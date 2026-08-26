import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import {
  applyStagedPrices,
  beginPriceSyncRun,
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
