'use client';

import { Field } from '@/components/common/states';
import { Input } from '@/components/ui/input';
import { LIMIT_KINDS, type KindLimitsForm } from './settings-parse';

/** Own rounds, tokens and time per background trigger; empty fields use the general background limits (#313). */
export function KindLimitsFields({ value, onChange }: { value: KindLimitsForm; onChange: (value: KindLimitsForm) => void }) {
  return (
    <fieldset className="rounded-lg border p-3" data-testid="agent-kind-limits">
      <legend className="px-1 text-sm font-medium">Grenzen je Hintergrundaufgabe</legend>
      <p className="text-xs text-muted-foreground">
        Leere Felder gelten wie „Grenzen im Hintergrund“. So bleibt z. B. die Archivprüfung kleiner als das Einsortieren.
      </p>
      <div className="mt-2 flex flex-col gap-3">
        {LIMIT_KINDS.map(([kind, label]) => {
          const set = (change: Partial<KindLimitsForm[typeof kind]>) => onChange({ ...value, [kind]: { ...value[kind], ...change } });
          return (
            <div key={kind} role="group" aria-label={label} className="grid items-end gap-2 sm:grid-cols-[1.4fr_1fr_1fr_1fr]">
              <p className="text-sm">{label}</p>
              <Field label="Runden" htmlFor={`agent-kind-${kind}-rounds`}>
                <Input
                  id={`agent-kind-${kind}-rounds`}
                  type="number"
                  min={1}
                  max={1000}
                  value={value[kind].rounds}
                  onChange={(e) => set({ rounds: e.target.value })}
                />
              </Field>
              <Field label="Tokens" htmlFor={`agent-kind-${kind}-tokens`}>
                <Input
                  id={`agent-kind-${kind}-tokens`}
                  type="number"
                  min={5000}
                  max={50000000}
                  step={1000}
                  value={value[kind].tokens}
                  onChange={(e) => set({ tokens: e.target.value })}
                />
              </Field>
              <Field label="Minuten" htmlFor={`agent-kind-${kind}-minutes`}>
                <Input
                  id={`agent-kind-${kind}-minutes`}
                  type="number"
                  min={1}
                  max={1440}
                  value={value[kind].minutes}
                  onChange={(e) => set({ minutes: e.target.value })}
                />
              </Field>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
