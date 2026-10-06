import type { EntityType } from '@archivist/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/database';
import { blockedSubjects } from '../../db/schema';
import { newId, nowIso } from '../../util/ids';
import { normalizeName } from '../../util/text';

/** Whether the user deleted a subject of this type under this name (or one of its aliases): analysis must not create it again. */
export function isBlockedName(db: Db, subject: { type: EntityType; name: string }): boolean {
  const normalizedName = normalizeName(subject.name);
  if (!normalizedName) return false;
  return Boolean(
    db
      .select({ id: blockedSubjects.id })
      .from(blockedSubjects)
      .where(and(eq(blockedSubjects.type, subject.type), eq(blockedSubjects.normalizedName, normalizedName)))
      .get(),
  );
}

/** Blocks the names; returns the ids of the entries added (names blocked before stay with their first entry). */
export function blockNames(db: Db, subject: { type: EntityType; names: string[] }): string[] {
  const normalized = [...new Set(subject.names.map(normalizeName).filter(Boolean))];
  const createdAt = nowIso();
  return normalized.flatMap((normalizedName) =>
    db
      .insert(blockedSubjects)
      .values({ id: newId(), type: subject.type, normalizedName, createdAt })
      .onConflictDoNothing()
      .returning({ id: blockedSubjects.id })
      .all()
      .map((row) => row.id),
  );
}

export function unblockNames(db: Db, ids: string[]): void {
  if (ids.length) db.delete(blockedSubjects).where(inArray(blockedSubjects.id, ids)).run();
}
