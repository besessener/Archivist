'use client';

import { useState } from 'react';
import { AgentMemoryList } from '@/components/agent/memory-list';
import { AgentRunsList } from '@/components/agent/runs-list';
import { AgentSettingsForm } from '@/components/agent/settings-form';
import { AgentUsageTable } from '@/components/agent/usage-table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { TabProps } from './shared';

/** Settings tab „Agent“: settings, runs (#299), usage (#302) and what Archivist has learned (#315). */
export function AgentTab({ settings, hasApiKey, reload, focusRunId }: TabProps & { focusRunId?: string | null }) {
  const [section, setSection] = useState(focusRunId ? 'runs' : 'settings');
  return (
    <Tabs value={section} onValueChange={setSection}>
      <TabsList aria-label="Agent-Bereiche">
        <TabsTrigger value="settings" data-testid="agent-tab-settings">
          Einstellungen
        </TabsTrigger>
        <TabsTrigger value="runs" data-testid="agent-tab-runs">
          Agentenläufe
        </TabsTrigger>
        <TabsTrigger value="usage" data-testid="agent-tab-usage">
          Verbrauch
        </TabsTrigger>
        <TabsTrigger value="memory" data-testid="agent-tab-memory">
          Was Archivist gelernt hat
        </TabsTrigger>
      </TabsList>
      <TabsContent value="settings">
        <AgentSettingsForm key={JSON.stringify(settings.agent)} settings={settings} hasApiKey={hasApiKey} reload={reload} />
      </TabsContent>
      <TabsContent value="runs">
        <AgentRunsList focusRunId={focusRunId} />
      </TabsContent>
      <TabsContent value="usage">
        <AgentUsageTable />
      </TabsContent>
      <TabsContent value="memory">
        <AgentMemoryList />
      </TabsContent>
    </Tabs>
  );
}
