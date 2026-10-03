import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { intent } from '../helpers/chat-intents';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.cleanup();
});

const decision = (decisionText: string, decidedAt: string) =>
  app.ok('decisions:create', {
    title: decisionText.slice(0, 40),
    decisionText,
    topic: 'prod-plat',
    decidedAt,
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });

describe('Contradiction check in the chat (#252)', () => {
  it('also reports possibly outdated decisions', async () => {
    app.llm.down = true;
    await decision('Das Meeting findet dienstags statt.', '2026-01-10');
    await decision('Das Protokoll schreibt Anna.', '2026-03-01');
    await app.services.consistency.run({ trigger: 'test' });
    app.llm.down = false;
    app.llm.on('ChatIntent', () => intent({ intent: 'contradiction_check' }));

    const reply = await app.ok('chat:send', { text: 'Gibt es Widersprüche?' });

    expect(reply.assistantMessage.content).toContain('Möglicherweise überholte Entscheidungen');
    expect(reply.assistantMessage.content).toContain('Das Meeting findet dienstags statt');
  });

  it('runs the contradiction scan as a job (#254)', async () => {
    app.llm.on('ChatIntent', () => intent({ intent: 'contradiction_check' }));

    await app.ok('chat:send', { text: 'Gibt es Widersprüche?' });

    expect(app.services.jobs.list().find((job) => job.type === 'contradiction.scan')).toMatchObject({ status: 'succeeded', label: 'Widersprüche prüfen' });
  });

  const scanJob = () => app.services.jobs.list().find((job) => job.type === 'contradiction.scan')!;
  const askForContradictions = async () => {
    app.llm.on('ChatIntent', () => intent({ intent: 'contradiction_check' }));
    return (await app.ok('chat:send', { text: 'Gibt es Widersprüche?' })).assistantMessage.content;
  };

  it('says so when the scan was cancelled, instead of only „keine widersprüchlichen Aussagen“ (#254)', async () => {
    vi.spyOn(app.services.contradictions, 'scanAll').mockImplementation(async (signal) => {
      app.services.jobs.cancel(scanJob().id);
      signal?.throwIfAborted();
      return [];
    });

    const content = await askForContradictions();

    expect(scanJob().status).toBe('cancelled');
    expect(content).toContain('Die Prüfung wurde abgebrochen');
  });

  it('names the error when the scan failed (#254)', async () => {
    vi.spyOn(app.services.contradictions, 'scanAll').mockRejectedValue(new Error('Datenbank gesperrt'));

    expect(await askForContradictions()).toMatch(/Die Prüfung ist fehlgeschlagen: .*Datenbank gesperrt/);
  });

  it('points to the job while the scan is still running (#254)', async () => {
    // the chat's wait ran out before the job started
    await app.services.jobs.stop();
    vi.spyOn(app.services.jobs, 'waitFor').mockImplementation(async (id) => app.services.jobs.get(id));

    expect(await askForContradictions()).toContain('Die Prüfung läuft noch im Hintergrund');
  });
});
