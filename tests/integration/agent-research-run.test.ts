import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, scriptedTurns, toolOutputs } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

const knowledgeAnswer = (overrides: Record<string, unknown>) => () => ({
  answer: 'Antwort.',
  facts: [],
  interpretation: null,
  uncertainties: [],
  missingInformation: [],
  contradictions: [],
  usedSourceIds: ['S1'],
  confidence: 0.9,
  ...overrides,
});

describe('Agent research over several steps', () => {
  it('searches, reads the hit and closes with a verified answer, each step seeing the result of the one before', async () => {
    await archived(app, {
      name: 'protokoll.txt',
      content: 'Beschluss: Die Plattform zieht bis Ende März nach Frankfurt um, verantwortlich ist Jana.',
      folder: 'work/protokolle',
    });
    app.llm.on(
      'KnowledgeAnswer',
      knowledgeAnswer({ answer: 'Nach Frankfurt.', facts: [{ statement: 'Die Plattform zieht nach Frankfurt.', sourceIds: ['S1'] }] }),
    );
    const seen: string[][] = [];
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'search', args: { query: 'Plattform Umzug Frankfurt' } }] },
      (request) => {
        seen.push(toolOutputs(app));
        expect(request.tools).toContain('read_document');
        return { calls: [{ name: 'read_document', args: { id: 'D1' } }] };
      },
      () => {
        seen.push(toolOutputs(app));
        return { calls: [{ name: 'verified_answer', args: { question: 'Wohin zieht die Plattform um?' } }] };
      },
      () => {
        seen.push(toolOutputs(app));
        return { text: 'Die Plattform zieht nach Frankfurt (D1).' };
      },
    );

    const res = await app.ok('chat:send', { text: 'Wohin zieht die Plattform um und wer ist zuständig?' });

    expect(seen[0]!.at(-1)).toContain('protokoll');
    expect(seen[1]!.at(-1)).toContain('verantwortlich ist Jana');
    expect(seen[2]!.at(-1)).toContain('**Belegte Fakten**');
    expect(res.assistantMessage.content).toContain('Frankfurt');
  });

  it('verified_answer flags what the sources do not prove', async () => {
    await archived(app, {
      name: 'angebot.txt',
      content: 'Angebot Dachdecker Kowalski über 18.000 Euro, Beginn der Arbeiten nach Absprache.',
      folder: 'private/haus',
    });
    app.llm.on(
      'KnowledgeAnswer',
      knowledgeAnswer({
        answer: 'Das Angebot beträgt 18.000 Euro.',
        facts: [{ statement: 'Das Angebot beträgt 18.000 Euro.', sourceIds: ['S1'] }],
        missingInformation: ['Ein Starttermin'],
        uncertainties: ['Ob das Angebot angenommen wurde, steht nicht fest.'],
        confidence: 0.4,
      }),
    );
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'verified_answer', args: { question: 'Wann beginnt der Dachdecker mit den Arbeiten?' } }] },
      { text: 'Das ist nicht belegt.' },
    );

    await app.ok('chat:send', { text: 'Wann beginnt der Dachdecker mit den Arbeiten?' });

    const out = toolOutputs(app).at(-1)!;
    expect(out).toContain('**Unsicherheiten**');
    expect(out).toContain('• Ob das Angebot angenommen wurde, steht nicht fest.');
    expect(out).toContain('• Fehlt: Ein Starttermin');
    expect(out).toContain('• Die Antwort ist nur mit geringer Sicherheit belegt.');
  });
});
