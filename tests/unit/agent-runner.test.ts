import { describe, expect, it } from 'vitest';
import type { TurnRequest, TurnResult } from '../../packages/core/src/agent/types';
import { AppError } from '../../packages/core/src/util/errors';
import { call, calls, expectAllCallsAnswered, lastTool, setupRunner, toolMessages } from '../helpers/agent-runner';

describe('AgentRunner (#295)', () => {
  it('works through several rounds until the model is done', async () => {
    const t = setupRunner([calls(call('lookup', { q: 'rechnung' })), calls(call('change', { ids: ['a', 'b'] })), { text: 'Fertig: 2 geändert.' }]);
    const out = await t.runner.run();
    expect(out.status).toBe('done');
    expect(out.text).toBe('Fertig: 2 geändert.');
    expect(out.rounds).toBe(3);
    expect(out.usage).toMatchObject({ requests: 3, inputTokens: 30, outputTokens: 15, retries: 0 });
    expect(out.steps.map((s) => [s.tool, s.outcome, s.round])).toEqual([
      ['lookup', 'ok', 1],
      ['change', 'ok', 2],
    ]);
    expect(t.ctx.changes).toEqual(['2 Einträge geändert']);
    expect(t.ctx.changedCount).toBe(2);
    expect(t.texts).toEqual(['Fertig: 2 geändert.']);
    // request 2 carries the result of round 1, request 3 that of round 2
    expect(lastTool(t.adapter.requests[1]!).results[0]!.content).toBe('Treffer für rechnung');
    expect(lastTool(t.adapter.requests[2]!).results[0]!.content).toBe('2 geändert');
    expect(t.adapter.requests[0]!.tools.map((x) => x.name)).toEqual(['ask_user', 'change', 'danger', 'lookup', 'memo']);
    expect(t.adapter.requests[0]!).toMatchObject({ system: 'SYSTEM', effort: 'high', maxOutputTokens: 32_000, purpose: 'Agent' });
    // the history is append-only: everything appended went through onAppend
    expect(t.history.slice(1)).toEqual(t.appended);
    expect(t.history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
  });

  it('a one-shot answer counts as one round', async () => {
    const t = setupRunner([{ text: 'Hallo!' }]);
    const out = await t.runner.run();
    expect(out).toMatchObject({ status: 'done', text: 'Hallo!', rounds: 1 });
  });

  it('runs the read calls of a round in parallel and answers all calls together in ONE tool message, in call order', async () => {
    const t = setupRunner([
      calls(call('lookup', { q: 'langsam', delay: 40 }, 'r1'), call('change', { ids: ['x'] }, 'w1'), call('lookup', { q: 'schnell', delay: 1 }, 'r2')),
      { text: 'ok' },
    ]);
    await t.runner.run();
    expect(t.probe.maxActive).toBe(2);
    // both reads started before the first finished; the change ran after the reads
    expect(t.probe.order.slice(0, 2)).toEqual(['start:langsam', 'start:schnell']);
    expect(t.probe.order.at(-1)).toBe('change:x');
    const req = t.adapter.requests[1]!;
    expect(toolMessages(req.messages)).toHaveLength(1);
    expect(lastTool(req).results.map((r) => r.callId)).toEqual(['r1', 'w1', 'r2']);
    expect(lastTool(req).results.map((r) => r.content)).toEqual(['Treffer für langsam', '1 geändert', 'Treffer für schnell']);
  });

  it('invalid arguments become an error result and the run continues', async () => {
    const t = setupRunner([calls(call('lookup', { q: 42 })), (req) => ({ text: lastTool(req).results[0]!.isError ? 'korrigiert' : 'falsch' })]);
    const out = await t.runner.run();
    expect(out).toMatchObject({ status: 'done', text: 'korrigiert' });
    const r = lastTool(t.adapter.requests[1]!).results[0]!;
    expect(r).toMatchObject({ isError: true, name: 'lookup' });
    expect(r.content).toMatch(/^Ungültige Argumente: q: /);
  });

  it('an unknown tool is answered with the list of available tools', async () => {
    const t = setupRunner([calls(call('zaubern', { x: 1 })), { text: 'ok' }]);
    const out = await t.runner.run();
    expect(out.status).toBe('done');
    const r = lastTool(t.adapter.requests[1]!).results[0]!;
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Unbekanntes Werkzeug „zaubern“');
    expect(r.content).toContain('lookup');
  });

  it('a tool that throws becomes an error result with the message; the run goes on', async () => {
    const t = setupRunner([calls(call('lookup', { q: 'boom' })), { text: 'weiter' }]);
    const out = await t.runner.run();
    expect(out.status).toBe('done');
    expect(out.steps[0]).toMatchObject({ outcome: 'error', summary: 'Platte voll' });
    expect(lastTool(t.adapter.requests[1]!).results[0]).toMatchObject({ isError: true, content: 'Fehler: Platte voll' });
  });

  describe('limits (#302)', () => {
    /** A new, different read call per round (no loop). */
    const endless = (req: TurnRequest, n: number): Partial<TurnResult> =>
      req.maxOutputTokens === 2_000 ? { text: '' } : calls(call('lookup', { q: `q${n}` }));

    it('maxRounds: stops with status limit; the wrap-up request carries the note and its text is the answer', async () => {
      const t = setupRunner([(req, n) => (req.maxOutputTokens === 2_000 ? { text: 'Zwei Suchen erledigt, es fehlt noch der Rest.' } : endless(req, n))], {
        limits: { maxRounds: 2 },
      });
      const out = await t.runner.run();
      expect(out).toMatchObject({ status: 'limit', limitReason: 'rounds', text: 'Zwei Suchen erledigt, es fehlt noch der Rest.', rounds: 2 });
      expect(t.adapter.requests).toHaveLength(3);
      const wrap = t.adapter.requests[2]!;
      expect(wrap.maxOutputTokens).toBe(2_000);
      expect(lastTool(wrap).note).toContain('Technische Grenze erreicht: die Höchstzahl an Arbeitsschritten');
      expect(lastTool(wrap).note).toContain('Rufe KEINE Werkzeuge mehr auf');
      expect(t.probe.order.filter((x) => x.startsWith('end:'))).toHaveLength(2);
      expectAllCallsAnswered(t.history);
    });

    it('maxRounds: without a wrap-up text the fallback summary names what was done', async () => {
      const t = setupRunner([(req, n) => (req.maxOutputTokens === 2_000 ? { text: '' } : n === 0 ? calls(call('change', { ids: ['a'] })) : endless(req, n))], {
        limits: { maxRounds: 2 },
      });
      const out = await t.runner.run();
      expect(out.status).toBe('limit');
      expect(out.text).toContain('Ich habe die Höchstzahl an Arbeitsschritten erreicht');
      expect(out.text).toContain('• 1 Einträge geändert');
      expect(out.text).toContain('Soll ich weitermachen?');
    });

    it('maxTokens: the usage of the provider counts against the budget', async () => {
      const usage = { inputTokens: 3_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const t = setupRunner([(req, n) => ({ ...endless(req, n), usage })], { limits: { maxTokens: 5_000 } });
      const out = await t.runner.run();
      expect(out).toMatchObject({ status: 'limit', limitReason: 'tokens', rounds: 2 });
      expect(out.usage.inputTokens).toBe(9_000);
      const wrap = t.adapter.requests[2]!;
      expect(lastTool(wrap).note).toContain('das Token-Budget dieses Laufs');
      // the remaining budget is passed on (Claude task budget)
      expect(t.adapter.requests[0]!.taskBudget).toBe(5_000);
      expect(t.adapter.requests[1]!.taskBudget).toBe(1_900);
      expect(out.text).toContain('Ich habe das Token-Budget dieses Laufs erreicht');
      expect(out.text).toContain('Geändert wurde bisher nichts.');
    });

    it('cache reads count a tenth against the budget', async () => {
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 30_000, cacheWriteTokens: 0 };
      const t = setupRunner([(req, n) => ({ ...endless(req, n), usage })], { limits: { maxTokens: 5_000 } });
      const out = await t.runner.run();
      expect(out.limitReason).toBe('tokens');
      expect(out.rounds).toBe(2);
    });

    it('timeoutMs: stops at the time limit (fake clock) with a deterministic summary – no further request after the deadline', async () => {
      let clock = 1_000_000;
      const t = setupRunner(
        [
          (req, n) => {
            clock += 250_000;
            return endless(req, n);
          },
        ],
        { limits: { timeoutMs: 600_000 }, runner: { now: () => clock } },
      );
      const out = await t.runner.run();
      expect(out).toMatchObject({ status: 'limit', limitReason: 'time', rounds: 3 });
      // the time is up: no wrap-up request is sent; the summary comes from the run itself
      expect(t.adapter.requests).toHaveLength(3);
      expect(out.text).toContain('Ich habe das Zeitlimit dieses Laufs erreicht');
      expect(out.text).toContain('Soll ich weitermachen?');
      expectAllCallsAnswered(t.history);
    });

    it('a wrap-up turn that still calls tools does not run them', async () => {
      const t = setupRunner([(req, n) => (req.maxOutputTokens === 2_000 ? calls(call('change', { ids: ['z'] }, 'late')) : endless(req, n))], {
        limits: { maxRounds: 1 },
      });
      const out = await t.runner.run();
      expect(out.status).toBe('limit');
      expect(t.probe.changes).toBe(0);
      expect(t.history.at(-1)).toMatchObject({
        role: 'tool',
        results: [{ callId: 'late', isError: true, content: 'Nicht ausgeführt: technische Grenze erreicht.' }],
      });
      expectAllCallsAnswered(t.history);
    });

    it('a failing wrap-up request falls back to the deterministic summary', async () => {
      const t = setupRunner([(req, n) => (req.maxOutputTokens === 2_000 ? new AppError('llm_error', 'kaputt') : endless(req, n))], {
        limits: { maxRounds: 1 },
      });
      const out = await t.runner.run();
      expect(out.status).toBe('limit');
      expect(out.text).toContain('Ich habe die Höchstzahl an Arbeitsschritten erreicht');
    });
  });

  describe('loop detection', () => {
    it('skips the third identical call (argument order does not matter) and stops after three skipped repetitions', async () => {
      const t = setupRunner([
        (req, n) => (req.maxOutputTokens === 2_000 ? { text: '' } : calls(call('lookup', n % 2 ? { delay: 0, q: 'x' } : { q: 'x', delay: 0 }))),
      ]);
      const out = await t.runner.run();
      expect(out).toMatchObject({ status: 'limit', limitReason: 'loop' });
      expect(out.steps.map((s) => s.outcome)).toEqual(['ok', 'ok', 'skipped', 'skipped', 'skipped']);
      expect(t.probe.order.filter((x) => x.startsWith('end:'))).toHaveLength(2);
      const skipped = lastTool(t.adapter.requests[3]!).results[0]!;
      expect(skipped.isError).toBe(true);
      expect(skipped.content).toContain('Nicht erneut ausgeführt');
      expect(out.text).toContain('eine Schleife');
      expect(lastTool(t.adapter.requests.at(-1)!).note).toContain('eine Schleife (wiederholt gleiche Aufrufe)');
    });

    it('the same tool with other arguments is no loop', async () => {
      const t = setupRunner([(_req, n) => (n < 6 ? calls(call('lookup', { q: `q${n}` })) : { text: 'fertig' })]);
      const out = await t.runner.run();
      expect(out.status).toBe('done');
      expect(out.steps.every((s) => s.outcome === 'ok')).toBe(true);
    });
  });
});
