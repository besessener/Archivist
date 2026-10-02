import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** One scripted model turn of the agent (native tool calling, #300); `delayMs` keeps the run visibly busy. */
export interface AgentTurn {
  calls?: Array<{ name: string; args?: Record<string, unknown> }>;
  text?: string;
  delayMs?: number;
}

export interface FakeLlmServer {
  url: string;
  calls: Array<{ schema: string; input: string }>;
  /** Delay of every response in milliseconds (for a "slow AI"); 0 = immediately. */
  delayMs: number;
  /**
   * Agent turns in order (the last one repeats). Unset, the endpoint has no tool calling: the connection test fails and
   * the chat stays rule-based – as all other specs expect. Set it before the setup to switch the agent mode on.
   */
  agentTurns: AgentTurn[] | null;
  close(): Promise<void>;
}

/** Responses API output of one agent turn. */
function agentOutput(turn: AgentTurn, round: number): unknown[] {
  return [
    ...(turn.calls ?? []).map((c, n) => ({
      type: 'function_call',
      id: `fc_${round}_${n}`,
      call_id: `call_${round}_${n}`,
      name: c.name,
      arguments: JSON.stringify(c.args ?? {}),
    })),
    ...(turn.text ? [{ type: 'message', id: `msg_${round}`, role: 'assistant', content: [{ type: 'output_text', text: turn.text }] }] : []),
  ];
}

const userMessage = (input: string) => input.split('Nachricht des Benutzers:\n')[1] ?? input;

/** Minimal OpenAI-compatible endpoint (Responses API) for the E2E test. */
export async function startFakeLlm(): Promise<FakeLlmServer> {
  const calls: FakeLlmServer['calls'] = [];
  const control: { delayMs: number; agentTurns: AgentTurn[] | null; agentRound: number } = { delayMs: 0, agentTurns: null, agentRound: 0 };
  /** The connection test calls `echo` once and expects „OK“ after its result. */
  const agentTurn = (tools: Array<{ name?: string }>, input: unknown): AgentTurn => {
    if (tools.some((t) => t.name === 'echo'))
      return JSON.stringify(input).includes('function_call_output') ? { text: 'OK' } : { calls: [{ name: 'echo', args: { text: 'archivist' } }] };
    const turns = control.agentTurns ?? [];
    const turn = turns[Math.min(control.agentRound, turns.length - 1)] ?? { text: 'OK' };
    control.agentRound += 1;
    return turn;
  };
  const respond = (schema: string, input: string): unknown => {
    if (schema === 'plain') return 'OK';
    if (schema === 'DocumentClassification') {
      const name = /Dateiname: (.+)/.exec(input)?.[1] ?? '';
      const vacation = /urlaub/i.test(name);
      return {
        docType: vacation ? 'Urlaubsantrag' : 'Protokoll',
        title: vacation ? 'Urlaubsantrag Juni 2026' : 'Jour Fixe Nordlicht',
        summary: vacation ? 'Urlaubsantrag für den 12.06.2026.' : 'Protokoll des Jour Fixe zum Projekt Nordlicht.',
        mainTopic: vacation ? null : 'Nordlicht',
        project: vacation ? null : 'Nordlicht',
        persons: vacation ? [] : ['Anna', 'Ben'],
        dates: [{ date: vacation ? '2026-06-12' : '2026-05-04', label: null }],
        tags: vacation ? ['urlaub'] : ['jour-fixe'],
        location: {
          categoryPath: vacation ? 'private/vacation/2026' : 'work/projects/Nordlicht',
          fileName: null,
          newMainCategory: false,
          rationale: vacation ? 'Urlaubsantrag vom 12.06.2026' : 'Das Dokument nennt das Projekt Nordlicht.',
          confidence: 0.88,
        },
        decisions: [],
        openItems: [],
        confidence: 0.88,
        rationale: 'E2E',
      };
    }
    if (schema === 'ChatIntent') {
      const text = userMessage(input);
      if (/Wann haben wir/.test(text)) return { intent: 'knowledge_question', confidence: 0.9, rationale: 'e2e', query: 'Nordlicht pausiert Entscheidung' };
      if (/Am 4\. Mai/.test(text))
        return {
          intent: 'decision_amend',
          confidence: 0.9,
          rationale: 'e2e',
          decision: { participants: ['Anna', 'Ben'], alternatives: [], unknownFields: [], decidedAt: '2026-05-04', confidence: 0.9 },
        };
      if (/entschieden/.test(text))
        return {
          intent: 'decision_new',
          confidence: 0.9,
          rationale: 'e2e',
          decision: {
            title: 'Nordlicht pausiert',
            decisionText: 'Das Projekt Nordlicht wird pausiert.',
            topic: 'Nordlicht',
            topicIsProject: true,
            participants: [],
            alternatives: [],
            unknownFields: [],
            confidence: 0.9,
          },
        };
      return { intent: 'unknown', confidence: 0.3, rationale: 'e2e' };
    }
    if (schema === 'KnowledgeAnswer') {
      return {
        answer: 'Das Projekt Nordlicht wurde am 4. Mai 2026 pausiert.',
        facts: [{ statement: 'Die Pause wurde am 2026-05-04 entschieden.', sourceIds: ['S1'] }],
        interpretation: null,
        uncertainties: [],
        contradictions: [],
        missingInformation: [],
        usedSourceIds: ['S1'],
        confidence: 0.85,
      };
    }
    return {};
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
        res.writeHead(404).end('not found');
        return;
      }
      const parsed = JSON.parse(body) as { instructions?: string; input?: string; tools?: Array<{ name?: string }> };
      // without agent turns a tool request gets a plain text answer, as from an endpoint without tool calling
      if (parsed.tools?.length && control.agentTurns) {
        const round = control.agentRound;
        const turn = agentTurn(parsed.tools, parsed.input);
        const agentPayload = JSON.stringify({
          id: `resp_agent_${round}`,
          status: 'completed',
          output: agentOutput(turn, round),
          usage: { input_tokens: 1200, output_tokens: 80, input_tokens_details: { cached_tokens: 0 } },
        });
        setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(agentPayload), turn.delayMs ?? 0);
        return;
      }
      const schema = /JSON-Schema „(\w+)“/.exec(parsed.instructions ?? '')?.[1] ?? 'plain';
      calls.push({ schema, input: parsed.input ?? '' });
      let out = respond(schema, parsed.input ?? '');
      if (schema === 'ChatIntent' && out && typeof out === 'object' && 'intent' in out) out = { intents: [out] };
      const payload = JSON.stringify({
        id: 'r',
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: typeof out === 'string' ? out : JSON.stringify(out) }] }],
      });
      setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(payload), control.delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    get delayMs() {
      return control.delayMs;
    },
    set delayMs(ms: number) {
      control.delayMs = ms;
    },
    get agentTurns() {
      return control.agentTurns;
    },
    set agentTurns(turns: AgentTurn[] | null) {
      control.agentTurns = turns;
      control.agentRound = 0;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
