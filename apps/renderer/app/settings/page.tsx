'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { JobsList } from '@/components/common/jobs-list';
import { Page, PageHeader } from '@/components/common/page-header';
import { ErrorNote, Loading } from '@/components/common/states';
import { AgentTab } from '@/components/settings/agent-tab';
import { ArchiveTab } from '@/components/settings/archive-tab';
import { LlmTab } from '@/components/settings/llm-tab';
import { AuditTab } from '@/components/settings/audit-tab';
import { BackupsTab } from '@/components/settings/backups-tab';
import { AppearanceTab, LogsTab, NotificationsTab, ProfileTab } from '@/components/settings/misc-tabs';
import { UpdatesTab } from '@/components/settings/updates-tab';
import { PrivacyTab } from '@/components/settings/privacy-tab';
import { Section } from '@/components/settings/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSettings } from '@/lib/use-settings';

const TABS = ['llm', 'agent', 'archive', 'privacy', 'general', 'maintenance', 'audit', 'jobs'];

// Former tab names from older deep links
const TAB_ALIASES: Record<string, string> = {
  profile: 'general',
  appearance: 'general',
  notifications: 'general',
  logs: 'maintenance',
  backups: 'maintenance',
  updates: 'maintenance',
};

function SettingsInner() {
  const { settings, hasApiKey, loading, error, refetch } = useSettings();
  const reload = refetch;
  const [tab, setTab] = useState('llm');
  const [focusRunId, setFocusRunId] = useState<string | null>(null);

  const params = useSearchParams();
  const wantedTab = params.get('tab');
  const wantedRun = params.get('run');

  // Deep links: ?tab=agent&run=<id> (e.g. from the notification of a background run)
  useEffect(() => {
    const resolvedTab = wantedTab ? (TAB_ALIASES[wantedTab] ?? wantedTab) : null;
    if (resolvedTab && TABS.includes(resolvedTab)) setTab(resolvedTab);
    setFocusRunId(wantedRun);
  }, [wantedTab, wantedRun]);

  return (
    <Page>
      <PageHeader title="Einstellungen" />
      {error && !settings && <ErrorNote error={error} onRetry={() => void reload()} />}
      {!settings && loading && <Loading />}
      {settings && (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList aria-label="Einstellungsbereiche">
            <TabsTrigger value="llm" data-testid="tab-llm">
              KI
            </TabsTrigger>
            <TabsTrigger value="agent" data-testid="tab-agent">
              Agent
            </TabsTrigger>
            <TabsTrigger value="archive" data-testid="tab-archive">
              Archiv
            </TabsTrigger>
            <TabsTrigger value="privacy" data-testid="tab-privacy">
              Datenschutz
            </TabsTrigger>
            <TabsTrigger value="general" data-testid="tab-general">
              Allgemein
            </TabsTrigger>
            <TabsTrigger value="maintenance" data-testid="tab-maintenance">
              Wartung
            </TabsTrigger>
            <TabsTrigger value="audit" data-testid="tab-audit">
              Änderungen
            </TabsTrigger>
            <TabsTrigger value="jobs" data-testid="tab-jobs">
              Verarbeitung
            </TabsTrigger>
          </TabsList>
          <TabsContent value="llm">
            <LlmTab key={JSON.stringify(settings.llm) + String(hasApiKey)} settings={settings} hasApiKey={hasApiKey} reload={reload} />
          </TabsContent>
          <TabsContent value="agent">
            <AgentTab key={focusRunId ?? ''} settings={settings} hasApiKey={hasApiKey} reload={reload} focusRunId={focusRunId} />
          </TabsContent>
          <TabsContent value="archive">
            <ArchiveTab
              key={JSON.stringify([settings.archiveRoot, settings.consistency, settings.ocr])}
              settings={settings}
              hasApiKey={hasApiKey}
              reload={reload}
            />
          </TabsContent>
          <TabsContent value="privacy">
            <PrivacyTab settings={settings} hasApiKey={hasApiKey} reload={reload} />
          </TabsContent>
          <TabsContent value="general" className="flex flex-col gap-4">
            <ProfileTab key={JSON.stringify(settings.profile)} settings={settings} hasApiKey={hasApiKey} reload={reload} />
            <AppearanceTab settings={settings} hasApiKey={hasApiKey} reload={reload} />
            <NotificationsTab key={JSON.stringify(settings.notifications)} settings={settings} hasApiKey={hasApiKey} reload={reload} />
          </TabsContent>
          <TabsContent value="maintenance" className="flex flex-col gap-4">
            <BackupsTab key={JSON.stringify(settings.backups)} settings={settings} hasApiKey={hasApiKey} reload={reload} />
            <UpdatesTab settings={settings} hasApiKey={hasApiKey} reload={reload} />
            <LogsTab key={JSON.stringify(settings.logs)} settings={settings} hasApiKey={hasApiKey} reload={reload} />
          </TabsContent>
          <TabsContent value="audit">
            <AuditTab />
          </TabsContent>
          <TabsContent value="jobs">
            <Section title="Verarbeitung" description="Analysen, Importe und Suchläufe. Fehlgeschlagene Aufgaben kannst du hier erneut starten.">
              <JobsList limit={100} />
            </Section>
          </TabsContent>
        </Tabs>
      )}
    </Page>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <SettingsInner />
    </Suspense>
  );
}
