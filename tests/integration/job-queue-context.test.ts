import { afterEach, beforeEach, expect, it } from 'vitest';
import { agentRunScope, currentRun } from '../../packages/core/src/agent/scope';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;

beforeEach(async () => {
  app = await createTestApp();
});
afterEach(async () => {
  await app.cleanup();
});

it('runs a job the user queued behind an agent-started job outside the agent run scope', async () => {
  const { jobs, audit } = app.services;
  let releaseAgent!: () => void;
  const agentGate = new Promise<void>((resolve) => (releaseAgent = resolve));
  jobs.register('test.agent', {
    handler: async () => {
      await agentGate;
      return {};
    },
  });
  const runIds: Array<string | null> = [];
  jobs.register('test.user', {
    handler: async () => {
      runIds.push(currentRun()?.runId ?? null);
      audit.log({ action: 'test.user', actor: 'user', trigger: 'manual', confirmed: true });
      return {};
    },
  });

  agentRunScope.run({ runId: 'agent-run', explicit: true, auditIds: [] }, () => jobs.enqueue('test.agent', { label: 'Agentenjob' }));
  const userJob = jobs.enqueue('test.user', { label: 'Dein Job' });
  expect(jobs.get(userJob.id).status).toBe('pending');

  releaseAgent();
  expect((await jobs.waitFor(userJob.id, 5_000)).status).toBe('succeeded');

  expect(runIds).toEqual([null]);
  expect(audit.forRun('agent-run')).toEqual([]);
});
