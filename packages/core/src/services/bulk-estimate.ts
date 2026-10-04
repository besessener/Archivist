import { estimateTokens } from '../util/estimate-tokens';
import { MAX_LLM_PARTS, partSize } from './document-parts';

/** Characters the instructions of one analysis request add to the text. */
const PROMPT_OVERHEAD_CHARS = 2_000;
/** Tokens one structured classification answer is assumed to take. */
const OUTPUT_TOKENS_PER_REQUEST = 1_000;

/** Tokens of analysing texts of the given lengths with the LLM: every part up to the cap is a request with the prompt overhead, plus an output allowance. */
export function estimateAnalysisTokens(textLengths: number[], maxInputChars: number): number {
  const size = partSize({ maxInputChars, promptChars: PROMPT_OVERHEAD_CHARS });
  const requests = textLengths.map((length) => Math.max(1, Math.min(MAX_LLM_PARTS, Math.ceil(length / size))));
  const sentChars = textLengths.reduce((sum, length, index) => sum + Math.min(length, requests[index]! * size), 0);
  const requestCount = requests.reduce((sum, count) => sum + count, 0);
  return estimateTokens(sentChars + requestCount * PROMPT_OVERHEAD_CHARS) + requestCount * OUTPUT_TOKENS_PER_REQUEST;
}
