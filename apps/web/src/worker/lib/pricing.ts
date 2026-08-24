import type { PriceBaseline } from '@pokedex/shared';
import { z } from 'zod';
import { isoFromSeconds, newId, nowSeconds } from './db';

const PRICE_SCALE = 1_000_000;
const MAX_STAGE_JSON_BYTES = 1_500_000;
const MAX_STAGE_ROWS = 500;

interface PriceRow {
  source: 'tcgplayer' | 'cardmarket';
  native_amount_micros: number;
  native_currency: string;
  source_captured_at: number;
  fx_date: string | null;
  amount_aud_micros: number | null;
}

export interface PriceCandidate {
  source: 'tcgplayer' | 'cardmarket';
  nativeAmount: number;
  nativeCurrency: string;
  sourceCapturedAt: number;
  amountAud?: number | null;
}

export interface StagedPriceRow extends PriceCandidate {
  cardId: string;
}

const tcgdexPricingSchema = z
  .object({
    id: z.string().min(1),
    pricing: z
      .object({
        cardmarket: z
          .object({
            updated: z.string().datetime({ offset: true }),
            unit: z.string().regex(/^[A-Z]{3}$/u),
            trend: z.number().positive().nullable().optional(),
          })
          .nullable()
          .optional(),
        tcgplayer: z
          .object({
            updated: z.string().datetime({ offset: true }),
            unit: z.string().regex(/^[A-Z]{3}$/u),
          })
          .catchall(z.unknown())
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

function positiveMarketPrices(value: Record<string, unknown>): number[] {
  const prices: number[] = [];
  for (const candidate of Object.values(value)) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
    const record: Record<string, unknown> = { ...candidate };
    const marketPrice = record.marketPrice;
    if (typeof marketPrice === 'number' && Number.isFinite(marketPrice) && marketPrice > 0)
      prices.push(marketPrice);
  }
  return prices;
}

export function extractTcgdexPrices(value: unknown): {
  sourceId: string;
  candidates: PriceCandidate[];
} {
  const parsed = tcgdexPricingSchema.safeParse(value);
  if (!parsed.success) throw new Error('tcgdex_price_invalid');
  const candidates: PriceCandidate[] = [];
  const cardmarket = parsed.data.pricing?.cardmarket;
  if (cardmarket?.trend && cardmarket.trend > 0) {
    candidates.push({
      source: 'cardmarket',
      nativeAmount: cardmarket.trend,
      nativeCurrency: cardmarket.unit,
      sourceCapturedAt: Math.floor(Date.parse(cardmarket.updated) / 1000),
    });
  }
  const tcgplayer = parsed.data.pricing?.tcgplayer;
  if (tcgplayer) {
    const prices = positiveMarketPrices(tcgplayer);
    const marketPrice = prices.length > 0 ? Math.min(...prices) : null;
    if (marketPrice !== null) {
      candidates.push({
        source: 'tcgplayer',
        nativeAmount: marketPrice,
        nativeCurrency: tcgplayer.unit,
        sourceCapturedAt: Math.floor(Date.parse(tcgplayer.updated) / 1000),
      });
    }
  }
  return { sourceId: parsed.data.id, candidates };
}

function amountMicros(amount: number): number {
  const scaled = Math.round(amount * PRICE_SCALE);
  if (!Number.isSafeInteger(scaled) || scaled <= 0) throw new Error('price_amount_invalid');
  return scaled;
}

interface StoredStageRow {
  cardId: string;
  source: PriceCandidate['source'];
  nativeAmountMicros: number;
  nativeCurrency: string;
  sourceCapturedAt: number;
}

function stageChunks(rows: StoredStageRow[]): StoredStageRow[][] {
  const chunks: StoredStageRow[][] = [];
  let current: StoredStageRow[] = [];
  let bytes = 2;
  for (const row of rows) {
    const rowBytes = new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
    if (rowBytes > MAX_STAGE_JSON_BYTES) throw new Error('price_stage_row_too_large');
    if (
      current.length > 0 &&
      (current.length >= MAX_STAGE_ROWS || bytes + rowBytes > MAX_STAGE_JSON_BYTES)
    ) {
      chunks.push(current);
      current = [];
      bytes = 2;
    }
    current.push(row);
    bytes += rowBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function beginPriceSyncRun(
  db: D1Database,
  runId = newId('price_sync'),
): Promise<string> {
  await db
    .prepare(
      `INSERT INTO price_sync_runs (id, started_at, status)
       VALUES (?1, ?2, 'running') ON CONFLICT(id) DO NOTHING`,
    )
    .bind(runId, nowSeconds())
    .run();
  return runId;
}

export async function stagePrices(
  db: D1Database,
  runId: string,
  rows: StagedPriceRow[],
): Promise<void> {
  await beginPriceSyncRun(db, runId);
  const stored = rows
    .filter((row) => row.nativeAmount > 0)
    .map((row) => ({
      cardId: row.cardId,
      source: row.source,
      nativeAmountMicros: amountMicros(row.nativeAmount),
      nativeCurrency: row.nativeCurrency,
      sourceCapturedAt: row.sourceCapturedAt,
    }));
  for (const chunk of stageChunks(stored)) {
    await db
      .prepare(
        `INSERT INTO price_stage_rows
          (run_id, card_id, source, native_amount_micros, native_currency,
           source_captured_at, created_at)
         SELECT ?1, json_extract(value, '$.cardId'), json_extract(value, '$.source'),
           json_extract(value, '$.nativeAmountMicros'), json_extract(value, '$.nativeCurrency'),
           json_extract(value, '$.sourceCapturedAt'), ?2
         FROM json_each(?3) WHERE true
         ON CONFLICT(run_id, card_id, source, source_captured_at) DO UPDATE SET
           native_amount_micros = excluded.native_amount_micros,
           native_currency = excluded.native_currency`,
      )
      .bind(runId, nowSeconds(), JSON.stringify(chunk))
      .run();
  }
}

export async function applyStagedPrices(
  db: D1Database,
  runId: string,
  fxDate: string,
): Promise<number> {
  const count = await db
    .prepare('SELECT COUNT(*) AS count FROM price_stage_rows WHERE run_id = ?1')
    .bind(runId)
    .first<{ count: number }>();
  if (!count || count.count === 0) throw new Error('staged_price_empty');
  const now = nowSeconds();
  await db.batch([
    db
      .prepare(
        `INSERT INTO price_snapshots
          (id, card_id, source, native_amount, native_amount_micros, native_currency,
           source_captured_at, fx_date, amount_aud, amount_aud_micros, created_at)
         SELECT lower(hex(randomblob(16))), stage.card_id, stage.source,
           stage.native_amount_micros / 1000000.0, stage.native_amount_micros,
           stage.native_currency, stage.source_captured_at,
           CASE WHEN stage.native_currency = 'AUD' OR fx.rate IS NOT NULL THEN ?1 ELSE NULL END,
           CASE WHEN stage.native_currency = 'AUD' THEN stage.native_amount_micros / 1000000.0
                WHEN fx.rate IS NOT NULL THEN ROUND(stage.native_amount_micros * fx.rate) / 1000000.0
                ELSE NULL END,
           CASE WHEN stage.native_currency = 'AUD' THEN stage.native_amount_micros
                WHEN fx.rate IS NOT NULL THEN CAST(ROUND(stage.native_amount_micros * fx.rate) AS INTEGER)
                ELSE NULL END,
           ?2
         FROM price_stage_rows stage
         LEFT JOIN fx_rates fx ON fx.rate_date = ?1
           AND fx.base_currency = stage.native_currency AND fx.quote_currency = 'AUD'
           AND fx.source = 'frankfurter'
         WHERE stage.run_id = ?3
         ON CONFLICT(card_id, source, source_captured_at) DO UPDATE SET
           native_amount = excluded.native_amount,
           native_amount_micros = excluded.native_amount_micros,
           native_currency = excluded.native_currency, fx_date = excluded.fx_date,
           amount_aud = excluded.amount_aud, amount_aud_micros = excluded.amount_aud_micros`,
      )
      .bind(fxDate, now, runId),
    db
      .prepare(
        `DELETE FROM card_current_prices
         WHERE card_id IN (SELECT card_id FROM price_stage_rows WHERE run_id = ?1)`,
      )
      .bind(runId),
    db
      .prepare(
        `INSERT INTO card_current_prices
          (card_id, source, native_amount_micros, native_currency, source_captured_at,
           fx_date, amount_aud_micros, updated_at)
         WITH affected AS (
           SELECT DISTINCT card_id FROM price_stage_rows WHERE run_id = ?1
         ), latest AS (
           SELECT snapshot.*,
             ROW_NUMBER() OVER (
               PARTITION BY snapshot.card_id, snapshot.source
               ORDER BY snapshot.source_captured_at DESC, snapshot.created_at DESC
             ) AS source_rank
           FROM price_snapshots snapshot JOIN affected ON affected.card_id = snapshot.card_id
         ), ranked AS (
           SELECT latest.*,
             ROW_NUMBER() OVER (
               PARTITION BY latest.card_id
               ORDER BY latest.amount_aud_micros IS NULL, latest.amount_aud_micros,
                 latest.source_captured_at DESC
             ) AS card_rank
           FROM latest WHERE source_rank = 1
         )
         SELECT card_id, source, native_amount_micros, native_currency, source_captured_at,
           fx_date, amount_aud_micros, ?2
         FROM ranked WHERE card_rank = 1`,
      )
      .bind(runId, now),
    db.prepare('DELETE FROM price_stage_rows WHERE run_id = ?1').bind(runId),
    db
      .prepare(
        `UPDATE price_sync_runs SET completed_at = ?1, status = 'complete', row_count = ?2,
           fx_date = ?3, error = NULL WHERE id = ?4 AND status = 'running'`,
      )
      .bind(now, count.count, fxDate, runId),
  ]);
  return count.count;
}

function baseline(row: PriceRow | null): PriceBaseline {
  return row
    ? {
        amountAud: row.amount_aud_micros === null ? null : row.amount_aud_micros / PRICE_SCALE,
        nativeAmount: row.native_amount_micros / PRICE_SCALE,
        nativeCurrency: row.native_currency,
        source: row.source,
        sourceCapturedAt: isoFromSeconds(row.source_captured_at),
        fxDate: row.fx_date,
      }
    : {
        amountAud: null,
        nativeAmount: null,
        nativeCurrency: null,
        source: null,
        sourceCapturedAt: null,
        fxDate: null,
      };
}

export function selectConservativePrice(candidates: PriceCandidate[]): PriceCandidate | null {
  const pool = candidates.filter(
    (candidate) =>
      candidate.nativeAmount > 0 &&
      candidate.amountAud !== null &&
      candidate.amountAud !== undefined,
  );
  if (pool.length === 0) return null;
  return pool.reduce((lowest, candidate) =>
    (candidate.amountAud ?? Infinity) < (lowest.amountAud ?? Infinity) ? candidate : lowest,
  );
}

export async function upsertFxRate(
  db: D1Database,
  date: string,
  baseCurrency: string,
  audPerUnit: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fx_rates (rate_date, base_currency, quote_currency, rate, source, captured_at)
       VALUES (?1, ?2, 'AUD', ?3, 'frankfurter', ?4)
       ON CONFLICT(rate_date, base_currency, quote_currency, source) DO UPDATE SET
         rate = excluded.rate, captured_at = excluded.captured_at`,
    )
    .bind(date, baseCurrency, audPerUnit, nowSeconds())
    .run();
}

export async function recordPrice(
  db: D1Database,
  cardId: string,
  candidate: PriceCandidate,
  fxDate: string,
): Promise<PriceBaseline> {
  const runId = await beginPriceSyncRun(db);
  await stagePrices(db, runId, [{ ...candidate, cardId }]);
  await applyStagedPrices(db, runId, fxDate);
  return priceForCard(db, cardId);
}

export async function priceForCard(db: D1Database, cardId: string): Promise<PriceBaseline> {
  const row = await db
    .prepare(
      `SELECT source, native_amount_micros, native_currency, source_captured_at,
         fx_date, amount_aud_micros
       FROM card_current_prices WHERE card_id = ?1`,
    )
    .bind(cardId)
    .first<PriceRow>();
  return baseline(row);
}

export async function priceCoverage(
  db: D1Database,
  ownerId: string,
): Promise<{ priced: number; missing: number; estimateAud: number }> {
  const row = await db
    .prepare(
      `SELECT COUNT(CASE WHEN current.amount_aud_micros IS NOT NULL THEN 1 END) AS priced,
         COUNT(CASE WHEN current.amount_aud_micros IS NULL THEN 1 END) AS missing,
         COALESCE(SUM(collection.quantity * current.amount_aud_micros), 0) AS estimate_aud_micros
       FROM collection_cards collection
       LEFT JOIN card_current_prices current ON current.card_id = collection.card_id
       WHERE collection.owner_id = ?1 AND collection.quantity > 0`,
    )
    .bind(ownerId)
    .first<{ priced: number; missing: number; estimate_aud_micros: number }>();
  return {
    priced: row?.priced ?? 0,
    missing: row?.missing ?? 0,
    estimateAud: (row?.estimate_aud_micros ?? 0) / PRICE_SCALE,
  };
}

export async function getPriceSyncCursor(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare('SELECT source_id FROM price_sync_state WHERE id = 1')
    .first<{ source_id: string | null }>();
  return row?.source_id ?? null;
}

export async function setPriceSyncCursor(db: D1Database, sourceId: string | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO price_sync_state (id, source_id, updated_at) VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET source_id = excluded.source_id, updated_at = excluded.updated_at`,
    )
    .bind(sourceId, nowSeconds())
    .run();
}

export async function prunePricingData(db: D1Database, now = nowSeconds()): Promise<void> {
  const snapshotCutoff = now - 400 * 24 * 60 * 60;
  const runCutoff = now - 30 * 24 * 60 * 60;
  await db.batch([
    db.prepare('DELETE FROM price_snapshots WHERE created_at < ?1').bind(snapshotCutoff),
    db.prepare('DELETE FROM price_stage_rows WHERE created_at < ?1').bind(now - 24 * 60 * 60),
    db
      .prepare("DELETE FROM price_sync_runs WHERE started_at < ?1 AND status <> 'running'")
      .bind(runCutoff),
  ]);
}
