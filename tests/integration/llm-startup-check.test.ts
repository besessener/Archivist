import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(() => app.cleanup());

const llmStatus = async () => (await app.ok('app:getStatus')).llm.status;
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
};

describe('KI connection is checked on startup', () => {
  it('a configured connection shows „Verbunden“ without a manual test', async () => {
    app = await createTestApp();
    expect(await llmStatus()).toBe('unknown');
    app.services.start();
    await until(async () => (await llmStatus()) !== 'unknown');
    expect(await llmStatus()).toBe('ok');
  });

  it('a failing connection shows the error', async () => {
    app = await createTestApp();
    app.llm.status = 401;
    app.services.start();
    await until(async () => (await llmStatus()) !== 'unknown');
    expect(await llmStatus()).toBe('error');
  });

  it('mode „nur lokal“ sends nothing', async () => {
    app = await createTestApp({ privacy: 'local_only' });
    app.services.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(app.llm.calls).toHaveLength(0);
    expect(await llmStatus()).toBe('unknown');
  });
});
