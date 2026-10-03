import { MemoryInput, RuleDefinition, WorkflowDefinition, type MemoryEntry, type MemoryKind } from '@archivist/shared';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** The fields of a rule as the user types them: conditions (when) and actions (then). */
export interface RuleForm {
  sender: string;
  docType: string;
  nameContains: string;
  ext: string;
  topic: string;
  textContains: string;
  folder: string;
  thenTopic: string;
  project: string;
  tags: string;
  renamePattern: string;
}

export const WHEN_FIELDS: Array<[keyof RuleForm, string]> = [
  ['sender', 'Absender enthält'],
  ['docType', 'Dokumenttyp enthält'],
  ['nameContains', 'Dateiname enthält'],
  ['ext', 'Endung'],
  ['topic', 'Thema enthält'],
  ['textContains', 'Text enthält'],
];
export const THEN_FIELDS: Array<[keyof RuleForm, string]> = [
  ['folder', 'Ablageordner'],
  ['thenTopic', 'Thema setzen'],
  ['project', 'Projekt setzen'],
  ['tags', 'Schlagwörter (mit Komma getrennt)'],
  ['renamePattern', 'Namensschema'],
];

/** A workflow as typed: one step per line, parameters as „name: Beschreibung“ per line. */
export interface WorkflowForm {
  steps: string;
  parameters: string;
  /** '' = not scheduled, else weekday 0–6 */
  weekday: string;
}

export const emptyRuleForm = (): RuleForm => ({
  sender: '',
  docType: '',
  nameContains: '',
  ext: '',
  topic: '',
  textContains: '',
  folder: '',
  thenTopic: '',
  project: '',
  tags: '',
  renamePattern: '',
});
export const emptyWorkflowForm = (): WorkflowForm => ({ steps: '', parameters: '', weekday: '' });

export function ruleToForm(data: unknown): RuleForm {
  const parsed = RuleDefinition.safeParse(data);
  if (!parsed.success) return emptyRuleForm();
  const { when, then } = parsed.data;
  return {
    sender: when.sender ?? '',
    docType: when.docType ?? '',
    nameContains: when.nameContains ?? '',
    ext: when.ext ?? '',
    topic: when.topic ?? '',
    textContains: when.textContains ?? '',
    folder: then.folder ?? '',
    thenTopic: then.topic ?? '',
    project: then.project ?? '',
    tags: (then.tags ?? []).join(', '),
    renamePattern: then.renamePattern ?? '',
  };
}

const text = (value: string) => value.trim() || undefined;
const lines = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

export function ruleFromForm(form: RuleForm): Result<RuleDefinition> {
  const tags = form.tags
    .split(/[,;]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  const parsed = RuleDefinition.safeParse({
    when: {
      sender: text(form.sender),
      docType: text(form.docType),
      nameContains: text(form.nameContains),
      ext: text(form.ext),
      topic: text(form.topic),
      textContains: text(form.textContains),
    },
    then: {
      folder: text(form.folder),
      topic: text(form.thenTopic),
      project: text(form.project),
      tags: tags.length ? tags : undefined,
      renamePattern: text(form.renamePattern),
    },
  });
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error.issues[0]?.message ?? 'Ungültige Regel.' };
}

export function workflowToForm(data: unknown): WorkflowForm {
  const parsed = WorkflowDefinition.safeParse(data);
  if (!parsed.success) return emptyWorkflowForm();
  const { steps, parameters, scheduleWeekday } = parsed.data;
  return {
    steps: steps.join('\n'),
    parameters: parameters.map((p) => (p.description ? `${p.name}: ${p.description}` : p.name)).join('\n'),
    weekday: scheduleWeekday === null || scheduleWeekday === undefined ? '' : String(scheduleWeekday),
  };
}

export function workflowFromForm(form: WorkflowForm): Result<WorkflowDefinition> {
  const steps = lines(form.steps);
  if (steps.length === 0) return { ok: false, error: 'Ein Ablauf braucht mindestens einen Schritt.' };
  if (steps.length > 30) return { ok: false, error: 'Ein Ablauf hat höchstens 30 Schritte.' };
  const parameters = lines(form.parameters).map((line) => {
    const [name = '', ...rest] = line.split(':');
    return { name: name.trim(), description: rest.join(':').trim() };
  });
  if (parameters.some((parameter) => !parameter.name)) return { ok: false, error: 'Jeder Parameter braucht einen Namen.' };
  return { ok: true, value: WorkflowDefinition.parse({ steps, parameters, scheduleWeekday: form.weekday === '' ? null : Number(form.weekday) }) };
}

/** What the entry dialog edits; corrections are read-only apart from their text. */
export interface MemoryDraft {
  id: string | null;
  kind: MemoryKind;
  name: string;
  content: string;
  rule: RuleForm;
  workflow: WorkflowForm;
}

export const newDraft = (): MemoryDraft => ({
  id: null,
  kind: 'preference',
  name: '',
  content: '',
  rule: emptyRuleForm(),
  workflow: emptyWorkflowForm(),
});

export const draftOf = (entry: Pick<MemoryEntry, 'id' | 'kind' | 'name' | 'content'> & { data?: unknown }): MemoryDraft => ({
  id: entry.id,
  kind: entry.kind,
  name: entry.name,
  content: entry.content,
  rule: entry.kind === 'rule' ? ruleToForm(entry.data) : emptyRuleForm(),
  workflow: entry.kind === 'workflow' ? workflowToForm(entry.data) : emptyWorkflowForm(),
});

/** The structured part of a draft: undefined for kinds without one. */
export function dataOfDraft(draft: MemoryDraft): Result<RuleDefinition | WorkflowDefinition | undefined> {
  if (draft.kind === 'rule') return ruleFromForm(draft.rule);
  if (draft.kind === 'workflow') return workflowFromForm(draft.workflow);
  return { ok: true, value: undefined };
}

export const MEMORY_EXPORT_FILE = 'archivist-gelernt.json';

/** JSON text of the entries for the export file. */
export function exportMemory(entries: Array<Pick<MemoryEntry, 'kind' | 'name' | 'content' | 'enabled'> & { data?: unknown }>): string {
  return JSON.stringify(
    entries.map(({ kind, name, content, data, enabled }) => ({ kind, name, content, data: data ?? null, enabled })),
    null,
    2,
  );
}

/** Entries of an export file; items that are no valid entry are counted, not applied. */
export function parseMemoryImport(raw: string): Result<{ items: MemoryInput[]; skipped: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Die Datei ist kein gültiges JSON.' };
  }
  const items: MemoryInput[] = [];
  let skipped = 0;
  for (const item of Array.isArray(parsed) ? (parsed as unknown[]) : []) {
    const candidate = item && typeof item === 'object' && (item as { data?: unknown }).data === null ? { ...item, data: undefined } : item;
    const entry = MemoryInput.safeParse(candidate);
    if (entry.success) items.push(entry.data);
    else skipped += 1;
  }
  return { ok: true, value: { items, skipped } };
}
