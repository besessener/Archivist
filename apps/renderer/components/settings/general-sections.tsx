'use client';

import { useState } from 'react';
import { Save } from 'lucide-react';
import { Field } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { LOCAL_TIME, ThemeChoice } from '@archivist/shared';
import { THEME_LABELS } from '@/lib/labels';
import { Section, SwitchRow, useSaveSettings, type TabProps } from './shared';

export function ProfileSection({ settings, reload }: TabProps) {
  const { save, busy } = useSaveSettings(reload);
  const [name, setName] = useState(settings.profile.name);
  const [nicknames, setNicknames] = useState(settings.profile.nicknames.join(', '));
  const list = nicknames
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return (
    <Section
      title="Über dich"
      description="Dein Name und deine Spitznamen helfen Archivist, „ich“, „mir“ und „mich“ im Chat sowie Erwähnungen deiner Person richtig zuzuordnen. Sie werden nur als Kontext für die Auswertung deiner Chat-Nachrichten verwendet."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="profile-name">
          <Input id="profile-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} data-testid="settings-profile-name" />
        </Field>
        <Field label="Spitznamen (durch Komma getrennt)" htmlFor="profile-nicknames">
          <Input id="profile-nicknames" value={nicknames} onChange={(e) => setNicknames(e.target.value)} data-testid="settings-profile-nicknames" />
        </Field>
      </div>
      <div>
        <Button disabled={busy} onClick={() => void save({ profile: { name: name.trim(), nicknames: list } })} data-testid="settings-save">
          <Save aria-hidden /> Speichern
        </Button>
      </div>
    </Section>
  );
}

export function NotificationsSection({ settings, reload }: TabProps) {
  const { save, busy } = useSaveSettings(reload);
  const [reminderTime, setReminderTime] = useState(settings.notifications.reminderTime);
  const validTime = LOCAL_TIME.test(reminderTime);
  return (
    <Section
      title="Benachrichtigungen"
      description="Hinweise erscheinen immer in der Glocke oben rechts. Zusätzlich kannst du Desktop-Hinweise deines Betriebssystems erhalten."
    >
      <Field label="Uhrzeit für Erinnerungen (Ortszeit)" htmlFor="reminder-time" hint="Erinnerungen für einen Tag ohne Uhrzeit erscheinen zu dieser Uhrzeit.">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="reminder-time"
            type="time"
            className="w-36"
            value={reminderTime}
            onChange={(e) => setReminderTime(e.target.value)}
            data-testid="settings-reminder-time"
          />
          <Button
            variant="outline"
            disabled={busy || !validTime || reminderTime === settings.notifications.reminderTime}
            onClick={() => void save({ notifications: { reminderTime } })}
            data-testid="settings-reminder-time-save"
          >
            <Save aria-hidden /> Speichern
          </Button>
        </div>
      </Field>
      <SwitchRow label="Desktop-Benachrichtigungen" hint="Zeigt wichtige Hinweise auch außerhalb des Programmfensters an.">
        <Switch
          checked={settings.notifications.desktop}
          onCheckedChange={(v) => void save({ notifications: { desktop: v } })}
          aria-label="Desktop-Benachrichtigungen"
          data-testid="settings-desktop-notifications"
        />
      </SwitchRow>
    </Section>
  );
}

export function AppearanceSection({ settings, reload }: TabProps) {
  const { save, busy } = useSaveSettings(reload);
  return (
    <Section title="Darstellung" description="Hell, dunkel oder wie in deinem Betriebssystem eingestellt. Die Änderung gilt sofort.">
      <Field label="Farbschema" htmlFor="appearance-theme">
        <Select
          id="appearance-theme"
          className="sm:w-64"
          value={settings.appearance.theme}
          disabled={busy}
          onChange={(e) => void save({ appearance: { theme: ThemeChoice.parse(e.target.value) } })}
          data-testid="settings-theme"
        >
          {ThemeChoice.options.map((choice) => (
            <option key={choice} value={choice}>
              {THEME_LABELS[choice]}
            </option>
          ))}
        </Select>
      </Field>
    </Section>
  );
}
