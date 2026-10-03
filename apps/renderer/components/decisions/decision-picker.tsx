'use client';

import { useState } from 'react';
import { ACTIVE_DECISION_STATUSES } from '@archivist/shared';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { formatLongDate } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { useQuery } from '@/lib/use-query';

const RECENT_COUNT = 100;
const SEARCH_COUNT = 30;

interface DecisionPickerProps {
  /** The decision that is replaced; it cannot be its own successor. */
  excludeId: string;
  open: boolean;
  value: string;
  onChange: (id: string) => void;
  selectId: string;
  testId: string;
}

/** Picks one valid decision: the newest ones, or the hits of a search – never the whole list. */
export function DecisionPicker({ excludeId, open, value, onChange, selectId, testId }: DecisionPickerProps) {
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 300);
  const recent = useQuery('decisions:list', { statuses: ACTIVE_DECISION_STATUSES, limit: RECENT_COUNT }, { scopes: ['decisions'], enabled: open && !query });
  const found = useQuery('decisions:search', { query: query || 'x', limit: SEARCH_COUNT }, { scopes: ['decisions'], enabled: open && !!query });
  const options = (query ? found : recent).data ?? [];
  return (
    <div className="flex flex-col gap-2">
      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Entscheidungen durchsuchen …" aria-label="Entscheidungen durchsuchen" />
      <Select id={selectId} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        <option value="">Entscheidung wählen …</option>
        {options
          .filter((decision) => decision.id !== excludeId && ACTIVE_DECISION_STATUSES.includes(decision.status))
          .map((decision) => (
            <option key={decision.id} value={decision.id}>
              {(decision.title || decision.decisionText).slice(0, 80)} ({formatLongDate(decision.decidedAt, 'ohne Datum')})
            </option>
          ))}
      </Select>
    </div>
  );
}
