import { sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

/** The subject with all topics/projects below it over confirmed „Unterthema von“ relations (#282), as a subquery. */
const subtree = (subjectId: string) =>
  sql`(WITH RECURSIVE st(id) AS (SELECT ${subjectId} UNION SELECT r.source_entity_id FROM relations r JOIN st ON r.target_entity_id = st.id WHERE r.relation_type = 'subtopic_of' AND r.status = 'confirmed') SELECT id FROM st)`;

/**
 * The entry (`idCol`) has the subject – or one of its subtopics (#282) – as its main topic/project (`mainCol`) or as a
 * further one, a confirmed relation to it (#287). For the topic/project filters of the lists.
 */
export function withSubject(idCol: AnySQLiteColumn, mainCol: AnySQLiteColumn, subjectId: string): SQL {
  return sql`(${mainCol} IN ${subtree(subjectId)} OR EXISTS (SELECT 1 FROM relations sr WHERE sr.source_entity_id = ${idCol} AND sr.target_entity_id IN ${subtree(subjectId)} AND sr.status = 'confirmed' AND sr.relation_type <> 'subtopic_of'))`;
}
