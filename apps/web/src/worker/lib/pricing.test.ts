import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import {
  applyStagedPrices,
  beginPriceSyncRun,
  cardRowsForPriceSources,
  cardSourcePage,
  inUseCardSourceIds,
  nextPriceChainLink,
  priceForCard,
  stagePrices,
  stagePriceTargets,
  upsertFxRate,
} from './pricing';

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function priceDatabase(): { database: DatabaseSync; db: D1Database } {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(database);
  database.exec(`
    INSERT INTO catalogue_cards
      (id, name, language, category, set_id, set_name, number, created_at, updated_at)
    VALUES ('card-1', 'Squirtle', 'en', 'pokemon', 'set-1', 'Set', '7', 1, 1);
  `);
  return { database, db: sqliteD1(database) };
}

describe('price source availability', () => {
  it('keeps every active source for one card in the same pricing page', async () => {
    const { database, db } = priceDatabase();
    database.exec(`
      INSERT INTO catalogue_cards
        (id, name, language, category, set_id, set_name, number, created_at, updated_at)
      VALUES
        ('card-2', 'Wartortle', 'en', 'pokemon', 'set-1', 'Set', '8', 1, 1),
        ('card-fr', 'Carapuce', 'fr', 'pokemon', 'set-1', 'Set', '7', 1, 1);
      INSERT INTO card_sources
        (provider, source_id, card_id, language, source_updated_at, checksum, active, imported_at)
      VALUES
        ('tcgdex', 'source-a', 'card-1', 'en', 1, '${'a'.repeat(64)}', 1, 1),
        ('tcgdex', 'source-b', 'card-1', 'en', 1, '${'b'.repeat(64)}', 1, 1),
        ('tcgdex', 'source-c', 'card-2', 'en', 1, '${'c'.repeat(64)}', 1, 1),
        ('tcgdex', 'source-a', 'card-fr', 'fr', 1, '${'d'.repeat(64)}', 1, 1);
    `);

    await expect(cardSourcePage(db, 1)).resolves.toEqual({
      ids: ['source-a', 'source-b'],
      cursor: 'card-1',
      last: false,
    });
    await expect(
      cardRowsForPriceSources(db, [
        {
          sourceId: 'source-a',
          candidates: [
            {
              source: 'tcgplayer',
              nativeAmount: 10,
              nativeCurrency: 'USD',
              sourceCapturedAt: 1,
            },
          ],
        },
      ]),
    ).resolves.toMatchObject({ cardIds: ['card-1'], rows: [{ cardId: 'card-1' }] });
  });

  it('stops displaying a source after a refreshed card no longer has that price', async () => {
    const { database, db } = priceDatabase();
    await upsertFxRate(db, '2026-08-26', 'USD', 1.5);

    await beginPriceSyncRun(db, 'run-1');
    await stagePriceTargets(db, 'run-1', ['card-1']);
    await stagePrices(db, 'run-1', [
      {
        cardId: 'card-1',
        source: 'tcgplayer',
        nativeAmount: 10,
        nativeCurrency: 'USD',
        sourceCapturedAt: 10,
      },
    ]);
    await applyStagedPrices(db, 'run-1', '2026-08-26');
    await expect(priceForCard(db, 'card-1')).resolves.toMatchObject({
      source: 'tcgplayer',
      amountAud: 15,
    });

    await beginPriceSyncRun(db, 'run-2');
    await stagePriceTargets(db, 'run-2', ['card-1']);
    await applyStagedPrices(db, 'run-2', '2026-08-26');

    await expect(priceForCard(db, 'card-1')).resolves.toMatchObject({
      source: null,
      amountAud: null,
    });
    expect(
      database
        .prepare(
          "SELECT available FROM price_source_availability WHERE card_id = 'card-1' ORDER BY source",
        )
        .all(),
    ).toEqual([{ available: 0 }, { available: 0 }]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM price_snapshots').get()).toEqual({
      count: 1,
    });
  });
});

describe('in-use price sources', () => {
  it('selects cards that are owned, targeted in a binder, or placed in one, and nothing else', async () => {
    const { database, db } = priceDatabase();
    database.exec(`
      INSERT INTO users (id, label, created_at) VALUES ('owner', 'Owner', 1);
      INSERT INTO catalogue_cards
        (id, name, language, category, set_id, set_name, number, created_at, updated_at)
      VALUES
        ('card-owned', 'Owned', 'en', 'pokemon', 'set-1', 'Set', '1', 1, 1),
        ('card-target', 'Target', 'en', 'pokemon', 'set-1', 'Set', '2', 1, 1),
        ('card-placed', 'Placed', 'en', 'pokemon', 'set-1', 'Set', '3', 1, 1),
        ('card-zero', 'Zero copies', 'en', 'pokemon', 'set-1', 'Set', '4', 1, 1),
        ('card-unused', 'Unused', 'en', 'pokemon', 'set-1', 'Set', '5', 1, 1);
      INSERT INTO card_sources (provider, source_id, card_id, language, source_updated_at, checksum, active, imported_at)
      VALUES
        ('tcgdex', 'src-owned', 'card-owned', 'en', 1, 'c', 1, 1),
        ('tcgdex', 'src-target', 'card-target', 'en', 1, 'c', 1, 1),
        ('tcgdex', 'src-placed', 'card-placed', 'en', 1, 'c', 1, 1),
        ('tcgdex', 'src-zero', 'card-zero', 'en', 1, 'c', 1, 1),
        ('tcgdex', 'src-unused', 'card-unused', 'en', 1, 'c', 1, 1);
      INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at)
      VALUES ('owner', 'card-owned', 1, 1, 1), ('owner', 'card-zero', 0, 1, 1),
        ('owner', 'card-placed', 1, 1, 1);
      INSERT INTO binders (id, owner_id, name, created_at, updated_at)
      VALUES ('binder-1', 'owner', 'Binder', 1, 1);
      INSERT INTO binder_versions (id, binder_id, version_number, status, layout_kind, rows, columns, created_at)
      VALUES ('version-1', 'binder-1', 1, 'draft', '2x2', 2, 2, 1);
      INSERT INTO binder_pages (id, binder_version_id, position, kind) VALUES ('page-1', 'version-1', 0, 'slots');
      INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id, entry_kind, assigned_card_id)
      VALUES
        ('page-1', 0, 0, 'card-target', 'exact-card', NULL),
        ('page-1', 0, 1, 'card-placed', 'exact-card', 'card-placed');
    `);
    expect(await inUseCardSourceIds(db)).toEqual(['src-owned', 'src-placed', 'src-target']);
  });
});

describe('whole-catalogue price refresh chain', () => {
  it('starts the next page until the catalogue ends, and never runs away', () => {
    expect(nextPriceChainLink({ id: 'prices-all-x', page: 0 }, false)).toEqual({
      instanceId: 'prices-all-x-p1',
      chain: { id: 'prices-all-x', page: 1 },
    });
    expect(nextPriceChainLink({ id: 'prices-all-x', page: 7 }, true)).toBeNull();
    expect(nextPriceChainLink({ id: 'prices-all-x', page: 59 }, false)).toBeNull();
  });
});
