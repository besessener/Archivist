'use client';

import type { Settings, SettingsPatch } from '@archivist/shared';
import { call } from '@/lib/ipc';
import { useRun } from '@/lib/use-run';

export interface TabProps {
  settings: Settings;
  hasApiKey: boolean;
  reload: () => void;
}

/** Speichert ein Settings-Patch mit Toast-Rückmeldung. */
export function useSaveSettings(reload: () => void) {
  const { run, busy } = useRun();
  async function save(patch: SettingsPatch, success = 'Einstellungen gespeichert.'): Promise<boolean> {
    const out = await run(() => call('settings:update', patch), { success });
    if (out) reload();
    return !!out;
  }
  return { save, busy };
}

export function Section({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

export function SwitchRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
