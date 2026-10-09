import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { riskOf } from '../../packages/core/src/agent/registry';
import { subjectDeleteTools } from '../../packages/core/src/agent/tools/subject-delete';
import { blockedSubjects } from '../../packages/core/src/db/schema';
import { agentApp, archived, emptyToolContext, lastToolOutput, scriptedTurns } from '../helpers/agent';
import type { TestApp } from '../helpers/harness';
import { toolDepsOf } from '../helpers/tool-deps';

let app: TestApp;
beforeEach(async () => {
  app = await agentApp();
});
afterEach(async () => app.cleanup());

const graph = () => app.services.graph;
const deletions = async () => (await app.ok('audit:list', {})).filter((e) => e.action === 'entity.delete');
const undoLast = async () => app.ok('audit:undo', { auditId: (await deletions())[0]!.id });
const blocked = () => app.services.ctx.database.db.select().from(blockedSubjects).all();

describe('Deleting a subject', () => {
  it('deletes a person without links and the undo brings it back with aliases', async () => {
    const person = graph().ensureEntity({ type: 'person', name: 'K35' });
    graph().addAlias(person.id, 'Kay');

    const result = await graph().deleteSubject(person.id, { actor: 'user', trigger: 'manual', confirmed: true });

    expect(result.impact.relations + result.impact.records.length).toBe(0);
    expect(graph().getEntity(person.id)).toBeUndefined();
    expect(
      blocked()
        .map((row) => row.normalizedName)
        .toSorted(),
    ).toEqual(['k35', 'kay']);

    await undoLast();
    expect(graph().getEntity(person.id)).toMatchObject({ name: 'K35', aliases: ['Kay'] });
    expect(blocked()).toHaveLength(0);
  });

  it('removes edges, name lists and main topics of a topic and the undo restores all of it', async () => {
    const id = await archived(app, { name: 'vertrag.txt', content: 'Mietvertrag', folder: 'Privat/wohnen', topic: 'Umzug', persons: ['Frank Tenzer'] });
    const topic = graph().findByName('topic', 'Umzug')!;
    const person = graph().findByName('person', 'Frank Tenzer')!;
    const before = app.services.documents.getRow(id);
    expect(before.topicId).toBe(topic.id);

    const impact = graph().subjectImpact(topic.id);
    expect(impact.records).toEqual([expect.objectContaining({ table: 'documents', id, main: true })]);
    await graph().deleteSubject(topic.id, { actor: 'user', trigger: 'manual', confirmed: true });
    await graph().deleteSubject(person.id, { actor: 'user', trigger: 'manual', confirmed: true });

    const after = app.services.documents.getRow(id);
    expect(after.topicId).toBeNull();
    expect(after.persons).toEqual([]);
    expect(after.archiveRelPath).toBe(before.archiveRelPath);
    expect(
      graph()
        .relationsOf(id)
        .filter((relation) => [topic.id, person.id].includes(relation.sourceEntityId) || [topic.id, person.id].includes(relation.targetEntityId)),
    ).toEqual([]);

    for (const entry of await deletions()) await app.ok('audit:undo', { auditId: entry.id });
    const restored = app.services.documents.getRow(id);
    expect(restored.topicId).toBe(topic.id);
    expect(restored.persons).toEqual(['Frank Tenzer']);
    expect(graph().relationsOf(topic.id).length).toBeGreaterThan(0);
  });

  it('refuses the user themselves and entries that are no named subject', async () => {
    const self = app.services.self.ensure();
    const note = await app.services.notes.create({ title: 'Notiz', content: 'Inhalt der Notiz' });

    await expect(graph().deleteSubject(self.id, { actor: 'user', trigger: 'manual', confirmed: true })).rejects.toThrow(/selbst/);
    await expect(graph().deleteSubject(note.id, { actor: 'user', trigger: 'manual', confirmed: true })).rejects.toThrow(/keine Person/);
    expect(graph().getEntity(self.id)).toBeDefined();
  });

  it('does not create a deleted name again from the analysis, but a manual entry still works', async () => {
    const person = graph().ensureEntity({ type: 'person', name: 'Frank Tenzer' });
    await graph().deleteSubject(person.id, { actor: 'user', trigger: 'manual', confirmed: true });

    const analysed = app.services.persons.resolveNames(['Frank Tenzer', 'Anna Berg'], { context: 'document', fromAnalysis: true });
    expect(analysed.names).toEqual(['Anna Berg']);
    expect(graph().findByName('person', 'Frank Tenzer')).toBeUndefined();

    expect(app.services.persons.resolve('Frank Tenzer', { context: 'manual' }).entity?.name).toBe('Frank Tenzer');
  });

  it('does not take a deleted topic over from a document again', async () => {
    graph().ensureEntity({ type: 'topic', name: 'Umzug' });
    await graph().deleteSubject(graph().findByName('topic', 'Umzug')!.id, { actor: 'user', trigger: 'manual', confirmed: true });

    const id = await archived(app, { name: 'brief.txt', content: 'Brief zum Umzug', folder: 'Privat/wohnen', topic: 'Umzug' });

    expect(graph().findByName('topic', 'Umzug')).toBeUndefined();
    expect(app.services.documents.getRow(id).topicId).toBeNull();
  });

  it('refuses without an explicit confirmation', async () => {
    const topic = graph().ensureEntity({ type: 'topic', name: 'Hauskauf' });

    await expect(graph().deleteSubject(topic.id, { actor: 'user', trigger: 'manual', confirmed: false })).rejects.toThrow(/Bestätigung/);
    expect(graph().getEntity(topic.id)).toBeDefined();
  });

  it('blocks the undo when the name was created again meanwhile', async () => {
    const person = graph().ensureEntity({ type: 'person', name: 'Frank Tenzer' });
    await graph().deleteSubject(person.id, { actor: 'user', trigger: 'manual', confirmed: true });
    graph().ensureEntity({ type: 'person', name: 'Frank Tenzer' });

    const undone = await app.ok('audit:undo', { auditId: (await deletions())[0]!.id });
    expect(undone.undone).toBe(false);
    expect(undone.conflicts.join(' ')).toContain('neu angelegt');
  });
});

describe('The user interface channel', () => {
  it('shows the impact and deletes only after the explicit confirmation', async () => {
    const topic = graph().ensureEntity({ type: 'topic', name: 'Hauskauf' });
    expect(await app.ok('knowledge:subjectImpact', { id: topic.id })).toEqual({ relations: 0, records: [] });

    expect((await app.call('knowledge:deleteSubject', { id: topic.id, confirmed: false as unknown as true })).ok).toBe(false);
    expect(graph().getEntity(topic.id)).toBeDefined();

    await app.ok('knowledge:deleteSubject', { id: topic.id, confirmed: true });
    expect(graph().getEntity(topic.id)).toBeUndefined();
  });
});

describe('The delete_subject tool', () => {
  const tool = () => new Map(subjectDeleteTools(toolDepsOf(app)).map((entry) => [entry.name, entry])).get('delete_subject')!;
  const call = async (args: unknown) => tool().run(tool().schema.parse(args), emptyToolContext());

  it('is a plain change without links and asks first when something still hangs on the subject', async () => {
    const lonely = graph().ensureEntity({ type: 'person', name: 'K35' });
    await archived(app, { name: 'a.txt', content: 'Inhalt', folder: 'Privat/wohnen', topic: 'Umzug' });
    const topic = graph().findByName('topic', 'Umzug')!;
    const ctx = emptyToolContext();
    ctx.refs.entry(lonely.id);
    ctx.refs.entry(topic.id);

    expect(riskOf(tool(), tool().schema.parse({ subject: 'K1' }), ctx)).toBe('write');
    expect(riskOf(tool(), tool().schema.parse({ subject: 'K2' }), ctx)).toBe('critical');
    expect(riskOf(tool(), tool().schema.parse({ subject: 'unbekannt' }), ctx)).toBe('critical');
  });

  it('answers like the other tools and lists the documents that lose their main topic', async () => {
    const id = await archived(app, { name: 'a.txt', content: 'Inhalt', folder: 'Privat/wohnen', topic: 'Umzug' });
    const out = await call({ subject: 'Umzug', type: 'topic', reason: 'Dublette zum Projekt' });

    expect(out.isError).toBeUndefined();
    expect(out.content).toMatch(/Thema „Umzug“ \(K1\) gelöscht – \d+ Verknüpfung\(en\) entfernt\. Rückgängig möglich\./);
    expect(out.content).toContain('Hauptthema/-projekt');
    expect(app.services.documents.getRow(id).topicId).toBeNull();
  });

  it('names the candidates when the name is ambiguous and refuses the user themselves', async () => {
    graph().ensureEntity({ type: 'topic', name: 'Steuer' });
    graph().ensureEntity({ type: 'project', name: 'Steuer' });

    const ambiguous = await call({ subject: 'Steuer' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content).toMatch(/nicht eindeutig.*K\d Thema „Steuer“.*K\d Projekt „Steuer“/);
    expect((await call({ subject: 'Steuer', type: 'project' })).isError).toBeUndefined();

    app.services.self.ensure();
    expect((await call({ subject: 'ich', type: 'person' })).isError).toBe(true);
  });

  it('runs in the chat: direct without links, as a proposal card with links, undone with the run', async () => {
    graph().ensureEntity({ type: 'person', name: 'K35' });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'delete_subject', args: { subject: 'K35', type: 'person' } }] }, { text: 'Gelöscht.' });
    const first = await app.ok('chat:send', { text: 'Lösche die Person K35' });
    expect(lastToolOutput(app)).toContain('gelöscht');
    expect(graph().findByName('person', 'K35')).toBeUndefined();

    expect((await app.ok('agent:undoRun', { runId: first.assistantMessage.runId! })).undone).toBe(1);
    expect(graph().findByName('person', 'K35')).toBeDefined();
    expect(graph().isBlockedName({ type: 'person', name: 'K35' })).toBe(false);

    await archived(app, { name: 'a.txt', content: 'Inhalt', folder: 'Privat/wohnen', topic: 'Umzug' });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'delete_subject', args: { subject: 'Umzug' } }] }, { text: 'Ich habe es vorbereitet.' });
    const reply = await app.ok('chat:send', { text: 'Lösche das Thema Umzug' });
    expect(graph().findByName('topic', 'Umzug')).toBeDefined();
    const card = reply.assistantMessage.actions.find((action) => action.actionType === 'agent_batch')!;
    expect(card).toBeDefined();

    await app.ok('actions:resolve', { actionId: card.id, decision: 'approve', confirmed: true });
    expect(graph().findByName('topic', 'Umzug')).toBeUndefined();
  });
});

describe("Deleting a subject only on the user's own request", () => {
  const scriptDelete = (subject: string) => {
    app.llm.agent = scriptedTurns({ calls: [{ name: 'delete_subject', args: { subject } }] }, { text: 'ok' });
  };

  it('does not delete when the user only asks a question', async () => {
    const topic = graph().ensureEntity({ type: 'topic', name: 'Umzug' });
    scriptDelete('Umzug');

    await app.ok('chat:send', { text: 'Wer ist eigentlich zuständig für Umzug?' });

    expect(lastToolOutput(app)).toContain('ausdrücklichen Wunsch');
    expect(graph().getEntity(topic.id)).toBeDefined();
    expect(graph().isBlockedName({ type: 'topic', name: 'Umzug' })).toBe(false);
  });

  it('does not delete in a background run', async () => {
    const person = graph().ensureEntity({ type: 'person', name: 'Kai Uhl' });
    scriptDelete('Kai Uhl');

    await app.services.agent.runBackground('archive_check');

    expect(graph().getEntity(person.id)).toBeDefined();
    expect(graph().isBlockedName({ type: 'person', name: 'Kai Uhl' })).toBe(false);
  });

  it('deletes on an explicit request', async () => {
    graph().ensureEntity({ type: 'topic', name: 'Umzug' });
    scriptDelete('Umzug');

    await app.ok('chat:send', { text: 'Lösche das Thema Umzug' });

    expect(graph().findByName('topic', 'Umzug')).toBeUndefined();
  });
});

describe('forget', () => {
  it('names the real kind of the entry instead of blaming the saving guard', async () => {
    const person = graph().ensureEntity({ type: 'person', name: 'K35' });
    app.llm.agent = scriptedTurns(
      { calls: [{ name: 'list_subjects', args: { type: 'person' } }] },
      { calls: [{ name: 'forget', args: { id: 'K1' } }] },
      { text: 'ok' },
    );
    await app.ok('chat:send', { text: 'Lösche K1 aus dem Gedächtnis' });

    const output = lastToolOutput(app);
    expect(output).toContain('„K1“ ist eine Person, nichts Gelerntes – zum Löschen delete_subject verwenden.');
    expect(output).not.toContain('Gespeichert wird nur');
    expect(graph().getEntity(person.id)).toBeDefined();
  });

  it('still deletes learned things on request and only then', async () => {
    const entry = app.services.memory.save({ kind: 'preference', name: 'Kurz', content: 'Antworte kurz.' });
    app.llm.agent = scriptedTurns({ calls: [{ name: 'forget', args: { id: entry.id } }] }, { text: 'ok' });
    await app.ok('chat:send', { text: 'Wie spät ist es?' });
    expect(lastToolOutput(app)).toContain('ausdrücklichen Wunsch');
    expect(app.services.memory.list()).toHaveLength(1);

    app.llm.agent = scriptedTurns({ calls: [{ name: 'forget', args: { id: entry.id } }] }, { text: 'ok' });
    await app.ok('chat:send', { text: 'Vergiss die Vorliebe, lösche sie bitte' });
    expect(app.services.memory.list()).toHaveLength(0);
  });
});
