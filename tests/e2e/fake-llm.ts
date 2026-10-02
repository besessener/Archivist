import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeLlmServer {
  url: string;
  calls: Array<{ schema: string; input: string }>;
  /** Delay of every response in milliseconds (for a "slow AI"); 0 = immediately. */
  delayMs: number;
  close(): Promise<void>;
}

const userMessage = (input: string) => input.split('Nachricht des Benutzers:\n')[1] ?? input;

/** Minimal OpenAI-compatible endpoint (Responses API) for the E2E test. */
export async function startFakeLlm(): Promise<FakeLlmServer> {
  const calls: FakeLlmServer['calls'] = [];
  const control = { delayMs: 0 };
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
      const parsed = JSON.parse(body) as { instructions?: string; input?: string };
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
    close: () => new Promise((r) => server.close(() => r())),
  };
}
