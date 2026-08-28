import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackup, restoreBackup } from './backup';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];

const V3_BINDER_FIXTURE = Object.freeze({
  binders: [
    {
      id: 'v3-binder',
      owner_id: 'owner',
      name: 'V3 Binder',
      active_version_id: 'v3-version',
      created_at: 1,
      updated_at: 1,
    },
  ],
  versions: [
    {
      id: 'v3-version',
      binder_id: 'v3-binder',
      version_number: 1,
      status: 'active',
      layout_kind: '2x2',
      rows: 2,
      columns: 2,
      created_at: 1,
      activated_at: 1,
      revision: 1,
    },
  ],
  pages: [{ id: 'v3-page', binder_version_id: 'v3-version', position: 0 }],
  slots: [
    { binder_page_id: 'v3-page', row_index: 0, column_index: 0, card_id: 'card-binder' },
    { binder_page_id: 'v3-page', row_index: 0, column_index: 1, card_id: null },
  ],
});

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup(): { database: DatabaseSync; db: D1Database; art: R2Bucket } {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(database);
  database.exec(`
    INSERT INTO users (id, label, created_at) VALUES ('owner', 'Owner', 1);
    INSERT INTO catalogue_cards
      (id, name, language, category, set_id, set_name, number, number_sort, is_custom, created_at, updated_at)
    VALUES
      ('card-binder', 'Binder card', 'en', 'pokemon', 'set-1', 'Set', '1', 1, 0, 1, 1),
      ('custom-a', 'Custom A', 'en', 'custom', 'custom', 'Custom', '1', 1, 1, 1, 1);
    INSERT INTO binders (id, owner_id, name, created_at, updated_at)
    VALUES ('binder-1', 'owner', 'Binder', 1, 1);
    INSERT INTO binder_versions
      (id, binder_id, version_number, status, layout_kind, rows, columns, created_at, revision)
    VALUES ('version-1', 'binder-1', 1, 'active', '2x2', 2, 2, 1, 1);
    INSERT INTO binder_pages (id, binder_version_id, position)
    VALUES ('page-1', 'version-1', 0);
    INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id)
    VALUES ('page-1', 0, 0, 'card-binder');
    INSERT INTO card_sources
      (provider, source_id, card_id, language, source_updated_at, checksum, active, imported_at)
    VALUES ('manual', 'source-a', 'custom-a', 'en', 1, '${'a'.repeat(64)}', 1, 1);
    INSERT INTO art_manifest
      (card_id, variant, object_key, sha256, bytes, version, updated_at)
    VALUES
      ('card-binder', 'low', 'cards/card-binder/low/hash.webp', '${'b'.repeat(64)}', 20, 1, 1),
      ('custom-a', 'high', 'cards/custom-a/high/hash.webp', '${'c'.repeat(64)}', 20, 1, 1);
    INSERT INTO catalogue_search (card_id, name, set_name, number, species, rarity, artist)
    VALUES
      ('card-binder', 'Binder card', 'Set', '1', '', '', ''),
      ('custom-a', 'Custom A', 'Custom', '1', '', '', '');
  `);
  return { database, db: sqliteD1(database), art: mapR2() };
}

function mapR2(): R2Bucket {
  type Stored = {
    body: Uint8Array;
    httpMetadata?: Record<string, unknown>;
    customMetadata?: Record<string, string>;
  };
  const objects = new Map<string, Stored>();
  const toBytes = async (value: unknown): Promise<Uint8Array> => {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value instanceof ReadableStream) {
      const reader = value.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const chunks: Uint8Array[] = [];
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array)) throw new Error('Unsupported R2 chunk.');
        chunks.push(chunk);
      }
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const combined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return combined;
    }
    throw new Error(`Unsupported R2 body: ${String(value)}`);
  };
  const bodyStream = (body: Uint8Array) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
  return {
    async put(key: string, value: unknown, options?: R2PutOptions) {
      objects.set(key, {
        body: await toBytes(value),
        httpMetadata: options?.httpMetadata as Record<string, unknown> | undefined,
        customMetadata: options?.customMetadata,
      });
      return null;
    },
    get(key: string) {
      const stored = objects.get(key);
      return Promise.resolve(
        stored
          ? ({
              key,
              size: stored.body.byteLength,
              body: bodyStream(stored.body),
              httpMetadata: stored.httpMetadata,
              customMetadata: stored.customMetadata,
            } as R2ObjectBody)
          : null,
      );
    },
    head(key: string) {
      const stored = objects.get(key);
      return Promise.resolve(
        stored
          ? ({
              key,
              size: stored.body.byteLength,
              customMetadata: stored.customMetadata,
            } as R2Object)
          : null,
      );
    },
    delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      return Promise.resolve();
    },
    list() {
      return Promise.resolve({ objects: [], delimitedPrefixes: [], truncated: false } as R2Objects);
    },
  } as unknown as R2Bucket;
}

async function readObjectText(art: R2Bucket, key: string): Promise<string> {
  const object = await art.get(key);
  if (!object) throw new Error(`Missing object ${key}`);
  const reader = object.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = next.value;
    if (!(chunk instanceof Uint8Array)) throw new Error(`Unexpected object chunk for ${key}`);
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

async function checksum(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function seedReferencedArt(art: R2Bucket): Promise<void> {
  await art.put('cards/custom-a/high/hash.webp', Uint8Array.from([1, 2, 3]), {
    customMetadata: { ownerId: 'owner' },
  } as R2PutOptions);
  await art.put('cards/card-binder/low/hash.webp', Uint8Array.from([4, 5, 6]), {
    customMetadata: { source: 'tcgdex' },
  } as R2PutOptions);
}

describe('backup restore', () => {
  it('restores the frozen v3 binder fixture with v4 defaults', async () => {
    const { database, db, art } = setup();
    const backupId = 'backup_v3_fixture';
    const chunks: Array<{
      kind: 'binders' | 'versions' | 'pages' | 'slots';
      index: number;
      objectKey: string;
      checksum: string;
      bytes: number;
      rows: number;
    }> = [];
    for (const kind of ['binders', 'versions', 'pages', 'slots'] as const) {
      const payload = JSON.stringify(V3_BINDER_FIXTURE[kind]);
      const objectKey = `backups/owner/${backupId}/chunks/${kind}/0.json`;
      const digest = await checksum(payload);
      await art.put(objectKey, payload, { customMetadata: { checksum: digest } });
      chunks.push({
        kind,
        index: 0,
        objectKey,
        checksum: digest,
        bytes: new TextEncoder().encode(payload).byteLength,
        rows: V3_BINDER_FIXTURE[kind].length,
      });
    }
    const manifest = JSON.stringify({
      version: 3,
      ownerId: 'owner',
      mutationEpoch: 0,
      createdAt: '2026-08-28T00:00:00.000Z',
      chunks,
    });
    const manifestChecksum = await checksum(manifest);
    const manifestKey = `backups/owner/${backupId}/manifest.json`;
    await art.put(manifestKey, manifest);
    database
      .prepare(
        `INSERT INTO backup_runs
          (id,owner_id,object_key,checksum,backup_epoch,created_at)
         VALUES (?1,'owner',?2,?3,0,1)`,
      )
      .run(backupId, manifestKey, manifestChecksum);

    await restoreBackup(db, art, 'owner', backupId);

    expect(
      database.prepare('SELECT capacity FROM binder_versions WHERE id = ?1').get('v3-version'),
    ).toEqual({ capacity: 4 });
    expect(
      database.prepare('SELECT kind, label FROM binder_pages WHERE id = ?1').get('v3-page'),
    ).toEqual({ kind: 'slots', label: null });
    expect(
      database
        .prepare(
          `SELECT row_index, entry_kind, card_id FROM binder_slots
           WHERE binder_page_id = 'v3-page' ORDER BY column_index`,
        )
        .all(),
    ).toEqual([
      { row_index: 0, entry_kind: 'exact-card', card_id: 'card-binder' },
      { row_index: 0, entry_kind: 'empty', card_id: null },
    ]);
  });

  it('includes art metadata for cards that appear only in binder slots', async () => {
    const { db, art } = setup();
    await seedReferencedArt(art);

    const backupId = 'backup_binder_art';
    await createBackup(db, art, 'owner', { backupId });

    const manifest = JSON.parse(
      await readObjectText(art, `backups/owner/${backupId}/manifest.json`),
    ) as { chunks: Array<{ kind: string; objectKey: string }> };
    const artChunkKey = manifest.chunks.find((chunk) => chunk.kind === 'art_manifest')?.objectKey;
    expect(artChunkKey).toBeTruthy();
    const rows = JSON.parse(await readObjectText(art, artChunkKey!)) as Array<{
      card_id: string;
      backup_object_key: string;
    }>;

    expect(rows.map((row) => row.card_id)).toContain('card-binder');
    const binderArt = rows.find((row) => row.card_id === 'card-binder');
    expect(binderArt?.backup_object_key).toContain('/art/card-binder/low.webp');
    await expect(art.get(binderArt?.backup_object_key ?? '')).resolves.not.toBeNull();
  });

  it('preserves shared catalogue data when restoring an older backup', async () => {
    const { database, db, art } = setup();
    await seedReferencedArt(art);

    const backupId = 'backup_restore_custom';
    await createBackup(db, art, 'owner', { backupId });

    database.exec(`
      UPDATE catalogue_cards SET name = 'Custom A updated' WHERE id = 'custom-a';
      INSERT INTO catalogue_cards
        (id, name, language, category, set_id, set_name, number, number_sort, is_custom, created_at, updated_at)
      VALUES ('custom-b', 'Custom B', 'en', 'custom', 'custom', 'Custom', '2', 2, 1, 2, 2);
      INSERT INTO card_sources
        (provider, source_id, card_id, language, source_updated_at, checksum, active, imported_at)
      VALUES
        ('manual', 'source-a-extra', 'custom-a', 'en', 2, '${'d'.repeat(64)}', 1, 2),
        ('manual', 'source-b', 'custom-b', 'en', 2, '${'e'.repeat(64)}', 1, 2);
      INSERT INTO art_manifest
        (card_id, variant, object_key, sha256, bytes, version, updated_at)
      VALUES
        ('custom-a', 'low', 'cards/custom-a/low/hash.webp', '${'f'.repeat(64)}', 20, 1, 2),
        ('custom-b', 'high', 'cards/custom-b/high/hash.webp', '${'9'.repeat(64)}', 20, 1, 2);
      INSERT INTO catalogue_search (card_id, name, set_name, number, species, rarity, artist)
      VALUES ('custom-b', 'Custom B', 'Custom', '2', '', '', '');
    `);

    await restoreBackup(db, art, 'owner', backupId);

    expect(
      database
        .prepare('SELECT id, name FROM catalogue_cards WHERE is_custom = 1 ORDER BY id')
        .all(),
    ).toEqual([
      { id: 'custom-a', name: 'Custom A updated' },
      { id: 'custom-b', name: 'Custom B' },
    ]);
    expect(
      database.prepare('SELECT source_id, card_id FROM card_sources ORDER BY source_id').all(),
    ).toEqual([
      { source_id: 'source-a', card_id: 'custom-a' },
      { source_id: 'source-a-extra', card_id: 'custom-a' },
      { source_id: 'source-b', card_id: 'custom-b' },
    ]);
    expect(
      database
        .prepare('SELECT card_id, variant FROM art_manifest WHERE card_id LIKE ? ORDER BY variant')
        .all('custom-%'),
    ).toEqual([
      { card_id: 'custom-a', variant: 'high' },
      { card_id: 'custom-b', variant: 'high' },
      { card_id: 'custom-a', variant: 'low' },
    ]);
    expect(
      database
        .prepare('SELECT card_id FROM catalogue_search WHERE card_id LIKE ? ORDER BY card_id')
        .all('custom-%'),
    ).toEqual([{ card_id: 'custom-a' }, { card_id: 'custom-b' }]);
  });
});
