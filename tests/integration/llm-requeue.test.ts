import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../packages/core/src/util/errors';
import { classification } from '../helpers/document-classifications';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
  app.llm.on('DocumentClassification', () =>
    classification({ title: 'Mietvertrag Wohnung', summary: 'Ein Vertrag.', categoryPath: 'Privat/wohnen', docType: 'Vertrag' }),
  );
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await app.cleanup();
});

const importOne = async (name = 'vertrag.txt') => {
  const result = await app.ok('documents:import', {
    paths: [app.file(`in/${name}`, 'Mietvertrag für die Wohnung in der Musterstraße 1, Miete 800 Euro im Monat.')],
  });
  return result.imported[0]!.id;
};
const analyzeJob = () => app.services.jobs.list().find((job) => job.type === 'document.analyze')!;
const llmFailures = () => app.services.notifications.list().filter((n) => n.title === 'KI-Analyse fehlgeschlagen');

describe('A rate limit or an outage re-queues the analysis instead of downgrading it (#220)', () => {
  it('keeps the document pending and analyses it with the LLM once the endpoint answers again', async () => {
    // the client's 3 attempts all fail once, so the job is re-queued
    app.llm.failing = { count: 3, status: 429, retryAfter: '0' };
    const id = await importOne();
    await app.services.jobs.whenIdle();

    const document = await app.ok('documents:get', { id });
    expect(document).toMatchObject({ status: 'proposed', llmStatus: 'analyzed' });
    expect(document.proposal?.analyzedBy).toBe('llm');
    expect(llmFailures()).toHaveLength(0);
    expect(analyzeJob()).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('falls back to the local classification, with the notification, after 5 failed attempts', async () => {
    app.llm.status = 503;
    const id = await importOne();
    await app.services.jobs.whenIdle();

    expect(analyzeJob()).toMatchObject({ status: 'succeeded', attempts: 5 });
    const document = await app.ok('documents:get', { id });
    expect(document).toMatchObject({ status: 'proposed', llmStatus: 'pending' });
    expect(document.proposal?.analyzedBy).toBe('local');
    expect(llmFailures()).toHaveLength(1);
  });

  it('waits as long as the server asked (retryAfterMs) before the next attempt', async () => {
    app.llm.failing = { count: 1000, status: 429, retryAfter: '3600' };
    const id = await importOne();
    await vi.waitFor(() => expect(analyzeJob().progressMessage).toMatch(/Neuer Versuch in 300 s/));

    expect(analyzeJob().status).toBe('pending');
    expect(await app.ok('documents:get', { id })).toMatchObject({ llmStatus: 'pending', processingError: null });
    expect(llmFailures()).toHaveLength(0);
    app.services.jobs.cancel(analyzeJob().id);
  });

  it('caps a server wish at 5 minutes', () => {
    expect(new AppError('llm_error', 'x', { retryable: true, retryAfterMs: 9_999_999 }).retryAfterMs).toBe(300_000);
    expect(new AppError('llm_error', 'x', { retryable: true }).retryAfterMs).toBeUndefined();
  });

  /** Until the analysis job ended or waits for its third attempt – the second one met the open circuit breaker. */
  const untilSecondAttemptSettled = () =>
    vi.waitFor(() => {
      const job = analyzeJob();
      expect(job.status === 'succeeded' || (job.status === 'pending' && job.attempts === 2)).toBe(true);
    });

  it('waits for the open circuit after a rate limit without Retry-After and then analyses with the LLM', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
    app.llm.failing = { count: 3, status: 429, retryAfter: null };
    const id = await importOne();
    await untilSecondAttemptSettled();
    await vi.advanceTimersByTimeAsync(15_000);
    await app.services.jobs.whenIdle();

    const document = await app.ok('documents:get', { id });
    expect(document).toMatchObject({ status: 'proposed', llmStatus: 'analyzed' });
    expect(document.proposal?.analyzedBy).toBe('llm');
    expect(llmFailures()).toHaveLength(0);
    expect(analyzeJob()).toMatchObject({ status: 'succeeded', attempts: 3 });
  });

  it('waits for the open circuit after an unreachable endpoint and then analyses with the LLM', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
    app.llm.down = true;
    const id = await importOne();
    await untilSecondAttemptSettled();
    app.llm.down = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await app.services.jobs.whenIdle();

    const document = await app.ok('documents:get', { id });
    expect(document).toMatchObject({ status: 'proposed', llmStatus: 'analyzed' });
    expect(document.proposal?.analyzedBy).toBe('llm');
    expect(llmFailures()).toHaveLength(0);
    expect(analyzeJob()).toMatchObject({ status: 'succeeded', attempts: 3 });
  });

  it('does not re-queue an error that retrying cannot fix', async () => {
    app.llm.status = 401;
    const id = await importOne();
    await app.services.jobs.whenIdle();

    expect(analyzeJob()).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect((await app.ok('documents:get', { id })).proposal?.analyzedBy).toBe('local');
    expect(llmFailures()).toHaveLength(1);
  });
});
