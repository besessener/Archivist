import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  await app.cleanup();
});

const solutionCalls = () => app.llm.calls.filter((c) => c.schema === 'SolutionProposal');

const item = (title: string, extra: Record<string, unknown> = {}) =>
  app.ok('openItems:create', { title, priority: 'normal', sourceIds: [], confidence: 0.9, ...extra });

async function decision(title: string, text: string): Promise<string> {
  const d = await app.ok('decisions:create', {
    title,
    decisionText: text,
    topic: 'Hausrenovierung',
    decidedAt: '2026-09-01',
    participants: ['Anna'],
    alternatives: [],
    unknownFields: [],
    sourceIds: [],
    confidence: 0.9,
    asDraft: false,
  });
  return d.id;
}

/** Import a document, let the (fake) LLM classify it and archive it. */
async function archivedDoc(name: string, content: string): Promise<string> {
  app.llm.on('DocumentClassification', () => ({
    docType: 'Angebot',
    title: name,
    summary: `Zusammenfassung: ${content}`,
    mainTopic: 'Hausrenovierung',
    project: null,
    persons: [],
    dates: [],
    tags: [],
    location: { categoryPath: 'private/haus', fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
    decisions: [],
    openItems: [],
    confidence: 0.7,
    rationale: 'x',
  }));
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}.txt`, content)] });
  await app.services.jobs.whenIdle();
  const id = imp.imported[0]!.id;
  await app.ok('documents:archive', {
    items: [{ documentId: id, mode: 'copy', categoryPath: 'private/haus' }],
    confirmed: true,
    approveNewCategories: [],
    confirmMove: false,
  } as never);
  return id;
}

const PROPOSAL = {
  assessment: 'Die Entscheidung für Holzfaser steht, es fehlen nur Angebote.',
  assessmentSourceIds: ['S1'],
  nextSteps: [
    { title: 'Zwei Angebote für Holzfaser einholen', detail: 'Bei regionalen Dachdeckern anfragen', sourceIds: ['S1'] },
    { title: 'Förderung prüfen', sourceIds: ['S99'] },
  ],
  openQuestions: ['Welches Budget steht zur Verfügung?'],
  risks: [{ description: 'Lieferzeiten für Dämmstoff', sourceIds: [] }],
  usedSourceIds: ['S1'],
  confidence: 0.8,
};

describe('Solution proposal for open items (#46)', () => {
  it('the prompt contains the item and matching sources; the output is validated and stored with date and model', async () => {
    const dec = await decision('Dämmung mit Holzfaser', 'Das Dach wird mit Holzfaser gedämmt.');
    const target = await item('Angebot für Dachdämmung einholen', {
      description: 'Mindestens zwei Angebote vergleichen. Zugang: password=hunter2geheim',
      responsible: 'Anna Schmidt',
      dueAt: '2026-11-15',
      topic: 'Hausrenovierung',
      project: 'Dach',
      sourceIds: [dec],
    });
    // note that is only found via the hybrid search
    const note = app.services.graph.ensureEntity('note', 'Dachdecker Meier', 'Dachdecker Meier bietet Holzfaser-Dämmung an.');
    await app.services.search.index({ type: 'note', id: note.id, title: note.name, content: 'Dachdecker Meier bietet Holzfaser Dämmung und Angebot an.' });
    app.llm.on('SolutionProposal', () => PROPOSAL);

    const out = await app.ok('openItems:generateSolution', { id: target.id });

    const [call] = solutionCalls();
    expect(call!.input).toContain('Titel: Angebot für Dachdämmung einholen');
    expect(call!.input).toContain('Verantwortlich: Anna Schmidt');
    expect(call!.input).toContain('Fällig: 2026-11-15');
    expect(call!.input).toContain('Status: offen');
    expect(call!.input).toContain('Thema: Hausrenovierung');
    expect(call!.input).toContain('Projekt: Dach');
    expect(call!.input).toMatch(/\[S1\] \(decision, 2026-09-01\) Dämmung mit Holzfaser/);
    expect(call!.input).toContain('Das Dach wird mit Holzfaser gedämmt.');
    expect(call!.input).toContain('Dachdecker Meier');
    // secrets are masked before transmission
    expect(call!.input).not.toContain('hunter2geheim');
    expect(call!.input).toContain('[REDACTED:secret]');

    const s = out.solution!;
    expect(s.model).toBe('test-model');
    expect(s.generatedAt.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(s.assessmentUncertain).toBe(false);
    expect(s.nextSteps[0]).toMatchObject({ text: 'Zwei Angebote für Holzfaser einholen', sourceRefs: ['S1'], uncertain: false });
    // unknown source „S99“ is not valid evidence → marked as uncertain
    expect(s.nextSteps[1]).toMatchObject({ text: 'Förderung prüfen', sourceRefs: [], uncertain: true });
    expect(s.risks[0]).toMatchObject({ uncertain: true });
    expect(s.uncertainties.join(' ')).toContain('2 Aussage(n) ohne gültigen Quellenbeleg');
    expect(s.sources.find((x) => x.ref === 'S1')).toMatchObject({ id: dec, type: 'decision', used: true });
    expect(s.sources.some((x) => x.id === note.id)).toBe(true);

    const listed = (await app.ok('openItems:list', {})).find((i) => i.id === target.id)!;
    expect(listed.solution?.assessment).toBe(PROPOSAL.assessment);
    const log = await app.ok('llm:transmissions', {});
    expect(log.some((t) => t.purpose === 'Lösungsvorschlag' && t.success)).toBe(true);
  });

  it('regenerating replaces the proposal', async () => {
    const target = await item('Steuererklärung vorbereiten');
    app.llm.on('SolutionProposal', () => ({ ...PROPOSAL, assessment: 'Erster Vorschlag' }));
    await app.ok('openItems:generateSolution', { id: target.id });
    app.llm.on('SolutionProposal', () => ({ ...PROPOSAL, assessment: 'Zweiter Vorschlag' }));
    const out = await app.ok('openItems:generateSolution', { id: target.id });
    expect(out.solution?.assessment).toBe('Zweiter Vorschlag');
    // without sources there is no valid evidence
    expect(out.solution?.assessmentUncertain).toBe(true);
    expect(out.solution?.uncertainties.join(' ')).toContain('keine passenden Quellen');
  });

  it('excluded documents contribute only their title – never their content', async () => {
    const doc = await archivedDoc('Angebot Dach', 'Vertraulich Zitronenfalter Kalkulation 48.000 Euro');
    await app.ok('documents:setLlmExcluded', { id: doc, excluded: true });
    const target = await item('Dachangebot prüfen', { sourceIds: [doc] });
    app.llm.on('SolutionProposal', () => PROPOSAL);

    const preview = await app.ok('openItems:solutionPreview', { id: target.id });
    expect(preview.sources.find((s) => s.id === doc)).toMatchObject({ title: 'Angebot Dach', contentIncluded: false });

    const before = solutionCalls().length;
    const out = await app.ok('openItems:generateSolution', { id: target.id });
    const input = solutionCalls()[before]!.input;
    expect(input).toContain('Angebot Dach');
    expect(input).not.toContain('Zitronenfalter');
    expect(input).not.toContain('48.000');
    expect(out.solution?.sources.find((s) => s.id === doc)?.contentIncluded).toBe(false);
  });

  it('documents that are not excluded are sent with their content', async () => {
    const doc = await archivedDoc('Angebot Fenster', 'Fensterbauer Kranich liefert in sechs Wochen');
    const target = await item('Fensterangebot prüfen', { sourceIds: [doc] });
    app.llm.on('SolutionProposal', () => PROPOSAL);
    await app.ok('openItems:generateSolution', { id: target.id });
    expect(solutionCalls().at(-1)!.input).toContain('Kranich');
    const log = await app.ok('llm:transmissions', {});
    expect(log.find((t) => t.purpose === 'Lösungsvorschlag')?.documentIds).toContain(doc);
  });

  it('local_only blocks the action – nothing is sent', async () => {
    const target = await item('Vertrag kündigen');
    app.services.settings.update({ privacy: { llmMode: 'local_only' } });
    app.llm.on('SolutionProposal', () => PROPOSAL);

    const preview = await app.ok('openItems:solutionPreview', { id: target.id });
    expect(preview).toMatchObject({ mode: 'local_only', available: false });
    expect(preview.blockedReason).toContain('nur lokal');

    const r = await app.call('openItems:generateSolution', { id: target.id, confirmed: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('permission_error');
    expect(solutionCalls()).toHaveLength(0);
    expect((await app.ok('openItems:list', {}))[0]!.solution).toBeNull();
  });

  it('confirm: nothing is sent without confirmation, but it is with confirmation', async () => {
    const target = await item('Urlaub planen');
    app.services.settings.update({ privacy: { llmMode: 'confirm' } });
    app.llm.on('SolutionProposal', () => PROPOSAL);

    const preview = await app.ok('openItems:solutionPreview', { id: target.id });
    expect(preview).toMatchObject({ mode: 'confirm', available: true });
    expect(preview.itemFields.find((f) => f.label === 'Titel')?.value).toBe('Urlaub planen');

    const r = await app.call('openItems:generateSolution', { id: target.id });
    expect(r.ok).toBe(false);
    expect(solutionCalls()).toHaveLength(0);

    const out = await app.ok('openItems:generateSolution', { id: target.id, confirmed: true });
    expect(out.solution).not.toBeNull();
    expect(solutionCalls()).toHaveLength(1);
  });

  it('LLM not configured or unreachable: understandable message, nothing changed', async () => {
    const target = await item('Heizung warten lassen');
    app.llm.down = true;
    const down = await app.call('openItems:generateSolution', { id: target.id });
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.error.message).toContain('nicht erreichbar');
    expect((await app.ok('openItems:list', {}))[0]).toMatchObject({ solution: null, updatedAt: target.updatedAt });

    app.llm.down = false;
    app.services.secrets.clear();
    const preview = await app.ok('openItems:solutionPreview', { id: target.id });
    expect(preview.available).toBe(false);
    const r = await app.call('openItems:generateSolution', { id: target.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('nicht konfiguriert');
  });

  it('invalid LLM output is discarded – nothing stored', async () => {
    const target = await item('Garage aufräumen');
    app.llm.on('SolutionProposal', () => ({ nextSteps: 'kein Array' }));
    const r = await app.call('openItems:generateSolution', { id: target.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('llm_error');
    expect((await app.ok('openItems:list', {}))[0]!.solution).toBeNull();
  });

  it('the generation can be cancelled – the result is discarded', async () => {
    const target = await item('Keller entrümpeln');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    app.llm.on('SolutionProposal', async () => {
      await gate;
      return PROPOSAL;
    });

    const pending = app.call('openItems:generateSolution', { id: target.id });
    await expect.poll(() => solutionCalls().length).toBe(1);
    expect(await app.ok('openItems:cancelSolution', { id: target.id })).toEqual({ cancelled: true });
    release();

    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('abgebrochen');
    expect((await app.ok('openItems:list', {}))[0]!.solution).toBeNull();
    expect(await app.ok('openItems:cancelSolution', { id: target.id })).toEqual({ cancelled: false });
  });

  it('apply: as an addition to the description, as new open items (with confirmation) and as a note', async () => {
    const target = await item('Dachdämmung beauftragen', { description: 'Bis Winter erledigen.', topic: 'Hausrenovierung' });
    app.llm.on('SolutionProposal', () => PROPOSAL);
    await app.ok('openItems:generateSolution', { id: target.id });

    const desc = await app.ok('openItems:applySolution', { target: 'description', id: target.id });
    expect(desc.item.description).toMatch(/^Bis Winter erledigen\.\n\nLösungsvorschlag vom /);
    expect(desc.item.description).toContain('- Förderung prüfen (unbelegt)');

    const unconfirmed = await app.call('openItems:applySolution', { target: 'items', id: target.id, stepIndexes: [0], confirmed: false } as never);
    expect(unconfirmed.ok).toBe(false);
    const items = await app.ok('openItems:applySolution', { target: 'items', id: target.id, stepIndexes: [0, 1], confirmed: true });
    expect(items.created.map((i) => i.title)).toEqual(['Zwei Angebote für Holzfaser einholen', 'Förderung prüfen']);
    expect(items.created[0]).toMatchObject({ topicName: 'Hausrenovierung', sourceIds: [target.id], status: 'open' });
    expect(items.created[0]!.description).toContain('Bei regionalen Dachdeckern anfragen');
    expect(app.services.graph.neighbors(target.id, { types: ['task'] }).map((e) => e.id)).toContain(items.created[0]!.id);

    const note = await app.ok('openItems:applySolution', { target: 'note', id: target.id });
    const entity = app.services.graph.getEntity(note.noteId!);
    expect(entity).toMatchObject({ type: 'note' });
    expect(entity!.description).toContain(PROPOSAL.assessment);
    const hits = await app.ok('search:global', { query: 'Holzfaser Dachdeckern', types: ['note'] });
    expect(hits.some((h) => h.id === note.noteId)).toBe(true);
  });
});
