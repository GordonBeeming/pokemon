CREATE TABLE IF NOT EXISTS catalogue_stage_cards (
  run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  source_updated_at INTEGER NOT NULL,
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
  PRIMARY KEY (run_id, source_id)
);

CREATE TABLE IF NOT EXISTS price_stage_rows (
  run_id TEXT NOT NULL,
  card_id TEXT NOT NULL REFERENCES catalogue_cards(id),
  source TEXT NOT NULL CHECK (source IN ('tcgplayer', 'cardmarket')),
  native_amount REAL NOT NULL CHECK (native_amount > 0),
  native_currency TEXT NOT NULL CHECK (length(native_currency) = 3),
  source_captured_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, card_id, source, native_amount)
);
