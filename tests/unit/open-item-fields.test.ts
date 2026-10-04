import { OpenItemInput, type OpenItemSolution } from '@archivist/shared';
import { describe, expect, it } from 'vitest';
import {
  assertEditableStatusChange,
  newOpenItemRow,
  openItemIndexContent,
  plainPatchColumns,
  toOpenItem,
  type OpenItemRow,
} from '../../packages/core/src/services/open-item-fields';

const refs = { id: 'item-1', now: '2026-03-02T10:00:00.000Z', topicId: 'topic-1', projectId: null, responsiblePersonId: 'person-1' };
const row = (overrides: Partial<OpenItemRow> = {}): OpenItemRow => ({
  ...newOpenItemRow(OpenItemInput.parse({ title: 'Angebot prüfen' }), refs),
  ...overrides,
});

const names: Record<string, string> = { 'topic-1': 'Haus', 'project-1': 'Umbau', 'person-1': 'Anna' };
const lookups = (conversations: Map<string, string> = new Map()) => ({ nameOf: (id: string | null) => (id ? (names[id] ?? null) : null), conversations });

const solution: OpenItemSolution = {
  generatedAt: '2026-03-03T10:00:00.000Z',
  model: 'gpt-test',
  assessment: 'Machbar',
  assessmentSourceRefs: [],
  assessmentUncertain: false,
  nextSteps: [],
  openQuestions: [],
  risks: [],
  uncertainties: [],
  sources: [],
  confidence: 0.7,
};

describe('status changes of open items by editing', () => {
  it('allows keeping the status and moving between open statuses', () => {
    expect(() => assertEditableStatusChange('resolved', undefined)).not.toThrow();
    expect(() => assertEditableStatusChange('dismissed', 'dismissed')).not.toThrow();
    expect(() => assertEditableStatusChange('open', 'blocked')).not.toThrow();
  });

  it('refuses closing by editing', () => {
    expect(() => assertEditableStatusChange('open', 'resolved')).toThrow(/erfordert eine ausdrückliche Bestätigung/);
    expect(() => assertEditableStatusChange('waiting', 'dismissed')).toThrow(expect.objectContaining({ category: 'permission_error' }));
  });

  it('refuses reopening a closed item by editing', () => {
    expect(() => assertEditableStatusChange('resolved', 'open')).toThrow(/nicht durch Bearbeiten wieder öffnen/);
    expect(() => assertEditableStatusChange('dismissed', 'waiting')).toThrow(expect.objectContaining({ category: 'permission_error' }));
  });
});

describe('plain patch columns of open items', () => {
  it('sets only the fields present in the patch', () => {
    expect(plainPatchColumns(row(), {})).toStrictEqual({});
  });

  it('trims texts, clears an empty description and takes priority and a changed status', () => {
    expect(plainPatchColumns(row(), { title: ' Neu ', description: ' Details ', priority: 'high', status: 'waiting' })).toEqual({
      title: 'Neu',
      description: 'Details',
      priority: 'high',
      status: 'waiting',
    });
    expect(plainPatchColumns(row(), { description: '   ', status: 'open' })).toEqual({ description: null });
    expect(plainPatchColumns(row(), { description: null })).toEqual({ description: null });
  });

  it('normalises the due date and drops the „unknown“ mark only when a date is set', () => {
    expect(plainPatchColumns(row({ dueUnknown: true }), { dueAt: '5.4.2026' })).toEqual({ dueAt: '2026-04-05', dueUnknown: false });
    expect(plainPatchColumns(row({ dueUnknown: true }), { dueAt: null })).toEqual({ dueAt: null });
  });
});

describe('new open items', () => {
  it('creates an open item with defaults from the input and the resolved references', () => {
    expect(newOpenItemRow(OpenItemInput.parse({ title: ' Angebot prüfen ' }), refs)).toEqual({
      id: 'item-1',
      title: 'Angebot prüfen',
      description: null,
      topicId: 'topic-1',
      projectId: null,
      responsiblePersonId: 'person-1',
      responsibleUnknown: false,
      dueAt: null,
      dueUnknown: false,
      status: 'open',
      priority: 'normal',
      sourceIds: [],
      reminderAt: null,
      confidence: 0.9,
      createdAt: refs.now,
      updatedAt: refs.now,
      solution: null,
      duplicateOfId: null,
      resolutionNote: null,
    });
  });

  it('takes the given details', () => {
    const created = newOpenItemRow(
      { title: 'A', description: ' Beschreibung ', dueAt: '2026-04-05', priority: 'low', sourceIds: ['doc-1'], confidence: 0.5 },
      refs,
    );

    expect(created).toMatchObject({ description: 'Beschreibung', dueAt: '2026-04-05', priority: 'low', sourceIds: ['doc-1'], confidence: 0.5 });
    expect(newOpenItemRow(OpenItemInput.parse({ title: 'A', description: '  ' }), refs).description).toBeNull();
  });

  it('keeps an unknown owner and due date only while neither is given', () => {
    const unknown = OpenItemInput.parse({ title: 'A', responsibleUnknown: true, dueUnknown: true });

    expect(newOpenItemRow(unknown, { ...refs, responsiblePersonId: null })).toMatchObject({ responsibleUnknown: true, dueUnknown: true });
    expect(newOpenItemRow({ ...unknown, dueAt: '2026-04-05' }, refs)).toMatchObject({ responsibleUnknown: false, dueUnknown: false });
  });
});

describe('rendering open items', () => {
  it('maps a row with names, the first source conversation and a valid solution', () => {
    const item = toOpenItem(
      row({ projectId: 'project-1', sourceIds: ['doc-1', 'msg-1', 'msg-2'], solution }),
      lookups(
        new Map([
          ['msg-1', 'conv-1'],
          ['msg-2', 'conv-2'],
        ]),
      ),
    );

    expect(item).toMatchObject({ topicName: 'Haus', projectName: 'Umbau', responsibleName: 'Anna', sourceConversationId: 'conv-1', solution });
  });

  it('has no conversation without chat sources and drops a stored solution that no longer parses', () => {
    const item = toOpenItem(row({ sourceIds: ['doc-1'], solution: { kaputt: true } as unknown as OpenItemSolution }), lookups());

    expect(item.sourceConversationId).toBeNull();
    expect(item.solution).toBeNull();
    expect(toOpenItem(row(), lookups()).solution).toBeNull();
  });

  it('builds the search index text from the filled fields only', () => {
    const item = toOpenItem(
      row({ description: 'Zwei Angebote', projectId: 'project-1', dueAt: '2026-04-05T12:00:00.000Z', status: 'resolved', resolutionNote: 'Angebot B' }),
      lookups(),
    );

    expect(openItemIndexContent(item)).toBe(
      [
        'Angebot prüfen',
        'Zwei Angebote',
        'Thema: Haus',
        'Projekt: Umbau',
        'Verantwortlich: Anna',
        'Fällig: 2026-04-05',
        'Status: Erledigt',
        'Erledigt: Angebot B',
      ].join('\n'),
    );
    const dismissed = toOpenItem(row({ topicId: null, responsiblePersonId: null, status: 'dismissed', resolutionNote: 'Doppelt' }), lookups());
    expect(openItemIndexContent(dismissed)).toBe('Angebot prüfen\nStatus: Verworfen\nVerworfen: Doppelt');
  });
});
