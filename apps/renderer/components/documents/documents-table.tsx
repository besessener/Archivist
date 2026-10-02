'use client';

import type { Dispatch, SetStateAction } from 'react';
import type { EntrySubjects, IpcOutput } from '@archivist/shared';
import { ExtraSubjectsNote } from '@/components/common/extra-subjects';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDate } from '@/lib/format';
import { withMembership } from '@/lib/utils';
type ListedDocument = IpcOutput<'documents:list'>[number];

export interface DocumentsTableProps {
  documents: ListedDocument[];
  subjects: Record<string, EntrySubjects>;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  onOpen: (id: string) => void;
}

export function DocumentsTable({ documents, subjects, selected, setSelected, onOpen }: DocumentsTableProps) {
  const selectedCount = documents.filter((doc) => selected.has(doc.id)).length;
  const allChecked = documents.length > 0 && selectedCount === documents.length;
  const toggle = (id: string, on: boolean) => setSelected((previous) => withMembership(previous, { value: id, present: on }));
  return (
    <div className="rounded-xl border bg-card">
      <Table data-testid="documents-table">
        <THead>
          <tr>
            <TH className="w-8">
              <Checkbox
                checked={allChecked ? true : selectedCount > 0 ? 'indeterminate' : false}
                onCheckedChange={(checked) => setSelected(checked === true ? new Set(documents.map((doc) => doc.id)) : new Set())}
                aria-label="Alle angezeigten Dokumente auswählen"
                data-testid="documents-select-all"
              />
            </TH>
            <TH>Titel</TH>
            <TH>Typ</TH>
            <TH>Kategorie</TH>
            <TH>Thema</TH>
            <TH>Projekt</TH>
            <TH>Datum</TH>
            <TH>Pfad</TH>
          </tr>
        </THead>
        <TBody>
          {documents.map((doc) => (
            <TR key={doc.id} data-testid="document-row" data-selected={selected.has(doc.id) ? 'true' : undefined}>
              <TD>
                <Checkbox
                  checked={selected.has(doc.id)}
                  onCheckedChange={(checked) => toggle(doc.id, checked === true)}
                  aria-label={`${doc.title} auswählen`}
                  data-testid="document-select"
                />
              </TD>
              <TD className="max-w-xs">
                <button
                  type="button"
                  className="text-left font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => onOpen(doc.id)}
                >
                  {doc.title}
                </button>
              </TD>
              <TD>{doc.docType ?? '–'}</TD>
              <TD>{doc.categoryPath ?? '–'}</TD>
              <TD>
                {doc.topicName ?? '–'} <ExtraSubjectsNote subjects={subjects[doc.id]} />
              </TD>
              <TD>{doc.projectName ?? '–'}</TD>
              <TD className="whitespace-nowrap">
                {doc.documentDate ? (
                  formatDate(doc.documentDate)
                ) : (
                  <span className="text-muted-foreground" title="Dokumentdatum unbekannt – Datum der Archivierung">
                    {formatDate(doc.archivedAt ?? doc.createdAt)} (archiviert)
                  </span>
                )}
              </TD>
              <TD className="max-w-xs break-all text-xs text-muted-foreground">{doc.archivePath ?? doc.archiveRelPath ?? '–'}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
