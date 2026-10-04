import type { EntityType } from '@archivist/shared';
import type Database from 'better-sqlite3';
import { LOCAL_MODEL } from './embedding';
import type { VectorHit, VectorIndex } from './vector-index';

export interface SimilarOptions {
  types: readonly EntityType[];
  limit: number;
  minScore: { local: number; embeddings: number };
}

export interface SimilarEntry {
  id: string;
  type: EntityType;
  score: number;
  passage: string;
  local: boolean;
}

type Deps = { sqlite: Database.Database; vectors: VectorIndex };

/** Local hits of entries with the endpoint's vectors are dropped, so the local pass asks for more. */
const LOCAL_OVERFETCH = 4;

const hasVectorsOf = (sqlite: Database.Database, { entityId, model }: { entityId: string; model: string }): boolean =>
  Boolean(sqlite.prepare('SELECT 1 FROM chunks WHERE entity_id = ? AND embedding_model = ? AND embedding IS NOT NULL LIMIT 1').get(entityId, model));

function entriesOf(sqlite: Database.Database, hits: VectorHit[], local: boolean): SimilarEntry[] {
  const passage = sqlite.prepare('SELECT text FROM chunks WHERE id = ?');
  return hits.map((hit) => ({
    id: hit.entityId,
    type: hit.entityType as EntityType,
    score: Math.round(hit.score * 1000) / 1000,
    passage: (passage.get(hit.chunkId) as { text: string } | undefined)?.text ?? '',
    local,
  }));
}

/** Entries similar to an indexed one (#271): by the endpoint's vectors if it has them, by the local ones for the rest (`local`). */
export async function similarEntries({ sqlite, vectors }: Deps, entityId: string, opts: SimilarOptions): Promise<SimilarEntry[]> {
  const models = (
    sqlite.prepare('SELECT DISTINCT embedding_model AS m FROM chunks WHERE entity_id = ? AND embedding IS NOT NULL').all(entityId) as Array<{ m: string }>
  ).map((row) => row.m);
  const model = models.find((m) => m !== LOCAL_MODEL) ?? models.find((m) => m === LOCAL_MODEL);
  if (!model) return [];
  const local = { model: LOCAL_MODEL, entityId };
  if (model === LOCAL_MODEL)
    return entriesOf(sqlite, await vectors.similarTo(local, { k: opts.limit, minScore: opts.minScore.local, types: opts.types }), true);
  const remote = await vectors.similarTo({ model, entityId }, { k: opts.limit, minScore: opts.minScore.embeddings, types: opts.types });
  // entries without vectors of the endpoint's model are found only by their local ones
  const localOnly = (await vectors.similarTo(local, { k: opts.limit * LOCAL_OVERFETCH, minScore: opts.minScore.local, types: opts.types })).filter(
    (hit) => !hasVectorsOf(sqlite, { entityId: hit.entityId, model }),
  );
  return [...entriesOf(sqlite, remote, false), ...entriesOf(sqlite, localOnly, true)].toSorted((a, b) => b.score - a.score).slice(0, opts.limit);
}
