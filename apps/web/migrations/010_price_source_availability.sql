CREATE TABLE price_stage_targets (
  run_id TEXT NOT NULL REFERENCES price_sync_runs(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES catalogue_cards(id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, card_id)
);

CREATE TABLE price_source_availability (
  card_id TEXT NOT NULL REFERENCES catalogue_cards(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('tcgplayer', 'cardmarket')),
  available INTEGER NOT NULL CHECK (available IN (0, 1)),
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (card_id, source)
);

INSERT INTO price_source_availability (card_id, source, available, checked_at)
SELECT card_id, source, 1, updated_at FROM card_current_prices;

CREATE INDEX idx_price_source_availability_current
  ON price_source_availability(card_id, available, source);
