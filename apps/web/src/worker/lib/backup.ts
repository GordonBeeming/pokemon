import { z } from 'zod';
import { newId, nowSeconds } from './db';
import { ApplicationError } from './log';

export const DESKTOP_SCOPES = [
  'art:read',
  'art:write',
  'catalogue:read',
  'collection:write',
  'binders:write',
] as const;
export type DesktopScope = (typeof DESKTOP_SCOPES)[number];

const BACKUP_VERSION = 2 as const;
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const RESTORE_CHUNK_ROWS = 250;
const DESKTOP_TOKEN_MAX_AGE = 60 * 60 * 24 * 90;
const DESKTOP_ACTIVITY_INTERVAL = 60 * 60;

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
    version: z.literal(BACKUP_VERSION),
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

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashText(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function validScopes(value: unknown): value is DesktopScope[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (scope) => typeof scope === 'string' && DESKTOP_SCOPES.some((known) => known === scope),
    )
  );
}

function parseRows<T>(schema: z.ZodType<T>, value: unknown): T[] {
  return z.array(schema).parse(value);
}

async function copyCustomArt(
  art: R2Bucket,
  ownerId: string,
  backupId: string,
  rows: Array<Omit<BackupBundle['artManifest'][number], 'backup_object_key'>>,
  customCardIds: ReadonlySet<string>,
): Promise<{ rows: BackupBundle['artManifest']; copiedKeys: string[] }> {
  const copied: BackupBundle['artManifest'] = [];
  const copiedKeys: string[] = [];
  try {
    for (const row of rows) {
      let backupObjectKey: string | null = null;
      if (customCardIds.has(row.card_id)) {
        const object = await art.get(row.object_key);
        if (!object) throw new ApplicationError('backup_custom_art_missing', 500);
        backupObjectKey = `backups/${ownerId}/${backupId}/art/${encodeURIComponent(row.card_id)}/${row.variant}.webp`;
        await art.put(backupObjectKey, object.body, {
          httpMetadata: object.httpMetadata,
          customMetadata: object.customMetadata,
          sha256: row.sha256,
        });
        copiedKeys.push(backupObjectKey);
      }
      copied.push({ ...row, backup_object_key: backupObjectKey });
    }
  } catch (error) {
    await Promise.all(copiedKeys.map((key) => art.delete(key)));
    throw error;
  }
  return { rows: copied, copiedKeys };
}

export async function createBackup(
  db: D1Database,
  art: R2Bucket,
  ownerId: string,
): Promise<{ id: string; checksum: string }> {
  const statements = [
    db.prepare('SELECT mutation_epoch FROM users WHERE id = ?1').bind(ownerId),
    db
      .prepare(
        `SELECT c.id, c.name, c.language, c.category, c.set_id, c.set_name, c.number,
          c.supertype, c.subtype, c.species, c.rarity, c.artist, c.release_date,
          c.pokedex_number, c.number_sort, c.is_custom, c.is_active, c.created_at, c.updated_at
         FROM catalogue_cards c WHERE c.is_custom = 1
           OR EXISTS (SELECT 1 FROM collection_cards cc WHERE cc.owner_id = ?1 AND cc.card_id = c.id)
           OR EXISTS (SELECT 1 FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id
             JOIN binder_versions v ON v.id = p.binder_version_id JOIN binders b ON b.id = v.binder_id
             WHERE b.owner_id = ?1 AND s.card_id = c.id)`,
      )
      .bind(ownerId),
    db
      .prepare(
        `SELECT s.provider, s.source_id, s.card_id, s.language, s.source_updated_at, s.checksum, s.active, s.imported_at
         FROM card_sources s WHERE EXISTS (
           SELECT 1 FROM catalogue_cards c WHERE c.id = s.card_id AND (c.is_custom = 1
             OR EXISTS (SELECT 1 FROM collection_cards cc WHERE cc.owner_id = ?1 AND cc.card_id = c.id)
             OR EXISTS (SELECT 1 FROM binder_slots bs JOIN binder_pages p ON p.id = bs.binder_page_id
               JOIN binder_versions v ON v.id = p.binder_version_id JOIN binders b ON b.id = v.binder_id
               WHERE b.owner_id = ?1 AND bs.card_id = c.id)))`,
      )
      .bind(ownerId),
    db
      .prepare(
        'SELECT card_id, quantity, notes, revision, updated_at FROM collection_cards WHERE owner_id = ?1',
      )
      .bind(ownerId),
    db
      .prepare(
        'SELECT id, owner_id, name, active_version_id, created_at, updated_at FROM binders WHERE owner_id = ?1',
      )
      .bind(ownerId),
    db
      .prepare(
        'SELECT v.id, v.binder_id, v.version_number, v.status, v.layout_kind, v.rows, v.columns, v.created_at, v.activated_at, v.revision FROM binder_versions v JOIN binders b ON b.id = v.binder_id WHERE b.owner_id = ?1',
      )
      .bind(ownerId),
    db
      .prepare(
        'SELECT p.id, p.binder_version_id, p.position FROM binder_pages p JOIN binder_versions v ON v.id = p.binder_version_id JOIN binders b ON b.id = v.binder_id WHERE b.owner_id = ?1',
      )
      .bind(ownerId),
    db
      .prepare(
        'SELECT s.binder_page_id, s.row_index, s.column_index, s.card_id FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id JOIN binder_versions v ON v.id = p.binder_version_id JOIN binders b ON b.id = v.binder_id WHERE b.owner_id = ?1',
      )
      .bind(ownerId),
    db
      .prepare(
        `SELECT m.card_id, m.variant, m.object_key, m.sha256, m.bytes, m.version, m.updated_at
         FROM art_manifest m WHERE EXISTS (SELECT 1 FROM catalogue_cards c WHERE c.id = m.card_id AND
           (c.is_custom = 1 OR EXISTS (SELECT 1 FROM collection_cards cc WHERE cc.owner_id = ?1 AND cc.card_id = c.id)))`,
      )
      .bind(ownerId),
  ];
  const snapshot = await db.batch(statements);
  const epoch = z
    .array(z.object({ mutation_epoch: z.number().int().nonnegative() }))
    .min(1)
    .parse(snapshot[0]?.results)[0]?.mutation_epoch;
  if (epoch === undefined) throw new ApplicationError('backup_owner_not_found', 404);
  const catalogue = parseRows(catalogueRow, snapshot[1]?.results);
  const sources = parseRows(sourceRow, snapshot[2]?.results);
  const collection = parseRows(collectionRow, snapshot[3]?.results);
  const binders = parseRows(binderRow, snapshot[4]?.results);
  const versions = parseRows(versionRow, snapshot[5]?.results);
  const pages = parseRows(pageRow, snapshot[6]?.results);
  const slots = parseRows(slotRow, snapshot[7]?.results);
  const manifestRows = parseRows(artRow.omit({ backup_object_key: true }), snapshot[8]?.results);

  const id = newId('backup');
  const objectKey = `backups/${ownerId}/${id}/manifest.json`;
  const customIds = new Set(catalogue.filter((row) => row.is_custom === 1).map((row) => row.id));
  const copiedArt = await copyCustomArt(art, ownerId, id, manifestRows, customIds);
  const bundle: BackupBundle = {
    version: BACKUP_VERSION,
    ownerId,
    mutationEpoch: epoch,
    createdAt: new Date().toISOString(),
    catalogue,
    sources,
    collection,
    binders,
    versions,
    pages,
    slots,
    artManifest: copiedArt.rows,
  };
  const payload = JSON.stringify(bundle);
  if (new TextEncoder().encode(payload).byteLength > MAX_BACKUP_BYTES) {
    await Promise.all(copiedArt.copiedKeys.map((key) => art.delete(key)));
    throw new ApplicationError('backup_too_large', 413);
  }
  const checksum = await hashText(payload);
  await db
    .prepare(
      'INSERT INTO backup_runs (id, owner_id, object_key, checksum, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
    .bind(id, ownerId, objectKey, 'pending', nowSeconds())
    .run();
  try {
    await art.put(objectKey, payload, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { ownerId, checksum, version: String(BACKUP_VERSION) },
      sha256: checksum,
    });
    await db
      .prepare('UPDATE backup_runs SET checksum = ?1 WHERE id = ?2 AND owner_id = ?3')
      .bind(checksum, id, ownerId)
      .run();
  } catch (error) {
    await Promise.all([
      art.delete(objectKey),
      ...copiedArt.copiedKeys.map((key) => art.delete(key)),
    ]);
    await db
      .prepare('DELETE FROM backup_runs WHERE id = ?1 AND checksum = ?2')
      .bind(id, 'pending')
      .run();
    throw error;
  }
  return { id, checksum };
}

async function readBackupText(object: R2ObjectBody): Promise<string> {
  if (object.size > MAX_BACKUP_BYTES) throw new ApplicationError('backup_too_large', 413);
  const reader = (object.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_BACKUP_BYTES) {
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

const jsonRows =
  'backup_restore_chunks c, json_each(c.payload_json) j WHERE c.run_id = ?1 AND c.owner_id = ?2';

export async function restoreBackup(
  db: D1Database,
  art: R2Bucket,
  ownerId: string,
  backupId: string,
): Promise<void> {
  const run = await db
    .prepare('SELECT object_key, checksum FROM backup_runs WHERE id = ?1 AND owner_id = ?2')
    .bind(backupId, ownerId)
    .first<{ object_key: string; checksum: string }>();
  if (!run || run.checksum === 'pending') throw new ApplicationError('backup_not_found', 404);
  const object = await art.get(run.object_key);
  if (!object) throw new ApplicationError('backup_object_missing', 404);
  const text = await readBackupText(object);
  if ((await hashText(text)) !== run.checksum)
    throw new ApplicationError('backup_checksum_mismatch', 400);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApplicationError('backup_invalid', 400);
  }
  const parsed = backupBundleSchema.safeParse(json);
  if (!parsed.success || parsed.data.ownerId !== ownerId)
    throw new ApplicationError('backup_owner_mismatch', 403);
  const bundle = parsed.data;
  if (bundle.binders.some((binder) => binder.owner_id !== ownerId))
    throw new ApplicationError('backup_owner_mismatch', 403);

  for (const row of bundle.artManifest) {
    if (!row.backup_object_key) continue;
    const backedUp = await art.get(row.backup_object_key);
    if (!backedUp) throw new ApplicationError('backup_custom_art_missing', 400);
    await art.put(row.object_key, backedUp.body, {
      httpMetadata: backedUp.httpMetadata,
      customMetadata: backedUp.customMetadata,
      sha256: row.sha256,
    });
  }

  const restoreRunId = newId('restore');
  try {
    await stageRestore(db, restoreRunId, ownerId, bundle);
    await db.batch([
      db.prepare('DELETE FROM collection_mutations WHERE owner_id = ?1').bind(ownerId),
      db.prepare('DELETE FROM collection_cards WHERE owner_id = ?1').bind(ownerId),
      db.prepare('DELETE FROM binders WHERE owner_id = ?1').bind(ownerId),
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
  } catch (error) {
    await db
      .prepare('DELETE FROM backup_restore_chunks WHERE run_id = ?1')
      .bind(restoreRunId)
      .run();
    throw error;
  }
}

export async function createPairCode(
  db: D1Database,
  ownerId: string,
  scopes: DesktopScope[],
): Promise<string> {
  if (!validScopes(scopes)) throw new ApplicationError('invalid_desktop_scopes', 400);
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const code = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  const now = nowSeconds();
  await db.batch([
    db
      .prepare('DELETE FROM desktop_pair_codes WHERE expires_at <= ?1 OR consumed_at IS NOT NULL')
      .bind(now),
    db
      .prepare('DELETE FROM desktop_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?1')
      .bind(now),
    db
      .prepare(
        'INSERT INTO desktop_pair_codes (code_hash, owner_id, scopes, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      )
      .bind(await hashText(code), ownerId, JSON.stringify(scopes), now + 600, now),
  ]);
  return code;
}

export async function redeemPairCode(
  db: D1Database,
  code: string,
  label: string,
): Promise<{ token: string; scopes: DesktopScope[] }> {
  const codeHash = await hashText(code.trim().toUpperCase());
  const row = await db
    .prepare('SELECT scopes FROM desktop_pair_codes WHERE code_hash = ?1')
    .bind(codeHash)
    .first<{ scopes: string }>();
  const parsedScopes: unknown = row ? JSON.parse(row.scopes) : null;
  if (!validScopes(parsedScopes)) throw new ApplicationError('pair_code_invalid', 400);
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
  const tokenHash = await hashText(token);
  const now = nowSeconds();
  try {
    const [inserted] = await db.batch([
      db
        .prepare(
          `INSERT INTO desktop_tokens (token_hash, owner_id, label, scopes, pair_code_hash, expires_at, created_at)
           SELECT ?1, owner_id, ?2, scopes, code_hash, ?3, ?4 FROM desktop_pair_codes
           WHERE code_hash = ?5 AND consumed_at IS NULL AND expires_at > ?4`,
        )
        .bind(tokenHash, label, now + DESKTOP_TOKEN_MAX_AGE, now, codeHash),
      db
        .prepare(
          'UPDATE desktop_pair_codes SET consumed_at = ?1 WHERE code_hash = ?2 AND consumed_at IS NULL AND expires_at > ?1',
        )
        .bind(now, codeHash),
    ]);
    if (inserted?.meta.changes !== 1) throw new ApplicationError('pair_code_invalid', 400);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('pair_code_already_consumed', 409);
  }
  return { token, scopes: parsedScopes };
}

export async function requireDesktopToken(
  db: D1Database,
  token: string,
  scope: DesktopScope,
): Promise<string> {
  const tokenHash = await hashText(token);
  const now = nowSeconds();
  const row = await db
    .prepare(
      'SELECT owner_id, scopes, expires_at, revoked_at, last_used_at FROM desktop_tokens WHERE token_hash = ?1',
    )
    .bind(tokenHash)
    .first<{
      owner_id: string;
      scopes: string;
      expires_at: number | null;
      revoked_at: number | null;
      last_used_at: number | null;
    }>();
  if (!row || row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= now))
    throw new ApplicationError('desktop_token_invalid', 401);
  const scopesValue: unknown = JSON.parse(row.scopes);
  if (!validScopes(scopesValue) || !scopesValue.includes(scope))
    throw new ApplicationError('desktop_token_scope_missing', 403);
  if (row.last_used_at === null || row.last_used_at <= now - DESKTOP_ACTIVITY_INTERVAL)
    await db
      .prepare(
        'UPDATE desktop_tokens SET last_used_at = ?1 WHERE token_hash = ?2 AND (last_used_at IS NULL OR last_used_at <= ?3)',
      )
      .bind(now, tokenHash, now - DESKTOP_ACTIVITY_INTERVAL)
      .run();
  return row.owner_id;
}

export async function listDesktopTokens(
  db: D1Database,
  ownerId: string,
): Promise<
  Array<{
    id: string;
    label: string;
    scopes: DesktopScope[];
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
  }>
> {
  const result = await db
    .prepare(
      'SELECT token_hash, label, scopes, expires_at, revoked_at, last_used_at FROM desktop_tokens WHERE owner_id = ?1 ORDER BY created_at DESC',
    )
    .bind(ownerId)
    .all<{
      token_hash: string;
      label: string;
      scopes: string;
      expires_at: number | null;
      revoked_at: number | null;
      last_used_at: number | null;
    }>();
  return result.results.flatMap((row) => {
    const scopes: unknown = JSON.parse(row.scopes);
    return validScopes(scopes)
      ? [
          {
            id: row.token_hash,
            label: row.label,
            scopes,
            expiresAt: row.expires_at ? new Date(row.expires_at * 1000).toISOString() : null,
            revokedAt: row.revoked_at ? new Date(row.revoked_at * 1000).toISOString() : null,
            lastUsedAt: row.last_used_at ? new Date(row.last_used_at * 1000).toISOString() : null,
          },
        ]
      : [];
  });
}

export async function revokeDesktopToken(
  db: D1Database,
  ownerId: string,
  tokenId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE desktop_tokens SET revoked_at = ?1 WHERE token_hash = ?2 AND owner_id = ?3 AND revoked_at IS NULL',
    )
    .bind(nowSeconds(), tokenId, ownerId)
    .run();
  return result.meta.changes === 1;
}
