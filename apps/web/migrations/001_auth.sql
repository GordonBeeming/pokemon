CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_label TEXT,
  name TEXT,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  target TEXT,
  meta TEXT,
  created_at INTEGER NOT NULL
);
