ALTER TABLE `documents` ADD `folder_llm_allowed` integer DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE `documents` SET `folder_llm_allowed` = false WHERE `id` IN (SELECT `sf`.`document_id` FROM `scan_files` `sf` JOIN `scan_roots` `sr` ON `sr`.`id` = `sf`.`root_id` WHERE `sr`.`llm_allowed` = 0 AND `sf`.`document_id` IS NOT NULL);
