'use client';

import { JobsList } from '@/components/common/jobs-list';
import { Page, PageHeader } from '@/components/common/page-header';
import { ErrorNote, Loading } from '@/components/common/states';
import { ArchiveTab } from '@/components/settings/archive-tab';
import { LlmTab } from '@/components/settings/llm-tab';
import { AuditTab, BackupsTab, LogsTab, NotificationsTab, ProfileTab } from '@/components/settings/misc-tabs';
import { PrivacyTab } from '@/components/settings/privacy-tab';
import { Section } from '@/components/settings/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSettings } from '@/lib/use-settings';

export default function SettingsPage() {
  const { settings, hasApiKey, loading, error, refetch } = useSettings();
  const reload = () => void refetch();

  return (
    <Page>
      <PageHeader title="Einstellungen" />
      {error && !settings && <ErrorNote error={error} onRetry={reload} />}
      {!settings && loading && <Loading />}
      {settings && (
        <Tabs defaultValue="llm">
          <TabsList aria-label="Einstellungsbereiche">
            <TabsTrigger value="llm" data-testid="tab-llm">
              KI
            </TabsTrigger>
            <TabsTrigger value="archive" data-testid="tab-archive">
              Archiv
            </TabsTrigger>
            <TabsTrigger value="privacy" data-testid="tab-privacy">
              Datenschutz
            </TabsTrigger>
            <TabsTrigger value="profile" data-testid="tab-profile">
              Über dich
            </TabsTrigger>
            <TabsTrigger value="notifications" data-testid="tab-notifications">
              Benachrichtigungen
            </TabsTrigger>
            <TabsTrigger value="logs" data-testid="tab-logs">
              Protokolle
            </TabsTrigger>
            <TabsTrigger value="backups" data-testid="tab-backups">
              Backups
            </TabsTrigger>
            <TabsTrigger value="audit" data-testid="tab-audit">
              Änderungsprotokoll
            </TabsTrigger>
            <TabsTrigger value="jobs" data-testid="tab-jobs">
              Verarbeitung
            </TabsTrigger>
          </TabsList>
          <TabsContent value="llm">
            <LlmTab key={JSON.stringify(settings.llm) + String(hasApiKey)} settings={settings} hasApiKey={hasApiKey} reload={reload} />
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
          <TabsContent value="profile">
            <ProfileTab key={JSON.stringify(settings.profile)} settings={settings} hasApiKey={hasApiKey} reload={reload} />
          </TabsContent>
          <TabsContent value="notifications">
            <NotificationsTab key={JSON.stringify(settings.notifications)} settings={settings} hasApiKey={hasApiKey} reload={reload} />
          </TabsContent>
          <TabsContent value="logs">
            <LogsTab key={JSON.stringify(settings.logs)} settings={settings} hasApiKey={hasApiKey} reload={reload} />
          </TabsContent>
          <TabsContent value="backups">
            <BackupsTab key={JSON.stringify(settings.backups)} settings={settings} hasApiKey={hasApiKey} reload={reload} />
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
