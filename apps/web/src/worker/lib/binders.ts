import {
  binderLayoutSchema,
  binderAssignmentCandidatesSchema,
  binderMutationResultSchema,
  binderPageSchema,
  binderVersionPagesSchema,
  binderVersionSummarySchema,
  cardIdSchema,
  NATIONAL_POKEDEX,
  type BinderCapacityError,
  type BinderAssignmentCandidate,
  type BinderEntry,
  type BinderLayout,
  type BinderMutationResult,
  type BinderPage,
  type BinderPokemonShortage,
  type BinderReadyToPlace,
  type BinderShortage,
  type BinderSlotLocation,
  type BinderVersionPages,
  type BinderVersionSummary,
  type BinderView,
} from '@pokedex/shared';
import { newId, nowSeconds } from './db';

const MAX_BINDER_PAGES = 300;
const MAX_BINDER_CARDS = 2000;
const MAX_PAGE_WINDOW = 4;
const MAX_SHORTAGE_PAGE = 100;
const CARD_QUERY_CHUNK = 80;
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export interface ReflowEntry {
  entry: BinderEntry;
  assignedCardId?: string | null;
  originalIndex?: number;
}

export function reflowBinderEntries(
  capacity: number,
  pageSize: number,
  entries: readonly ReflowEntry[],
  options: { anchorReservations?: boolean } = {},
): Array<ReflowEntry | null> {
  const placed: Array<ReflowEntry | null> = Array.from({ length: capacity }, () => null);
  if (options.anchorReservations)
    for (const item of entries) {
      if (item.entry.kind !== 'reserved') continue;
      const index = item.originalIndex;
      if (index === undefined || index < 0 || index >= capacity || placed[index] !== null)
        domainError('binder_slot_out_of_bounds');
      placed[index] = item;
    }
  let cursor = 0;
  for (const item of entries) {
    if (options.anchorReservations && item.entry.kind === 'reserved') continue;
    if ('startsNewPage' in item.entry && item.entry.startsNewPage && cursor % pageSize !== 0) {
      cursor += pageSize - (cursor % pageSize);
    }
    while (cursor < capacity && placed[cursor] !== null) cursor += 1;
    if (cursor >= capacity) {
      const requiredCapacity = cursor + 1;
      throw new BinderDomainError('binder_capacity_exceeded', {
        currentCapacity: capacity,
        requiredCapacity,
        additionalPockets: requiredCapacity - capacity,
        pageIncrement: pageSize,
      });
    }
    placed[cursor] = item;
    cursor += 1;
  }
  return placed;
}

interface BinderRow {
  id: string;
  name: string;
  active_version_id: string | null;
  updated_at: number;
  latest_version_id: string | null;
}

interface VersionRow {
  id: string;
  binder_id: string;
  version_number: number;
  status: 'draft' | 'active' | 'archived';
  layout_kind: BinderLayout['kind'];
  rows: number;
  columns: number;
  revision: number;
  page_count: number;
  capacity: number;
}

interface PageRow {
  id: string;
  position: number;
  kind?: 'slots' | 'reserved';
  label?: string | null;
}

interface SlotRow {
  binder_page_id: string;
  row_index: number;
  column_index: number;
  card_id: string | null;
  entry_kind?: 'empty' | 'reserved' | 'exact-card' | 'pokemon';
  label?: string | null;
  pokemon_number?: number | null;
  assigned_card_id?: string | null;
  starts_new_page?: number;
}

export interface OrderingRow {
  id: string;
  set_name: string;
  number: string;
  name: string;
  language: string;
  release_date: string | null;
  pokedex_number: number | null;
}

export type ArrangementMode = 'set-number' | 'release-date' | 'pokedex-number' | 'language';

export type BinderErrorCode =
  | 'binder_version_not_found'
  | 'binder_version_not_draft'
  | 'binder_version_archived'
  | 'binder_revision_conflict'
  | 'binder_page_not_found'
  | 'binder_last_page'
  | 'binder_page_order_invalid'
  | 'binder_page_limit_reached'
  | 'binder_page_window_invalid'
  | 'binder_slot_not_found'
  | 'binder_slot_out_of_bounds'
  | 'binder_arrangement_card_missing'
  | 'binder_capacity_exceeded'
  | 'binder_capacity_invalid'
  | 'binder_shrink_occupied'
  | 'binder_assignment_incompatible'
  | 'binder_assignment_quantity_exceeded'
  | 'binder_reserved_page_not_empty'
  | 'card_not_found';

export class BinderDomainError extends Error {
  constructor(
    public readonly code: BinderErrorCode,
    public readonly details?: BinderCapacityError | { locations: BinderSlotLocation[] },
  ) {
    super(code);
    this.name = 'BinderDomainError';
  }
}

function domainError(code: BinderErrorCode): never {
  throw new BinderDomainError(code);
}

function toLayout(row: VersionRow): BinderLayout {
  return binderLayoutSchema.parse({
    kind: row.layout_kind,
    rows: row.rows,
    columns: row.columns,
  });
}

function toBinder(row: BinderRow): BinderView {
  return {
    id: row.id,
    name: row.name,
    activeVersionId: row.active_version_id,
    updatedAt: new Date(row.updated_at * 1000).toISOString(),
    latestVersionId: row.latest_version_id,
  };
}

function toSummary(row: VersionRow): BinderVersionSummary {
  return binderVersionSummarySchema.parse({
    id: row.id,
    binderId: row.binder_id,
    versionNumber: row.version_number,
    status: row.status,
    layout: toLayout(row),
    revision: row.revision,
    pageCount: row.page_count,
    capacity: row.capacity,
  });
}

async function readVersion(
  db: D1Database,
  ownerId: string,
  versionId: string,
): Promise<VersionRow> {
  const row = await db
    .prepare(
      `SELECT v.id, v.binder_id, v.version_number, v.status, v.layout_kind,
        v.rows, v.columns, v.revision, v.capacity, COUNT(p.id) AS page_count
       FROM binder_versions v
       JOIN binders b ON b.id = v.binder_id
       LEFT JOIN binder_pages p ON p.binder_version_id = v.id
       WHERE v.id = ?1 AND b.owner_id = ?2
       GROUP BY v.id, v.binder_id, v.version_number, v.status, v.layout_kind,
        v.rows, v.columns, v.revision, v.capacity`,
    )
    .bind(versionId, ownerId)
    .first<VersionRow>();
  if (!row) domainError('binder_version_not_found');
  return row;
}

function expectedRevision(row: VersionRow, expected?: number): number {
  if (expected !== undefined && expected !== row.revision) domainError('binder_revision_conflict');
  return row.revision;
}

function requireEditable(row: VersionRow): void {
  if (row.status === 'archived') domainError('binder_version_archived');
}

function requirePageWindow(page: number, limit: number): void {
  if (
    !Number.isInteger(page) ||
    page < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE_WINDOW
  )
    domainError('binder_page_window_invalid');
}

function versionAssertion(
  db: D1Database,
  ownerId: string,
  versionId: string,
  revision: number,
  draftOnly: boolean,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
        SELECT 1 FROM binder_versions v JOIN binders b ON b.id = v.binder_id
        WHERE v.id = ?1 AND b.owner_id = ?2 AND v.revision = ?3
          AND (?4 = 0 OR v.status = 'draft')
       ) THEN 1 ELSE json_extract('binder_revision_conflict', '$') END AS valid`,
    )
    .bind(versionId, ownerId, revision, draftOnly ? 1 : 0);
}

async function runVersionBatch(
  db: D1Database,
  ownerId: string,
  versionId: string,
  revision: number,
  draftOnly: boolean,
  statements: D1PreparedStatement[],
): Promise<void> {
  try {
    await db.batch([versionAssertion(db, ownerId, versionId, revision, draftOnly), ...statements]);
  } catch (error) {
    const current = await readVersion(db, ownerId, versionId);
    if (draftOnly && current.status !== 'draft')
      throw new BinderDomainError('binder_version_not_draft');
    if (current.revision !== revision) throw new BinderDomainError('binder_revision_conflict');
    const message = error instanceof Error ? error.message : String(error);
    for (const code of [
      'binder_shrink_occupied',
      'binder_page_limit_reached',
      'binder_assignment_quantity_exceeded',
      'binder_assignment_incompatible',
      'binder_reserved_page_not_empty',
      'binder_slot_not_found',
    ] as const)
      if (message.includes(code)) throw new BinderDomainError(code);
    throw error;
  }
}

function createSlotsStatement(
  db: D1Database,
  pageId: string,
  layout: BinderLayout,
): D1PreparedStatement {
  return db
    .prepare(
      `WITH RECURSIVE
        rows(value) AS (
          SELECT 0 UNION ALL SELECT value + 1 FROM rows WHERE value + 1 < ?2
        ),
        columns(value) AS (
          SELECT 0 UNION ALL SELECT value + 1 FROM columns WHERE value + 1 < ?3
        )
       INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id)
       SELECT ?1, rows.value, columns.value, NULL FROM rows CROSS JOIN columns`,
    )
    .bind(pageId, layout.rows, layout.columns);
}

async function readPages(
  db: D1Database,
  versionId: string,
  page: number,
  limit: number,
): Promise<BinderPage[]> {
  const pageRows = await db
    .prepare(
      'SELECT id, position, kind, label FROM binder_pages WHERE binder_version_id = ?1 ORDER BY position LIMIT ?2 OFFSET ?3',
    )
    .bind(versionId, limit, page)
    .all<PageRow>();
  if (pageRows.results.length === 0) return [];
  const placeholders = pageRows.results.map((_item, index) => `?${index + 1}`).join(',');
  const slotRows = await db
    .prepare(
      `SELECT binder_page_id, row_index, column_index, card_id, entry_kind, label,
        pokemon_number, assigned_card_id, starts_new_page
       FROM binder_slots WHERE binder_page_id IN (${placeholders})
       ORDER BY binder_page_id, row_index, column_index`,
    )
    .bind(...pageRows.results.map((item) => item.id))
    .all<SlotRow>();
  const slotsByPage = new Map<string, SlotRow[]>();
  for (const slot of slotRows.results) {
    const slots = slotsByPage.get(slot.binder_page_id) ?? [];
    slots.push(slot);
    slotsByPage.set(slot.binder_page_id, slots);
  }
  return pageRows.results.map((item) =>
    binderPageSchema.parse({
      id: item.id,
      position: item.position,
      kind: item.kind ?? 'slots',
      label: item.label ?? null,
      slots: (slotsByPage.get(item.id) ?? []).map((slot) => ({
        pageId: slot.binder_page_id,
        row: slot.row_index,
        column: slot.column_index,
        cardId: slot.card_id,
        entryKind: slot.entry_kind ?? (slot.card_id === null ? 'empty' : 'exact-card'),
        label: slot.label ?? null,
        pokemonNumber: slot.pokemon_number ?? null,
        assignedCardId: slot.assigned_card_id ?? null,
        startsNewPage: slot.starts_new_page === 1,
      })),
    }),
  );
}

async function mutationResult(
  db: D1Database,
  ownerId: string,
  versionId: string,
  pagePositions: number[],
): Promise<BinderMutationResult> {
  const row = await readVersion(db, ownerId, versionId);
  const unique = [...new Set(pagePositions)]
    .filter((position) => position >= 0 && position < row.page_count)
    .slice(0, 2);
  const pages: BinderPage[] = [];
  for (const position of unique) pages.push(...(await readPages(db, versionId, position, 1)));
  return binderMutationResultSchema.parse({ version: toSummary(row), pages });
}

async function listPageRows(db: D1Database, versionId: string): Promise<PageRow[]> {
  const result = await db
    .prepare(
      'SELECT id, position, kind, label FROM binder_pages WHERE binder_version_id = ?1 ORDER BY position, id LIMIT ?2',
    )
    .bind(versionId, MAX_BINDER_PAGES + 1)
    .all<PageRow>();
  if (result.results.length > MAX_BINDER_PAGES) domainError('binder_page_limit_reached');
  return result.results;
}

function revisionStatements(
  db: D1Database,
  version: VersionRow,
  now: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare('UPDATE binder_versions SET revision = revision + 1 WHERE id = ?1 AND revision = ?2')
      .bind(version.id, version.revision),
    db.prepare('UPDATE binders SET updated_at = ?1 WHERE id = ?2').bind(now, version.binder_id),
  ];
}

export async function createBinder(
  db: D1Database,
  ownerId: string,
  name: string,
  inputLayout: BinderLayout,
  requestedCapacity?: number,
): Promise<BinderMutationResult> {
  const layout = binderLayoutSchema.parse(inputLayout);
  const pageSize = layout.rows * layout.columns;
  const capacity = requestedCapacity ?? pageSize;
  if (!Number.isInteger(capacity) || capacity < pageSize || capacity % pageSize !== 0)
    domainError('binder_capacity_invalid');
  const pageCount = capacity / pageSize;
  if (pageCount > MAX_BINDER_PAGES) domainError('binder_page_limit_reached');
  const now = nowSeconds();
  const binderId = newId('binder');
  const versionId = newId('binder_version');
  const pages = Array.from({ length: pageCount }, (_unused, position) => ({
    id: newId('page'),
    position,
  }));
  await db.batch([
    db
      .prepare(
        `INSERT INTO binders (id, owner_id, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)`,
      )
      .bind(binderId, ownerId, name, now),
    db
      .prepare(
        `INSERT INTO binder_versions
          (id, binder_id, version_number, status, layout_kind, rows, columns, revision, capacity, created_at)
         VALUES (?1, ?2, 1, 'active', ?3, ?4, ?5, 1, ?6, ?7)`,
      )
      .bind(versionId, binderId, layout.kind, layout.rows, layout.columns, capacity, now),
    db.prepare('UPDATE binders SET active_version_id = ?1 WHERE id = ?2').bind(versionId, binderId),
    db
      .prepare(
        `INSERT INTO binder_pages (id, binder_version_id, position)
         SELECT json_extract(value, '$.id'), ?1, CAST(json_extract(value, '$.position') AS INTEGER)
         FROM json_each(?2)`,
      )
      .bind(versionId, JSON.stringify(pages)),
    db
      .prepare(
        `WITH RECURSIVE rows(value) AS (
           SELECT 0 UNION ALL SELECT value + 1 FROM rows WHERE value + 1 < ?2
         ), columns(value) AS (
           SELECT 0 UNION ALL SELECT value + 1 FROM columns WHERE value + 1 < ?3
         )
         INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id)
         SELECT json_extract(page.value, '$.id'), rows.value, columns.value, NULL
         FROM json_each(?1) page CROSS JOIN rows CROSS JOIN columns`,
      )
      .bind(JSON.stringify(pages), layout.rows, layout.columns),
  ]);
  return mutationResult(db, ownerId, versionId, [0]);
}

export async function listBinders(db: D1Database, ownerId: string): Promise<BinderView[]> {
  const result = await db
    .prepare(
      `SELECT b.id, b.name, b.active_version_id, b.updated_at,
        (SELECT v.id FROM binder_versions v WHERE v.binder_id = b.id
         ORDER BY v.version_number DESC LIMIT 1) AS latest_version_id
       FROM binders b WHERE b.owner_id = ?1 ORDER BY b.updated_at DESC`,
    )
    .bind(ownerId)
    .all<BinderRow>();
  return result.results.map(toBinder);
}

export async function activeBinderShortages(
  db: D1Database,
  ownerId: string,
): Promise<BinderShortage[]> {
  const result = await db
    .prepare(
      `WITH assignments AS (
         SELECT slot.assigned_card_id AS card_id, COUNT(*) AS assigned
         FROM binder_slots slot JOIN binder_pages page ON page.id = slot.binder_page_id
         JOIN binder_versions version ON version.id = page.binder_version_id
         JOIN binders binder ON binder.id = version.binder_id
         WHERE binder.owner_id = ?1 AND version.status = 'active'
           AND slot.assigned_card_id IS NOT NULL GROUP BY slot.assigned_card_id
       ), targets AS (
         SELECT slot.card_id, COUNT(*) AS required
         FROM binder_slots slot JOIN binder_pages page ON page.id = slot.binder_page_id
         JOIN binder_versions version ON version.id = page.binder_version_id
         JOIN binders binder ON binder.id = version.binder_id
         WHERE binder.owner_id = ?1 AND version.status = 'active'
           AND slot.entry_kind = 'exact-card' AND slot.assigned_card_id IS NULL
         GROUP BY slot.card_id
       )
       SELECT targets.card_id, targets.required, COALESCE(collection.quantity, 0) AS owned,
         COALESCE(assignments.assigned, 0) AS assigned,
         MAX(COALESCE(collection.quantity, 0) - COALESCE(assignments.assigned, 0), 0) AS available
       FROM targets LEFT JOIN collection_cards collection
         ON collection.owner_id = ?1 AND collection.card_id = targets.card_id
       LEFT JOIN assignments ON assignments.card_id = targets.card_id
       WHERE targets.required > MAX(COALESCE(collection.quantity, 0) - COALESCE(assignments.assigned, 0), 0)
       ORDER BY (targets.required - MAX(COALESCE(collection.quantity, 0) - COALESCE(assignments.assigned, 0), 0)) DESC,
         targets.card_id LIMIT ?2`,
    )
    .bind(ownerId, MAX_SHORTAGE_PAGE)
    .all<{
      card_id: string;
      required: number;
      owned: number;
      assigned: number;
      available: number;
    }>();
  return result.results.map((row) => ({
    cardId: cardIdSchema.parse(row.card_id),
    required: row.required,
    owned: row.owned,
    assigned: row.assigned,
    available: row.available,
    missing: row.required - row.available,
  }));
}

export async function getBinderVersion(
  db: D1Database,
  ownerId: string,
  versionId: string,
  page = 0,
  limit = 1,
): Promise<BinderVersionPages> {
  requirePageWindow(page, limit);
  const row = await readVersion(db, ownerId, versionId);
  const pages = await readPages(db, versionId, page, limit);
  return binderVersionPagesSchema.parse({
    version: toSummary(row),
    pages,
    nextPage: page + pages.length < row.page_count ? page + pages.length : null,
  });
}

export async function getBinderVersionShortages(
  db: D1Database,
  ownerId: string,
  versionId: string,
  offset = 0,
  limit = MAX_SHORTAGE_PAGE,
): Promise<{
  shortages: BinderShortage[];
  pokemonShortages: BinderPokemonShortage[];
  readyToPlace: BinderReadyToPlace;
  nextOffset: number | null;
}> {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1)
    domainError('binder_page_window_invalid');
  const version = await readVersion(db, ownerId, versionId);
  const bounded = Math.min(limit, MAX_SHORTAGE_PAGE);
  const exact = await db
    .prepare(
      `WITH assignments AS (
         SELECT slot.assigned_card_id AS card_id, COUNT(*) AS assigned
         FROM binder_slots slot JOIN binder_pages page ON page.id = slot.binder_page_id
         JOIN binder_versions scope_version ON scope_version.id = page.binder_version_id
         JOIN binders scope_binder ON scope_binder.id = scope_version.binder_id
         WHERE scope_binder.owner_id = ?2 AND slot.assigned_card_id IS NOT NULL
           AND (scope_version.id = ?1 OR (scope_version.status = 'active'
             AND (?3 = 'active' OR scope_version.binder_id <> ?4)))
         GROUP BY slot.assigned_card_id
       ), targets AS (
         SELECT slot.card_id, COUNT(*) AS required
         FROM binder_slots slot JOIN binder_pages page ON page.id = slot.binder_page_id
         WHERE page.binder_version_id = ?1 AND slot.entry_kind = 'exact-card'
           AND slot.assigned_card_id IS NULL GROUP BY slot.card_id
       )
       SELECT targets.card_id, targets.required, COALESCE(collection.quantity, 0) AS owned,
         COALESCE(assignments.assigned, 0) AS assigned,
         MAX(COALESCE(collection.quantity, 0) - COALESCE(assignments.assigned, 0), 0) AS available
       FROM targets LEFT JOIN collection_cards collection
         ON collection.owner_id = ?2 AND collection.card_id = targets.card_id
       LEFT JOIN assignments ON assignments.card_id = targets.card_id`,
    )
    .bind(versionId, ownerId, version.status, version.binder_id)
    .all<{
      card_id: string;
      required: number;
      owned: number;
      assigned: number;
      available: number;
    }>();
  const pokemon = await db
    .prepare(
      `WITH assignments AS (
         SELECT card.pokedex_number, COUNT(*) AS assigned
         FROM binder_slots slot JOIN binder_pages page ON page.id = slot.binder_page_id
         JOIN binder_versions scope_version ON scope_version.id = page.binder_version_id
         JOIN binders scope_binder ON scope_binder.id = scope_version.binder_id
         JOIN catalogue_cards card ON card.id = slot.assigned_card_id
         WHERE scope_binder.owner_id = ?2 AND slot.assigned_card_id IS NOT NULL
           AND (scope_version.id = ?1 OR (scope_version.status = 'active'
             AND (?3 = 'active' OR scope_version.binder_id <> ?4)))
         GROUP BY card.pokedex_number
       ), targets AS (
         SELECT slot.pokemon_number, COUNT(*) AS required
         FROM binder_slots slot JOIN binder_pages page ON page.id = slot.binder_page_id
         WHERE page.binder_version_id = ?1 AND slot.entry_kind = 'pokemon'
           AND slot.assigned_card_id IS NULL GROUP BY slot.pokemon_number
       ), owned AS (
         SELECT card.pokedex_number, SUM(collection.quantity) AS owned
         FROM catalogue_cards card JOIN collection_cards collection ON collection.card_id = card.id
         WHERE collection.owner_id = ?2 AND card.category = 'pokemon'
         GROUP BY card.pokedex_number
       )
       SELECT targets.pokemon_number, targets.required, COALESCE(owned.owned, 0) AS owned,
         COALESCE(assignments.assigned, 0) AS assigned,
         MAX(COALESCE(owned.owned, 0) - COALESCE(assignments.assigned, 0), 0) AS available
       FROM targets LEFT JOIN owned ON owned.pokedex_number = targets.pokemon_number
       LEFT JOIN assignments ON assignments.pokedex_number = targets.pokemon_number`,
    )
    .bind(versionId, ownerId, version.status, version.binder_id)
    .all<{
      pokemon_number: number;
      required: number;
      owned: number;
      assigned: number;
      available: number;
    }>();
  const exactShortages = exact.results
    .filter((row) => row.required > row.available)
    .sort((left, right) => right.required - right.available - (left.required - left.available));
  const pokemonShortages: BinderPokemonShortage[] = pokemon.results
    .filter((row) => row.required > row.available)
    .sort((left, right) => right.required - right.available - (left.required - left.available))
    .slice(offset, offset + bounded)
    .map((row) => ({
      pokemonNumber: row.pokemon_number,
      required: row.required,
      owned: row.owned,
      assigned: row.assigned,
      available: row.available,
      missing: row.required - row.available,
    }));
  const readyToPlace: BinderReadyToPlace = {
    exactTargets: exact.results.reduce(
      (sum, row) => sum + Math.min(row.required, row.available),
      0,
    ),
    pokemonTargets: pokemon.results.reduce(
      (sum, row) => sum + Math.min(row.required, row.available),
      0,
    ),
  };
  const rows = exactShortages.slice(offset, offset + bounded);
  return {
    shortages: rows.map((row) => ({
      cardId: cardIdSchema.parse(row.card_id),
      required: row.required,
      owned: row.owned,
      assigned: row.assigned,
      available: row.available,
      missing: row.required - row.available,
    })),
    pokemonShortages,
    readyToPlace,
    nextOffset:
      exactShortages.length > offset + bounded || pokemon.results.length > offset + bounded
        ? offset + bounded
        : null,
  };
}

export async function getBinderAssignmentCandidates(
  db: D1Database,
  ownerId: string,
  versionId: string,
  location: BinderSlotLocation,
): Promise<{ candidates: BinderAssignmentCandidate[] }> {
  const version = await readVersion(db, ownerId, versionId);
  validateLocation(version, location);
  const slots = await materializedSlots(db, versionId);
  const target = slots.find(
    (slot) =>
      slot.page_position === location.page &&
      slot.row_index === location.row &&
      slot.column_index === location.column,
  );
  if (!target) domainError('binder_slot_not_found');
  if (target.page_kind === 'reserved') domainError('binder_reserved_page_not_empty');
  if (target.entry_kind !== 'exact-card' && target.entry_kind !== 'pokemon')
    domainError('binder_slot_not_found');
  const result = await db
    .prepare(
      `WITH assignments AS (
         SELECT slot.assigned_card_id AS card_id, COUNT(*) AS assigned
         FROM binder_slots slot JOIN binder_pages page ON page.id = slot.binder_page_id
         JOIN binder_versions scope_version ON scope_version.id = page.binder_version_id
         JOIN binders scope_binder ON scope_binder.id = scope_version.binder_id
         WHERE scope_binder.owner_id = ?2 AND slot.assigned_card_id IS NOT NULL
           AND (scope_version.id = ?1 OR (scope_version.status = 'active'
             AND (?3 = 'active' OR scope_version.binder_id <> ?4)))
         GROUP BY slot.assigned_card_id
       )
       SELECT card.id, card.name, card.set_name, card.number, card.language,
         collection.quantity AS owned, COALESCE(assignments.assigned, 0) AS assigned,
         MAX(collection.quantity - COALESCE(assignments.assigned, 0), 0) AS available
       FROM catalogue_cards card JOIN collection_cards collection
         ON collection.owner_id = ?2 AND collection.card_id = card.id AND collection.quantity > 0
       LEFT JOIN assignments ON assignments.card_id = card.id
       WHERE (?5 = 'exact-card' AND card.id = ?6)
          OR (?5 = 'pokemon' AND card.category = 'pokemon' AND card.pokedex_number = ?7)
       ORDER BY available DESC, card.set_name, card.number, card.name, card.id LIMIT 500`,
    )
    .bind(
      versionId,
      ownerId,
      version.status,
      version.binder_id,
      target.entry_kind,
      target.card_id,
      target.pokemon_number,
    )
    .all<{
      id: string;
      name: string;
      set_name: string;
      number: string;
      language: BinderAssignmentCandidate['language'];
      owned: number;
      assigned: number;
      available: number;
    }>();
  return binderAssignmentCandidatesSchema.parse({
    candidates: result.results.map((row) => ({
      cardId: row.id,
      name: row.name,
      setName: row.set_name,
      number: row.number,
      language: row.language,
      owned: row.owned,
      assigned: row.assigned,
      available: row.available,
    })),
  });
}

async function addBinderPageOnce(
  db: D1Database,
  ownerId: string,
  versionId: string,
  requestedRevision?: number,
): Promise<BinderMutationResult> {
  const version = await readVersion(db, ownerId, versionId);
  requireEditable(version);
  expectedRevision(version, requestedRevision);
  if (version.page_count >= MAX_BINDER_PAGES) domainError('binder_page_limit_reached');
  const pageId = newId('page');
  const now = nowSeconds();
  await runVersionBatch(db, ownerId, versionId, version.revision, false, [
    db
      .prepare(
        `INSERT INTO binder_pages (id, binder_version_id, position)
         SELECT ?1, ?2, COALESCE(MAX(position) + 1, 0)
         FROM binder_pages WHERE binder_version_id = ?2`,
      )
      .bind(pageId, versionId),
    createSlotsStatement(db, pageId, toLayout(version)),
    db
      .prepare('UPDATE binder_versions SET capacity = capacity + (?1 * ?2) WHERE id = ?3')
      .bind(version.rows, version.columns, versionId),
    ...revisionStatements(db, version, now),
  ]);
  return mutationResult(db, ownerId, versionId, [version.page_count]);
}

export async function addBinderPage(
  db: D1Database,
  ownerId: string,
  versionId: string,
  requestedRevision?: number,
): Promise<BinderMutationResult> {
  if (requestedRevision !== undefined)
    return addBinderPageOnce(db, ownerId, versionId, requestedRevision);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await addBinderPageOnce(db, ownerId, versionId);
    } catch (error) {
      if (!(error instanceof BinderDomainError) || error.code !== 'binder_revision_conflict')
        throw error;
    }
  }
  throw new BinderDomainError('binder_revision_conflict');
}

export async function deleteBinderPage(
  db: D1Database,
  ownerId: string,
  versionId: string,
  pageId: string,
  requestedRevision?: number,
): Promise<BinderMutationResult> {
  const version = await readVersion(db, ownerId, versionId);
  requireEditable(version);
  expectedRevision(version, requestedRevision);
  const pages = await listPageRows(db, versionId);
  const page = pages.find((item) => item.id === pageId);
  if (!page) domainError('binder_page_not_found');
  if (pages.length <= 1) domainError('binder_last_page');
  const remaining = pages.filter((item) => item.id !== pageId);
  const offset = pages.length + 1;
  const now = nowSeconds();
  await runVersionBatch(db, ownerId, versionId, version.revision, false, [
    db
      .prepare(
        `SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM binder_pages target LEFT JOIN binder_slots slot ON slot.binder_page_id = target.id
          WHERE target.id = ?1 AND (target.kind = 'reserved' OR slot.entry_kind <> 'empty'
            OR slot.assigned_card_id IS NOT NULL OR slot.starts_new_page = 1)
         ) THEN 1 ELSE json_extract('binder_shrink_occupied', '$') END AS valid`,
      )
      .bind(pageId),
    db.prepare('DELETE FROM binder_pages WHERE id = ?1').bind(pageId),
    db
      .prepare('UPDATE binder_pages SET position = position + ?1 WHERE binder_version_id = ?2')
      .bind(offset, versionId),
    ...remaining.map((item, position) =>
      db.prepare('UPDATE binder_pages SET position = ?1 WHERE id = ?2').bind(position, item.id),
    ),
    db
      .prepare('UPDATE binder_versions SET capacity = capacity - (?1 * ?2) WHERE id = ?3')
      .bind(version.rows, version.columns, versionId),
    ...revisionStatements(db, version, now),
  ]);
  return mutationResult(db, ownerId, versionId, [Math.min(page.position, remaining.length - 1)]);
}

export async function reorderBinderPages(
  db: D1Database,
  ownerId: string,
  versionId: string,
  pageIds: string[],
  requestedRevision?: number,
): Promise<BinderMutationResult> {
  const version = await readVersion(db, ownerId, versionId);
  requireEditable(version);
  expectedRevision(version, requestedRevision);
  const pages = await listPageRows(db, versionId);
  if (
    pages.length !== pageIds.length ||
    new Set(pageIds).size !== pageIds.length ||
    pages.some((page) => !pageIds.includes(page.id))
  )
    domainError('binder_page_order_invalid');
  const offset = pages.length + 1;
  const now = nowSeconds();
  await runVersionBatch(db, ownerId, versionId, version.revision, false, [
    db
      .prepare('UPDATE binder_pages SET position = position + ?1 WHERE binder_version_id = ?2')
      .bind(offset, versionId),
    ...pageIds.map((pageId, position) =>
      db.prepare('UPDATE binder_pages SET position = ?1 WHERE id = ?2').bind(position, pageId),
    ),
    ...revisionStatements(db, version, now),
  ]);
  return mutationResult(db, ownerId, versionId, [0]);
}

async function orderingRows(db: D1Database, cardIds: string[]): Promise<Map<string, OrderingRow>> {
  const rows = new Map<string, OrderingRow>();
  for (let offset = 0; offset < cardIds.length; offset += CARD_QUERY_CHUNK) {
    const chunk = cardIds.slice(offset, offset + CARD_QUERY_CHUNK);
    const placeholders = chunk.map((_id, index) => `?${index + 1}`).join(',');
    const result = await db
      .prepare(
        `SELECT id, set_name, number, name, language, release_date, pokedex_number
         FROM catalogue_cards WHERE id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<OrderingRow>();
    for (const row of result.results) rows.set(row.id, row);
  }
  return rows;
}

export function compareBinderCards(
  left: OrderingRow,
  right: OrderingRow,
  mode: ArrangementMode,
): number {
  const fallback = (): number =>
    natural.compare(left.set_name, right.set_name) ||
    natural.compare(left.number, right.number) ||
    natural.compare(left.name, right.name) ||
    natural.compare(left.id, right.id);
  if (mode === 'release-date')
    return (
      Number(left.release_date === null) - Number(right.release_date === null) ||
      natural.compare(left.release_date ?? '', right.release_date ?? '') ||
      fallback()
    );
  if (mode === 'pokedex-number')
    return (
      Number(left.pokedex_number === null) - Number(right.pokedex_number === null) ||
      (left.pokedex_number ?? 0) - (right.pokedex_number ?? 0) ||
      natural.compare(left.name, right.name) ||
      natural.compare(left.id, right.id)
    );
  if (mode === 'language') return natural.compare(left.language, right.language) || fallback();
  return fallback();
}

export async function arrangeBinderVersion(
  db: D1Database,
  ownerId: string,
  versionId: string,
  mode: ArrangementMode,
  requestedRevision?: number,
): Promise<BinderMutationResult> {
  const version = await readVersion(db, ownerId, versionId);
  requireEditable(version);
  expectedRevision(version, requestedRevision);
  if (version.page_count > MAX_BINDER_PAGES) domainError('binder_page_limit_reached');
  const slots = await materializedSlots(db, versionId);
  const available = slots.filter((slot) => slot.page_kind !== 'reserved');
  const entries = available
    .map((slot, originalIndex): ReflowEntry | null => {
      const entry = slotEntry(slot);
      return entry ? { entry, assignedCardId: slot.assigned_card_id ?? null, originalIndex } : null;
    })
    .filter((entry) => entry !== null);
  const targets = entries.filter(
    (item) => item.entry.kind === 'exact-card' || item.entry.kind === 'pokemon',
  );
  if (targets.length === 0) return mutationResult(db, ownerId, versionId, [0]);
  const uniqueIds = [
    ...new Set(
      targets.flatMap((item) => (item.entry.kind === 'exact-card' ? [item.entry.cardId] : [])),
    ),
  ];
  const cards = await orderingRows(db, uniqueIds);
  if (cards.size !== uniqueIds.length) domainError('binder_arrangement_card_missing');
  const ordering = (item: ReflowEntry): OrderingRow => {
    if (item.entry.kind === 'exact-card') {
      const card = cards.get(item.entry.cardId);
      if (!card) domainError('binder_arrangement_card_missing');
      return card;
    }
    if (item.entry.kind !== 'pokemon') domainError('binder_arrangement_card_missing');
    const pokemon = NATIONAL_POKEDEX[item.entry.pokemonNumber - 1];
    if (!pokemon) domainError('binder_arrangement_card_missing');
    return {
      id: `pokemon-${String(pokemon.number).padStart(4, '0')}`,
      set_name: '',
      number: String(pokemon.number),
      name: pokemon.name,
      language: '',
      release_date: null,
      pokedex_number: pokemon.number,
    };
  };
  const arranged = [...targets].sort((left, right) =>
    compareBinderCards(ordering(left), ordering(right), mode),
  );
  const reservations = entries.filter((item) => item.entry.kind === 'reserved');
  const flowed = reflowBinderEntries(
    available.length,
    version.rows * version.columns,
    [...reservations, ...arranged],
    { anchorReservations: true },
  );
  await runVersionBatch(db, ownerId, versionId, version.revision, false, [
    rewriteSlotsStatement(db, slots, flowed),
    ...revisionStatements(db, version, nowSeconds()),
  ]);
  return mutationResult(db, ownerId, versionId, [0]);
}

function validateLocation(version: VersionRow, location: BinderSlotLocation): void {
  if (
    location.row < 0 ||
    location.column < 0 ||
    location.row >= version.rows ||
    location.column >= version.columns
  )
    domainError('binder_slot_out_of_bounds');
}

async function pageAt(db: D1Database, versionId: string, position: number): Promise<PageRow> {
  const page = await db
    .prepare('SELECT id, position FROM binder_pages WHERE binder_version_id = ?1 AND position = ?2')
    .bind(versionId, position)
    .first<PageRow>();
  if (!page) domainError('binder_page_not_found');
  return page;
}

async function requireCard(db: D1Database, cardId: string | null): Promise<void> {
  if (cardId === null) return;
  const card = await db
    .prepare('SELECT id FROM catalogue_cards WHERE id = ?1')
    .bind(cardId)
    .first();
  if (!card) domainError('card_not_found');
}

export async function setBinderSlot(
  db: D1Database,
  ownerId: string,
  versionId: string,
  pagePosition: number,
  row: number,
  column: number,
  cardId: string | null,
  requestedRevision?: number,
): Promise<BinderMutationResult> {
  const version = await readVersion(db, ownerId, versionId);
  requireEditable(version);
  expectedRevision(version, requestedRevision);
  validateLocation(version, { page: pagePosition, row, column });
  const page = await pageAt(db, versionId, pagePosition);
  await requireCard(db, cardId);
  const now = nowSeconds();
  await runVersionBatch(db, ownerId, versionId, version.revision, false, [
    db
      .prepare(
        `UPDATE binder_slots SET card_id = ?1,
          entry_kind = CASE WHEN ?1 IS NULL THEN 'empty' ELSE 'exact-card' END,
          label = NULL, pokemon_number = NULL, assigned_card_id = NULL, starts_new_page = 0
         WHERE binder_page_id = ?2 AND row_index = ?3 AND column_index = ?4`,
      )
      .bind(cardId, page.id, row, column),
    ...revisionStatements(db, version, now),
  ]);
  return mutationResult(db, ownerId, versionId, [pagePosition]);
}

export async function setBinderSlots(
  db: D1Database,
  ownerId: string,
  versionId: string,
  assignments: Array<BinderSlotLocation & { cardId: string }>,
  requestedRevision?: number,
): Promise<BinderMutationResult> {
  if (assignments.length === 0 || assignments.length > MAX_BINDER_CARDS)
    domainError('binder_slot_out_of_bounds');
  const version = await readVersion(db, ownerId, versionId);
  requireEditable(version);
  expectedRevision(version, requestedRevision);
  const pages = await listPageRows(db, versionId);
  const pageByPosition = new Map(pages.map((page) => [page.position, page.id]));
  const keys = new Set<string>();
  for (const assignment of assignments) {
    validateLocation(version, assignment);
    if (!pageByPosition.has(assignment.page)) domainError('binder_page_not_found');
    const key = `${assignment.page}\u0000${assignment.row}\u0000${assignment.column}`;
    if (keys.has(key)) domainError('binder_slot_out_of_bounds');
    keys.add(key);
  }
  const cards = await orderingRows(db, [...new Set(assignments.map((item) => item.cardId))]);
  if (cards.size !== new Set(assignments.map((item) => item.cardId)).size)
    domainError('binder_arrangement_card_missing');
  const encoded = JSON.stringify(
    assignments.map((assignment) => ({
      pageId: pageByPosition.get(assignment.page),
      row: assignment.row,
      column: assignment.column,
      cardId: assignment.cardId,
    })),
  );
  await runVersionBatch(db, ownerId, versionId, version.revision, false, [
    db
      .prepare(
        `WITH assignments AS (
          SELECT json_extract(value, '$.pageId') AS page_id,
            CAST(json_extract(value, '$.row') AS INTEGER) AS row_index,
            CAST(json_extract(value, '$.column') AS INTEGER) AS column_index,
            json_extract(value, '$.cardId') AS card_id
          FROM json_each(?1)
         )
         UPDATE binder_slots
         SET card_id = (
           SELECT card_id FROM assignments
           WHERE page_id = binder_slots.binder_page_id
             AND row_index = binder_slots.row_index
             AND column_index = binder_slots.column_index
         ), entry_kind = 'exact-card', label = NULL, pokemon_number = NULL,
           assigned_card_id = NULL, starts_new_page = 0
         WHERE EXISTS (
           SELECT 1 FROM assignments
           WHERE page_id = binder_slots.binder_page_id
             AND row_index = binder_slots.row_index
             AND column_index = binder_slots.column_index
         )`,
      )
      .bind(encoded),
    ...revisionStatements(db, version, nowSeconds()),
  ]);
  return mutationResult(db, ownerId, versionId, [assignments[0]?.page ?? 0]);
}

export async function swapBinderSlots(
  db: D1Database,
  ownerId: string,
  versionId: string,
  source: BinderSlotLocation,
  target: BinderSlotLocation,
  requestedRevision?: number,
): Promise<BinderMutationResult> {
  const version = await readVersion(db, ownerId, versionId);
  requireEditable(version);
  expectedRevision(version, requestedRevision);
  validateLocation(version, source);
  validateLocation(version, target);
  if (source.page === target.page && source.row === target.row && source.column === target.column)
    return mutationResult(db, ownerId, versionId, [source.page]);
  const slots = await materializedSlots(db, versionId);
  const sourceSlot = slots.find(
    (slot) =>
      slot.page_position === source.page &&
      slot.row_index === source.row &&
      slot.column_index === source.column,
  );
  const targetSlot = slots.find(
    (slot) =>
      slot.page_position === target.page &&
      slot.row_index === target.row &&
      slot.column_index === target.column,
  );
  if (!sourceSlot || !targetSlot) domainError('binder_slot_not_found');
  if (sourceSlot.page_kind === 'reserved' || targetSlot.page_kind === 'reserved')
    domainError('binder_reserved_page_not_empty');
  const available = slots.filter((slot) => slot.page_kind !== 'reserved');
  const payload = (slot: MaterializedSlot, originalIndex: number): ReflowEntry | null => {
    const entry = slotEntry(slot);
    return entry ? { entry, assignedCardId: slot.assigned_card_id ?? null, originalIndex } : null;
  };
  const physical = available.map(payload);
  const sourceIndex = available.indexOf(sourceSlot);
  const targetIndex = available.indexOf(targetSlot);
  [physical[sourceIndex], physical[targetIndex]] = [
    physical[targetIndex] ?? null,
    physical[sourceIndex] ?? null,
  ];
  const pageSize = version.rows * version.columns;
  const breakNeedsReflow = physical.some(
    (item, index) =>
      item !== null &&
      (item.entry.kind === 'exact-card' || item.entry.kind === 'pokemon') &&
      item.entry.startsNewPage &&
      index % pageSize !== 0,
  );
  const flowed = breakNeedsReflow
    ? reflowBinderEntries(
        available.length,
        pageSize,
        physical.filter((entry) => entry !== null),
      )
    : physical;
  await runVersionBatch(db, ownerId, versionId, version.revision, false, [
    rewriteSlotsStatement(db, slots, flowed),
    ...revisionStatements(db, version, nowSeconds()),
  ]);
  return mutationResult(db, ownerId, versionId, [source.page, target.page]);
}

export async function addCardsToBinderVersion(
  db: D1Database,
  ownerId: string,
  versionId: string,
  cardIds: string[],
  requestedRevision?: number,
): Promise<{ binder: BinderMutationResult; added: number }> {
  if (cardIds.length === 0 || cardIds.length > MAX_BINDER_CARDS)
    domainError('binder_slot_out_of_bounds');
  const version = await readVersion(db, ownerId, versionId);
  requireEditable(version);
  expectedRevision(version, requestedRevision);
  const uniqueIds = [...new Set(cardIds)];
  const cards = await orderingRows(db, uniqueIds);
  if (cards.size !== uniqueIds.length) domainError('binder_arrangement_card_missing');

  const existing = await db
    .prepare(
      `SELECT slots.binder_page_id, slots.row_index, slots.column_index, pages.position
       FROM binder_slots slots JOIN binder_pages pages ON pages.id = slots.binder_page_id
       WHERE pages.binder_version_id = ?1 AND pages.kind = 'slots'
         AND slots.entry_kind = 'empty'
       ORDER BY pages.position, slots.row_index, slots.column_index LIMIT ?2`,
    )
    .bind(versionId, cardIds.length)
    .all<SlotRow & { position: number }>();
  const perPage = version.rows * version.columns;
  const missingSlots = Math.max(0, cardIds.length - existing.results.length);
  if (missingSlots > 0)
    throw new BinderDomainError('binder_capacity_exceeded', {
      currentCapacity: version.capacity,
      requiredCapacity: version.capacity + missingSlots,
      additionalPockets: missingSlots,
      pageIncrement: perPage,
    });
  const locations = existing.results.map((slot) => ({
    pageId: slot.binder_page_id,
    row: slot.row_index,
    column: slot.column_index,
    position: slot.position,
  }));
  const assignments = cardIds.map((cardId, index) => ({ ...locations[index], cardId }));
  if (assignments.some((assignment) => !assignment.pageId))
    domainError('binder_slot_out_of_bounds');

  const statements: D1PreparedStatement[] = [];
  statements.push(
    db
      .prepare(
        `WITH assignments AS (
          SELECT json_extract(value, '$.pageId') AS page_id,
            CAST(json_extract(value, '$.row') AS INTEGER) AS row_index,
            CAST(json_extract(value, '$.column') AS INTEGER) AS column_index,
            json_extract(value, '$.cardId') AS card_id
          FROM json_each(?1)
         )
         UPDATE binder_slots
         SET card_id = (
           SELECT card_id FROM assignments
           WHERE page_id = binder_slots.binder_page_id
             AND row_index = binder_slots.row_index
             AND column_index = binder_slots.column_index
         ), entry_kind = 'exact-card', label = NULL, pokemon_number = NULL,
           assigned_card_id = NULL, starts_new_page = 0
         WHERE EXISTS (
           SELECT 1 FROM assignments
           WHERE page_id = binder_slots.binder_page_id
             AND row_index = binder_slots.row_index
             AND column_index = binder_slots.column_index
         )`,
      )
      .bind(JSON.stringify(assignments)),
    ...revisionStatements(db, version, nowSeconds()),
  );
  await runVersionBatch(db, ownerId, versionId, version.revision, false, statements);
  const firstPage = assignments[0]?.position ?? 0;
  return {
    binder: await mutationResult(db, ownerId, versionId, [firstPage]),
    added: cardIds.length,
  };
}

export async function cloneBinderVersion(
  db: D1Database,
  ownerId: string,
  sourceVersionId: string,
  requestedRevision?: number,
): Promise<BinderMutationResult> {
  const source = await readVersion(db, ownerId, sourceVersionId);
  expectedRevision(source, requestedRevision);
  const pages = await listPageRows(db, sourceVersionId);
  const newVersionId = newId('binder_version');
  const mapping = pages.map((page) => ({
    sourceId: page.id,
    newId: newId('page'),
    position: page.position,
  }));
  const mappingJson = JSON.stringify(mapping);
  const now = nowSeconds();
  await runVersionBatch(db, ownerId, sourceVersionId, source.revision, false, [
    db
      .prepare(
        `INSERT INTO binder_versions
          (id, binder_id, version_number, status, layout_kind, rows, columns, revision, capacity, created_at)
         SELECT ?1, source.binder_id,
          COALESCE((SELECT MAX(version_number) FROM binder_versions WHERE binder_id = source.binder_id), 0) + 1,
          'draft', source.layout_kind, source.rows, source.columns, 1, source.capacity, ?2
         FROM binder_versions source WHERE source.id = ?3`,
      )
      .bind(newVersionId, now, sourceVersionId),
    db
      .prepare(
        `WITH mapping AS (
          SELECT json_extract(value, '$.newId') AS new_id,
            CAST(json_extract(value, '$.position') AS INTEGER) AS position
          FROM json_each(?1)
         )
         INSERT INTO binder_pages (id, binder_version_id, position)
         SELECT new_id, ?2, position FROM mapping`,
      )
      .bind(mappingJson, newVersionId),
    db
      .prepare(
        `WITH mapping AS (
          SELECT json_extract(value, '$.sourceId') AS source_id,
            json_extract(value, '$.newId') AS new_id
          FROM json_each(?1)
         )
         INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id,
           entry_kind, label, pokemon_number, assigned_card_id, starts_new_page)
         SELECT mapping.new_id, slots.row_index, slots.column_index, slots.card_id,
           slots.entry_kind, slots.label, slots.pokemon_number, slots.assigned_card_id,
           slots.starts_new_page
         FROM mapping JOIN binder_slots slots ON slots.binder_page_id = mapping.source_id`,
      )
      .bind(mappingJson),
    db.prepare('UPDATE binders SET updated_at = ?1 WHERE id = ?2').bind(now, source.binder_id),
  ]);
  return mutationResult(db, ownerId, newVersionId, [0]);
}

export async function activateBinderVersion(
  db: D1Database,
  ownerId: string,
  versionId: string,
  requestedRevision?: number,
): Promise<BinderMutationResult> {
  const version = await readVersion(db, ownerId, versionId);
  expectedRevision(version, requestedRevision);
  if (version.status === 'active') return mutationResult(db, ownerId, versionId, [0]);
  const now = nowSeconds();
  try {
    await runVersionBatch(db, ownerId, versionId, version.revision, false, [
      db
        .prepare(
          `SELECT CASE WHEN NOT EXISTS (
          SELECT proposed.assigned_card_id
          FROM binder_slots proposed
          JOIN binder_pages proposed_page ON proposed_page.id = proposed.binder_page_id
          WHERE proposed_page.binder_version_id = ?1 AND proposed.assigned_card_id IS NOT NULL
          GROUP BY proposed.assigned_card_id
          HAVING COUNT(*) + (
            SELECT COUNT(*) FROM binder_slots other
            JOIN binder_pages other_page ON other_page.id = other.binder_page_id
            JOIN binder_versions other_version ON other_version.id = other_page.binder_version_id
            JOIN binders other_binder ON other_binder.id = other_version.binder_id
            WHERE other_binder.owner_id = ?2 AND other_version.status = 'active'
              AND other_version.binder_id <> ?3
              AND other.assigned_card_id = proposed.assigned_card_id
          ) > COALESCE((SELECT quantity FROM collection_cards
            WHERE owner_id = ?2 AND card_id = proposed.assigned_card_id), 0)
         ) THEN 1 ELSE json_extract('binder_assignment_quantity_exceeded', '$') END AS valid`,
        )
        .bind(versionId, ownerId, version.binder_id),
      db
        .prepare(
          `UPDATE binder_versions SET status = 'archived', revision = revision + 1
         WHERE binder_id = ?1 AND status = 'active' AND id <> ?2`,
        )
        .bind(version.binder_id, versionId),
      db
        .prepare(
          `UPDATE binder_versions
         SET status = 'active', activated_at = ?1, revision = revision + 1
         WHERE id = ?2 AND revision = ?3`,
        )
        .bind(now, versionId, version.revision),
      db
        .prepare('UPDATE binders SET active_version_id = ?1, updated_at = ?2 WHERE id = ?3')
        .bind(versionId, now, version.binder_id),
    ]);
  } catch (error) {
    const conflict = await db
      .prepare(
        `SELECT proposed.assigned_card_id
         FROM binder_slots proposed
         JOIN binder_pages proposed_page ON proposed_page.id = proposed.binder_page_id
         WHERE proposed_page.binder_version_id = ?1 AND proposed.assigned_card_id IS NOT NULL
         GROUP BY proposed.assigned_card_id
         HAVING COUNT(*) + (
           SELECT COUNT(*) FROM binder_slots other
           JOIN binder_pages other_page ON other_page.id = other.binder_page_id
           JOIN binder_versions other_version ON other_version.id = other_page.binder_version_id
           JOIN binders other_binder ON other_binder.id = other_version.binder_id
           WHERE other_binder.owner_id = ?2 AND other_version.status = 'active'
             AND other_version.binder_id <> ?3
             AND other.assigned_card_id = proposed.assigned_card_id
         ) > COALESCE((SELECT quantity FROM collection_cards
           WHERE owner_id = ?2 AND card_id = proposed.assigned_card_id), 0)
         LIMIT 1`,
      )
      .bind(versionId, ownerId, version.binder_id)
      .first();
    if (conflict) throw new BinderDomainError('binder_assignment_quantity_exceeded');
    throw error;
  }
  return mutationResult(db, ownerId, versionId, [0]);
}

interface MaterializedSlot extends SlotRow {
  page_position: number;
  page_kind: 'slots' | 'reserved';
}

function slotEntry(slot: MaterializedSlot): BinderEntry | null {
  const kind = slot.entry_kind ?? (slot.card_id === null ? 'empty' : 'exact-card');
  if (kind === 'empty') return null;
  if (kind === 'reserved') return { kind, label: slot.label ?? null };
  if (kind === 'exact-card') {
    if (!slot.card_id) domainError('binder_slot_not_found');
    return {
      kind,
      cardId: cardIdSchema.parse(slot.card_id),
      startsNewPage: slot.starts_new_page === 1,
    };
  }
  if (!slot.pokemon_number) domainError('binder_slot_not_found');
  return { kind, pokemonNumber: slot.pokemon_number, startsNewPage: slot.starts_new_page === 1 };
}

async function materializedSlots(db: D1Database, versionId: string): Promise<MaterializedSlot[]> {
  const result = await db
    .prepare(
      `SELECT slot.binder_page_id, slot.row_index, slot.column_index, slot.card_id,
        slot.entry_kind, slot.label, slot.pokemon_number, slot.assigned_card_id,
        slot.starts_new_page, page.position AS page_position, page.kind AS page_kind
       FROM binder_slots slot JOIN binder_pages page ON page.id = slot.binder_page_id
       WHERE page.binder_version_id = ?1
       ORDER BY page.position, slot.row_index, slot.column_index`,
    )
    .bind(versionId)
    .all<MaterializedSlot>();
  return result.results;
}

function locationIndex(version: VersionRow, location: BinderSlotLocation): number {
  validateLocation(version, location);
  if (location.page >= version.page_count) domainError('binder_page_not_found');
  return (
    location.page * version.rows * version.columns +
    location.row * version.columns +
    location.column
  );
}

function encodedSlot(item: ReflowEntry | null, slot: MaterializedSlot) {
  const entry = item?.entry ?? null;
  return {
    pageId: slot.binder_page_id,
    row: slot.row_index,
    column: slot.column_index,
    kind: entry?.kind ?? 'empty',
    label: entry?.kind === 'reserved' ? entry.label : null,
    cardId: entry?.kind === 'exact-card' ? entry.cardId : null,
    pokemonNumber: entry?.kind === 'pokemon' ? entry.pokemonNumber : null,
    startsNewPage:
      entry?.kind === 'exact-card' || entry?.kind === 'pokemon' ? entry.startsNewPage : false,
    assignedCardId: item?.assignedCardId ?? null,
  };
}

function rewriteSlotsStatement(
  db: D1Database,
  slots: MaterializedSlot[],
  entries: Array<ReflowEntry | null>,
): D1PreparedStatement {
  const available = slots.filter((slot) => slot.page_kind !== 'reserved');
  const rows = available.map((slot, index) => encodedSlot(entries[index] ?? null, slot));
  return db
    .prepare(
      `WITH replacement AS (
        SELECT json_extract(value, '$.pageId') AS page_id,
          CAST(json_extract(value, '$.row') AS INTEGER) AS row_index,
          CAST(json_extract(value, '$.column') AS INTEGER) AS column_index,
          json_extract(value, '$.kind') AS entry_kind,
          json_extract(value, '$.label') AS label,
          json_extract(value, '$.cardId') AS card_id,
          json_extract(value, '$.pokemonNumber') AS pokemon_number,
          CAST(json_extract(value, '$.startsNewPage') AS INTEGER) AS starts_new_page
          ,json_extract(value, '$.assignedCardId') AS assigned_card_id
        FROM json_each(?1)
       )
       UPDATE binder_slots SET
         entry_kind = (SELECT entry_kind FROM replacement WHERE page_id = binder_page_id
           AND row_index = binder_slots.row_index AND column_index = binder_slots.column_index),
         label = (SELECT label FROM replacement WHERE page_id = binder_page_id
           AND row_index = binder_slots.row_index AND column_index = binder_slots.column_index),
         card_id = (SELECT card_id FROM replacement WHERE page_id = binder_page_id
           AND row_index = binder_slots.row_index AND column_index = binder_slots.column_index),
         pokemon_number = (SELECT pokemon_number FROM replacement WHERE page_id = binder_page_id
           AND row_index = binder_slots.row_index AND column_index = binder_slots.column_index),
         assigned_card_id = (SELECT assigned_card_id FROM replacement WHERE page_id = binder_page_id
           AND row_index = binder_slots.row_index AND column_index = binder_slots.column_index),
         starts_new_page = (SELECT starts_new_page FROM replacement WHERE page_id = binder_page_id
           AND row_index = binder_slots.row_index AND column_index = binder_slots.column_index)
       WHERE EXISTS (SELECT 1 FROM replacement WHERE page_id = binder_page_id
         AND row_index = binder_slots.row_index AND column_index = binder_slots.column_index)`,
    )
    .bind(JSON.stringify(rows));
}

async function mutateLogicalEntries(
  db: D1Database,
  ownerId: string,
  versionId: string,
  requestedRevision: number,
  anchor: BinderSlotLocation,
  mutate: (
    entries: ReflowEntry[],
    index: number,
    physicalIndex: number,
    capacity: number,
  ) => ReflowEntry[],
): Promise<BinderMutationResult> {
  const version = await readVersion(db, ownerId, versionId);
  requireEditable(version);
  expectedRevision(version, requestedRevision);
  const slots = await materializedSlots(db, versionId);
  const physicalIndex = locationIndex(version, anchor);
  const anchorSlot = slots[physicalIndex];
  if (!anchorSlot || anchorSlot.page_kind === 'reserved')
    domainError('binder_reserved_page_not_empty');
  const available = slots.filter((slot) => slot.page_kind !== 'reserved');
  const availableIndex = available.indexOf(anchorSlot);
  const dense = available
    .map((slot, index) => {
      const entry = slotEntry(slot);
      return entry
        ? { entry, assignedCardId: slot.assigned_card_id ?? null, originalIndex: index }
        : null;
    })
    .filter((entry) => entry !== null);
  const logicalIndex = available
    .slice(0, availableIndex)
    .filter((slot) => slotEntry(slot) !== null).length;
  const changed = mutate(dense, logicalIndex, availableIndex, available.length);
  const flowed = reflowBinderEntries(available.length, version.rows * version.columns, changed);
  await runVersionBatch(db, ownerId, versionId, version.revision, false, [
    rewriteSlotsStatement(db, slots, flowed),
    ...revisionStatements(db, version, nowSeconds()),
  ]);
  return { ...(await mutationResult(db, ownerId, versionId, [anchor.page])), anchor };
}

export function insertBinderEntries(
  db: D1Database,
  ownerId: string,
  versionId: string,
  at: BinderSlotLocation,
  entries: BinderEntry[],
  expectedRevision: number,
): Promise<BinderMutationResult> {
  return mutateLogicalEntries(db, ownerId, versionId, expectedRevision, at, (current, index) => [
    ...current.slice(0, index),
    ...entries.map((entry) => ({ entry, assignedCardId: null })),
    ...current.slice(index),
  ]);
}

export function compactRemoveBinderEntry(
  db: D1Database,
  ownerId: string,
  versionId: string,
  at: BinderSlotLocation,
  expectedRevision: number,
): Promise<BinderMutationResult> {
  return mutateLogicalEntries(db, ownerId, versionId, expectedRevision, at, (current, index) =>
    current.filter((_entry, entryIndex) => entryIndex !== index),
  );
}

export async function moveBinderEntryByOffset(
  db: D1Database,
  ownerId: string,
  versionId: string,
  from: BinderSlotLocation,
  offset: number,
  requestedRevision: number,
): Promise<BinderMutationResult> {
  const version = await readVersion(db, ownerId, versionId);
  requireEditable(version);
  expectedRevision(version, requestedRevision);
  validateLocation(version, from);
  const slots = await materializedSlots(db, versionId);
  const sourceSlot = slots.find(
    (slot) =>
      slot.page_position === from.page &&
      slot.row_index === from.row &&
      slot.column_index === from.column,
  );
  if (!sourceSlot) domainError('binder_slot_not_found');
  if (sourceSlot.page_kind === 'reserved') domainError('binder_reserved_page_not_empty');
  const available = slots.filter((slot) => slot.page_kind !== 'reserved');
  const sourceIndex = available.indexOf(sourceSlot);
  const targetIndex = sourceIndex + offset;
  if (targetIndex < 0 || targetIndex >= available.length) domainError('binder_slot_out_of_bounds');
  const physical = available.map((slot, originalIndex): ReflowEntry | null => {
    const entry = slotEntry(slot);
    return entry ? { entry, assignedCardId: slot.assigned_card_id ?? null, originalIndex } : null;
  });
  const moved = physical[sourceIndex];
  if (!moved) domainError('binder_slot_not_found');
  physical.splice(sourceIndex, 1);
  physical.splice(targetIndex, 0, moved);
  const pageSize = version.rows * version.columns;
  for (let index = 0; index < physical.length; index += 1) {
    const item = physical[index];
    if (
      !item ||
      (item.entry.kind !== 'exact-card' && item.entry.kind !== 'pokemon') ||
      !item.entry.startsNewPage ||
      index % pageSize === 0
    )
      continue;
    const pageStart = index + (pageSize - (index % pageSize));
    if (pageStart >= physical.length)
      throw new BinderDomainError('binder_capacity_exceeded', {
        currentCapacity: version.capacity,
        requiredCapacity: version.capacity + 1,
        additionalPockets: 1,
        pageIncrement: pageSize,
      });
    physical.splice(index, 1);
    physical.splice(pageStart, 0, item);
  }
  await runVersionBatch(db, ownerId, versionId, version.revision, false, [
    rewriteSlotsStatement(db, slots, physical),
    ...revisionStatements(db, version, nowSeconds()),
  ]);
  const finalIndex = physical.indexOf(moved);
  const targetSlot = available[finalIndex];
  if (!targetSlot) domainError('binder_slot_not_found');
  const anchor = {
    page: targetSlot.page_position,
    row: targetSlot.row_index,
    column: targetSlot.column_index,
  };
  return {
    ...(await mutationResult(db, ownerId, versionId, [from.page, anchor.page])),
    anchor,
  };
}

export function insertFullPokedex(
  db: D1Database,
  ownerId: string,
  versionId: string,
  at: BinderSlotLocation,
  regionPageBreaks: boolean,
  expectedRevision: number,
): Promise<BinderMutationResult> {
  let previousCategory: string | undefined;
  const entries: BinderEntry[] = NATIONAL_POKEDEX.map((pokemon) => {
    const startsNewPage =
      regionPageBreaks &&
      (previousCategory === undefined || previousCategory !== pokemon.discoveryCategory);
    previousCategory = pokemon.discoveryCategory;
    return { kind: 'pokemon', pokemonNumber: pokemon.number, startsNewPage };
  });
  return insertBinderEntries(db, ownerId, versionId, at, entries, expectedRevision);
}

export async function setBinderEntryAssignment(
  db: D1Database,
  ownerId: string,
  versionId: string,
  at: BinderSlotLocation,
  cardId: string | null,
  requestedRevision: number,
): Promise<BinderMutationResult> {
  const version = await readVersion(db, ownerId, versionId);
  requireEditable(version);
  expectedRevision(version, requestedRevision);
  const page = await pageAt(db, versionId, at.page);
  validateLocation(version, at);
  if (cardId !== null) await requireCard(db, cardId);
  const now = nowSeconds();
  const quantityAssertion = db
    .prepare(
      `SELECT CASE WHEN ?1 IS NULL OR (
        (SELECT COUNT(*) FROM binder_slots assigned
         JOIN binder_pages assigned_page ON assigned_page.id = assigned.binder_page_id
         JOIN binder_versions assigned_version ON assigned_version.id = assigned_page.binder_version_id
         JOIN binders assigned_binder ON assigned_binder.id = assigned_version.binder_id
         WHERE assigned_binder.owner_id = ?2
           AND (assigned_version.id = ?6 OR (assigned_version.status = 'active'
             AND NOT (?7 = 'draft' AND assigned_version.binder_id = ?8)))
           AND assigned.assigned_card_id = ?1
           AND NOT (assigned.binder_page_id = ?3 AND assigned.row_index = ?4 AND assigned.column_index = ?5))
        < COALESCE((SELECT quantity FROM collection_cards WHERE owner_id = ?2 AND card_id = ?1), 0)
      ) THEN 1 ELSE json_extract('binder_assignment_quantity_exceeded', '$') END AS valid`,
    )
    .bind(
      cardId,
      ownerId,
      page.id,
      at.row,
      at.column,
      versionId,
      version.status,
      version.binder_id,
    );
  try {
    await runVersionBatch(db, ownerId, versionId, version.revision, false, [
      db
        .prepare(
          `SELECT CASE WHEN EXISTS (
          SELECT 1 FROM binder_slots WHERE binder_page_id = ?1 AND row_index = ?2
            AND column_index = ?3 AND entry_kind IN ('exact-card', 'pokemon')
         ) THEN 1 ELSE json_extract('binder_slot_not_found', '$') END AS valid`,
        )
        .bind(page.id, at.row, at.column),
      quantityAssertion,
      db
        .prepare(
          `UPDATE binder_slots SET assigned_card_id = ?1
         WHERE binder_page_id = ?2 AND row_index = ?3 AND column_index = ?4
           AND entry_kind IN ('exact-card', 'pokemon')`,
        )
        .bind(cardId, page.id, at.row, at.column),
      ...revisionStatements(db, version, now),
    ]);
  } catch (error) {
    if (cardId !== null) {
      const budget = await db
        .prepare(
          `SELECT COALESCE((SELECT quantity FROM collection_cards
              WHERE owner_id = ?1 AND card_id = ?2), 0) AS quantity,
            (SELECT COUNT(*) FROM binder_slots slot
             JOIN binder_pages page ON page.id = slot.binder_page_id
             JOIN binder_versions assigned_version ON assigned_version.id = page.binder_version_id
             WHERE slot.assigned_card_id = ?2
               AND (assigned_version.id = ?3 OR assigned_version.status = 'active')) AS assigned`,
        )
        .bind(ownerId, cardId, versionId)
        .first<{ quantity: number; assigned: number }>();
      if ((budget?.assigned ?? 0) >= (budget?.quantity ?? 0))
        throw new BinderDomainError('binder_assignment_quantity_exceeded');
    }
    throw error;
  }
  return { ...(await mutationResult(db, ownerId, versionId, [at.page])), anchor: at };
}

export async function setBinderEntryPageBreak(
  db: D1Database,
  ownerId: string,
  versionId: string,
  at: BinderSlotLocation,
  startsNewPage: boolean,
  requestedRevision: number,
): Promise<BinderMutationResult> {
  return mutateLogicalEntries(db, ownerId, versionId, requestedRevision, at, (current, index) => {
    const item = current[index];
    if (!item || (item.entry.kind !== 'exact-card' && item.entry.kind !== 'pokemon'))
      domainError('binder_slot_not_found');
    const replacement: ReflowEntry = {
      ...item,
      entry: { ...item.entry, startsNewPage },
    };
    return current.map((entry, entryIndex) => (entryIndex === index ? replacement : entry));
  });
}

export async function reserveBinderPage(
  db: D1Database,
  ownerId: string,
  versionId: string,
  pagePosition: number,
  reserved: boolean,
  label: string | null,
  requestedRevision: number,
): Promise<BinderMutationResult> {
  const version = await readVersion(db, ownerId, versionId);
  requireEditable(version);
  expectedRevision(version, requestedRevision);
  const page = await pageAt(db, versionId, pagePosition);
  const slots = await materializedSlots(db, versionId);
  const dense = slots
    .filter((slot) => slot.page_kind !== 'reserved')
    .map((slot) => {
      const entry = slotEntry(slot);
      return entry ? { entry, assignedCardId: slot.assigned_card_id ?? null } : null;
    })
    .filter((entry) => entry !== null);
  const futureSlots = slots.map((slot) =>
    slot.binder_page_id === page.id
      ? { ...slot, page_kind: reserved ? ('reserved' as const) : ('slots' as const) }
      : slot,
  );
  const available = futureSlots.filter((slot) => slot.page_kind !== 'reserved');
  const flowed = reflowBinderEntries(available.length, version.rows * version.columns, dense);
  await runVersionBatch(db, ownerId, versionId, version.revision, false, [
    ...(reserved
      ? [
          db
            .prepare(
              `UPDATE binder_slots SET entry_kind = 'empty', label = NULL, card_id = NULL,
                pokemon_number = NULL, assigned_card_id = NULL, starts_new_page = 0
               WHERE binder_page_id = ?1`,
            )
            .bind(page.id),
        ]
      : []),
    db
      .prepare('UPDATE binder_pages SET kind = ?1, label = ?2 WHERE id = ?3')
      .bind(reserved ? 'reserved' : 'slots', label, page.id),
    rewriteSlotsStatement(db, futureSlots, flowed),
    ...revisionStatements(db, version, nowSeconds()),
  ]);
  return mutationResult(db, ownerId, versionId, [pagePosition]);
}

export async function resizeBinderCapacity(
  db: D1Database,
  ownerId: string,
  versionId: string,
  capacity: number,
  requestedRevision: number,
): Promise<BinderMutationResult> {
  const version = await readVersion(db, ownerId, versionId);
  requireEditable(version);
  expectedRevision(version, requestedRevision);
  const pageSize = version.rows * version.columns;
  if (!Number.isInteger(capacity) || capacity < pageSize || capacity % pageSize !== 0)
    domainError('binder_capacity_invalid');
  const targetPages = capacity / pageSize;
  if (targetPages > MAX_BINDER_PAGES) domainError('binder_page_limit_reached');
  if (capacity === version.capacity) return mutationResult(db, ownerId, versionId, [0]);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `SELECT CASE WHEN ?1 <= ?2 THEN 1 ELSE json_extract('binder_page_limit_reached', '$') END AS valid`,
      )
      .bind(targetPages, MAX_BINDER_PAGES),
  ];
  if (targetPages < version.page_count) {
    statements.push(
      db
        .prepare(
          `SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM binder_pages page LEFT JOIN binder_slots slot ON slot.binder_page_id = page.id
            WHERE page.binder_version_id = ?1 AND page.position >= ?2
              AND (page.kind = 'reserved' OR slot.entry_kind <> 'empty' OR slot.assigned_card_id IS NOT NULL
                OR slot.starts_new_page = 1)
           ) THEN 1 ELSE json_extract('binder_shrink_occupied', '$') END AS valid`,
        )
        .bind(versionId, targetPages),
      db
        .prepare('DELETE FROM binder_pages WHERE binder_version_id = ?1 AND position >= ?2')
        .bind(versionId, targetPages),
    );
  } else {
    const pages = Array.from({ length: targetPages - version.page_count }, (_unused, index) => ({
      id: newId('page'),
      position: version.page_count + index,
    }));
    statements.push(
      db
        .prepare(
          `INSERT INTO binder_pages (id, binder_version_id, position)
           SELECT json_extract(value, '$.id'), ?1, CAST(json_extract(value, '$.position') AS INTEGER)
           FROM json_each(?2)`,
        )
        .bind(versionId, JSON.stringify(pages)),
      db
        .prepare(
          `WITH RECURSIVE rows(value) AS (
             SELECT 0 UNION ALL SELECT value + 1 FROM rows WHERE value + 1 < ?2
           ), columns(value) AS (
             SELECT 0 UNION ALL SELECT value + 1 FROM columns WHERE value + 1 < ?3
           )
           INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id)
           SELECT json_extract(page.value, '$.id'), rows.value, columns.value, NULL
           FROM json_each(?1) page CROSS JOIN rows CROSS JOIN columns`,
        )
        .bind(JSON.stringify(pages), version.rows, version.columns),
    );
  }
  statements.push(
    db.prepare('UPDATE binder_versions SET capacity = ?1 WHERE id = ?2').bind(capacity, versionId),
    ...revisionStatements(db, version, nowSeconds()),
  );
  try {
    await runVersionBatch(db, ownerId, versionId, version.revision, false, statements);
  } catch (error) {
    if (targetPages < version.page_count) {
      const occupied = await db
        .prepare(
          `SELECT 1 FROM binder_pages page LEFT JOIN binder_slots slot ON slot.binder_page_id = page.id
           WHERE page.binder_version_id = ?1 AND page.position >= ?2
             AND (page.kind = 'reserved' OR slot.entry_kind <> 'empty'
               OR slot.assigned_card_id IS NOT NULL OR slot.starts_new_page = 1) LIMIT 1`,
        )
        .bind(versionId, targetPages)
        .first();
      if (occupied) throw new BinderDomainError('binder_shrink_occupied');
    }
    throw error;
  }
  return mutationResult(db, ownerId, versionId, [Math.min(version.page_count, targetPages) - 1]);
}
