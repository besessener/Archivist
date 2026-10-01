import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { subjectFromText } from '../../packages/core/src/services/chat';
import { createTestApp, type TestApp } from '../helpers/harness';

const TOPIC = 'Bildungsurlaub 2026';
const intent = (over: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...over });

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const archiveRoot = () => app.services.settings.get().archiveRoot;
const folderOf = (id: string) => path.posix.dirname(app.services.documents.getRow(id).archiveRelPath!);

async function archived(name: string, loc: string, topic: string | null = TOPIC, content = `Inhalt von ${name}`): Promise<string> {
  app.llm.on('DocumentClassification', () => ({
    docType: 'Notiz',
    title: name,
    summary: `Zusammenfassung ${name}`,
    mainTopic: topic,
    project: null,
    persons: [],
    dates: [],
    tags: [],
    location: { categoryPath: loc, fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
    decisions: [],
    openItems: [],
    confidence: 0.7,
    rationale: 'x',
  }));
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}.txt`, content)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: loc, topic }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

/** Sechs Bildungsurlaub-Dokumente in vier Verzeichnissen, dazu ein fremdes Dokument. */
async function scatteredArchive() {
  const ids = [
    await archived('Antrag', 'work/hr/abwesenheiten'),
    await archived('Antrag-Screenshot', 'work/hr/abwesenheiten'),
    await archived('Bescheid', 'private/bildungsurlaub/2026'),
    await archived('Teilnahmebescheinigung', 'private/bildungsurlaub/2026'),
    await archived('Teilnahmebescheinigung-Kopie', 'private/bildungsurlaub/2026'),
    await archived('Ticket', 'work/tickets'),
  ];
  const other = await archived('Steuerbescheid', 'private/steuer', 'Steuer');
  return { ids, other };
}

const send = (text: string, conversationId?: string) => app.ok('chat:send', { text, conversationId });

describe('Chat: Ablage prüfen und Dokumente in ein Verzeichnis legen', () => {
  it('antwortet auf „und die Verzeichnisse?“ mit der Verteilung auf die Verzeichnisse, nicht mit Statistik', async () => {
    const { ids } = await scatteredArchive();
    app.llm.on('ChatIntent', () => intent({ intent: 'archive_structure', topic: TOPIC }));

    const r = await send('und die verzeichnisse? ich meine ich hätte für das selbe thema Bildungsurlaub 2026 mehrere verzeichnisse');

    const m = r.assistantMessage;
    expect(m.intent).toBe('archive_structure');
    expect(m.content).toContain(`Die ${ids.length} Dokument(e) zu „${TOPIC}“ liegen in 3 verschiedenen Verzeichnissen`);
    expect(m.content).toContain('**private/bildungsurlaub/2026** (3)');
    expect(m.content).toContain('**work/hr/abwesenheiten** (2)');
    expect(m.content).toContain('**work/tickets** (1)');
    expect(m.content).toContain('„private/bildungsurlaub/2026“ vorschlagen');
    expect(m.content).not.toContain('Archivstatus');
    expect(m.context?.documents).toHaveLength(ids.length);
  });

  it('ohne Thema: nennt die Themen, deren Dokumente verstreut liegen', async () => {
    await scatteredArchive();
    app.llm.on('ChatIntent', () => intent({ intent: 'archive_structure' }));

    const r = await send('sind meine archivierten dateien konsistent?');

    expect(r.assistantMessage.content).toContain(`Thema „${TOPIC}“: 6 Dokumente in 3 Verzeichnissen`);
    expect(r.assistantMessage.content).not.toContain('„Steuer“');
  });

  it('meldet ein sauber abgelegtes Archiv als in Ordnung', async () => {
    await archived('A', 'work/a');
    await archived('B', 'work/a');
    app.llm.on('ChatIntent', () => intent({ intent: 'archive_structure' }));

    const r = await send('ist die ablage konsistent?');

    expect(r.assistantMessage.content).toMatch(/Zu keinem Thema und keinem Projekt liegen Dokumente in verschiedenen Verzeichnissen/);
  });

  it('die Widerspruchsprüfung weist nebenbei auf verstreute Dokumente hin', async () => {
    await scatteredArchive();
    app.llm.on('ChatIntent', () => intent({ intent: 'contradiction_check' }));

    const r = await send('gibt es widersprüche?');

    expect(r.assistantMessage.content).toContain('keine widersprüchlichen Aussagen');
    expect(r.assistantMessage.content).toContain(`Thema „${TOPIC}“ (3 Verzeichnisse)`);
  });

  it('bereitet auf „können die nicht alle ins selbe Verzeichnis?“ einen Vorschlag vor und verschiebt erst nach „ja“', async () => {
    const { ids, other } = await scatteredArchive();
    const before = new Map(ids.map((id) => [id, folderOf(id)]));
    app.llm.on('ChatIntent', (_s, input) => {
      if (/Wie sind die Dokumente abgelegt/.test(input)) return intent({ intent: 'archive_structure', topic: TOPIC });
      if (/selbe verzeichnis/.test(input)) return intent({ intent: 'archive_reorganize' });
      if (/^ja\b/m.test(input.split('Nachricht des Benutzers:\n')[1] ?? '')) return intent({ intent: 'proposal_confirm' });
      return intent({ intent: 'unknown' });
    });

    const first = await send('Wie sind die Dokumente abgelegt?');
    const conv = first.conversationId;
    const proposal = await send('können die nicht alle ins selbe verzeichnis?', conv);

    const action = proposal.assistantMessage.actions[0]!;
    expect(proposal.assistantMessage.intent).toBe('archive_reorganize');
    expect(action).toMatchObject({ actionType: 'relocate_documents', status: 'proposed', requiredConfirmation: 'confirm' });
    expect(action.label).toBe('3 Dokument(e) nach „private/bildungsurlaub/2026“ verschieben');
    expect(proposal.assistantMessage.content).toContain('Vorher ändert sich nichts');
    for (const id of ids) expect(folderOf(id), 'vor der Bestätigung bleibt alles liegen').toBe(before.get(id));

    const done = await send('ja', conv);

    expect(done.assistantMessage.content).toContain('Erledigt: 3 Dokument(e) nach „private/bildungsurlaub/2026“ verschieben');
    for (const id of ids) expect(folderOf(id)).toBe('private/bildungsurlaub/2026');
    expect(folderOf(other), 'fremde Dokumente bleiben unberührt').toBe('private/steuer');
    for (const id of ids) expect(fs.existsSync(path.join(archiveRoot(), app.services.documents.getRow(id).archiveRelPath!))).toBe(true);
  });

  it('nimmt einen genannten Zielordner und ersetzt den früheren offenen Vorschlag', async () => {
    const { ids } = await scatteredArchive();
    app.llm.on('ChatIntent', (_s, input) => {
      const text = input.split('Nachricht des Benutzers:\n')[1] ?? '';
      if (/anderen ordner/.test(text)) return intent({ intent: 'archive_reorganize', topic: TOPIC, path: 'work/hr/bildungsurlaub' });
      return intent({ intent: 'archive_reorganize', topic: TOPIC });
    });

    const first = await send('leg alle in einen ordner');
    const second = await send('nimm einen anderen ordner', first.conversationId);

    const proposed = app.services.actions.list('proposed').filter((a) => a.actionType === 'relocate_documents');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.id).toBe(second.assistantMessage.actions[0]!.id);
    expect(proposed[0]!.label).toBe(`${ids.length} Dokument(e) nach „work/hr/bildungsurlaub“ verschieben`);
    expect(app.services.actions.list('rejected').some((a) => a.id === first.assistantMessage.actions[0]!.id)).toBe(true);
  });

  it('der Benutzer kann den Vorschlag ablehnen: es wird nichts verschoben', async () => {
    const { ids } = await scatteredArchive();
    const before = ids.map(folderOf);
    app.llm.on('ChatIntent', (_s, input) =>
      /nein/.test(input.split('Nachricht des Benutzers:\n')[1] ?? '')
        ? intent({ intent: 'proposal_reject' })
        : intent({ intent: 'archive_reorganize', topic: TOPIC }),
    );

    const first = await send('leg alle in einen ordner');
    await send('nein', first.conversationId);

    expect(ids.map(folderOf)).toEqual(before);
  });

  it('fragt nach, wenn unklar ist, welche Dokumente gemeint sind, und lehnt ungültige Zielordner ab', async () => {
    await scatteredArchive();
    app.llm.on('ChatIntent', () => intent({ intent: 'archive_reorganize' }));
    const unclear = await send('leg alles zusammen');
    expect(unclear.assistantMessage.content).toContain('Welche archivierten Dokumente soll ich zusammenlegen?');
    expect(app.services.actions.list('proposed')).toHaveLength(0);

    app.llm.on('ChatIntent', () => intent({ intent: 'archive_reorganize', topic: TOPIC, path: '../draussen' }));
    const invalid = await send(`leg alle ${TOPIC} nach ../draussen`);
    expect(invalid.assistantMessage.content).toContain('kann ich nicht verwenden');
    expect(app.services.actions.list('proposed')).toHaveLength(0);
  });

  it('sagt, wenn schon alles im selben Verzeichnis liegt', async () => {
    await archived('A', 'work/a');
    await archived('B', 'work/a');
    app.llm.on('ChatIntent', () => intent({ intent: 'archive_reorganize', topic: TOPIC }));

    const r = await send('leg alle in einen ordner');

    expect(r.assistantMessage.content).toContain('liegen schon in „work/a“');
    expect(app.services.actions.list('proposed')).toHaveLength(0);
  });

  it('versteht die Anliegen auch ohne LLM (regelbasierter Fallback)', async () => {
    const rule = (text: string) => app.services.chat.ruleBased(text, {}).intent;

    expect(rule('können die nicht alle ins selbe verzeichnis?')).toBe('archive_reorganize');
    expect(rule('es gibt 6 archivierte bildungsurlaub dateien. die gehören meiner meinung nach alle ins selbe verzeichnis')).toBe('archive_reorganize');
    expect(rule('sind die konsistent?')).toBe('archive_structure');
    expect(rule('und die verzeichnisse?')).toBe('archive_structure');
    expect(rule('wie ist die ablage?')).toBe('archive_structure');
    expect(rule('gibt es widersprüche?')).toBe('contradiction_check');
    expect(rule('wie viele dokumente habe ich?')).toBe('archive_status');
  });

  describe('Archivprüfung („Archivprüfung jetzt starten“)', () => {
    const scattered = () => app.services.insights.list('open').filter((i) => i.kind === 'scattered_documents');

    it('erkennt verstreut abgelegte Dokumente und schlägt einen Ordner vor, ohne etwas zu verschieben', async () => {
      const { ids, other } = await scatteredArchive();
      const before = ids.map(folderOf);

      const report = await app.services.consistency.run('test');

      expect(report.byKind.scattered_documents).toBe(1);
      const [insight] = scattered();
      expect(insight!.title).toBe(`Thema „${TOPIC}“: Dokumente liegen in 3 Verzeichnissen`);
      expect(insight!.explanation).toContain('private/bildungsurlaub/2026 (3)');
      expect(insight!.explanation).toContain('work/hr/abwesenheiten (2)');
      expect(insight!.sourceIds.toSorted()).toEqual(ids.toSorted());
      expect(insight!.sourceIds).not.toContain(other);
      const action = app.services.actions.get(insight!.recommendedActionId!);
      expect(action).toMatchObject({ actionType: 'relocate_documents', status: 'proposed', requiredConfirmation: 'confirm' });
      expect(action.label).toBe(`3 Dokument(e) zu „${TOPIC}“ nach „private/bildungsurlaub/2026“ verschieben`);
      expect(ids.map(folderOf), 'die Prüfung ändert nichts').toEqual(before);
    });

    it('legt bei jedem weiteren Lauf keine Duplikate an', async () => {
      await scatteredArchive();

      await app.services.consistency.run('test');
      await app.services.consistency.run('test');

      expect(scattered()).toHaveLength(1);
      expect(app.services.actions.list('proposed').filter((a) => a.actionType === 'relocate_documents')).toHaveLength(1);
    });

    it('nach Bestätigung des Vorschlags erledigt sich der Hinweis beim nächsten Lauf von selbst', async () => {
      const { ids } = await scatteredArchive();
      await app.services.consistency.run('test');
      const action = app.services.actions.get(scattered()[0]!.recommendedActionId!);

      const done = await app.services.actions.resolve(action.id, 'approve', { confirmed: true });
      await app.services.consistency.run('test');

      expect(done.status).toBe('executed');
      expect(new Set(ids.map(folderOf))).toEqual(new Set(['private/bildungsurlaub/2026']));
      expect(scattered()).toHaveLength(0);
    });

    it('meldet nichts, wenn die Dokumente eines Themas beisammen liegen', async () => {
      await archived('A', 'work/a');
      await archived('B', 'work/a');
      await archived('C', 'work/b', 'Anderes Thema');

      const report = await app.services.consistency.run('test');

      expect(report.byKind.scattered_documents).toBeUndefined();
      expect(scattered()).toHaveLength(0);
    });
  });
});

describe('„Leg alle Dokumente zu X zusammen“ verschiebt genau X (#45)', () => {
  const proposedIds = (r: Awaited<ReturnType<typeof send>>) =>
    ((r.assistantMessage.actions[0]?.proposedParameters as { items?: Array<{ documentId: string }> } | undefined)?.items ?? []).map((i) => i.documentId).sort();

  it('ein genanntes Thema schlägt die zuletzt gezeigten Dokumente (LLM liefert nur query)', async () => {
    const { ids, other } = await scatteredArchive();
    await archived('Steuer-Beleg', 'private/steuer-2', 'Steuer');
    app.llm.on('ChatIntent', (_s, input) => {
      const text = input.split('Nachricht des Benutzers:\n')[1] ?? '';
      if (/Steuer/.test(text)) return intent({ intent: 'archive_structure', topic: 'Steuer' });
      return intent({ intent: 'archive_reorganize', query: 'Bildungsurlaub' });
    });
    const first = await send('Wie liegen die Steuer-Dokumente?');
    expect(first.assistantMessage.context?.documents?.map((d) => d.id)).toContain(other);

    const r = await send('leg alle Bildungsurlaub-Dateien zusammen', first.conversationId);

    const moved = proposedIds(r);
    expect(moved.length).toBeGreaterThan(0);
    for (const id of moved) expect(ids).toContain(id);
    expect(moved).not.toContain(other);
  });

  it('mehrere teilweise passende Themen: fragt nach statt still zu wählen; die Antwort führt das Umlagern aus', async () => {
    await scatteredArchive();
    const old = await archived('Antrag 2025', 'private/bu-2025', 'Bildungsurlaub 2025');
    await archived('Bescheid 2025', 'work/hr/2025', 'Bildungsurlaub 2025');
    app.llm.on('ChatIntent', () => intent({ intent: 'archive_reorganize', topic: 'Bildungsurlaub' }));

    const r1 = await send('leg alle Dokumente zu Bildungsurlaub in einen Ordner');

    expect(r1.assistantMessage.content).toMatch(/^Meinst du „Bildungsurlaub 202[56]“ oder „Bildungsurlaub 202[56]“\?$/);
    expect(r1.assistantMessage.actions).toHaveLength(0);

    app.llm.on('ChatIntent', () => intent({ intent: 'unknown' }));
    const r2 = await send('Bildungsurlaub 2026', r1.conversationId);

    expect(r2.assistantMessage.actions[0]?.label).toBe('3 Dokument(e) nach „private/bildungsurlaub/2026“ verschieben');
    expect(proposedIds(r2)).not.toContain(old);
  });

  it('kein stiller Volltext-Rückfall beim Verschieben: ein fremdes Dokument, das das Wort enthält, bleibt außen vor', async () => {
    const { ids } = await scatteredArchive();
    const gehalt = await archived('Gehaltsabrechnung', 'work/gehalt', 'Gehalt', 'Gehaltsabrechnung Oktober, Abzug Bildungsurlaub 2026');
    app.llm.on('ChatIntent', () => intent({ intent: 'archive_reorganize', topic: 'Bildungsurlaub' }));

    const r = await send('leg alle Bildungsurlaub-Dokumente zusammen');

    const moved = proposedIds(r);
    expect(moved).not.toContain(gehalt);
    for (const id of moved) expect(ids).toContain(id);

    app.llm.on('ChatIntent', () => intent({ intent: 'archive_reorganize', topic: 'Kreuzfahrt' }));
    const none = await send('leg alle Kreuzfahrt-Dokumente zusammen');
    expect(none.assistantMessage.actions).toHaveLength(0);
    expect(none.assistantMessage.content).toContain('Zu „Kreuzfahrt“ kenne ich kein Thema');
  });

  it('ohne LLM: „leg alle Bildungsurlaub-Dateien in einen Ordner“ findet das Thema', async () => {
    const { ids, other } = await scatteredArchive();
    app.llm.down = true;
    const r = await send('leg alle Bildungsurlaub-Dateien in einen Ordner');
    expect(r.assistantMessage.intent).toBe('archive_reorganize');
    const moved = proposedIds(r);
    expect(moved.length).toBe(3);
    for (const id of moved) expect(ids).toContain(id);
    expect(moved).not.toContain(other);
  });

  it('„archivieren“ nutzt Inbox-Dokumente, auch wenn zuletzt archivierte gezeigt wurden', async () => {
    await scatteredArchive();
    app.llm.on('DocumentClassification', () => ({
      docType: 'Rechnung',
      title: 'Neue Rechnung',
      summary: 'Rechnung',
      mainTopic: 'Rechnungen',
      project: null,
      persons: [],
      dates: [],
      tags: [],
      location: { categoryPath: 'private/rechnungen', fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
      decisions: [],
      openItems: [],
      confidence: 0.7,
      rationale: 'x',
    }));
    const imp = await app.ok('documents:import', { paths: [app.file('in/rechnung.txt', 'Rechnung Nr. 1')] });
    await app.services.jobs.whenIdle();
    app.llm.on('ChatIntent', (_s, input) =>
      /archiviere/i.test(input.split('Nachricht des Benutzers:\n')[1] ?? '')
        ? intent({ intent: 'archive_execute' })
        : intent({ intent: 'archive_structure', topic: TOPIC }),
    );
    const first = await send('Wie liegen die Bildungsurlaub-Dokumente?');

    const r = await send('archiviere bitte die neuen Dokumente', first.conversationId);

    expect(r.assistantMessage.actions[0]?.actionType).toBe('archive_documents');
    expect(r.assistantMessage.context?.documents?.map((d) => d.id)).toEqual([imp.imported[0]!.id]);
  });
});

describe('subjectFromText (#45)', () => {
  it.each([
    ['leg alle Bildungsurlaub-Dateien in einen Ordner', 'Bildungsurlaub'],
    ['leg alle Dokumente zu Bildungsurlaub 2026 in einen Ordner', 'Bildungsurlaub 2026'],
    ['können die Unterlagen zum Thema Steuer zusammen?', 'Steuer'],
    ['können die nicht alle ins selbe Verzeichnis?', null],
  ])('%s → %s', (text, expected) => {
    expect(subjectFromText(text)).toBe(expected);
  });
});
