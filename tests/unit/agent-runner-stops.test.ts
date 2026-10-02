import { describe, expect, it } from 'vitest';
import { ASK_USER } from '../../packages/core/src/agent/runner';
import { pendingCalls } from '../../packages/core/src/agent/service';
import { AppError } from '../../packages/core/src/util/errors';
import { call, calls, expectAllCallsAnswered, lastTool, setupRunner, type ToolMessage } from '../helpers/agent-runner';

describe('AgentRunner (#295)', () => {
  describe('ask_user', () => {
    it('leaves the loop with the question and its options; the history ends with the other results, without the question', async () => {
      const t = setupRunner([
        calls(call('lookup', { q: 'jahr' }, 'l1'), call(ASK_USER, { question: 'Welches Jahr meinst du?', options: ['2025', '2026'] }, 'q1')),
        { text: 'nie erreicht' },
      ]);
      const out = await t.runner.run();
      expect(out.status).toBe('ask_user');
      expect(out.question).toEqual({ callId: 'q1', text: 'Welches Jahr meinst du?', options: ['2025', '2026'] });
      expect(t.adapter.requests).toHaveLength(1);
      expect(t.history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
      expect((t.history.at(-1) as ToolMessage).results.map((r) => r.callId)).toEqual(['l1']);
      expect(out.steps.map((s) => [s.tool, s.outcome])).toEqual([
        ['lookup', 'ok'],
        ['ask_user', 'asked'],
      ]);
      // the open question is what the service answers on the next message
      expect(pendingCalls(t.history).map((c) => c.id)).toEqual(['q1']);
    });

    it('a round with only the question writes no empty tool message', async () => {
      const t = setupRunner([calls(call(ASK_USER, { question: 'Wirklich?' }, 'q1'))]);
      const out = await t.runner.run();
      expect(out.status).toBe('ask_user');
      expect(out.question?.options).toEqual([]);
      expect(t.history.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(pendingCalls(t.history).map((c) => c.id)).toEqual(['q1']);
    });

    it('only one question at a time; an invalid question is an error result', async () => {
      const t = setupRunner([
        calls(call(ASK_USER, { question: '' }, 'bad'), call(ASK_USER, { question: 'Erste?' }, 'q1'), call(ASK_USER, { question: 'Zweite?' }, 'q2')),
      ]);
      const out = await t.runner.run();
      expect(out.question?.callId).toBe('q1');
      const results = (t.history.at(-1) as ToolMessage).results;
      expect(results.map((r) => [r.callId, r.isError])).toEqual([
        ['bad', true],
        ['q2', true],
      ]);
      expect(results[1]!.content).toContain('Nur eine Rückfrage auf einmal');
    });
  });

  describe('cancellation', () => {
    it('before the first request', async () => {
      const t = setupRunner([{ text: 'nie' }]);
      t.controller.abort();
      const out = await t.runner.run();
      expect(out.status).toBe('cancelled');
      expect(t.adapter.requests).toHaveLength(0);
      expect(t.history).toHaveLength(1);
    });

    it('during a request: nothing is appended for it', async () => {
      const t = setupRunner([
        calls(call('lookup', { q: 'a' })),
        () => {
          t.controller.abort();
          return new DOMException('This operation was aborted', 'AbortError');
        },
      ]);
      const out = await t.runner.run();
      expect(out.status).toBe('cancelled');
      expect(t.history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
      expectAllCallsAnswered(t.history);
    });

    it('an answer that arrives after the cancellation is not executed', async () => {
      const t = setupRunner([
        () => {
          t.controller.abort();
          return calls(call('change', { ids: ['a'] }, 'w1'));
        },
      ]);
      const out = await t.runner.run();
      expect(out.status).toBe('cancelled');
      expect(t.probe.changes).toBe(0);
      expect(t.history.at(-1)).toMatchObject({ role: 'tool', results: [{ callId: 'w1', isError: true, content: 'Abgebrochen, bevor das Werkzeug lief.' }] });
      expectAllCallsAnswered(t.history);
    });

    it('during the tools of a round: what is done stays, the rest is answered as cancelled', async () => {
      const t = setupRunner([calls(call('lookup', { q: 'a' }, 'r1'), call('change', { ids: ['a'] }, 'w1')), { text: 'nie' }]);
      t.probe.onRead = () => t.controller.abort();
      const out = await t.runner.run();
      expect(out.status).toBe('cancelled');
      expect(t.probe.changes).toBe(0);
      expect(t.adapter.requests).toHaveLength(1);
      const results = (t.history.at(-1) as ToolMessage).results;
      expect(results.map((r) => [r.callId, r.isError])).toEqual([
        ['r1', false],
        ['w1', true],
      ]);
      expectAllCallsAnswered(t.history);
    });
  });

  describe('retries and errors', () => {
    const rateLimit = () => new AppError('llm_error', 'Limit', { retryable: true });

    it('retries retryable errors and counts them', async () => {
      const t = setupRunner([rateLimit(), rateLimit(), { text: 'geklappt' }]);
      const out = await t.runner.run();
      expect(out).toMatchObject({ status: 'done', text: 'geklappt' });
      expect(out.usage).toMatchObject({ retries: 2, requests: 1 });
      expect(t.adapter.requests).toHaveLength(3);
    });

    it('gives up after maxRetries', async () => {
      const t = setupRunner([rateLimit()], { runner: { maxRetries: 1 } });
      const out = await t.runner.run();
      expect(out).toMatchObject({ status: 'error', error: 'Limit' });
      expect(out.usage.retries).toBe(1);
      expect(t.adapter.requests).toHaveLength(2);
    });

    it('a non-retryable error ends the run at once', async () => {
      const t = setupRunner([calls(call('lookup', { q: 'a' })), new AppError('llm_error', 'Anmeldung abgelehnt', { details: 'HTTP 401' })]);
      const out = await t.runner.run();
      expect(out).toMatchObject({ status: 'error', error: 'Anmeldung abgelehnt (HTTP 401)' });
      expect(out.usage.retries).toBe(0);
      expect(t.adapter.requests).toHaveLength(2);
      expectAllCallsAnswered(t.history);
    });

    it('an unknown error is also not retried', async () => {
      const t = setupRunner([new TypeError('kaputt')]);
      const out = await t.runner.run();
      expect(out.status).toBe('error');
      expect(t.adapter.requests).toHaveLength(1);
    });
  });

  describe('stop reasons', () => {
    it('max_tokens with tool calls: the cut-off calls are never executed', async () => {
      const t = setupRunner([{ toolCalls: [call('change', { ids: ['a'] }, 'w1')], stopReason: 'max_tokens' }, { text: 'kleiner versucht' }]);
      const out = await t.runner.run();
      expect(out.status).toBe('done');
      expect(t.probe.changes).toBe(0);
      const r = lastTool(t.adapter.requests[1]!).results[0]!;
      expect(r).toMatchObject({ callId: 'w1', isError: true });
      expect(r.content).toContain('am Ausgabelimit abgeschnitten');
    });

    it('max_tokens without any text is an error; with text the text is kept', async () => {
      const empty = await setupRunner([{ stopReason: 'max_tokens' }]).runner.run();
      expect(empty).toMatchObject({ status: 'error', error: 'Die Antwort des Modells wurde abgeschnitten (Ausgabelimit).' });
      const partial = await setupRunner([{ stopReason: 'max_tokens', text: 'Teil' }]).runner.run();
      expect(partial).toMatchObject({ status: 'done', text: 'Teil' });
    });

    it('refusal ends the run with the explanation', async () => {
      const out = await setupRunner([{ stopReason: 'refusal', refusal: { category: 'cyber', explanation: 'unzulässig' } }]).runner.run();
      expect(out).toMatchObject({ status: 'refusal', text: 'Das Modell hat diese Anfrage abgelehnt (unzulässig).' });
      const withText = await setupRunner([{ stopReason: 'refusal', text: 'Das mache ich nicht.' }]).runner.run();
      expect(withText.text).toBe('Das mache ich nicht.');
    });

    it('a paused turn is sent again to continue', async () => {
      const t = setupRunner([{ stopReason: 'pause', raw: [{ type: 'server_tool_use' }] }, { text: 'weiter und fertig' }]);
      const out = await t.runner.run();
      expect(out).toMatchObject({ status: 'done', text: 'weiter und fertig' });
      expect(t.adapter.requests).toHaveLength(2);
      expect(t.adapter.requests[1]!.messages.at(-1)).toMatchObject({ role: 'assistant', raw: [{ type: 'server_tool_use' }] });
    });
  });
});
