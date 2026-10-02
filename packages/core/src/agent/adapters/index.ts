import type { AgentAdapterChoice, AgentAdapterId } from '@archivist/shared';
import type { ProviderAdapter } from '../types';
import { AnthropicAdapter, isAnthropicUrl } from './anthropic';
import type { AdapterConfig } from './common';
import { OpenAiResponsesAdapter } from './openai';

export { AnthropicAdapter } from './anthropic';
export type { AdapterConfig } from './common';

/**
 * Which adapter fits the configured base URL (#296)? The user only gives the base URL in the setup wizard:
 * - Anthropic endpoint (`api.anthropic.com`, Foundry `…/anthropic`) → Claude adapter (Messages API),
 * - everything else (`api.openai.com`, `…openai.azure.com/openai/v1`) → Responses adapter (#297), also for Claude models
 *   if the endpoint offers them there. „Erweitert“ can override the choice.
 */
export function detectAdapter(baseUrl: string, choice: AgentAdapterChoice = 'auto'): AgentAdapterId {
  if (choice !== 'auto') return choice;
  return isAnthropicUrl(baseUrl) ? 'anthropic' : 'openai';
}

/**
 * The Anthropic endpoint of the same Azure resource, e.g. `https://foundry-x.openai.azure.com/openai/v1` →
 * `https://foundry-x.services.ai.azure.com/anthropic`. Claude on Foundry offers native tool use only there.
 */
export function anthropicEndpointFor(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    const m = /^([a-z0-9-]+)\.(?:openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/i.exec(u.hostname);
    return m ? `https://${m[1]}.services.ai.azure.com/anthropic` : null;
  } catch {
    return null;
  }
}

export const looksLikeClaude = (model: string) => /claude|opus|sonnet|haiku|fable|mythos/i.test(model);

export function createAdapter(id: AgentAdapterId, cfg: AdapterConfig): ProviderAdapter {
  return id === 'anthropic' ? new AnthropicAdapter(cfg) : new OpenAiResponsesAdapter(cfg);
}
