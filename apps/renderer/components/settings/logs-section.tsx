'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { Field } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Section, useSaveSettings, type TabProps } from './shared';

export function LogsSection({ settings, reload }: TabProps) {
  const { save, busy } = useSaveSettings(reload);
  const [level, setLevel] = useState(settings.logs.level);
  const [days, setDays] = useState(String(settings.logs.retentionDays));
  return (
    <Section title="Protokolle" description="Technische Protokolle helfen bei der Fehlersuche. Inhalte deiner Dokumente werden dort nicht gespeichert.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Detailgrad" htmlFor="log-level">
          <Select id="log-level" value={level} onChange={(e) => setLevel(e.target.value as typeof level)} data-testid="settings-log-level">
            <option value="error">Nur Fehler</option>
            <option value="warn">Warnungen und Fehler</option>
            <option value="info">Normal</option>
            <option value="debug">Ausführlich (Fehlersuche)</option>
          </Select>
        </Field>
        <Field label="Aufbewahrung (Tage)" htmlFor="log-days">
          <Input id="log-days" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
      </div>
      <div>
        <Button
          disabled={busy || !(Number(days) >= 1)}
          onClick={() => void save({ logs: { level, retentionDays: Math.round(Number(days)) } })}
          data-testid="settings-save"
        >
          <Save aria-hidden /> Speichern
        </Button>
      </div>
    </Section>
  );
}
