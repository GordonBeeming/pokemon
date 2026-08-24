PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS catalogue_cards (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  category TEXT NOT NULL,
  set_id TEXT NOT NULL,
  set_name TEXT NOT NULL,
  number TEXT NOT NULL,
  supertype TEXT,
  subtype TEXT,
  species TEXT,
  rarity TEXT,
  artist TEXT,
  is_custom INTEGER NOT NULL DEFAULT 0 CHECK (is_custom IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_catalogue_cards_set ON catalogue_cards(set_id, language, number);
CREATE INDEX IF NOT EXISTS idx_catalogue_cards_species ON catalogue_cards(species);

CREATE TABLE IF NOT EXISTS card_sources (
  provider TEXT NOT NULL,
  source_id TEXT NOT NULL,
  card_id TEXT NOT NULL REFERENCES catalogue_cards(id),
  language TEXT NOT NULL,
  source_updated_at INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (provider, source_id, language)
);

CREATE INDEX IF NOT EXISTS idx_card_sources_card ON card_sources(card_id);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  language TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  source_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  inactive_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'rejected', 'failed')),
  refusal_reason TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS catalogue_search USING fts5(
  card_id UNINDEXED,
  name,
  set_name,
  number,
  species,
  rarity,
  artist,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS collection_cards (
  owner_id TEXT NOT NULL REFERENCES users(id),
  card_id TEXT NOT NULL REFERENCES catalogue_cards(id),
  quantity INTEGER NOT NULL CHECK (quantity >= 0 AND quantity <= 9999),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, card_id)
);

CREATE TABLE IF NOT EXISTS collection_mutations (
  owner_id TEXT NOT NULL REFERENCES users(id),
  mutation_id TEXT NOT NULL,
  card_id TEXT NOT NULL REFERENCES catalogue_cards(id),
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, mutation_id)
);

CREATE TABLE IF NOT EXISTS binders (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  active_version_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS binder_versions (
  id TEXT PRIMARY KEY NOT NULL,
  binder_id TEXT NOT NULL REFERENCES binders(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'archived')),
  layout_kind TEXT NOT NULL CHECK (layout_kind IN ('2x2', '3x3', '4x3', 'top-loader', 'custom')),
  rows INTEGER NOT NULL CHECK (rows BETWEEN 1 AND 20),
  columns INTEGER NOT NULL CHECK (columns BETWEEN 1 AND 20),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  UNIQUE (binder_id, version_number)
);

CREATE TABLE IF NOT EXISTS binder_pages (
  id TEXT PRIMARY KEY NOT NULL,
  binder_version_id TEXT NOT NULL REFERENCES binder_versions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  UNIQUE (binder_version_id, position)
);

CREATE TABLE IF NOT EXISTS binder_slots (
  binder_page_id TEXT NOT NULL REFERENCES binder_pages(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL CHECK (row_index >= 0),
  column_index INTEGER NOT NULL CHECK (column_index >= 0),
  card_id TEXT REFERENCES catalogue_cards(id),
  PRIMARY KEY (binder_page_id, row_index, column_index)
);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  card_id TEXT NOT NULL REFERENCES catalogue_cards(id),
  source TEXT NOT NULL CHECK (source IN ('tcgplayer', 'cardmarket')),
  native_amount REAL NOT NULL CHECK (native_amount > 0),
  native_currency TEXT NOT NULL CHECK (length(native_currency) = 3),
  price_kind TEXT NOT NULL DEFAULT 'market',
  source_captured_at INTEGER NOT NULL,
  fx_date TEXT,
  amount_aud REAL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_snapshots_card ON price_snapshots(card_id, source_captured_at DESC);

CREATE TABLE IF NOT EXISTS fx_rates (
  rate_date TEXT NOT NULL,
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate REAL NOT NULL CHECK (rate > 0),
  source TEXT NOT NULL DEFAULT 'frankfurter',
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (rate_date, base_currency, quote_currency, source)
);

CREATE TABLE IF NOT EXISTS art_manifest (
  card_id TEXT NOT NULL REFERENCES catalogue_cards(id),
  variant TEXT NOT NULL CHECK (variant IN ('high', 'low')),
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (card_id, variant)
);

CREATE TABLE IF NOT EXISTS desktop_pair_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS desktop_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  restored_at INTEGER
);
