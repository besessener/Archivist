import { z } from 'zod';
import { AppError } from '../../util/errors';
import { mapHttpError } from '../../util/llm-errors';
import { redactSecrets, type RedactionOptions } from '../../util/redact';
import type { PostRequest, PostResponse } from './http';
import type { Transmission } from './transmission-log';
import { embeddingsUsage, UsageTally } from './usage';

const embeddingsSchema = z.object({ data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().optional() })) });

/** Texts are cut to this many characters before masking. */
const MAX_TEXT_CHARS = 8000;

/** One masked /embeddings request: logged in any case with its tokens, the daily token limit checked first. */
export async function requestEmbeddings(
  request: {
    url: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    texts: string[];
    purpose: string;
    documentIds: string[];
    masking: RedactionOptions;
  },
  deps: { post: (request: PostRequest) => Promise<PostResponse>; record: (transmission: Transmission) => void; assertWithinCap: () => void },
): Promise<number[][]> {
  const { url, apiKey, model, timeoutMs, texts, purpose, documentIds, masking } = request;
  const redacted = texts.map((text) => redactSecrets(text.slice(0, MAX_TEXT_CHARS), masking));
  deps.assertWithinCap();
  const tally = new UsageTally();
  let success = false;
  try {
    tally.countRequest();
    const response = await deps.post({ url, apiKey, body: { model, input: redacted.map((entry) => entry.text) }, timeoutMs });
    tally.add(embeddingsUsage(response.text));
    if (response.status >= 400) throw mapHttpError(response.status, response.text, response.retryAfterMs);
    const parsed = embeddingsSchema.safeParse(JSON.parse(response.text));
    if (!parsed.success || parsed.data.data.length !== texts.length) throw new AppError('llm_error', 'Unerwartete Embedding-Antwort.');
    success = true;
    return parsed.data.data.map((entry) => entry.embedding);
  } finally {
    deps.record({
      purpose,
      model,
      endpoint: url,
      bytes: redacted.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0),
      redactions: redacted.reduce((sum, entry) => sum + entry.count, 0),
      personalRedactions: redacted.reduce((sum, entry) => sum + entry.personalData, 0),
      documentIds,
      preview: redacted[0]?.text.slice(0, 200) ?? '',
      success,
      ...tally.columns(),
    });
  }
}
