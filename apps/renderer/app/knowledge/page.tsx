'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { KnowledgeCreateResult } from '@archivist/shared';
import { Plus } from 'lucide-react';
import { EventFormDialog } from '@/components/events/event-form-dialog';
import { CreateEntityDialog } from '@/components/knowledge/create-entity-dialog';
import { EntityListPanel, useEntityList } from '@/components/knowledge/entity-list';
import { EntityView } from '@/components/knowledge/entity-view';
import { Page, PageHeader } from '@/components/common/page-header';
import { EmptyState, Loading } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { ENTITY_TYPE_LABELS } from '@/lib/nav';
import { useRun } from '@/lib/use-run';
import { useToast } from '@/lib/toast';

function KnowledgeInner() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id');
  const entityList = useEntityList();
  const [createOpen, setCreateOpen] = useState(false);
  const [createKey, setCreateKey] = useState(0);
  /** Initial title of the open event dialog; null = closed. */
  const [eventSeed, setEventSeed] = useState<string | null>(null);
  const { run } = useRun();
  const { toast } = useToast();

  const showResult = ({ entity, created }: KnowledgeCreateResult) => {
    const label = ENTITY_TYPE_LABELS[entity.type];
    if (created) toast({ variant: 'success', title: `${label} angelegt.` });
    else toast({ variant: 'info', title: `${label} „${entity.name}“ existiert bereits.`, description: 'Der vorhandene Eintrag wurde geöffnet.' });
    void entityList.list.refetch();
    router.push(`/knowledge/?id=${encodeURIComponent(entity.id)}`);
  };

  return (
    <Page wide className="lg:flex lg:h-full lg:flex-col">
      <PageHeader
        title="Wissen"
        description="Alles, was Archivist über deine Themen, Projekte und Personen weiß – und wie es zusammenhängt."
        actions={
          <Button
            onClick={() => {
              setCreateKey((key) => key + 1);
              setCreateOpen(true);
            }}
            data-testid="knowledge-create"
          >
            <Plus aria-hidden /> Neu anlegen
          </Button>
        }
      />
      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[20rem_1fr] lg:grid-rows-[minmax(0,1fr)]">
        <EntityListPanel state={entityList} selectedId={id} />
        <div className="min-w-0 lg:overflow-y-auto">
          {id ? (
            <EntityView key={id} id={id} />
          ) : (
            <EmptyState title="Wähle einen Eintrag" description="Klicke links auf ein Thema, Projekt oder eine Person, um die Verknüpfungen zu sehen." />
          )}
        </div>
      </div>
      <CreateEntityDialog
        key={`c-${createKey}`}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onResult={showResult}
        onPickEvent={(title) => {
          setCreateOpen(false);
          setEventSeed(title);
        }}
      />
      <EventFormDialog
        key={`e-${eventSeed ?? ''}`}
        open={eventSeed !== null}
        onOpenChange={(open) => !open && setEventSeed(null)}
        initialTitle={eventSeed ?? ''}
        onSubmit={async (input) => {
          const result = await run(() => call('knowledge:createEntity', { type: 'event', ...input }));
          if (result) showResult(result);
          return result?.entity.id ?? false;
        }}
      />
    </Page>
  );
}

export default function KnowledgePage() {
  return (
    <Suspense fallback={<Loading />}>
      <KnowledgeInner />
    </Suspense>
  );
}
