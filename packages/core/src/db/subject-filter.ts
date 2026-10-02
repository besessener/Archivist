import { sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * The entry (`idCol`) has the subject as its main topic/project (`mainCol`) or as a further one – a confirmed relation to
 * it (#287). For the topic/project filters of the lists.
 */
export function withSubject(idCol: AnySQLiteColumn, mainCol: AnySQLiteColumn, subjectId: string): SQL {
  return sql`(${mainCol} = ${subjectId} OR EXISTS (SELECT 1 FROM relations sr WHERE sr.source_entity_id = ${idCol} AND sr.target_entity_id = ${subjectId} AND sr.status = 'confirmed'))`;
}
