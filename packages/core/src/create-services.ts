import { createBaseServices, type CreateServicesOptions } from './composition/base-services';
import { createDomainServices, createLinkingServices } from './composition/domain-services';
import { createLinkProposalNotifier, linkRunEnqueuer, registerLinkAutomation } from './composition/link-automation';
import { createAgent } from './composition/agent';
import { wireServices } from './composition/wiring';
import { registerJobHandlers } from './composition/job-handlers';
import { createLifecycle, reactToSettingsChanges } from './composition/lifecycle';

export type { CreateServicesOptions } from './composition/base-services';

export type Services = ReturnType<typeof createServices>;

/** Composition root: creates and wires all services. */
export function createServices(options: CreateServicesOptions) {
  const base = createBaseServices(options);
  const domain = createDomainServices(base);
  const wired = { ...base, ...domain, ...createLinkingServices({ ...base, ...domain }) };
  const notifyLinkProposals = createLinkProposalNotifier(wired);
  const enqueueLinkRun = linkRunEnqueuer(wired.jobs);
  const enqueueConsistency = (trigger: string) =>
    wired.jobs.enqueue('consistency.check', { label: 'Archivprüfung', payload: { trigger }, maxAttempts: 1, sameAs: () => true });
  const { agent, agentFileJobs } = createAgent(wired, enqueueConsistency);
  const services = { ...wired, agent, agentFileJobs, enqueueLinkRun, enqueueConsistency };

  wireServices(services, notifyLinkProposals);
  registerLinkAutomation(services, notifyLinkProposals);
  registerJobHandlers(services);
  reactToSettingsChanges(services);
  return { ...services, ...createLifecycle(services) };
}
