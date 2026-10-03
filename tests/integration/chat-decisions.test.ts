import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { extractedDecision, intent } from '../helpers/chat-intents';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

describe('Decision workflow with follow-up questions (LLM)', () => {
  it('asks targeted follow-up questions, saves only when complete and finds the decision again', async () => {
    let step = 0;
    app.llm.on('ChatIntent', (_s, input) => {
      step += 1;
      if (/prod-plat erstmal nicht weitermachen/.test(input) && step === 1) {
        return intent({
          intent: 'decision_new',
          decision: extractedDecision({
            decisionText: 'Wir machen mit prod-plat erstmal nicht weiter.',
            title: 'prod-plat pausiert',
            topic: 'prod-plat',
            topicIsProject: null,
          }),
        });
      }
      if (/Am 3\. März/.test(input)) {
        return intent({
          intent: 'decision_amend',
          decision: extractedDecision({ decidedAt: '2026-03-03', participants: ['Anna', 'Ben'], topicIsProject: true }),
        });
      }
      if (/Wann haben wir/.test(input)) return intent({ intent: 'knowledge_question', query: 'prod-plat pausiert Entscheidung' });
      return intent({ intent: 'unknown' });
    });
    app.llm.on('KnowledgeAnswer', (_s, input) => {
      expect(input).toContain('[S1]');
      return {
        answer: 'prod-plat wurde am 3. März 2026 pausiert.',
        facts: [
          { statement: 'Die Entscheidung zur Pause fiel am 2026-03-03.', sourceIds: ['S1'] },
          { statement: 'Erfundene Aussage ohne Beleg.', sourceIds: ['S99'] },
        ],
        interpretation: 'Die Pause könnte mit dem Budget zusammenhängen.',
        uncertainties: [],
        contradictions: [],
        missingInformation: ['Begründung der Pause'],
        usedSourceIds: ['S1', 'S42'],
        confidence: 0.8,
      };
    });

    const r1 = await app.ok('chat:send', { text: 'Wir haben entschieden, dass wir mit prod-plat erstmal nicht weitermachen.' });
    const m1 = r1.assistantMessage;
    expect(m1.content).toContain('Wann wurde das entschieden?');
    expect(m1.content).not.toContain('Wer war an der Entscheidung beteiligt?');
    expect(m1.content).toMatch(/„prod-plat“ das Thema oder der Name des Projekts/);
    const draft = (await app.ok('decisions:list', {}))[0]!;
    expect(draft.status).toBe('draft');
    expect(draft.missingFields).toEqual(['decidedAt']);

    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Am 3. März 2026 mit Anna und Ben, prod-plat ist ein Projekt.' });
    expect(r2.assistantMessage.content).toContain('Die Entscheidung ist gespeichert');
    const saved = await app.ok('decisions:get', { id: draft.id });
    expect(saved.status).toBe('active');
    expect(saved.decidedAt?.slice(0, 10)).toBe('2026-03-03');
    expect(saved.participants).toEqual(['Anna', 'Ben']);
    expect(saved.projectName).toBe('prod-plat');
    expect(saved.missingFields).toEqual([]);

    const r3 = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Wann haben wir prod-plat pausiert?' });
    const a = r3.assistantMessage;
    expect(a.sources.length).toBeGreaterThan(0);
    expect(a.sources[0]!.type).toBe('decision');
    expect(a.content).toContain('3. März 2026');
    expect(a.content).not.toContain('Erfundene Aussage');
    expect(a.content).toContain('Einschätzung');
    expect(a.uncertainties.join(' ')).toMatch(/Begründung der Pause/);
    expect(a.uncertainties.join(' ')).toMatch(/ohne gültigen Quellenbeleg/);
    expect(a.context?.decisions?.length).toBeGreaterThan(0);
  });

  it('saves a decision without participants once date and topic are known (#198)', async () => {
    app.llm.on('ChatIntent', () =>
      intent({
        intent: 'decision_new',
        decision: extractedDecision({ decisionText: 'Wir wechseln den Stromanbieter.', topic: 'Strom', topicIsProject: false, decidedAt: '2026-02-01' }),
      }),
    );
    const r1 = await app.ok('chat:send', { text: 'Wir wechseln den Stromanbieter, seit 1.2.2026.' });
    expect(r1.assistantMessage.content).toContain('gespeichert');
    expect(r1.assistantMessage.content).not.toContain('Wer war an der Entscheidung beteiligt?');
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.status).toBe('active');
    expect(d.participants).toEqual([]);
  });
});

describe('Decision workflow without an LLM (rule-based fallback)', () => {
  it('asks step by step and points out the missing LLM', async () => {
    app.llm.down = true;
    const r1 = await app.ok('chat:send', { text: 'Wir haben entschieden, dass wir mit prod-plat erstmal nicht weitermachen.' });
    expect(r1.assistantMessage.content).toContain('Wann wurde das entschieden?');
    expect(r1.assistantMessage.content).not.toContain('Wer war an der Entscheidung');
    expect(r1.assistantMessage.errorMessage).toMatch(/nicht erreichbar/);
    const r2 = await app.ok('chat:send', { conversationId: r1.conversationId, text: '12.03.2026' });
    expect(r2.assistantMessage.content).toContain('gespeichert');
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.decidedAt?.slice(0, 10)).toBe('2026-03-12');
    expect(d.topicName).toBe('prod-plat');
  });

  it('returns a local hit list with sources for knowledge questions without an LLM', async () => {
    await app.ok('decisions:create', {
      decisionText: 'Wir pausieren prod-plat.',
      title: 'prod-plat pausiert',
      topic: 'prod-plat',
      decidedAt: '2026-03-03',
      participants: ['Anna'],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
      asDraft: false,
    });
    await app.services.search.index({ type: 'note', id: 'x', title: 'x', content: 'x' }).catch(() => undefined);
    app.llm.down = true;
    const r = await app.ok('chat:send', { text: 'Wann haben wir prod-plat pausiert?' });
    expect(r.assistantMessage.sources[0]?.type).toBe('decision');
    expect(r.assistantMessage.content).toMatch(/lokale Trefferliste/);
    expect(r.assistantMessage.confidence).toBeLessThan(0.6);
  });

  it('openly admits when nothing was found', async () => {
    const r = await app.ok('chat:send', { text: 'Haben wir jemals über Vault gesprochen?' });
    expect(r.assistantMessage.content).toMatch(/nichts/);
    expect(r.assistantMessage.sources).toHaveLength(0);
  });
});

describe('Contradictions and replacing only after confirmation', () => {
  const mk = (text: string, date: string) => ({
    decisionText: text,
    title: text.slice(0, 40),
    topic: 'prod-plat',
    decidedAt: date,
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });

  it('detects two contradicting decisions, shows insight + hint and replaces only after confirmation', async () => {
    app.llm.down = true; // purely lexical check with controlled sample data
    const a = await app.ok('decisions:create', mk('Wir führen prod-plat weiter.', '2026-01-10'));
    const b = await app.ok('decisions:create', mk('Wir machen mit prod-plat vorerst nicht weiter.', '2026-03-01'));
    const list = await app.ok('contradictions:list', {});
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe('detected');
    expect(list[0]!.affectedEntityIds.sort()).toEqual([a.id, b.id].sort());
    expect(list[0]!.confidence).toBeGreaterThan(0.5);

    const insights = await app.ok('insights:list', { status: 'open' });
    const ins = insights.find((i) => i.kind === 'contradiction')!;
    expect(ins.recommendedActionLabel).toMatch(/ersetzt/);
    const notes = await app.ok('notifications:list', {});
    expect(notes.some((n) => n.type === 'contradiction')).toBe(true);

    // no autonomous change
    expect((await app.ok('decisions:get', { id: a.id })).status).toBe('active');

    // rejected without confirmation
    const denied = await app.call('insights:respond', { response: 'accept', id: ins.id, confirmed: false as unknown as true, strongConfirmed: false });
    expect(denied.ok).toBe(false);
    expect((await app.ok('decisions:get', { id: a.id })).status).toBe('active');

    await app.ok('insights:respond', { response: 'accept', id: ins.id, confirmed: true, strongConfirmed: false });
    const old = await app.ok('decisions:get', { id: a.id });
    expect(old.status).toBe('superseded');
    expect((await app.ok('decisions:get', { id: b.id })).supersedesDecisionId).toBe(a.id);

    // undo first checks for newer changes
    const audit = await app.ok('audit:list', { limit: 50, onlyUndoable: true });
    const entry = audit.find((e) => e.action === 'decision.supersede')!;
    await app.ok('decisions:update', { id: a.id, patch: { rationale: 'nachträglich ergänzt' } });
    const blocked = await app.ok('audit:undo', { auditId: entry.id });
    expect(blocked.undone).toBe(false);
    expect(blocked.conflicts.join(' ')).toMatch(/verändert/);
  });

  it('undo restores the status when nothing was changed', async () => {
    app.llm.down = true;
    const a = await app.ok('decisions:create', mk('Wir führen prod-plat weiter.', '2026-01-10'));
    const b = await app.ok('decisions:create', mk('prod-plat wird eingestellt.', '2026-03-01'));
    const act = await app.services.actions.resolve((await app.ok('actions:list', { status: 'proposed' }))[0]!.id, { decision: 'approve', confirmed: true });
    expect(act.status).toBe('executed');
    const entry = (await app.ok('audit:list', { limit: 20, onlyUndoable: true })).find((e) => e.action === 'decision.supersede')!;
    const res = await app.ok('audit:undo', { auditId: entry.id });
    expect(res.undone).toBe(true);
    expect((await app.ok('decisions:get', { id: a.id })).status).toBe('active');
    expect((await app.ok('decisions:get', { id: b.id })).supersedesDecisionId).toBeNull();
  });

  it('shows the replace proposal in the chat when a new decision contradicts', async () => {
    app.llm.down = true;
    await app.ok('decisions:create', mk('Wir führen prod-plat weiter.', '2026-01-10'));
    const r = await app.ok('chat:send', { text: 'Wir haben entschieden, dass wir prod-plat pausieren. Datum 01.03.2026.' });
    // rule-based: date and topic prod-plat detected – complete without participants, so the contradiction check runs right away
    expect(r.assistantMessage.content).toMatch(/Widerspruch|widersprüchlich/);
    expect(r.assistantMessage.actions.some((x) => x.actionType === 'supersede_decision' && x.status === 'proposed')).toBe(true);
  });
});

describe('Invalid LLM outputs trigger nothing', () => {
  it('discards answers that do not match the schema and changes nothing', async () => {
    app.llm.on('ChatIntent', () => ({ intent: 'decision_new', confidence: 7, decision: { participants: 'Anna' } }));
    const r = await app.ok('chat:send', { text: 'Wir haben entschieden, X zu tun.' });
    // falls back to rule-based evaluation and visibly flags the technical error
    expect(r.assistantMessage.errorMessage).toMatch(/Format/);
    const calls = app.llm.calls.filter((c) => c.schema === 'ChatIntent');
    expect(calls.length).toBe(2); // one correction request
    expect(calls[1]!.input).toContain('ungültig');
  });

  it('accepts a corrected answer on the second attempt', async () => {
    let k = 0;
    app.llm.on('ChatIntent', () => (++k === 1 ? 'das ist kein json' : intent({ intent: 'smalltalk' })));
    const r = await app.ok('chat:send', { text: 'Hallo' });
    expect(r.assistantMessage.errorMessage).toBeNull();
    expect(k).toBe(2);
  });

  it('rejects actions with invalid parameters', () => {
    expect(() =>
      app.services.actions.propose({
        actionType: 'supersede_decision',
        rationale: 'x',
        confidence: 0.5,
        affectedEntities: [],
        requiredConfirmation: 'confirm',
        proposedParameters: { oldDecisionId: 5 },
        label: 'x',
      }),
    ).toThrow(/ungültige Parameter/);
  });
});

describe('An addition without a running follow-up question (#177)', () => {
  it('changes the last decision instead of creating a new one from the addition sentence', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      /Ben war übrigens auch dabei/.test(input)
        ? intent({ intent: 'decision_amend', decision: extractedDecision({ participants: ['Ben'] }) })
        : intent({
            intent: 'decision_new',
            decision: extractedDecision({
              decisionText: 'Wir wechseln zum Stromanbieter B.',
              decidedAt: '2026-03-03',
              topic: 'Strom',
              topicIsProject: false,
              participants: ['Anna'],
            }),
          }),
    );
    const r1 = await app.ok('chat:send', { text: 'Wir haben am 3.3.2026 entschieden, zum Stromanbieter B zu wechseln. Anna war dabei.' });
    const [first] = await app.ok('decisions:list', {});
    expect(first!.status).toBe('active');

    await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Ben war übrigens auch dabei.' });

    const all = await app.ok('decisions:list', {});
    expect(all).toHaveLength(1);
    expect(all[0]!.participants).toEqual(expect.arrayContaining(['Anna', 'Ben']));
    expect(all[0]!.decisionText).toBe('Wir wechseln zum Stromanbieter B.');
  });

  it('asks what to add when the addition names nothing that can be stored', async () => {
    app.llm.on('ChatIntent', (_s, input) =>
      /Noch was dazu/.test(input)
        ? intent({ intent: 'decision_amend', decision: extractedDecision() })
        : intent({
            intent: 'decision_new',
            decision: extractedDecision({
              decisionText: 'Wir wechseln zu B.',
              decidedAt: '2026-03-03',
              topic: 'Strom',
              topicIsProject: false,
              participants: ['Anna'],
            }),
          }),
    );
    const r1 = await app.ok('chat:send', { text: 'Wir haben entschieden, zu B zu wechseln.' });
    const r = await app.ok('chat:send', { conversationId: r1.conversationId, text: 'Noch was dazu.' });
    expect(r.assistantMessage.content).toMatch(/Was soll ich an der Entscheidung/);
    expect(await app.ok('decisions:list', {})).toHaveLength(1);
  });
});
