import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { subjectFromText } from '../../packages/core/src/services/chat/subjects';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';
import { intent, userText } from '../helpers/chat-intents';

const TOPIC = 'Bildungsurlaub 2026';

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
  app.llm.on('DocumentClassification', () => classification({ title: name, summary: `Zusammenfassung ${name}`, categoryPath: loc, mainTopic: topic }));
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

/** Six Bildungsurlaub documents in four directories, plus one unrelated document. */
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

describe('Chat: checking the filing and putting documents into one directory', () => {
  it('answers „und die Verzeichnisse?“ with the distribution across the directories, not with statistics', async () => {
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

  it('without a topic: names the topics whose documents are scattered', async () => {
    await scatteredArchive();
    app.llm.on('ChatIntent', () => intent({ intent: 'archive_structure' }));

    const r = await send('sind meine archivierten dateien konsistent?');

    expect(r.assistantMessage.content).toContain(`Thema „${TOPIC}“: 6 Dokumente in 3 Verzeichnissen`);
    expect(r.assistantMessage.content).not.toContain('„Steuer“');
  });

  it('reports a cleanly filed archive as fine', async () => {
    await archived('A', 'work/a');
    await archived('B', 'work/a');
    app.llm.on('ChatIntent', () => intent({ intent: 'archive_structure' }));

    const r = await send('ist die ablage konsistent?');

    expect(r.assistantMessage.content).toMatch(/Zu keinem Thema und keinem Projekt liegen Dokumente in verschiedenen Verzeichnissen/);
  });

  it('the contradiction check also points out scattered documents', async () => {
    await scatteredArchive();
    app.llm.on('ChatIntent', () => intent({ intent: 'contradiction_check' }));

    const r = await send('gibt es widersprüche?');

    expect(r.assistantMessage.content).toContain('keine widersprüchlichen Aussagen');
    expect(r.assistantMessage.content).toContain(`Thema „${TOPIC}“ (3 Verzeichnisse)`);
  });

  it('prepares a proposal for „können die nicht alle ins selbe Verzeichnis?“ and moves only after „ja“', async () => {
    const { ids, other } = await scatteredArchive();
    const before = new Map(ids.map((id) => [id, folderOf(id)]));
    app.llm.on('ChatIntent', (_s, input) => {
      if (/Wie sind die Dokumente abgelegt/.test(input)) return intent({ intent: 'archive_structure', topic: TOPIC });
      if (/selbe verzeichnis/.test(input)) return intent({ intent: 'archive_reorganize' });
      if (/^ja\b/m.test(userText(input))) return intent({ intent: 'proposal_confirm' });
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
    for (const id of ids) expect(folderOf(id), 'everything stays in place before the confirmation').toBe(before.get(id));

    const done = await send('ja', conv);

    expect(done.assistantMessage.content).toContain('Erledigt: 3 Dokument(e) nach „private/bildungsurlaub/2026“ verschieben');
    for (const id of ids) expect(folderOf(id)).toBe('private/bildungsurlaub/2026');
    expect(folderOf(other), 'unrelated documents stay untouched').toBe('private/steuer');
    for (const id of ids) expect(fs.existsSync(path.join(archiveRoot(), app.services.documents.getRow(id).archiveRelPath!))).toBe(true);
  });

  it('takes a named target folder and replaces the earlier open proposal', async () => {
    const { ids } = await scatteredArchive();
    app.llm.on('ChatIntent', (_s, input) => {
      const text = userText(input);
      if (/anderen ordner/.test(text)) return intent({ intent: 'archive_reorganize', topic: TOPIC, path: 'work/hr/bildungsurlaub' });
      return intent({ intent: 'archive_reorganize', topic: TOPIC });
    });

    const first = await send('leg alle in einen ordner');
    const second = await send('nimm einen anderen ordner', first.conversationId);

    const proposed = app.services.actions.list('proposed').filter((a) => a.actionType === 'relocate_documents');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.id).toBe(second.assistantMessage.actions[0]!.id);
    expect(proposed[0]!.label).toBe(`${ids.length} Dokument(e) nach „work/hr/bildungsurlaub“ verschieben`);
    expect(app.services.actions.list('withdrawn').some((a) => a.id === first.assistantMessage.actions[0]!.id)).toBe(true);
  });

  it('the user can reject the proposal: nothing is moved', async () => {
    const { ids } = await scatteredArchive();
    const before = ids.map(folderOf);
    app.llm.on('ChatIntent', (_s, input) =>
      /nein/.test(userText(input)) ? intent({ intent: 'proposal_reject' }) : intent({ intent: 'archive_reorganize', topic: TOPIC }),
    );

    const first = await send('leg alle in einen ordner');
    await send('nein', first.conversationId);

    expect(ids.map(folderOf)).toEqual(before);
  });

  it('asks back when it is unclear which documents are meant, and rejects invalid target folders', async () => {
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

  it('says so when everything is already in the same directory', async () => {
    await archived('A', 'work/a');
    await archived('B', 'work/a');
    app.llm.on('ChatIntent', () => intent({ intent: 'archive_reorganize', topic: TOPIC }));

    const r = await send('leg alle in einen ordner');

    expect(r.assistantMessage.content).toContain('liegen schon in „work/a“');
    expect(app.services.actions.list('proposed')).toHaveLength(0);
  });

  it('understands the requests without an LLM too (rule-based fallback)', async () => {
    const rule = (text: string) => app.services.chat.ruleBased(text, {}).intent;

    expect(rule('können die nicht alle ins selbe verzeichnis?')).toBe('archive_reorganize');
    expect(rule('es gibt 6 archivierte bildungsurlaub dateien. die gehören meiner meinung nach alle ins selbe verzeichnis')).toBe('archive_reorganize');
    expect(rule('sind die konsistent?')).toBe('archive_structure');
    expect(rule('und die verzeichnisse?')).toBe('archive_structure');
    expect(rule('wie ist die ablage?')).toBe('archive_structure');
    expect(rule('gibt es widersprüche?')).toBe('contradiction_check');
    expect(rule('wie viele dokumente habe ich?')).toBe('archive_status');
  });

  describe('Archive check („Archivprüfung jetzt starten“)', () => {
    const scattered = () => app.services.insights.list('open').filter((i) => i.kind === 'scattered_documents');

    it('detects scattered documents and proposes a folder without moving anything', async () => {
      const { ids, other } = await scatteredArchive();
      const before = ids.map(folderOf);

      const report = await app.services.consistency.run({ trigger: 'test' });

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
      expect(ids.map(folderOf), 'the check changes nothing').toEqual(before);
    });

    it('creates no duplicates on further runs', async () => {
      await scatteredArchive();

      await app.services.consistency.run({ trigger: 'test' });
      await app.services.consistency.run({ trigger: 'test' });

      expect(scattered()).toHaveLength(1);
      expect(app.services.actions.list('proposed').filter((a) => a.actionType === 'relocate_documents')).toHaveLength(1);
    });

    it('after the proposal is confirmed, the hint resolves itself on the next run', async () => {
      const { ids } = await scatteredArchive();
      await app.services.consistency.run({ trigger: 'test' });
      const action = app.services.actions.get(scattered()[0]!.recommendedActionId!);

      const done = await app.services.actions.resolve(action.id, { decision: 'approve', confirmed: true });
      await app.services.consistency.run({ trigger: 'test' });

      expect(done.status).toBe('executed');
      expect(new Set(ids.map(folderOf))).toEqual(new Set(['private/bildungsurlaub/2026']));
      expect(scattered()).toHaveLength(0);
    });

    it('reports nothing when the documents of a topic are together', async () => {
      await archived('A', 'work/a');
      await archived('B', 'work/a');
      await archived('C', 'work/b', 'Anderes Thema');

      const report = await app.services.consistency.run({ trigger: 'test' });

      expect(report.byKind.scattered_documents).toBeUndefined();
      expect(scattered()).toHaveLength(0);
    });
  });
});

describe('„Leg alle Dokumente zu X zusammen“ moves exactly X (#45)', () => {
  const proposedIds = (r: Awaited<ReturnType<typeof send>>) =>
    ((r.assistantMessage.actions[0]?.proposedParameters as { items?: Array<{ documentId: string }> } | undefined)?.items ?? []).map((i) => i.documentId).sort();

  it('a named topic beats the most recently shown documents (LLM only returns query)', async () => {
    const { ids, other } = await scatteredArchive();
    await archived('Steuer-Beleg', 'private/steuer-2', 'Steuer');
    app.llm.on('ChatIntent', (_s, input) => {
      const text = userText(input);
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

  it('several partially matching topics: asks back instead of silently choosing; the answer performs the relocation', async () => {
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

  it('no silent full-text fallback when moving: an unrelated document containing the word stays out', async () => {
    const { ids } = await scatteredArchive();
    const payslip = await archived('Gehaltsabrechnung', 'work/gehalt', 'Gehalt', 'Gehaltsabrechnung Oktober, Abzug Bildungsurlaub 2026');
    app.llm.on('ChatIntent', () => intent({ intent: 'archive_reorganize', topic: 'Bildungsurlaub' }));

    const r = await send('leg alle Bildungsurlaub-Dokumente zusammen');

    const moved = proposedIds(r);
    expect(moved).not.toContain(payslip);
    for (const id of moved) expect(ids).toContain(id);

    app.llm.on('ChatIntent', () => intent({ intent: 'archive_reorganize', topic: 'Kreuzfahrt' }));
    const none = await send('leg alle Kreuzfahrt-Dokumente zusammen');
    expect(none.assistantMessage.actions).toHaveLength(0);
    expect(none.assistantMessage.content).toContain('Zu „Kreuzfahrt“ kenne ich kein Thema');
  });

  it('without an LLM: „leg alle Bildungsurlaub-Dateien in einen Ordner“ finds the topic', async () => {
    const { ids, other } = await scatteredArchive();
    app.llm.down = true;
    const r = await send('leg alle Bildungsurlaub-Dateien in einen Ordner');
    expect(r.assistantMessage.intent).toBe('archive_reorganize');
    const moved = proposedIds(r);
    expect(moved.length).toBe(3);
    for (const id of moved) expect(ids).toContain(id);
    expect(moved).not.toContain(other);
  });

  it('„archivieren“ uses inbox documents even when recently archived ones were shown', async () => {
    await scatteredArchive();
    app.llm.on('DocumentClassification', () =>
      classification({ title: 'Neue Rechnung', summary: 'Rechnung', categoryPath: 'private/rechnungen', docType: 'Rechnung', mainTopic: 'Rechnungen' }),
    );
    const imp = await app.ok('documents:import', { paths: [app.file('in/rechnung.txt', 'Rechnung Nr. 1')] });
    await app.services.jobs.whenIdle();
    app.llm.on('ChatIntent', (_s, input) =>
      /archiviere/i.test(userText(input)) ? intent({ intent: 'archive_execute' }) : intent({ intent: 'archive_structure', topic: TOPIC }),
    );
    const first = await send('Wie liegen die Bildungsurlaub-Dokumente?');

    const r = await send('archiviere bitte die neuen Dokumente', first.conversationId);

    expect(r.assistantMessage.actions[0]?.actionType).toBe('archive_documents');
    expect(r.assistantMessage.context?.documents?.map((d) => d.id)).toEqual([imp.imported[0]!.id]);
    // source path and final file name are in the message and on the card (#189)
    const line = /• Neue Rechnung: (.+) → (.+)/.exec(r.assistantMessage.content);
    expect(line?.[1]).toMatch(/in[\\/]rechnung\.txt$/);
    expect(line?.[2]).toBe('private/rechnungen/rechnung.txt');
    expect(r.assistantMessage.actions[0]?.rationale).toContain('private/rechnungen/rechnung.txt');
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
