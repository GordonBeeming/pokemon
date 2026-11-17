import {
  NATIONAL_POKEDEX,
  binderActivityResultSchema,
  type BinderActivityQuery,
} from '@pokedex/shared';
import { newId, nowSeconds } from './db';
import { BinderDomainError } from './binders';
import { ApplicationError } from './log';

async function requireBinder(db: D1Database, ownerId: string, binderId: string) {
  if (
    !(await db
      .prepare('SELECT id FROM binders WHERE id = ? AND owner_id = ?')
      .bind(binderId, ownerId)
      .first())
  )
    throw new BinderDomainError('binder_not_found');
}

export async function createBinderCheckpoint(db: D1Database, ownerId: string, binderId: string) {
  await requireBinder(db, ownerId, binderId);
  const id = newId('checkpoint');
  await db
    .prepare(
      `INSERT INTO binder_checkpoints (id, binder_id, after_id, created_at)
    SELECT ?1, id, COALESCE((SELECT MAX(id) FROM binder_activity WHERE binder_id = ?2), 0), ?3
    FROM binders WHERE id = ?2 AND owner_id = ?4`,
    )
    .bind(id, binderId, nowSeconds(), ownerId)
    .run();
  return id;
}

export async function getBinderActivity(
  db: D1Database,
  ownerId: string,
  binderId: string,
  query: BinderActivityQuery,
) {
  await requireBinder(db, ownerId, binderId);
  const checkpoints = await db
    .prepare(
      `SELECT cp.id, cp.after_id, cp.created_at,
    (SELECT COUNT(*) FROM binder_activity e WHERE e.binder_id = cp.binder_id AND e.id > cp.after_id) AS newer
    FROM binder_checkpoints cp WHERE cp.binder_id = ?
    ORDER BY cp.after_id DESC, cp.created_at DESC, cp.rowid DESC`,
    )
    .bind(binderId)
    .all<{ id: string; after_id: number; created_at: number; newer: number }>();
  const count = await db
    .prepare('SELECT COUNT(*) AS total FROM binder_activity WHERE binder_id = ?')
    .bind(binderId)
    .first<{ total: number }>();
  const boundaries = [
    ...checkpoints.results.map((c) => ({
      id: c.id,
      afterId: c.after_id,
      createdAt: c.created_at,
      newer: c.newer,
    })),
    { id: 'beginning', afterId: 0, createdAt: null, newer: count?.total ?? 0 },
  ];
  const batches = boundaries.map((b, index) => ({
    id: b.id,
    createdAt: b.createdAt,
    count: b.newer - (boundaries[index - 1]?.newer ?? 0),
  }));
  const selectedBatch =
    query.batch ?? batches.find((b) => b.count > 0)?.id ?? batches[0]?.id ?? 'beginning';
  const index = boundaries.findIndex((b) => b.id === selectedBatch);
  const boundary = boundaries[index];
  if (!boundary) throw new ApplicationError('invalid_filter', 400);
  const clauses = ['e.binder_id = ?', 'e.id > ?'];
  const values: (string | number)[] = [binderId, boundary.afterId];
  const previous = boundaries[index - 1];
  if (previous) {
    clauses.push('e.id <= ?');
    values.push(previous.afterId);
  }
  if (query.kind !== 'all') {
    clauses.push('e.kind = ?');
    values.push(query.kind);
  }
  if (query.q) {
    clauses.push(
      "instr(lower(COALESCE(c.name, e.card_id) || ' ' || COALESCE(c.set_name, '') || ' ' || COALESCE(c.number, '')), lower(?)) > 0",
    );
    values.push(query.q);
  }
  if (query.regions.length) {
    const numbers = NATIONAL_POKEDEX.filter((p) => query.regions.includes(p.discoveryCategory)).map(
      (p) => p.number,
    );
    clauses.push("c.category = 'pokemon' AND c.pokedex_number IN (SELECT value FROM json_each(?))");
    values.push(JSON.stringify(numbers));
  }
  const from = `FROM binder_activity e LEFT JOIN catalogue_cards c ON c.id = e.card_id AND (c.owner_id IS NULL OR c.owner_id = (SELECT owner_id FROM binders WHERE id = e.binder_id)) WHERE ${clauses.join(' AND ')}`;
  const total = await db
    .prepare(`SELECT COUNT(*) AS total ${from}`)
    .bind(...values)
    .first<{ total: number }>();
  const order = {
    newest: 'e.id DESC',
    oldest: 'e.id ASC',
    binder: 'e.version_number DESC, e.page, e.row_index, e.column_index, e.id DESC',
    pokedex: 'c.pokedex_number IS NULL, c.pokedex_number, e.id DESC',
  }[query.sort];
  const events = await db
    .prepare(
      `SELECT e.id, e.kind, e.created_at AS createdAt, e.version_id AS versionId,
    e.version_number AS versionNumber, e.page, e.row_index AS row, e.column_index AS column,
    e.card_id AS cardId, COALESCE(c.name, e.card_id) AS name, COALESCE(c.set_name, '') AS setName,
    COALESCE(c.number, '') AS number, COALESCE(c.language, '') AS language, c.pokedex_number AS pokedexNumber,
    CASE WHEN EXISTS(SELECT 1 FROM art_manifest a WHERE a.card_id = e.card_id AND a.variant = 'low')
      OR EXISTS(SELECT 1 FROM card_sources s WHERE s.card_id = e.card_id AND s.provider = 'tcgdex') THEN 1 ELSE 0 END AS hasArt
    ${from} ORDER BY ${order} LIMIT 500`,
    )
    .bind(...values)
    .all<{
      id: number;
      kind: string;
      createdAt: number;
      versionId: string;
      versionNumber: number;
      page: number;
      row: number;
      column: number;
      cardId: string;
      name: string;
      setName: string;
      number: string;
      language: string;
      pokedexNumber: number | null;
      hasArt: number;
    }>();
  return binderActivityResultSchema.parse({
    selectedBatch,
    batches,
    total: total?.total ?? 0,
    events: events.results.map(({ hasArt, ...e }) => ({
      ...e,
      region: NATIONAL_POKEDEX.find((p) => p.number === e.pokedexNumber)?.discoveryCategory ?? null,
      imageLowUrl: hasArt ? `/api/art/${encodeURIComponent(e.cardId)}/low` : null,
    })),
  });
}

export function activitySnapshot(db: D1Database, versionId: string, mutationId: string) {
  return db
    .prepare(
      `INSERT INTO binder_activity_snapshot (mutation_id, card_id, page, row_index, column_index)
    SELECT ?1, s.assigned_card_id, p.position, s.row_index, s.column_index FROM binder_slots s
    JOIN binder_pages p ON p.id = s.binder_page_id
    WHERE p.binder_version_id = ?2 AND s.assigned_card_id IS NOT NULL`,
    )
    .bind(mutationId, versionId);
}

export function activityChanges(db: D1Database, versionId: string, mutationId: string) {
  // Compare the final layout so intermediate reflow writes never become activity.
  return [
    db
      .prepare(
        `WITH current AS (
    SELECT s.assigned_card_id AS card_id, p.position AS page, s.row_index, s.column_index
    FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id
    WHERE p.binder_version_id = ?2 AND s.assigned_card_id IS NOT NULL
  ), changes AS (
    SELECT 'removed' AS kind, old.card_id, old.page, old.row_index, old.column_index
    FROM binder_activity_snapshot old WHERE mutation_id = ?1 AND NOT EXISTS (
      SELECT 1 FROM current c WHERE c.card_id = old.card_id AND c.page = old.page
      AND c.row_index = old.row_index AND c.column_index = old.column_index)
    UNION ALL
    SELECT 'added', c.card_id, c.page, c.row_index, c.column_index FROM current c WHERE NOT EXISTS (
      SELECT 1 FROM binder_activity_snapshot old WHERE mutation_id = ?1 AND old.card_id = c.card_id
      AND old.page = c.page AND old.row_index = c.row_index AND old.column_index = c.column_index)
  ) INSERT INTO binder_activity (binder_id, version_id, version_number, kind, card_id, page, row_index, column_index, created_at)
    SELECT v.binder_id, v.id, v.version_number, c.kind, c.card_id, c.page, c.row_index, c.column_index, ?3
    FROM changes c JOIN binder_versions v ON v.id = ?2
    ORDER BY c.kind DESC, c.page, c.row_index, c.column_index`,
      )
      .bind(mutationId, versionId, nowSeconds()),
    db.prepare('DELETE FROM binder_activity_snapshot WHERE mutation_id = ?').bind(mutationId),
  ];
}
