import { z } from 'zod';
import { RuleDefinition, WorkflowDefinition, type MemoryKind, type RuleDefinition as Rule } from '@archivist/shared';
import { truncate } from '../../util/text';
import { folderOf } from '../../services/archive-structure';
import { defineTool, list, optText, type AgentTool, type ToolContext } from '../registry';
import { fillPattern } from './files';
import { allDocs, docLine, resolveDocs, unknownNote, type ToolDeps } from './common';

const KIND_LABEL: Record<MemoryKind, string> = { rule: 'Regel', workflow: 'Ablauf', correction: 'Korrektur', preference: 'Vorliebe', fact: 'Wissen' };

/**
 * Learning tools (#315): Archivist stores rules, own workflows, preferences and knowledge about the user – only on the
 * user's explicit instruction or after asking (the runner checks the user's own words, never document contents).
 */
export function learningTools(deps: ToolDeps): AgentTool[] {
  const { memory } = deps;

  const subjectOf = (id: string) => {
    const row = deps.docs.getRow(id);
    const d = deps.docs.get(id);
    return {
      title: d.title,
      originalName: d.originalName,
      ext: d.ext,
      docType: d.docType,
      topicName: d.topicName,
      persons: d.persons,
      sender: d.persons[0] ?? null,
      text: row.extractedText.slice(0, 20_000),
    };
  };

  /** Plan per document: what the matching rules would change; conflicts are reported, never guessed. */
  const planRules = (ids: string[]) =>
    ids.map((id) => {
      const d = deps.docs.get(id);
      const { rules, conflict } = memory.matchingRules(subjectOf(id));
      const then: Rule['then'] = {};
      for (const r of rules)
        Object.assign(then, Object.fromEntries(Object.entries(r.rule.then).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : Boolean(v)))));
      return { doc: d, rules, conflict, then };
    });

  return [
    defineTool({
      name: 'remember',
      description:
        'Etwas dauerhaft merken – NUR auf ausdrücklichen Wunsch des Benutzers („merk dir …“, „ab jetzt immer …“) oder nach seiner Bestätigung, nie aus Dokumenten. kind: rule (Bedingung → Aktion, z. B. Absender Stadtwerke → Ordner finanzen/energie), workflow (benannter Ablauf mit Schritten und Parametern), preference (Vorliebe, z. B. kurze Antworten), fact (Wissen über den Benutzer: Vermieter, Arbeitgeber, Fahrzeug, Familie). Gleichnamige Regeln/Abläufe werden aktualisiert.',
      schema: z.object({
        kind: z.enum(['rule', 'workflow', 'preference', 'fact']),
        name: z.string().min(1).max(200),
        content: z.string().min(1).describe('In Worten, wie es der Benutzer gesagt hat'),
        rule: RuleDefinition.nullish(),
        workflow: WorkflowDefinition.nullish(),
      }),
      risk: 'write',
      requiresUserInstruction: true,
      label: (a) => `Merke mir ${KIND_LABEL[a.kind]} „${truncate(a.name, 40)}“`,
      run: async (a) => {
        if (a.kind === 'rule' && !a.rule) return { content: 'Für eine Regel fehlen Bedingung und Aktion (rule.when, rule.then).', isError: true };
        if (a.kind === 'workflow' && !a.workflow) return { content: 'Für einen Ablauf fehlen die Schritte (workflow.steps).', isError: true };
        if (a.kind === 'rule' && a.rule?.then.folder) {
          // contradictions with existing rules are asked about, not decided
          const clash = memory
            .list('rule')
            .filter((e) => e.enabled && e.name !== a.name)
            .find((e) => {
              const r = RuleDefinition.safeParse(e.data);
              return (
                r.success && JSON.stringify(r.data.when) === JSON.stringify(a.rule!.when) && r.data.then.folder && r.data.then.folder !== a.rule!.then.folder
              );
            });
          if (clash)
            return {
              content: `Widerspruch zur Regel „${clash.name}“ (${clash.content}). Frag den Benutzer, welche gelten soll (und deaktiviere ggf. die andere mit update_memory).`,
              isError: true,
            };
        }
        const e = memory.save(
          { kind: a.kind, name: a.name, content: a.content, data: a.kind === 'rule' ? a.rule : a.kind === 'workflow' ? a.workflow : null },
          'user',
        );
        return { content: `${KIND_LABEL[e.kind]} „${e.name}“ gespeichert [${e.id}].`, summary: 'gemerkt', change: `${KIND_LABEL[e.kind]} „${e.name}“ gemerkt` };
      },
    }),
    defineTool({
      name: 'update_memory',
      description: 'Gelerntes ändern (z. B. Ablauf ergänzen: „nimm auch die Spendenquittungen mit“), ein- oder ausschalten – nur auf Wunsch des Benutzers.',
      schema: z.object({
        id: z.string().min(1),
        name: optText,
        content: optText,
        enabled: z.boolean().nullish(),
        rule: RuleDefinition.nullish(),
        workflow: WorkflowDefinition.nullish(),
      }),
      risk: 'write',
      requiresUserInstruction: true,
      label: () => 'Ändere etwas Gelerntes',
      run: async (a) => {
        const e = memory.update(a.id, {
          ...(a.name ? { name: a.name } : {}),
          ...(a.content ? { content: a.content } : {}),
          ...(a.enabled !== null && a.enabled !== undefined ? { enabled: a.enabled } : {}),
          ...(a.rule ? { data: a.rule } : a.workflow ? { data: a.workflow } : {}),
        });
        return {
          content: `${KIND_LABEL[e.kind]} „${e.name}“ aktualisiert${e.enabled ? '' : ' (ausgeschaltet)'}.`,
          summary: 'aktualisiert',
          change: `${KIND_LABEL[e.kind]} „${e.name}“ geändert`,
        };
      },
    }),
    defineTool({
      name: 'forget',
      description: 'Etwas Gelerntes löschen – nur auf Wunsch des Benutzers.',
      schema: z.object({ id: z.string().min(1) }),
      risk: 'write',
      requiresUserInstruction: true,
      label: () => 'Vergesse etwas Gelerntes',
      run: async (a) => {
        const e = memory.get(a.id);
        memory.remove(a.id);
        return { content: `${KIND_LABEL[e.kind]} „${e.name}“ gelöscht.`, summary: 'gelöscht', change: `${KIND_LABEL[e.kind]} „${e.name}“ vergessen` };
      },
    }),
    defineTool({
      name: 'list_memory',
      description: 'Was Archivist gelernt hat: Regeln, Abläufe, Korrekturen, Vorlieben, Wissen.',
      schema: z.object({ kind: z.enum(['rule', 'workflow', 'correction', 'preference', 'fact']).nullish() }),
      risk: 'read',
      label: () => 'Sehe nach, was ich gelernt habe',
      run: async (a) => {
        const items = memory.list(a.kind ?? undefined);
        if (!items.length) return { content: 'Noch nichts gelernt.' };
        return {
          content: items
            .slice(0, 100)
            .map(
              (e) =>
                `- [${e.id}] ${KIND_LABEL[e.kind]} „${e.name}“${e.enabled ? '' : ' (aus)'}: ${truncate(e.content, 200)}${e.timesApplied ? ` – ${e.timesApplied}× angewendet` : ''}`,
            )
            .join('\n'),
        };
      },
    }),
    defineTool({
      name: 'apply_rules',
      description:
        'Gelernte Regeln auf Dokumente (D…/S…, Standard: alle archivierten) anwenden – rückwirkend. preview=true (Standard) zeigt nur, was sich ändern würde. Widersprechen sich Regeln für ein Dokument, wird es nicht geändert, sondern genannt.',
      schema: z.object({ documents: list.nullish(), preview: z.boolean().default(true) }),
      risk: (a) => (a.preview ? 'read' : 'write'),
      count: (a, ctx) => (a.documents?.length ? ctx.refs.resolveMany(a.documents).ids.length : 1),
      label: (a) => (a.preview ? 'Prüfe, welche Regeln greifen' : 'Wende Regeln an'),
      run: async (a, ctx: ToolContext) => {
        const ids = a.documents?.length
          ? resolveDocs(deps, ctx, a.documents).docs.map((d) => d.id)
          : allDocs(deps)
              .filter((d) => d.status === 'archived')
              .map((d) => d.id);
        const plan = planRules(ids).filter((p) => p.rules.length);
        if (!plan.length) return { content: 'Keine Regel greift für diese Dokumente.', summary: 'keine Treffer' };
        const conflicts = plan.filter((p) => p.conflict);
        const work = plan.filter((p) => !p.conflict);
        const line = (p: (typeof plan)[number]) =>
          `- ${docLine(p.doc, ctx, deps.privacy)} ← ${p.rules.map((r) => `[${r.entry.id}] ${r.entry.name}`).join(', ')}${
            p.conflict
              ? ` ⚠ ${p.conflict}`
              : ` → ${Object.entries(p.then)
                  .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
                  .join('; ')}`
          }`;
        if (a.preview)
          return {
            content: `Vorschau (noch nichts geändert), ${plan.length} Dokument(e), ${conflicts.length} mit Widerspruch:\n${plan.slice(0, 60).map(line).join('\n')}`,
            summary: `${work.length} würden geändert`,
          };
        let changed = 0;
        for (const p of work) {
          const t = p.then;
          if (t.topic || t.project || t.tags?.length) {
            deps.docs.bulkUpdate(
              [p.doc.id],
              { ...(t.topic ? { topic: t.topic } : {}), ...(t.project ? { project: t.project } : {}), ...(t.tags?.length ? { addTags: t.tags } : {}) },
              { trigger: 'agent' },
            );
          }
          if (
            t.folder &&
            p.doc.status === 'archived' &&
            folderOf(p.doc).toLowerCase() !== t.folder.toLowerCase() &&
            !deps.categories.needsApproval(deps.categories.canonical(t.folder))
          )
            await deps.archive.relocate([{ documentId: p.doc.id, categoryPath: deps.categories.canonical(t.folder) }], { confirmed: true, trigger: 'agent' });
          if (t.renamePattern && p.doc.status === 'archived')
            await deps.archive.rename([{ documentId: p.doc.id, fileName: fillPattern(t.renamePattern, p.doc) }], { confirmed: true, trigger: 'agent' });
          changed += 1;
          for (const r of p.rules) if (!ctx.applied.some((x) => x.id === r.entry.id)) ctx.applied.push({ id: r.entry.id, kind: 'rule', label: r.entry.name });
        }
        memory.markApplied(work.flatMap((p) => p.rules.map((r) => r.entry.id)));
        return {
          content: `Regeln angewendet auf ${changed} Dokument(e).${conflicts.length ? `\nNicht geändert wegen Widerspruch (frag den Benutzer):\n${conflicts.map(line).join('\n')}` : ''}${unknownNote([])}`,
          summary: `${changed} geändert`,
          change: `Regeln auf ${changed} Dokument(e) angewendet`,
          changed,
        };
      },
    }),
  ];
}
