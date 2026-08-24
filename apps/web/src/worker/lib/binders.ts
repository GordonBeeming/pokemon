import { binderSlotSchema, type BinderLayout, type BinderSlot } from '@pokedex/shared';
import { newId, nowSeconds } from './db';

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
}

export interface BinderView {
  id: string;
  name: string;
  activeVersionId: string | null;
  updatedAt: string;
  latestVersionId: string | null;
}

export interface BinderVersionView {
  id: string;
  binderId: string;
  versionNumber: number;
  status: 'draft' | 'active' | 'archived';
  layout: BinderLayout;
  slots: BinderSlot[];
  shortages: Array<{ cardId: string; required: number; owned: number; missing: number }>;
}
export type ArrangementMode = 'set-number' | 'release-date' | 'pokedex-number' | 'language';

function toLayout(row: VersionRow): BinderLayout {
  if (row.layout_kind === 'custom') {
    return { kind: 'custom', rows: row.rows, columns: row.columns };
  }
  return { kind: row.layout_kind, rows: row.rows, columns: row.columns };
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

async function createPage(
  db: D1Database,
  versionId: string,
  position: number,
  layout: BinderLayout,
): Promise<string> {
  const pageId = newId('page');
  await db
    .prepare('INSERT INTO binder_pages (id, binder_version_id, position) VALUES (?1, ?2, ?3)')
    .bind(pageId, versionId, position)
    .run();
  const statements: D1PreparedStatement[] = [];
  for (let row = 0; row < layout.rows; row += 1) {
    for (let column = 0; column < layout.columns; column += 1) {
      statements.push(
        db
          .prepare(
            'INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id) VALUES (?1, ?2, ?3, NULL)',
          )
          .bind(pageId, row, column),
      );
    }
  }
  if (statements.length > 0) await db.batch(statements);
  return pageId;
}

export async function createBinder(
  db: D1Database,
  ownerId: string,
  name: string,
  layout: BinderLayout,
): Promise<BinderVersionView> {
  const now = nowSeconds();
  const binderId = newId('binder');
  const versionId = newId('binder_version');
  await db.batch([
    db
      .prepare(
        'INSERT INTO binders (id, owner_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
      )
      .bind(binderId, ownerId, name, now),
    db
      .prepare(
        'INSERT INTO binder_versions (id, binder_id, version_number, status, layout_kind, rows, columns, created_at) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7)',
      )
      .bind(versionId, binderId, 'draft', layout.kind, layout.rows, layout.columns, now),
  ]);
  await createPage(db, versionId, 0, layout);
  return getBinderVersion(db, ownerId, versionId);
}

export async function listBinders(db: D1Database, ownerId: string): Promise<BinderView[]> {
  const result = await db
    .prepare(
      `SELECT b.id, b.name, b.active_version_id, b.updated_at,
        (SELECT v.id FROM binder_versions v WHERE v.binder_id = b.id ORDER BY v.version_number DESC LIMIT 1) AS latest_version_id
       FROM binders b WHERE b.owner_id = ?1 ORDER BY b.updated_at DESC`,
    )
    .bind(ownerId)
    .all<BinderRow>();
  return result.results.map(toBinder);
}

export async function activeBinderShortages(
  db: D1Database,
  ownerId: string,
): Promise<Array<{ cardId: string; required: number; owned: number; missing: number }>> {
  const result = await db
    .prepare(
      `SELECT s.card_id, COUNT(*) AS required, COALESCE(c.quantity, 0) AS owned
       FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id
       JOIN binder_versions v ON v.id = p.binder_version_id
       JOIN binders b ON b.id = v.binder_id
       LEFT JOIN collection_cards c ON c.card_id = s.card_id AND c.owner_id = b.owner_id
       WHERE b.owner_id = ?1 AND v.status = 'active' AND s.card_id IS NOT NULL
       GROUP BY s.card_id HAVING COUNT(*) > COALESCE(c.quantity, 0)`,
    )
    .bind(ownerId)
    .all<{ card_id: string; required: number; owned: number }>();
  return result.results.map((row) => ({
    cardId: row.card_id,
    required: row.required,
    owned: row.owned,
    missing: row.required - row.owned,
  }));
}

export async function getBinderVersion(
  db: D1Database,
  ownerId: string,
  versionId: string,
): Promise<BinderVersionView> {
  const version = await db
    .prepare(
      `SELECT v.id, v.binder_id, v.version_number, v.status, v.layout_kind, v.rows, v.columns
       FROM binder_versions v JOIN binders b ON b.id = v.binder_id
       WHERE v.id = ?1 AND b.owner_id = ?2`,
    )
    .bind(versionId, ownerId)
    .first<VersionRow>();
  if (!version) throw new Error('binder_version_not_found');
  const slotRows = await db
    .prepare(
      `SELECT p.id AS page_id, s.row_index, s.column_index, s.card_id
       FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id
       WHERE p.binder_version_id = ?1 ORDER BY p.position, s.row_index, s.column_index`,
    )
    .bind(version.id)
    .all<{ page_id: string; row_index: number; column_index: number; card_id: string | null }>();
  const shortageRows = await db
    .prepare(
      `SELECT s.card_id, COUNT(*) AS required, COALESCE(c.quantity, 0) AS owned
       FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id
       LEFT JOIN collection_cards c ON c.card_id = s.card_id AND c.owner_id = ?2
       WHERE p.binder_version_id = ?1 AND s.card_id IS NOT NULL
       GROUP BY s.card_id
       HAVING COUNT(*) > COALESCE(c.quantity, 0)`,
    )
    .bind(version.id, ownerId)
    .all<{ card_id: string; required: number; owned: number }>();
  return {
    id: version.id,
    binderId: version.binder_id,
    versionNumber: version.version_number,
    status: version.status,
    layout: toLayout(version),
    slots: slotRows.results.map((slot) =>
      binderSlotSchema.parse({
        pageId: slot.page_id,
        row: slot.row_index,
        column: slot.column_index,
        cardId: slot.card_id,
      }),
    ),
    shortages: shortageRows.results.map((row) => ({
      cardId: row.card_id,
      required: row.required,
      owned: row.owned,
      missing: row.required - row.owned,
    })),
  };
}

export async function addBinderPage(
  db: D1Database,
  ownerId: string,
  versionId: string,
): Promise<BinderVersionView> {
  const version = await getBinderVersion(db, ownerId, versionId);
  if (version.status !== 'draft') throw new Error('binder_version_not_draft');
  const count = await db
    .prepare('SELECT COUNT(*) AS count FROM binder_pages WHERE binder_version_id = ?1')
    .bind(versionId)
    .first<{ count: number }>();
  await createPage(db, versionId, count?.count ?? 0, version.layout);
  return getBinderVersion(db, ownerId, versionId);
}

export async function deleteBinderPage(
  db: D1Database,
  ownerId: string,
  versionId: string,
  pageId: string,
): Promise<BinderVersionView> {
  const version = await getBinderVersion(db, ownerId, versionId);
  if (version.status !== 'draft') throw new Error('binder_version_not_draft');
  const page = await db
    .prepare('SELECT id FROM binder_pages WHERE id = ?1 AND binder_version_id = ?2')
    .bind(pageId, versionId)
    .first<{ id: string }>();
  if (!page) throw new Error('binder_page_not_found');
  const count = await db
    .prepare('SELECT COUNT(*) AS count FROM binder_pages WHERE binder_version_id = ?1')
    .bind(versionId)
    .first<{ count: number }>();
  if ((count?.count ?? 0) <= 1) throw new Error('binder_last_page');
  await db.prepare('DELETE FROM binder_pages WHERE id = ?1').bind(page.id).run();
  const pages = await db
    .prepare('SELECT id FROM binder_pages WHERE binder_version_id = ?1 ORDER BY position, id')
    .bind(versionId)
    .all<{ id: string }>();
  await db.batch(
    pages.results.map((item, position) =>
      db.prepare('UPDATE binder_pages SET position = ?1 WHERE id = ?2').bind(position, item.id),
    ),
  );
  return getBinderVersion(db, ownerId, versionId);
}

export async function reorderBinderPages(
  db: D1Database,
  ownerId: string,
  versionId: string,
  pageIds: string[],
): Promise<BinderVersionView> {
  const version = await getBinderVersion(db, ownerId, versionId);
  if (version.status !== 'draft') throw new Error('binder_version_not_draft');
  const pages = await db
    .prepare('SELECT id FROM binder_pages WHERE binder_version_id = ?1')
    .bind(versionId)
    .all<{ id: string }>();
  if (
    pages.results.length !== pageIds.length ||
    new Set(pageIds).size !== pageIds.length ||
    pages.results.some((page) => !pageIds.includes(page.id))
  )
    throw new Error('binder_page_order_invalid');
  await db.batch(
    pageIds.map((pageId, position) =>
      db.prepare('UPDATE binder_pages SET position = ?1 WHERE id = ?2').bind(position, pageId),
    ),
  );
  return getBinderVersion(db, ownerId, versionId);
}

export async function arrangeBinderVersion(
  db: D1Database,
  ownerId: string,
  versionId: string,
  mode: ArrangementMode,
): Promise<BinderVersionView> {
  const version = await getBinderVersion(db, ownerId, versionId);
  if (version.status !== 'draft') throw new Error('binder_version_not_draft');
  const slots = await db
    .prepare(
      `SELECT s.binder_page_id, s.row_index, s.column_index, s.card_id
      FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id
      WHERE p.binder_version_id = ?1 AND s.card_id IS NOT NULL ORDER BY p.position, s.row_index, s.column_index`,
    )
    .bind(versionId)
    .all<{ binder_page_id: string; row_index: number; column_index: number; card_id: string }>();
  if (slots.results.length === 0) return version;
  const ordering: Record<ArrangementMode, string> = {
    'set-number': 'set_name COLLATE NOCASE, number COLLATE NOCASE, name COLLATE NOCASE, id',
    'release-date':
      'release_date IS NULL, release_date, set_name COLLATE NOCASE, number COLLATE NOCASE, id',
    'pokedex-number': 'pokedex_number IS NULL, pokedex_number, name COLLATE NOCASE, id',
    language: 'language, set_name COLLATE NOCASE, number COLLATE NOCASE, id',
  };
  const cards = await db
    .prepare(
      `SELECT id FROM catalogue_cards WHERE id IN (${slots.results.map((_slot, index) => `?${index + 1}`).join(',')}) ORDER BY ${ordering[mode]}`,
    )
    .bind(...slots.results.map((slot) => slot.card_id))
    .all<{ id: string }>();
  if (cards.results.length !== slots.results.length)
    throw new Error('binder_arrangement_card_missing');
  await db.batch(
    slots.results.map((slot, index) => {
      const card = cards.results[index];
      if (!card) throw new Error('binder_arrangement_card_missing');
      return db
        .prepare(
          'UPDATE binder_slots SET card_id = ?1 WHERE binder_page_id = ?2 AND row_index = ?3 AND column_index = ?4',
        )
        .bind(card.id, slot.binder_page_id, slot.row_index, slot.column_index);
    }),
  );
  return getBinderVersion(db, ownerId, versionId);
}

export async function setBinderSlot(
  db: D1Database,
  ownerId: string,
  versionId: string,
  pagePosition: number,
  row: number,
  column: number,
  cardId: string | null,
): Promise<BinderVersionView> {
  const version = await getBinderVersion(db, ownerId, versionId);
  if (version.status !== 'draft') throw new Error('binder_version_not_draft');
  if (row >= version.layout.rows || column >= version.layout.columns)
    throw new Error('binder_slot_out_of_bounds');
  const page = await db
    .prepare('SELECT id FROM binder_pages WHERE binder_version_id = ?1 AND position = ?2')
    .bind(versionId, pagePosition)
    .first<{ id: string }>();
  if (!page) throw new Error('binder_page_not_found');
  if (cardId) {
    const card = await db
      .prepare('SELECT id FROM catalogue_cards WHERE id = ?1')
      .bind(cardId)
      .first();
    if (!card) throw new Error('card_not_found');
  }
  await db
    .prepare(
      'UPDATE binder_slots SET card_id = ?1 WHERE binder_page_id = ?2 AND row_index = ?3 AND column_index = ?4',
    )
    .bind(cardId, page.id, row, column)
    .run();
  await db
    .prepare('UPDATE binders SET updated_at = ?1 WHERE id = ?2')
    .bind(nowSeconds(), version.binderId)
    .run();
  return getBinderVersion(db, ownerId, versionId);
}

export async function cloneBinderVersion(
  db: D1Database,
  ownerId: string,
  sourceVersionId: string,
): Promise<BinderVersionView> {
  const source = await getBinderVersion(db, ownerId, sourceVersionId);
  const max = await db
    .prepare('SELECT MAX(version_number) AS max_version FROM binder_versions WHERE binder_id = ?1')
    .bind(source.binderId)
    .first<{ max_version: number | null }>();
  const newVersionId = newId('binder_version');
  const now = nowSeconds();
  await db
    .prepare(
      'INSERT INTO binder_versions (id, binder_id, version_number, status, layout_kind, rows, columns, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
    )
    .bind(
      newVersionId,
      source.binderId,
      (max?.max_version ?? 0) + 1,
      'draft',
      source.layout.kind,
      source.layout.rows,
      source.layout.columns,
      now,
    )
    .run();
  const pages = await db
    .prepare('SELECT id, position FROM binder_pages WHERE binder_version_id = ?1 ORDER BY position')
    .bind(sourceVersionId)
    .all<{ id: string; position: number }>();
  for (const page of pages.results) {
    const newPage = await createPage(db, newVersionId, page.position, source.layout);
    await db
      .prepare(
        `UPDATE binder_slots SET card_id = (
          SELECT old.card_id FROM binder_slots old WHERE old.binder_page_id = ?1
          AND old.row_index = binder_slots.row_index AND old.column_index = binder_slots.column_index)
         WHERE binder_page_id = ?2`,
      )
      .bind(page.id, newPage)
      .run();
  }
  await db
    .prepare('UPDATE binders SET updated_at = ?1 WHERE id = ?2')
    .bind(now, source.binderId)
    .run();
  return getBinderVersion(db, ownerId, newVersionId);
}

export async function activateBinderVersion(
  db: D1Database,
  ownerId: string,
  versionId: string,
): Promise<BinderVersionView> {
  const version = await getBinderVersion(db, ownerId, versionId);
  const now = nowSeconds();
  await db.batch([
    db
      .prepare(
        "UPDATE binder_versions SET status = 'archived' WHERE binder_id = ?1 AND status = 'active'",
      )
      .bind(version.binderId),
    db
      .prepare("UPDATE binder_versions SET status = 'active', activated_at = ?1 WHERE id = ?2")
      .bind(now, versionId),
    db
      .prepare('UPDATE binders SET active_version_id = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(versionId, now, version.binderId),
  ]);
  return getBinderVersion(db, ownerId, versionId);
}
