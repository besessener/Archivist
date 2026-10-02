'use client';

import { useMemo, useState } from 'react';
import { ErrorNote, Field, Loading } from '@/components/common/states';
import { Section } from '@/components/settings/shared';
import { Select } from '@/components/ui/select';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { formatDate, formatNumber } from '@/lib/format';
import { useQuery } from '@/lib/use-query';
import { formatCost, formatTokens } from './run-utils';

interface Cell {
  runs: number;
  tokens: number;
  costUsd: number;
}
interface Row {
  key: string;
  chat: Cell;
  background: Cell;
}
type Entry = { trigger: 'chat' | 'background' } & Cell;

const empty = (): Cell => ({ runs: 0, tokens: 0, costUsd: 0 });
const add = (a: Cell, b: Cell): Cell => ({ runs: a.runs + b.runs, tokens: a.tokens + b.tokens, costUsd: a.costUsd + b.costUsd });

function group(entries: Array<Entry & { key: string }>): Row[] {
  const map = new Map<string, Row>();
  for (const e of entries) {
    const row = map.get(e.key) ?? { key: e.key, chat: empty(), background: empty() };
    row[e.trigger] = add(row[e.trigger], e);
    map.set(e.key, row);
  }
  return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
}

const MONTH = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });
function monthLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(key);
  return m ? MONTH.format(new Date(Number(m[1]), Number(m[2]) - 1, 1)) : key;
}

function CellView({ c }: { c: Cell }) {
  if (c.runs === 0) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="whitespace-nowrap">
      {formatNumber(c.runs)} · {formatTokens(c.tokens)} · {formatCost(c.costUsd)}
    </span>
  );
}

function UsageRows({ caption, rows, label }: { caption: string; rows: Row[]; label: (key: string) => string }) {
  const total = rows.reduce((acc, r) => ({ chat: add(acc.chat, r.chat), background: add(acc.background, r.background) }), {
    chat: empty(),
    background: empty(),
  });
  return (
    <Table>
      <caption className="mb-2 text-left text-sm font-medium text-foreground [caption-side:top]">{caption}</caption>
      <THead>
        <TR>
          <TH scope="col">Zeitraum</TH>
          <TH scope="col">Chat (Läufe · Tokens · Kosten)</TH>
          <TH scope="col">Hintergrund</TH>
          <TH scope="col">Zusammen</TH>
        </TR>
      </THead>
      <TBody>
        {rows.length === 0 && (
          <TR>
            <TD colSpan={4} className="text-muted-foreground">
              Kein Verbrauch in diesem Zeitraum.
            </TD>
          </TR>
        )}
        {rows.map((r) => (
          <TR key={r.key}>
            <TH scope="row" className="font-normal">
              {label(r.key)}
            </TH>
            <TD>
              <CellView c={r.chat} />
            </TD>
            <TD>
              <CellView c={r.background} />
            </TD>
            <TD>
              <CellView c={add(r.chat, r.background)} />
            </TD>
          </TR>
        ))}
        {rows.length > 0 && (
          <TR className="font-medium">
            <TH scope="row">Summe</TH>
            <TD>
              <CellView c={total.chat} />
            </TD>
            <TD>
              <CellView c={total.background} />
            </TD>
            <TD>
              <CellView c={add(total.chat, total.background)} />
            </TD>
          </TR>
        )}
      </TBody>
    </Table>
  );
}

/** Usage per day and month, split into chat and background (#302) – information only. */
export function AgentUsageTable() {
  const [days, setDays] = useState(31);
  const q = useQuery('agent:usage', { days }, { scopes: ['agent'] });
  const dayRows = useMemo(() => group((q.data?.days ?? []).map((d) => ({ ...d, key: d.day }))), [q.data]);
  const monthRows = useMemo(() => group((q.data?.months ?? []).map((m) => ({ ...m, key: m.month }))), [q.data]);

  return (
    <Section title="Verbrauch" description="Nur zur Information – es gibt keine Kostenobergrenze. Kosten sind Schätzungen nach der Preistabelle (US$).">
      <Field label="Zeitraum" htmlFor="usage-days" className="max-w-xs">
        <Select id="usage-days" value={String(days)} onChange={(e) => setDays(Number(e.target.value))} data-testid="agent-usage-days">
          <option value="7">letzte 7 Tage</option>
          <option value="31">letzte 31 Tage</option>
          <option value="92">letzte 3 Monate</option>
          <option value="366">letztes Jahr</option>
        </Select>
      </Field>
      {q.error && <ErrorNote error={q.error} onRetry={() => void q.refetch()} />}
      {!q.data && q.loading && <Loading />}
      {q.data && (
        <>
          <p className="text-sm" data-testid="agent-usage-total">
            Insgesamt: {formatNumber(q.data.total.runs)} Läufe · {formatTokens(q.data.total.tokens)} · {formatCost(q.data.total.costUsd)}
          </p>
          <UsageRows caption="Pro Tag" rows={dayRows} label={(k) => formatDate(k)} />
          <UsageRows caption="Pro Monat" rows={monthRows} label={monthLabel} />
        </>
      )}
    </Section>
  );
}
