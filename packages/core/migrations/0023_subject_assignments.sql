-- Several topics and projects per entry (#287): the topic/project columns stay the main assignment, every assignment is a
-- relation. Older entries whose column had no mirror relation get one.
INSERT OR IGNORE INTO `relations` (`id`, `source_entity_id`, `target_entity_id`, `relation_type`, `confidence`, `source_ids`, `status`, `resolved_by_user`, `origin`, `method`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-a' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  x.`id`, x.`topic_id`, 'relates_to', 0.9, '[]', 'confirmed', 0, 'system', 'field', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `documents` x JOIN `entities` s ON s.`id` = x.`topic_id`
WHERE x.`topic_id` IS NOT NULL AND x.`status` IN ('archived','indexed_only');--> statement-breakpoint
INSERT OR IGNORE INTO `relations` (`id`, `source_entity_id`, `target_entity_id`, `relation_type`, `confidence`, `source_ids`, `status`, `resolved_by_user`, `origin`, `method`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-a' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  x.`id`, x.`project_id`, 'belongs_to', 0.9, '[]', 'confirmed', 0, 'system', 'field', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `documents` x JOIN `entities` s ON s.`id` = x.`project_id`
WHERE x.`project_id` IS NOT NULL AND x.`status` IN ('archived','indexed_only');--> statement-breakpoint
INSERT OR IGNORE INTO `relations` (`id`, `source_entity_id`, `target_entity_id`, `relation_type`, `confidence`, `source_ids`, `status`, `resolved_by_user`, `origin`, `method`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-a' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  x.`id`, x.`topic_id`, 'concerns', 0.9, '[]', 'confirmed', 0, 'system', 'field', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `decisions` x JOIN `entities` s ON s.`id` = x.`topic_id`
WHERE x.`topic_id` IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `relations` (`id`, `source_entity_id`, `target_entity_id`, `relation_type`, `confidence`, `source_ids`, `status`, `resolved_by_user`, `origin`, `method`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-a' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  x.`id`, x.`project_id`, 'affects', 0.9, '[]', 'confirmed', 0, 'system', 'field', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `decisions` x JOIN `entities` s ON s.`id` = x.`project_id`
WHERE x.`project_id` IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `relations` (`id`, `source_entity_id`, `target_entity_id`, `relation_type`, `confidence`, `source_ids`, `status`, `resolved_by_user`, `origin`, `method`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-a' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  x.`id`, x.`topic_id`, 'relates_to', 0.9, '[]', 'confirmed', 0, 'system', 'field', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `open_items` x JOIN `entities` s ON s.`id` = x.`topic_id`
WHERE x.`topic_id` IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `relations` (`id`, `source_entity_id`, `target_entity_id`, `relation_type`, `confidence`, `source_ids`, `status`, `resolved_by_user`, `origin`, `method`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-a' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  x.`id`, x.`project_id`, 'belongs_to', 0.9, '[]', 'confirmed', 0, 'system', 'field', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `open_items` x JOIN `entities` s ON s.`id` = x.`project_id`
WHERE x.`project_id` IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `relations` (`id`, `source_entity_id`, `target_entity_id`, `relation_type`, `confidence`, `source_ids`, `status`, `resolved_by_user`, `origin`, `method`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-a' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  x.`id`, x.`topic_id`, 'relates_to', 0.9, '[]', 'confirmed', 0, 'system', 'field', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `events` x JOIN `entities` s ON s.`id` = x.`topic_id`
WHERE x.`topic_id` IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `relations` (`id`, `source_entity_id`, `target_entity_id`, `relation_type`, `confidence`, `source_ids`, `status`, `resolved_by_user`, `origin`, `method`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-a' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  x.`id`, x.`project_id`, 'belongs_to', 0.9, '[]', 'confirmed', 0, 'system', 'field', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `events` x JOIN `entities` s ON s.`id` = x.`project_id`
WHERE x.`project_id` IS NOT NULL;
