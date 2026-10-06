import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SpeechModelName } from '@archivist/shared';
import type { SpeechModelSpec } from '../../packages/core/src/services/speech/model-manifest';

export interface SpeechModelServer {
  /** The served files as a pinned model; `models` has one per model name, each in its own folder. */
  spec: SpeechModelSpec;
  models: Record<SpeechModelName, SpeechModelSpec>;
  /** Requests served per path. */
  requests: string[];
  /** Serves different bytes of the same length for this file from now on (a corrupted download). */
  corrupt(path: string): void;
  /** Holds every answer back until `release` is called. */
  hold(): void;
  release(): void;
  close(): Promise<void>;
}

const REVISION = 'abc123';

/** A local stand-in for the model host: serves the given files under `/<revision>/<path>` and describes them as a pinned model. */
export async function startSpeechModelServer(contents: Record<string, string>): Promise<SpeechModelServer> {
  const served = new Map(Object.entries(contents));
  const requests: string[] = [];
  let gate: Promise<void> | null = null;
  let open: () => void = () => undefined;
  const server = http.createServer((request, response) => {
    requests.push(request.url ?? '');
    const send = () => {
      const body = served.get((request.url ?? '').slice(`/${REVISION}/`.length));
      if (body === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-length': Buffer.byteLength(body) });
      response.write(body.slice(0, Math.ceil(body.length / 2)));
      setTimeout(() => response.end(body.slice(Math.ceil(body.length / 2))), 5);
    };
    if (gate) void gate.then(send);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const spec: SpeechModelSpec = {
    label: 'Testmodell',
    directory: 'test-model',
    baseUrl: `http://127.0.0.1:${port}`,
    revision: REVISION,
    files: Object.entries(contents).map(([path, body]) => ({
      path,
      bytes: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex'),
    })),
  };
  const named = (name: SpeechModelName): SpeechModelSpec => ({ ...spec, label: `Testmodell ${name}`, directory: `test-${name}` });
  return {
    spec,
    models: { small: named('small'), medium: named('medium'), turbo: named('turbo') },
    requests,
    corrupt: (path) => served.set(path, `X${(served.get(path) ?? '').slice(1)}`),
    hold: () => {
      gate = new Promise((resolve) => (open = resolve));
    },
    release: () => {
      gate = null;
      open();
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
