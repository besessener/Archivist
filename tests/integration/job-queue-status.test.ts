import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
afterEach(async () => app.cleanup());

describe('Local services status with failed jobs', () => {
  it('keeps the job queue healthy while old failed jobs remain, and counts them for the jobs indicator', async () => {
    app = await createTestApp();
    app.services.jobs.register('test.broken', {
      handler: async () => {
        throw new Error('kaputt');
      },
    });
    app.services.jobs.enqueue('test.broken', { label: 'Kaputt', payload: {}, maxAttempts: 1 });
    await app.services.jobs.whenIdle();

    const status = await app.ok('app:getStatus', {});

    expect(status.jobs.failed).toBe(1);
    expect(status.services.find((service) => service.name === 'Job-Queue')).toMatchObject({ status: 'ok', detail: '0 wartend, 0 laufend, 1 fehlgeschlagen' });
  });
});
