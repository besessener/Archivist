import type { LinkCandidates } from './candidates';
import type { CoOriginLinks } from './co-origin';
import { entrySql, isEntry, LINK_ENTRY_TYPES, storedList, type LinkDeps } from './entries';

export interface BackfillResult {
  processed: number;
  proposed: number;
  /** All entries are done (the next run starts over from the beginning). */
  done: boolean;
  remaining: number;
}

export interface BackfillOptions {
  maxEntries?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Analyses a note (#273) for the retroactive run; returns the number of new proposals. */
export type NoteAnalyzer = (id: string, signal?: AbortSignal) => Promise<number>;

const BACKFILL_CURSOR = 'links.backfill.cursor';
/** Entries indexed since the last similarity pass (#271); kept across restarts. */
const SIMILAR_PENDING = 'links.similar.pending';
const ENTRY_WHERE = entrySql('e', LINK_ENTRY_TYPES);

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

  /** The retroactive run starts again from the first entry (e.g. once after an update that brought new methods). */
  restart(): void {
    this.deps.appState.set(BACKFILL_CURSOR, '');
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

  /** Retroactive run (#279): PROPOSES links for every entry in a stable order, storing its position after each entry. */
  async backfill(options: BackfillOptions = {}): Promise<BackfillResult> {
    const cursor = this.deps.appState.get(BACKFILL_CURSOR) ?? '';
    const rows = this.sqlite
      .prepare(`SELECT e.id FROM entities e WHERE ${ENTRY_WHERE} AND e.id > ? ORDER BY e.id LIMIT ?`)
      .all(cursor, options.maxEntries ?? 200) as Array<{ id: string }>;
    let processed = 0;
    let proposed = 0;
    for (const { id } of rows) {
      if (options.signal?.aborted) break;
      proposed += await this.proposeSimilarLinks(id);
      proposed += await this.runOtherMethods(id, options.signal);
      // stopped in the middle of this entry: it is done again next time (nothing finished is paid twice)
      if (options.signal?.aborted) break;
      processed += 1;
      this.deps.appState.set(BACKFILL_CURSOR, id);
      options.onProgress?.(processed, rows.length);
    }
    const remaining = (
      this.sqlite.prepare(`SELECT count(*) AS c FROM entities e WHERE ${ENTRY_WHERE} AND e.id > ?`).get(this.deps.appState.get(BACKFILL_CURSOR) ?? '') as {
        c: number;
      }
    ).c;
    const done = remaining === 0;
    // finished: the next run starts over (new entries since then get their chance)
    if (done) this.restart();
    return { processed, proposed, done, remaining };
  }

  private async proposeSimilarLinks(id: string): Promise<number> {
    let proposed = 0;
    for (const candidate of await this.methods.candidates.candidates(id, { limit: 3, types: LINK_ENTRY_TYPES })) {
      if (candidate.method !== 'similarity' || this.deps.graph.rejectedBetween(id, candidate.id)) continue;
      try {
        const result = this.deps.graph.linkEntries(id, candidate.id, 'related_to', {
          status: 'proposed',
          trigger: 'link_backfill',
          confidence: candidate.score,
          origin: 'system',
          method: 'similarity',
          evidence: candidate.reason,
        });
        if (result.created) proposed += 1;
      } catch (err) {
        // e.g. an entry removed meanwhile: this pair is skipped, the run goes on
        this.deps.ctx.logger.warn('links', 'Link proposal skipped', { error: err, from: id, to: candidate.id });
      }
    }
    return proposed;
  }

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
