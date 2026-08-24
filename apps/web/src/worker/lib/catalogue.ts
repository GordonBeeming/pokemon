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
import { priceForCard } from './pricing';

interface CardRow {
  id: string;
  name: string;
  language: LanguageCode;
  category: CatalogueBrief['category'];
  set_id: string;
  set_name: string;
  number: string;
  supertype: string | null;
  subtype: string | null;
  species: string | null;
  rarity: string | null;
  artist: string | null;
  is_active: number;
  source_provider: string | null;
  source_id: string | null;
  source_updated_at: number | null;
  notes: string | null;
  quantity: number | null;
  collection_updated_at: number | null;
  low_key: string | null;
  high_key: string | null;
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
  supertype?: string | null;
  subtype?: string | null;
  species?: string | null;
  rarity?: string | null;
  artist?: string | null;
  releaseDate?: string | null;
  pokedexNumber?: number | null;
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
    if (!result.success) throw new Error('invalid_catalogue_source_cursor');
    return result.data;
  } catch {
    throw new Error('invalid_catalogue_source_cursor');
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

export function resolveStagedCardId(
  existing: ReadonlyMap<string, string>,
  sourceId: string,
  language: LanguageCode,
): string {
  return existing.get(`${language}\u0000${sourceId}`) ?? newId('card');
}

export async function beginStagedCatalogueRun(
  db: D1Database,
  language: LanguageCode,
): Promise<string> {
  const runId = newId('sync');
  await db
    .prepare(
      'INSERT INTO sync_runs (id, provider, language, started_at, status) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
    .bind(runId, 'tcgdex', language, nowSeconds(), 'running')
    .run();
  return runId;
}

export async function stageCatalogueCards(
  db: D1Database,
  runId: string,
  cards: ImportedCard[],
): Promise<void> {
  const existingBySource = new Map<string, string>();
  for (const language of new Set(cards.map((card) => card.language))) {
    const rows = await db
      .prepare('SELECT source_id, card_id FROM card_sources WHERE provider = ?1 AND language = ?2')
      .bind('tcgdex', language)
      .all<{ source_id: string; card_id: string }>();
    for (const row of rows.results)
      existingBySource.set(`${language}\u0000${row.source_id}`, row.card_id);
  }
  const statements = [];
  for (const card of cards) {
    const cardId = resolveStagedCardId(existingBySource, card.sourceId, card.language);
    statements.push(
      db
        .prepare(
          'INSERT INTO catalogue_stage_cards (run_id, source_id, card_id, checksum, source_updated_at, name, language, category, set_id, set_name, number, supertype, subtype, species, rarity, artist) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16) ON CONFLICT(run_id, source_id) DO UPDATE SET checksum = excluded.checksum, source_updated_at = excluded.source_updated_at, name = excluded.name, category = excluded.category, set_id = excluded.set_id, set_name = excluded.set_name, number = excluded.number, supertype = excluded.supertype, subtype = excluded.subtype, species = excluded.species, rarity = excluded.rarity, artist = excluded.artist',
        )
        .bind(
          runId,
          card.sourceId,
          cardId,
          card.checksum,
          card.sourceUpdatedAt,
          card.name,
          card.language,
          card.category,
          card.setId,
          card.setName,
          card.number,
          card.supertype ?? null,
          card.subtype ?? null,
          card.species ?? null,
          card.rarity ?? null,
          card.artist ?? null,
        ),
    );
  }
  for (let offset = 0; offset < statements.length; offset += 50)
    await db.batch(statements.slice(offset, offset + 50));
}

export async function applyStagedCatalogueRun(
  db: D1Database,
  runId: string,
  allowDestructiveDrop: boolean,
): Promise<{ imported: number; inactive: number }> {
  const run = await db
    .prepare('SELECT provider, language FROM sync_runs WHERE id = ?1 AND status = ?2')
    .bind(runId, 'running')
    .first<{ provider: string; language: LanguageCode }>();
  if (!run || run.provider !== 'tcgdex') throw new Error('staged_sync_not_running');
  try {
    const staged = await scalarCount(
      db,
      'SELECT COUNT(*) AS count FROM catalogue_stage_cards WHERE run_id = ?1',
      runId,
    );
    if (staged === 0) throw new Error('staged_sync_empty');
    const existing = await scalarCount(
      db,
      'SELECT COUNT(*) AS count FROM card_sources WHERE provider = ?1 AND language = ?2 AND active = 1',
      'tcgdex',
      run.language,
    );
    if (existing > 0 && staged < Math.floor(existing * 0.8) && !allowDestructiveDrop)
      throw new Error('sync_count_drop_rejected');
    const inactive = await scalarCount(
      db,
      'SELECT COUNT(*) AS count FROM card_sources s WHERE s.provider = ?1 AND s.language = ?2 AND s.active = 1 AND NOT EXISTS (SELECT 1 FROM catalogue_stage_cards st WHERE st.run_id = ?3 AND st.source_id = s.source_id)',
      'tcgdex',
      run.language,
      runId,
    );
    await db.batch([
      db
        .prepare(
          `INSERT INTO catalogue_cards (id, name, language, category, set_id, set_name, number, supertype, subtype, species, rarity, artist, created_at, updated_at)
        SELECT card_id, name, language, category, set_id, set_name, number, supertype, subtype, species, rarity, artist, ?1, ?1 FROM catalogue_stage_cards WHERE run_id = ?2
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, language = excluded.language, category = excluded.category, set_id = excluded.set_id, set_name = excluded.set_name, number = excluded.number, supertype = excluded.supertype, subtype = excluded.subtype, species = excluded.species, rarity = excluded.rarity, artist = excluded.artist, is_active = 1, updated_at = excluded.updated_at WHERE catalogue_cards.is_custom = 0`,
        )
        .bind(nowSeconds(), runId),
      db
        .prepare(
          `INSERT INTO card_sources (provider, source_id, card_id, language, source_updated_at, checksum, active, imported_at)
        SELECT 'tcgdex', source_id, card_id, language, source_updated_at, checksum, 1, ?1 FROM catalogue_stage_cards WHERE run_id = ?2
        ON CONFLICT(provider, source_id, language) DO UPDATE SET checksum = excluded.checksum, source_updated_at = excluded.source_updated_at, active = 1, imported_at = excluded.imported_at`,
        )
        .bind(nowSeconds(), runId),
      db
        .prepare(
          'DELETE FROM catalogue_search WHERE card_id IN (SELECT card_id FROM catalogue_stage_cards WHERE run_id = ?1)',
        )
        .bind(runId),
      db
        .prepare(
          `INSERT INTO catalogue_search (card_id, name, set_name, number, species, rarity, artist)
        SELECT card_id, name, set_name, number, COALESCE(species, ''), COALESCE(rarity, ''), COALESCE(artist, '') FROM catalogue_stage_cards WHERE run_id = ?1`,
        )
        .bind(runId),
      db
        .prepare(
          `UPDATE card_sources SET active = 0, imported_at = ?1 WHERE provider = 'tcgdex' AND language = ?2 AND active = 1 AND NOT EXISTS (SELECT 1 FROM catalogue_stage_cards st WHERE st.run_id = ?3 AND st.source_id = card_sources.source_id)`,
        )
        .bind(nowSeconds(), run.language, runId),
      db
        .prepare(
          'UPDATE sync_runs SET completed_at = ?1, source_count = ?2, imported_count = ?2, inactive_count = ?3, status = ?4 WHERE id = ?5',
        )
        .bind(nowSeconds(), staged, inactive, 'complete', runId),
    ]);
    return { imported: staged, inactive };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      message === 'sync_count_drop_rejected' || message === 'staged_sync_empty'
        ? 'rejected'
        : 'failed';
    await db
      .prepare(
        'UPDATE sync_runs SET completed_at = ?1, status = ?2, refusal_reason = ?3 WHERE id = ?4',
      )
      .bind(nowSeconds(), status, message, runId)
      .run();
    throw error;
  }
}

function artUrl(cardId: string, variant: 'high' | 'low', key: string | null): string | null {
  return key ? `/api/art/${encodeURIComponent(cardId)}/${variant}` : null;
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
    imageLowUrl: artUrl(row.id, 'low', row.low_key),
  };
}

function collection(row: CardRow): CatalogueCardView['collection'] {
  if (row.quantity === null || row.collection_updated_at === null) return null;
  return {
    cardId: cardIdSchema.parse(row.id),
    quantity: row.quantity,
    notes: row.notes,
    updatedAt: isoFromSeconds(row.collection_updated_at),
  };
}

async function detail(db: D1Database, row: CardRow): Promise<CatalogueDetailView> {
  if (!row.source_provider || !row.source_id || row.source_updated_at === null)
    throw new Error('card_provenance_missing');
  return {
    ...brief(row),
    supertype: row.supertype,
    subtype: row.subtype,
    species: row.species,
    rarity: row.rarity,
    artist: row.artist,
    imageHighUrl: artUrl(row.id, 'high', row.high_key),
    source: {
      provider: row.source_provider,
      sourceId: row.source_id,
      updatedAt: isoFromSeconds(row.source_updated_at),
    },
    notes: row.notes,
    collection: collection(row),
    price: await priceForCard(db, row.id),
  };
}

async function view(db: D1Database, row: CardRow): Promise<CatalogueCardView> {
  return { ...brief(row), collection: collection(row), price: await priceForCard(db, row.id) };
}

const cardSelect = `
  SELECT c.id, c.name, c.language, c.category, c.set_id, c.set_name, c.number,
    c.supertype, c.subtype, c.species, c.rarity, c.artist, c.is_active,
    s.provider AS source_provider, s.source_id, s.source_updated_at,
    cc.notes, cc.quantity, cc.updated_at AS collection_updated_at, low.object_key AS low_key, high.object_key AS high_key
  FROM catalogue_cards c
  LEFT JOIN card_sources s ON s.card_id = c.id AND s.active = 1
  LEFT JOIN collection_cards cc ON cc.card_id = c.id AND cc.owner_id = ?1
  LEFT JOIN art_manifest low ON low.card_id = c.id AND low.variant = 'low'
  LEFT JOIN art_manifest high ON high.card_id = c.id AND high.variant = 'high'`;

export async function searchCards(
  db: D1Database,
  ownerId: string,
  filters: CatalogueFilters,
): Promise<{ total: number; cards: CatalogueCardView[] }> {
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
  if (filters.owned !== undefined) {
    where.push(filters.owned ? 'COALESCE(cc.quantity, 0) > 0' : 'COALESCE(cc.quantity, 0) = 0');
  }
  const predicate = where.join(' AND ');
  const total = await scalarCount(
    db,
    `SELECT COUNT(*) AS count FROM catalogue_cards c
      LEFT JOIN collection_cards cc ON cc.card_id = c.id AND cc.owner_id = ?1
      WHERE ${predicate.replaceAll('?1', '?1')}`,
    ...values,
  );
  const limitIndex = values.length + 1;
  const offsetIndex = values.length + 2;
  const result = await db
    .prepare(
      `${cardSelect} WHERE ${predicate} ORDER BY c.set_name, c.number, c.name LIMIT ?${limitIndex} OFFSET ?${offsetIndex}`,
    )
    .bind(...values, filters.limit, filters.offset)
    .all<CardRow>();
  return { total, cards: await Promise.all(result.results.map((row) => view(db, row))) };
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
  return row ? detail(db, row) : null;
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

async function upsertSearch(db: D1Database, card: ImportedCard, cardId: string): Promise<void> {
  await db.prepare('DELETE FROM catalogue_search WHERE card_id = ?1').bind(cardId).run();
  await db
    .prepare(
      'INSERT INTO catalogue_search (card_id, name, set_name, number, species, rarity, artist) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    )
    .bind(
      cardId,
      card.name,
      card.setName,
      card.number,
      card.species ?? '',
      card.rarity ?? '',
      card.artist ?? '',
    )
    .run();
}

export async function createCustomCard(
  db: D1Database,
  input: Omit<ImportedCard, 'sourceId' | 'checksum' | 'sourceUpdatedAt'>,
): Promise<string> {
  const id = newId('custom');
  const now = nowSeconds();
  await db
    .prepare(
      'INSERT INTO catalogue_cards (id, name, language, category, set_id, set_name, number, supertype, subtype, species, rarity, artist, is_custom, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?13)',
    )
    .bind(
      id,
      input.name,
      input.language,
      input.category,
      input.setId,
      input.setName,
      input.number,
      input.supertype ?? null,
      input.subtype ?? null,
      input.species ?? null,
      input.rarity ?? null,
      input.artist ?? null,
      now,
    )
    .run();
  await upsertSearch(db, { ...input, sourceId: id, checksum: '', sourceUpdatedAt: now }, id);
  return id;
}

export async function importCatalogueLanguage(
  db: D1Database,
  input: SyncInput,
): Promise<{ runId: string; imported: number; inactive: number }> {
  const sourceIds = new Set<string>();
  for (const card of input.cards) {
    if (!card.sourceId || sourceIds.has(card.sourceId))
      throw new Error('invalid_or_duplicate_source_id');
    sourceIds.add(card.sourceId);
  }
  const existing = await scalarCount(
    db,
    'SELECT COUNT(*) AS count FROM card_sources WHERE provider = ?1 AND language = ?2 AND active = 1',
    input.provider,
    input.language,
  );
  if (
    input.complete &&
    existing > 0 &&
    input.cards.length < Math.floor(existing * 0.8) &&
    !input.allowDestructiveDrop
  )
    throw new Error('sync_count_drop_rejected');
  const now = nowSeconds();
  const runId = newId('sync');
  await db
    .prepare(
      'INSERT INTO sync_runs (id, provider, language, started_at, source_count, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    )
    .bind(runId, input.provider, input.language, now, input.cards.length, 'running')
    .run();
  const seen = new Set<string>();
  for (const card of input.cards) {
    const existingSource = await db
      .prepare(
        'SELECT card_id FROM card_sources WHERE provider = ?1 AND source_id = ?2 AND language = ?3',
      )
      .bind(input.provider, card.sourceId, input.language)
      .first<{ card_id: string }>();
    const cardId = existingSource?.card_id ?? newId('card');
    await db
      .prepare(
        `INSERT INTO catalogue_cards
          (id, name, language, category, set_id, set_name, number, supertype, subtype, species, rarity, artist, release_date, pokedex_number, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, language = excluded.language,
          category = excluded.category, set_id = excluded.set_id, set_name = excluded.set_name,
          number = excluded.number, supertype = excluded.supertype, subtype = excluded.subtype,
          species = excluded.species, rarity = excluded.rarity, artist = excluded.artist, release_date = excluded.release_date, pokedex_number = excluded.pokedex_number,
          is_active = 1, updated_at = excluded.updated_at
         WHERE catalogue_cards.is_custom = 0`,
      )
      .bind(
        cardId,
        card.name,
        card.language,
        card.category,
        card.setId,
        card.setName,
        card.number,
        card.supertype ?? null,
        card.subtype ?? null,
        card.species ?? null,
        card.rarity ?? null,
        card.artist ?? null,
        card.releaseDate ?? null,
        card.pokedexNumber ?? null,
        now,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO card_sources (provider, source_id, card_id, language, source_updated_at, checksum, active, imported_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
         ON CONFLICT(provider, source_id, language) DO UPDATE SET source_updated_at = excluded.source_updated_at,
          checksum = excluded.checksum, active = 1, imported_at = excluded.imported_at`,
      )
      .bind(
        input.provider,
        card.sourceId,
        cardId,
        input.language,
        card.sourceUpdatedAt,
        card.checksum,
        now,
      )
      .run();
    await upsertSearch(db, card, cardId);
    seen.add(card.sourceId);
  }
  const toDeactivate: Array<{ source_id: string }> = [];
  if (input.complete) {
    const activeRows = await db
      .prepare(
        'SELECT source_id FROM card_sources WHERE provider = ?1 AND language = ?2 AND active = 1',
      )
      .bind(input.provider, input.language)
      .all<{ source_id: string }>();
    for (const row of activeRows.results) {
      if (seen.has(row.source_id)) continue;
      toDeactivate.push(row);
      await db
        .prepare(
          'UPDATE card_sources SET active = 0, imported_at = ?1 WHERE provider = ?2 AND source_id = ?3 AND language = ?4',
        )
        .bind(now, input.provider, row.source_id, input.language)
        .run();
    }
  }
  await db
    .prepare(
      'UPDATE sync_runs SET completed_at = ?1, imported_count = ?2, inactive_count = ?3, status = ?4 WHERE id = ?5',
    )
    .bind(now, input.cards.length, toDeactivate.length, 'complete', runId)
    .run();
  return { runId, imported: input.cards.length, inactive: toDeactivate.length };
}
