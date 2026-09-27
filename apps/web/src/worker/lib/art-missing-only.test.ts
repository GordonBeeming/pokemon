import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { createArtUploadToken } from './art';
it('issues first-version-only tickets and refuses to replace existing artwork', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    applyAllMigrations(database);
    database.exec(`INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);
      INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,created_at,updated_at)
      VALUES('card','Card','en','pokemon','set','Set','1',1,1);`);
    const db = sqliteD1(database);
    await createArtUploadToken(db, 'owner', 'card', 'low', 'a'.repeat(64), 100, true);
    expect(database.prepare('SELECT expected_version FROM art_upload_tokens').get()).toEqual({
      expected_version: 1,
    });
    database.exec(`INSERT INTO art_manifest(card_id,variant,object_key,sha256,bytes,version,updated_at)
      VALUES('card','low','existing','${'b'.repeat(64)}',100,1,1)`);
    await expect(
      createArtUploadToken(db, 'owner', 'card', 'low', 'c'.repeat(64), 100, true),
    ).rejects.toMatchObject({ code: 'art_already_exists', status: 409 });
    expect(database.prepare('SELECT object_key FROM art_manifest').get()).toEqual({
      object_key: 'existing',
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM art_upload_tokens').get()).toEqual({
      count: 1,
    });
  } finally {
    database.close();
  }
});
