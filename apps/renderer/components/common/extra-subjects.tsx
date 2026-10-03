'use client';

import { useEffect, useState } from 'react';
import type { EntrySubjects } from '@archivist/shared';
import { Field } from '@/components/common/states';
import { Input } from '@/components/ui/input';
import { call } from '@/lib/ipc';
import { useQuery } from '@/lib/use-query';
import { parseList } from '@/lib/utils';

const SCOPES = ['documents', 'decisions', 'openItems', 'events', 'knowledge'];
const join = (xs: Array<{ name: string }> | undefined) => (xs ?? []).map((x) => x.name).join(', ');

/** Further topics and projects of an entry in a form (#287); `save` stores them after the entry itself, as one undo step. */
export function useExtraSubjects(id: string | undefined, { open = true }: { open?: boolean } = {}) {
  const query = useQuery('subjects:of', id ? { ids: [id] } : undefined, { scopes: SCOPES, enabled: Boolean(id) && open });
  const current = id ? query.data?.[id] : undefined;
  const [topics, setTopics] = useState('');
  const [projects, setProjects] = useState('');
  const initialTopics = join(current?.extraTopics);
  const initialProjects = join(current?.extraProjects);
  useEffect(() => {
    setTopics(initialTopics);
    setProjects(initialProjects);
  }, [initialTopics, initialProjects, open]);
  const changed = topics.trim() !== initialTopics || projects.trim() !== initialProjects;
  return {
    topics,
    projects,
    setTopics,
    setProjects,
    changed,
    initialTopics,
    initialProjects,
    /** Stores the further topics/projects of the (new or edited) entry; nothing happens without a change. */
    save: async (entryId: string) => {
      if (!changed) return;
      await call('subjects:setExtras', { id: entryId, topics: parseList(topics), projects: parseList(projects) });
    },
  };
}

export function ExtraSubjectFields({
  idPrefix,
  topics,
  projects,
  setTopics,
  setProjects,
}: Record<string, unknown> & {
  idPrefix: string;
  topics: string;
  projects: string;
  setTopics: (v: string) => void;
  setProjects: (v: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Weitere Themen" htmlFor={`${idPrefix}-extra-topics`} hint="Optional, mit Komma trennen.">
        <Input id={`${idPrefix}-extra-topics`} value={topics} onChange={(e) => setTopics(e.target.value)} data-testid={`${idPrefix}-extra-topics`} />
      </Field>
      <Field label="Weitere Projekte" htmlFor={`${idPrefix}-extra-projects`} hint="Optional, mit Komma trennen.">
        <Input id={`${idPrefix}-extra-projects`} value={projects} onChange={(e) => setProjects(e.target.value)} data-testid={`${idPrefix}-extra-projects`} />
      </Field>
    </div>
  );
}

/** Further topics/projects of the entries of a list, in one query (#287). */
export function useSubjectsOf(ids: string[]): Record<string, EntrySubjects> {
  const q = useQuery('subjects:of', ids.length ? { ids: ids.slice(0, 1000) } : undefined, { scopes: SCOPES, enabled: ids.length > 0 });
  return q.data ?? {};
}

/** „+ Förderung, Sanierung 2026“ – the further topics and projects of a list entry. */
export function ExtraSubjectsNote({ subjects }: { subjects: EntrySubjects | undefined }) {
  const extra = [...(subjects?.extraTopics ?? []), ...(subjects?.extraProjects ?? [])];
  if (!extra.length) return null;
  return (
    <span className="text-xs text-muted-foreground" title="Weitere Themen und Projekte" data-testid="extra-subjects">
      + {extra.map((x) => x.name).join(', ')}
    </span>
  );
}
