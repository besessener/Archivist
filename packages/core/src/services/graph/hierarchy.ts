import type Database from 'better-sqlite3';

/** A topic or project with everything below it over confirmed „Unterthema von“ relations (#282), itself first. */
export function subtreeOf(sqlite: Database.Database, id: string): string[] {
  return (
    sqlite
      .prepare(
        `WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT r.source_entity_id FROM relations r JOIN sub ON r.target_entity_id = sub.id
             WHERE r.relation_type = 'subtopic_of' AND r.status = 'confirmed') SELECT id FROM sub`,
      )
      .all(id) as Array<{ id: string }>
  ).map((row) => row.id);
}

/** Every confirmed „Unterthema von“ (#282) as child and parent. */
export function subtopicPairs(sqlite: Database.Database): Array<{ childId: string; parentId: string }> {
  return sqlite
    .prepare(`SELECT source_entity_id AS childId, target_entity_id AS parentId FROM relations WHERE relation_type = 'subtopic_of' AND status = 'confirmed'`)
    .all() as Array<{ childId: string; parentId: string }>;
}
