import {
  cardIdSchema,
  languageSchema,
  type CatalogueBrief,
  type CatalogueCardView,
  type CatalogueDetailView,
  type LanguageCode,
} from '@pokedex/shared';
import { z } from 'zod';
import { base64UrlDecode, base64UrlEncode } from './crypto';
import { escapedFtsQuery, isoFromSeconds, newId, nowSeconds, scalarCount } from './db';
import { ApplicationError } from './log';

interface CardRow {
  id: string;
  name: string;
  language: LanguageCode;
  category: CatalogueBrief['category'];
  set_id: string;
  set_name: string;
  number: string;
  number_sort: number | null;
  supertype: string | null;
  subtype: string | null;
  species: string | null;
  rarity: string | null;
  artist: string | null;
  is_active: number;
  is_custom: number;
  updated_at: number;
  source_provider: string | null;
  source_id: string | null;
  source_updated_at: number | null;
  notes: string | null;
  quantity: number | null;
  collection_updated_at: number | null;
  collection_revision: number | null;
  low_key: string | null;
  high_key: string | null;
  price_source: 'tcgplayer' | 'cardmarket' | null;
  price_native_micros: number | null;
  price_native_currency: string | null;
  price_source_captured_at: number | null;
  price_fx_date: string | null;
  price_aud_micros: number | null;
}

export function catalogueSyncLanguage(value: unknown): LanguageCode {
  const requested = languageSchema.safeParse(value);
  return requested.success ? requested.data : 'en';
}

export interface CatalogueFilters {
  query?: string;
  language?: LanguageCode;
  category?: CatalogueBrief['category'];
  owned?: boolean;
  limit: number;
  offset: number;
  setId?: string;
  species?: string;
  pokedexNumber?: number;
  cursor?: string | null;
}

const catalogueCursorSchema = z
  .object({
    setName: z.string(),
    numberSortMissing: z.union([z.literal(0), z.literal(1)]),
    numberSort: z.number().int(),
    number: z.string(),
    name: z.string(),
    id: z.string().min(1).max(128),
    filterKey: z.string(),
    total: z.number().int().nonnegative(),
  })
  .strict();
type CatalogueCursor = z.infer<typeof catalogueCursorSchema>;

function encodeCatalogueCursor(row: CardRow, filterKey: string, total: number): string {
  return base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        setName: row.set_name,
        numberSortMissing: row.number_sort === null ? 1 : 0,
        numberSort: row.number_sort ?? 0,
        number: row.number,
        name: row.name,
        id: row.id,
        filterKey,
        total,
      } satisfies CatalogueCursor),
    ),
  );
}

function decodeCatalogueCursor(value: string | null | undefined): CatalogueCursor | null {
  if (!value) return null;
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
    const parsed = catalogueCursorSchema.safeParse(decoded);
    if (!parsed.success) throw new ApplicationError('invalid_catalogue_cursor', 400);
    return parsed.data;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('invalid_catalogue_cursor', 400);
  }
}

export interface ImportedCard {
  sourceId: string;
  checksum: string;
  sourceUpdatedAt: number;
  name: string;
  language: LanguageCode;
  category: CatalogueBrief['category'];
  setId: string;
  setName: string;
  number: string;
  numberSort?: number | null;
  supertype?: string | null;
  subtype?: string | null;
  species?: string | null;
  rarity?: string | null;
  artist?: string | null;
  releaseDate?: string | null;
  pokedexNumber?: number | null;
}

const tcgdexCardSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    localId: z.union([z.string(), z.number()]).transform(String),
    name: z.string().trim().min(1).max(200),
    category: z.enum(['Pokemon', 'Trainer', 'Energy']),
    illustrator: z.string().trim().max(200).nullable().optional(),
    rarity: z.string().trim().max(120).nullable().optional(),
    updated: z.string().datetime({ offset: true }).optional(),
    updatedAt: z.string().datetime({ offset: true }).optional(),
    dexId: z.array(z.number().int().positive()).optional(),
    types: z.array(z.string()).optional(),
    trainerType: z.string().nullable().optional(),
    energyType: z.string().nullable().optional(),
    set: z
      .object({
        id: z.string().trim().min(1).max(128),
        name: z.string().trim().min(1).max(200),
        logo: z.string().url().nullable().optional(),
        symbol: z.string().url().nullable().optional(),
        releaseDate: z.string().date().nullable().optional(),
      })
      .passthrough(),
  })
  .passthrough();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Text(value: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
  );
}

function numericCardNumber(value: string): number | null {
  const matched = value.match(/\d+/u)?.at(0);
  if (!matched) return null;
  const parsed = Number.parseInt(matched, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isPocketCard(card: z.infer<typeof tcgdexCardSchema>): boolean {
  return [card.set.logo, card.set.symbol].some((value) => value?.includes('/tcgp/') === true);
}

export async function transformTcgdexCard(
  value: unknown,
  language: LanguageCode,
  releaseDate?: string | null,
): Promise<ImportedCard | null> {
  const parsed = tcgdexCardSchema.safeParse(value);
  if (!parsed.success) throw new Error('tcgdex_card_invalid');
  const card = parsed.data;
  if (isPocketCard(card)) return null;
  const category =
    card.category === 'Pokemon' ? 'pokemon' : card.category === 'Trainer' ? 'trainer' : 'energy';
  const sourceUpdated = card.updated ?? card.updatedAt;
  const sourceUpdatedAt = sourceUpdated ? Math.floor(Date.parse(sourceUpdated) / 1000) : 0;
  const pokedexNumber = card.dexId?.length ? Math.min(...card.dexId) : null;
  const effectiveReleaseDate = releaseDate ?? card.set.releaseDate ?? null;
  const checksum = await sha256Text(
    JSON.stringify({ provider: 'tcgdex', language, card, releaseDate: effectiveReleaseDate }),
  );
  return {
    sourceId: card.id,
    checksum,
    sourceUpdatedAt,
    name: card.name,
    language,
    category,
    setId: card.set.id,
    setName: card.set.name,
    number: card.localId,
    numberSort: numericCardNumber(card.localId),
    supertype: card.category,
    subtype:
      category === 'pokemon'
        ? card.types?.join(', ') || null
        : category === 'trainer'
          ? (card.trainerType ?? null)
          : (card.energyType ?? null),
    species: category === 'pokemon' ? card.name : null,
    rarity: card.rarity ?? null,
    artist: card.illustrator ?? null,
    releaseDate: effectiveReleaseDate,
    pokedexNumber,
  };
}

export async function setImportedCardReleaseDate(
  card: ImportedCard,
  releaseDate: string | null,
): Promise<ImportedCard> {
  return {
    ...card,
    releaseDate,
    checksum: await sha256Text(JSON.stringify({ ...card, checksum: null, releaseDate })),
  };
}

export interface SyncInput {
  provider: 'tcgdex';
  language: LanguageCode;
  cards: ImportedCard[];
  allowDestructiveDrop?: boolean;
  complete?: boolean;
}

export interface CatalogueSourceEntry {
  cardId: string;
  provider: 'tcgdex';
  sourceId: string;
  language: LanguageCode;
  sourceUpdatedAt: number;
  sourceChecksum: string;
}

const sourceCursorSchema = z
  .object({
    cardId: z.string().min(1).max(128),
    language: languageSchema,
    sourceId: z.string().min(1).max(256),
  })
  .strict();
type SourceCursor = z.infer<typeof sourceCursorSchema>;

function encodeSourceCursor(cursor: SourceCursor): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(cursor)));
}

function decodeSourceCursor(cursor: string | null): SourceCursor | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(cursor)));
    const result = sourceCursorSchema.safeParse(parsed);
    if (!result.success) throw new ApplicationError('invalid_catalogue_source_cursor', 400);
    return result.data;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('invalid_catalogue_source_cursor', 400);
  }
}

export async function listCatalogueSources(
  db: D1Database,
  cursor: string | null,
  limit: number,
): Promise<{ entries: CatalogueSourceEntry[]; cursor: string | null }> {
  const decoded = decodeSourceCursor(cursor);
  const query = decoded
    ? `SELECT s.card_id, s.provider, s.source_id, s.language, s.source_updated_at, s.checksum
       FROM card_sources s JOIN catalogue_cards c ON c.id = s.card_id
       WHERE s.provider = 'tcgdex' AND s.active = 1 AND c.is_active = 1
         AND (s.card_id > ?1 OR (s.card_id = ?1 AND s.language > ?2) OR (s.card_id = ?1 AND s.language = ?2 AND s.source_id > ?3))
       ORDER BY s.card_id, s.language, s.source_id LIMIT ?4`
    : `SELECT s.card_id, s.provider, s.source_id, s.language, s.source_updated_at, s.checksum
       FROM card_sources s JOIN catalogue_cards c ON c.id = s.card_id
       WHERE s.provider = 'tcgdex' AND s.active = 1 AND c.is_active = 1
       ORDER BY s.card_id, s.language, s.source_id LIMIT ?1`;
  const statement = decoded
    ? db.prepare(query).bind(decoded.cardId, decoded.language, decoded.sourceId, limit + 1)
    : db.prepare(query).bind(limit + 1);
  const rows = await statement.all<{
    card_id: string;
    provider: string;
    source_id: string;
    language: LanguageCode;
    source_updated_at: number;
    checksum: string;
  }>();
  const hasNext = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  const entries = page.map((row) => ({
    cardId: row.card_id,
    provider: 'tcgdex' as const,
    sourceId: row.source_id,
    language: row.language,
    sourceUpdatedAt: row.source_updated_at,
    sourceChecksum: row.checksum,
  }));
  const last = entries.at(-1);
  return {
    entries,
    cursor:
      hasNext && last
        ? encodeSourceCursor({
            cardId: last.cardId,
            language: last.language,
            sourceId: last.sourceId,
          })
        : null,
  };
}

export async function resolveStagedCardId(
  existing: ReadonlyMap<string, string>,
  sourceId: string,
  language: LanguageCode,
): Promise<string> {
  return (
    existing.get(`${language}\u0000${sourceId}`) ??
    `card_${await sha256Text(`tcgdex\u0000${language}\u0000${sourceId}`)}`
  );
}

export async function beginStagedCatalogueRun(
  db: D1Database,
  language: LanguageCode,
  options: { runId?: string; complete?: boolean; objectKey?: string | null } = {},
): Promise<string> {
  const runId = options.runId ?? newId('sync');
  await db
    .prepare(
      `INSERT INTO sync_runs (id, provider, language, started_at, status, complete_source, object_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      runId,
      'tcgdex',
      language,
      nowSeconds(),
      'running',
      options.complete === false ? 0 : 1,
      options.objectKey ?? null,
    )
    .run();
  return runId;
}

const MAX_STAGE_JSON_BYTES = 1_500_000;
const MAX_STAGE_ROWS = 500;

interface StagedCard extends ImportedCard {
  cardId: string;
}

function physicalPrintingKey(card: {
  language: string;
  setName: string;
  number: string;
  name: string;
}): string {
  return [
    card.language,
    card.setName.toLocaleLowerCase('en'),
    card.number,
    card.name.toLocaleLowerCase('en'),
  ].join('\u0000');
}

function stageChunks(rows: StagedCard[]): StagedCard[][] {
  const chunks: StagedCard[][] = [];
  let current: StagedCard[] = [];
  let currentBytes = 2;
  for (const row of rows) {
    const rowBytes = new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
    if (rowBytes > MAX_STAGE_JSON_BYTES)
      throw new ApplicationError('catalogue_stage_row_too_large', 413);
    if (
      current.length > 0 &&
      (current.length >= MAX_STAGE_ROWS || currentBytes + rowBytes > MAX_STAGE_JSON_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function stageCatalogueCards(
  db: D1Database,
  runId: string,
  cards: ImportedCard[],
): Promise<void> {
  const sourceIds = new Set<string>();
  for (const card of cards) {
    const key = `${card.language}\u0000${card.sourceId}`;
    if (sourceIds.has(key)) throw new ApplicationError('invalid_or_duplicate_source_id', 400);
    sourceIds.add(key);
  }
  const noExistingIds = new Map<string, string>();
  const physicalIds = new Map<string, string>();
  for (let offset = 0; offset < cards.length; offset += MAX_STAGE_ROWS) {
    const input = cards.slice(offset, offset + MAX_STAGE_ROWS);
    const existing = await db
      .prepare(
        `SELECT card.id, card.language, card.set_name, card.number, card.name
         FROM catalogue_cards card
         JOIN json_each(?1) candidate
           ON card.language = json_extract(candidate.value, '$.language')
          AND lower(card.set_name) = lower(json_extract(candidate.value, '$.setName'))
          AND card.number = json_extract(candidate.value, '$.number')
          AND lower(card.name) = lower(json_extract(candidate.value, '$.name'))
         WHERE card.is_custom = 0`,
      )
      .bind(
        JSON.stringify(
          input.map((card) => ({
            language: card.language,
            setName: card.setName,
            number: card.number,
            name: card.name,
          })),
        ),
      )
      .all<{ id: string; language: string; set_name: string; number: string; name: string }>();
    for (const card of existing.results) {
      physicalIds.set(
        physicalPrintingKey({
          language: card.language,
          setName: card.set_name,
          number: card.number,
          name: card.name,
        }),
        card.id,
      );
    }
    const prepared = await Promise.all(
      input.map(async (card) => {
        const key = physicalPrintingKey(card);
        const cardId =
          physicalIds.get(key) ??
          (await resolveStagedCardId(noExistingIds, card.sourceId, card.language));
        physicalIds.set(key, cardId);
        return { ...card, cardId };
      }),
    );
    for (const chunk of stageChunks(prepared))
      await db
        .prepare(
          `INSERT INTO catalogue_stage_cards
          (run_id, source_id, card_id, checksum, source_updated_at, name, language, category,
           set_id, set_name, number, number_sort, supertype, subtype, species, rarity, artist,
           release_date, pokedex_number)
         SELECT ?1,
           json_extract(value, '$.sourceId'),
           COALESCE(
             (SELECT source.card_id FROM card_sources source
              WHERE source.provider = 'tcgdex'
                AND source.source_id = json_extract(value, '$.sourceId')
                AND source.language = json_extract(value, '$.language')),
             json_extract(value, '$.cardId')),
           json_extract(value, '$.checksum'), json_extract(value, '$.sourceUpdatedAt'),
           json_extract(value, '$.name'), json_extract(value, '$.language'),
           json_extract(value, '$.category'), json_extract(value, '$.setId'),
           json_extract(value, '$.setName'), json_extract(value, '$.number'),
           json_extract(value, '$.numberSort'), json_extract(value, '$.supertype'),
           json_extract(value, '$.subtype'), json_extract(value, '$.species'),
           json_extract(value, '$.rarity'), json_extract(value, '$.artist'),
           json_extract(value, '$.releaseDate'), json_extract(value, '$.pokedexNumber')
         FROM json_each(?2) WHERE true
         ON CONFLICT(run_id, source_id) DO UPDATE SET
           card_id = excluded.card_id, checksum = excluded.checksum,
           source_updated_at = excluded.source_updated_at, name = excluded.name,
           language = excluded.language, category = excluded.category, set_id = excluded.set_id,
           set_name = excluded.set_name, number = excluded.number,
           number_sort = excluded.number_sort, supertype = excluded.supertype,
           subtype = excluded.subtype, species = excluded.species, rarity = excluded.rarity,
           artist = excluded.artist, release_date = excluded.release_date,
           pokedex_number = excluded.pokedex_number`,
        )
        .bind(runId, JSON.stringify(chunk))
        .run();
  }
}

export async function applyStagedCatalogueRun(
  db: D1Database,
  runId: string,
  allowDestructiveDrop: boolean,
): Promise<{ imported: number; inactive: number }> {
  const run = await db
    .prepare(
      `SELECT provider, language, complete_source, started_at
       FROM sync_runs WHERE id = ?1 AND status = ?2`,
    )
    .bind(runId, 'running')
    .first<{
      provider: string;
      language: LanguageCode;
      complete_source: number;
      started_at: number;
    }>();
  if (!run || run.provider !== 'tcgdex') throw new ApplicationError('staged_sync_not_running', 409);
  try {
    const staged = await scalarCount(
      db,
      'SELECT COUNT(*) AS count FROM catalogue_stage_cards WHERE run_id = ?1',
      runId,
    );
    if (staged === 0) throw new ApplicationError('staged_sync_empty', 400);
    const superseded = await db
      .prepare(
        `SELECT 1 AS found FROM sync_runs
         WHERE provider = ?1 AND language = ?2 AND complete_source = 1
           AND started_at > ?3 AND status IN ('running', 'complete') LIMIT 1`,
      )
      .bind(run.provider, run.language, run.started_at)
      .first<{ found: number }>();
    if (run.complete_source === 1 && superseded) throw new ApplicationError('sync_superseded', 409);
    const existing = await scalarCount(
      db,
      'SELECT COUNT(*) AS count FROM card_sources WHERE provider = ?1 AND language = ?2 AND active = 1',
      'tcgdex',
      run.language,
    );
    if (
      run.complete_source === 1 &&
      existing > 0 &&
      staged * 5 < existing * 4 &&
      !allowDestructiveDrop
    )
      throw new ApplicationError('sync_count_drop_rejected', 409);
    const inactive =
      run.complete_source === 1
        ? await scalarCount(
            db,
            'SELECT COUNT(*) AS count FROM card_sources s WHERE s.provider = ?1 AND s.language = ?2 AND s.active = 1 AND NOT EXISTS (SELECT 1 FROM catalogue_stage_cards st WHERE st.run_id = ?3 AND st.source_id = s.source_id)',
            'tcgdex',
            run.language,
            runId,
          )
        : 0;
    const claimToken = crypto.randomUUID();
    const now = nowSeconds();
    const results = await db.batch([
      db
        .prepare(
          `SELECT CASE WHEN ?1 = 0 OR NOT EXISTS (
            SELECT 1 FROM sync_runs newer JOIN sync_runs current ON current.id = ?2
            WHERE newer.provider = current.provider AND newer.language = current.language
              AND newer.complete_source = 1 AND newer.started_at > current.started_at
              AND newer.status IN ('running', 'complete')
          ) THEN 1 ELSE json_extract('sync_superseded', '$') END AS valid`,
        )
        .bind(run.complete_source, runId),
      db
        .prepare(
          'INSERT INTO sync_run_claims (run_id, claim_token, claimed_at) VALUES (?1, ?2, ?3) ON CONFLICT(run_id) DO NOTHING',
        )
        .bind(runId, claimToken, now),
      db
        .prepare(
          `INSERT INTO catalogue_cards
            (id, name, language, category, set_id, set_name, number, number_sort, supertype,
             subtype, species, rarity, artist, release_date, pokedex_number, created_at, updated_at)
           SELECT card_id, name, language, category, set_id, set_name, number, number_sort,
             supertype, subtype, species, rarity, artist, release_date, pokedex_number, ?1, ?1
           FROM catalogue_stage_cards
           WHERE run_id = ?2
             AND EXISTS (SELECT 1 FROM sync_run_claims WHERE run_id = ?2 AND claim_token = ?3)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, language = excluded.language,
             category = excluded.category, set_id = excluded.set_id, set_name = excluded.set_name,
             number = excluded.number, number_sort = excluded.number_sort,
             supertype = excluded.supertype, subtype = excluded.subtype, species = excluded.species,
             rarity = excluded.rarity, artist = excluded.artist,
             release_date = excluded.release_date, pokedex_number = excluded.pokedex_number,
             is_active = 1, updated_at = excluded.updated_at
           WHERE catalogue_cards.is_custom = 0`,
        )
        .bind(now, runId, claimToken),
      db
        .prepare(
          `INSERT INTO card_sources (provider, source_id, card_id, language, source_updated_at, checksum, active, imported_at)
           SELECT 'tcgdex', source_id, card_id, language, source_updated_at, checksum, 1, ?1
           FROM catalogue_stage_cards
           WHERE run_id = ?2
             AND EXISTS (SELECT 1 FROM sync_run_claims WHERE run_id = ?2 AND claim_token = ?3)
           ON CONFLICT(provider, source_id, language) DO UPDATE SET
             checksum = excluded.checksum, source_updated_at = excluded.source_updated_at,
             active = 1, imported_at = excluded.imported_at`,
        )
        .bind(now, runId, claimToken),
      db
        .prepare(
          `DELETE FROM catalogue_search
           WHERE card_id IN (SELECT card_id FROM catalogue_stage_cards WHERE run_id = ?1)
             AND EXISTS (SELECT 1 FROM sync_run_claims WHERE run_id = ?1 AND claim_token = ?2)`,
        )
        .bind(runId, claimToken),
      db
        .prepare(
          `INSERT INTO catalogue_search (card_id, name, set_name, number, species, rarity, artist)
           SELECT card_id, name, set_name, number, COALESCE(species, ''),
             COALESCE(rarity, ''), COALESCE(artist, '')
           FROM catalogue_stage_cards
           WHERE run_id = ?1
             AND EXISTS (SELECT 1 FROM sync_run_claims WHERE run_id = ?1 AND claim_token = ?2)`,
        )
        .bind(runId, claimToken),
      db
        .prepare(
          `UPDATE card_sources SET active = 0, imported_at = ?1
           WHERE ?2 = 1 AND provider = 'tcgdex' AND language = ?3 AND active = 1
             AND NOT EXISTS (SELECT 1 FROM catalogue_stage_cards st WHERE st.run_id = ?4 AND st.source_id = card_sources.source_id)
             AND EXISTS (SELECT 1 FROM sync_run_claims WHERE run_id = ?4 AND claim_token = ?5)`,
        )
        .bind(now, run.complete_source, run.language, runId, claimToken),
      db
        .prepare(
          `UPDATE catalogue_cards SET is_active = 0, updated_at = ?1
           WHERE ?2 = 1 AND is_custom = 0 AND language = ?3 AND is_active = 1
             AND NOT EXISTS (SELECT 1 FROM card_sources source WHERE source.card_id = catalogue_cards.id AND source.active = 1)
             AND EXISTS (SELECT 1 FROM sync_run_claims WHERE run_id = ?4 AND claim_token = ?5)`,
        )
        .bind(now, run.complete_source, run.language, runId, claimToken),
      db
        .prepare(
          `DELETE FROM catalogue_search
           WHERE card_id IN (
             SELECT id FROM catalogue_cards WHERE ?1 = 1 AND language = ?2 AND is_active = 0
           )
             AND EXISTS (SELECT 1 FROM sync_run_claims WHERE run_id = ?3 AND claim_token = ?4)`,
        )
        .bind(run.complete_source, run.language, runId, claimToken),
      db
        .prepare(
          `DELETE FROM catalogue_stage_cards WHERE run_id = ?1
           AND EXISTS (SELECT 1 FROM sync_run_claims WHERE run_id = ?1 AND claim_token = ?2)`,
        )
        .bind(runId, claimToken),
      db
        .prepare(
          `UPDATE sync_runs SET completed_at = ?1, source_count = ?2, imported_count = ?2,
             inactive_count = ?3, status = 'complete', refusal_reason = NULL
           WHERE id = ?4 AND status = 'running'
             AND EXISTS (SELECT 1 FROM sync_run_claims WHERE run_id = ?4 AND claim_token = ?5)`,
        )
        .bind(now, staged, inactive, runId, claimToken),
    ]);
    if (results.at(-1)?.meta.changes !== 1) {
      const completed = await db
        .prepare("SELECT status FROM sync_runs WHERE id = ?1 AND status = 'complete'")
        .bind(runId)
        .first<{ status: 'complete' }>();
      if (completed) return { imported: staged, inactive };
      throw new ApplicationError('staged_sync_already_applied', 409);
    }
    return { imported: staged, inactive };
  } catch (error) {
    const message = error instanceof ApplicationError ? error.code : String(error);
    const status =
      message === 'sync_count_drop_rejected' ||
      message === 'staged_sync_empty' ||
      message === 'sync_superseded'
        ? 'rejected'
        : 'failed';
    await db
      .prepare(
        `UPDATE sync_runs SET completed_at = ?1, status = ?2, refusal_reason = ?3
         WHERE id = ?4 AND status = 'running'`,
      )
      .bind(nowSeconds(), status, message, runId)
      .run();
    throw error;
  }
}

function artUrl(
  cardId: string,
  variant: 'high' | 'low',
  key: string | null,
  sourceProvider: string | null,
): string | null {
  return key || sourceProvider === 'tcgdex'
    ? `/api/art/${encodeURIComponent(cardId)}/${variant}`
    : null;
}

export interface NationalPokedexCoverage {
  number: number;
  totalCards: number;
  ownedCards: number;
  types: string[];
  representative: {
    cardId: string;
    cardName: string;
    setName: string;
    number: string;
    imageLowUrl: string | null;
    imageHighUrl: string | null;
    explicit: boolean;
  };
}

export async function listNationalPokedexCoverage(
  db: D1Database,
  ownerId: string,
): Promise<NationalPokedexCoverage[]> {
  const result = await db
    .prepare(
      `WITH coverage AS (
         SELECT c.pokedex_number,
           COUNT(DISTINCT c.id) AS total_cards,
           COUNT(DISTINCT CASE WHEN cc.quantity > 0 THEN c.id END) AS owned_cards,
           GROUP_CONCAT(DISTINCT c.subtype) AS types
         FROM catalogue_cards c
         LEFT JOIN collection_cards cc ON cc.card_id = c.id AND cc.owner_id = ?1
         WHERE c.is_active = 1 AND c.category = 'pokemon'
           AND c.pokedex_number BETWEEN 1 AND 1025
         GROUP BY c.pokedex_number
       ), ranked AS (
         SELECT c.pokedex_number, c.id, c.name, c.set_name, c.number,
           low.object_key AS low_key, high.object_key AS high_key,
           EXISTS (
             SELECT 1 FROM card_sources source
             WHERE source.card_id = c.id AND source.provider = 'tcgdex' AND source.active = 1
           ) AS has_tcgdex_source,
           ROW_NUMBER() OVER (
             PARTITION BY c.pokedex_number
             ORDER BY CASE WHEN c.release_date IS NULL THEN 1 ELSE 0 END, c.release_date,
               c.set_name, CASE WHEN c.number_sort IS NULL THEN 1 ELSE 0 END,
               c.number_sort, c.number, c.id
           ) AS rank
         FROM catalogue_cards c
         LEFT JOIN art_manifest low ON low.card_id = c.id AND low.variant = 'low'
         LEFT JOIN art_manifest high ON high.card_id = c.id AND high.variant = 'high'
         WHERE c.is_active = 1 AND c.category = 'pokemon'
           AND c.pokedex_number BETWEEN 1 AND 1025
       ), preferred AS (
         SELECT choice.pokedex_number, card.id, card.name, card.set_name, card.number,
           low.object_key AS low_key, high.object_key AS high_key,
           EXISTS (
             SELECT 1 FROM card_sources source
             WHERE source.card_id = card.id AND source.provider = 'tcgdex' AND source.active = 1
           ) AS has_tcgdex_source
         FROM species_representatives choice
         JOIN catalogue_cards card ON card.id = choice.card_id
           AND card.is_active = 1 AND card.category = 'pokemon'
         LEFT JOIN art_manifest low ON low.card_id = card.id AND low.variant = 'low'
         LEFT JOIN art_manifest high ON high.card_id = card.id AND high.variant = 'high'
         WHERE choice.owner_id = ?1
       )
       SELECT coverage.pokedex_number, coverage.total_cards, coverage.owned_cards, coverage.types,
         CASE WHEN preferred.id IS NOT NULL THEN preferred.id ELSE ranked.id END AS id,
         CASE WHEN preferred.id IS NOT NULL THEN preferred.name ELSE ranked.name END AS name,
         CASE WHEN preferred.id IS NOT NULL THEN preferred.set_name ELSE ranked.set_name END AS set_name,
         CASE WHEN preferred.id IS NOT NULL THEN preferred.number ELSE ranked.number END AS number,
         CASE WHEN preferred.id IS NOT NULL THEN preferred.low_key ELSE ranked.low_key END AS low_key,
         CASE WHEN preferred.id IS NOT NULL THEN preferred.high_key ELSE ranked.high_key END AS high_key,
         CASE WHEN preferred.id IS NOT NULL THEN preferred.has_tcgdex_source
           ELSE ranked.has_tcgdex_source END AS has_tcgdex_source,
         CASE WHEN preferred.id IS NOT NULL THEN 1 ELSE 0 END AS is_explicit
       FROM coverage JOIN ranked
         ON ranked.pokedex_number = coverage.pokedex_number AND ranked.rank = 1
       LEFT JOIN preferred ON preferred.pokedex_number = coverage.pokedex_number
       ORDER BY coverage.pokedex_number`,
    )
    .bind(ownerId)
    .all<{
      pokedex_number: number;
      total_cards: number;
      owned_cards: number;
      types: string | null;
      id: string;
      name: string;
      set_name: string;
      number: string;
      low_key: string | null;
      high_key: string | null;
      has_tcgdex_source: number;
      is_explicit: number;
    }>();
  return result.results.map((row) => ({
    number: row.pokedex_number,
    totalCards: row.total_cards,
    ownedCards: row.owned_cards,
    types: Array.from(
      new Set(
        (row.types ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ).sort((left, right) => left.localeCompare(right, 'en-AU')),
    representative: {
      cardId: row.id,
      cardName: row.name,
      setName: row.set_name,
      number: row.number,
      imageLowUrl:
        row.low_key || row.has_tcgdex_source === 1
          ? `/api/art/${encodeURIComponent(row.id)}/low`
          : null,
      imageHighUrl:
        row.high_key || row.has_tcgdex_source === 1
          ? `/api/art/${encodeURIComponent(row.id)}/high`
          : null,
      explicit: row.is_explicit === 1,
    },
  }));
}

export async function setNationalPokedexRepresentative(
  db: D1Database,
  ownerId: string,
  pokedexNumber: number,
  cardId: string,
): Promise<void> {
  const matching = await db
    .prepare(
      `SELECT id FROM catalogue_cards
       WHERE id = ?1 AND pokedex_number = ?2 AND category = 'pokemon' AND is_active = 1`,
    )
    .bind(cardId, pokedexNumber)
    .first<{ id: string }>();
  if (!matching) throw new ApplicationError('national_representative_mismatch', 400);
  await db
    .prepare(
      `INSERT INTO species_representatives (owner_id, pokedex_number, card_id, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(owner_id, pokedex_number) DO UPDATE SET
         card_id = excluded.card_id, updated_at = excluded.updated_at`,
    )
    .bind(ownerId, pokedexNumber, cardId, nowSeconds())
    .run();
}

export async function setNationalRepresentativesFromSources(
  db: D1Database,
  ownerId: string,
  choices: Array<{ number: number; name: string; sourceId: string }>,
): Promise<Array<{ number: number; cardId: string }>> {
  if (new Set(choices.map((choice) => choice.number)).size !== choices.length)
    throw new ApplicationError('national_representatives_invalid', 400);
  const encoded = JSON.stringify(choices);
  const resolved = await db
    .prepare(
      `SELECT CAST(json_extract(choice.value, '$.number') AS INTEGER) AS pokedex_number,
        source.card_id
       FROM json_each(?1) choice
       JOIN card_sources source
         ON source.provider = 'tcgdex' AND source.language = 'en' AND source.active = 1
        AND source.source_id = json_extract(choice.value, '$.sourceId')
       JOIN catalogue_cards card ON card.id = source.card_id AND card.is_active = 1
        AND card.category = 'pokemon'
        AND lower(card.name) = lower(json_extract(choice.value, '$.name'))
       ORDER BY pokedex_number`,
    )
    .bind(encoded)
    .all<{ pokedex_number: number; card_id: string }>();
  if (resolved.results.length !== choices.length)
    throw new ApplicationError('national_representatives_incomplete', 409);
  await db
    .prepare(
      `INSERT INTO species_representatives (owner_id, pokedex_number, card_id, updated_at)
       SELECT ?1, CAST(json_extract(choice.value, '$.number') AS INTEGER), source.card_id, ?3
       FROM json_each(?2) choice
       JOIN card_sources source
         ON source.provider = 'tcgdex' AND source.language = 'en' AND source.active = 1
        AND source.source_id = json_extract(choice.value, '$.sourceId')
       JOIN catalogue_cards card ON card.id = source.card_id AND card.is_active = 1
        AND card.category = 'pokemon'
        AND lower(card.name) = lower(json_extract(choice.value, '$.name'))
       WHERE true
       ON CONFLICT(owner_id, pokedex_number) DO UPDATE SET
         card_id = excluded.card_id, updated_at = excluded.updated_at`,
    )
    .bind(ownerId, encoded, nowSeconds())
    .run();
  return resolved.results.map((row) => ({ number: row.pokedex_number, cardId: row.card_id }));
}

function brief(row: CardRow): CatalogueBrief {
  return {
    id: cardIdSchema.parse(row.id),
    name: row.name,
    language: row.language,
    category: row.category,
    setId: row.set_id,
    setName: row.set_name,
    number: row.number,
    imageLowUrl: artUrl(row.id, 'low', row.low_key, row.source_provider),
  };
}

function collection(row: CardRow): CatalogueCardView['collection'] {
  if (
    row.quantity === null ||
    row.collection_updated_at === null ||
    row.collection_revision === null
  )
    return null;
  return {
    cardId: cardIdSchema.parse(row.id),
    quantity: row.quantity,
    notes: row.notes,
    updatedAt: isoFromSeconds(row.collection_updated_at),
    revision: row.collection_revision,
  };
}

function cardPrice(row: CardRow): CatalogueCardView['price'] {
  if (
    !row.price_source ||
    row.price_native_micros === null ||
    !row.price_native_currency ||
    row.price_source_captured_at === null
  ) {
    return {
      amountAud: null,
      nativeAmount: null,
      nativeCurrency: null,
      source: null,
      sourceCapturedAt: null,
      fxDate: null,
    };
  }
  return {
    amountAud: row.price_aud_micros === null ? null : row.price_aud_micros / 1_000_000,
    nativeAmount: row.price_native_micros / 1_000_000,
    nativeCurrency: row.price_native_currency,
    source: row.price_source,
    sourceCapturedAt: isoFromSeconds(row.price_source_captured_at),
    fxDate: row.price_fx_date,
  };
}

function detail(row: CardRow): CatalogueDetailView {
  const source =
    row.source_provider && row.source_id && row.source_updated_at !== null
      ? {
          provider: row.source_provider,
          sourceId: row.source_id,
          updatedAt: isoFromSeconds(row.source_updated_at),
        }
      : row.is_custom === 1
        ? { provider: 'manual', sourceId: row.id, updatedAt: isoFromSeconds(row.updated_at) }
        : null;
  if (!source) throw new Error('card_provenance_missing');
  return {
    ...brief(row),
    supertype: row.supertype,
    subtype: row.subtype,
    species: row.species,
    rarity: row.rarity,
    artist: row.artist,
    imageHighUrl: artUrl(row.id, 'high', row.high_key, row.source_provider),
    source,
    notes: row.notes,
    collection: collection(row),
    price: cardPrice(row),
  };
}

function view(row: CardRow): CatalogueCardView {
  return {
    ...brief(row),
    imageHighUrl: artUrl(row.id, 'high', row.high_key, row.source_provider),
    collection: collection(row),
    price: cardPrice(row),
  };
}

const cardSelect = `
  SELECT c.id, c.name, c.language, c.category, c.set_id, c.set_name, c.number, c.number_sort,
    c.supertype, c.subtype, c.species, c.rarity, c.artist, c.is_active, c.is_custom, c.updated_at,
    s.provider AS source_provider, s.source_id, s.source_updated_at,
    cc.notes, cc.quantity, cc.updated_at AS collection_updated_at,
    cc.revision AS collection_revision,
    low.object_key AS low_key, high.object_key AS high_key,
    price.source AS price_source, price.native_amount_micros AS price_native_micros,
    price.native_currency AS price_native_currency,
    price.source_captured_at AS price_source_captured_at, price.fx_date AS price_fx_date,
    price.amount_aud_micros AS price_aud_micros
  FROM catalogue_cards c
  LEFT JOIN card_sources s ON s.rowid = (
    SELECT source.rowid FROM card_sources source
    WHERE source.card_id = c.id AND source.active = 1
    ORDER BY source.imported_at DESC, source.provider, source.source_id
    LIMIT 1
  )
  LEFT JOIN collection_cards cc ON cc.card_id = c.id AND cc.owner_id = ?1
  LEFT JOIN art_manifest low ON low.card_id = c.id AND low.variant = 'low'
  LEFT JOIN art_manifest high ON high.card_id = c.id AND high.variant = 'high'
  LEFT JOIN card_current_prices price ON price.card_id = c.id`;

export async function resolveCatalogueCards(
  db: D1Database,
  ownerId: string,
  cardIds: string[],
): Promise<CatalogueCardView[]> {
  if (cardIds.length === 0) return [];
  if (cardIds.length > 200 || new Set(cardIds).size !== cardIds.length)
    throw new ApplicationError('invalid_card_ids', 400);
  const result = await db
    .prepare(
      `${cardSelect}
       WHERE c.id IN (SELECT value FROM json_each(?2))
       ORDER BY c.set_name, CASE WHEN c.number_sort IS NULL THEN 1 ELSE 0 END,
         c.number_sort, c.number, c.name, c.id`,
    )
    .bind(ownerId, JSON.stringify(cardIds))
    .all<CardRow>();
  return result.results.map(view);
}

export async function searchCards(
  db: D1Database,
  ownerId: string,
  filters: CatalogueFilters,
): Promise<{ total: number; cards: CatalogueCardView[]; cursor: string | null }> {
  const where = ['c.is_active = 1'];
  const values: unknown[] = [ownerId];
  const fts = filters.query ? escapedFtsQuery(filters.query) : null;
  if (fts) {
    where.push('c.id IN (SELECT card_id FROM catalogue_search WHERE catalogue_search MATCH ?2)');
    values.push(fts);
  }
  if (filters.language) {
    where.push(`c.language = ?${values.length + 1}`);
    values.push(filters.language);
  }
  if (filters.category) {
    where.push(`c.category = ?${values.length + 1}`);
    values.push(filters.category);
  }
  if (filters.setId) {
    where.push(`c.set_id = ?${values.length + 1}`);
    values.push(filters.setId);
  }
  if (filters.species) {
    where.push(`c.species = ?${values.length + 1}`);
    values.push(filters.species);
  }
  if (filters.pokedexNumber !== undefined) {
    where.push(`c.pokedex_number = ?${values.length + 1}`);
    values.push(filters.pokedexNumber);
  }
  if (filters.owned !== undefined) {
    where.push(filters.owned ? 'COALESCE(cc.quantity, 0) > 0' : 'COALESCE(cc.quantity, 0) = 0');
  }
  const predicate = where.join(' AND ');
  const cursor = decodeCatalogueCursor(filters.cursor);
  if (cursor && filters.offset !== 0) throw new ApplicationError('invalid_catalogue_cursor', 400);
  const filterKey = JSON.stringify({
    query: fts,
    language: filters.language ?? null,
    category: filters.category ?? null,
    setId: filters.setId ?? null,
    species: filters.species ?? null,
    pokedexNumber: filters.pokedexNumber ?? null,
    owned: filters.owned ?? null,
  });
  if (cursor && cursor.filterKey !== filterKey)
    throw new ApplicationError('invalid_catalogue_cursor', 400);
  const total = cursor
    ? cursor.total
    : await scalarCount(
        db,
        `SELECT COUNT(*) AS count FROM catalogue_cards c
          LEFT JOIN collection_cards cc ON cc.card_id = c.id AND cc.owner_id = ?1
          WHERE ${predicate}`,
        ...values,
      );
  const pageWhere = [...where];
  if (cursor) {
    const cursorIndex = values.length + 1;
    pageWhere.push(
      `(c.set_name, c.number_sort IS NULL, COALESCE(c.number_sort, 0), c.number, c.name, c.id) >
       (?${cursorIndex}, ?${cursorIndex + 1}, ?${cursorIndex + 2}, ?${cursorIndex + 3}, ?${cursorIndex + 4}, ?${cursorIndex + 5})`,
    );
    values.push(
      cursor.setName,
      cursor.numberSortMissing,
      cursor.numberSort,
      cursor.number,
      cursor.name,
      cursor.id,
    );
  }
  const limitIndex = values.length + 1;
  const offsetIndex = values.length + 2;
  const result = await db
    .prepare(
      `${cardSelect} WHERE ${pageWhere.join(' AND ')}
       ORDER BY c.set_name, c.number_sort IS NULL, COALESCE(c.number_sort, 0), c.number, c.name, c.id
       LIMIT ?${limitIndex} OFFSET ?${offsetIndex}`,
    )
    .bind(...values, filters.limit + 1, cursor ? 0 : filters.offset)
    .all<CardRow>();
  const page = result.results.slice(0, filters.limit);
  const last = page.at(-1);
  return {
    total,
    cards: page.map(view),
    cursor:
      result.results.length > filters.limit && last
        ? encodeCatalogueCursor(last, filterKey, total)
        : null,
  };
}

export async function getCardDetail(
  db: D1Database,
  ownerId: string,
  cardId: string,
): Promise<CatalogueDetailView | null> {
  const row = await db
    .prepare(`${cardSelect} WHERE c.id = ?2`)
    .bind(ownerId, cardId)
    .first<CardRow>();
  return row ? detail(row) : null;
}

export async function listSetFacets(
  db: D1Database,
  ownerId: string,
  language?: LanguageCode,
): Promise<
  Array<{ setId: string; setName: string; language: LanguageCode; total: number; owned: number }>
> {
  const result = await db
    .prepare(
      `SELECT c.set_id, c.set_name, c.language, COUNT(*) AS total, COUNT(CASE WHEN COALESCE(cc.quantity, 0) > 0 THEN 1 END) AS owned
    FROM catalogue_cards c LEFT JOIN collection_cards cc ON cc.card_id = c.id AND cc.owner_id = ?1
    WHERE c.is_active = 1 AND (?2 IS NULL OR c.language = ?2)
    GROUP BY c.set_id, c.set_name, c.language ORDER BY c.set_name COLLATE NOCASE, c.language`,
    )
    .bind(ownerId, language ?? null)
    .all<{
      set_id: string;
      set_name: string;
      language: LanguageCode;
      total: number;
      owned: number;
    }>();
  return result.results.map((row) => ({
    setId: row.set_id,
    setName: row.set_name,
    language: row.language,
    total: row.total,
    owned: row.owned,
  }));
}

export async function listSpeciesFacets(
  db: D1Database,
  ownerId: string,
  language?: LanguageCode,
): Promise<Array<{ species: string; total: number; owned: number; languages: LanguageCode[] }>> {
  const result = await db
    .prepare(
      `SELECT c.species, COUNT(*) AS total, COUNT(CASE WHEN COALESCE(cc.quantity, 0) > 0 THEN 1 END) AS owned, GROUP_CONCAT(DISTINCT c.language) AS languages
    FROM catalogue_cards c LEFT JOIN collection_cards cc ON cc.card_id = c.id AND cc.owner_id = ?1
    WHERE c.is_active = 1 AND c.species IS NOT NULL AND (?2 IS NULL OR c.language = ?2)
    GROUP BY c.species ORDER BY c.species COLLATE NOCASE`,
    )
    .bind(ownerId, language ?? null)
    .all<{ species: string; total: number; owned: number; languages: string }>();
  return result.results.map((row) => ({
    species: row.species,
    total: row.total,
    owned: row.owned,
    languages: row.languages
      .split(',')
      .filter((item): item is LanguageCode =>
        [
          'en',
          'fr',
          'es',
          'es-mx',
          'it',
          'pt',
          'pt-br',
          'pt-pt',
          'de',
          'nl',
          'pl',
          'ru',
          'ja',
          'ko',
          'zh-tw',
          'id',
          'th',
          'zh-cn',
        ].includes(item),
      ),
  }));
}

export async function createCustomCard(
  db: D1Database,
  input: Omit<ImportedCard, 'sourceId' | 'checksum' | 'sourceUpdatedAt'>,
): Promise<string> {
  const id = newId('custom');
  const now = nowSeconds();
  await db.batch([
    db
      .prepare(
        `INSERT INTO catalogue_cards
          (id, name, language, category, set_id, set_name, number, number_sort, supertype,
           subtype, species, rarity, artist, is_custom, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, ?14, ?14)`,
      )
      .bind(
        id,
        input.name,
        input.language,
        input.category,
        input.setId,
        input.setName,
        input.number,
        input.numberSort ?? numericCardNumber(input.number),
        input.supertype ?? null,
        input.subtype ?? null,
        input.species ?? null,
        input.rarity ?? null,
        input.artist ?? null,
        now,
      ),
    db
      .prepare(
        `INSERT INTO catalogue_search
          (card_id, name, set_name, number, species, rarity, artist)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        id,
        input.name,
        input.setName,
        input.number,
        input.species ?? '',
        input.rarity ?? '',
        input.artist ?? '',
      ),
  ]);
  return id;
}

export async function importCatalogueLanguage(
  db: D1Database,
  input: SyncInput,
): Promise<{ runId: string; imported: number; inactive: number }> {
  const sourceIds = new Set<string>();
  for (const card of input.cards) {
    if (!card.sourceId || sourceIds.has(card.sourceId))
      throw new ApplicationError('invalid_or_duplicate_source_id', 400);
    sourceIds.add(card.sourceId);
  }
  const runId = await beginStagedCatalogueRun(db, input.language, {
    complete: input.complete ?? false,
  });
  try {
    await stageCatalogueCards(db, runId, input.cards);
    const result = await applyStagedCatalogueRun(db, runId, input.allowDestructiveDrop ?? false);
    return { runId, ...result };
  } catch (error) {
    await db
      .prepare(
        `UPDATE sync_runs SET completed_at = ?1, status = 'failed', refusal_reason = ?2
         WHERE id = ?3 AND status = 'running'`,
      )
      .bind(nowSeconds(), error instanceof Error ? error.message : String(error), runId)
      .run();
    throw error;
  }
}
