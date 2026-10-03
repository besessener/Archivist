'use client';

import type { useExtraSubjects } from '@/components/common/extra-subjects';
import { ExtraSubjectFields } from '@/components/common/extra-subjects';
import { Field } from '@/components/common/states';
import { coverageNotes, DocCoverage } from '@/components/inbox/doc-coverage';
import { Input } from '@/components/ui/input';
import { formatDate, formatDateTime } from '@/lib/format';
import type { DocRecord } from '@/lib/types';
import { PathText } from '@/components/common/path-text';

type ExtraSubjects = ReturnType<typeof useExtraSubjects>;

export function DocumentMeta({ doc, extra }: { doc: DocRecord; extra: ExtraSubjects }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]" data-testid="document-meta">
      <dt className="text-muted-foreground">Kategorie</dt>
      <dd>{doc.categoryPath ?? '–'}</dd>
      <dt className="text-muted-foreground">Thema</dt>
      <dd>{doc.topicName ?? '–'}</dd>
      <dt className="text-muted-foreground">Projekt</dt>
      <dd>{doc.projectName ?? '–'}</dd>
      {(extra.initialTopics || extra.initialProjects) && (
        <>
          <dt className="text-muted-foreground">Weitere Themen/Projekte</dt>
          <dd data-testid="document-extra-subjects">{[extra.initialTopics, extra.initialProjects].filter(Boolean).join(', ')}</dd>
        </>
      )}
      <dt className="text-muted-foreground">Personen</dt>
      <dd>{doc.persons.length ? doc.persons.join(', ') : '–'}</dd>
      <dt className="text-muted-foreground">Schlagwörter</dt>
      <dd>{doc.tags.length ? doc.tags.join(', ') : '–'}</dd>
      <dt className="text-muted-foreground">Dokumentdatum</dt>
      <dd>{formatDate(doc.documentDate, 'unbekannt')}</dd>
      <dt className="text-muted-foreground">Datumsangaben</dt>
      <dd>{doc.dates.length ? doc.dates.map((date) => formatDate(date, date)).join(', ') : '–'}</dd>
      <dt className="text-muted-foreground">Archiviert am</dt>
      <dd>{formatDateTime(doc.archivedAt)}</dd>
      <dt className="text-muted-foreground">Pfad</dt>
      <dd className="text-xs">
        <PathText path={doc.archivePath ?? '–'} />
      </dd>
      {doc.proposal && coverageNotes(doc.proposal).length > 0 && (
        <>
          <dt className="text-muted-foreground">Analyse</dt>
          <dd>
            <DocCoverage proposal={doc.proposal} />
          </dd>
        </>
      )}
      <dt className="text-muted-foreground">Prüfsumme</dt>
      <dd className="break-all font-mono text-xs">{doc.sha256}</dd>
    </dl>
  );
}

export interface MetadataForm {
  title: string;
  setTitle: (value: string) => void;
  topic: string;
  setTopic: (value: string) => void;
  project: string;
  setProject: (value: string) => void;
  tags: string;
  setTags: (value: string) => void;
  persons: string;
  setPersons: (value: string) => void;
}

export function DocumentEditFields({ form, extra }: { form: MetadataForm; extra: ExtraSubjects }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="document-edit">
      <Field label="Titel" htmlFor="doc-title" className="sm:col-span-2">
        <Input id="doc-title" value={form.title} onChange={(e) => form.setTitle(e.target.value)} data-testid="doc-edit-title" />
      </Field>
      <Field label="Thema" htmlFor="doc-topic">
        <Input id="doc-topic" value={form.topic} onChange={(e) => form.setTopic(e.target.value)} data-testid="doc-edit-topic" />
      </Field>
      <Field label="Projekt" htmlFor="doc-project">
        <Input id="doc-project" value={form.project} onChange={(e) => form.setProject(e.target.value)} data-testid="doc-edit-project" />
      </Field>
      <Field label="Schlagwörter" htmlFor="doc-tags" hint="Mit Komma trennen.">
        <Input id="doc-tags" value={form.tags} onChange={(e) => form.setTags(e.target.value)} />
      </Field>
      <Field label="Personen" htmlFor="doc-persons" hint="Mit Komma trennen.">
        <Input id="doc-persons" value={form.persons} onChange={(e) => form.setPersons(e.target.value)} />
      </Field>
      <div className="sm:col-span-2">
        <ExtraSubjectFields idPrefix="doc" {...extra} />
      </div>
    </div>
  );
}
