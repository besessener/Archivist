import { ipcContract, type IpcChannel, type Result } from '@archivist/shared';
import type { z } from 'zod';
import type { Services } from './create-services';
import { toErrorInfo } from './util/errors';
import { agentHandlers } from './handlers/agent';
import { appHandlers } from './handlers/app';
import { documentHandlers } from './handlers/documents';
import { knowledgeHandlers } from './handlers/knowledge';
import { recordHandlers } from './handlers/records';
import { speechHandlers } from './handlers/speech';
import { updateHandlers } from './handlers/update';
import type { HandlerMap, HostApi } from './handlers/types';

export type { HostApi } from './handlers/types';

/** Implements every IPC channel exclusively via the service layer. */
export function createHandlers(services: Services, host: HostApi): HandlerMap {
  return {
    ...appHandlers(services, host),
    ...agentHandlers(services, host),
    ...recordHandlers(services),
    ...documentHandlers(services, host),
    ...knowledgeHandlers(services),
    ...speechHandlers(services),
    ...updateHandlers(host),
  };
}

export type IpcDispatcher = (channel: string, rawInput: unknown) => Promise<Result<unknown>>;

function validationFailure(message: string, details: string): Result<unknown> {
  return { ok: false, error: { category: 'validation_error', message, retryable: false, details } };
}

function issueList(issues: z.core.$ZodIssue[], rootLabel: string): string {
  return issues.map((issue) => `${issue.path.join('.') || rootLabel}: ${issue.message}`).join('; ');
}

/** Central IPC entry point (main process and tests): channel allowlist, Zod validation of input and output, uniform errors. */
export function createIpcDispatcher(handlers: HandlerMap, onError?: (channel: string, err: unknown) => void): IpcDispatcher {
  return async (channel, rawInput) => {
    if (!Object.prototype.hasOwnProperty.call(ipcContract, channel)) {
      return { ok: false, error: { category: 'permission_error', message: `Unbekannter oder nicht erlaubter IPC-Kanal: ${channel}`, retryable: false } };
    }
    const knownChannel = channel as IpcChannel;
    const spec = ipcContract[knownChannel];
    const parsed = spec.input.safeParse(rawInput ?? {});
    if (!parsed.success) return validationFailure('Ungültige Eingabe.', issueList(parsed.error.issues, '(root)'));
    try {
      const handler = handlers[knownChannel] as (input: unknown) => unknown;
      const output = spec.output.safeParse(await handler(parsed.data));
      if (output.success) return { ok: true, data: output.data };
      onError?.(channel, output.error);
      return validationFailure('Interne Antwort entsprach nicht dem Schema.', issueList(output.error.issues.slice(0, 5), ''));
    } catch (err) {
      onError?.(channel, err);
      return { ok: false, error: toErrorInfo(err) };
    }
  };
}
