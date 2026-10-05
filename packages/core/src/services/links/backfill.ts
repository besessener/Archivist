import { currentRun } from '../../agent/scope';
import { nowIso } from '../../util/ids';
import type { LinkCandidates, SimilarProposer } from './candidates';
import type { CoOriginLinks } from './co-origin';
import { entrySql, isEntry, LINK_ENTRY_TYPES, storedList, type LinkDeps } from './entries';

export interface BackfillResult {
  processed: number;
  proposed: number;
  /** Every entry is checked. */
  done: boolean;
  remaining: number;
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

/** Raise it when a link method is added or changed: every entry is checked again once. */
const METHOD_VERSION = 2;
/** Entries indexed since the last similarity pass (#271); kept across restarts. */
const SIMILAR_PENDING = 'links.similar.pending';
const ENTRY_WHERE = entrySql('e', LINK_ENTRY_TYPES);
const UNSCANNED = `NOT EXISTS (SELECT 1 FROM link_scans s WHERE s.entity_id = e.id AND s.method_version >= ${METHOD_VERSION})`;

/** The link methods run over many entries: after indexing (#271) and retroactively over the whole archive (#279). */
export class LinkBackfill {
  private noteAnalyzer: NoteAnalyzer = async () => 0;

  constructor(
    private readonly deps: LinkDeps,
    private readonly methods: { candidates: LinkCandidates; coOrigin: CoOriginLinks },
  ) {}

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
    const pending = new Set(this.pendingSimilar());
    for (const id of wanted) pending.add(id);
    this.deps.appState.set(SIMILAR_PENDING, JSON.stringify([...pending]));
    return true;
  }

  private pendingSimilar(): string[] {
    return storedList(this.deps.appState, SIMILAR_PENDING).filter((id): id is string => typeof id === 'string');
  }

  /** Works through the remembered entries; each leaves the list only once done, so an interrupted pass continues with the rest. */
  async runPendingSimilar(options: { max?: number; signal?: AbortSignal } = {}): Promise<{ processed: number; proposed: number }> {
    let processed = 0;
    let proposed = 0;
    for (let next = this.pendingSimilar()[0]; next !== undefined; next = this.pendingSimilar()[0]) {
      if (options.signal?.aborted) break;
      try {
        // the more specific reason first: same day and person (#278), then similar content (#271)
        proposed += this.methods.coOrigin.proposeSameDayPerson(next);
        proposed += await this.methods.candidates.proposeSimilar(next, { max: options.max });
        proposed += await this.methods.candidates.proposeCases(next);
      } catch (err) {
        this.deps.ctx.logger.warn('links', 'Similarity proposals skipped', { error: err, id: next });
      }
      const done = next;
      this.deps.appState.set(SIMILAR_PENDING, JSON.stringify(this.pendingSimilar().filter((id) => id !== done)));
      processed += 1;
    }
    return { processed, proposed };
  }

  /** Proposes by every method for one entry and marks it as checked, unless stopped in the middle (it is done again next time). */
  async scanEntry(id: string, options: ScanOptions = {}): Promise<number> {
    const proposed = (await this.proposeSimilarLinks(id, options.max)) + (await this.runOtherMethods(id, options.signal));
    if (!options.signal?.aborted) this.markScanned(id);
    return proposed;
  }

  /** Retroactive run (#279): PROPOSES links for every entry not checked yet (new, changed or from before a new method), in a stable order. */
  async backfill(options: BackfillOptions = {}): Promise<BackfillResult> {
    const rows = this.sqlite
      .prepare(`SELECT e.id FROM entities e WHERE ${ENTRY_WHERE} AND ${UNSCANNED} ORDER BY e.id LIMIT ?`)
      .all(options.maxEntries ?? 200) as Array<{ id: string }>;
    let processed = 0;
    let proposed = 0;
    for (const { id } of rows) {
      if (options.signal?.aborted) break;
      proposed += await this.scanEntry(id, options);
      if (options.signal?.aborted) break;
      processed += 1;
      options.onProgress?.(processed, rows.length);
    }
    const remaining = (this.sqlite.prepare(`SELECT count(*) AS c FROM entities e WHERE ${ENTRY_WHERE} AND ${UNSCANNED}`).get() as { c: number }).c;
    return { processed, proposed, done: remaining === 0, remaining };
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
    if (this.deps.graph.rejectedBetween({ a: key.sourceId, b: key.targetId })) return false;
    const options = { status: 'proposed', trigger: 'link_backfill', origin: 'system', method: 'similarity', ...proposal } as const;
    return this.deps.graph.linkEntries(key, options).created;
  };

  /** The other methods of Epic #269: same day and person, same source document, cases, the analysis of a note. */
  private async runOtherMethods(id: string, signal: AbortSignal | undefined): Promise<number> {
    let proposed = 0;
    try {
      proposed += this.methods.coOrigin.proposeSameDayPerson(id);
      proposed += this.methods.coOrigin.linkSameDocument(id);
      proposed += await this.methods.candidates.proposeCases(id);
      if (this.deps.graph.getEntity(id)?.type === 'note') proposed += await this.noteAnalyzer(id, signal);
    } catch (err) {
      this.deps.ctx.logger.warn('links', 'Link methods skipped for an entry', { error: err, id });
    }
    return proposed;
  }
}
