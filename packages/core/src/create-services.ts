import type { FetchLike } from './services/llm';
import type { SecretCipher } from './services/secret';
import { createBaseServices } from './composition/base-services';
import { createDomainServices, createLinkingServices } from './composition/domain-services';
import { createLinkProposalNotifier, linkRunEnqueuer, registerLinkAutomation } from './composition/link-automation';
import { createAgent } from './composition/agent';
import { wireServices } from './composition/wiring';
import { registerJobHandlers } from './composition/job-handlers';
import { createLifecycle, reactToSettingsChanges } from './composition/lifecycle';

export interface CreateServicesOptions {
  /** Root of the local data storage (default: ~/Documents/Archivist) */
  dataRoot: string;
  /** Folder with the Drizzle migrations */
  migrationsFolder: string;
  cipher: SecretCipher;
  /** Path to the bundled worker script; null/undefined = tasks run inline (tests) */
  workerFile?: string | null;
  /** Path to the bundled read worker (own read-only DB connection); null/undefined = queries run inline (tests) */
  readerFile?: string | null;
  fetchImpl?: FetchLike;
  jobConcurrency?: number;
  /** Wait before the first job retry; doubles with every further attempt (default 5 s, tests: 0) */
  jobRetryDelayMs?: number;
  /** Delay between LLM retries (tests: 0) */
  llmRetryDelayMs?: number;
}

export type Services = ReturnType<typeof buildServices>;

/** Composition root: creates and wires all services. */
export function createServices(opts: CreateServicesOptions) {
  return buildServices(opts);
}

function buildServices(opts: CreateServicesOptions) {
  const base = createBaseServices(opts);
  const domain = createDomainServices(base);
  const wired = { ...base, ...domain, ...createLinkingServices({ ...base, ...domain }) };
  const notifyLinkProposals = createLinkProposalNotifier(wired);
  const enqueueLinkRun = linkRunEnqueuer(wired.jobs);
  const enqueueConsistency = (trigger: string) => wired.jobs.enqueue('consistency.check', 'Archivprüfung', { trigger }, { maxAttempts: 1, sameAs: () => true });
  const { agent, agentFileJobs } = createAgent(wired, enqueueConsistency);
  const services = { ...wired, agent, agentFileJobs, enqueueLinkRun, enqueueConsistency };

  wireServices(services, notifyLinkProposals);
  registerLinkAutomation(services, notifyLinkProposals);
  registerJobHandlers(services);
  reactToSettingsChanges(services);
  return { ...services, ...createLifecycle(services) };
}
