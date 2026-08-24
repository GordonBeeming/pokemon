import {
  binderLayoutSchema,
  binderMutationResultSchema,
  binderPageSchema,
  binderVersionPagesSchema,
  binderVersionSummarySchema,
  cardIdSchema,
  type BinderLayout,
  type BinderMutationResult,
  type BinderPage,
  type BinderShortage,
  type BinderSlotLocation,
  type BinderVersionPages,
  type BinderVersionSummary,
  type BinderView,
} from '@pokedex/shared';
import { newId, nowSeconds } from './db';

const MAX_BINDER_PAGES = 200;
const MAX_PAGE_WINDOW = 4;
const MAX_SHORTAGE_PAGE = 100;
const CARD_QUERY_CHUNK = 80;
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

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
}

interface PageRow {
  id: string;
  position: number;
}

interface SlotRow {
  binder_page_id: string;
  row_index: number;
  column_index: number;
  card_id: string | null;
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
  | 'binder_revision_conflict'
  | 'binder_page_not_found'
  | 'binder_last_page'
  | 'binder_page_order_invalid'
  | 'binder_page_limit_reached'
  | 'binder_page_window_invalid'
  | 'binder_slot_not_found'
  | 'binder_slot_out_of_bounds'
  | 'binder_arrangement_card_missing'
  | 'card_not_found';

export class BinderDomainError extends Error {
  constructor(public readonly code: BinderErrorCode) {
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
        v.rows, v.columns, v.revision, COUNT(p.id) AS page_count
       FROM binder_versions v
       JOIN binders b ON b.id = v.binder_id
       LEFT JOIN binder_pages p ON p.binder_version_id = v.id
       WHERE v.id = ?1 AND b.owner_id = ?2
       GROUP BY v.id, v.binder_id, v.version_number, v.status, v.layout_kind,
        v.rows, v.columns, v.revision`,
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

function requireDraft(row: VersionRow): void {
  if (row.status !== 'draft') domainError('binder_version_not_draft');
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
      'SELECT id, position FROM binder_pages WHERE binder_version_id = ?1 ORDER BY position LIMIT ?2 OFFSET ?3',
    )
    .bind(versionId, limit, page)
    .all<PageRow>();
  if (pageRows.results.length === 0) return [];
  const placeholders = pageRows.results.map((_item, index) => `?${index + 1}`).join(',');
  const slotRows = await db
    .prepare(
      `SELECT binder_page_id, row_index, column_index, card_id
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
      slots: (slotsByPage.get(item.id) ?? []).map((slot) => ({
        pageId: slot.binder_page_id,
        row: slot.row_index,
        column: slot.column_index,
        cardId: slot.card_id,
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
      'SELECT id, position FROM binder_pages WHERE binder_version_id = ?1 ORDER BY position, id LIMIT ?2',
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
): Promise<BinderMutationResult> {
  const layout = binderLayoutSchema.parse(inputLayout);
  const now = nowSeconds();
  const binderId = newId('binder');
  const versionId = newId('binder_version');
  const pageId = newId('page');
  await db.batch([
    db
      .prepare(
        'INSERT INTO binders (id, owner_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
      )
      .bind(binderId, ownerId, name, now),
    db
      .prepare(
        `INSERT INTO binder_versions
          (id, binder_id, version_number, status, layout_kind, rows, columns, revision, created_at)
         VALUES (?1, ?2, 1, 'draft', ?3, ?4, ?5, 1, ?6)`,
      )
      .bind(versionId, binderId, layout.kind, layout.rows, layout.columns, now),
    db
      .prepare('INSERT INTO binder_pages (id, binder_version_id, position) VALUES (?1, ?2, 0)')
      .bind(pageId, versionId),
    createSlotsStatement(db, pageId, layout),
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
      `SELECT s.card_id, COUNT(*) AS required, COALESCE(c.quantity, 0) AS owned
       FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id
       JOIN binder_versions v ON v.id = p.binder_version_id
       JOIN binders b ON b.id = v.binder_id
       LEFT JOIN collection_cards c ON c.card_id = s.card_id AND c.owner_id = b.owner_id
       WHERE b.owner_id = ?1 AND v.status = 'active' AND s.card_id IS NOT NULL
       GROUP BY s.card_id HAVING COUNT(*) > COALESCE(c.quantity, 0)
       ORDER BY (COUNT(*) - COALESCE(c.quantity, 0)) DESC, s.card_id LIMIT ?2`,
    )
    .bind(ownerId, MAX_SHORTAGE_PAGE)
    .all<{ card_id: string; required: number; owned: number }>();
  return result.results.map((row) => ({
    cardId: cardIdSchema.parse(row.card_id),
    required: row.required,
    owned: row.owned,
    missing: row.required - row.owned,
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
): Promise<{ shortages: BinderShortage[]; nextOffset: number | null }> {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1)
    domainError('binder_page_window_invalid');
  await readVersion(db, ownerId, versionId);
  const bounded = Math.min(limit, MAX_SHORTAGE_PAGE);
  const result = await db
    .prepare(
      `SELECT s.card_id, COUNT(*) AS required, COALESCE(c.quantity, 0) AS owned
       FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id
       LEFT JOIN collection_cards c ON c.card_id = s.card_id AND c.owner_id = ?2
       WHERE p.binder_version_id = ?1 AND s.card_id IS NOT NULL
       GROUP BY s.card_id HAVING COUNT(*) > COALESCE(c.quantity, 0)
       ORDER BY (COUNT(*) - COALESCE(c.quantity, 0)) DESC, s.card_id LIMIT ?3 OFFSET ?4`,
    )
    .bind(versionId, ownerId, bounded + 1, offset)
    .all<{ card_id: string; required: number; owned: number }>();
  const rows = result.results.slice(0, bounded);
  return {
    shortages: rows.map((row) => ({
      cardId: cardIdSchema.parse(row.card_id),
      required: row.required,
      owned: row.owned,
      missing: row.required - row.owned,
    })),
    nextOffset: result.results.length > bounded ? offset + bounded : null,
  };
}

async function addBinderPageOnce(
  db: D1Database,
  ownerId: string,
  versionId: string,
  requestedRevision?: number,
): Promise<BinderMutationResult> {
  const version = await readVersion(db, ownerId, versionId);
  requireDraft(version);
  expectedRevision(version, requestedRevision);
  if (version.page_count >= MAX_BINDER_PAGES) domainError('binder_page_limit_reached');
  const pageId = newId('page');
  const now = nowSeconds();
  await runVersionBatch(db, ownerId, versionId, version.revision, true, [
    db
      .prepare(
        `INSERT INTO binder_pages (id, binder_version_id, position)
         SELECT ?1, ?2, COALESCE(MAX(position) + 1, 0)
         FROM binder_pages WHERE binder_version_id = ?2`,
      )
      .bind(pageId, versionId),
    createSlotsStatement(db, pageId, toLayout(version)),
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
  requireDraft(version);
  expectedRevision(version, requestedRevision);
  const pages = await listPageRows(db, versionId);
  const page = pages.find((item) => item.id === pageId);
  if (!page) domainError('binder_page_not_found');
  if (pages.length <= 1) domainError('binder_last_page');
  const remaining = pages.filter((item) => item.id !== pageId);
  const offset = pages.length + 1;
  const now = nowSeconds();
  await runVersionBatch(db, ownerId, versionId, version.revision, true, [
    db.prepare('DELETE FROM binder_pages WHERE id = ?1').bind(pageId),
    db
      .prepare('UPDATE binder_pages SET position = position + ?1 WHERE binder_version_id = ?2')
      .bind(offset, versionId),
    ...remaining.map((item, position) =>
      db.prepare('UPDATE binder_pages SET position = ?1 WHERE id = ?2').bind(position, item.id),
    ),
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
  requireDraft(version);
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
  await runVersionBatch(db, ownerId, versionId, version.revision, true, [
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
  requireDraft(version);
  expectedRevision(version, requestedRevision);
  if (version.page_count > MAX_BINDER_PAGES) domainError('binder_page_limit_reached');
  const maxSlots = version.page_count * version.rows * version.columns;
  const slots = await db
    .prepare(
      `SELECT s.binder_page_id, s.row_index, s.column_index, s.card_id
       FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id
       WHERE p.binder_version_id = ?1 AND s.card_id IS NOT NULL
       ORDER BY p.position, s.row_index, s.column_index LIMIT ?2`,
    )
    .bind(versionId, maxSlots + 1)
    .all<SlotRow & { card_id: string }>();
  if (slots.results.length > maxSlots) domainError('binder_slot_out_of_bounds');
  if (slots.results.length === 0) return mutationResult(db, ownerId, versionId, [0]);
  const uniqueIds = [...new Set(slots.results.map((slot) => slot.card_id))];
  const cards = await orderingRows(db, uniqueIds);
  if (cards.size !== uniqueIds.length) domainError('binder_arrangement_card_missing');
  const arranged = slots.results
    .map((slot) => {
      const card = cards.get(slot.card_id);
      if (!card) domainError('binder_arrangement_card_missing');
      return { ...slot, card };
    })
    .sort((left, right) => compareBinderCards(left.card, right.card, mode));
  const assigned = slots.results.map((slot, index) => {
    const card = arranged[index]?.card;
    if (!card) domainError('binder_arrangement_card_missing');
    return { ...slot, cardId: card.id };
  });
  const byPage = new Map<string, typeof assigned>();
  for (const slot of assigned) {
    const page = byPage.get(slot.binder_page_id) ?? [];
    page.push(slot);
    byPage.set(slot.binder_page_id, page);
  }
  const now = nowSeconds();
  await runVersionBatch(db, ownerId, versionId, version.revision, true, [
    ...[...byPage].map(([pageId, pageSlots]) =>
      db
        .prepare(
          `WITH arranged AS (
            SELECT
              CAST(json_extract(value, '$.row') AS INTEGER) AS row_index,
              CAST(json_extract(value, '$.column') AS INTEGER) AS column_index,
              json_extract(value, '$.cardId') AS card_id
            FROM json_each(?1)
           )
           UPDATE binder_slots
           SET card_id = (
             SELECT card_id FROM arranged
             WHERE row_index = binder_slots.row_index
               AND column_index = binder_slots.column_index
           )
           WHERE binder_page_id = ?2
             AND EXISTS (
               SELECT 1 FROM arranged
               WHERE row_index = binder_slots.row_index
                 AND column_index = binder_slots.column_index
             )`,
        )
        .bind(
          JSON.stringify(
            pageSlots.map((slot) => ({
              row: slot.row_index,
              column: slot.column_index,
              cardId: slot.cardId,
            })),
          ),
          pageId,
        ),
    ),
    ...revisionStatements(db, version, now),
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
  requireDraft(version);
  expectedRevision(version, requestedRevision);
  validateLocation(version, { page: pagePosition, row, column });
  const page = await pageAt(db, versionId, pagePosition);
  await requireCard(db, cardId);
  const now = nowSeconds();
  await runVersionBatch(db, ownerId, versionId, version.revision, true, [
    db
      .prepare(
        `UPDATE binder_slots SET card_id = ?1
         WHERE binder_page_id = ?2 AND row_index = ?3 AND column_index = ?4`,
      )
      .bind(cardId, page.id, row, column),
    ...revisionStatements(db, version, now),
  ]);
  return mutationResult(db, ownerId, versionId, [pagePosition]);
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
  requireDraft(version);
  expectedRevision(version, requestedRevision);
  validateLocation(version, source);
  validateLocation(version, target);
  if (source.page === target.page && source.row === target.row && source.column === target.column)
    return mutationResult(db, ownerId, versionId, [source.page]);
  const [sourcePage, targetPage] = await Promise.all([
    pageAt(db, versionId, source.page),
    pageAt(db, versionId, target.page),
  ]);
  const slots = await db
    .prepare(
      `SELECT binder_page_id, row_index, column_index, card_id FROM binder_slots
       WHERE (binder_page_id = ?1 AND row_index = ?2 AND column_index = ?3)
          OR (binder_page_id = ?4 AND row_index = ?5 AND column_index = ?6)`,
    )
    .bind(sourcePage.id, source.row, source.column, targetPage.id, target.row, target.column)
    .all<SlotRow>();
  const sourceSlot = slots.results.find(
    (slot) =>
      slot.binder_page_id === sourcePage.id &&
      slot.row_index === source.row &&
      slot.column_index === source.column,
  );
  const targetSlot = slots.results.find(
    (slot) =>
      slot.binder_page_id === targetPage.id &&
      slot.row_index === target.row &&
      slot.column_index === target.column,
  );
  if (!sourceSlot || !targetSlot) domainError('binder_slot_not_found');
  const now = nowSeconds();
  await runVersionBatch(db, ownerId, versionId, version.revision, true, [
    db
      .prepare(
        `UPDATE binder_slots
         SET card_id = CASE
           WHEN binder_page_id = ?1 AND row_index = ?2 AND column_index = ?3 THEN ?7
           ELSE ?8
         END
         WHERE (binder_page_id = ?1 AND row_index = ?2 AND column_index = ?3)
            OR (binder_page_id = ?4 AND row_index = ?5 AND column_index = ?6)`,
      )
      .bind(
        sourcePage.id,
        source.row,
        source.column,
        targetPage.id,
        target.row,
        target.column,
        targetSlot.card_id,
        sourceSlot.card_id,
      ),
    ...revisionStatements(db, version, now),
  ]);
  return mutationResult(db, ownerId, versionId, [source.page, target.page]);
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
          (id, binder_id, version_number, status, layout_kind, rows, columns, revision, created_at)
         SELECT ?1, source.binder_id,
          COALESCE((SELECT MAX(version_number) FROM binder_versions WHERE binder_id = source.binder_id), 0) + 1,
          'draft', source.layout_kind, source.rows, source.columns, 1, ?2
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
         INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id)
         SELECT mapping.new_id, slots.row_index, slots.column_index, slots.card_id
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
  await runVersionBatch(db, ownerId, versionId, version.revision, false, [
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
  return mutationResult(db, ownerId, versionId, [0]);
}
