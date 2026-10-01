import type { LlmService } from './llm';
import type { SettingsService } from './settings';
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

/**
 * Lokale, deterministische Vektoren (Feature Hashing über Wörter und Zeichen-Trigramme).
 * Keine Netzwerkanfrage, keine Modelldatei – robust offline und für vertrauliche Dokumente.
 */
export function localEmbed(text: string): Float32Array {
  const vec = new Float32Array(LOCAL_DIM);
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const add = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    const idx = h % LOCAL_DIM;
    const sign = (fnv1a(feature, 0x9747b28c) & 1) === 0 ? 1 : -1;
    vec[idx] = (vec[idx] ?? 0) + sign * weight;
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
}

export class EmbeddingService {
  constructor(
    private readonly settings: SettingsService,
    private readonly llm: LlmService,
  ) {}

  /** Modell, das Anfragen aktuell nutzen würden. */
  currentModel(allowRemote: boolean): string {
    const cfg = this.settings.get().llm;
    return allowRemote && cfg.embeddingModel && this.llm.isConfigured() ? cfg.embeddingModel : LOCAL_MODEL;
  }

  /** `allowRemote=false` erzwingt lokale Vektoren (z. B. für von externer Analyse ausgeschlossene Dokumente). */
  async embed(texts: string[], opts: { allowRemote: boolean; purpose: string; documentIds?: string[] }): Promise<EmbedResult> {
    const model = this.currentModel(opts.allowRemote);
    if (model !== LOCAL_MODEL) {
      try {
        const out: number[][] = [];
        for (let i = 0; i < texts.length; i += 32) out.push(...(await this.llm.embeddings(texts.slice(i, i + 32), opts.purpose, opts.documentIds)));
        const vectors = out.map((v) => {
          const f = Float32Array.from(v);
          let n = 0;
          for (const x of f) n += x * x;
          n = Math.sqrt(n) || 1;
          for (let i = 0; i < f.length; i += 1) f[i] = (f[i] ?? 0) / n;
          return f;
        });
        return { vectors, model, dim: vectors[0]?.length ?? 0 };
      } catch {
        /* Fallback auf lokale Vektoren – Indexierung darf nicht an der Cloud hängen */
      }
    }
    return { vectors: texts.map(localEmbed), model: LOCAL_MODEL, dim: LOCAL_DIM };
  }
}
