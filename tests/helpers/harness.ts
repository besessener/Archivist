import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHandlers, createIpcDispatcher, createServices, type HostApi, type SecretCipher, type Services } from '../../packages/core/src';
import type { IpcChannel, IpcInput, IpcOutput, Result } from '@archivist/shared';
import { FakeLlm } from './fake-llm';

export const MIGRATIONS = path.resolve(__dirname, '../../packages/core/migrations');

/** Insecure test cipher (tests only), replaces Electron safeStorage. */
export class TestCipher implements SecretCipher {
  constructor(private readonly options = { available: true }) {}
  isAvailable() {
    return this.options.available;
  }
  backend() {
    return 'test';
  }
  encrypt(plain: string) {
    return Buffer.from(`enc:${Buffer.from(plain).toString('base64').split('').reverse().join('')}`);
  }
  decrypt(data: Buffer) {
    const encoded = data.toString();
    if (!encoded.startsWith('enc:')) throw new Error('bad');
    return Buffer.from(encoded.slice(4).split('').reverse().join(''), 'base64').toString();
  }
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
  file(relativePath: string, content: string | Buffer): string;
  cleanup(): Promise<void>;
}

export interface TestAppOptions {
  configured?: boolean;
  privacy?: 'auto' | 'confirm' | 'local_only';
  scanEnabled?: boolean;
  /** Agent mode (#294); off by default so that the rule-based chat tests keep their intent scripts. */
  agent?: boolean;
  /** Automatic similarity proposals (#271); off by default so tests of other features see exactly the relations they create. */
  autoLinks?: boolean;
  workerFile?: string | null;
  /** bundled read worker (db-reader-entry); null = queries run inline */
  readerFile?: string | null;
  dataRoot?: string;
  /** Database, config, logs and backups in their own folder next to the document store (the default layout of the installed app). */
  separateAppData?: boolean;
}

/** Complete application (services + dispatcher) in a temporary directory. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const root = options.dataRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'archivist-test-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const llm = new FakeLlm();
  const services = createServices({
    dataRoot: path.join(root, 'Archivist'),
    appDataRoot: options.separateAppData ? path.join(root, 'AppData') : undefined,
    migrationsFolder: MIGRATIONS,
    cipher: new TestCipher(),
    fetchImpl: llm.fetch,
    workerFile: options.workerFile ?? null,
    readerFile: options.readerFile ?? null,
    jobConcurrency: 1,
    llmRetryDelayMs: 0,
    jobRetryDelayMs: 0,
  });
  if (options.configured !== false) {
    services.settings.update({
      llm: { baseUrl: 'https://llm.example.test/openai/v1', model: 'test-model' },
      privacy: { llmMode: options.privacy ?? 'auto' },
      agent: { enabled: options.agent ?? false },
      setupCompleted: true,
    });
    services.secrets.setApiKey('sk-test-SECRET-0123456789abcdef');
  }
  services.settings.update({ links: { autoPropose: options.autoLinks ?? false } });
  if (options.scanEnabled) services.settings.update({ scan: { enabled: true } });
  const opened: string[] = [];
  const host = {
    version: 'test',
    platform: process.platform,
    opened,
    selectDirectory: async () => null,
    openPath: async (target: string) => {
      opened.push(target);
      return '';
    },
    revealPath: (target: string) => void opened.push(target),
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
      const result = await dispatch(channel, input ?? {});
      if (!result.ok) throw new Error(`${channel}: ${result.error.message} ${result.error.details ?? ''}`);
      return result.data;
    }) as TestApp['ok'],
    file(relativePath, content) {
      const filePath = path.join(home, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      return filePath;
    },
    async cleanup() {
      await services.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
