import { describe, expect, it } from 'vitest';
import { RuleDefinition, WorkflowDefinition } from '@archivist/shared';
import {
  dataOfDraft,
  draftOf,
  emptyRuleForm,
  exportMemory,
  newDraft,
  parseMemoryImport,
  ruleFromForm,
  ruleToForm,
  workflowFromForm,
  workflowToForm,
} from '../../apps/renderer/components/agent/memory-forms';

const rule = { when: { sender: 'Stadtwerke', docType: 'Rechnung' }, then: { folder: 'Privat/energie', tags: ['Strom', 'Energie'] } };
const workflow = {
  steps: ['Belege des Jahres {jahr} sammeln', 'auf Lücken prüfen'],
  parameters: [
    { name: 'jahr', description: 'Steuerjahr' },
    { name: 'ort', description: '' },
  ],
  scheduleWeekday: 1,
};

describe('rule form fields', () => {
  it('turns a rule into fields and back without losing anything', () => {
    const form = ruleToForm(rule);
    expect(form).toMatchObject({ sender: 'Stadtwerke', docType: 'Rechnung', folder: 'Privat/energie', tags: 'Strom, Energie' });
    expect(ruleFromForm(form)).toEqual({ ok: true, value: RuleDefinition.parse(rule) });
  });

  it('trims the fields and leaves empty ones out', () => {
    const result = ruleFromForm({ ...emptyRuleForm(), sender: '  Telekom ', folder: ' Privat/telefon ', tags: ' a ;; b ,' });
    expect(result).toEqual({ ok: true, value: { when: { sender: 'Telekom' }, then: { folder: 'Privat/telefon', tags: ['a', 'b'] } } });
  });

  it('names what is missing in German', () => {
    expect(ruleFromForm(emptyRuleForm())).toEqual({ ok: false, error: 'Eine Regel braucht mindestens eine Bedingung.' });
    expect(ruleFromForm({ ...emptyRuleForm(), sender: 'x' })).toEqual({ ok: false, error: 'Eine Regel braucht eine Aktion.' });
  });

  it('shows invalid stored data as an empty form', () => {
    expect(ruleToForm({ nonsense: true })).toEqual(emptyRuleForm());
  });
});

describe('workflow form fields', () => {
  it('turns a workflow into fields and back, with parameters and weekday', () => {
    const form = workflowToForm(workflow);
    expect(form).toEqual({ steps: 'Belege des Jahres {jahr} sammeln\nauf Lücken prüfen', parameters: 'jahr: Steuerjahr\nort', weekday: '1' });
    expect(workflowFromForm(form)).toEqual({ ok: true, value: WorkflowDefinition.parse(workflow) });
  });

  it('an empty weekday means not scheduled', () => {
    const result = workflowFromForm({ steps: 'a', parameters: '', weekday: '' });
    expect(result).toMatchObject({ ok: true, value: { scheduleWeekday: null } });
  });

  it('needs at least one and at most 30 steps', () => {
    expect(workflowFromForm({ steps: ' \n ', parameters: '', weekday: '' })).toEqual({ ok: false, error: 'Ein Ablauf braucht mindestens einen Schritt.' });
    expect(workflowFromForm({ steps: Array.from({ length: 31 }, (_, i) => `s${i}`).join('\n'), parameters: '', weekday: '' }).ok).toBe(false);
  });

  it('rejects a parameter without a name', () => {
    expect(workflowFromForm({ steps: 'a', parameters: ': ohne Namen', weekday: '' })).toEqual({ ok: false, error: 'Jeder Parameter braucht einen Namen.' });
  });
});

describe('entry drafts', () => {
  const entry = { id: 'e1', name: 'N', content: 'C' };

  it('builds the structured part per kind; preferences and facts have none', () => {
    expect(dataOfDraft(newDraft())).toEqual({ ok: true, value: undefined });
    expect(dataOfDraft(draftOf({ ...entry, kind: 'rule', data: rule }))).toMatchObject({ ok: true, value: { when: { sender: 'Stadtwerke' } } });
    expect(dataOfDraft(draftOf({ ...entry, kind: 'workflow', data: workflow }))).toMatchObject({ ok: true, value: { scheduleWeekday: 1 } });
    expect(dataOfDraft(draftOf({ ...entry, kind: 'rule', data: null })).ok).toBe(false);
  });

  it('keeps a correction as it is (no structured part is sent)', () => {
    expect(dataOfDraft(draftOf({ ...entry, kind: 'correction', data: { did: 'a', instead: 'b', key: 'k' } }))).toEqual({ ok: true, value: undefined });
  });
});

describe('export and import of what was learned', () => {
  const entries = [
    { kind: 'rule' as const, name: 'Regel', content: 'Stadtwerke nach energie', data: rule, enabled: false },
    { kind: 'fact' as const, name: 'Vermieter', content: 'Firma Berger', enabled: true },
  ];

  it('imports exactly what was exported, including switched-off entries', () => {
    const imported = parseMemoryImport(exportMemory(entries));
    expect(imported).toEqual({
      ok: true,
      value: {
        skipped: 0,
        items: [
          { kind: 'rule', name: 'Regel', content: 'Stadtwerke nach energie', data: rule, enabled: false },
          { kind: 'fact', name: 'Vermieter', content: 'Firma Berger', enabled: true },
        ],
      },
    });
  });

  it('counts invalid entries as skipped and reports a file that is no JSON', () => {
    const text = JSON.stringify([
      { kind: 'fact', name: 'Gut', content: 'x' },
      { kind: 'unbekannt', name: 'Schlecht', content: 'y' },
      'text',
      { kind: 'fact', name: '', content: 'z' },
    ]);
    expect(parseMemoryImport(text)).toMatchObject({ ok: true, value: { skipped: 3, items: [{ name: 'Gut', enabled: true }] } });
    expect(parseMemoryImport('{ kaputt')).toEqual({ ok: false, error: 'Die Datei ist kein gültiges JSON.' });
    expect(parseMemoryImport('{"kind":"fact"}')).toMatchObject({ ok: true, value: { items: [], skipped: 0 } });
  });
});
