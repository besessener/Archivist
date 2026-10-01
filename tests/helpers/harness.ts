import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHandlers, createIpcDispatcher, createServices, type HostApi, type SecretCipher, type Services } from '../../packages/core/src';
import type { IpcChannel, IpcInput, IpcOutput, Result } from '@archivist/shared';

export const MIGRATIONS = path.resolve(__dirname, '../../packages/core/migrations');

/** Unsichere Test-Chiffre (nur für Tests) – ersetzt Electron safeStorage. */
export class TestCipher implements SecretCipher {
  constructor(private readonly available = true) {}
  isAvailable() {
    return this.available;
  }
  backend() {
    return 'test';
  }
  encrypt(plain: string) {
    return Buffer.from(`enc:${Buffer.from(plain).toString('base64').split('').reverse().join('')}`);
  }
  decrypt(data: Buffer) {
    const s = data.toString();
    if (!s.startsWith('enc:')) throw new Error('bad');
    return Buffer.from(s.slice(4).split('').reverse().join(''), 'base64').toString();
  }
}

type Responder = (schema: string, input: string, body: Record<string, unknown>) => unknown | Promise<unknown>;

/** Skriptbarer Fake-Endpunkt für die Responses API. */
export class FakeLlm {
  calls: Array<{ schema: string; input: string; instructions: string }> = [];
  responders = new Map<string, Responder>();
  down = false;
  status = 200;
  raw: string | null = null;

  on(schema: string, fn: Responder) {
    this.responders.set(schema, fn);
    return this;
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (this.status !== 200) return new Response(JSON.stringify({ error: { message: 'nope' } }), { status: this.status });
    if (u.endsWith('/responses')) {
      const instructions = String(body.instructions ?? '');
      const input = String(body.input ?? '');
      const schema = /JSON-Schema „(\w+)“/.exec(instructions)?.[1] ?? 'plain';
      this.calls.push({ schema, input, instructions });
      let text: string;
      if (this.raw !== null) text = this.raw;
      else {
        const fn = this.responders.get(schema);
        let out = fn ? await fn(schema, input.replace(/Bisheriger Verlauf[\s\S]*?\n\n(?=Nachricht des Benutzers:)/, ''), body) : schema === 'plain' ? 'OK' : { error: `kein Responder für ${schema}` };
        // Tests liefern der Einfachheit halber eine einzelne Absicht; die Analyse erwartet {intents: [...]}
        if (schema === 'ChatIntent' && out && typeof out === 'object' && 'intent' in out) out = { intents: [out] };
        text = typeof out === 'string' ? out : JSON.stringify(out);
      }
      return new Response(JSON.stringify({ id: 'resp_1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };
}

export interface TestApp {
  root: string;
  home: string;
  services: Services;
  llm: FakeLlm;
  call<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<Result<IpcOutput<C>>>;
  ok<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<IpcOutput<C>>;
  dispatch: ReturnType<typeof createIpcDispatcher>;
  host: HostApi & { opened: string[] };
  file(rel: string, content: string | Buffer): string;
  cleanup(): Promise<void>;
}

export interface TestAppOptions {
  configured?: boolean;
  privacy?: 'auto' | 'confirm' | 'local_only';
  scanEnabled?: boolean;
  workerFile?: string | null;
  dataRoot?: string;
}

/** Vollständige Anwendung (Services + Dispatcher) in einem temporären Verzeichnis. */
export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const root = opts.dataRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-test-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const llm = new FakeLlm();
  const services = createServices({
    dataRoot: path.join(root, 'Archivist'),
    migrationsFolder: MIGRATIONS,
    cipher: new TestCipher(),
    fetchImpl: llm.fetch as typeof fetch,
    workerFile: opts.workerFile ?? null,
    jobConcurrency: 1,
    llmRetryDelayMs: 0,
  });
  if (opts.configured !== false) {
    services.settings.update({ llm: { baseUrl: 'https://llm.example.test/openai/v1', model: 'test-model' }, privacy: { llmMode: opts.privacy ?? 'auto' }, setupCompleted: true });
    services.secrets.setApiKey('sk-test-SECRET-0123456789abcdef');
  }
  if (opts.scanEnabled) services.settings.update({ scan: { enabled: true } });
  const opened: string[] = [];
  const host = {
    version: 'test',
    platform: process.platform,
    opened,
    selectDirectory: async () => null,
    openPath: async (p: string) => {
      opened.push(p);
      return '';
    },
    revealPath: (p: string) => void opened.push(p),
  };
  const handlers = createHandlers(services, host);
  const dispatch = createIpcDispatcher(handlers);
  services.jobs.start();
  return {
    root,
    home,
    services,
    llm,
    dispatch,
    host,
    call: ((channel: IpcChannel, input?: unknown) => dispatch(channel, input ?? {})) as TestApp['call'],
    ok: (async (channel: IpcChannel, input?: unknown) => {
      const r = await dispatch(channel, input ?? {});
      if (!r.ok) throw new Error(`${channel}: ${r.error.message} ${r.error.details ?? ''}`);
      return r.data;
    }) as TestApp['ok'],
    file(rel, content) {
      const p = path.join(home, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return p;
    },
    async cleanup() {
      await services.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
