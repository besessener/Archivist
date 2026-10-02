import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOLDEN_QUERIES, GOLDEN_RECORDS, type GoldenQuery, type QueryKind } from '../helpers/search-corpus';
import { createTestApp, type TestApp } from '../helpers/harness';

// Search quality without API key (#255); the floors are a ratchet, only raised; SEARCH_QUALITY_REPORT=1 prints the numbers.
let app: TestApp;
const idByKey = new Map<string, string>();
const keyById = new Map<string, string>();

beforeAll(async () => {
  app = await createTestApp({ configured: false });
  for (const r of GOLDEN_RECORDS) {
    const note = await app.services.notes.create({ title: r.title, content: r.content });
    idByKey.set(r.key, note.id);
    keyById.set(note.id, r.key);
  }
}, 120_000);
afterAll(async () => app.cleanup());

const RECALL_K = 10;

async function run(q: GoldenQuery): Promise<string[]> {
  const hits = await app.services.search.search(q.query, { limit: RECALL_K });
  return hits.map((h) => keyById.get(h.id) ?? h.id);
}

interface Metrics {
  n: number;
  recall: number;
  mrr: number;
  rank1: number;
}

async function measure(kind: QueryKind): Promise<Metrics> {
  const queries = GOLDEN_QUERIES.filter((q) => q.kind === kind && q.relevant.length > 0);
  let recall = 0;
  let mrr = 0;
  let rank1 = 0;
  for (const q of queries) {
    const keys = await run(q);
    const found = q.relevant.filter((k) => keys.includes(k)).length;
    recall += found / q.relevant.length;
    const first = keys.findIndex((k) => q.relevant.includes(k));
    if (first >= 0) mrr += 1 / (first + 1);
    if (first === 0) rank1 += 1;
  }
  const n = queries.length;
  return { n, recall: recall / n, mrr: mrr / n, rank1: rank1 / n };
}

describe('golden corpus', () => {
  it('has the size the evaluation needs', () => {
    expect(GOLDEN_RECORDS.length).toBeGreaterThanOrEqual(100);
    expect(GOLDEN_QUERIES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(GOLDEN_RECORDS.map((r) => r.key)).size).toBe(GOLDEN_RECORDS.length);
    for (const q of GOLDEN_QUERIES) for (const k of [...q.relevant, ...(q.forbidden ?? [])]) expect(idByKey.has(k), `${q.query}: unknown key ${k}`).toBe(true);
  });

  // synonym and cross-lingual are weak by design of the local hash vectors: raise them when retrieval improves.
  const FLOORS: Record<Exclude<QueryKind, 'must-not-match'>, { recall: number; mrr: number }> = {
    exact: { recall: 1, mrr: 1 },
    inflection: { recall: 0.85, mrr: 0.95 },
    question: { recall: 1, mrr: 1 },
    paraphrase: { recall: 0.95, mrr: 0.85 },
    synonym: { recall: 0.3, mrr: 0.3 },
    'cross-lingual': { recall: 0.3, mrr: 0.5 },
  };

  for (const [kind, floor] of Object.entries(FLOORS) as Array<[keyof typeof FLOORS, { recall: number; mrr: number }]>) {
    it(`${kind}: recall@${RECALL_K} and MRR stay above the floor`, async () => {
      const m = await measure(kind);
      if (process.env.SEARCH_QUALITY_REPORT)
        console.log(`[search-quality] ${kind.padEnd(14)} n=${m.n} recall@10=${m.recall.toFixed(3)} mrr=${m.mrr.toFixed(3)} rank1=${m.rank1.toFixed(3)}`);
      expect(m.recall).toBeGreaterThanOrEqual(floor.recall);
      expect(m.mrr).toBeGreaterThanOrEqual(floor.mrr);
    });
  }

  it('overall recall@10 and MRR stay above the floor', async () => {
    let recall = 0;
    let mrr = 0;
    let rank1 = 0;
    const queries = GOLDEN_QUERIES.filter((q) => q.relevant.length > 0);
    for (const q of queries) {
      const keys = await run(q);
      recall += q.relevant.filter((k) => keys.includes(k)).length / q.relevant.length;
      const first = keys.findIndex((k) => q.relevant.includes(k));
      if (first >= 0) mrr += 1 / (first + 1);
      if (first === 0) rank1 += 1;
    }
    const n = queries.length;
    if (process.env.SEARCH_QUALITY_REPORT)
      console.log(`[search-quality] overall        n=${n} recall@10=${(recall / n).toFixed(3)} mrr=${(mrr / n).toFixed(3)} rank1=${(rank1 / n).toFixed(3)}`);
    expect(recall / n).toBeGreaterThanOrEqual(0.75);
    expect(mrr / n).toBeGreaterThanOrEqual(0.78);
  });

  it('ranks competing documents of the same topic by the query (distractors do not win)', async () => {
    expect((await run({ kind: 'exact', query: 'Dachdecker Schulz Mineralwolle', relevant: [] }))[0]).toBe('dach-angebot-schulz');
    expect((await run({ kind: 'exact', query: 'Dachdecker Meier Holzfaserdämmung', relevant: [] }))[0]).toBe('dach-angebot-meier');
    expect((await run({ kind: 'exact', query: 'AWS Rechnung Februar EC2', relevant: [] }))[0]).toBe('aws-rechnung');
    expect((await run({ kind: 'exact', query: 'Hausratversicherung Fahrräder', relevant: [] }))[0]).toBe('versicherung-hausrat');
  });

  it('must-not-match: unrelated queries return none of the forbidden records', async () => {
    for (const q of GOLDEN_QUERIES.filter((x) => x.kind === 'must-not-match')) {
      const keys = await run(q);
      for (const bad of q.forbidden ?? []) expect(keys, `${q.query} must not return ${bad}`).not.toContain(bad);
      if (q.relevant.length === 0) expect(keys.length, `${q.query} returned ${keys.join(', ')}`).toBeLessThanOrEqual(3);
      else expect(keys[0], q.query).toBe(q.relevant[0]);
    }
  });

  it('similarEntities finds the near-duplicate and not the distractor', async () => {
    const hits = await app.services.search.similarEntities('Angebot Dachdecker Schulz: Dachsanierung mit Mineralwolle', ['note'], 5);
    expect(keyById.get(hits[0]!.id)).toBe('dach-angebot-schulz');
    expect(hits.slice(0, 1).map((h) => keyById.get(h.id))).not.toContain('dach-angebot-meier');
  });
});
