import { z } from 'zod';
import { newId, nowSeconds } from './db';
import { ApplicationError } from './log';

const LEGACY_BACKUP_VERSION = 2 as const;
const BACKUP_VERSION = 3 as const;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_CHUNK_BYTES = 1_500_000;
const MAX_BACKUP_MANIFEST_BYTES = 1_000_000;
const MAX_LEGACY_BACKUP_BYTES = 2_000_000;
const BACKUP_QUERY_ROWS = 250;
const BACKUP_RETENTION_COUNT = 10;
const RESTORE_CHUNK_ROWS = 250;

const catalogueRow = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    language: z.string(),
    category: z.string(),
    set_id: z.string(),
    set_name: z.string(),
    number: z.string(),
    supertype: z.string().nullable(),
    subtype: z.string().nullable(),
    species: z.string().nullable(),
    rarity: z.string().nullable(),
    artist: z.string().nullable(),
    release_date: z.string().nullable(),
    pokedex_number: z.number().int().nullable(),
    number_sort: z.number().int().nullable(),
    is_custom: z.number().int(),
    is_active: z.number().int(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict();
const sourceRow = z
  .object({
    provider: z.string(),
    source_id: z.string(),
    card_id: z.string(),
    language: z.string(),
    source_updated_at: z.number().int(),
    checksum: z.string(),
    active: z.number().int(),
    imported_at: z.number().int(),
  })
  .strict();
const collectionRow = z
  .object({
    card_id: z.string(),
    quantity: z.number().int().min(0).max(9999),
    notes: z.string().nullable(),
    revision: z.number().int().positive(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();
const speciesRepresentativeRow = z
  .object({
    pokedex_number: z.number().int().min(1).max(1025),
    card_id: z.string().min(1),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();
const binderRow = z
  .object({
    id: z.string(),
    owner_id: z.string(),
    name: z.string().min(1).max(120),
    active_version_id: z.string().nullable(),
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();
const versionRow = z
  .object({
    id: z.string(),
    binder_id: z.string(),
    version_number: z.number().int().positive(),
    status: z.enum(['draft', 'active', 'archived']),
    layout_kind: z.enum(['2x2', '3x3', '4x3', 'top-loader', 'custom']),
    rows: z.number().int().min(1).max(20),
    columns: z.number().int().min(1).max(20),
    created_at: z.number().int().nonnegative(),
    activated_at: z.number().int().nonnegative().nullable(),
    revision: z.number().int().positive(),
  })
  .strict();
const pageRow = z
  .object({
    id: z.string(),
    binder_version_id: z.string(),
    position: z.number().int().nonnegative(),
  })
  .strict();
const slotRow = z
  .object({
    binder_page_id: z.string(),
    row_index: z.number().int().nonnegative(),
    column_index: z.number().int().nonnegative(),
    card_id: z.string().nullable(),
  })
  .strict();
const artRow = z
  .object({
    card_id: z.string(),
    variant: z.enum(['high', 'low']),
    object_key: z.string(),
    backup_object_key: z.string().nullable(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().positive(),
    version: z.number().int().positive(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();

const backupBundleSchema = z
  .object({
    version: z.literal(LEGACY_BACKUP_VERSION),
    ownerId: z.string().min(1),
    mutationEpoch: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    catalogue: z.array(catalogueRow),
    sources: z.array(sourceRow),
    collection: z.array(collectionRow),
    binders: z.array(binderRow),
    versions: z.array(versionRow),
    pages: z.array(pageRow),
    slots: z.array(slotRow),
    artManifest: z.array(artRow),
  })
  .strict();

export type BackupBundle = z.infer<typeof backupBundleSchema>;

const backupKindSchema = z.enum([
  'catalogue',
  'sources',
  'collection',
  'species_representatives',
  'binders',
  'versions',
  'pages',
  'slots',
  'art_manifest',
]);
type BackupKind = z.infer<typeof backupKindSchema>;

const backupChunkSchema = z
  .object({
    kind: backupKindSchema,
    index: z.number().int().nonnegative(),
    objectKey: z.string().min(1),
    checksum: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().positive().max(MAX_BACKUP_CHUNK_BYTES),
    rows: z.number().int().nonnegative().max(BACKUP_QUERY_ROWS),
  })
  .strict();

const backupManifestSchema = z
  .object({
    version: z.literal(BACKUP_VERSION),
    ownerId: z.string().min(1),
    mutationEpoch: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    chunks: z.array(backupChunkSchema).max(100_000),
  })
  .strict();
type BackupManifest = z.infer<typeof backupManifestSchema>;

interface BackupPageResult {
  cursor: number;
  rowCount: number;
  bytes: number;
  chunks: BackupManifest['chunks'];
}

export type BackupPageRunner = (
  name: string,
  action: () => Promise<BackupPageResult>,
) => Promise<BackupPageResult>;

export interface CreateBackupOptions {
  backupId?: string;
  runPage?: BackupPageRunner;
}

export type RestoreStepRunner = (name: string, action: () => Promise<null>) => Promise<null>;

export interface RestoreBackupOptions {
  restoreRunId?: string;
  runStep?: RestoreStepRunner;
}

const backupRowSchemas = {
  catalogue: catalogueRow,
  sources: sourceRow,
  collection: collectionRow,
  species_representatives: speciesRepresentativeRow,
  binders: binderRow,
  versions: versionRow,
  pages: pageRow,
  slots: slotRow,
  art_manifest: artRow,
} as const satisfies Record<BackupKind, z.ZodType>;

interface BackupQuery {
  kind: BackupKind;
  sql: string;
}

const backupQueries: readonly BackupQuery[] = [
  {
    kind: 'catalogue',
    sql: `SELECT c.rowid AS backup_cursor, c.id, c.name, c.language, c.category, c.set_id,
      c.set_name, c.number, c.supertype, c.subtype, c.species, c.rarity, c.artist,
      c.release_date, c.pokedex_number, c.number_sort, c.is_custom, c.is_active,
      c.created_at, c.updated_at
     FROM catalogue_cards c WHERE c.rowid > ?2 AND (c.is_custom = 1
       OR EXISTS (SELECT 1 FROM collection_cards cc WHERE cc.owner_id = ?1 AND cc.card_id = c.id)
       OR EXISTS (SELECT 1 FROM species_representatives representative
         WHERE representative.owner_id = ?1 AND representative.card_id = c.id)
       OR EXISTS (SELECT 1 FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id
         JOIN binder_versions v ON v.id = p.binder_version_id JOIN binders b ON b.id = v.binder_id
         WHERE b.owner_id = ?1 AND s.card_id = c.id))
     ORDER BY c.rowid LIMIT ?3`,
  },
  {
    kind: 'sources',
    sql: `SELECT s.rowid AS backup_cursor, s.provider, s.source_id, s.card_id, s.language,
      s.source_updated_at, s.checksum, s.active, s.imported_at
     FROM card_sources s WHERE s.rowid > ?2 AND EXISTS (
       SELECT 1 FROM catalogue_cards c WHERE c.id = s.card_id AND (c.is_custom = 1
         OR EXISTS (SELECT 1 FROM collection_cards cc WHERE cc.owner_id = ?1 AND cc.card_id = c.id)
         OR EXISTS (SELECT 1 FROM species_representatives representative
           WHERE representative.owner_id = ?1 AND representative.card_id = c.id)
         OR EXISTS (SELECT 1 FROM binder_slots bs JOIN binder_pages p ON p.id = bs.binder_page_id
           JOIN binder_versions v ON v.id = p.binder_version_id JOIN binders b ON b.id = v.binder_id
           WHERE b.owner_id = ?1 AND bs.card_id = c.id)))
     ORDER BY s.rowid LIMIT ?3`,
  },
  {
    kind: 'collection',
    sql: `SELECT cc.rowid AS backup_cursor, cc.card_id, cc.quantity, cc.notes, cc.revision,
      cc.updated_at FROM collection_cards cc
     WHERE cc.owner_id = ?1 AND cc.rowid > ?2 ORDER BY cc.rowid LIMIT ?3`,
  },
  {
    kind: 'species_representatives',
    sql: `SELECT representative.rowid AS backup_cursor, representative.pokedex_number,
      representative.card_id, representative.updated_at
     FROM species_representatives representative
     WHERE representative.owner_id = ?1 AND representative.rowid > ?2
     ORDER BY representative.rowid LIMIT ?3`,
  },
  {
    kind: 'binders',
    sql: `SELECT b.rowid AS backup_cursor, b.id, b.owner_id, b.name, b.active_version_id,
      b.created_at, b.updated_at FROM binders b
     WHERE b.owner_id = ?1 AND b.rowid > ?2 ORDER BY b.rowid LIMIT ?3`,
  },
  {
    kind: 'versions',
    sql: `SELECT v.rowid AS backup_cursor, v.id, v.binder_id, v.version_number, v.status,
      v.layout_kind, v.rows, v.columns, v.created_at, v.activated_at, v.revision
     FROM binder_versions v JOIN binders b ON b.id = v.binder_id
     WHERE b.owner_id = ?1 AND v.rowid > ?2 ORDER BY v.rowid LIMIT ?3`,
  },
  {
    kind: 'pages',
    sql: `SELECT p.rowid AS backup_cursor, p.id, p.binder_version_id, p.position
     FROM binder_pages p JOIN binder_versions v ON v.id = p.binder_version_id
     JOIN binders b ON b.id = v.binder_id
     WHERE b.owner_id = ?1 AND p.rowid > ?2 ORDER BY p.rowid LIMIT ?3`,
  },
  {
    kind: 'slots',
    sql: `SELECT s.rowid AS backup_cursor, s.binder_page_id, s.row_index, s.column_index, s.card_id
     FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id
     JOIN binder_versions v ON v.id = p.binder_version_id JOIN binders b ON b.id = v.binder_id
     WHERE b.owner_id = ?1 AND s.rowid > ?2 ORDER BY s.rowid LIMIT ?3`,
  },
  {
    kind: 'art_manifest',
    sql: `SELECT m.rowid AS backup_cursor, m.card_id, m.variant, m.object_key, NULL AS backup_object_key,
      m.sha256, m.bytes, m.version, m.updated_at, c.is_custom AS backup_is_custom
     FROM art_manifest m JOIN catalogue_cards c ON c.id = m.card_id
     WHERE m.rowid > ?2 AND (c.is_custom = 1
       OR EXISTS (SELECT 1 FROM collection_cards cc WHERE cc.owner_id = ?1 AND cc.card_id = c.id)
       OR EXISTS (SELECT 1 FROM species_representatives representative
         WHERE representative.owner_id = ?1 AND representative.card_id = c.id)
       OR EXISTS (SELECT 1 FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id
         JOIN binder_versions v ON v.id = p.binder_version_id JOIN binders b ON b.id = v.binder_id
         WHERE b.owner_id = ?1 AND s.card_id = c.id))
     ORDER BY m.rowid LIMIT ?3`,
  },
];

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashText(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

interface BackupRawRow {
  backup_cursor: number;
  backup_is_custom?: number;
  [key: string]: unknown;
}

async function deleteBackupPrefix(art: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await art.list({ prefix, cursor, limit: 1_000 });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) await art.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function pruneBackups(db: D1Database, art: R2Bucket, ownerId: string): Promise<void> {
  while (true) {
    const expired = await db
      .prepare(
        `SELECT id FROM backup_runs WHERE owner_id = ?1 AND checksum <> 'pending'
         ORDER BY created_at DESC, id DESC LIMIT 25 OFFSET ?2`,
      )
      .bind(ownerId, BACKUP_RETENTION_COUNT)
      .all<{ id: string }>();
    if (expired.results.length === 0) return;
    for (const run of expired.results) {
      await deleteBackupPrefix(art, `backups/${ownerId}/${run.id}/`);
      await db
        .prepare('DELETE FROM backup_runs WHERE id = ?1 AND owner_id = ?2')
        .bind(run.id, ownerId)
        .run();
    }
  }
}

async function writeBackupRows(
  art: R2Bucket,
  ownerId: string,
  backupId: string,
  kind: BackupKind,
  rows: unknown[],
  chunks: BackupManifest['chunks'],
  indexBase = 0,
): Promise<number> {
  const payload = JSON.stringify(rows);
  const bytes = new TextEncoder().encode(payload).byteLength;
  if (bytes > MAX_BACKUP_CHUNK_BYTES && rows.length > 1) {
    const midpoint = Math.ceil(rows.length / 2);
    return (
      (await writeBackupRows(
        art,
        ownerId,
        backupId,
        kind,
        rows.slice(0, midpoint),
        chunks,
        indexBase,
      )) +
      (await writeBackupRows(art, ownerId, backupId, kind, rows.slice(midpoint), chunks, indexBase))
    );
  }
  if (bytes > MAX_BACKUP_CHUNK_BYTES) throw new ApplicationError('backup_row_too_large', 413);
  const index = indexBase + chunks.filter((chunk) => chunk.kind === kind).length;
  const objectKey = `backups/${ownerId}/${backupId}/chunks/${kind}/${index}.json`;
  const checksum = await hashText(payload);
  await art.put(objectKey, payload, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { ownerId, backupId, kind, checksum },
    sha256: checksum,
  });
  chunks.push({ kind, index, objectKey, checksum, bytes, rows: rows.length });
  return bytes;
}

async function backupArtRows(
  art: R2Bucket,
  ownerId: string,
  backupId: string,
  rawRows: BackupRawRow[],
): Promise<BackupBundle['artManifest']> {
  const rows: BackupBundle['artManifest'] = [];
  for (const raw of rawRows) {
    const { backup_cursor: _cursor, backup_is_custom: isCustom, ...value } = raw;
    void _cursor;
    const row = artRow.parse(value);
    let backupObjectKey: string | null = null;
    if (isCustom === 1) {
      const object = await art.get(row.object_key);
      if (!object) throw new ApplicationError('backup_custom_art_missing', 500);
      backupObjectKey = `backups/${ownerId}/${backupId}/art/${encodeURIComponent(row.card_id)}/${row.variant}.webp`;
      await art.put(backupObjectKey, object.body, {
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
        sha256: row.sha256,
      });
    }
    rows.push({ ...row, backup_object_key: backupObjectKey });
  }
  return rows;
}

function parseBackupRows(kind: Exclude<BackupKind, 'art_manifest'>, rows: unknown[]): unknown[] {
  return z.array(backupRowSchemas[kind]).parse(rows);
}

export async function createBackup(
  db: D1Database,
  art: R2Bucket,
  ownerId: string,
  options: CreateBackupOptions | BackupPageRunner = {},
): Promise<{ id: string; checksum: string }> {
  const configured = typeof options === 'function' ? { runPage: options } : options;
  const runPage = configured.runPage ?? ((_name, action) => action());
  const id = configured.backupId ?? newId('backup');
  if (!/^backup_[A-Za-z0-9_-]+$/u.test(id)) throw new ApplicationError('backup_id_invalid', 400);
  const objectKey = `backups/${ownerId}/${id}/manifest.json`;
  let run = await db
    .prepare('SELECT owner_id, object_key, checksum, backup_epoch FROM backup_runs WHERE id = ?1')
    .bind(id)
    .first<{ owner_id: string; object_key: string; checksum: string; backup_epoch: number }>();
  if (run && (run.owner_id !== ownerId || run.object_key !== objectKey))
    throw new ApplicationError('backup_run_conflict', 409);
  if (run?.checksum !== undefined && run.checksum !== 'pending') {
    if (!/^[a-f0-9]{64}$/u.test(run.checksum))
      throw new ApplicationError('backup_run_conflict', 409);
    return { id, checksum: run.checksum };
  }
  const owner = await db
    .prepare('SELECT backup_epoch FROM users WHERE id = ?1')
    .bind(ownerId)
    .first<{ backup_epoch: number }>();
  if (!owner) throw new ApplicationError('backup_owner_not_found', 404);
  if (!run)
    await db
      .prepare(
        `INSERT INTO backup_runs
          (id, owner_id, object_key, checksum, backup_epoch, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id) DO NOTHING`,
      )
      .bind(id, ownerId, objectKey, 'pending', owner.backup_epoch, nowSeconds())
      .run();
  run = await db
    .prepare('SELECT owner_id, object_key, checksum, backup_epoch FROM backup_runs WHERE id = ?1')
    .bind(id)
    .first<{ owner_id: string; object_key: string; checksum: string; backup_epoch: number }>();
  if (!run || run.owner_id !== ownerId || run.object_key !== objectKey)
    throw new ApplicationError('backup_run_conflict', 409);
  if (run.checksum !== 'pending') {
    if (!/^[a-f0-9]{64}$/u.test(run.checksum))
      throw new ApplicationError('backup_run_conflict', 409);
    return { id, checksum: run.checksum };
  }
  if (run.backup_epoch !== owner.backup_epoch)
    throw new ApplicationError('backup_changed_during_creation', 409);
  const chunks: BackupManifest['chunks'] = [];
  let totalBytes = 0;
  for (const query of backupQueries) {
    let cursor = 0;
    let page = 0;
    while (true) {
      const pageCursor = cursor;
      const result = await runPage(`backup-${query.kind}-${page}`, async () => {
        const selected = await db
          .prepare(query.sql)
          .bind(ownerId, pageCursor, BACKUP_QUERY_ROWS)
          .all<BackupRawRow>();
        if (selected.results.length === 0)
          return { cursor: pageCursor, rowCount: 0, bytes: 0, chunks: [] };
        const last = selected.results.at(-1);
        if (!last || !Number.isInteger(last.backup_cursor) || last.backup_cursor <= pageCursor)
          throw new ApplicationError('backup_cursor_invalid', 500);
        const rows =
          query.kind === 'art_manifest'
            ? await backupArtRows(art, ownerId, id, selected.results)
            : parseBackupRows(
                query.kind,
                selected.results.map(({ backup_cursor: ignored, ...row }) => {
                  void ignored;
                  return row;
                }),
              );
        const pageChunks: BackupManifest['chunks'] = [];
        const bytes = await writeBackupRows(
          art,
          ownerId,
          id,
          query.kind,
          rows,
          pageChunks,
          page * BACKUP_QUERY_ROWS,
        );
        return {
          cursor: last.backup_cursor,
          rowCount: selected.results.length,
          bytes,
          chunks: pageChunks,
        };
      });
      if (result.rowCount === 0) break;
      cursor = result.cursor;
      chunks.push(...result.chunks);
      totalBytes += result.bytes;
      if (totalBytes > MAX_BACKUP_BYTES) throw new ApplicationError('backup_too_large', 413);
      if (result.rowCount < BACKUP_QUERY_ROWS) break;
      page += 1;
    }
  }
  const currentOwner = await db
    .prepare('SELECT backup_epoch FROM users WHERE id = ?1')
    .bind(ownerId)
    .first<{ backup_epoch: number }>();
  if (!currentOwner || currentOwner.backup_epoch !== run.backup_epoch)
    throw new ApplicationError('backup_changed_during_creation', 409);
  if (chunks.some((chunk) => !chunk.objectKey.startsWith(`backups/${ownerId}/${id}/chunks/`)))
    throw new ApplicationError('backup_chunk_owner_mismatch', 500);
  for (let offset = 0; offset < chunks.length; offset += 100) {
    const page = Math.floor(offset / 100);
    const expected = chunks.slice(offset, offset + 100);
    await runPage(`verify-backup-chunks-${page}`, async () => {
      const objects = await Promise.all(expected.map((chunk) => art.head(chunk.objectKey)));
      if (
        objects.some(
          (object, index) =>
            !object ||
            object.size !== expected[index]?.bytes ||
            object.customMetadata?.checksum !== expected[index]?.checksum,
        )
      )
        throw new ApplicationError('backup_chunk_missing', 500);
      return { cursor: 0, rowCount: 0, bytes: 0, chunks: [] };
    });
  }
  const manifest: BackupManifest = {
    version: BACKUP_VERSION,
    ownerId,
    mutationEpoch: run.backup_epoch,
    createdAt: new Date().toISOString(),
    chunks,
  };
  const payload = JSON.stringify(manifest);
  if (new TextEncoder().encode(payload).byteLength > MAX_BACKUP_MANIFEST_BYTES)
    throw new ApplicationError('backup_too_large', 413);
  const checksum = await hashText(payload);
  await art.put(objectKey, payload, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { ownerId, checksum, version: String(BACKUP_VERSION) },
    sha256: checksum,
  });
  await db
    .prepare('UPDATE backup_runs SET checksum = ?1 WHERE id = ?2 AND owner_id = ?3')
    .bind(checksum, id, ownerId)
    .run();
  await pruneBackups(db, art, ownerId);
  return { id, checksum };
}

export async function cleanupPendingBackup(
  db: D1Database,
  art: R2Bucket,
  ownerId: string,
  backupId: string,
): Promise<void> {
  const pending = await db
    .prepare('SELECT 1 FROM backup_runs WHERE id = ?1 AND owner_id = ?2 AND checksum = ?3')
    .bind(backupId, ownerId, 'pending')
    .first();
  if (!pending) return;
  await deleteBackupPrefix(art, `backups/${ownerId}/${backupId}/`);
  await db
    .prepare('DELETE FROM backup_runs WHERE id = ?1 AND owner_id = ?2 AND checksum = ?3')
    .bind(backupId, ownerId, 'pending')
    .run();
}

async function readBackupText(object: R2ObjectBody, maximumBytes: number): Promise<string> {
  if (object.size > maximumBytes) throw new ApplicationError('backup_too_large', 413);
  const reader = (object.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel('backup exceeded maximum size');
      throw new ApplicationError('backup_too_large', 413);
    }
    text += decoder.decode(next.value, { stream: true });
  }
  return text + decoder.decode();
}

function chunks<T>(rows: T[]): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += RESTORE_CHUNK_ROWS)
    output.push(rows.slice(offset, offset + RESTORE_CHUNK_ROWS));
  return output;
}

async function stageRestore(db: D1Database, runId: string, ownerId: string, bundle: BackupBundle) {
  const groups: Array<[string, unknown[]]> = [
    ['catalogue', bundle.catalogue],
    ['sources', bundle.sources],
    ['collection', bundle.collection],
    ['binders', bundle.binders],
    ['versions', bundle.versions],
    ['pages', bundle.pages],
    ['slots', bundle.slots],
    ['art_manifest', bundle.artManifest],
  ];
  const statements: D1PreparedStatement[] = [];
  for (const [kind, rows] of groups) {
    for (const [index, chunk] of chunks(rows).entries())
      statements.push(
        db
          .prepare(
            'INSERT INTO backup_restore_chunks (run_id, owner_id, kind, chunk_index, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
          )
          .bind(runId, ownerId, kind, index, JSON.stringify(chunk), nowSeconds()),
      );
  }
  for (let offset = 0; offset < statements.length; offset += 50)
    await db.batch(statements.slice(offset, offset + 50));
}

async function restoreCustomArt(
  art: R2Bucket,
  ownerId: string,
  backupId: string,
  rows: BackupBundle['artManifest'],
): Promise<void> {
  for (const row of rows) {
    if (!row.backup_object_key) continue;
    if (!row.backup_object_key.startsWith(`backups/${ownerId}/${backupId}/art/`))
      throw new ApplicationError('backup_invalid', 400);
    const backedUp = await art.get(row.backup_object_key);
    if (!backedUp) throw new ApplicationError('backup_custom_art_missing', 400);
    await art.put(row.object_key, backedUp.body, {
      httpMetadata: backedUp.httpMetadata,
      customMetadata: backedUp.customMetadata,
      sha256: row.sha256,
    });
  }
}

async function stageManifestRestore(
  db: D1Database,
  art: R2Bucket,
  runId: string,
  ownerId: string,
  backupId: string,
  manifest: BackupManifest,
  runStep: RestoreStepRunner,
): Promise<void> {
  let totalBytes = 0;
  const identities = new Set<string>();
  for (const chunk of manifest.chunks) {
    const identity = `${chunk.kind}:${chunk.index}`;
    if (identities.has(identity)) throw new ApplicationError('backup_invalid', 400);
    identities.add(identity);
    if (!chunk.objectKey.startsWith(`backups/${ownerId}/${backupId}/chunks/`))
      throw new ApplicationError('backup_invalid', 400);
    totalBytes += chunk.bytes;
    if (totalBytes > MAX_BACKUP_BYTES) throw new ApplicationError('backup_too_large', 413);
    await runStep(`restore-${chunk.kind}-${chunk.index}`, async () => {
      const object = await art.get(chunk.objectKey);
      if (!object) throw new ApplicationError('backup_object_missing', 404);
      if (object.size !== chunk.bytes) throw new ApplicationError('backup_checksum_mismatch', 400);
      const payload = await readBackupText(object, MAX_BACKUP_CHUNK_BYTES);
      if ((await hashText(payload)) !== chunk.checksum)
        throw new ApplicationError('backup_checksum_mismatch', 400);
      let decoded: unknown;
      try {
        decoded = JSON.parse(payload);
      } catch {
        throw new ApplicationError('backup_invalid', 400);
      }
      const rows = z.array(backupRowSchemas[chunk.kind]).safeParse(decoded);
      if (!rows.success || rows.data.length !== chunk.rows)
        throw new ApplicationError('backup_invalid', 400);
      if (
        chunk.kind === 'binders' &&
        z
          .array(binderRow)
          .parse(rows.data)
          .some((binder) => binder.owner_id !== ownerId)
      )
        throw new ApplicationError('backup_owner_mismatch', 403);
      if (chunk.kind === 'art_manifest')
        await restoreCustomArt(art, ownerId, backupId, z.array(artRow).parse(rows.data));
      await db
        .prepare(
          `INSERT INTO backup_restore_chunks
            (run_id, owner_id, kind, chunk_index, payload_json, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(run_id, kind, chunk_index) DO UPDATE SET
             payload_json = excluded.payload_json, created_at = excluded.created_at`,
        )
        .bind(runId, ownerId, chunk.kind, chunk.index, payload, nowSeconds())
        .run();
      return null;
    });
  }
}

const jsonRows =
  'backup_restore_chunks c, json_each(c.payload_json) j WHERE c.run_id = ?1 AND c.owner_id = ?2';

export async function restoreBackup(
  db: D1Database,
  art: R2Bucket,
  ownerId: string,
  backupId: string,
  options: RestoreBackupOptions = {},
): Promise<void> {
  const runStep = options.runStep ?? ((_name, action) => action());
  const run = await db
    .prepare('SELECT object_key, checksum FROM backup_runs WHERE id = ?1 AND owner_id = ?2')
    .bind(backupId, ownerId)
    .first<{ object_key: string; checksum: string }>();
  if (!run || run.checksum === 'pending') throw new ApplicationError('backup_not_found', 404);
  const object = await art.get(run.object_key);
  if (!object) throw new ApplicationError('backup_object_missing', 404);
  const text = await readBackupText(object, MAX_LEGACY_BACKUP_BYTES);
  if ((await hashText(text)) !== run.checksum)
    throw new ApplicationError('backup_checksum_mismatch', 400);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApplicationError('backup_invalid', 400);
  }
  const restoreRunId = options.restoreRunId ?? newId('restore');
  try {
    const manifest = backupManifestSchema.safeParse(json);
    if (manifest.success) {
      if (manifest.data.ownerId !== ownerId)
        throw new ApplicationError('backup_owner_mismatch', 403);
      await stageManifestRestore(db, art, restoreRunId, ownerId, backupId, manifest.data, runStep);
    } else {
      const legacy = backupBundleSchema.safeParse(json);
      if (!legacy.success) throw new ApplicationError('backup_invalid', 400);
      if (
        legacy.data.ownerId !== ownerId ||
        legacy.data.binders.some((binder) => binder.owner_id !== ownerId)
      )
        throw new ApplicationError('backup_owner_mismatch', 403);
      await restoreCustomArt(art, ownerId, backupId, legacy.data.artManifest);
      await stageRestore(db, restoreRunId, ownerId, legacy.data);
    }
    await runStep('restore-finalize', async () => {
      await db.batch([
        db.prepare('DELETE FROM collection_mutations WHERE owner_id = ?1').bind(ownerId),
        db.prepare('DELETE FROM collection_cards WHERE owner_id = ?1').bind(ownerId),
        db.prepare('DELETE FROM species_representatives WHERE owner_id = ?1').bind(ownerId),
        db.prepare('DELETE FROM binders WHERE owner_id = ?1').bind(ownerId),
        db.prepare(
          `DELETE FROM art_upload_tokens WHERE card_id IN (
           SELECT id FROM catalogue_cards WHERE is_custom = 1
         )`,
        ),
        db.prepare(
          `DELETE FROM price_stage_rows WHERE card_id IN (
           SELECT id FROM catalogue_cards WHERE is_custom = 1
         )`,
        ),
        db.prepare(
          `DELETE FROM price_snapshots WHERE card_id IN (
           SELECT id FROM catalogue_cards WHERE is_custom = 1
         )`,
        ),
        db.prepare(
          `DELETE FROM card_sources WHERE card_id IN (
           SELECT id FROM catalogue_cards WHERE is_custom = 1
         )`,
        ),
        db.prepare(
          `DELETE FROM art_manifest WHERE card_id IN (
           SELECT id FROM catalogue_cards WHERE is_custom = 1
         )`,
        ),
        db.prepare(
          `DELETE FROM catalogue_search WHERE card_id IN (
           SELECT id FROM catalogue_cards WHERE is_custom = 1
         )`,
        ),
        db.prepare('DELETE FROM catalogue_cards WHERE is_custom = 1'),
        db
          .prepare(
            `INSERT INTO catalogue_cards (id,name,language,category,set_id,set_name,number,supertype,subtype,species,rarity,artist,release_date,pokedex_number,number_sort,is_custom,is_active,created_at,updated_at)
           SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.name'),json_extract(j.value,'$.language'),json_extract(j.value,'$.category'),json_extract(j.value,'$.set_id'),json_extract(j.value,'$.set_name'),json_extract(j.value,'$.number'),json_extract(j.value,'$.supertype'),json_extract(j.value,'$.subtype'),json_extract(j.value,'$.species'),json_extract(j.value,'$.rarity'),json_extract(j.value,'$.artist'),json_extract(j.value,'$.release_date'),json_extract(j.value,'$.pokedex_number'),json_extract(j.value,'$.number_sort'),json_extract(j.value,'$.is_custom'),json_extract(j.value,'$.is_active'),json_extract(j.value,'$.created_at'),json_extract(j.value,'$.updated_at') FROM ${jsonRows} AND c.kind='catalogue'
           ON CONFLICT(id) DO UPDATE SET name=excluded.name,language=excluded.language,category=excluded.category,set_id=excluded.set_id,set_name=excluded.set_name,number=excluded.number,supertype=excluded.supertype,subtype=excluded.subtype,species=excluded.species,rarity=excluded.rarity,artist=excluded.artist,release_date=excluded.release_date,pokedex_number=excluded.pokedex_number,number_sort=excluded.number_sort,is_custom=excluded.is_custom,is_active=excluded.is_active,updated_at=excluded.updated_at`,
          )
          .bind(restoreRunId, ownerId),
        db
          .prepare(
            `DELETE FROM catalogue_search WHERE card_id IN (
             SELECT json_extract(j.value,'$.id') FROM ${jsonRows} AND c.kind='catalogue'
           )`,
          )
          .bind(restoreRunId, ownerId),
        db
          .prepare(
            `INSERT INTO catalogue_search (card_id,name,set_name,number,species,rarity,artist)
           SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.name'),json_extract(j.value,'$.set_name'),json_extract(j.value,'$.number'),COALESCE(json_extract(j.value,'$.species'),''),COALESCE(json_extract(j.value,'$.rarity'),''),COALESCE(json_extract(j.value,'$.artist'),'') FROM ${jsonRows} AND c.kind='catalogue'`,
          )
          .bind(restoreRunId, ownerId),
        db
          .prepare(
            `INSERT INTO card_sources (provider,source_id,card_id,language,source_updated_at,checksum,active,imported_at)
           SELECT json_extract(j.value,'$.provider'),json_extract(j.value,'$.source_id'),json_extract(j.value,'$.card_id'),json_extract(j.value,'$.language'),json_extract(j.value,'$.source_updated_at'),json_extract(j.value,'$.checksum'),json_extract(j.value,'$.active'),json_extract(j.value,'$.imported_at') FROM ${jsonRows} AND c.kind='sources'
           ON CONFLICT(provider,source_id,language) DO UPDATE SET card_id=excluded.card_id,source_updated_at=excluded.source_updated_at,checksum=excluded.checksum,active=excluded.active,imported_at=excluded.imported_at`,
          )
          .bind(restoreRunId, ownerId),
        db
          .prepare(
            `INSERT INTO collection_cards (owner_id,card_id,quantity,notes,revision,updated_at)
           SELECT ?2,json_extract(j.value,'$.card_id'),json_extract(j.value,'$.quantity'),json_extract(j.value,'$.notes'),json_extract(j.value,'$.revision'),json_extract(j.value,'$.updated_at') FROM ${jsonRows} AND c.kind='collection'`,
          )
          .bind(restoreRunId, ownerId),
        db
          .prepare(
            `INSERT INTO species_representatives (owner_id,pokedex_number,card_id,updated_at)
           SELECT ?2,json_extract(j.value,'$.pokedex_number'),json_extract(j.value,'$.card_id'),json_extract(j.value,'$.updated_at') FROM ${jsonRows} AND c.kind='species_representatives'`,
          )
          .bind(restoreRunId, ownerId),
        db
          .prepare(
            `INSERT INTO binders (id,owner_id,name,active_version_id,created_at,updated_at)
           SELECT json_extract(j.value,'$.id'),?2,json_extract(j.value,'$.name'),NULL,json_extract(j.value,'$.created_at'),json_extract(j.value,'$.updated_at') FROM ${jsonRows} AND c.kind='binders'`,
          )
          .bind(restoreRunId, ownerId),
        db
          .prepare(
            `INSERT INTO binder_versions (id,binder_id,version_number,status,layout_kind,rows,columns,created_at,activated_at,revision)
           SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.binder_id'),json_extract(j.value,'$.version_number'),json_extract(j.value,'$.status'),json_extract(j.value,'$.layout_kind'),json_extract(j.value,'$.rows'),json_extract(j.value,'$.columns'),json_extract(j.value,'$.created_at'),json_extract(j.value,'$.activated_at'),json_extract(j.value,'$.revision') FROM ${jsonRows} AND c.kind='versions'`,
          )
          .bind(restoreRunId, ownerId),
        db
          .prepare(
            `UPDATE binders SET active_version_id = (
             SELECT json_extract(j.value,'$.active_version_id') FROM ${jsonRows}
             AND c.kind='binders' AND json_extract(j.value,'$.id') = binders.id
           ) WHERE owner_id = ?2 AND id IN (
             SELECT json_extract(j.value,'$.id') FROM ${jsonRows} AND c.kind='binders'
           )`,
          )
          .bind(restoreRunId, ownerId),
        db
          .prepare(
            `INSERT INTO binder_pages (id,binder_version_id,position)
           SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.binder_version_id'),json_extract(j.value,'$.position') FROM ${jsonRows} AND c.kind='pages'`,
          )
          .bind(restoreRunId, ownerId),
        db
          .prepare(
            `INSERT INTO binder_slots (binder_page_id,row_index,column_index,card_id)
           SELECT json_extract(j.value,'$.binder_page_id'),json_extract(j.value,'$.row_index'),json_extract(j.value,'$.column_index'),json_extract(j.value,'$.card_id') FROM ${jsonRows} AND c.kind='slots'`,
          )
          .bind(restoreRunId, ownerId),
        db
          .prepare(
            `INSERT INTO art_manifest (card_id,variant,object_key,sha256,bytes,version,updated_at)
           SELECT json_extract(j.value,'$.card_id'),json_extract(j.value,'$.variant'),json_extract(j.value,'$.object_key'),json_extract(j.value,'$.sha256'),json_extract(j.value,'$.bytes'),json_extract(j.value,'$.version'),json_extract(j.value,'$.updated_at') FROM ${jsonRows} AND c.kind='art_manifest'
           ON CONFLICT(card_id,variant) DO UPDATE SET object_key=excluded.object_key,sha256=excluded.sha256,bytes=excluded.bytes,version=excluded.version,updated_at=excluded.updated_at`,
          )
          .bind(restoreRunId, ownerId),
        db
          .prepare('UPDATE users SET mutation_epoch = mutation_epoch + 1 WHERE id = ?1')
          .bind(ownerId),
        db
          .prepare(
            'UPDATE web_sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL',
          )
          .bind(nowSeconds(), ownerId),
        db
          .prepare('UPDATE backup_runs SET restored_at = ?1 WHERE id = ?2 AND owner_id = ?3')
          .bind(nowSeconds(), backupId, ownerId),
        db.prepare('DELETE FROM backup_restore_chunks WHERE run_id = ?1').bind(restoreRunId),
      ]);
      return null;
    });
  } catch (error) {
    await db
      .prepare('DELETE FROM backup_restore_chunks WHERE run_id = ?1')
      .bind(restoreRunId)
      .run();
    throw error;
  }
}
