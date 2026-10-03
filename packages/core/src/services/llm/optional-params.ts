/** Gentler fallbacks tried before a parameter is dropped: json_schema → json_object, effort max → xhigh → high. */
export type Downgrade = 'json_schema' | 'effort_max' | 'effort_xhigh';

/** Optional request parameters that a compatible endpoint may reject, and the downgrades it has refused. */
export type OptionalParam = 'store' | 'reasoning' | 'text' | 'max_output_tokens' | Downgrade;
const OPTIONAL_PARAMS: Array<Exclude<OptionalParam, Downgrade>> = ['store', 'reasoning', 'text', 'max_output_tokens'];

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
  // "Unsupported value: 'xhigh' is not supported with the 'gpt-5' model. Supported values are: …" (param reasoning.effort)
  /\bunsupported\s+value\b/i,
  // "Invalid schema for response_format 'X'" (code invalid_json_schema): the schema is not accepted, JSON mode still works
  /\binvalid[_\s]json[_\s]schema\b|\binvalid\s+schema\s+for\s+response_format\b/i,
];

const PARAM_MENTIONS: Record<Exclude<OptionalParam, Downgrade>, RegExp> = {
  store: /\bstore\b/i,
  reasoning: /\breasoning\b|\beffort\b/i,
  text: /\btext\.format\b|\bresponse_format\b|\bjson_object\b|\bjson_schema\b|['"`]text['"`]/i,
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

/** The gentler step to take for a parameter the endpoint rejected, else the parameter itself (dropped). */
export function stepFor(param: OptionalParam, body: Record<string, unknown>): OptionalParam {
  const format = (body.text as { format?: { type?: string } } | undefined)?.format?.type;
  const effort = (body.reasoning as { effort?: string } | undefined)?.effort;
  if (param === 'text' && format === 'json_schema') return 'json_schema';
  if (param === 'reasoning' && effort === 'max') return 'effort_max';
  if (param === 'reasoning' && effort === 'xhigh') return 'effort_xhigh';
  return param;
}

export function withoutParams(body: Record<string, unknown>, rejected: Set<OptionalParam>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !rejected.has(key as OptionalParam)));
}
