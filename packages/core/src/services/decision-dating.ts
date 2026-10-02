import { inArray } from 'drizzle-orm';
import type { Db } from '../db/database';
import { documents } from '../db/schema';

/** Where a decision's date comes from: its own decision date, the date of a source document, or nothing (#168). */
export interface DecisionDating {
  date: string | null;
  basis: 'decided' | 'source' | null;
}

interface Datable {
  id: string;
  decidedAt: string | null;
  sourceIds: string[];
}

/** Decision date, else the earliest source document date; never the capture date (it says nothing about the decision). */
export function decisionDates(db: Db, list: Datable[]): Map<string, DecisionDating> {
  const sourceIds = [...new Set(list.filter((d) => !d.decidedAt).flatMap((d) => d.sourceIds))];
  const documentDates = new Map<string, string>();
  for (let i = 0; i < sourceIds.length; i += 500) {
    const rows = db
      .select({ id: documents.id, documentDate: documents.documentDate })
      .from(documents)
      .where(inArray(documents.id, sourceIds.slice(i, i + 500)))
      .all();
    for (const row of rows) if (row.documentDate) documentDates.set(row.id, row.documentDate);
  }
  const out = new Map<string, DecisionDating>();
  for (const d of list) {
    if (d.decidedAt) {
      out.set(d.id, { date: d.decidedAt, basis: 'decided' });
      continue;
    }
    const fromSources = d.sourceIds.flatMap((id) => documentDates.get(id) ?? []).sort()[0];
    out.set(d.id, fromSources ? { date: fromSources, basis: 'source' } : { date: null, basis: null });
  }
  return out;
}
