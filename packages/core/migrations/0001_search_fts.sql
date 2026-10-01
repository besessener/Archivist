-- Volltextindex (FTS5) für die hybride Suche; wird vom SearchService gepflegt.
CREATE VIRTUAL TABLE search_fts USING fts5(
  chunk_id UNINDEXED,
  entity_id UNINDEXED,
  entity_type UNINDEXED,
  title,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);
