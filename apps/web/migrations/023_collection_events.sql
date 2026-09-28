-- An append-only ledger of every quantity change, so "N in a binder / M loose"
-- history survives beyond the 30-day collection_mutations idempotency window.
CREATE TABLE collection_events (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES catalogue_cards(id),
  delta INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('add', 'pocket', 'loose', 'miscount', 'set', 'import')),
  slot_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_collection_events_owner_card_time
  ON collection_events(owner_id, card_id, created_at);

CREATE TRIGGER collection_events_epoch_after_insert AFTER INSERT ON collection_events BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id = NEW.owner_id;
END;
