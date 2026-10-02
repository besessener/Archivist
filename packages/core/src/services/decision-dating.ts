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

/**
 * Dates for decisions: the decision date, else the earliest document date among its source documents.
 * The capture date is never used – it says nothing about when something was decided.
 */
export function decisionDates(db: Db, list: Datable[]): Map<string, DecisionDating> {
  const sourceIds = [...new Set(list.filter((d) => !d.decidedAt).flatMap((d) => d.sourceIds))];
  const docDates = new Map<string, string>();
  for (let i = 0; i < sourceIds.length; i += 500) {
    const rows = db
      .select({ id: documents.id, documentDate: documents.documentDate })
      .from(documents)
      .where(inArray(documents.id, sourceIds.slice(i, i + 500)))
      .all();
    for (const r of rows) if (r.documentDate) docDates.set(r.id, r.documentDate);
  }
  const out = new Map<string, DecisionDating>();
  for (const d of list) {
    if (d.decidedAt) {
      out.set(d.id, { date: d.decidedAt, basis: 'decided' });
      continue;
    }
    const fromSources = d.sourceIds.flatMap((id) => docDates.get(id) ?? []).sort()[0];
    out.set(d.id, fromSources ? { date: fromSources, basis: 'source' } : { date: null, basis: null });
  }
  return out;
}
