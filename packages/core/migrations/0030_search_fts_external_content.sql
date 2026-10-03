-- Full-text index over the chunks instead of a second copy of their text: FTS5 external content, read through a view (title and text come from chunks).
ALTER TABLE `chunks` ADD `title` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `chunks` SET `title` = coalesce((SELECT f.title FROM search_fts f WHERE f.rowid = chunks.rowid), '');--> statement-breakpoint
DROP TABLE `search_fts`;--> statement-breakpoint
CREATE VIEW `search_fts_source` AS SELECT rowid AS chunk_rowid, id AS chunk_id, entity_id, entity_type, title, text AS content FROM chunks;--> statement-breakpoint
CREATE VIRTUAL TABLE `search_fts` USING fts5(
  chunk_id UNINDEXED,
  entity_id UNINDEXED,
  entity_type UNINDEXED,
  title,
  content,
  content = 'search_fts_source',
  content_rowid = 'chunk_rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);--> statement-breakpoint
INSERT INTO `search_fts`(`search_fts`) VALUES ('rebuild');
