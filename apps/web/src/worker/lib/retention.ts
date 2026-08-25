import { nowSeconds } from './db';

const RETENTION_BATCH = 500;
const DAY_SECONDS = 24 * 60 * 60;

export async function pruneOperationalLedgers(db: D1Database, now = nowSeconds()): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM art_upload_tokens WHERE token_hash IN (
           SELECT token_hash FROM art_upload_tokens
           WHERE expires_at <= ?1 OR (consumed_at IS NOT NULL AND consumed_at <= ?2)
           ORDER BY expires_at LIMIT ?3
         )`,
      )
      .bind(now, now - DAY_SECONDS, RETENTION_BATCH),
    db
      .prepare(
        `DELETE FROM collection_mutations WHERE rowid IN (
           SELECT rowid FROM collection_mutations WHERE created_at <= ?1
           ORDER BY created_at LIMIT ?2
         )`,
      )
      .bind(now - 30 * DAY_SECONDS, RETENTION_BATCH),
    db
      .prepare(
        `DELETE FROM audit WHERE id IN (
           SELECT id FROM audit WHERE created_at <= ?1 ORDER BY created_at LIMIT ?2
         )`,
      )
      .bind(now - 365 * DAY_SECONDS, RETENTION_BATCH),
  ]);
}
