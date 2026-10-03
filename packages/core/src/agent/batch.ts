import type { ActionParamSchemas, AgentStep } from '@archivist/shared';
import type { z } from 'zod';
import { AppError, toErrorInfo } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { truncate } from '../util/text';
import { createToolContext, RefStore, type ToolContext, type ToolRegistry } from './registry';
import type { AgentRunService } from './runs';
import { agentRunScope } from './scope';

export type BatchParams = z.output<(typeof ActionParamSchemas)['agent_batch']>;
type BatchItem = BatchParams['items'][number];

interface BatchDeps {
  registry: ToolRegistry;
  runs: AgentRunService;
}

interface ItemRun {
  registry: ToolRegistry;
  ctx: ToolContext;
  item: BatchItem;
  step: AgentStep;
}

const batchStep = (item: BatchItem): AgentStep => ({
  id: newId(),
  round: 0,
  tool: item.tool,
  risk: item.risk,
  label: item.label,
  summary: '',
  outcome: 'running',
  args: item.args,
  result: '',
  auditIds: [],
  actionId: null,
  startedAt: nowIso(),
  durationMs: null,
});

/** Executes a confirmed proposal card of a run (all items or the selected ones) under the run's id (#298). */
export async function executeProposalBatch(deps: BatchDeps, params: BatchParams): Promise<string> {
  const selected = params.selected?.length ? params.selected : params.items.map((_, i) => i);
  // confirming the card IS the user's instruction (also for learning: „ja, merk dir das“)
  const ctx = createToolContext({
    runId: params.runId,
    conversationId: params.conversationId ?? null,
    trigger: 'chat',
    mode: 'auto',
    refs: new RefStore(structuredClone(params.refs)),
    signal: new AbortController().signal,
    userText: 'Vom Benutzer bestätigt: ausführen und merken.',
    lastAnswer: 'ja',
  });
  const steps: AgentStep[] = [];
  const lines: string[] = [];
  for (const i of selected) {
    const item = params.items[i];
    if (!item) continue;
    const step = batchStep(item);
    steps.push(step);
    lines.push(await runItem({ registry: deps.registry, ctx, item, step }));
  }
  deps.runs.appendSteps(params.runId, steps);
  const failed = steps.filter((s) => s.outcome === 'error').length;
  if (failed === steps.length && steps.length) throw new AppError('validation_error', `Nichts ausgeführt: ${lines.join('; ')}`);
  return lines.join('\n');
}

/** Runs one item and fills in its step; returns the item's line for the result. */
async function runItem({ registry, ctx, item, step }: ItemRun): Promise<string> {
  const tool = registry.get(item.tool);
  if (!tool) {
    step.outcome = 'error';
    return `${item.label}: unbekanntes Werkzeug`;
  }
  const parsed = tool.schema.safeParse(item.args);
  if (!parsed.success) {
    step.outcome = 'error';
    return `${item.label}: ungültige Angaben`;
  }
  const started = Date.now();
  try {
    const out = await agentRunScope.run({ runId: ctx.runId, explicit: true, auditIds: step.auditIds, stepId: step.id }, () => tool.run(parsed.data, ctx));
    step.outcome = out.isError ? 'error' : 'ok';
    step.summary = out.summary ?? '';
    step.result = truncate(out.content, 600);
    return `${item.label}: ${out.isError ? truncate(out.content, 160) : (out.summary ?? 'erledigt')}`;
  } catch (err) {
    step.outcome = 'error';
    step.result = toErrorInfo(err).message;
    return `${item.label}: ${toErrorInfo(err).message}`;
  } finally {
    step.durationMs = Date.now() - started;
  }
}
