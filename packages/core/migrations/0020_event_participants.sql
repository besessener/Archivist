ALTER TABLE `events` ADD `participants` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `relations` (`id`, `source_entity_id`, `target_entity_id`, `relation_type`, `confidence`, `source_ids`, `status`, `resolved_by_user`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-a' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  o.`responsible_person_id`, o.`id`, 'responsible_for', 0.9, o.`source_ids`, 'confirmed', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `open_items` o JOIN `entities` p ON p.`id` = o.`responsible_person_id` AND p.`type` = 'person'
WHERE o.`responsible_person_id` IS NOT NULL;
