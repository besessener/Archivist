import path from 'node:path';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fillPattern } from '../../packages/core/src/services/rename-pattern';
import { SECTION_CHARS, locate } from '../../packages/core/src/agent/tools/read';
import type { TestApp } from '../helpers/harness';
import { agentApp, archived, folderOf, scriptedTurns, sentText } from '../helpers/agent';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

const lastOutput = () =>
  ((app.llm.agentRequests.at(-1)?.input as Array<{ type?: string; output?: string }>) ?? []).filter((i) => i.type === 'function_call_output').at(-1)?.output ??
  '';
const fileName = (id: string) => path.posix.basename(app.services.documents.getRow(id).archiveRelPath!);

describe('File and folder tools (#304)', () => {
  it('renames by pattern: preview first with conflicts, then executes without overwriting; undo restores the names', async () => {
    const a = await archived(app, {
      name: 'scan001.txt',
      content: 'Rechnung A',
      folder: 'work/misc',
      docType: 'Rechnung',
      documentDate: '2026-03-01',
      persons: ['Müller'],
    });
    const b = await archived(app, {
      name: 'scan002.txt',
      content: 'Rechnung B',
      folder: 'work/misc',
      docType: 'Rechnung',
      documentDate: '2026-03-01',
      persons: ['Müller'],
    });
    await app.ok('documents:bulkUpdate', { ids: [a, b], docType: 'Rechnung', documentDate: '2026-03-01', addPersons: ['Müller'], confirmed: true });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'scan' } }] },
      { calls: [{ name: 'rename_documents', args: { documents: ['S1'], pattern: '{datum} {typ} {absender}' } }] },
      () => {
        expect(lastOutput()).toContain('Vorschau');
        expect(lastOutput()).toContain('Konflikt');
        return { calls: [{ name: 'rename_documents', args: { documents: ['D1'], pattern: '{datum} {typ} {absender}', preview: false } }] };
      },
      { text: 'Umbenannt.' },
    );
    const res = await app.ok('chat:send', { text: 'Benenne die Scans nach Datum, Typ und Absender um' });
    const names = [fileName(a), fileName(b)];
    expect(names).toContain('2026-03-01 Rechnung Müller.txt');
    expect(names.filter((n) => n.startsWith('2026-03-01'))).toHaveLength(1);
    await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    expect([fileName(a), fileName(b)].sort()).toEqual(['scan001.txt', 'scan002.txt']);
  });

  it('refuses hash- and UUID-like names', async () => {
    const a = await archived(app, { name: 'x.txt', content: 'X', folder: 'work/misc' });
    const plan = await app.services.archive.previewRename([{ documentId: a, fileName: '8f14e45fceea167a5a36dedd4bea2543' }]);
    expect(plan[0]!.conflicts[0]).toMatch(/kein sprechender Name/);
  });

  it('fills the naming scheme and trims separators of empty placeholders', () => {
    const d = {
      documentDate: '2026-01-05',
      archivedAt: null,
      createdAt: '2026-01-06',
      docType: null,
      persons: [],
      title: 'T',
      topicName: null,
      projectName: null,
      originalName: 'o.pdf',
    };
    expect(fillPattern('{datum} - {typ} - {absender}', d)).toBe('2026-01-05');
    expect(fillPattern('{jahr}_{titel}', d)).toBe('2026_T');
  });

  it('folders: create, merge one folder into another with structure, remove empty ones; upper/lower case of existing folders is kept (#244)', async () => {
    const a = await archived(app, { name: 'a.txt', content: 'A', folder: 'work/Projekte/alt' });
    const b = await archived(app, { name: 'b.txt', content: 'B', folder: 'work/Projekte/alt/2025' });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'rename_folder', args: { from: 'work/projekte/alt', to: 'work/projekte/archiv' } }] },
      { calls: [{ name: 'create_folder', args: { path: 'WORK/neu' } }] },
      { text: 'Fertig.' },
    );
    await app.ok('chat:send', { text: 'Leg den Ordner alt nach archiv um und leg work/neu an' });
    expect(folderOf(app, a)).toBe('work/Projekte/archiv');
    expect(folderOf(app, b)).toBe('work/Projekte/archiv/2025');
    expect(app.services.categories.list().some((c) => c.path === 'work/neu')).toBe(true);
    expect(app.services.categories.list().some((c) => c.path === 'work/Projekte/alt')).toBe(false);
  });

  it('path limits: traversal and absolute paths are refused', async () => {
    const a = await archived(app, { name: 'a.txt', content: 'A', folder: 'work/misc' });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'a' } }] },
      () => ({ calls: [{ name: 'move_documents', args: { documents: ['D1'], folder: '../../etc' } }] }),
      () => {
        expect(lastOutput()).toMatch(/Ungültig|relativ|nicht erlaubt|Fehler/i);
        return { calls: [{ name: 'create_folder', args: { path: '/tmp/evil' } }] };
      },
      { text: 'Nicht möglich.' },
    );
    await app.ok('chat:send', { text: 'Finde a.txt und verschiebe sie nach ../../etc' });
    expect(folderOf(app, a)).toBe('work/misc');
    expect(fs.existsSync('/tmp/evil')).toBe(false);
  });
});

describe('Search hits with section and page (#303)', () => {
  it('locates a passage in the document text', () => {
    const text = `${'a'.repeat(SECTION_CHARS + 10)}\fSeite zwei mit dem Fundstück hier`;
    expect(locate(text, 'Seite zwei mit dem Fundstück')).toBe(' (Abschnitt 2, Seite 2)');
    expect(locate('kurz', 'nicht enthalten')).toBe('');
  });
});

describe('Metadata tools (#305, #291)', () => {
  it('bulk assignment of topic, project, tags and persons is ONE undo step; „ich“ resolves to the user', async () => {
    app.services.settings.update({ profile: { name: 'Erika Muster' } });
    app.services.self.ensure();
    const ids = [
      await archived(app, { name: 'beleg1.txt', content: 'Autokauf Beleg', folder: 'private/auto' }),
      await archived(app, { name: 'beleg2.txt', content: 'Autokauf Beleg 2', folder: 'private/auto' }),
    ];
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'beleg' } }] },
      { calls: [{ name: 'set_metadata', args: { targets: ['S1'], project: 'Auto', addTags: ['Autokauf'], addPersons: ['ich'] } }] },
      { text: 'Zugeordnet.' },
    );
    const res = await app.ok('chat:send', { text: 'Ordne alle Belege vom Autokauf dem Projekt Auto zu, Käufer bin ich' });
    for (const id of ids) {
      const d = await app.ok('documents:get', { id });
      expect(d.projectName).toBe('Auto');
      expect(d.tags).toContain('Autokauf');
      expect(d.persons).toContain('Erika Muster');
    }
    const run = await app.ok('agent:run', { id: res.assistantMessage.runId! });
    expect(run.undoable).toBe(1);
    await app.ok('agent:undoRun', { runId: run.id });
    for (const id of ids) expect((await app.ok('documents:get', { id })).projectName).toBeNull();
  });

  it('entries other than documents get title, persons and date too', async () => {
    await app.ok('decisions:create', {
      decisionText: 'Wir kaufen ein Lastenrad',
      title: 'Lastenrad',
      topic: 'Mobilität',
      decidedAt: '2026-01-15',
      participants: ['Anna'],
      alternatives: [],
      unknownFields: [],
      sourceIds: [],
      confidence: 0.9,
    });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'list_entries', args: { kind: 'decision' } }] },
      {
        calls: [
          {
            name: 'set_metadata',
            args: { targets: ['K1'], title: 'Lastenrad kaufen', documentDate: '2026-01-10', addPersons: ['Ben'], removePersons: ['Anna'] },
          },
        ],
      },
      { text: 'Korrigiert.' },
    );
    await app.ok('chat:send', { text: 'Die Lastenrad-Entscheidung war am 10.1., mit Ben statt Anna, Titel „Lastenrad kaufen“' });
    const d = (await app.ok('decisions:list', {}))[0]!;
    expect(d.title).toBe('Lastenrad kaufen');
    expect(d.decidedAt?.slice(0, 10)).toBe('2026-01-10');
    expect(d.participants).toEqual(['Ben']);
  });

  it('unclear persons are asked about, not guessed', async () => {
    await app.ok('knowledge:createEntity', { type: 'person', name: 'Anna Schmidt' });
    await app.ok('knowledge:createEntity', { type: 'person', name: 'Anna Meier' });
    const id = await archived(app, { name: 'brief.txt', content: 'Brief', folder: 'private/post' });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'brief' } }] },
      { calls: [{ name: 'set_metadata', args: { targets: ['D1'], addPersons: ['Anna'] } }] },
      { text: '?' },
    );
    await app.ok('chat:send', { text: 'Ordne den Brief Anna zu' });
    expect(lastOutput()).toContain('Unklare Person');
    expect(lastOutput()).toContain('Anna Schmidt');
    expect(lastOutput()).toContain('Anna Meier');
    expect((await app.ok('documents:get', { id })).persons).toEqual([]);
  });

  it('re-analysis: archived documents are read again in ONE job and keep their assignments (#220)', async () => {
    const id = await archived(app, { name: 'scan.txt', content: 'alter Text', folder: 'private/post', topic: 'Post' });
    const file = app.services.documents.get(id).archivePath!;
    fs.writeFileSync(file, 'neuer Text nach besserer Texterkennung');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'scan' } }] },
      { calls: [{ name: 'reanalyze', args: { documents: ['S1'] } }] },
      { text: 'Läuft.' },
    );
    const before = app.services.jobs.list(500).length;
    await app.ok('chat:send', { text: 'Lies scan.txt bitte neu ein' });
    expect(lastOutput()).toContain('neu gelesen');
    await app.services.jobs.whenIdle();
    const jobs = app.services.jobs.list(500);
    expect(jobs.length - before).toBe(1);
    expect(jobs.find((j) => j.type === 'documents.reread')?.status).toBe('succeeded');
    const row = app.services.documents.getRow(id);
    expect(row.extractedText).toContain('besserer Texterkennung');
    expect(row.status).toBe('archived');
    expect((await app.ok('documents:get', { id })).topicName).toBe('Post');
  });

  it('privacy exclusion per document is critical: always a proposal', async () => {
    const id = await archived(app, { name: 'pw.txt', content: 'Passwort', folder: 'private/misc' });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'pw' } }] },
      { calls: [{ name: 'exclude_from_llm', args: { documents: ['D1'] } }] },
      { text: 'Bitte bestätigen.' },
    );
    const res = await app.ok('chat:send', { text: 'Schließ pw.txt von der KI-Analyse aus' });
    expect((await app.ok('documents:get', { id })).llmStatus).not.toBe('excluded');
    expect(res.assistantMessage.actions.some((a) => a.actionType === 'agent_batch')).toBe(true);
  });
});

describe('Links and cases (#306, #277, #286)', () => {
  it('explicit request → confirmed (origin agent, run id); own accord → proposed; rejected pairs are never proposed again', async () => {
    const vertrag = await archived(app, { name: 'mietvertrag.txt', content: 'Mietvertrag', folder: 'private/wohnen' });
    const nebenkosten = await archived(app, { name: 'nebenkosten.txt', content: 'Nebenkosten', folder: 'private/wohnen' });
    const other = await archived(app, { name: 'urlaub.txt', content: 'Urlaub', folder: 'private/urlaub' });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: {} }] },
      {
        calls: [
          { name: 'link', args: { a: 'D3', b: 'D1', onUserRequest: true } },
          { name: 'link', args: { a: 'D2', b: 'D1', onUserRequest: false } },
        ],
      },
      { text: 'Verknüpft.' },
    );
    const res = await app.ok('chat:send', { text: 'Verknüpf die Nebenkosten mit dem Mietvertrag' });
    const rel = (a: string, b: string) => app.services.graph.relationsOf(a).find((r) => r.sourceEntityId === b || r.targetEntityId === b);
    const refs = res.assistantMessage.runId!;
    const run = await app.ok('agent:run', { id: refs });
    expect(run.steps.filter((s) => s.tool === 'link')).toHaveLength(2);
    // D-refs follow the date order of find_documents; resolve which document got which status
    const statuses = [rel(vertrag, nebenkosten), rel(vertrag, other), rel(nebenkosten, other)]
      .filter(Boolean)
      .map((r) => r!.status)
      .sort();
    expect(statuses).toEqual(['confirmed', 'proposed']);
    const confirmed = [rel(vertrag, nebenkosten), rel(vertrag, other), rel(nebenkosten, other)].find((r) => r?.status === 'confirmed')!;
    expect(confirmed.origin).toBe('agent');
    expect(confirmed.runId).toBe(run.id);
    // the user rejects the proposal → the agent may not propose it again
    const proposed = [rel(vertrag, nebenkosten), rel(vertrag, other), rel(nebenkosten, other)].find((r) => r?.status === 'proposed')!;
    await app.ok('knowledge:resolveRelation', { relationId: proposed.id, status: 'rejected', confirmed: true });
    expect(() => app.services.graph.linkEntries(proposed.sourceEntityId, proposed.targetEntityId, 'relates_to', { status: 'proposed' })).toThrow(/abgelehnt/);
  });

  it('cases: create with entries, add more, close and undo the closing', async () => {
    const a = await archived(app, { name: 'kaufvertrag.txt', content: 'Kaufvertrag Auto', folder: 'private/auto' });
    const b = await archived(app, { name: 'versicherung.txt', content: 'Versicherung Auto', folder: 'private/auto' });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'kaufvertrag' } }] },
      { calls: [{ name: 'create_case', args: { name: 'Autokauf 2026', entries: ['D1'] } }] },
      { calls: [{ name: 'find_documents', args: { name: 'versicherung' } }] },
      { calls: [{ name: 'add_to_case', args: { case: 'K1', entries: ['D2'] } }] },
      { calls: [{ name: 'close_case', args: { case: 'K1' } }] },
      { text: 'Vorgang angelegt und abgeschlossen.' },
    );
    const res = await app.ok('chat:send', { text: 'Leg alles zum Autokauf in einen Vorgang und schließ ihn ab' });
    const c = app.services.graph.listEntities({ type: 'case' })[0]!;
    expect(c.name).toBe('Autokauf 2026');
    expect(c.status).toBe('closed');
    expect(
      app.services.graph
        .neighbors(c.id)
        .map((e) => e.id)
        .sort(),
    ).toEqual([a, b].sort());
    await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    expect(app.services.graph.listEntities({ type: 'case' })).toHaveLength(0);
  });

  it('related entries come with a reason (#276)', async () => {
    const a = await archived(app, { name: 'a.txt', content: 'A', folder: 'private/x', topic: 'Wohnung' });
    const b = await archived(app, { name: 'b.txt', content: 'B', folder: 'private/x', topic: 'Wohnung' });
    const rel = await app.ok('knowledge:related', { id: a });
    expect(rel.items.find((r) => r.entity.id === b)?.reason).toBe('gleiches Thema „Wohnung“');
  });
});

describe('Settings per chat (#312)', () => {
  it('„Stell den Agenten auf Fragen“ changes the setting (undoable); privacy settings always ask', async () => {
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'set_setting', args: { key: 'agent.mode', value: 'ask' } }] },
      { calls: [{ name: 'set_setting', args: { key: 'privacy.llmMode', value: 'local_only' } }] },
      { text: 'Erledigt bzw. zur Bestätigung vorbereitet.' },
    );
    const res = await app.ok('chat:send', { text: 'Stell den Agenten auf Fragen und den Datenschutz auf nur lokal' });
    expect(app.services.settings.get().agent.mode).toBe('ask');
    expect(app.services.settings.get().privacy.llmMode).toBe('auto');
    expect(res.assistantMessage.actions.some((a) => a.actionType === 'agent_batch')).toBe(true);
    await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    expect(app.services.settings.get().agent.mode).toBe('auto');
  });

  it('the document list renames a multi-selection by the same scheme: preview with conflicts, then rename (#304)', async () => {
    const a = await archived(app, {
      name: 'scan010.txt',
      content: 'Rechnung A',
      folder: 'work/misc',
      docType: 'Rechnung',
      documentDate: '2026-03-01',
      persons: ['Müller'],
    });
    const b = await archived(app, {
      name: 'scan011.txt',
      content: 'Rechnung B',
      folder: 'work/misc',
      docType: 'Rechnung',
      documentDate: '2026-03-01',
      persons: ['Müller'],
    });
    await app.ok('documents:bulkUpdate', { ids: [a, b], docType: 'Rechnung', documentDate: '2026-03-01', addPersons: ['Müller'], confirmed: true });
    const preview = await app.ok('documents:previewRename', { ids: [a, b], pattern: '{datum} {typ} {absender}' });
    expect(preview.map((p) => p.to?.split('/').at(-1))).toEqual(['2026-03-01 Rechnung Müller.txt', '2026-03-01 Rechnung Müller.txt']);
    expect(preview[1]!.conflicts.length).toBeGreaterThan(0);
    expect(fileName(a)).toBe('scan010.txt');
    const res = await app.ok('documents:rename', { ids: [a, b], pattern: '{datum} {typ} {absender}', confirmed: true });
    expect(res.success).toBe(1);
    expect(res.conflicts).toBe(1);
    expect(fileName(a)).toBe('2026-03-01 Rechnung Müller.txt');
    expect(fileName(b)).toBe('scan011.txt');
    expect((await app.call('documents:rename', { ids: [a], pattern: '{titel}', confirmed: false as never })).ok).toBe(false);
  });

  it('scan exclusions can be set, lifted and undone – only inside the released scan folders', async () => {
    const dl = path.join(app.home, 'Downloads');
    fs.mkdirSync(path.join(dl, 'privat'), { recursive: true });
    await app.ok('scanner:addDirectory', { path: dl, recursive: true });
    const inside = path.join(fs.realpathSync(dl), 'privat');
    app.llm.agent = scriptedTurns(
      {
        calls: [
          { name: 'exclude_from_scan', args: { path: path.join(app.home, 'Dokumente') } },
          { name: 'exclude_from_scan', args: { path: inside } },
        ],
      },
      { text: 'ok' },
    );
    const res = await app.ok('chat:send', { text: 'Schließ Downloads/privat und Dokumente vom Scan aus' });
    expect(sentText(app)).toContain('liegt in keinem freigegebenen Scan-Ordner');
    expect((await app.ok('scanner:listExclusions', {})).map((e) => e.path)).toEqual([inside]);
    await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    expect(await app.ok('scanner:listExclusions', {})).toHaveLength(0);

    await app.ok('scanner:exclude', { kind: 'dir', path: inside });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'exclude_from_scan', args: { path: inside, remove: true } }] }, { text: 'ok' });
    const lifted = await app.ok('chat:send', { text: 'Nimm den Ausschluss für privat wieder raus' });
    expect(await app.ok('scanner:listExclusions', {})).toHaveLength(0);
    await app.ok('agent:undoRun', { runId: lifted.assistantMessage.runId! });
    expect((await app.ok('scanner:listExclusions', {})).map((e) => e.path)).toEqual([inside]);
  });

  it('created folders and removed empty folders can be undone', async () => {
    await archived(app, { name: 'a.md', content: 'A', folder: 'work/misc' });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'create_folder', args: { path: 'work/neu/tief' } }] }, { text: 'ok' });
    const res = await app.ok('chat:send', { text: 'Leg work/neu/tief an' });
    const paths = async () => (await app.ok('categories:list', {})).map((c) => c.path);
    expect(await paths()).toEqual(expect.arrayContaining(['work/neu', 'work/neu/tief']));
    await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    expect(await paths()).not.toContain('work/neu');
    expect(await paths()).toContain('work/misc');

    await app.ok('categories:create', { path: 'work/leer', confirmed: true });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'remove_empty_folders', args: {} }] }, { text: 'ok' });
    const removed = await app.ok('chat:send', { text: 'Räum leere Ordner auf' });
    expect(await paths()).not.toContain('work/leer');
    await app.ok('agent:undoRun', { runId: removed.assistantMessage.runId! });
    expect(await paths()).toContain('work/leer');
  });
});
