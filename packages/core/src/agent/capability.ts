import type { AgentCapability, LlmTestResult } from '@archivist/shared';
import type { AppContext } from '../context';
import type { AppStateService } from '../services/app-state';
import type { LlmOverrides, LlmService } from '../services/llm';
import type { SettingsService } from '../services/settings';
import { AppError, toErrorInfo } from '../util/errors';
import { nowIso } from '../util/ids';
import { anthropicEndpointFor, createAdapter, detectAdapter, looksLikeClaude, type AdapterConfig } from './adapters';
import type { AgentMessage, ProviderAdapter, TurnResult } from './types';

const CAPABILITY_KEY = 'agent.capability';

type Endpoint = Pick<AdapterConfig, 'baseUrl' | 'model'>;

interface CapabilityDeps {
  ctx: AppContext;
  llm: LlmService;
  appState: AppStateService;
  settings: SettingsService;
}

const PROBE_TOOLS = [
  {
    name: 'echo',
    description: 'Gibt einen Text zurück (Verbindungstest).',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

/** A probe that failed for a transient reason (rate limit, server or network) says nothing about tool calling and is not stored. */
interface ProbeOutcome {
  capability: AgentCapability;
  transient: boolean;
}

const isServerOrRateLimit = (status: number | undefined) => status === 429 || (status ?? 0) >= 500;

/** Only rate limits, server errors, timeouts and unreachable endpoints pass; a broken answer would repeat on every probe. */
const isTransient = (err: unknown) =>
  err instanceof AppError && err.retryable && (err.category === 'network_error' || isServerOrRateLimit(err.options.httpStatus));

const PROBE_SYSTEM =
  'Du bist ein Verbindungstest. Rufe das Werkzeug echo genau einmal mit text="archivist" auf. Nachdem du das Ergebnis erhalten hast, antworte mit dem Wort OK.';

/** Real tool call with result round trip and streaming (#296): the connection test of the agent. */
async function probeToolCalling(adapter: ProviderAdapter, endpoint: Endpoint): Promise<ProbeOutcome> {
  const history: AgentMessage[] = [{ role: 'user', content: 'Starte den Test.' }];
  const base = {
    system: PROBE_SYSTEM,
    tools: PROBE_TOOLS,
    maxOutputTokens: 4_000,
    effort: 'low' as const,
    purpose: 'Verbindungstest (Werkzeuge)',
    documentIds: [],
  };
  const suggested = adapter.id === 'openai' && looksLikeClaude(endpoint.model) ? anthropicEndpointFor(endpoint.baseUrl) : null;
  const name = adapter.id === 'anthropic' ? 'Claude (Anthropic Messages API)' : 'OpenAI Responses API';
  const unsupported = (message: string): AgentCapability => ({
    adapter: adapter.id,
    toolCalling: false,
    streaming: false,
    message: suggested
      ? `${message} Für Claude-Modelle auf Microsoft Foundry bietet der Anthropic-Endpunkt derselben Ressource natives Tool-Calling: ${suggested}`
      : message,
    suggestedBaseUrl: suggested,
    checkedAt: nowIso(),
  });
  const fail = (message: string, err?: unknown): ProbeOutcome => ({ capability: unsupported(message), transient: isTransient(err) });
  let first: TurnResult;
  try {
    first = await adapter.turn({ ...base, messages: history });
  } catch (err) {
    return fail(`Werkzeugaufrufe über ${name} schlugen fehl: ${toErrorInfo(err).message}`, err);
  }
  if (!first.toolCalls.some((c) => c.name === 'echo'))
    return fail(`Das Modell hat über ${name} kein Werkzeug aufgerufen – natives Tool-Calling wird über diesen Endpunkt offenbar nicht unterstützt.`);
  history.push({ role: 'assistant', text: first.text, toolCalls: first.toolCalls, provider: adapter.id, model: adapter.model, raw: first.raw });
  history.push({
    role: 'tool',
    results: first.toolCalls.map((c) => ({ callId: c.id, name: c.name, content: c.name === 'echo' ? 'archivist' : 'unbekannt', isError: c.name !== 'echo' })),
  });
  try {
    const second = await adapter.turn({ ...base, messages: history });
    const streaming = first.streamed || second.streamed;
    const ready: AgentCapability = {
      adapter: adapter.id,
      toolCalling: true,
      streaming,
      message: `Agentenmodus bereit: ${name}, natives Tool-Calling${streaming ? ' und Streaming' : ''} funktionieren.`,
      suggestedBaseUrl: null,
      checkedAt: nowIso(),
    };
    return { capability: ready, transient: false };
  } catch (err) {
    return fail(`Das Werkzeugergebnis konnte nicht zurückgegeben werden: ${toErrorInfo(err).message}`, err);
  }
}

/** Whether the configured endpoint supports native tool calling; checked once per endpoint, model and adapter. */
export class AgentCapabilityService {
  private probing: Promise<AgentCapability | null> | null = null;

  constructor(private readonly deps: CapabilityDeps) {}

  private get settings() {
    return this.deps.settings.get();
  }

  private capabilityKey(endpoint: Endpoint): string {
    return `${endpoint.baseUrl}|${endpoint.model}|${detectAdapter(endpoint.baseUrl, this.settings.agent.adapter)}`;
  }

  /** Stored result of the tool-calling test for the configured endpoint, or null if it was never checked. */
  capability(): AgentCapability | null {
    const raw = this.deps.appState.get(CAPABILITY_KEY);
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as { key: string; cap: AgentCapability };
      const config = this.settings.llm;
      return stored.key === this.capabilityKey({ baseUrl: config.baseUrl.trim(), model: config.model.trim() }) ? stored.cap : null;
    } catch {
      return null;
    }
  }

  /** Agent mode is used: switched on, LLM usable (not „nur lokal“), endpoint not known to lack tool calling. */
  isActive(): boolean {
    return this.settings.agent.enabled && this.deps.llm.canUse() && this.capability()?.toolCalling !== false;
  }

  /** Checks tool calling once per endpoint before the first run (one small request). */
  async ensureCapable(): Promise<boolean> {
    if (!this.isActive()) return false;
    if (this.capability()) return true;
    const probing = (this.probing ??= this.probeConfigured());
    const capability = await probing;
    // cleared here, not inside the probe: a probe failing synchronously would otherwise leave its result cached for good
    if (this.probing === probing) this.probing = null;
    return Boolean(capability?.toolCalling);
  }

  private async probeConfigured(): Promise<AgentCapability | null> {
    try {
      return await this.probeAndStore(this.deps.llm.adapterConfig());
    } catch (err) {
      this.deps.ctx.logger.warn('agent', 'Tool-calling probe failed', { error: err });
      return null;
    }
  }

  /** Connection test of the setup dialog: text answer, structured answer (#265) plus real tool calling (#296, #297). */
  async testConnection(overrides: LlmOverrides = {}): Promise<LlmTestResult> {
    const plain = await this.deps.llm.testConnection(overrides);
    if (!plain.ok) return { ...plain, agent: null };
    const text = { ...plain, structured: await this.deps.llm.testStructuredAnswer(overrides) };
    let config: AdapterConfig;
    try {
      config = this.deps.llm.adapterConfig(overrides);
    } catch {
      return { ...text, agent: null };
    }
    return { ...text, agent: await this.probeAndStore(config) };
  }

  private async probeAndStore(config: AdapterConfig): Promise<AgentCapability> {
    const { capability, transient } = await probeToolCalling(createAdapter(detectAdapter(config.baseUrl, this.settings.agent.adapter), config), config);
    if (transient) {
      this.deps.ctx.logger.warn('agent', 'Tool-calling probe failed transiently – not stored, next run probes again', { message: capability.message });
      return capability;
    }
    this.deps.appState.set(CAPABILITY_KEY, JSON.stringify({ key: this.capabilityKey(config), cap: capability }));
    this.deps.ctx.events.changed('settings', 'status');
    return capability;
  }
}
