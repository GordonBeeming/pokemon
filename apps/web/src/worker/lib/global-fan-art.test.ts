import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listArtManifest } from './art';
import { getCardDetail, resolveCatalogueCards, searchCards } from './catalogue';
import { incrementCollectionQuantity, patchCollectionNotes } from './collection';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const repair = readFileSync(
  new URL('../../../repairs/global-fan-art.sql', import.meta.url),
  'utf8',
);
const mimikyu = 'custom_4c705272-b14d-4dfc-adf9-9cfbb8e76f91';
const snorlax = 'custom_f9c57bdb-852c-4cab-9e55-73c79901d4ae';
let raw: DatabaseSync;
let db: D1Database;

beforeEach(() => {
  raw = new DatabaseSync(':memory:');
  applyAllMigrations(raw);
  db = sqliteD1(raw);
  raw.exec(
    `INSERT INTO users (id,label,created_at) VALUES ('owner','Parent',1),('daughter','Daughter',1);`,
  );
  const cards: Array<[string, string, string]> = [
    [mimikyu, 'Mimikyu ex (Unofficial fan art)', '052/055'],
    [snorlax, 'Snorlax (Batman, Unofficial fan art)', '027/055'],
    ['private-custom', 'Private Mimikyu', '001/055'],
  ];
  for (const [id, name, number] of cards) {
    raw
      .prepare(
        `INSERT INTO catalogue_cards
      (id,name,language,category,set_id,set_name,number,is_custom,owner_id,created_at,updated_at)
      VALUES (?,?,'en','pokemon','unofficial-fan-art-055','Unofficial fan art',?,1,'owner',1,1)`,
      )
      .run(id, name, number);
    raw
      .prepare(
        `INSERT INTO catalogue_search (card_id,name,set_name,number,species,rarity,artist)
      VALUES (?,?,'Unofficial fan art',?,'','','')`,
      )
      .run(id, name, number);
    for (const variant of ['high', 'low']) {
      raw
        .prepare(
          `INSERT INTO art_manifest (card_id,variant,object_key,sha256,bytes,version,updated_at)
        VALUES (?,?,? ,?,10,1,1)`,
        )
        .run(id, variant, `cards/${id}/${variant}/art.webp`, 'a'.repeat(64));
    }
  }
});

afterEach(() => raw.close());

describe('global fan-art promotion', () => {
  it('shares only the two printings and their existing art with another account', async () => {
    expect(await getCardDetail(db, 'daughter', mimikyu)).toBeNull();
    raw.exec(repair);

    const visible = await searchCards(db, 'daughter', {
      query: 'Unofficial',
      limit: 100,
      offset: 0,
    });
    expect(visible.cards.map((card) => card.id).sort()).toEqual([mimikyu, snorlax].sort());
    const detail = await getCardDetail(db, 'daughter', mimikyu);
    expect(detail).toMatchObject({
      name: 'Mimikyu ex (Unofficial fan art)',
      source: { provider: 'fan-art' },
      imageHighUrl: `/api/art/${mimikyu}/high`,
      imageLowUrl: `/api/art/${mimikyu}/low`,
    });
    const resolved = await resolveCatalogueCards(db, 'daughter', [
      mimikyu,
      snorlax,
      'private-custom',
    ]);
    expect(resolved.map((card) => card.id).sort()).toEqual([mimikyu, snorlax].sort());
    const art = await listArtManifest(db, 'daughter', null, 100);
    expect(art.entries).toHaveLength(4);
    expect(art.entries.every((entry) => [mimikyu, snorlax].includes(entry.cardId))).toBe(true);
    expect(await getCardDetail(db, 'daughter', 'private-custom')).toBeNull();
    expect(
      raw.prepare('SELECT owner_id,is_custom FROM catalogue_cards WHERE id=?').get(mimikyu),
    ).toEqual({ owner_id: null, is_custom: 1 });
  });

  it('keeps each account quantity and notes independent', async () => {
    raw.exec(repair);
    await incrementCollectionQuantity(db, 'owner', {
      cardId: mimikyu,
      mutationId: crypto.randomUUID(),
      delta: 2,
    });
    await incrementCollectionQuantity(db, 'daughter', {
      cardId: mimikyu,
      mutationId: crypto.randomUUID(),
      delta: 1,
    });
    await patchCollectionNotes(db, 'owner', {
      cardId: mimikyu,
      mutationId: crypto.randomUUID(),
      notes: 'Parent copy',
    });
    await patchCollectionNotes(db, 'daughter', {
      cardId: mimikyu,
      mutationId: crypto.randomUUID(),
      notes: 'Daughter copy',
    });
    expect((await getCardDetail(db, 'owner', mimikyu))?.collection).toMatchObject({
      quantity: 2,
      notes: 'Parent copy',
    });
    expect((await getCardDetail(db, 'daughter', mimikyu))?.collection).toMatchObject({
      quantity: 1,
      notes: 'Daughter copy',
    });
  });

  it('is safe to rerun without changing artwork or personal data', () => {
    raw.exec(repair);
    const snapshot = () => ({
      cards: raw.prepare('SELECT * FROM catalogue_cards ORDER BY id').all(),
      sources: raw.prepare('SELECT * FROM card_sources ORDER BY card_id').all(),
      art: raw.prepare('SELECT * FROM art_manifest ORDER BY card_id,variant').all(),
    });
    const before = snapshot();
    raw.exec(repair);
    expect(snapshot()).toEqual(before);
  });

  it('refuses a mismatched design even if its ID matches', () => {
    raw.prepare('UPDATE catalogue_cards SET number=? WHERE id=?').run('051/055', mimikyu);
    raw.exec(repair);
    expect(raw.prepare('SELECT owner_id FROM catalogue_cards WHERE id=?').get(mimikyu)).toEqual({
      owner_id: 'owner',
    });
    expect(raw.prepare('SELECT 1 FROM card_sources WHERE card_id=?').get(mimikyu)).toBeUndefined();
  });

  it('leaves a printing private until both artwork sizes exist', () => {
    raw.prepare('DELETE FROM art_manifest WHERE card_id=? AND variant=?').run(mimikyu, 'low');
    raw.exec(repair);
    expect(raw.prepare('SELECT owner_id FROM catalogue_cards WHERE id=?').get(mimikyu)).toEqual({
      owner_id: 'owner',
    });
    expect(raw.prepare('SELECT 1 FROM card_sources WHERE card_id=?').get(mimikyu)).toBeUndefined();
  });
});
