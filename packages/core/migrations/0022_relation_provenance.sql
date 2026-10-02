ALTER TABLE `relations` ADD `method` text;--> statement-breakpoint
ALTER TABLE `relations` ADD `evidence` text;--> statement-breakpoint
-- Backfill (#270): relations to a topic, project, person, tag or folder mirror a field of the entry; the user's own links are manual.
UPDATE `relations` SET `method` = 'field' WHERE `method` IS NULL AND `relation_type` <> 'duplicate_of' AND (
  EXISTS (SELECT 1 FROM `entities` e WHERE e.`id` = `relations`.`target_entity_id` AND e.`type` IN ('topic', 'project', 'person', 'tag', 'category'))
  OR EXISTS (SELECT 1 FROM `entities` e WHERE e.`id` = `relations`.`source_entity_id` AND e.`type` = 'person')
);--> statement-breakpoint
UPDATE `relations` SET `method` = 'analysis' WHERE `method` IS NULL AND `relation_type` IN ('supports', 'results_from', 'supersedes', 'contradicts', 'duplicate_of');
