import type { PriceBaseline } from '@pokedex/shared';
import { isoFromSeconds, newId, nowSeconds } from './db';

interface PriceRow {
  source: 'tcgplayer' | 'cardmarket';
  native_amount: number;
  native_currency: string;
  source_captured_at: number;
  fx_date: string | null;
  amount_aud: number | null;
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

export async function stagePrices(
  db: D1Database,
  runId: string,
  rows: StagedPriceRow[],
): Promise<void> {
  const statements = rows
    .filter((row) => row.nativeAmount > 0)
    .map((row) =>
      db
        .prepare(
          'INSERT OR IGNORE INTO price_stage_rows (run_id, card_id, source, native_amount, native_currency, source_captured_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
        )
        .bind(
          runId,
          row.cardId,
          row.source,
          row.nativeAmount,
          row.nativeCurrency,
          row.sourceCapturedAt,
        ),
    );
  for (let offset = 0; offset < statements.length; offset += 100)
    await db.batch(statements.slice(offset, offset + 100));
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
  await db
    .prepare(
      `INSERT INTO price_snapshots (id, card_id, source, native_amount, native_currency, source_captured_at, fx_date, amount_aud, created_at)
    SELECT lower(hex(randomblob(16))), s.card_id, s.source, s.native_amount, s.native_currency, s.source_captured_at,
      CASE WHEN s.native_currency = 'AUD' OR fx.rate IS NOT NULL THEN ?1 ELSE NULL END,
      CASE WHEN s.native_currency = 'AUD' THEN s.native_amount WHEN fx.rate IS NOT NULL THEN s.native_amount * fx.rate ELSE NULL END, ?2
    FROM price_stage_rows s LEFT JOIN fx_rates fx ON fx.rate_date = ?1 AND fx.base_currency = s.native_currency AND fx.quote_currency = 'AUD' AND fx.source = 'frankfurter'
    WHERE s.run_id = ?3`,
    )
    .bind(fxDate, now, runId)
    .run();
  return count.count;
}

function baseline(row: PriceRow | null): PriceBaseline {
  return row
    ? {
        amountAud: row.amount_aud,
        nativeAmount: row.native_amount,
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
       ON CONFLICT(rate_date, base_currency, quote_currency, source) DO UPDATE SET rate = excluded.rate, captured_at = excluded.captured_at`,
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
  const fx =
    candidate.nativeCurrency === 'AUD'
      ? 1
      : await db
          .prepare(
            "SELECT rate FROM fx_rates WHERE rate_date = ?1 AND base_currency = ?2 AND quote_currency = 'AUD' AND source = 'frankfurter'",
          )
          .bind(fxDate, candidate.nativeCurrency)
          .first<{ rate: number }>();
  const amountAud =
    typeof fx === 'number'
      ? candidate.nativeAmount * fx
      : fx?.rate
        ? candidate.nativeAmount * fx.rate
        : null;
  const row: PriceRow = {
    source: candidate.source,
    native_amount: candidate.nativeAmount,
    native_currency: candidate.nativeCurrency,
    source_captured_at: candidate.sourceCapturedAt,
    fx_date: amountAud === null ? null : fxDate,
    amount_aud: amountAud,
  };
  await db
    .prepare(
      'INSERT INTO price_snapshots (id, card_id, source, native_amount, native_currency, source_captured_at, fx_date, amount_aud, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
    )
    .bind(
      newId('price'),
      cardId,
      row.source,
      row.native_amount,
      row.native_currency,
      row.source_captured_at,
      row.fx_date,
      row.amount_aud,
      nowSeconds(),
    )
    .run();
  return baseline(row);
}

export async function priceForCard(db: D1Database, cardId: string): Promise<PriceBaseline> {
  const row = await db
    .prepare(
      `SELECT source, native_amount, native_currency, source_captured_at, fx_date, amount_aud
       FROM price_snapshots WHERE card_id = ?1 AND native_amount > 0
       ORDER BY amount_aud IS NULL, amount_aud ASC, source_captured_at DESC LIMIT 1`,
    )
    .bind(cardId)
    .first<PriceRow>();
  return baseline(row);
}

export async function priceCoverage(
  db: D1Database,
  ownerId: string,
): Promise<{
  priced: number;
  missing: number;
  estimateAud: number;
}> {
  const row = await db
    .prepare(
      `WITH selected AS (
        SELECT p.card_id, p.amount_aud, ROW_NUMBER() OVER (
          PARTITION BY p.card_id ORDER BY p.amount_aud IS NULL, p.amount_aud ASC, p.source_captured_at DESC) AS row_number
        FROM price_snapshots p WHERE p.native_amount > 0
      )
      SELECT COUNT(CASE WHEN selected.amount_aud IS NOT NULL THEN 1 END) AS priced,
        COUNT(CASE WHEN selected.amount_aud IS NULL THEN 1 END) AS missing,
        COALESCE(SUM(c.quantity * selected.amount_aud), 0) AS estimate_aud
      FROM collection_cards c LEFT JOIN selected ON selected.card_id = c.card_id AND selected.row_number = 1
      WHERE c.owner_id = ?1 AND c.quantity > 0`,
    )
    .bind(ownerId)
    .first<{ priced: number; missing: number; estimate_aud: number }>();
  return {
    priced: row?.priced ?? 0,
    missing: row?.missing ?? 0,
    estimateAud: row?.estimate_aud ?? 0,
  };
}
