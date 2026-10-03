-- Person mentions were stored as proposed 0.5 "produced" (hat erzeugt) relations (#189): a mention is "mentioned_in" and a text fact, so it is confirmed.
-- Relations the user decided on or created stay untouched; the new type was never used before, so the unique index cannot clash.
UPDATE `relations` SET `relation_type` = 'mentioned_in', `method` = 'mention', `confidence` = 0.6,
  `status` = CASE WHEN `status` = 'proposed' THEN 'confirmed' ELSE `status` END
WHERE `relation_type` = 'produced' AND `resolved_by_user` = 0 AND COALESCE(`origin`, 'system') = 'system'
  AND EXISTS (SELECT 1 FROM `entities` p WHERE p.`id` = `relations`.`source_entity_id` AND p.`type` = 'person')
  AND EXISTS (SELECT 1 FROM `entities` d WHERE d.`id` = `relations`.`target_entity_id` AND d.`type` = 'document');
