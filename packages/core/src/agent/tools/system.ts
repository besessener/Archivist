import { z } from 'zod';
import type { Settings, ToolRisk } from '@archivist/shared';
import { defineTool, type AgentTool } from '../registry';
import type { ToolDeps } from './common';

/** Undo type of a settings change made by the agent („Stell den Agenten auf Fragen“). */
export const SETTING_UNDO_TYPE = 'settings.field';

interface SettingSpec {
  label: string;
  risk: ToolRisk;
  schema: z.ZodType;
}

/**
 * Settings the agent may change on request (#312). Privacy settings, the mass action threshold and automatic analysis
 * are critical: they always ask (#298). Everything else is an ordinary, undoable change.
 */
const SETTINGS: Record<string, SettingSpec> = {
  'agent.mode': { label: 'Agentenmodus', risk: 'write', schema: z.enum(['auto', 'ask']) },
  'agent.massActionThreshold': { label: 'Schwelle für Massenaktionen', risk: 'critical', schema: z.coerce.number().int().min(1) },
  'agent.effort': { label: 'Denktiefe', risk: 'write', schema: z.enum(['low', 'medium', 'high', 'xhigh', 'max']) },
  'agent.learning': { label: 'Gelerntes verwenden', risk: 'write', schema: z.boolean() },
  'agent.background.inbox': { label: 'Eingang im Hintergrund sortieren', risk: 'write', schema: z.boolean() },
  'agent.background.archiveCheck': { label: 'Agentische Archivprüfung', risk: 'write', schema: z.boolean() },
  'agent.background.links': { label: 'Verknüpfungsvorschläge im Hintergrund', risk: 'write', schema: z.boolean() },
  'agent.background.deadlineWatch': { label: 'Fristen-Wächter', risk: 'write', schema: z.boolean() },
  'agent.background.deadlineLeadDays': { label: 'Vorlauf des Fristen-Wächters (Tage)', risk: 'write', schema: z.coerce.number().int().min(1).max(365) },
  'agent.background.weeklyReview': { label: 'Wochenrückblick', risk: 'write', schema: z.boolean() },
  'agent.background.weeklyReviewDay': { label: 'Wochentag des Rückblicks (0 = Sonntag)', risk: 'write', schema: z.coerce.number().int().min(0).max(6) },
  'scan.enabled': { label: 'Dokumentensuche', risk: 'write', schema: z.boolean() },
  'scan.periodic': { label: 'Regelmäßige Suche', risk: 'write', schema: z.boolean() },
  'scan.intervalMinutes': { label: 'Suchintervall (Minuten)', risk: 'write', schema: z.coerce.number().int().min(5) },
  'scan.autoAnalyze': { label: 'Neue Dateien automatisch analysieren', risk: 'critical', schema: z.boolean() },
  'privacy.llmMode': { label: 'Datenschutzmodus', risk: 'critical', schema: z.enum(['auto', 'confirm', 'local_only']) },
  'privacy.neverAnalyzeDirs': { label: 'Nie analysierte Verzeichnisse', risk: 'critical', schema: z.array(z.string()) },
  'privacy.neverAnalyzeExtensions': { label: 'Nie analysierte Dateitypen', risk: 'critical', schema: z.array(z.string()) },
  'privacy.neverAnalyzeFiles': { label: 'Nie analysierte Dateien', risk: 'critical', schema: z.array(z.string()) },
  'consistency.intervalHours': { label: 'Intervall der Archivprüfung (Stunden)', risk: 'write', schema: z.coerce.number().min(0) },
  'notifications.reminderTime': { label: 'Uhrzeit für Erinnerungen ohne Uhrzeit', risk: 'write', schema: z.string().regex(/^\d{2}:\d{2}$/) },
};

function readSetting(s: Settings, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), s);
}

/** Patch for one dotted key (`agent.background.inbox` → { agent: { background: { inbox } } }). */
export function settingPatch(key: string, value: unknown): Record<string, unknown> {
  const parts = key.split('.');
  return parts.reduceRight<unknown>((acc, k) => ({ [k]: acc }), value) as Record<string, unknown>;
}

export function registerSettingUndo(deps: Pick<ToolDeps, 'settings' | 'undo'>): void {
  deps.undo.register(SETTING_UNDO_TYPE, {
    check: async (data) => {
      const d = data as { key: string; after: unknown };
      return JSON.stringify(readSetting(deps.settings.get(), d.key)) === JSON.stringify(d.after) ? [] : ['Die Einstellung wurde seither erneut geändert.'];
    },
    run: async (data) => {
      const d = data as { key: string; before: unknown };
      deps.settings.update(settingPatch(d.key, d.before));
      return 'Einstellung zurückgesetzt.';
    },
  });
}

export function systemTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      name: 'set_setting',
      description: `Eine Einstellung auf Wunsch des Benutzers ändern. Erlaubte Schlüssel: ${Object.entries(SETTINGS)
        .map(([k, v]) => `${k} (${v.label})`)
        .join(', ')}. Datenschutz-Einstellungen fragen immer nach.`,
      schema: z.object({ key: z.enum(Object.keys(SETTINGS) as [string, ...string[]]), value: z.unknown() }),
      risk: (a) => SETTINGS[a.key]?.risk ?? 'critical',
      label: (a) => `Ändere die Einstellung „${SETTINGS[a.key]?.label ?? a.key}“`,
      run: async (a) => {
        const spec = SETTINGS[a.key]!;
        const parsed = spec.schema.safeParse(a.value);
        if (!parsed.success) return { content: `Ungültiger Wert für ${a.key}: ${parsed.error.issues[0]?.message ?? ''}`, isError: true };
        const before = readSetting(deps.settings.get(), a.key);
        deps.settings.update(settingPatch(a.key, parsed.data));
        deps.audit.log({
          action: 'settings.change',
          actor: 'agent',
          trigger: 'agent',
          confirmed: true,
          before: { [a.key]: before },
          after: { [a.key]: parsed.data },
          undo: { type: SETTING_UNDO_TYPE, data: { key: a.key, before, after: parsed.data } },
        });
        return {
          content: `${spec.label}: ${JSON.stringify(before)} → ${JSON.stringify(parsed.data)}.`,
          summary: 'geändert',
          change: `Einstellung „${spec.label}“ geändert`,
        };
      },
    }),
    defineTool({
      name: 'run_archive_check',
      description: 'Die Archivprüfung starten (Hintergrundauftrag). Die Befunde erscheinen danach als Hinweise (list_entries kind=insight).',
      schema: z.object({}),
      risk: 'write',
      label: () => 'Starte die Archivprüfung',
      run: async () => {
        deps.enqueueConsistency('agent');
        return { content: 'Archivprüfung gestartet; die Hinweise erscheinen in wenigen Augenblicken.', summary: 'gestartet' };
      },
    }),
  ];
}
