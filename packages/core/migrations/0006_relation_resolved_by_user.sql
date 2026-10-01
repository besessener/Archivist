ALTER TABLE `relations` ADD `resolved_by_user` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: relations the user already confirmed or rejected (logged as relation.* in the audit log).
UPDATE `relations` SET `resolved_by_user` = 1 WHERE `id` IN (SELECT j.value FROM `audit_log` a, json_each(a.entity_ids) j WHERE a.action LIKE 'relation.%' AND a.success = 1);
