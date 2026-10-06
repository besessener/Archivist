'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { IpcOutput } from '@archivist/shared';
import { ActionCard } from '@/components/common/action-card';
import { EntityChip } from '@/components/common/entity-chip';
import type { WikiResolver } from '@/components/common/markdown';
import { ErrorNote, Loading } from '@/components/common/states';
import { CaseAssignDialog } from '@/components/knowledge/case-dialog';
import { CaseView } from '@/components/knowledge/case-view';
import { EntityHeader, type EntityDialog } from '@/components/knowledge/entity-header';
import { EntityRelations } from '@/components/knowledge/entity-relations';
import { GraphView } from '@/components/knowledge/graph-view';
import { isMergeable, MergeDialog } from '@/components/knowledge/merge-dialog';
import { DeleteEntityDialog } from '@/components/knowledge/delete-dialog';
import { NoteEditDialog } from '@/components/knowledge/note-edit-dialog';
import { LinkDialog, LinkSuggestions, RelatedEntries } from '@/components/knowledge/related';
import { Button } from '@/components/ui/button';
import { ENTITY_TYPE_LABELS, entityHref } from '@/lib/nav';
import { useQuery } from '@/lib/use-query';
import type { ActionRecord } from '@/lib/types';

type EntityDetail = IpcOutput<'knowledge:getEntity'>;

/** In a note, [[Name]] leads to the entry its wiki-link relation points to (#285). */
function wikiResolverFor({ entity, relations }: EntityDetail): WikiResolver | undefined {
  if (entity.type !== 'note') return undefined;
  const targets = new Map(
    relations
      .filter((r) => r.direction === 'out' && r.method === 'wikilink' && r.evidence)
      .map((r) => [r.evidence!.slice(2, -2).trim().toLowerCase(), r.other] as const),
  );
  return (name) => {
    const other = targets.get(name.toLowerCase());
    return other ? { href: entityHref(other.type, other.id), title: `${ENTITY_TYPE_LABELS[other.type]} „${other.name}“` } : null;
  };
}

export function EntityView({ id }: { id: string }) {
  const detail = useQuery('knowledge:getEntity', { id }, { scopes: ['knowledge'] });
  const isTopic = detail.data?.entity.type === 'topic';
  const [dialog, setDialog] = useState<EntityDialog | null>(null);
  const [mergeAction, setMergeAction] = useState<ActionRecord | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const router = useRouter();

  if (detail.error && !detail.data) return <ErrorNote error={detail.error} onRetry={() => void detail.refetch()} />;
  if (!detail.data) return <Loading />;
  const { entity } = detail.data;
  const refetch = () => void detail.refetch();
  const dialogProps = (kind: EntityDialog) => ({ open: dialog === kind, onOpenChange: (open: boolean) => setDialog(open ? kind : null) });
  const closeAndRefetch = () => {
    setDialog(null);
    refetch();
  };

  return (
    <div className="flex flex-col gap-5" data-testid="entity-detail">
      <EntityHeader
        entity={entity}
        wiki={wikiResolverFor(detail.data)}
        graphOpen={graphOpen}
        onToggleGraph={() => setGraphOpen((open) => !open)}
        onOpenDialog={setDialog}
        onConfirmed={refetch}
      />

      {mergeAction && (
        <div data-testid="merge-action">
          <h3 className="mb-2 text-sm font-semibold">Vorschlag</h3>
          <ActionCard action={mergeAction} onResolved={refetch} />
        </div>
      )}

      {graphOpen && <GraphView id={entity.id} />}
      {entity.type === 'case' && <CaseView id={entity.id} />}
      <CaseAssignDialog entryIds={[entity.id]} {...dialogProps('case')} onDone={refetch} />

      <EntityRelations detail={detail.data} onChanged={refetch} />

      <RelatedEntries id={entity.id} scan={entity.type === 'note' || entity.type === 'event'} />
      <LinkSuggestions id={entity.id} />

      {isTopic && <TopicDocuments topicId={id} />}

      {entity.type === 'note' && <NoteEditDialog {...dialogProps('edit')} note={entity} onSaved={closeAndRefetch} />}
      <DeleteEntityDialog entity={entity} {...dialogProps('delete')} onDeleted={() => router.push('/knowledge/')} />

      <LinkDialog {...dialogProps('link')} sourceId={entity.id} sourceName={entity.name} onLinked={closeAndRefetch} />

      {isMergeable(entity.type) && (
        <MergeDialog
          {...dialogProps('merge')}
          source={{ id: entity.id, name: entity.name, type: entity.type }}
          onProposed={(action) => {
            setMergeAction(action);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function TopicDocuments({ topicId }: { topicId: string }) {
  const docs = useQuery('documents:forTopic', { topicId }, { scopes: ['documents', 'knowledge'] });
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">Zugeordnete Dokumente</h3>
      {docs.loading && !docs.data && <Loading />}
      {docs.data && docs.data.length === 0 && <p className="text-sm text-muted-foreground">Diesem Thema sind noch keine Dokumente zugeordnet.</p>}
      <ul className="flex flex-col gap-1.5" data-testid="topic-documents">
        {(docs.data ?? []).map((doc) => (
          <li key={doc.id}>
            <EntityChip type="document" id={doc.id} label={doc.title} detail={doc.summary} />
          </li>
        ))}
      </ul>
      <Button asChild variant="link" size="sm" className="mt-1 px-0">
        <Link href={`/documents/?topicId=${encodeURIComponent(topicId)}`}>Alle Dokumente zu diesem Thema ansehen</Link>
      </Button>
    </section>
  );
}
