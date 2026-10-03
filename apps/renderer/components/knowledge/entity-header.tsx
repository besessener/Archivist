'use client';

import type { IpcOutput } from '@archivist/shared';
import { Check, FolderKanban, GitMerge, Link2, Pencil, Trash2, Waypoints } from 'lucide-react';
import { EntityIcon } from '@/components/common/entity-chip';
import { Markdown, type WikiResolver } from '@/components/common/markdown';
import { CASE_ENTRY_TYPES } from '@/components/knowledge/case-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { call } from '@/lib/ipc';
import { formatDate } from '@/lib/format';
import { ENTITY_TYPE_LABELS } from '@/lib/nav';
import { useRun } from '@/lib/use-run';

type Entity = IpcOutput<'knowledge:getEntity'>['entity'];

export type EntityDialog = 'link' | 'case' | 'edit' | 'merge' | 'delete';

export interface EntityHeaderProps {
  entity: Entity;
  wiki: WikiResolver | undefined;
  graphOpen: boolean;
  onToggleGraph: () => void;
  onOpenDialog: (dialog: EntityDialog) => void;
  onConfirmed: () => void;
}

export function EntityHeader(props: EntityHeaderProps) {
  const { entity, wiki } = props;
  return (
    <div>
      <EntityBadges entity={entity} />
      <h2 className="mt-1 text-2xl font-semibold tracking-tight">{entity.name}</h2>
      {entity.description && <Markdown text={entity.description} className="mt-2 text-muted-foreground" testId="entity-description" wiki={wiki} />}
      {entity.roles.length > 0 && <p className="mt-2 text-sm text-muted-foreground">Rollen: {entity.roles.join(', ')}</p>}
      {entity.unconfirmed && <UnconfirmedNote entity={entity} onConfirmed={props.onConfirmed} />}
      <EntityActions {...props} />
    </div>
  );
}

function EntityBadges({ entity }: { entity: Entity }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="info">
        <EntityIcon type={entity.type} className="size-3" /> {ENTITY_TYPE_LABELS[entity.type]}
      </Badge>
      {entity.isSelf && (
        <Badge variant="success" data-testid="entity-self" title="Das bist du (Einstellungen → Über dich)">
          Du
        </Badge>
      )}
      {entity.unconfirmed && (
        <Badge
          variant="outline"
          data-testid="entity-unconfirmed"
          title="Aus einem Dokument übernommen. Bis du es bestätigst, nennt Archivist es der KI nicht als bekanntes Thema."
        >
          unbestätigt
        </Badge>
      )}
      {entity.duplicateOfId && (
        <Badge variant="outline" data-testid="entity-duplicate">
          verworfen (Duplikat)
        </Badge>
      )}
      <span className="text-xs text-muted-foreground">Aktualisiert {formatDate(entity.updatedAt)}</span>
    </div>
  );
}

function UnconfirmedNote({ entity, onConfirmed }: { entity: Entity; onConfirmed: () => void }) {
  const { run } = useRun();
  return (
    <div className="mt-3 rounded-md border border-dashed p-3 text-sm" data-testid="entity-unconfirmed-note">
      <p className="text-muted-foreground">
        Dieser Name wurde aus einem Dokument übernommen. Erst wenn du ihn bestätigst, nennt Archivist ihn der KI als bekanntes{' '}
        {entity.type === 'project' ? 'Projekt' : 'Thema'}.
      </p>
      <Button
        size="sm"
        variant="outline"
        className="mt-2"
        data-testid="entity-confirm"
        onClick={async () => {
          const confirmed = await run(() => call('knowledge:confirmEntity', { id: entity.id }), { success: 'Bestätigt.' });
          if (confirmed) onConfirmed();
        }}
      >
        <Check aria-hidden /> Bestätigen
      </Button>
    </div>
  );
}

function EntityActions({ entity, graphOpen, onToggleGraph, onOpenDialog }: EntityHeaderProps) {
  const active = !entity.duplicateOfId;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => onOpenDialog('link')} data-testid="knowledge-link">
        <Link2 aria-hidden /> Verknüpfen
      </Button>
      <Button variant={graphOpen ? 'secondary' : 'outline'} size="sm" onClick={onToggleGraph} aria-pressed={graphOpen} data-testid="knowledge-graph">
        <Waypoints aria-hidden /> Graph
      </Button>
      {CASE_ENTRY_TYPES.has(entity.type) && active && (
        <Button variant="outline" size="sm" onClick={() => onOpenDialog('case')} data-testid="knowledge-case">
          <FolderKanban aria-hidden /> Zu Vorgang hinzufügen
        </Button>
      )}
      {entity.type === 'note' && active && (
        <Button variant="outline" size="sm" onClick={() => onOpenDialog('edit')} data-testid="note-edit">
          <Pencil aria-hidden /> Bearbeiten
        </Button>
      )}
      {entity.type === 'note' && active && (
        <Button variant="outline" size="sm" onClick={() => onOpenDialog('delete')} data-testid="note-delete">
          <Trash2 aria-hidden /> Löschen
        </Button>
      )}
      {entity.type === 'topic' && (
        <Button variant="outline" size="sm" onClick={() => onOpenDialog('merge')} data-testid="knowledge-merge">
          <GitMerge aria-hidden /> Mit anderem Thema zusammenführen vorschlagen
        </Button>
      )}
    </div>
  );
}
