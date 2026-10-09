import { currentRun } from '../../agent/scope';
import { nowIso } from '../../util/ids';
import type { AppStateService } from '../app-state';
import type { LinkCandidates, SimilarProposer } from './candidates';
import type { CoOriginLinks } from './co-origin';
import { entrySql, isEntry, LINK_ENTRY_TYPES, reachesMinConfidence, storedList, type LinkDeps } from './entries';
import { proposalsAtLimit } from './proposal-list';

export interface BackfillResult {
  processed: number;
  proposed: number;
  /** Every entry is checked. */
  done: boolean;
  remaining: number;
  /** Stopped because the open proposals reached the cap: it goes on once the user has decided (#361). */
  stoppedAtLimit: boolean;
}

export interface ScanOptions {
  /** Most open similarity proposals per entry (setting `links.maxProposalsPerEntry`). */
  max?: number;
  signal?: AbortSignal;
}

export interface BackfillOptions extends ScanOptions {
  maxEntries?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Analyses a note (#273) for the retroactive run; returns the number of new proposals. */
export type NoteAnalyzer = (id: string, signal?: AbortSignal) => Promise<number>;

/** Marks of an older version count as unchecked; raising it starts no run, the next retroactive run then checks every entry again. */
const METHOD_VERSION = 2;
/** Entries indexed since the last pass (#271); kept across restarts. */
const SIMILAR_PENDING = 'links.similar.pending';
/** Notes whose analysis waited for the cap of open proposals (#361); kept across restarts. */
const ANALYSIS_PENDING = 'links.analysis.pending';
const ENTRY_WHERE = entrySql('e', LINK_ENTRY_TYPES);
const UNSCANNED = `NOT EXISTS (SELECT 1 FROM link_scans s WHERE s.entity_id = e.id AND s.method_version >= ${METHOD_VERSION})`;

/** Ids of entries waiting for a step, in the app state across restarts. */
class PendingIds {
  constructor(
    private readonly appState: AppStateService,
    private readonly key: string,
  ) {}

  all(): string[] {
    return storedList(this.appState, this.key).filter((id): id is string => typeof id === 'string');
  }

  has(id: string): boolean {
    return this.all().includes(id);
  }

  add(ids: string[]): void {
    this.appState.set(this.key, JSON.stringify([...new Set([...this.all(), ...ids])]));
  }

  remove(id: string): void {
    const ids = this.all();
    if (ids.includes(id)) this.appState.set(this.key, JSON.stringify(ids.filter((other) => other !== id)));
  }
}

/** The link methods run over many entries: after indexing (#271) and retroactively over the whole archive (#279). */
export class LinkBackfill {
  private noteAnalyzer: NoteAnalyzer = async () => 0;
  private readonly similarPending: PendingIds;
  private readonly analysisPending: PendingIds;

  constructor(
    private readonly deps: LinkDeps,
    private readonly methods: { candidates: LinkCandidates; coOrigin: CoOriginLinks },
  ) {
    this.similarPending = new PendingIds(deps.appState, SIMILAR_PENDING);
    this.analysisPending = new PendingIds(deps.appState, ANALYSIS_PENDING);
  }

  private get sqlite() {
    return this.deps.ctx.database.sqlite;
  }

  setNoteAnalyzer(analyzer: NoteAnalyzer): void {
    this.noteAnalyzer = analyzer;
  }

  /** Every entry counts as unchecked again (the user asked for a full run). */
  restart(): void {
    this.sqlite.prepare('DELETE FROM link_scans').run();
  }

  /** A new or changed entry is checked again by the retroactive run. */
  forgetScan(id: string): void {
    this.sqlite.prepare('DELETE FROM link_scans WHERE entity_id = ?').run(id);
  }

  private markScanned(id: string): void {
    if (!isEntry(this.sqlite, id)) return;
    this.sqlite
      .prepare(
        'INSERT INTO link_scans (entity_id, method_version, scanned_at) VALUES (?, ?, ?) ON CONFLICT(entity_id) DO UPDATE SET method_version = excluded.method_version, scanned_at = excluded.scanned_at',
      )
      .run(id, METHOD_VERSION, nowIso());
  }

  /** Remembers entries to look for similar ones (after indexing, #271); returns true if one of them counts. */
  queueSimilar(ids: string[]): boolean {
    const wanted = ids.filter((id) => isEntry(this.sqlite, id));
    if (!wanted.length) return false;
    this.similarPending.add(wanted);
    return true;
  }

  /** A note whose analysis waited for the cap (#361): the next pass analyses it, until then it counts as unchecked. */
  deferNoteAnalysis(id: string): void {
    this.analysisPending.add([id]);
    this.forgetScan(id);
  }

  /** Entries or notes wait for a pass. */
  hasPendingChecks(): boolean {
    return this.similarPending.all().length > 0 || this.analysisPending.all().length > 0;
  }

  /** Works through the remembered entries, then the deferred notes; an interrupted pass continues with the rest, an entry is checked once nothing waits for it. */
  async runPendingChecks(options: ScanOptions = {}): Promise<{ processed: number; proposed: number }> {
    const entries = await this.drain(this.similarPending, { check: (id) => this.proposeForEntry(id, options.max), signal: options.signal });
    const notes = await this.drain(this.analysisPending, { check: (id) => this.analyseNote(id, options.signal), signal: options.signal });
    return { processed: entries.processed + notes.processed, proposed: entries.proposed + notes.proposed };
  }

  /** One list until it is empty, the signal aborts or the open proposals reach the cap; each id leaves the list only once done. */
  private async drain(list: PendingIds, pass: { check: (id: string) => Promise<number>; signal?: AbortSignal }) {
    let processed = 0;
    let proposed = 0;
    for (let next = list.all()[0]; next !== undefined; next = list.all()[0]) {
      if (pass.signal?.aborted || proposalsAtLimit(this.deps)) break;
      proposed += await pass.check(next);
      if (pass.signal?.aborted) break;
      list.remove(next);
      if (!this.similarPending.has(next) && !this.analysisPending.has(next)) this.markScanned(next);
      processed += 1;
    }
    return { processed, proposed };
  }

  /** Proposes by every method for one entry and marks it as checked, unless stopped in the middle (it is done again next time). */
  async scanEntry(id: string, options: ScanOptions = {}): Promise<number> {
    const note = this.deps.graph.getEntity(id)?.type === 'note';
    const proposed = (await this.proposeForEntry(id, options.max)) + (note ? await this.analyseNote(id, options.signal) : 0);
    if (!options.signal?.aborted) {
      this.markScanned(id);
      this.analysisPending.remove(id);
    }
    return proposed;
  }

  /** Retroactive run (#279): PROPOSES links for every entry not checked yet (new, changed or from before a new method), in a stable order. */
  async backfill(options: BackfillOptions = {}): Promise<BackfillResult> {
    const rows = this.sqlite
      .prepare(`SELECT e.id FROM entities e WHERE ${ENTRY_WHERE} AND ${UNSCANNED} ORDER BY e.id LIMIT ?`)
      .all(options.maxEntries ?? 200) as Array<{ id: string }>;
    let processed = 0;
    let proposed = 0;
    let stoppedAtLimit = false;
    for (const { id } of rows) {
      stoppedAtLimit = proposalsAtLimit(this.deps);
      if (options.signal?.aborted || stoppedAtLimit) break;
      proposed += await this.scanEntry(id, options);
      if (options.signal?.aborted) break;
      processed += 1;
      options.onProgress?.(processed, rows.length);
    }
    const remaining = (this.sqlite.prepare(`SELECT count(*) AS c FROM entities e WHERE ${ENTRY_WHERE} AND ${UNSCANNED}`).get() as { c: number }).c;
    return { processed, proposed, done: remaining === 0, remaining, stoppedAtLimit };
  }

  /** Every method but the analysis of a note; one failing method skips the rest of this entry, the run goes on. */
  private async proposeForEntry(id: string, max: number | undefined): Promise<number> {
    let proposed = 0;
    try {
      // the more specific reason first: same day and person (#278), then similar content (#271)
      proposed += this.methods.coOrigin.proposeSameDayPerson(id);
      proposed += await this.proposeSimilarLinks(id, max);
      proposed += this.methods.coOrigin.linkSameDocument(id);
      proposed += await this.methods.candidates.proposeCases(id);
    } catch (err) {
      this.deps.ctx.logger.warn('links', 'Link methods skipped for an entry', { error: err, id });
    }
    return proposed;
  }

  private async proposeSimilarLinks(id: string, max: number | undefined): Promise<number> {
    // inside an agent run each proposal is audited, so it is undone with the run
    const propose = currentRun() ? this.auditedProposal : undefined;
    try {
      return await this.methods.candidates.proposeSimilar(id, { max, propose });
    } catch (err) {
      // e.g. an entry removed meanwhile: it is skipped, the run goes on
      this.deps.ctx.logger.warn('links', 'Similarity proposals skipped', { error: err, id });
      return 0;
    }
  }

  private readonly auditedProposal: SimilarProposer = (key, proposal) => {
    if (!reachesMinConfidence(this.deps, proposal.confidence) || this.deps.graph.rejectedBetween({ a: key.sourceId, b: key.targetId })) return false;
    const options = { status: 'proposed', trigger: 'link_backfill', origin: 'system', method: 'similarity', ...proposal } as const;
    return this.deps.graph.linkEntries(key, options).created;
  };

  /** The analysis of a note (#273); a failure skips only the note. */
  private async analyseNote(id: string, signal: AbortSignal | undefined): Promise<number> {
    try {
      return await this.noteAnalyzer(id, signal);
    } catch (err) {
      this.deps.ctx.logger.warn('links', 'Note analysis skipped', { error: err, id });
      return 0;
    }
  }
}
