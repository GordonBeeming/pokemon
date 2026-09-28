import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listCatalogueSets, setCatalogueSetCode } from './catalogue';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.unstubAllGlobals();
});

function setup(): D1Database {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`
    INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);
    INSERT INTO catalogue_sets(set_id,language,set_name,release_date,abbreviation,abbreviation_source,updated_at)
    VALUES
      ('sv08','en','Surging Sparks','2024-11-08','SSP','tcgdex',1),
      ('30th','en','30th Anniversary','2026-01-01','30C','tcgdex',1),
      ('30th-c','en','30th Anniversary Collection','2026-02-01','30C','tcgdex',1),
      ('all-pocket','en','Pocket Only Set',NULL,NULL,NULL,1);
    INSERT INTO catalogue_cards
      (id,name,language,category,set_id,set_name,number,is_active,created_at,updated_at)
    VALUES
      ('sv08-1','Card One','en','pokemon','sv08','Surging Sparks','1',1,1,1),
      ('30th-1','Card Two','en','pokemon','30th','30th Anniversary','1',1,1,1),
      ('30th-c-1','Card Three','en','pokemon','30th-c','30th Anniversary Collection','1',1,1,1),
      ('pocket-1','Pocket Mon','en','pokemon','all-pocket','Pocket Only Set','1',0,1,1);
  `);
  return sqliteD1(raw);
}

describe('listCatalogueSets', () => {
  it('reports card counts, codes, and never lists a Pocket-only set', async () => {
    const db = setup();
    const { sets } = await listCatalogueSets(db);
    expect(sets.map((set) => set.setId)).toEqual(['sv08', '30th', '30th-c']);
    expect(sets.find((set) => set.setId === 'sv08')).toMatchObject({
      setName: 'Surging Sparks',
      releaseDate: '2024-11-08',
      cardCount: 1,
      code: 'SSP',
      codeSource: 'tcgdex',
    });
  });

  it('reports a code shared by two sets as a clash', async () => {
    const db = setup();
    const { codeClashes } = await listCatalogueSets(db);
    expect(codeClashes).toEqual([{ code: '30C', setIds: ['30th', '30th-c'] }]);
  });
});

describe('setCatalogueSetCode', () => {
  it('sets an owner code and marks the source owner, never overwritten by the code alone', async () => {
    const db = setup();
    await setCatalogueSetCode(db, 'sv08', 'CUSTOM');
    const { sets } = await listCatalogueSets(db);
    expect(sets.find((set) => set.setId === 'sv08')).toMatchObject({
      code: 'CUSTOM',
      codeSource: 'owner',
    });
  });

  it('restores the TCGdex value on clear when the live lookup finds one', async () => {
    const db = setup();
    await setCatalogueSetCode(db, 'sv08', 'CUSTOM');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ abbreviation: { official: 'SSP' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    await setCatalogueSetCode(db, 'sv08', null);
    const { sets } = await listCatalogueSets(db);
    expect(sets.find((set) => set.setId === 'sv08')).toMatchObject({
      code: 'SSP',
      codeSource: 'tcgdex',
    });
  });

  it('clears to unset when the TCGdex lookup fails or has nothing', async () => {
    const db = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    );
    await setCatalogueSetCode(db, 'sv08', null);
    const { sets } = await listCatalogueSets(db);
    expect(sets.find((set) => set.setId === 'sv08')).toMatchObject({
      code: null,
      codeSource: null,
    });
  });

  it('rejects an unknown set', async () => {
    const db = setup();
    await expect(setCatalogueSetCode(db, 'missing-set', 'ABC')).rejects.toMatchObject({
      code: 'catalogue_set_not_found',
      status: 404,
    });
  });
});
