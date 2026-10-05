import Anthropic from '@anthropic-ai/sdk';
import type { AdapterConfig } from './common';

/** Optional features; an endpoint that rejects one gets requests without it from then on (#296). */
export type Feature =
  'web_location' | 'web_dynamic' | 'web_search' | 'effort' | 'json_format' | 'task_budget' | 'compaction' | 'eager_streaming' | 'top_cache' | 'fallbacks';

const FEATURE_MENTIONS: Record<Feature, RegExp> = {
  // the specific features come first: „output_config.task_budget: …“ must switch off the task budget, not the effort
  web_location: /user_location/i,
  // the filtering web search needs newer models (else a 400 asks for allowed_callers); Foundry hosted on Azure offers only the basic one
  web_dynamic: /web_search_20260209|allowed_callers/i,
  // web search switched off for the organization, or not offered by the endpoint (Bedrock, some Foundry deployments)
  web_search: /web[_ ]?search/i,
  task_budget: /task[_-]?budget/i,
  eager_streaming: /eager_input_streaming/i,
  compaction: /context_management|compact/i,
  fallbacks: /fallback/i,
  json_format: /output_config\.format|output[_ ]format|json_schema|structured output/i,
  effort: /\beffort\b|output_config/i,
  top_cache: /cache_control/i,
};

const FEATURES = Object.keys(FEATURE_MENTIONS) as Feature[];

/** The optional feature a rejection names and that is not switched off yet. */
export function rejectedFeature(message: string, off: Set<string>): Feature | undefined {
  return FEATURES.find((feature) => !off.has(feature) && FEATURE_MENTIONS[feature].test(message));
}

/** Sends; a 400 that names an optional feature switches it off (for this endpoint and model) and sends again. */
export async function withFeatureFallback<T>(off: Set<string>, request: { send: () => Promise<T>; warn: AdapterConfig['warn'] }): Promise<T> {
  for (let fallback = 0; ; fallback += 1) {
    try {
      return await request.send();
    } catch (err) {
      const feature = err instanceof Anthropic.BadRequestError && fallback < FEATURES.length ? rejectedFeature(err.message, off) : undefined;
      if (!feature) throw err;
      off.add(feature);
      request.warn('Claude endpoint rejected an optional feature – retrying without it', { feature });
    }
  }
}
