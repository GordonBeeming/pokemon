import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { listIllustrators } from './illustrators';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup(): { database: DatabaseSync; db: D1Database } {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  applyAllMigrations(database);
  database.exec(`
    INSERT INTO users (id, label, created_at) VALUES ('owner-a', 'Owner A', 1), ('owner-b', 'Owner B', 1);

    INSERT INTO catalogue_sets (set_id, language, set_name, release_date, updated_at) VALUES
      ('set-older', 'en', 'Set Older', '2019-01-01', 1),
      ('set-old', 'en', 'Set Old', '2020-01-01', 1),
      ('set-new', 'en', 'Set New', '2023-01-01', 1);

    INSERT INTO catalogue_cards
      (id, name, language, category, set_id, set_name, number, number_sort, artist, is_active, is_custom, created_at, updated_at)
    VALUES
      ('card-old', 'Card Old', 'en', 'pokemon', 'set-old', 'Set Old', '1', 1, 'Ada Test', 1, 0, 1, 1),
      ('card-new-noart', 'Card New', 'en', 'pokemon', 'set-new', 'Set New', '1', 1, 'Ada Test', 1, 0, 1, 1),
      ('card-older-owned', 'Card Older Owned', 'en', 'pokemon', 'set-older', 'Set Older', '2', 2, 'Ada Test', 1, 0, 1, 1),
      ('card-inactive', 'Card Inactive', 'en', 'pokemon', 'set-old', 'Set Old', '9', 9, 'Ada Test', 0, 0, 1, 1),
      ('card-custom', 'Card Custom', 'en', 'pokemon', 'set-old', 'Set Old', '10', 10, 'Ada Test', 1, 1, 1, 1),
      ('card-zed', 'Card Zed', 'en', 'pokemon', 'set-old', 'Set Old', '5', 5, 'Zed Other', 1, 0, 1, 1);
    UPDATE catalogue_cards SET owner_id = 'owner-a' WHERE id = 'card-custom';

    INSERT INTO art_manifest (card_id, variant, object_key, sha256, bytes, updated_at)
    VALUES ('card-old', 'low', 'key-card-old-low', 'hash', 10, 1),
      ('card-inactive', 'low', 'key-card-inactive-low', 'hash', 10, 1);

    INSERT INTO card_sources (provider, source_id, card_id, language, source_updated_at, checksum, active, imported_at)
    VALUES ('tcgdex', 'src-card-older-owned', 'card-older-owned', 'en', 1, 'hash', 1, 1);

    INSERT INTO collection_cards (owner_id, card_id, quantity, notes, revision, updated_at)
    VALUES ('owner-a', 'card-older-owned', 2, NULL, 1, 1);
  `);
  return { database, db: sqliteD1(database) };
}

describe('listIllustrators', () => {
  it('counts active, non-custom cards per artist, scoped to this owner', async () => {
    const { db } = setup();
    const illustrators = await listIllustrators(db, 'owner-a');
    const ada = illustrators.find((entry) => entry.name === 'Ada Test');
    expect(ada).toMatchObject({ cardCount: 3, ownedCount: 1 });
  });

  it('prefers an owned card as the representative, then falls back to a card with art', async () => {
    const { db } = setup();
    const forOwnerA = await listIllustrators(db, 'owner-a');
    // owner-a owns card-older-owned, so it wins even though it's neither the
    // newest set nor the only card with art.
    expect(forOwnerA.find((entry) => entry.name === 'Ada Test')?.representative.id).toBe(
      'card-older-owned',
    );

    const forOwnerB = await listIllustrators(db, 'owner-b');
    // owner-b owns nothing by Ada Test: the fallback is the card with art
    // (card-old), not the newer but art-less card-new-noart.
    expect(forOwnerB.find((entry) => entry.name === 'Ada Test')?.representative.id).toBe(
      'card-old',
    );
  });

  it('excludes inactive and custom cards from every count and from ever being the representative', async () => {
    const { db } = setup();
    const illustrators = await listIllustrators(db, 'owner-a');
    const ada = illustrators.find((entry) => entry.name === 'Ada Test');
    expect(ada?.cardCount).toBe(3);
    const representativeIds = illustrators.map((entry) => entry.representative.id);
    expect(representativeIds).not.toContain('card-inactive');
    expect(representativeIds).not.toContain('card-custom');
  });

  it("never lets user B's owned cards affect user A's ownedCount or representative", async () => {
    const { database, db } = setup();
    // owner-b owns a *different* card by the same artist than owner-a does.
    database.exec(
      "INSERT INTO collection_cards (owner_id, card_id, quantity, notes, revision, updated_at) VALUES ('owner-b', 'card-old', 1, NULL, 1, 1)",
    );

    const forOwnerA = await listIllustrators(db, 'owner-a');
    const ada = forOwnerA.find((entry) => entry.name === 'Ada Test');
    expect(ada?.ownedCount).toBe(1);
    expect(ada?.representative.id).toBe('card-older-owned');

    const forOwnerB = await listIllustrators(db, 'owner-b');
    const adaForB = forOwnerB.find((entry) => entry.name === 'Ada Test');
    expect(adaForB?.ownedCount).toBe(1);
    expect(adaForB?.representative.id).toBe('card-old');
  });

  it('sorts illustrators alphabetically, case-insensitively', async () => {
    const { db } = setup();
    const illustrators = await listIllustrators(db, 'owner-a');
    expect(illustrators.map((entry) => entry.name)).toEqual(['Ada Test', 'Zed Other']);
  });
});
