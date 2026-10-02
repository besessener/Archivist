import { z } from 'zod';
import { RelationType } from '@archivist/shared';
import { truncate } from '../../util/text';
import { defineTool, list, optText, type AgentTool, type ToolContext } from '../registry';
import { TYPE_LABEL, unknownNote, type ToolDeps } from './common';

/**
 * Links and cases (#306, with #277, #270, #280, #286): the rule of Epic #294 – a link the user explicitly asked for is
 * confirmed in mode „Auto“ (origin agent, with run id); a link of the agent's own accord stays a proposal. Rejected pairs
 * are never proposed again.
 */
export function linkTools(deps: ToolDeps): AgentTool[] {
  const { graph } = deps;
  const name = (id: string) => {
    const e = graph.getEntity(id);
    return e ? `${TYPE_LABEL[e.type] ?? e.type} „${truncate(e.name, 50)}“` : id;
  };
  const statusFor = (ctx: ToolContext, onUserRequest: boolean) => (ctx.trigger === 'chat' && onUserRequest ? 'confirmed' : 'proposed');

  return [
    defineTool({
      name: 'link',
      description:
        'Zwei Einträge (D…/K…) verknüpfen, mit Art der Beziehung. onUserRequest=true NUR, wenn der Benutzer diese Verknüpfung ausdrücklich verlangt hat – dann gilt sie als bestätigt; aus eigenem Antrieb (false) bleibt sie ein Vorschlag. Vom Benutzer abgelehnte Paare werden nie wieder vorgeschlagen.',
      schema: z.object({
        a: z.string().min(1),
        b: z.string().min(1),
        relationType: RelationType.default('relates_to'),
        onUserRequest: z.boolean().default(false),
      }),
      risk: 'write',
      label: () => 'Verknüpfe zwei Einträge',
      run: async (a, ctx) => {
        const src = ctx.refs.resolve(a.a);
        const tgt = ctx.refs.resolve(a.b);
        if (!src || !tgt) return { content: `Unbekannte ID(s).${unknownNote([a.a, a.b].filter((r) => !ctx.refs.resolve(r)))}`, isError: true };
        const status = statusFor(ctx, a.onUserRequest);
        const rejected = graph.rejectedBetween(src, tgt);
        if (rejected && status === 'proposed')
          return {
            content: `${name(src)} und ${name(tgt)} wurden vom Benutzer als „gehört nicht zusammen“ abgelehnt – kein neuer Vorschlag.`,
            summary: 'abgelehnt',
          };
        const r = graph.linkEntries(src, tgt, a.relationType, { status, trigger: 'agent' });
        return {
          content: `${name(src)} – ${name(tgt)}: ${a.relationType}, ${r.relation.status === 'confirmed' ? 'bestätigt' : 'als Vorschlag'}${r.created ? ' (neu)' : ''}.`,
          summary: r.relation.status === 'confirmed' ? 'verknüpft' : 'vorgeschlagen',
          change: `${name(src)} mit ${name(tgt)} ${r.relation.status === 'confirmed' ? 'verknüpft' : 'als Verknüpfung vorgeschlagen'}`,
        };
      },
    }),
    defineTool({
      name: 'unlink',
      description: 'Eine Verknüpfung zwischen zwei Einträgen (D…/K…) entfernen (nur auf Wunsch des Benutzers).',
      schema: z.object({ a: z.string().min(1), b: z.string().min(1), relationType: RelationType.nullish() }),
      risk: 'write',
      label: () => 'Entferne eine Verknüpfung',
      run: async (a, ctx) => {
        const src = ctx.refs.resolve(a.a);
        const tgt = ctx.refs.resolve(a.b);
        if (!src || !tgt) return { content: 'Unbekannte ID(s).', isError: true };
        const rels = graph
          .relationsOf(src)
          .filter(
            (r) => (r.sourceEntityId === tgt || r.targetEntityId === tgt) && (!a.relationType || r.relationType === a.relationType) && r.status !== 'rejected',
          );
        if (!rels.length) return { content: 'Zwischen den beiden gibt es keine Verknüpfung.', summary: 'nichts zu tun' };
        for (const r of rels) graph.unlinkEntries(r.id, { trigger: 'agent' });
        return {
          content: `${rels.length} Verknüpfung(en) zwischen ${name(src)} und ${name(tgt)} entfernt.`,
          summary: 'entfernt',
          change: `Verknüpfung ${name(src)} – ${name(tgt)} entfernt`,
        };
      },
    }),
    defineTool({
      name: 'decide_link_proposals',
      description:
        'Vorgeschlagene Verknüpfungen bestätigen oder ablehnen – für einen Eintrag (entry: D…/K…) oder alle Einträge eines Projekts/Themas (subject: Name). Nur auf Wunsch des Benutzers („Bestätige alle Vorschläge zum Projekt X“). Abgelehnte Paare werden nie wieder vorgeschlagen.',
      schema: z.object({ entry: optText, subject: optText, decision: z.enum(['confirm', 'reject']), relationIds: list.nullish() }),
      risk: 'write',
      count: () => 1,
      label: (a) => `${a.decision === 'confirm' ? 'Bestätige' : 'Lehne'} vorgeschlagene Verknüpfungen${a.decision === 'reject' ? ' ab' : ''}`,
      run: async (a, ctx) => {
        let ids: string[];
        if (a.entry) {
          const id = ctx.refs.resolve(a.entry);
          if (!id) return { content: `Unbekannte ID „${a.entry}“.`, isError: true };
          ids = [id];
        } else if (a.subject) {
          const subj =
            graph.findByNameOrAlias('project', a.subject) ?? graph.findByNameOrAlias('topic', a.subject) ?? graph.findByNameOrAlias('case', a.subject);
          if (!subj) return { content: `Projekt bzw. Thema „${a.subject}“ ist unbekannt.`, isError: true };
          ids = [subj.id, ...graph.neighbors(subj.id).map((e) => e.id)];
        } else return { content: 'Gib entry oder subject an.', isError: true };
        const wanted = a.relationIds?.length ? new Set(a.relationIds) : null;
        const proposals = [...new Map(ids.flatMap((id) => graph.relationsOf(id, { statuses: ['proposed'] })).map((r) => [r.id, r])).values()].filter(
          (r) => !wanted || wanted.has(r.id),
        );
        if (!proposals.length) return { content: 'Keine offenen Verknüpfungsvorschläge gefunden.', summary: 'keine' };
        for (const r of proposals) graph.decideRelation(r.id, a.decision === 'confirm' ? 'confirmed' : 'rejected', { trigger: 'agent' });
        return {
          content: `${proposals.length} Vorschlag/Vorschläge ${a.decision === 'confirm' ? 'bestätigt' : 'abgelehnt'}:\n${proposals
            .slice(0, 30)
            .map((r) => `- ${name(r.sourceEntityId)} – ${name(r.targetEntityId)} (${r.relationType})`)
            .join('\n')}`,
          summary: `${proposals.length} ${a.decision === 'confirm' ? 'bestätigt' : 'abgelehnt'}`,
          change: `${proposals.length} Verknüpfungsvorschläge ${a.decision === 'confirm' ? 'bestätigt' : 'abgelehnt'}`,
          changed: proposals.length,
        };
      },
    }),
    defineTool({
      name: 'create_case',
      description: 'Einen Vorgang anlegen (z. B. „Autokauf 2026“) und optional Einträge (D…/K…/S…) zuordnen.',
      schema: z.object({ name: z.string().min(1), description: optText, entries: list.nullish() }),
      risk: 'write',
      label: (a) => `Lege den Vorgang „${truncate(a.name, 40)}“ an`,
      run: async (a, ctx) => {
        const existed = graph.findByNameOrAlias('case', a.name);
        const c = existed ?? graph.ensureEntity('case', a.name, a.description);
        if (!existed) deps.audit.log({ action: 'case.create', actor: 'agent', trigger: 'agent', confirmed: true, entityIds: [c.id], after: { name: c.name } });
        const { ids, unknown } = ctx.refs.resolveMany(a.entries ?? []);
        for (const id of ids) graph.linkEntries(id, c.id, 'belongs_to', { status: 'confirmed', trigger: 'agent' });
        return {
          content: `${ctx.refs.entry(c.id)} Vorgang „${c.name}“ ${existed ? 'gab es schon' : 'angelegt'}${ids.length ? `, ${ids.length} Einträge zugeordnet` : ''}.${unknownNote(unknown)}`,
          summary: existed ? 'vorhanden' : 'angelegt',
          change: `Vorgang „${c.name}“ ${existed ? 'ergänzt' : 'angelegt'}${ids.length ? ` (${ids.length} Einträge)` : ''}`,
          changed: ids.length || 1,
        };
      },
    }),
    defineTool({
      name: 'add_to_case',
      description: 'Einträge (D…/K…/S…) einem bestehenden Vorgang (K…) zuordnen.',
      schema: z.object({ case: z.string().min(1), entries: list }),
      risk: 'write',
      count: (a, ctx) => ctx.refs.resolveMany(a.entries).ids.length,
      label: () => 'Ordne Einträge einem Vorgang zu',
      run: async (a, ctx) => {
        const caseId = ctx.refs.resolve(a.case);
        if (!caseId || graph.getEntity(caseId)?.type !== 'case')
          return { content: `„${a.case}“ ist kein Vorgang – list_entries kind=case zeigt sie.`, isError: true };
        const { ids, unknown } = ctx.refs.resolveMany(a.entries);
        for (const id of ids) graph.linkEntries(id, caseId, 'belongs_to', { status: 'confirmed', trigger: 'agent' });
        return {
          content: `${ids.length} Einträge ${name(caseId)} zugeordnet.${unknownNote(unknown)}`,
          summary: `${ids.length} zugeordnet`,
          change: `${ids.length} Einträge ${name(caseId)} zugeordnet`,
          changed: ids.length,
        };
      },
    }),
    defineTool({
      name: 'close_case',
      description: 'Einen Vorgang (K…) abschließen oder mit reopen=true wieder öffnen.',
      schema: z.object({ case: z.string().min(1), reopen: z.boolean().default(false) }),
      risk: 'write',
      label: (a) => (a.reopen ? 'Öffne einen Vorgang wieder' : 'Schließe einen Vorgang ab'),
      run: async (a, ctx) => {
        const caseId = ctx.refs.resolve(a.case);
        if (!caseId) return { content: `Unbekannte ID „${a.case}“.`, isError: true };
        const c = graph.setCaseStatus(caseId, a.reopen ? 'open' : 'closed', { trigger: 'agent' });
        return {
          content: `Vorgang „${c.name}“ ist ${a.reopen ? 'wieder offen' : 'abgeschlossen'}.`,
          summary: a.reopen ? 'geöffnet' : 'abgeschlossen',
          change: `Vorgang „${c.name}“ ${a.reopen ? 'wieder geöffnet' : 'abgeschlossen'}`,
        };
      },
    }),
  ];
}
