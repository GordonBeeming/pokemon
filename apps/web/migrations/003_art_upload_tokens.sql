CREATE TABLE IF NOT EXISTS art_upload_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  card_id TEXT NOT NULL REFERENCES catalogue_cards(id),
  variant TEXT NOT NULL CHECK (variant IN ('high', 'low')),
  expected_sha256 TEXT NOT NULL,
  max_bytes INTEGER NOT NULL CHECK (max_bytes BETWEEN 1 AND 15728640),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
