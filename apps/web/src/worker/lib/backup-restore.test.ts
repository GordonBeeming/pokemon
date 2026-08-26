import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createBackup, restoreBackup } from './backup';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];

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

describe('backup restore', () => {
  it('includes art metadata for cards that appear only in binder slots', async () => {
    const { db, art } = setup();
    await art.put(
      'cards/custom-a/high/hash.webp',
      Uint8Array.from([1, 2, 3]),
      { customMetadata: { ownerId: 'owner' } } as R2PutOptions,
    );

    const backupId = 'backup_binder_art';
    await createBackup(db, art, 'owner', { backupId });

    const manifest = JSON.parse(
      await readObjectText(art, `backups/owner/${backupId}/manifest.json`),
    ) as { chunks: Array<{ kind: string; objectKey: string }> };
    const artChunkKey = manifest.chunks.find((chunk) => chunk.kind === 'art_manifest')?.objectKey;
    expect(artChunkKey).toBeTruthy();
    const rows = JSON.parse(await readObjectText(art, artChunkKey!)) as Array<{ card_id: string }>;

    expect(rows.map((row) => row.card_id)).toContain('card-binder');
  });

  it('removes newer custom catalogue graph rows when restoring an older backup', async () => {
    const { database, db, art } = setup();
    await art.put(
      'cards/custom-a/high/hash.webp',
      Uint8Array.from([1, 2, 3]),
      { customMetadata: { ownerId: 'owner' } } as R2PutOptions,
    );

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
      database.prepare('SELECT id, name FROM catalogue_cards WHERE is_custom = 1 ORDER BY id').all(),
    ).toEqual([{ id: 'custom-a', name: 'Custom A' }]);
    expect(
      database.prepare('SELECT source_id, card_id FROM card_sources ORDER BY source_id').all(),
    ).toEqual([{ source_id: 'source-a', card_id: 'custom-a' }]);
    expect(
      database.prepare('SELECT card_id, variant FROM art_manifest WHERE card_id LIKE ? ORDER BY variant').all(
        'custom-%',
      ),
    ).toEqual([{ card_id: 'custom-a', variant: 'high' }]);
    expect(
      database.prepare('SELECT card_id FROM catalogue_search WHERE card_id LIKE ? ORDER BY card_id').all(
        'custom-%',
      ),
    ).toEqual([{ card_id: 'custom-a' }]);
  });
});
