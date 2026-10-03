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
});
