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
  /** Agent turns, the last one repeats; unset, the endpoint has no tool calling and the chat stays rule-based. */
  agentTurns: AgentTurn[] | null;
  /** false: the connection test's structured (JSON) request gets an invalid answer, as from an endpoint without working JSON mode. */
  structuredAnswers: boolean;
  close(): Promise<void>;
}

interface Control {
  delayMs: number;
  structuredAnswers: boolean;
  agentTurns: AgentTurn[] | null;
  agentRound: number;
}

interface ParsedRequest {
  instructions?: string;
  input?: string;
  tools?: Array<{ name?: string }>;
}

/** Responses API output of one agent turn. */
function agentOutput(turn: AgentTurn, round: number): unknown[] {
  return [
    ...(turn.calls ?? []).map((toolCall, callIndex) => ({
      type: 'function_call',
      id: `fc_${round}_${callIndex}`,
      call_id: `call_${round}_${callIndex}`,
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.args ?? {}),
    })),
    ...(turn.text ? [{ type: 'message', id: `msg_${round}`, role: 'assistant', content: [{ type: 'output_text', text: turn.text }] }] : []),
  ];
}

const userMessage = (input: string) => input.split('Nachricht des Benutzers:\n')[1] ?? input;

function classification(input: string) {
  const name = /Dateiname: (.+)/.exec(input)?.[1] ?? '';
  const vacation = /urlaub/i.test(name);
  const decided = /beschluss/i.test(name);
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
    decisions: decided
      ? [
          {
            title: 'Fassade streichen',
            decisionText: 'Die Fassade wird im Herbst gestrichen.',
            kind: 'decided',
            evidence: 'Beschluss: Die Fassade wird im Herbst gestrichen.',
            participants: [],
          },
        ]
      : [],
    openItems: [],
    confidence: 0.88,
    rationale: 'E2E',
  };
}

function chatIntent(input: string) {
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

const KNOWLEDGE_ANSWER = {
  answer: 'Das Projekt Nordlicht wurde am 4. Mai 2026 pausiert.',
  facts: [{ statement: 'Die Pause wurde am 2026-05-04 entschieden.', sourceIds: ['S1'] }],
  interpretation: null,
  uncertainties: [],
  contradictions: [],
  missingInformation: [],
  usedSourceIds: ['S1'],
  confidence: 0.85,
};

/** The text answer for a JSON schema; the analysis expects ChatIntent as {intents: [...]}. */
function textAnswer(schema: string, input: string): string {
  if (schema === 'plain') return 'OK';
  if (schema === 'ConnectionTest') return JSON.stringify({ ok: true });
  if (schema === 'DocumentClassification') return JSON.stringify(classification(input));
  if (schema === 'ChatIntent') return JSON.stringify({ intents: [chatIntent(input)] });
  if (schema === 'KnowledgeAnswer') return JSON.stringify(KNOWLEDGE_ANSWER);
  return JSON.stringify({});
}

/** The connection test calls `echo` once and expects „OK“ after its result. */
function nextAgentTurn(control: Control, request: ParsedRequest): AgentTurn {
  if (request.tools?.some((tool) => tool.name === 'echo'))
    return JSON.stringify(request.input).includes('function_call_output') ? { text: 'OK' } : { calls: [{ name: 'echo', args: { text: 'archivist' } }] };
  const turns = control.agentTurns ?? [];
  const turn = turns[Math.min(control.agentRound, turns.length - 1)] ?? { text: 'OK' };
  control.agentRound += 1;
  return turn;
}

function answerAgent(control: Control, request: ParsedRequest, response: http.ServerResponse) {
  const round = control.agentRound;
  const turn = nextAgentTurn(control, request);
  const payload = JSON.stringify({
    id: `resp_agent_${round}`,
    status: 'completed',
    output: agentOutput(turn, round),
    usage: { input_tokens: 1200, output_tokens: 80, input_tokens_details: { cached_tokens: 0 } },
  });
  setTimeout(() => response.writeHead(200, { 'content-type': 'application/json' }).end(payload), turn.delayMs ?? 0);
}

/** Minimal OpenAI-compatible endpoint (Responses API) for the E2E test. */
export async function startFakeLlm(): Promise<FakeLlmServer> {
  const calls: FakeLlmServer['calls'] = [];
  const control: Control = { delayMs: 0, structuredAnswers: true, agentTurns: null, agentRound: 0 };
  const answer = (request: ParsedRequest, response: http.ServerResponse) => {
    // without agent turns a tool request gets a plain text answer, as from an endpoint without tool calling
    if (request.tools?.length && control.agentTurns) {
      answerAgent(control, request, response);
      return;
    }
    const schema = /JSON-Schema „(\w+)“/.exec(request.instructions ?? '')?.[1] ?? 'plain';
    calls.push({ schema, input: request.input ?? '' });
    const text = !control.structuredAnswers && schema === 'ConnectionTest' ? '{}' : textAnswer(schema, request.input ?? '');
    const payload = JSON.stringify({
      id: 'r',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    });
    setTimeout(() => response.writeHead(200, { 'content-type': 'application/json' }).end(payload), control.delayMs);
  };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
        response.writeHead(404).end('not found');
        return;
      }
      answer(JSON.parse(body) as ParsedRequest, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
    get structuredAnswers() {
      return control.structuredAnswers;
    },
    set structuredAnswers(works: boolean) {
      control.structuredAnswers = works;
    },
    get agentTurns() {
      return control.agentTurns;
    },
    set agentTurns(turns: AgentTurn[] | null) {
      control.agentTurns = turns;
      control.agentRound = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
