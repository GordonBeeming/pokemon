import { newId, nowSeconds } from './db';
import { z } from 'zod';

const desktopScopes = [
  'art:read',
  'art:write',
  'catalogue:read',
  'collection:write',
  'binders:write',
] as const;
export type DesktopScope = (typeof desktopScopes)[number];

export interface BackupBundle {
  version: 1;
  createdAt: string;
  collection: Array<{
    card_id: string;
    quantity: number;
    notes: string | null;
    revision: number;
    updated_at: number;
  }>;
  binders: Array<{
    id: string;
    owner_id: string;
    name: string;
    active_version_id: string | null;
    created_at: number;
    updated_at: number;
  }>;
  versions: Array<{
    id: string;
    binder_id: string;
    version_number: number;
    status: string;
    layout_kind: string;
    rows: number;
    columns: number;
    created_at: number;
    activated_at: number | null;
  }>;
  pages: Array<{ id: string; binder_version_id: string; position: number }>;
  slots: Array<{
    binder_page_id: string;
    row_index: number;
    column_index: number;
    card_id: string | null;
  }>;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hashText(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return toHex(await crypto.subtle.digest('SHA-256', buffer));
}

function validScopes(value: unknown): value is DesktopScope[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (scope) =>
        typeof scope === 'string' && desktopScopes.some((knownScope) => knownScope === scope),
    )
  );
}

export async function createBackup(
  db: D1Database,
  art: R2Bucket,
  ownerId: string,
): Promise<{ id: string; checksum: string }> {
  const [collection, binders, versions, pages, slots] = await Promise.all([
    db
      .prepare(
        'SELECT card_id, quantity, notes, revision, updated_at FROM collection_cards WHERE owner_id = ?1',
      )
      .bind(ownerId)
      .all<BackupBundle['collection'][number]>(),
    db
      .prepare(
        'SELECT id, owner_id, name, active_version_id, created_at, updated_at FROM binders WHERE owner_id = ?1',
      )
      .bind(ownerId)
      .all<BackupBundle['binders'][number]>(),
    db
      .prepare(
        'SELECT v.id, v.binder_id, v.version_number, v.status, v.layout_kind, v.rows, v.columns, v.created_at, v.activated_at FROM binder_versions v JOIN binders b ON b.id = v.binder_id WHERE b.owner_id = ?1',
      )
      .bind(ownerId)
      .all<BackupBundle['versions'][number]>(),
    db
      .prepare(
        'SELECT p.id, p.binder_version_id, p.position FROM binder_pages p JOIN binder_versions v ON v.id = p.binder_version_id JOIN binders b ON b.id = v.binder_id WHERE b.owner_id = ?1',
      )
      .bind(ownerId)
      .all<BackupBundle['pages'][number]>(),
    db
      .prepare(
        'SELECT s.binder_page_id, s.row_index, s.column_index, s.card_id FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id JOIN binder_versions v ON v.id = p.binder_version_id JOIN binders b ON b.id = v.binder_id WHERE b.owner_id = ?1',
      )
      .bind(ownerId)
      .all<BackupBundle['slots'][number]>(),
  ]);
  const bundle: BackupBundle = {
    version: 1,
    createdAt: new Date().toISOString(),
    collection: collection.results,
    binders: binders.results,
    versions: versions.results,
    pages: pages.results,
    slots: slots.results,
  };
  const payload = JSON.stringify(bundle);
  const checksum = await hashText(payload);
  const id = newId('backup');
  const objectKey = `backups/${ownerId}/${id}.json`;
  await art.put(objectKey, payload, { httpMetadata: { contentType: 'application/json' } });
  await db
    .prepare(
      'INSERT INTO backup_runs (id, object_key, checksum, created_at) VALUES (?1, ?2, ?3, ?4)',
    )
    .bind(id, objectKey, checksum, nowSeconds())
    .run();
  return { id, checksum };
}

const backupBundleSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.string().datetime(),
    collection: z.array(
      z
        .object({
          card_id: z.string(),
          quantity: z.number().int().min(0).max(9999),
          notes: z.string().nullable(),
          revision: z.number().int().positive(),
          updated_at: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    binders: z.array(
      z
        .object({
          id: z.string(),
          owner_id: z.string(),
          name: z.string().min(1).max(120),
          active_version_id: z.string().nullable(),
          created_at: z.number().int().nonnegative(),
          updated_at: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    versions: z.array(
      z
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
        })
        .strict(),
    ),
    pages: z.array(
      z
        .object({
          id: z.string(),
          binder_version_id: z.string(),
          position: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    slots: z.array(
      z
        .object({
          binder_page_id: z.string(),
          row_index: z.number().int().nonnegative(),
          column_index: z.number().int().nonnegative(),
          card_id: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export async function restoreBackup(
  db: D1Database,
  art: R2Bucket,
  ownerId: string,
  backupId: string,
): Promise<void> {
  const run = await db
    .prepare('SELECT object_key, checksum FROM backup_runs WHERE id = ?1')
    .bind(backupId)
    .first<{ object_key: string; checksum: string }>();
  if (!run) throw new Error('backup_not_found');
  const object = await art.get(run.object_key);
  if (!object) throw new Error('backup_object_missing');
  const text = await object.text();
  if ((await hashText(text)) !== run.checksum) throw new Error('backup_checksum_mismatch');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    throw new Error(`backup_invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsedResult = backupBundleSchema.safeParse(parsedJson);
  if (!parsedResult.success) throw new Error('backup_invalid');
  const parsed = parsedResult.data;
  if (parsed.binders.some((binder) => binder.owner_id !== ownerId))
    throw new Error('backup_owner_mismatch');
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM collection_cards WHERE owner_id = ?1').bind(ownerId),
    db.prepare('DELETE FROM binders WHERE owner_id = ?1').bind(ownerId),
  ];
  for (const row of parsed.collection)
    statements.push(
      db
        .prepare(
          'INSERT INTO collection_cards (owner_id, card_id, quantity, notes, revision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
        )
        .bind(ownerId, row.card_id, row.quantity, row.notes, row.revision, row.updated_at),
    );
  for (const row of parsed.binders)
    statements.push(
      db
        .prepare(
          'INSERT INTO binders (id, owner_id, name, active_version_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
        )
        .bind(row.id, ownerId, row.name, row.active_version_id, row.created_at, row.updated_at),
    );
  for (const row of parsed.versions)
    statements.push(
      db
        .prepare(
          'INSERT INTO binder_versions (id, binder_id, version_number, status, layout_kind, rows, columns, created_at, activated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
        )
        .bind(
          row.id,
          row.binder_id,
          row.version_number,
          row.status,
          row.layout_kind,
          row.rows,
          row.columns,
          row.created_at,
          row.activated_at,
        ),
    );
  for (const row of parsed.pages)
    statements.push(
      db
        .prepare('INSERT INTO binder_pages (id, binder_version_id, position) VALUES (?1, ?2, ?3)')
        .bind(row.id, row.binder_version_id, row.position),
    );
  for (const row of parsed.slots)
    statements.push(
      db
        .prepare(
          'INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id) VALUES (?1, ?2, ?3, ?4)',
        )
        .bind(row.binder_page_id, row.row_index, row.column_index, row.card_id),
    );
  await db.batch(statements);
  await db
    .prepare('UPDATE backup_runs SET restored_at = ?1 WHERE id = ?2')
    .bind(nowSeconds(), backupId)
    .run();
}

export async function createPairCode(
  db: D1Database,
  ownerId: string,
  scopes: DesktopScope[],
): Promise<string> {
  if (!validScopes(scopes)) throw new Error('invalid_desktop_scopes');
  const code = crypto.randomUUID().slice(0, 8).toUpperCase();
  const now = nowSeconds();
  await db
    .prepare(
      'INSERT INTO desktop_pair_codes (code_hash, owner_id, scopes, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
    .bind(await hashText(code), ownerId, JSON.stringify(scopes), now + 600, now)
    .run();
  return code;
}

export async function redeemPairCode(
  db: D1Database,
  code: string,
  label: string,
): Promise<{ token: string; scopes: DesktopScope[] }> {
  const hash = await hashText(code);
  const row = await db
    .prepare(
      'SELECT owner_id, scopes FROM desktop_pair_codes WHERE code_hash = ?1 AND consumed_at IS NULL AND expires_at > ?2',
    )
    .bind(hash, nowSeconds())
    .first<{ owner_id: string; scopes: string }>();
  if (!row) throw new Error('pair_code_invalid');
  const scopesValue: unknown = JSON.parse(row.scopes);
  if (!validScopes(scopesValue)) throw new Error('pair_code_scope_invalid');
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
  const now = nowSeconds();
  const consumed = await db
    .prepare(
      'UPDATE desktop_pair_codes SET consumed_at = ?1 WHERE code_hash = ?2 AND consumed_at IS NULL',
    )
    .bind(now, hash)
    .run();
  if (consumed.meta.changes !== 1) throw new Error('pair_code_already_consumed');
  await db
    .prepare(
      'INSERT INTO desktop_tokens (token_hash, owner_id, label, scopes, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
    .bind(await hashText(token), row.owner_id, label, JSON.stringify(scopesValue), now)
    .run();
  return { token, scopes: scopesValue };
}

export async function requireDesktopToken(
  db: D1Database,
  token: string,
  scope: DesktopScope,
): Promise<string> {
  const row = await db
    .prepare(
      'SELECT owner_id, scopes, expires_at, revoked_at FROM desktop_tokens WHERE token_hash = ?1',
    )
    .bind(await hashText(token))
    .first<{
      owner_id: string;
      scopes: string;
      expires_at: number | null;
      revoked_at: number | null;
    }>();
  if (
    !row ||
    row.revoked_at !== null ||
    (row.expires_at !== null && row.expires_at <= nowSeconds())
  )
    throw new Error('desktop_token_invalid');
  const scopesValue: unknown = JSON.parse(row.scopes);
  if (!validScopes(scopesValue) || !scopesValue.includes(scope))
    throw new Error('desktop_token_scope_missing');
  await db
    .prepare('UPDATE desktop_tokens SET last_used_at = ?1 WHERE token_hash = ?2')
    .bind(nowSeconds(), await hashText(token))
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
