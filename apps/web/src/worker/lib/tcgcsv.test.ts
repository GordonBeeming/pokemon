import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { importCatalogueLanguage, searchCards, type ImportedCard } from './catalogue';
import { supplementalArtCandidates } from './supplemental-art';
import {
  csvCard,
  csvProductSchema,
  csvImageUrl,
  importSupplementalProducts,
  matchingCsvGroups,
  matchingCsvProduct,
  supplementalArtUrl,
  supplementalSets,
  type CsvProduct,
} from './tcgcsv';

// Selected identity fields from the live TCGCSV products feed; the tests remain
// independent of feed updates and availability.
const mcdonalds: CsvProduct[] = z
  .array(csvProductSchema)
  .parse(
    JSON.parse(readFileSync(new URL('./fixtures/mcdonalds-2026.json', import.meta.url), 'utf8')),
  );
const birds: CsvProduct[] = z
  .array(csvProductSchema)
  .parse(JSON.parse(readFileSync(new URL('./fixtures/mep-birds.json', import.meta.url), 'utf8')));
const mcGroup = { groupId: 24938, name: "McDonald's Promos 2026", abbreviation: 'M26' };
const mepGroup = { groupId: 24451, name: 'ME: Mega Evolution Promo', abbreviation: 'MEP' };
const mcSet = {
  setId: 'mcdonalds-2026',
  setName: "McDonald's Collection 2026",
  abbreviation: 'M26',
};
const mepSet = { setId: 'mep', setName: 'MEP Black Star Promos', abbreviation: 'MEP' };
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const raw of databases.splice(0)) raw.close();
});
function setup() {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1)");
  return { raw, db: sqliteD1(raw) };
}

describe('supplemental catalogue', () => {
  it('discovers new McDonalds sets and imports all 15 real cards into search, idempotently', async () => {
    const { raw, db } = setup();
    expect(await supplementalSets(db, [mcGroup])).toEqual([{ group: mcGroup, set: mcSet }]);
    expect(await importSupplementalProducts(db, mcGroup, mcSet, mcdonalds)).toBe(15);
    await importSupplementalProducts(db, mcGroup, mcSet, mcdonalds);
    const result = await searchCards(db, 'owner', {
      language: 'en',
      setId: mcSet.setId,
      limit: 100,
      offset: 0,
    });
    expect(result.cards).toHaveLength(15);
    expect(await supplementalArtCandidates(db, 1)).toHaveLength(15);
    expect(result.cards.every((c) => c.imageLowUrl?.startsWith('/api/art/'))).toBe(true);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM card_sources').get()).toEqual({ n: 15 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM catalogue_search').get()).toEqual({ n: 15 });
    const first = result.cards.find((c) => c.name === 'Decidueye');
    expect(first).toBeDefined();
    if (!first) throw new Error('fixture_card_missing');
    // A verified source link can serve art without asking TCGdex or the feed again.
    expect(await supplementalArtUrl(db, {} as R2Bucket, first.id)).toBe(
      'https://tcgplayer-cdn.tcgplayer.com/product/730416_in_1000x1000.jpg',
    );
  });

  it('attaches promo art to an existing printing without overwriting richer metadata or ownership', async () => {
    const { raw, db } = setup();
    raw.exec(`INSERT INTO catalogue_sets(set_id,language,set_name,release_date,updated_at) VALUES('mep','en','MEP Black Star Promos','2025-09-26',1);
      INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,artist,created_at,updated_at)
      VALUES('moltres','Moltres','en','pokemon','mep','MEP Black Star Promos','096','Original Artist',1,1);
      INSERT INTO collection_cards(owner_id,card_id,quantity,updated_at) VALUES('owner','moltres',2,1);`);
    raw.exec("UPDATE catalogue_cards SET is_active=0 WHERE id='moltres'");
    await importSupplementalProducts(db, mepGroup, mepSet, birds);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM catalogue_cards').get()).toEqual({ n: 3 });
    expect(
      raw.prepare("SELECT artist,number FROM catalogue_cards WHERE id='moltres'").get(),
    ).toEqual({ artist: 'Original Artist', number: '096' });
    expect(raw.prepare("SELECT is_active FROM catalogue_cards WHERE id='moltres'").get()).toEqual({
      is_active: 1,
    });
    expect(raw.prepare("SELECT card_id FROM card_sources WHERE source_id='713264'").get()).toEqual({
      card_id: 'moltres',
    });
    expect(
      raw.prepare("SELECT quantity FROM collection_cards WHERE card_id='moltres'").get(),
    ).toEqual({ quantity: 2 });
    expect(raw.prepare("SELECT release_date FROM catalogue_sets WHERE set_id='mep'").get()).toEqual(
      { release_date: '2025-09-26' },
    );
  });

  it('keeps supplemental cards active through full primary syncs and adopts their IDs when the primary catches up', async () => {
    const { raw, db } = setup();
    await importSupplementalProducts(db, mcGroup, mcSet, mcdonalds);
    const first = raw.prepare("SELECT id FROM catalogue_cards WHERE name='Decidueye'").get();
    if (typeof first?.id !== 'string') throw new Error('fixture_card_missing');
    raw
      .prepare(
        "INSERT INTO collection_cards(owner_id,card_id,quantity,updated_at) VALUES('owner',?,1,1)",
      )
      .run(first.id);
    const primary: ImportedCard = {
      sourceId: 'other-1',
      name: 'Pikachu',
      language: 'en',
      category: 'pokemon',
      setId: 'other',
      setName: 'Other',
      number: '1',
      checksum: 'a'.repeat(64),
      sourceUpdatedAt: 1,
    };
    await importCatalogueLanguage(db, {
      provider: 'tcgdex',
      language: 'en',
      cards: [primary],
      complete: true,
    });
    expect(
      raw.prepare('SELECT COUNT(*) AS n FROM catalogue_cards WHERE is_active=1').get(),
    ).toEqual({ n: 16 });
    await importCatalogueLanguage(db, {
      provider: 'tcgdex',
      language: 'en',
      cards: [
        {
          ...primary,
          sourceId: '2026sv-001',
          setId: '2026sv',
          setName: mcSet.setName,
          name: 'Decidueye',
          number: '001',
        },
      ],
      complete: false,
    });
    const migrated = await supplementalSets(db, [mcGroup]);
    expect(migrated[0]?.set.setId).toBe('2026sv');
    const canonical = migrated[0]?.set;
    if (!canonical) throw new Error('canonical_set_missing');
    await importSupplementalProducts(db, mcGroup, canonical, mcdonalds);
    expect(
      raw
        .prepare('SELECT COUNT(DISTINCT set_id) AS n FROM catalogue_cards WHERE set_name=?')
        .get(mcSet.setName),
    ).toEqual({ n: 1 });
    expect(
      raw.prepare("SELECT id,number FROM catalogue_cards WHERE name='Decidueye'").all(),
    ).toEqual([{ id: first.id, number: '001' }]);
    expect(raw.prepare('SELECT card_id,quantity FROM collection_cards').get()).toEqual({
      card_id: first.id,
      quantity: 1,
    });
    const result = await searchCards(db, 'owner', { query: 'Decidueye', limit: 10, offset: 0 });
    expect(result.cards).toHaveLength(1);
  });

  it('rejects ambiguous products, unrelated printings, mismatched groups and image URLs', async () => {
    const { raw, db } = setup();
    const product = birds[0];
    if (!product) throw new Error('fixture_missing');
    expect(matchingCsvProduct(birds, mepGroup.groupId, { name: 'Moltres', number: '96' })).toEqual(
      product,
    );
    expect(
      matchingCsvProduct(birds, mepGroup.groupId, { name: 'Moltres', number: '97' }),
    ).toBeNull();
    expect(csvImageUrl({ ...product, imageUrl: 'https://evil.test/image.jpg' })).toBeNull();
    expect(
      csvImageUrl({
        ...product,
        imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/1_200w.jpg',
      }),
    ).toBeNull();
    expect(() => csvCard(product, 123)).toThrow('tcgcsv_group_mismatch');
    await importSupplementalProducts(db, mepGroup, mepSet, [
      product,
      {
        ...product,
        productId: 999,
        imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/999_200w.jpg',
      },
    ]);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM catalogue_cards').get()).toEqual({ n: 0 });
    expect(
      matchingCsvGroups([{ ...mepGroup, name: 'Japanese Promo', abbreviation: 'MEP' }], mepSet),
    ).toEqual([]);
    expect(await supplementalSets(db, [mcGroup, { ...mcGroup, groupId: 12 }, mepGroup])).toEqual([
      { group: mepGroup, set: mepSet },
    ]);
  });

  it('skips labelled variants and recognises extra whitespace without creating product-label cards', async () => {
    const { raw, db } = setup();
    const product = birds[0];
    if (!product) throw new Error('fixture_missing');
    for (const name of [
      'Moltres - 096 [Staff]',
      'Moltres - 096 (Winner)',
      'Moltres - 096 (Cosmos Holo)',
      'Moltres (Prerelease)',
      'Moltres - 096 (30th Celebration) (Pokemon Center Exclusive)',
    ])
      expect(csvCard({ ...product, name }, mepGroup.groupId)).toBeNull();
    expect(csvCard({ ...product, name: 'Moltres -  096' }, mepGroup.groupId)?.name).toBe('Moltres');
    const trainer = {
      ...product,
      productId: 999,
      name: 'Artazon - 120',
      imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/999_200w.jpg',
      extendedData: [
        { name: 'Number', value: '120' },
        { name: 'Card Type', value: 'Trainer - Stadium' },
      ],
    };
    await importSupplementalProducts(db, mepGroup, mepSet, [trainer]);
    expect(
      raw.prepare('SELECT category,name,supertype,subtype FROM catalogue_cards').get(),
    ).toEqual({
      category: 'trainer',
      name: 'Artazon',
      supertype: 'Trainer',
      subtype: 'Stadium',
    });
  });
});
