import type Database from 'better-sqlite3';
import { LOCAL_DIM, LOCAL_MODEL, localEmbed, type EmbeddingService, type EmbedResult } from './embedding';

interface StoredChunk {
  title: string;
  text: string;
  embedding: Buffer | null;
  embedding_model: string | null;
}

/** Vectors an entity's chunks already have on `model`, by the text that was embedded (`title\ntext`). */
function storedVectors(sqlite: Database.Database, { entityId, model }: { entityId: string; model: string }): Map<string, Float32Array> {
  const rows = sqlite
    .prepare(
      'SELECT f.title AS title, c.text AS text, c.embedding AS embedding, c.embedding_model AS embedding_model FROM chunks c JOIN search_fts f ON f.rowid = c.rowid WHERE c.entity_id = ?',
    )
    .all(entityId) as StoredChunk[];
  const stored = new Map<string, Float32Array>();
  for (const row of rows) {
    if (row.embedding_model !== model || !row.embedding) continue;
    const bytes = row.embedding;
    stored.set(`${row.title}\n${row.text}`, new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  }
  return stored;
}

type Deps = { embedding: EmbeddingService; sqlite: Database.Database };
type Request = { entityId: string; texts: string[]; allowRemote: boolean; purpose: string; documentIds: string[] };

/** Embeds only the texts without a stored vector of the model that would be used now: fewer remote calls, same index. */
export function embedChanged(deps: Deps, request: Request): Promise<EmbedResult> {
  const { texts, allowRemote, purpose, documentIds } = request;
  const model = deps.embedding.currentModel({ allowRemote });
  // local vectors cost less than looking up the stored ones
  if (model === LOCAL_MODEL) return deps.embedding.embed(texts, { allowRemote, purpose, documentIds });
  return embedRemoteChanged(deps, { ...request, model });
}

async function embedRemoteChanged(deps: Deps, request: Request & { model: string }): Promise<EmbedResult> {
  const { embedding, sqlite } = deps;
  const { entityId, texts: allTexts, model, ...embedOptions } = request;
  // the size limit counts the whole entry, not only what is new: repeated indexing never sends more of it
  const texts = allTexts.slice(0, embedding.remoteTextCount(allTexts));
  const stored = storedVectors(sqlite, { entityId, model });
  const missing = texts.filter((text) => !stored.has(text));
  if (stored.size === 0 || missing.length === texts.length) return embedding.embed(allTexts, embedOptions);
  const fresh: EmbedResult = missing.length > 0 ? await embedding.embed(missing, embedOptions) : { vectors: [], model, dim: 0, fellBack: false };
  // the endpoint failed for the new texts: one model per entity, so everything gets local vectors
  if (fresh.model !== model) return { vectors: allTexts.map(localEmbed), model: LOCAL_MODEL, dim: LOCAL_DIM, fellBack: true };
  const queue = [...fresh.vectors];
  const vectors: Float32Array[] = [];
  for (const text of texts) {
    const vector = stored.get(text) ?? queue.shift();
    if (!vector) break;
    vectors.push(vector);
  }
  return { vectors, model, dim: vectors[0]?.length ?? 0, fellBack: false };
}
