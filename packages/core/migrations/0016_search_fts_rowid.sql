-- FTS rows take the rowid of their chunk, so they can be deleted by rowid via chunks.entity_id (#212).
CREATE TABLE `search_fts_rekey` AS SELECT c.rowid AS rid, f.chunk_id, f.entity_id, f.entity_type, f.title, f.content FROM search_fts f JOIN chunks c ON c.id = f.chunk_id;--> statement-breakpoint
DELETE FROM search_fts;--> statement-breakpoint
INSERT INTO search_fts (rowid, chunk_id, entity_id, entity_type, title, content) SELECT rid, chunk_id, entity_id, entity_type, title, content FROM search_fts_rekey;--> statement-breakpoint
DROP TABLE `search_fts_rekey`;--> statement-breakpoint
ALTER TABLE `documents` ADD `text_hash` text;--> statement-breakpoint
UPDATE `documents` SET `text_hash` = json_extract(`technical_meta`, '$.textHash') WHERE json_valid(`technical_meta`) AND json_extract(`technical_meta`, '$.textHash') IS NOT NULL;--> statement-breakpoint
CREATE INDEX `documents_text_hash_idx` ON `documents` (`text_hash`);
