import { sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

/** The subject with all topics/projects below it over confirmed „Unterthema von“ relations (#282), as a subquery. */
const subtree = (subjectId: string) =>
  sql`(WITH RECURSIVE st(id) AS (SELECT ${subjectId} UNION SELECT r.source_entity_id FROM relations r JOIN st ON r.target_entity_id = st.id WHERE r.relation_type = 'subtopic_of' AND r.status = 'confirmed') SELECT id FROM st)`;

/** The entry has the subject or a subtopic (#282) as main topic/project (`mainCol`) or as a further confirmed one (#287). */
export function withSubject({ idCol, mainCol, subjectId }: { idCol: AnySQLiteColumn; mainCol: AnySQLiteColumn; subjectId: string }): SQL {
  return sql`(${mainCol} IN ${subtree(subjectId)} OR EXISTS (SELECT 1 FROM relations sr WHERE sr.source_entity_id = ${idCol} AND sr.target_entity_id IN ${subtree(subjectId)} AND sr.status = 'confirmed' AND sr.relation_type <> 'subtopic_of'))`;
}
