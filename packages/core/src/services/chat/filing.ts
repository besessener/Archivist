import path from 'node:path';
import type { DocumentRecord } from '@archivist/shared';
import { toErrorInfo } from '../../util/errors';
import { isInside, sanitizeCategoryPath } from '../../util/paths';
import { truncate } from '../../util/text';
import { chooseTargetFolder, folderChoiceText, folderLabel, folderOf, groupByFolder, splitSubjects, type FolderGroup } from '../archive-structure';
import type { ConvState, Reply } from '../chat-state';
import { archivedWithFile, FilingSubjects } from './filing-subjects';
import type { ChatDeps, ChatRequest } from './types';

type FilingDeps = Pick<ChatDeps, 'graph' | 'docs' | 'search' | 'settings' | 'actions' | 'archive'>;
type RelocationPlan = Awaited<ReturnType<ChatDeps['archive']['previewRelocate']>>;

const STRUCTURE_SCOPE = 'Geprüft wird nur, ob Dokumente zum selben Thema bzw. Projekt im selben Verzeichnis liegen.';

function describeGroups(groups: FolderGroup<DocumentRecord>[]): string {
  return groups.map((g) => `• **${folderLabel(g.folder)}** (${g.docs.length}): ${g.docs.map((d) => truncate(d.title, 60)).join('; ')}`).join('\n');
}

/** The documents a filing reply is about: remembered for follow-up requests and shown as context. */
function shownDocuments(docs: DocumentRecord[], view: { subject: string | null; state: ConvState }): Partial<Reply> {
  return {
    state: { ...view.state, last: { ...(view.state.last ?? {}), documentIds: docs.map((d) => d.id), topic: view.subject } },
    context: { documents: docs.map((d) => ({ type: 'document' as const, id: d.id, label: d.title })) },
  };
}

/** Checking and tidying the archive's directories: are the documents of a topic in one place, and moving them there. */
export class FilingReplies {
  private readonly subjects: FilingSubjects;

  constructor(private readonly deps: FilingDeps) {
    this.subjects = new FilingSubjects(deps);
  }

  /** Short hint for other replies when the documents of a topic are spread over several directories. */
  scatterHint(): string {
    const split = splitSubjects(archivedWithFile(this.deps.docs.list({ status: 'archived', limit: 1000 })));
    if (!split.length) return '';
    const names = split
      .slice(0, 3)
      .map((s) => `${s.kind} „${s.name}“ (${s.groups.length} Verzeichnisse)`)
      .join(', ');
    return `\n\nZur Ablage: Zu ${names} liegen Dokumente verstreut. Frag mich nach der Ablage, wenn ich das ordnen soll.`;
  }

  async structure(request: ChatRequest): Promise<Reply> {
    const { docs, subject, choices } = await this.subjects.toView(request);
    if (choices.length) return this.subjects.askWhich(request, choices);
    const reply = (content: string, extra: Partial<Reply> = {}): Reply => ({
      intent: 'archive_structure',
      content,
      confidence: 0.8,
      state: request.state,
      ...extra,
    });
    if (docs.length === 0 && subject) return reply(`Zu „${subject}“ habe ich keine archivierten Dokumente gefunden.`, { confidence: 0.4 });
    if (docs.length === 0) return reply(...this.archiveOverview());
    const groups = groupByFolder(docs);
    const what = subject ? `„${subject}“` : 'diesen Dokumenten';
    const shown = shownDocuments(docs, { subject, state: request.state });
    if (groups.length === 1) return reply(`Alle ${docs.length} Dokument(e) zu ${what} liegen im selben Verzeichnis:\n\n${describeGroups(groups)}`, shown);
    const choice = chooseTargetFolder(groups);
    const suggestion =
      choice.kind === 'chosen'
        ? ` – ich würde „${choice.folder}“ vorschlagen, dort liegen schon die meisten`
        : choice.kind === 'tied'
          ? ` – in ${folderChoiceText(choice.folders)} liegen gleich viele, nenne mir bitte den Ordner, den du willst`
          : '';
    return reply(
      `Die ${docs.length} Dokument(e) zu ${what} liegen in ${groups.length} verschiedenen Verzeichnissen:\n\n${describeGroups(groups)}\n\nDas ist nicht konsistent abgelegt. Sag mir z. B. „leg alle in einen Ordner“${suggestion}. Verschoben wird erst nach deiner Bestätigung.`,
      shown,
    );
  }

  /** The whole archive: which topics have documents in several directories. */
  private archiveOverview(): [string, Partial<Reply>] {
    const all = archivedWithFile(this.deps.docs.list({ status: 'archived', limit: 1000 }));
    if (all.length === 0) return ['Es sind noch keine Dokumente archiviert.', { confidence: 0.6 }];
    const split = splitSubjects(all);
    const folders = groupByFolder(all).length;
    const heading = `**Ablage im Archiv**\n${all.length} archivierte Dokument(e) in ${folders} Verzeichnis(sen).`;
    if (split.length === 0)
      return [`${heading} Zu keinem Thema und keinem Projekt liegen Dokumente in verschiedenen Verzeichnissen.`, { uncertainties: [STRUCTURE_SCOPE] }];
    const lines = split
      .slice(0, 8)
      .map(
        (s) =>
          `• ${s.kind} „${s.name}“: ${s.groups.reduce((n, g) => n + g.docs.length, 0)} Dokumente in ${s.groups.length} Verzeichnissen (${s.groups.map((g) => `${folderLabel(g.folder)} (${g.docs.length})`).join(', ')})`,
      )
      .join('\n');
    return [
      `${heading} Bei diesen Themen liegen Dokumente verstreut:\n\n${lines}\n\nSag mir z. B. „leg die Dokumente zu ${split[0]!.name} in einen Ordner“, dann bereite ich das Verschieben vor. Verschoben wird erst nach deiner Bestätigung.`,
      { uncertainties: [STRUCTURE_SCOPE] },
    ];
  }

  async reorganize(request: ChatRequest): Promise<Reply> {
    const reply = (content: string, extra: Partial<Reply> = {}): Reply => ({
      intent: 'archive_reorganize',
      content,
      confidence: 0.7,
      state: request.state,
      ...extra,
    });
    const { docs, subject, choices } = this.subjects.toMove(request);
    if (choices.length) return this.subjects.askWhich(request, choices);
    if (docs.length === 0)
      return reply(
        subject
          ? `Zu „${subject}“ kenne ich kein Thema und kein Projekt mit archivierten Dokumenten. Nenne mir bitte den genauen Namen (z. B. „Bildungsurlaub 2026“) oder frage zuerst nach der Ablage.`
          : 'Welche archivierten Dokumente soll ich zusammenlegen? Nenne mir bitte das Thema (z. B. „Bildungsurlaub 2026“) oder frage zuerst nach der Ablage.',
        { confidence: 0.3 },
      );
    const target = this.targetFolder(request.intent.path?.trim(), docs);
    if ('error' in target) return reply(target.error, { confidence: 0.3 });
    const shown = shownDocuments(docs, { subject, state: request.state });
    const movable = docs.filter((d) => folderOf(d) !== target.folder);
    if (movable.length === 0)
      return reply(`Alle ${docs.length} Dokument(e) liegen schon in „${target.folder}“. Da gibt es nichts zu verschieben.`, { ...shown, confidence: 0.9 });
    const plan = await this.deps.archive.previewRelocate(movable.map((d) => ({ documentId: d.id, categoryPath: target.folder })));
    const ok = plan.filter((p) => !p.blocked && !p.unchanged);
    const blocked = plan.filter((p) => p.blocked);
    const blockedText = blocked.length
      ? `\n\nDiese kann ich nicht verschieben:\n${blocked.map((p) => `• ${truncate(p.title, 60)}: ${p.conflicts.join(' ')}`).join('\n')}`
      : '';
    if (ok.length === 0) return reply(`Ich kann keines der Dokumente nach „${target.folder}“ verschieben.${blockedText}`, { ...shown, confidence: 0.4 });
    const byId = new Map(movable.map((d) => [d.id, d]));
    const action = this.proposeRelocation(request, { docs, byId, ok, target: target.folder, subject });
    const lines = ok
      .map(
        (p) =>
          `• ${truncate(p.title, 60)}: ${folderLabel(folderOf(byId.get(p.documentId)!))} → ${target.folder}${p.renamed ? ' (wird umbenannt, der Name ist dort belegt)' : ''}`,
      )
      .join('\n');
    return reply(
      `Ich habe vorbereitet, ${ok.length} Dokument(e) nach „${target.folder}“ zu verschieben:\n\n${lines}${blockedText}\n\nBitte bestätige. Vorher ändert sich nichts. Du kannst auch einen anderen Zielordner nennen („nimm stattdessen …“).`,
      { actions: [action], ...shown, confidence: action.confidence },
    );
  }

  /** The directory named in the request (inside the archive), otherwise the one most documents are in already. */
  private targetFolder(asked: string | undefined, docs: DocumentRecord[]): { folder: string } | { error: string } {
    if (!asked) return this.mostUsedFolder(docs);
    const root = this.deps.settings.get().archiveRoot;
    const relative = path.isAbsolute(asked) && isInside(root, asked) ? path.relative(root, asked).split(path.sep).join('/') : asked;
    try {
      return { folder: sanitizeCategoryPath(relative) };
    } catch (err) {
      return { error: `Das Zielverzeichnis „${asked}“ kann ich nicht verwenden: ${toErrorInfo(err).message}` };
    }
  }

  private mostUsedFolder(docs: DocumentRecord[]): { folder: string } | { error: string } {
    const choice = chooseTargetFolder(groupByFolder(docs));
    if (choice.kind === 'chosen') return { folder: choice.folder };
    if (choice.kind === 'tied')
      return { error: `In ${folderChoiceText(choice.folders)} liegen gleich viele Dokumente. Nenne mir bitte den Zielordner, den du willst.` };
    return { error: 'Ich weiß nicht, in welches Verzeichnis die Dokumente sollen. Nenne mir bitte einen Zielordner, z. B. „Privat/Bildungsurlaub/2026“.' };
  }

  private proposeRelocation(
    request: ChatRequest,
    move: { docs: DocumentRecord[]; byId: Map<string, DocumentRecord>; ok: RelocationPlan; target: string; subject: string | null },
  ) {
    const actions = this.deps.actions;
    // replaces every open relocate proposal of this conversation and every other one for these documents, so an older target never moves them back
    const replaced = new Set(
      [
        ...actions.list('proposed').filter((a) => a.actionType === 'relocate_documents' && a.conversationId === request.conversationId),
        ...actions.openRelocationsFor(move.docs.map((d) => d.id)),
      ].map((a) => a.id),
    );
    for (const id of replaced) actions.withdraw(id, 'Durch einen neueren Umlager-Vorschlag ersetzt.');
    return actions.propose({
      actionType: 'relocate_documents',
      label: `${move.ok.length} Dokument(e) nach „${move.target}“ verschieben`,
      rationale: `Alle Dokumente${move.subject ? ` zu „${move.subject}“` : ''} sollen im selben Verzeichnis liegen. Es wird verschoben, nichts überschrieben; über das Protokoll lässt es sich rückgängig machen.`,
      confidence: 0.8,
      affectedEntities: move.ok.map((p) => ({ type: 'document' as const, id: p.documentId, label: p.title })),
      requiredConfirmation: 'confirm',
      proposedParameters: {
        items: move.ok.map((p) => ({
          documentId: p.documentId,
          categoryPath: move.target,
          fromRelPath: move.byId.get(p.documentId)?.archiveRelPath ?? undefined,
        })),
      },
      conversationId: request.conversationId,
    });
  }
}
