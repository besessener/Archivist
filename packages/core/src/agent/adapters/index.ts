import type { AgentAdapterChoice, AgentAdapterId } from '@archivist/shared';
import type { ProviderAdapter } from '../types';
import { AnthropicAdapter, isAnthropicUrl } from './anthropic';
import type { AdapterConfig } from './common';
import { OpenAiResponsesAdapter } from './openai';

export { AnthropicAdapter } from './anthropic';
export { claudeTextEffort } from './anthropic-text';
export type { AdapterConfig } from './common';

/** Anthropic endpoints (`api.anthropic.com`, Foundry `…/anthropic`) get the Messages API, everything else Responses (#296, #297). */
export function detectAdapter(baseUrl: string, choice: AgentAdapterChoice = 'auto'): AgentAdapterId {
  if (choice !== 'auto') return choice;
  return isAnthropicUrl(baseUrl) ? 'anthropic' : 'openai';
}

/** The Anthropic endpoint of the same Azure resource, where Claude on Foundry offers native tool use. */
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

export function createAdapter(id: AgentAdapterId, config: AdapterConfig): ProviderAdapter {
  return id === 'anthropic' ? new AnthropicAdapter(config) : new OpenAiResponsesAdapter(config);
}
