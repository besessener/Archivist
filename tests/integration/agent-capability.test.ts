import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentApp } from '../helpers/agent';
import type { TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.cleanup();
});

describe('tool-calling probe before the first agent run', () => {
  it('probes again after a probe that failed right away, instead of keeping the failure for good', async () => {
    vi.spyOn(app.services.llm, 'adapterConfig').mockImplementationOnce(() => {
      throw new Error('Endpunkt nicht konfiguriert');
    });

    expect(await app.services.agent.ensureCapable()).toBe(false);
    expect(app.services.agent.capability()).toBeNull();

    await app.services.agent.ensureCapable();

    expect(app.services.agent.capability()).not.toBeNull();
  });

  it('probes again after a rate limit instead of switching agent mode off for good', async () => {
    app.llm.failing = { count: 1, status: 429, retryAfter: null };
    const warn = vi.spyOn(app.services.logger, 'warn');

    expect(await app.services.agent.ensureCapable()).toBe(false);
    expect(app.services.agent.capability()).toBeNull();
    expect(warn).toHaveBeenCalledWith('agent', expect.stringContaining('not stored'), { message: expect.stringContaining('LLM-Limit') });
    expect(app.services.agent.isActive()).toBe(true);

    expect(await app.services.agent.ensureCapable()).toBe(true);
    expect(app.services.agent.capability()?.toolCalling).toBe(true);
  });

  it('keeps a rejected probe, so agent mode stays off for that endpoint', async () => {
    app.llm.failing = { count: 1, status: 400, retryAfter: null };

    expect(await app.services.agent.ensureCapable()).toBe(false);

    expect(app.services.agent.capability()?.toolCalling).toBe(false);
    expect(app.services.agent.isActive()).toBe(false);
  });
});
