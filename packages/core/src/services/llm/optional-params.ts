/** Optional request parameters that a compatible endpoint may reject. */
export type OptionalParam = 'store' | 'reasoning' | 'text' | 'max_output_tokens';
const OPTIONAL_PARAMS: OptionalParam[] = ['store', 'reasoning', 'text', 'max_output_tokens'];

/** Unambiguous "unsupported parameter" messages: they name a parameter and call it unsupported; plain format errors don't count. */
const UNSUPPORTED_PARAM_PATTERNS = [
  // "Unsupported parameter: 'store'", "Unknown parameter", "Unrecognized request argument supplied: reasoning"
  /\b(?:unsupported|unknown|unrecognized)\s+(?:request\s+)?(?:parameter|argument|field)s?\b/i,
  // "'text.format' is not supported", "reasoning.effort is unsupported"
  /['"`]?\b(?:store|reasoning(?:\.effort)?|text(?:\.format)?|max_output_tokens)\b['"`]?\s+(?:is|are)\s+(?:not\s+supported|unsupported|not\s+recognized|unknown)\b/i,
  // "does not support the 'reasoning' parameter"
  /\bdoes\s+not\s+support\b[^.\n]{0,80}\b(?:parameters?|arguments?|store|reasoning|text\.format|max_output_tokens)\b/i,
  // "Invalid parameter: 'text.format' of type 'json_object' is not supported with this model."
  /['"`]?\b(?:text\.format|response_format)\b['"`]?\s+of\s+type\s+['"`]?\w+['"`]?\s+is\s+not\s+supported\b/i,
];

const PARAM_MENTIONS: Record<OptionalParam, RegExp> = {
  store: /\bstore\b/i,
  reasoning: /\breasoning\b/i,
  text: /\btext\.format\b|\bresponse_format\b|\bjson_object\b|['"`]text['"`]/i,
  max_output_tokens: /\bmax_output_tokens\b/i,
};

export function isUnsupportedParamError(text: string): boolean {
  return UNSUPPORTED_PARAM_PATTERNS.some((pattern) => pattern.test(text));
}

/** Optional parameters the request body carries and the endpoint has not rejected yet. */
export function presentParams(body: Record<string, unknown>, rejected: Set<OptionalParam>): OptionalParam[] {
  return OPTIONAL_PARAMS.filter((param) => param in body && !rejected.has(param));
}

/** What to leave out after an "unsupported parameter" error: the parameters it names, else all but `store` (#150). */
export function paramsToDrop(errorText: string, present: OptionalParam[]): OptionalParam[] {
  const named = OPTIONAL_PARAMS.filter((param) => PARAM_MENTIONS[param].test(errorText)).filter((param) => present.includes(param));
  return named.length > 0 ? named : present.filter((param) => param !== 'store');
}

export function withoutParams(body: Record<string, unknown>, rejected: Set<OptionalParam>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !rejected.has(key as OptionalParam)));
}
