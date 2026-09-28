-- Multi-user: roles, disable/enable (never delete), invite links, and
-- per-owner custom cards. The single existing user keeps its id and becomes
-- the first admin, so a running deployment needs no data migration beyond
-- these column defaults.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member'));
ALTER TABLE users ADD COLUMN disabled_at INTEGER;
UPDATE users SET role = 'admin' WHERE id = 'owner';

-- Single-use, expiring invite links. Only a hash of the token is stored, the
-- same way desktop pair codes and desktop tokens never store the raw value.
CREATE TABLE invites (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  label TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  redeemed_by TEXT REFERENCES users(id),
  cancelled_at INTEGER
);
CREATE INDEX idx_invites_created ON invites(created_at);

-- The catalogue stays shared, except a custom card belongs to whoever made
-- it. NULL means "shared" (every pre-existing non-custom card); the existing
-- custom cards all belonged to the one pre-multi-user account.
ALTER TABLE catalogue_cards ADD COLUMN owner_id TEXT REFERENCES users(id);
UPDATE catalogue_cards SET owner_id = 'owner' WHERE is_custom = 1;
