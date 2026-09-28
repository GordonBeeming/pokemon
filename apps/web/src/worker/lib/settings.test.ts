import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_FRAME_PALETTE } from '@pokedex/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { frameColour, getFramePalette, resetFramePalette, setFramePalette } from './settings';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(): D1Database {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  applyAllMigrations(db);
  db.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);");
  return sqliteD1(db);
}

describe('frame palette settings', () => {
  it('has no overrides until one is set', async () => {
    const db = setup();
    expect(await getFramePalette(db, 'owner')).toEqual({});
    expect(frameColour({}, 'grass')).toBe(DEFAULT_FRAME_PALETTE.grass);
  });

  it('stores and retrieves a partial palette override', async () => {
    const db = setup();
    await setFramePalette(db, 'owner', { grass: '#00ff00' });
    expect(await getFramePalette(db, 'owner')).toEqual({ grass: '#00ff00' });
    expect(frameColour({ grass: '#00ff00' }, 'grass')).toBe('#00ff00');
    expect(frameColour({ grass: '#00ff00' }, 'fire')).toBe(DEFAULT_FRAME_PALETTE.fire);
  });

  it('overwrites a previous override rather than merging', async () => {
    const db = setup();
    await setFramePalette(db, 'owner', { grass: '#00ff00', fire: '#ff0000' });
    await setFramePalette(db, 'owner', { grass: '#123456' });
    expect(await getFramePalette(db, 'owner')).toEqual({ grass: '#123456' });
  });

  it('resets to no overrides', async () => {
    const db = setup();
    await setFramePalette(db, 'owner', { grass: '#00ff00' });
    await resetFramePalette(db, 'owner');
    expect(await getFramePalette(db, 'owner')).toEqual({});
  });

  it('scopes palettes per owner', async () => {
    const db = setup();
    await db.exec("INSERT INTO users(id,label,created_at) VALUES('other','Other',1);");
    await setFramePalette(db, 'owner', { grass: '#00ff00' });
    expect(await getFramePalette(db, 'other')).toEqual({});
  });
});
