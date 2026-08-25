import { nowSeconds } from './db';

export const RETENTION_BATCH = 5_000;
const DAY_SECONDS = 24 * 60 * 60;

export interface RetentionResult {
  deleted: { artUploadTokens: number; collectionMutations: number; audit: number };
  remaining: { artUploadTokens: number; collectionMutations: number; audit: number };
  totalRemaining: number;
}

export async function pruneOperationalLedgers(
  db: D1Database,
  now = nowSeconds(),
): Promise<RetentionResult> {
  const deleted = await db.batch([
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
  const remaining = await db.batch<{ count: number }>([
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM art_upload_tokens
         WHERE expires_at <= ?1 OR (consumed_at IS NOT NULL AND consumed_at <= ?2)`,
      )
      .bind(now, now - DAY_SECONDS),
    db
      .prepare('SELECT COUNT(*) AS count FROM collection_mutations WHERE created_at <= ?1')
      .bind(now - 30 * DAY_SECONDS),
    db
      .prepare('SELECT COUNT(*) AS count FROM audit WHERE created_at <= ?1')
      .bind(now - 365 * DAY_SECONDS),
  ]);
  const result: RetentionResult = {
    deleted: {
      artUploadTokens: deleted[0]?.meta.changes ?? 0,
      collectionMutations: deleted[1]?.meta.changes ?? 0,
      audit: deleted[2]?.meta.changes ?? 0,
    },
    remaining: {
      artUploadTokens: remaining[0]?.results.at(0)?.count ?? 0,
      collectionMutations: remaining[1]?.results.at(0)?.count ?? 0,
      audit: remaining[2]?.results.at(0)?.count ?? 0,
    },
    totalRemaining: 0,
  };
  result.totalRemaining =
    result.remaining.artUploadTokens +
    result.remaining.collectionMutations +
    result.remaining.audit;
  return result;
}
