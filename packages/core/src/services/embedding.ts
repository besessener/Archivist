import type { LlmService } from './llm';
import { withinCharBudget } from './llm/embedding-budget';
import type { SettingsService } from './settings';
import type { Logger } from '../util/logger';
import { stripDiacritics, tokenize } from '../util/text';

export const LOCAL_MODEL = 'local-hash-v1';
export const LOCAL_DIM = 512;

function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Local, deterministic vectors (feature hashing over words and character trigrams): no network, no model file. */
export function localEmbed(text: string): Float32Array {
  const vec = new Float32Array(LOCAL_DIM);
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    const slot = h % LOCAL_DIM;
    const sign = (fnv1a(feature, 0x9747b28c) & 1) === 0 ? 1 : -1;
    vec[slot] = (vec[slot] ?? 0) + sign * weight;
  };
  for (const [tok, count] of tf) {
    const w = 1 + Math.log(count);
    add(`w:${tok}`, w);
    const padded = `^${stripDiacritics(tok)}$`;
    if (padded.length > 4) for (let i = 0; i <= padded.length - 3; i += 1) add(`c:${padded.slice(i, i + 3)}`, w * 0.35);
  }
  let norm = 0;
  for (let i = 0; i < LOCAL_DIM; i += 1) norm += (vec[i] ?? 0) ** 2;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < LOCAL_DIM; i += 1) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}

export interface EmbedResult {
  vectors: Float32Array[];
  model: string;
  dim: number;
  /** The configured remote model was wanted but failed: these are local vectors that should be replaced later. */
  fellBack: boolean;
}

export class EmbeddingService {
  private readonly settings: SettingsService;
  private readonly llm: LlmService;
  private readonly logger: Logger;

  constructor(deps: { settings: SettingsService; llm: LlmService; logger: Logger }) {
    ({ settings: this.settings, llm: this.llm, logger: this.logger } = deps);
  }

  /** Model that requests would currently use. */
  currentModel({ allowRemote }: { allowRemote: boolean }): string {
    const llmSettings = this.settings.get().llm;
    return allowRemote && llmSettings.embeddingModel && this.llm.isConfigured() ? llmSettings.embeddingModel : LOCAL_MODEL;
  }

  /** How many of the texts (from the front) a remote request may carry within `maxInputChars`. */
  remoteTextCount(texts: string[]): number {
    return withinCharBudget(texts, this.settings.get().llm.maxInputChars).length;
  }

  /**
   * `allowRemote=false` forces local vectors (e.g. for documents excluded from external analysis).
   * A remote request carries at most `maxInputChars` characters in total: texts beyond that get no vector (`vectors` is then shorter than `texts`).
   */
  async embed(texts: string[], opts: { allowRemote: boolean; purpose: string; documentIds?: string[] }): Promise<EmbedResult> {
    const model = this.currentModel({ allowRemote: opts.allowRemote });
    let fellBack = false;
    if (model !== LOCAL_MODEL) {
      try {
        const sent = withinCharBudget(texts, this.settings.get().llm.maxInputChars);
        const out: number[][] = [];
        for (let i = 0; i < sent.length; i += 32)
          out.push(...(await this.llm.embeddings(sent.slice(i, i + 32), { purpose: opts.purpose, documentIds: opts.documentIds })));
        const vectors = out.map((v) => {
          const f = Float32Array.from(v);
          let n = 0;
          for (const x of f) n += x * x;
          n = Math.sqrt(n) || 1;
          for (let i = 0; i < f.length; i += 1) f[i] = (f[i] ?? 0) / n;
          return f;
        });
        return { vectors, model, dim: vectors[0]?.length ?? 0, fellBack: false };
      } catch (error) {
        // indexing must not depend on the cloud: local vectors take over
        fellBack = true;
        this.logger.warn('embedding', 'Remote embeddings failed, using local vectors', { model, error });
      }
    }
    return { vectors: texts.map(localEmbed), model: LOCAL_MODEL, dim: LOCAL_DIM, fellBack };
  }
}
