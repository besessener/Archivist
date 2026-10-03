import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentApp, folderOf, lastToolOutput, scriptedTurns } from '../helpers/agent';
import { archiveFile, setExtractedText, uniqueImage } from '../helpers/agent-tools';
import type { TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => {
  await app.cleanup();
});

/** Text of the tool results the model got so far in the current request. */
const outputsIn = (body: Record<string, unknown>) =>
  ((body.input as Array<{ type?: string; output?: string }>) ?? []).filter((i) => i.type === 'function_call_output').map((i) => i.output ?? '');
const firstMatch = (body: Record<string, unknown>, pattern: RegExp) => {
  const hit = outputsIn(body).join('\n').match(pattern);
  if (!hit) throw new Error(`no ${pattern} in the tool results`);
  return hit;
};

const mail = (subject: string, date: string, headers: string[]) =>
  [
    'From: a@example.test',
    'To: b@example.test',
    `Subject: ${subject}`,
    `Date: ${date}`,
    ...headers,
    'Content-Type: text/plain',
    '',
    `Text zu ${subject}`,
    '',
  ].join('\n');

async function archiveThread(): Promise<[string, string, string, string]> {
  const eml = { docType: 'E-Mail', loc: 'private/post' };
  return [
    await archiveFile(app, {
      ...eml,
      name: 'm1.eml',
      date: '2026-03-02',
      content: mail('Angebot Küche', 'Mon, 02 Mar 2026 10:00:00 +0000', ['Message-ID: <k1@x.test>']),
    }),
    await archiveFile(app, {
      ...eml,
      name: 'm2.eml',
      date: '2026-03-03',
      content: mail('AW: Angebot Küche', 'Tue, 03 Mar 2026 10:00:00 +0000', ['Message-ID: <k2@x.test>', 'In-Reply-To: <k1@x.test>']),
    }),
    await archiveFile(app, {
      ...eml,
      name: 'm3.eml',
      date: '2026-03-04',
      content: mail('AW: AW: Angebot Küche', 'Wed, 04 Mar 2026 10:00:00 +0000', ['Message-ID: <k3@x.test>', 'In-Reply-To: <k2@x.test>']),
    }),
    await archiveFile(app, {
      ...eml,
      name: 'andere.eml',
      date: '2026-03-05',
      content: mail('Angebot Küche', 'Thu, 05 Mar 2026 10:00:00 +0000', ['Message-ID: <z9@x.test>']),
    }),
  ];
}

const relatedTo = (id: string) =>
  app.services.graph
    .relationsOf(id)
    .filter((r) => r.status === 'confirmed' && r.relationType === 'relates_to')
    .map((r) => (r.sourceEntityId === id ? r.targetEntityId : r.sourceEntityId));

describe('file_mail_thread (#312)', () => {
  it('links the mails of a thread and moves them into one folder; undoing the run reverts both', async () => {
    const [first, second, third, unrelated] = await archiveThread();
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'email_threads', args: {} }] },
      ({ body }) => ({
        calls: [{ name: 'file_mail_thread', args: { documents: [firstMatch(body, /Ergebnismenge (S\d+)/)[1]], folder: 'private/post/angebot-kueche' } }],
      }),
      { text: 'Der Verlauf liegt jetzt zusammen.' },
    );

    const res = await app.ok('chat:send', { text: 'Leg den Verlauf zum Angebot Küche zusammen ab' });

    expect(res.assistantMessage.content).toContain('zusammen');
    for (const id of [first, second, third]) expect(folderOf(app, id)).toBe('private/post/angebot-kueche');
    expect(folderOf(app, unrelated)).toBe('private/post');
    expect(relatedTo(first).toSorted()).toEqual([second, third].toSorted());
    expect(relatedTo(unrelated)).toEqual([]);
    const run = await app.ok('agent:run', { id: res.assistantMessage.runId! });
    expect(run.steps.map((s) => s.tool)).toEqual(['email_threads', 'file_mail_thread']);
    expect(run.steps[1]!.auditIds?.length).toBe(4);

    const undo = await app.ok('agent:undoRun', { runId: run.id });
    expect(undo.undone).toBe(4);
    for (const id of [first, second, third]) expect(folderOf(app, id)).toBe('private/post');
    expect(relatedTo(first)).toEqual([]);
  });

  it('a new main category always asks first and moves nothing before the confirmation', async () => {
    const [first, second] = await archiveThread();
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'email_threads', args: {} }] },
      ({ body }) => ({
        calls: [{ name: 'file_mail_thread', args: { documents: [firstMatch(body, /Ergebnismenge (S\d+)/)[1]], folder: 'verlaeufe/angebot' } }],
      }),
      { text: 'Bitte bestätigen.' },
    );

    const res = await app.ok('chat:send', { text: 'Leg den Verlauf in verlaeufe/angebot ab' });

    expect(folderOf(app, first)).toBe('private/post');
    expect(relatedTo(first)).toEqual([]);
    const card = res.assistantMessage.actions.find((a) => a.actionType === 'agent_batch')!;
    expect(card).toBeTruthy();
    await app.ok('actions:resolve', { decision: 'approve', actionId: card.id, confirmed: true });
    expect(folderOf(app, first)).toBe('verlaeufe/angebot');
    expect(folderOf(app, second)).toBe('verlaeufe/angebot');
    expect(relatedTo(first)).toHaveLength(2);
  });

  it('refuses a single mail', async () => {
    const [first] = await archiveThread();
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { ext: ['eml'] } }] },
      () => ({ calls: [{ name: 'file_mail_thread', args: { documents: ['D1'], folder: 'private/post/x' } }] }),
      {
        text: 'Nicht möglich.',
      },
    );
    await app.ok('chat:send', { text: 'Leg die Mail ab' });
    expect(lastToolOutput(app)).toContain('mindestens zwei E-Mails');
    expect(folderOf(app, first)).toBe('private/post');
  });
});

describe('capture_device (#312)', () => {
  it('stores the device and the reminder under the run id; undoing the run removes both', async () => {
    const receipt = await archiveFile(app, {
      name: 'beleg.txt',
      content: 'Elektro Huber\nWaschmaschine Bosch\nSeriennummer: FD-8812-3456\n10 Jahre Garantie\nGesamt 599,00 €',
      date: '2026-09-01',
      title: 'Beleg Waschmaschine',
    });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'beleg' } }] },
      { calls: [{ name: 'capture_device', args: { device: 'Waschmaschine Bosch', receipt: 'D1' } }] },
      { text: 'Gerät erfasst.' },
    );

    const res = await app.ok('chat:send', { text: 'Erfasse die Waschmaschine mit Garantie aus dem Beleg' });

    expect(lastToolOutput(app)).toContain('Garantie bis: 01.09.2036');
    const notes = () => app.services.graph.listEntities({ type: 'note' }).filter((n) => n.name.startsWith('Gerät:'));
    expect(notes()).toHaveLength(1);
    expect(app.services.reminders.list('pending').map((r) => [r.targetId, r.remindAt])).toEqual([[receipt, '2036-09-01']]);
    const run = await app.ok('agent:run', { id: res.assistantMessage.runId! });
    expect(run.undoable).toBe(2);

    const undo = await app.ok('agent:undoRun', { runId: run.id });
    expect(undo.undone).toBe(2);
    expect(notes()).toEqual([]);
    expect(app.services.reminders.list('pending')).toEqual([]);
  });
});

describe('family members: „alles von meiner Tochter“ (#312)', () => {
  it('registers the relationship name for a person (undoable), then resolves, finds and assigns', async () => {
    const own = await archiveFile(app, { name: 'zeugnis.txt', content: 'Zeugnis', persons: ['Lena Muster'], docType: 'Zeugnis', loc: 'private/schule' });
    const second = await archiveFile(app, {
      name: 'elternbrief.txt',
      content: 'Elternbrief',
      persons: ['Lena Muster'],
      docType: 'Brief',
      loc: 'private/schule',
    });
    const other = await archiveFile(app, { name: 'rechnung.txt', content: 'Rechnung', persons: ['Tom Muster'], docType: 'Rechnung', loc: 'private/schule' });
    const lena = app.services.graph.findByName('person', 'Lena Muster')!;

    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'list_subjects', args: { type: 'person' } }] },
      ({ body }) => ({
        calls: [{ name: 'add_person_alias', args: { person: firstMatch(body, /(K\d+) Person: Lena Muster/)[1], aliases: ['Tochter', 'meine Tochter'] } }],
      }),
      { text: 'Gemerkt.' },
    );
    const learned = await app.ok('chat:send', { text: 'Merk dir: Lena Muster ist meine Tochter' });
    expect(app.services.graph.getEntity(lena.id)!.aliases).toEqual(['Tochter', 'meine Tochter']);

    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'resolve_person', args: { name: 'meine Tochter' } }] },
      ({ body }) => {
        expect(firstMatch(body, /K\d+ Lena Muster \(erkannt über alias\)/)).toBeTruthy();
        return { calls: [{ name: 'find_documents', args: { person: 'meine Tochter' } }] };
      },
      ({ body }) => {
        const found = firstMatch(body, /Ergebnismenge (S\d+)/)[1];
        expect(outputsIn(body).join('\n')).toContain('2 Dokument(e)');
        return { calls: [{ name: 'set_metadata', args: { targets: [found], project: 'Schule Lena' } }] };
      },
      { text: 'Alles von Lena ist dem Projekt Schule Lena zugeordnet.' },
    );
    await app.ok('chat:send', { text: 'Ordne alles von meiner Tochter dem Projekt Schule Lena zu' });
    expect((await app.ok('documents:get', { id: own })).projectName).toBe('Schule Lena');
    expect((await app.ok('documents:get', { id: second })).projectName).toBe('Schule Lena');
    expect((await app.ok('documents:get', { id: other })).projectName).toBeNull();

    await app.ok('agent:undoRun', { runId: learned.assistantMessage.runId! });
    expect(app.services.graph.getEntity(lena.id)!.aliases).toEqual([]);
    expect(app.services.persons.resolve('meine Tochter', { create: false }).entity).toBeNull();
  });

  it('does not give a name that another person already has', async () => {
    await archiveFile(app, { name: 'a.txt', content: 'A', persons: ['Lena Muster'], docType: 'Brief' });
    await archiveFile(app, { name: 'b.txt', content: 'B', persons: ['Tom Muster'], docType: 'Brief' });
    app.services.graph.addAlias(app.services.graph.findByName('person', 'Tom Muster')!.id, 'Sohn');
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'list_subjects', args: { type: 'person' } }] },
      ({ body }) => ({ calls: [{ name: 'add_person_alias', args: { person: firstMatch(body, /(K\d+) Person: Lena Muster/)[1], aliases: ['Sohn'] } }] }),
      { text: 'Nicht möglich.' },
    );
    await app.ok('chat:send', { text: 'Merk dir: Lena ist mein Sohn' });
    expect(lastToolOutput(app)).toContain('Nicht vergeben: „Sohn“ (gehört zu Tom Muster)');
    expect(app.services.graph.findByName('person', 'Lena Muster')!.aliases).toEqual([]);

    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'list_subjects', args: { type: 'project' } }] },
      { calls: [{ name: 'add_person_alias', args: { person: 'K99', aliases: ['x'] } }] },
      { text: 'Nicht möglich.' },
    );
    await app.ok('chat:send', { text: 'Merk dir das' });
    expect(lastToolOutput(app)).toContain('keine bekannte Person');
  });
});

describe('receipt photo journey (#312)', () => {
  it('match_receipt_photos proposes the case, add_to_case applies it on request', async () => {
    const invoice = await archiveFile(app, { name: 'rechnung-mm.txt', content: 'Media Markt\nGesamtbetrag 49,90 €', date: '2026-03-12' });
    const photo = await archiveFile(app, { name: 'bon.png', content: await uniqueImage(), docType: 'Beleg' });
    setExtractedText(app, photo, 'Media Markt\n14.03.2026\nSumme 49,90 EUR');
    const kauf = (await app.ok('cases:create', { name: 'Kopfhörer' })).case;
    app.services.cases.assign({ entryIds: [invoice], caseId: kauf.id });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'match_receipt_photos', args: {} }] },
      ({ body }) => {
        const [, caseRef, photoRef] = firstMatch(body, /add_to_case case=(K\d+) entries=\[(D\d+)\]/);
        return { calls: [{ name: 'add_to_case', args: { case: caseRef, entries: [photoRef] } }] };
      },
      { text: 'Das Foto gehört jetzt zum Vorgang Kopfhörer.' },
    );

    await app.ok('chat:send', { text: 'Ordne das Belegfoto dem passenden Vorgang zu' });

    expect((await app.ok('cases:detail', { id: kauf.id })).entries.map((e) => e.id).toSorted()).toEqual([invoice, photo].toSorted());
  });
});

describe('confirmed privacy proposals (#312)', () => {
  it('a confirmed exclude_from_llm proposal really excludes the document', async () => {
    const id = await archiveFile(app, { name: 'pw.txt', content: 'Passwort', docType: 'Notiz', loc: 'private/misc' });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'find_documents', args: { name: 'pw' } }] },
      { calls: [{ name: 'exclude_from_llm', args: { documents: ['D1'] } }] },
      { text: 'Bitte bestätigen.' },
    );
    const res = await app.ok('chat:send', { text: 'Schließ pw.txt von der KI-Analyse aus' });
    expect((await app.ok('documents:get', { id })).llmStatus).not.toBe('excluded');
    const card = res.assistantMessage.actions.find((a) => a.actionType === 'agent_batch')!;

    const done = await app.ok('actions:resolve', { decision: 'approve', actionId: card.id, confirmed: true });

    expect(done.status).toBe('executed');
    expect((await app.ok('documents:get', { id })).llmStatus).toBe('excluded');
    expect(app.services.privacy.mayShareDocument(app.services.documents.get(id))).toBe(false);
  });

  it('a confirmed privacy setting proposal is applied, and undoing the run restores it', async () => {
    app.llm.agent = scriptedTurns({ calls: [{ name: 'set_setting', args: { key: 'privacy.llmMode', value: 'local_only' } }] }, { text: 'Bitte bestätigen.' });
    const res = await app.ok('chat:send', { text: 'Stell den Datenschutz auf nur lokal' });
    expect(app.services.settings.get().privacy.llmMode).toBe('auto');
    const card = res.assistantMessage.actions.find((a) => a.actionType === 'agent_batch')!;

    const done = await app.ok('actions:resolve', { decision: 'approve', actionId: card.id, confirmed: true });

    expect(done.status).toBe('executed');
    expect(app.services.settings.get().privacy.llmMode).toBe('local_only');
    await app.ok('agent:undoRun', { runId: res.assistantMessage.runId! });
    expect(app.services.settings.get().privacy.llmMode).toBe('auto');
  });
});
