import { z } from 'zod';
import { WorkflowDefinition, type MemoryEntry } from '@archivist/shared';
import { normalizeName } from '../../util/text';
import { defineTool, type AgentTool, type ToolContext } from '../registry';
import { userAgrees } from '../security';
import type { ToolDeps } from './common';

interface Learned {
  entry: MemoryEntry;
  definition: WorkflowDefinition;
}

function findWorkflow(memory: ToolDeps['memory'], wanted: string): Learned | null {
  const key = normalizeName(wanted);
  for (const entry of memory.list('workflow')) {
    const definition = WorkflowDefinition.safeParse(entry.data);
    if (entry.enabled && definition.success && (entry.id === wanted.trim() || normalizeName(entry.name) === key)) return { entry, definition: definition.data };
  }
  return null;
}

const fill = (step: string, values: Record<string, string>) => step.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);

function planText({ entry, definition }: Learned, values: Record<string, string>): string {
  const given = Object.entries(values)
    .map(([name, value]) => `${name} = ${value}`)
    .join(', ');
  const steps = definition.steps.map((step, i) => `${i + 1}. ${fill(step, values)}`).join('\n');
  return `Ablauf „${entry.name}“ [${entry.id}]: ${entry.content}${given ? `\nParameter: ${given}` : ''}\nSchritte:\n${steps}`;
}

/** What stops a workflow from running now: missing parameters, no one to confirm the first run. */
function obstacle(learned: Learned, { values, ctx }: { values: Record<string, string>; ctx: ToolContext }): string | null {
  const missing = learned.definition.parameters.filter((p) => !values[p.name]?.trim());
  if (missing.length)
    return `Es fehlen Parameter: ${missing.map((p) => `${p.name}${p.description ? ` (${p.description})` : ''}`).join(', ')}. ${ctx.trigger === 'chat' ? 'Frag den Benutzer mit ask_user danach' : 'Im Hintergrund kann niemand antworten – führe nichts aus und nenne die fehlenden Angaben im Bericht'}.`;
  if (learned.entry.timesApplied > 0 || (ctx.trigger === 'chat' && userAgrees(ctx.lastAnswer))) return null;
  const plan = planText(learned, values);
  return ctx.trigger === 'chat'
    ? `Erster Lauf dieses Ablaufs – noch nichts ausgeführt. Zeige dem Benutzer diesen Plan mit ask_user (Antworten „Ja“ und „Nein“) und rufe run_workflow nach seinem Ja erneut auf:\n${plan}`
    : `Dieser Ablauf lief noch nie, und im Hintergrund kann ihn niemand bestätigen – führe nichts aus. Nenne im Bericht nur, dass der erste Lauf im Chat bestätigt werden muss:\n${plan}`;
}

/** Runs an ability the user taught by name (#315): the plan and parameters are checked here, the steps use the normal tools and their gates. */
export function workflowTools(deps: ToolDeps): AgentTool[] {
  const { memory } = deps;
  return [
    defineTool({
      name: 'run_workflow',
      description:
        'Einen gelernten Ablauf des Benutzers per Name ausführen („Mach die Steuer-Mappe für 2025“). Prüft die Parameter (fehlende frägst du nach), zählt den Lauf und liefert die Schritte, die du danach mit den üblichen Werkzeugen ausführst. Beim ersten Lauf eines Ablaufs zeigst du dem Benutzer vorher den Plan und wartest auf sein Ja.',
      schema: z.object({
        workflow: z.string().min(1).describe('Name oder ID des Ablaufs'),
        parameters: z.record(z.string(), z.string()).nullish().describe('Werte der Parameter des Ablaufs, z. B. {"jahr":"2025"}'),
      }),
      risk: 'read',
      label: (a) => `Starte den Ablauf „${a.workflow}“`,
      run: async (a, ctx) => {
        const learned = findWorkflow(memory, a.workflow);
        if (!learned) {
          const names = memory
            .list('workflow')
            .filter((e) => e.enabled)
            .map((e) => `„${e.name}“`);
          return { content: `Kein solcher Ablauf. Bekannt: ${names.join(', ') || 'keine'}.`, isError: true };
        }
        const values = a.parameters ?? {};
        const blocked = obstacle(learned, { values, ctx });
        if (blocked) return { content: blocked, summary: 'noch nicht gestartet', isError: true };
        memory.markApplied([learned.entry.id]);
        ctx.applied.push({ id: learned.entry.id, kind: 'workflow', label: learned.entry.name });
        return { content: `${planText(learned, values)}\nFühre die Schritte jetzt der Reihe nach aus.`, summary: `Ablauf „${learned.entry.name}“ gestartet` };
      },
    }),
  ];
}
