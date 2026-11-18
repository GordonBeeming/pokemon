import {
  binderActivityResultSchema,
  type BinderActivityQuery,
  type CatalogueCardView,
} from '@pokedex/shared';
import { newId, nowSeconds } from './db';
import { BinderDomainError } from './binders';
import { ApplicationError } from './log';
import { resolveCatalogueCards } from './catalogue';

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
  // The predicate and insert share one statement, so retries and simultaneous clicks
  // cannot create two boundaries for the same set of changes.
  const inserted = await db
    .prepare(
      `INSERT INTO binder_checkpoints(id,binder_id,after_id,created_at)
    SELECT ?1,b.id,(SELECT MAX(e.id) FROM binder_activity e WHERE e.binder_id=b.id),?3
    FROM binders b WHERE b.id=?2 AND b.owner_id=?4
    AND COALESCE((SELECT MAX(e.id) FROM binder_activity e WHERE e.binder_id=b.id),0)
      > COALESCE((SELECT MAX(cp.after_id) FROM binder_checkpoints cp WHERE cp.binder_id=b.id),0)
    RETURNING id`,
    )
    .bind(id, binderId, nowSeconds(), ownerId)
    .first<{ id: string }>();
  if (inserted) return { checkpointId: inserted.id, created: true };
  const latest = await db
    .prepare(
      'SELECT id FROM binder_checkpoints WHERE binder_id=? ORDER BY after_id DESC,created_at DESC,rowid DESC LIMIT 1',
    )
    .bind(binderId)
    .first<{ id: string }>();
  return { checkpointId: latest?.id ?? null, created: false };
}

const sectionSql = `WITH binder_context AS MATERIALIZED (
 SELECT b.id,COALESCE(b.active_version_id,(SELECT v.id FROM binder_versions v WHERE v.binder_id=b.id ORDER BY v.version_number DESC LIMIT 1)) AS fallback_version
 FROM binders b WHERE b.id=?1 AND b.owner_id=?2
), marks AS MATERIALIZED (
 SELECT v.id AS version_id,bm.name,p.position*400+bm.row_index*20+bm.column_index AS start
 FROM binder_bookmarks bm JOIN binder_pages p ON p.id=bm.binder_page_id
 JOIN binder_versions v ON v.id=p.binder_version_id JOIN binders b ON b.id=v.binder_id
 WHERE b.id=?1 AND b.owner_id=?2
 UNION
 SELECT v.id,COALESCE(p.label,'Reserved page '||(p.position+1)),p.position*400
 FROM binder_pages p JOIN binder_versions v ON v.id=p.binder_version_id JOIN binders b ON b.id=v.binder_id
 WHERE b.id=?1 AND b.owner_id=?2 AND (p.kind='reserved' OR p.label IS NOT NULL)
), coordinates AS (SELECT DISTINCT version_id,start FROM marks), ranges AS (
 SELECT version_id,start,LEAD(start) OVER(PARTITION BY version_id ORDER BY start) AS end FROM coordinates
), sections AS MATERIALIZED (
 SELECT m.version_id,m.name,r.start,r.end FROM marks m JOIN ranges r ON r.version_id=m.version_id AND r.start=m.start
), activity AS (
 SELECT e.*,COALESCE(v.id,b.fallback_version) AS section_version_id
 FROM binder_activity e JOIN binder_context b ON b.id=e.binder_id
 LEFT JOIN binder_versions v ON v.id=e.version_id AND v.binder_id=e.binder_id
)`;
const sectionMatch = `s.version_id=e.section_version_id AND e.page*400+e.row_index*20+e.column_index>=s.start
 AND (s.end IS NULL OR e.page*400+e.row_index*20+e.column_index<s.end)`;

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
    ORDER BY cp.after_id DESC, cp.created_at ASC, cp.rowid ASC`,
    )
    .bind(binderId)
    .all<{ id: string; after_id: number; created_at: number; newer: number }>();
  const count = await db
    .prepare('SELECT COUNT(*) AS total FROM binder_activity WHERE binder_id = ?')
    .bind(binderId)
    .first<{ total: number }>();
  const seen = new Set<number>();
  const distinctCheckpoints = checkpoints.results.filter((cp) => {
    if (cp.after_id === 0 || seen.has(cp.after_id)) return false;
    seen.add(cp.after_id);
    return true;
  });
  const boundaries = [
    ...distinctCheckpoints.map((c) => ({
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
  const requested = checkpoints.results.find((cp) => cp.id === query.batch);
  const requestedBatch = requested
    ? boundaries.find((b) => b.afterId === requested.after_id)?.id
    : query.batch;
  const selectedBatch =
    requestedBatch ?? batches.find((b) => b.count > 0)?.id ?? batches[0]?.id ?? 'beginning';
  const index = boundaries.findIndex((b) => b.id === selectedBatch);
  const boundary = boundaries[index];
  if (!boundary) throw new ApplicationError('invalid_filter', 400);
  const clauses = ['e.binder_id = ?1', 'e.id > ?3'];
  const values: (string | number)[] = [binderId, ownerId, boundary.afterId];
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
  if (query.sections.length) {
    const names = query.sections
      .filter((id) => id !== 'unbookmarked')
      .map((id) => (id.startsWith('bookmark:') ? id.slice(9) : id));
    const filters: string[] = [];
    if (names.length) {
      filters.push(
        `EXISTS(SELECT 1 FROM sections s WHERE ${sectionMatch} AND s.name IN (SELECT value FROM json_each(?)))`,
      );
      values.push(JSON.stringify(names));
    }
    if (query.sections.includes('unbookmarked'))
      filters.push(`NOT EXISTS(SELECT 1 FROM sections s WHERE ${sectionMatch})`);
    clauses.push(`(${filters.join(' OR ')})`);
  }
  const sectionNames = await db
    .prepare(`${sectionSql} SELECT name FROM sections GROUP BY name ORDER BY MIN(start),name`)
    .bind(binderId, ownerId)
    .all<{ name: string }>();
  const unbookmarked = await db
    .prepare(
      `${sectionSql} SELECT 1 AS found FROM activity e WHERE e.binder_id=?1 AND e.id>?3 AND e.id<=?4 AND NOT EXISTS(SELECT 1 FROM sections s WHERE ${sectionMatch}) LIMIT 1`,
    )
    .bind(binderId, ownerId, boundary.afterId, previous?.afterId ?? Number.MAX_SAFE_INTEGER)
    .first<{ found: number }>();
  const from = `FROM activity e LEFT JOIN catalogue_cards c ON c.id = e.card_id AND (c.owner_id IS NULL OR c.owner_id = (SELECT owner_id FROM binders WHERE id = e.binder_id)) WHERE ${clauses.join(' AND ')}`;
  const total = await db
    .prepare(`${sectionSql} SELECT COUNT(*) AS total ${from}`)
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
      `${sectionSql} SELECT e.id, e.kind, e.created_at AS createdAt, e.version_id AS versionId,
    e.version_number AS versionNumber, e.page, e.row_index AS row, e.column_index AS column,
    e.card_id AS cardId, COALESCE(c.name, e.card_id) AS name, COALESCE(c.set_name, '') AS setName,
    COALESCE(c.number, '') AS number, COALESCE(c.language, '') AS language, c.pokedex_number AS pokedexNumber,
    (SELECT GROUP_CONCAT(s.name, ' / ') FROM sections s WHERE ${sectionMatch}) AS sectionName,
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
      sectionName: string | null;
    }>();
  const cardIds = [...new Set(events.results.map((event) => event.cardId))];
  const cards = new Map<string, CatalogueCardView>();
  // Catalogue resolution is bounded to 200 IDs; activity can contain 500 events.
  for (let start = 0; start < cardIds.length; start += 200) {
    for (const card of await resolveCatalogueCards(
      db,
      ownerId,
      cardIds.slice(start, start + 200),
      true,
    ))
      cards.set(card.id, card);
  }
  return binderActivityResultSchema.parse({
    selectedBatch,
    pendingChanges: boundaries[0]?.newer ?? 0,
    sections: [
      ...sectionNames.results.map((s) => ({ id: `bookmark:${s.name}`, name: s.name })),
      ...(unbookmarked ? [{ id: 'unbookmarked', name: 'Unbookmarked' }] : []),
    ],
    batches,
    total: total?.total ?? 0,
    events: events.results.map(({ hasArt, ...e }) => ({
      ...e,
      card: cards.get(e.cardId) ?? null,
      region: null,
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
