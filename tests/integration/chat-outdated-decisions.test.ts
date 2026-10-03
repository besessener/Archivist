import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { intent } from '../helpers/chat-intents';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
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
    await decision('Das Meeting findet donnerstags statt.', '2026-03-01');
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
});
