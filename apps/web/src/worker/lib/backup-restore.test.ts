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
  it('backs up set dates and restores them into sets without putting dates on cards', async () => {
    const { database, db, art } = setup();
    await seedReferencedArt(art);
    database.exec(
      "INSERT INTO catalogue_sets (set_id, language, set_name, release_date, updated_at) VALUES('set-1','en','Set','1999-01-09',1)",
    );
    await createBackup(db, art, 'owner', { backupId: 'backup_set_dates' });
    database.exec("DELETE FROM catalogue_sets WHERE set_id='set-1'");
    await restoreBackup(db, art, 'owner', 'backup_set_dates');
    expect(
      database.prepare("SELECT release_date FROM catalogue_sets WHERE set_id='set-1'").get(),
    ).toEqual({ release_date: '1999-01-09' });
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM catalogue_cards WHERE release_date IS NOT NULL')
        .get(),
    ).toEqual({ count: 0 });
  });
  it('preserves copy-addition order across backup and restore', async () => {
    const { database, db, art } = setup();
    await seedReferencedArt(art);
    database.exec(`INSERT INTO collection_cards(owner_id,card_id,quantity,notes,revision,updated_at,last_added_order)
      VALUES('owner','card-binder',1,NULL,1,1,15),('owner','custom-a',1,NULL,1,1,27)`);
    await createBackup(db, art, 'owner', { backupId: 'backup_addition_order' });
    database.exec("UPDATE collection_cards SET quantity=quantity+1 WHERE card_id='card-binder'");
    await restoreBackup(db, art, 'owner', 'backup_addition_order');
    expect(
      database
        .prepare('SELECT card_id,last_added_order FROM collection_cards ORDER BY last_added_order')
        .all(),
    ).toEqual([
      { card_id: 'card-binder', last_added_order: 15 },
      { card_id: 'custom-a', last_added_order: 27 },
    ]);
  });

  it('restores old collection backups without inventing an addition order', async () => {
    const { database, db, art } = setup();
    const backupId = 'backup_legacy_addition';
    const body = JSON.stringify({
      version: 2,
      ownerId: 'owner',
      mutationEpoch: 0,
      createdAt: '2026-09-27T00:00:00.000Z',
      catalogue: [],
      sources: [],
      collection: [
        { card_id: 'card-binder', quantity: 2, notes: null, revision: 1, updated_at: 1 },
      ],
      binders: [],
      versions: [],
      pages: [],
      slots: [],
      artManifest: [],
    });
    const key = `backups/owner/${backupId}/legacy.json`;
    await art.put(key, body);
    database
      .prepare(
        "INSERT INTO backup_runs(id,owner_id,object_key,checksum,backup_epoch,created_at) VALUES(?1,'owner',?2,?3,0,1)",
      )
      .run(backupId, key, await checksum(body));
    await restoreBackup(db, art, 'owner', backupId);
    expect(
      database
        .prepare(
          "SELECT quantity,last_added_order FROM collection_cards WHERE card_id='card-binder'",
        )
        .get(),
    ).toEqual({ quantity: 2, last_added_order: 0 });
  });

  it('preserves a placed Pokémon target in the last pocket of a reserved page', async () => {
    const { database, db, art } = setup();
    await seedReferencedArt(art);
    database.exec(`
      UPDATE catalogue_cards SET pokedex_number=494 WHERE id='card-binder';
      INSERT INTO collection_cards(owner_id,card_id,quantity,notes,revision,updated_at)
        VALUES('owner','card-binder',1,NULL,1,1);
      UPDATE binder_slots SET entry_kind='empty',card_id=NULL;
      UPDATE binder_pages SET kind='reserved',label='Unova' WHERE id='page-1';
      UPDATE binder_slots SET row_index=1,column_index=1,card_id=NULL,entry_kind='pokemon',
        pokemon_number=494,assigned_card_id='card-binder',starts_new_page=1;
      INSERT INTO binder_bookmarks(id,binder_page_id,row_index,column_index,name,created_at)
        VALUES('victini-mark','page-1',1,1,'Victini',1);
    `);
    await createBackup(db, art, 'owner', { backupId: 'backup_reserved_victini' });
    database.exec(
      "UPDATE binder_slots SET entry_kind='empty',pokemon_number=NULL,assigned_card_id=NULL,starts_new_page=0; UPDATE binder_pages SET kind='slots',label=NULL; DELETE FROM binder_bookmarks;",
    );
    await restoreBackup(db, art, 'owner', 'backup_reserved_victini');
    expect(database.prepare("SELECT kind,label FROM binder_pages WHERE id='page-1'").get()).toEqual(
      { kind: 'reserved', label: 'Unova' },
    );
    expect(
      database
        .prepare(
          "SELECT row_index,column_index,entry_kind,pokemon_number,assigned_card_id,starts_new_page FROM binder_slots WHERE binder_page_id='page-1' AND row_index=1 AND column_index=1",
        )
        .get(),
    ).toEqual({
      row_index: 1,
      column_index: 1,
      entry_kind: 'pokemon',
      pokemon_number: 494,
      assigned_card_id: 'card-binder',
      starts_new_page: 1,
    });
    expect(
      database.prepare("SELECT name FROM binder_bookmarks WHERE id='victini-mark'").get(),
    ).toEqual({ name: 'Victini' });
  });

  it('round-trips intentional empty sleeves through the version 5 backup', async () => {
    const { database, db, art } = setup();
    await seedReferencedArt(art);
    database.exec(
      "INSERT INTO binder_slots (binder_page_id,row_index,column_index,entry_kind,is_manual_gap) VALUES ('page-1',0,1,'empty',1)",
    );
    await createBackup(db, art, 'owner', { backupId: 'backup_manual_gap' });
    database.exec(
      "UPDATE binder_slots SET is_manual_gap=0 WHERE binder_page_id='page-1' AND row_index=0 AND column_index=1",
    );
    await restoreBackup(db, art, 'owner', 'backup_manual_gap');
    expect(
      database
        .prepare(
          "SELECT entry_kind,is_manual_gap FROM binder_slots WHERE binder_page_id='page-1' AND row_index=0 AND column_index=1",
        )
        .get(),
    ).toEqual({ entry_kind: 'empty', is_manual_gap: 1 });
  });

  it('round-trips a set target through backup and restore', async () => {
    const { database, db, art } = setup();
    await seedReferencedArt(art);
    database.exec(
      "INSERT INTO binder_slots (binder_page_id,row_index,column_index,entry_kind,set_id,set_language) VALUES ('page-1',0,1,'reserved','30th','en')",
    );
    await createBackup(db, art, 'owner', { backupId: 'backup_set_target' });
    database.exec(
      "UPDATE binder_slots SET set_id=NULL,set_language=NULL WHERE binder_page_id='page-1' AND row_index=0 AND column_index=1",
    );
    await restoreBackup(db, art, 'owner', 'backup_set_target');
    expect(
      database
        .prepare(
          "SELECT entry_kind,set_id,set_language FROM binder_slots WHERE binder_page_id='page-1' AND row_index=0 AND column_index=1",
        )
        .get(),
    ).toEqual({ entry_kind: 'reserved', set_id: '30th', set_language: 'en' });
  });

  it('round-trips pocket bookmarks through backup and restore', async () => {
    const { database, db, art } = setup();
    await seedReferencedArt(art);
    database.exec(
      "INSERT INTO binder_bookmarks (id,binder_page_id,row_index,column_index,name,created_at) VALUES ('bookmark-1','page-1',0,0,'Kanto',1)",
    );
    await createBackup(db, art, 'owner', { backupId: 'backup_bookmarks' });
    database.exec('DELETE FROM binder_bookmarks');
    await restoreBackup(db, art, 'owner', 'backup_bookmarks');
    expect(
      database
        .prepare('SELECT id,binder_page_id,row_index,column_index,name FROM binder_bookmarks')
        .all(),
    ).toEqual([
      { id: 'bookmark-1', binder_page_id: 'page-1', row_index: 0, column_index: 0, name: 'Kanto' },
    ]);
  });

  it.each([3, 4])(
    'restores an older version %i binder fixture with current defaults',
    async (backupVersion) => {
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
        version: backupVersion,
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
      await restoreBackup(db, art, 'owner', backupId);

      expect(
        database.prepare('SELECT capacity FROM binder_versions WHERE id = ?1').get('v3-version'),
      ).toEqual({ capacity: 4 });
      // The v3/v4 fixture predates peek_columns/show_frame; restore must fall
      // back to the same defaults the column itself gives a fresh binder.
      expect(
        database
          .prepare('SELECT peek_columns, show_frame, page_section FROM binders WHERE id = ?1')
          .get('v3-binder'),
      ).toEqual({ peek_columns: 1, show_frame: 1, page_section: 'reserved' });
      expect(
        database.prepare('SELECT kind, label FROM binder_pages WHERE id = ?1').get('v3-page'),
      ).toEqual({ kind: 'slots', label: null });
      expect(
        database
          .prepare(
            `SELECT row_index, column_index, entry_kind, card_id FROM binder_slots
           WHERE binder_page_id = 'v3-page' ORDER BY row_index, column_index`,
          )
          .all(),
      ).toEqual([
        {
          row_index: 0,
          column_index: 0,
          entry_kind: 'exact-card',
          card_id: 'card-binder',
        },
        { row_index: 0, column_index: 1, entry_kind: 'empty', card_id: null },
        { row_index: 1, column_index: 0, entry_kind: 'empty', card_id: null },
        { row_index: 1, column_index: 1, entry_kind: 'empty', card_id: null },
      ]);
    },
  );

  it('preserves exact capacity and page reservations while repairing missing pockets', async () => {
    const { database, db, art } = setup();
    await seedReferencedArt(art);
    database.exec(`
      INSERT INTO binder_pages (id,binder_version_id,position,kind,label)
      VALUES ('page-2','version-1',1,'reserved','Trades');
      UPDATE binder_versions SET capacity = 7 WHERE id = 'version-1';
    `);
    const backupId = 'backup_incomplete_reserved_page';
    await createBackup(db, art, 'owner', { backupId });

    await restoreBackup(db, art, 'owner', backupId);

    expect(
      database.prepare('SELECT capacity FROM binder_versions WHERE id = ?1').get('version-1'),
    ).toEqual({ capacity: 7 });
    expect(
      database.prepare('SELECT kind, label FROM binder_pages WHERE id = ?1').get('page-2'),
    ).toEqual({ kind: 'reserved', label: 'Trades' });
    expect(
      database
        .prepare(
          `SELECT page.id, COUNT(slot.binder_page_id) AS slots
           FROM binder_pages page
           LEFT JOIN binder_slots slot ON slot.binder_page_id = page.id
           WHERE page.binder_version_id = 'version-1'
           GROUP BY page.id ORDER BY page.position`,
        )
        .all(),
    ).toEqual([
      { id: 'page-1', slots: 4 },
      { id: 'page-2', slots: 3 },
    ]);
    expect(
      database
        .prepare(
          `SELECT entry_kind, card_id FROM binder_slots
           WHERE binder_page_id = 'page-1' AND row_index = 0 AND column_index = 0`,
        )
        .get(),
    ).toEqual({ entry_kind: 'exact-card', card_id: 'card-binder' });
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

  it('round-trips a frame-palette setting, an inventory event, and binder display columns', async () => {
    const { database, db, art } = setup();
    await seedReferencedArt(art);
    database.exec(`
      UPDATE binders SET peek_columns = 2, show_frame = 0, page_section = 'bookmark' WHERE id = 'binder-1';
      INSERT INTO user_settings (owner_id, key, value_json, updated_at)
      VALUES ('owner', 'frame-palette', '{"grass":"#00ff00"}', 1);
      INSERT INTO collection_events (id, owner_id, card_id, delta, source, slot_id, created_at)
      VALUES ('event-1', 'owner', 'card-binder', 1, 'add', NULL, 1);
    `);

    const backup = await createBackup(db, art, 'owner');
    database.exec(`
      DELETE FROM binders WHERE id = 'binder-1';
      DELETE FROM user_settings WHERE owner_id = 'owner';
      DELETE FROM collection_events WHERE owner_id = 'owner';
    `);

    await restoreBackup(db, art, 'owner', backup.id);

    expect(
      database
        .prepare('SELECT peek_columns, show_frame, page_section FROM binders WHERE id = ?1')
        .get('binder-1'),
    ).toEqual({ peek_columns: 2, show_frame: 0, page_section: 'bookmark' });
    expect(
      database
        .prepare('SELECT value_json FROM user_settings WHERE owner_id = ? AND key = ?')
        .get('owner', 'frame-palette'),
    ).toEqual({ value_json: '{"grass":"#00ff00"}' });
    expect(
      database.prepare('SELECT delta, source FROM collection_events WHERE id = ?1').get('event-1'),
    ).toEqual({ delta: 1, source: 'add' });
  });
});

describe('backups keep custom cards with their owner', () => {
  // setup()'s custom-a becomes 'owner's; 'other' gets a custom card of their
  // own, with a source and art, that 'owner' must never carry away.
  function twoUsers() {
    const context = setup();
    context.database.exec(`
      UPDATE catalogue_cards SET owner_id = 'owner' WHERE id = 'custom-a';
      INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id)
      VALUES ('page-1', 0, 1, NULL), ('page-1', 1, 0, NULL), ('page-1', 1, 1, NULL);
      INSERT INTO users (id, label, created_at) VALUES ('other', 'Other', 1);
      INSERT INTO catalogue_cards
        (id, name, language, category, set_id, set_name, number, number_sort, is_custom, owner_id, created_at, updated_at)
      VALUES ('custom-other', 'Other secret', 'en', 'custom', 'custom', 'Custom', '9', 9, 1, 'other', 1, 1);
      INSERT INTO card_sources
        (provider, source_id, card_id, language, source_updated_at, checksum, active, imported_at)
      VALUES ('manual', 'source-other', 'custom-other', 'en', 1, '${'e'.repeat(64)}', 1, 1);
      INSERT INTO art_manifest (card_id, variant, object_key, sha256, bytes, version, updated_at)
      VALUES ('custom-other', 'high', 'cards/custom-other/high/hash.webp', '${'e'.repeat(64)}', 20, 1, 1);
      INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at)
      VALUES ('owner', 'custom-a', 1, 1, 1), ('other', 'custom-other', 2, 1, 1);
    `);
    return context;
  }

  async function seedAllArt(art: R2Bucket): Promise<void> {
    await seedReferencedArt(art);
    await art.put('cards/custom-other/high/hash.webp', Uint8Array.from([7, 8, 9]));
  }

  async function backedUpRows(
    art: R2Bucket,
    ownerId: string,
    backupId: string,
  ): Promise<Record<string, Array<Record<string, unknown>>>> {
    const manifest = JSON.parse(
      await readObjectText(art, `backups/${ownerId}/${backupId}/manifest.json`),
    ) as { chunks: Array<{ kind: string; objectKey: string }> };
    const rows: Record<string, Array<Record<string, unknown>>> = {};
    for (const chunk of manifest.chunks)
      rows[chunk.kind] = [
        ...(rows[chunk.kind] ?? []),
        ...(JSON.parse(await readObjectText(art, chunk.objectKey)) as Array<
          Record<string, unknown>
        >),
      ];
    return rows;
  }

  function snapshot(database: DatabaseSync): Record<string, unknown[]> {
    return Object.fromEntries(
      [
        'SELECT * FROM catalogue_cards ORDER BY id',
        'SELECT * FROM card_sources ORDER BY source_id',
        'SELECT * FROM art_manifest ORDER BY card_id, variant',
        'SELECT * FROM collection_cards ORDER BY owner_id, card_id',
        'SELECT * FROM binders ORDER BY id',
        'SELECT * FROM binder_slots ORDER BY binder_page_id, row_index, column_index',
      ].map((sql) => [sql, database.prepare(sql).all()]),
    );
  }

  async function legacyBackup(
    database: DatabaseSync,
    art: R2Bucket,
    backupId: string,
    content: { catalogue?: unknown[]; collection?: unknown[] },
  ): Promise<void> {
    const body = JSON.stringify({
      version: 2,
      ownerId: 'owner',
      mutationEpoch: 0,
      createdAt: '2026-09-27T00:00:00.000Z',
      catalogue: content.catalogue ?? [],
      sources: [],
      collection: content.collection ?? [],
      binders: [],
      versions: [],
      pages: [],
      slots: [],
      artManifest: [],
    });
    const key = `backups/owner/${backupId}/legacy.json`;
    await art.put(key, body);
    database
      .prepare(
        "INSERT INTO backup_runs(id,owner_id,object_key,checksum,backup_epoch,created_at) VALUES(?1,'owner',?2,?3,0,1)",
      )
      .run(backupId, key, await checksum(body));
  }

  it("exports only the owner's own custom cards, sources and art, even when a stray row references another's", async () => {
    const { database, db, art } = twoUsers();
    await seedAllArt(art);
    // A reference to someone else's custom card, as the pre-ownership
    // collection check allowed.
    database.exec(`INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at)
      VALUES ('owner', 'custom-other', 1, 1, 1)`);
    const backup = await createBackup(db, art, 'owner', { backupId: 'backup_scoped' });
    const rows = await backedUpRows(art, 'owner', backup.id);
    expect(rows.catalogue?.map((row) => [row.id, row.owner_id])).toEqual([
      ['card-binder', null],
      ['custom-a', 'owner'],
    ]);
    expect(rows.sources?.map((row) => row.card_id)).toEqual(['custom-a']);
    expect(rows.art_manifest?.map((row) => row.card_id)).toEqual(['card-binder', 'custom-a']);
  });

  it('round-trips two users without either custom card changing hands or becoming shared', async () => {
    const { database, db, art } = twoUsers();
    await seedAllArt(art);
    const ownerBackup = await createBackup(db, art, 'owner', { backupId: 'backup_owner_rt' });
    const otherBackup = await createBackup(db, art, 'other', { backupId: 'backup_other_rt' });
    const otherRows = await backedUpRows(art, 'other', otherBackup.id);
    expect(otherRows.catalogue?.map((row) => row.id)).toEqual(['custom-other']);

    const before = snapshot(database);
    await restoreBackup(db, art, 'owner', ownerBackup.id);
    await restoreBackup(db, art, 'other', otherBackup.id);

    expect(
      database
        .prepare('SELECT id, owner_id FROM catalogue_cards WHERE is_custom = 1 ORDER BY id')
        .all(),
    ).toEqual([
      { id: 'custom-a', owner_id: 'owner' },
      { id: 'custom-other', owner_id: 'other' },
    ]);
    expect(snapshot(database)).toEqual(before);
  });

  it("restores a missing custom card as the restoring user's own, never as shared", async () => {
    const { database, db, art } = twoUsers();
    await seedAllArt(art);
    const backup = await createBackup(db, art, 'owner', { backupId: 'backup_missing_custom' });
    database.exec(`
      DELETE FROM collection_cards WHERE owner_id = 'owner';
      DELETE FROM card_sources WHERE card_id = 'custom-a';
      DELETE FROM art_manifest WHERE card_id = 'custom-a';
      DELETE FROM catalogue_search WHERE card_id = 'custom-a';
      DELETE FROM catalogue_cards WHERE id = 'custom-a';
    `);
    await restoreBackup(db, art, 'owner', backup.id);
    expect(
      database.prepare('SELECT owner_id FROM catalogue_cards WHERE id = ?').get('custom-a'),
    ).toEqual({ owner_id: 'owner' });
  });

  it('gives a legacy backup without owner info custom cards owned by the restoring user', async () => {
    const { database, db, art } = twoUsers();
    await legacyBackup(database, art, 'backup_legacy_custom', {
      catalogue: [
        {
          id: 'legacy-custom',
          name: 'Legacy custom',
          language: 'en',
          category: 'custom',
          set_id: 'custom',
          set_name: 'Custom',
          number: '5',
          supertype: null,
          subtype: null,
          species: null,
          rarity: null,
          artist: null,
          release_date: null,
          pokedex_number: null,
          number_sort: 5,
          is_custom: 1,
          is_active: 1,
          created_at: 1,
          updated_at: 1,
        },
      ],
      collection: [
        { card_id: 'legacy-custom', quantity: 1, notes: null, revision: 1, updated_at: 1 },
      ],
    });
    await restoreBackup(db, art, 'owner', 'backup_legacy_custom');
    expect(
      database.prepare('SELECT owner_id FROM catalogue_cards WHERE id = ?').get('legacy-custom'),
    ).toEqual({ owner_id: 'owner' });
  });

  it("refuses a backup that references another user's custom card and changes nothing", async () => {
    const { database, db, art } = twoUsers();
    await legacyBackup(database, art, 'backup_foreign_ref', {
      collection: [
        { card_id: 'custom-other', quantity: 1, notes: null, revision: 1, updated_at: 1 },
      ],
    });
    const before = snapshot(database);
    await expect(restoreBackup(db, art, 'owner', 'backup_foreign_ref')).rejects.toMatchObject({
      code: 'backup_owner_mismatch',
      status: 403,
    });
    expect(snapshot(database)).toEqual(before);
  });

  it('refuses a backup whose catalogue row claims another owner', async () => {
    const { database, db, art } = twoUsers();
    await seedAllArt(art);
    const backup = await createBackup(db, art, 'other', { backupId: 'backup_claims_other' });
    // 'other's exported rows, re-registered as one of 'owner's backups: the
    // catalogue row still says owner_id = 'other'.
    const rows = await backedUpRows(art, 'other', backup.id);
    await legacyBackup(database, art, 'backup_claims_owner', {
      catalogue: rows.catalogue ?? [],
    });
    const before = snapshot(database);
    await expect(restoreBackup(db, art, 'owner', 'backup_claims_owner')).rejects.toMatchObject({
      code: 'backup_owner_mismatch',
    });
    expect(snapshot(database)).toEqual(before);
  });
});
