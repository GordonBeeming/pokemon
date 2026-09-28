import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { brisbaneDay, runNightlyJobs, runningCatalogueSync, type NightlyJobs } from './nightly';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(): { raw: DatabaseSync; db: D1Database } {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`INSERT INTO users (id, label, role, created_at) VALUES
    ('owner', 'Owner', 'admin', 1), ('kid', 'Kid', 'member', 1)`);
  return { raw, db: sqliteD1(raw) };
}

function jobs(db: D1Database, now: Date, overrides: Partial<NightlyJobs> = {}) {
  const started: string[] = [];
  const plan: NightlyJobs = {
    db,
    now,
    startFx: (id) => Promise.resolve(started.push(`fx ${id}`)),
    startPrices: (id, scope) => Promise.resolve(started.push(`prices:${scope} ${id}`)),
    startCatalogue: (id) => Promise.resolve(started.push(`catalogue ${id}`)),
    startBackup: (ownerId) => {
      started.push(`backup ${ownerId}`);
      return Promise.resolve({ id: `backup-${ownerId}` });
    },
    runningCatalogueSync: () => Promise.resolve(null),
    ...overrides,
  };
  return { plan, started };
}

// 17:00 UTC on a Friday is 3am Saturday in Brisbane; on a Saturday it is 3am Sunday.
const SATURDAY_3AM_BRISBANE = new Date('2026-10-02T17:00:00Z');
const SUNDAY_3AM_BRISBANE = new Date('2026-10-03T17:00:00Z');

describe('nightly jobs', () => {
  it('dates runs in Brisbane time', () => {
    expect(brisbaneDay(SATURDAY_3AM_BRISBANE)).toEqual({ date: '20261003', weekday: 6 });
    expect(brisbaneDay(SUNDAY_3AM_BRISBANE)).toEqual({ date: '20261004', weekday: 0 });
  });

  it('runs exchange rates, both price passes and every active backup, but no catalogue sync mid-week', async () => {
    const { db } = setup();
    const { plan, started } = jobs(db, SATURDAY_3AM_BRISBANE);
    await runNightlyJobs(plan);
    expect(started).toEqual([
      'fx fx-nightly-20261003',
      'prices:in-use prices-in-use-20261003',
      'prices:catalogue prices-catalogue-20261003',
      'backup kid',
      'backup owner',
    ]);
  });

  it('adds the weekly catalogue sync on Sunday mornings', async () => {
    const { db } = setup();
    const { plan, started } = jobs(db, SUNDAY_3AM_BRISBANE);
    await runNightlyJobs(plan);
    expect(started).toContain('catalogue catalogue-weekly-20261004');
  });

  it('skips the catalogue sync when one is already running', async () => {
    const { db } = setup();
    const { plan, started } = jobs(db, SUNDAY_3AM_BRISBANE, {
      runningCatalogueSync: () => Promise.resolve('catalogue-manual'),
    });
    await runNightlyJobs(plan);
    expect(started.some((entry) => entry.startsWith('catalogue'))).toBe(false);
  });

  it('keeps going when one job fails to start, and never throws', async () => {
    const { db } = setup();
    const { plan, started } = jobs(db, SUNDAY_3AM_BRISBANE, {
      startFx: () => Promise.reject(new Error('instance already exists')),
      runningCatalogueSync: () => Promise.reject(new Error('d1 unavailable')),
    });
    await expect(runNightlyJobs(plan)).resolves.toBeUndefined();
    expect(started).toEqual([
      'prices:in-use prices-in-use-20261004',
      'prices:catalogue prices-catalogue-20261004',
      'backup kid',
      'backup owner',
    ]);
  });

  it('skips disabled users when backing up', async () => {
    const { raw, db } = setup();
    raw.exec(`UPDATE users SET disabled_at = 1 WHERE id = 'kid'`);
    const { plan, started } = jobs(db, SATURDAY_3AM_BRISBANE);
    await runNightlyJobs(plan);
    expect(started.filter((entry) => entry.startsWith('backup'))).toEqual(['backup owner']);
  });
});

describe('runningCatalogueSync', () => {
  it('returns a live run and retires a dead one', async () => {
    const { raw, db } = setup();
    raw.exec(`INSERT INTO sync_runs (id, provider, language, started_at, status, complete_source)
      VALUES ('sync_catalogue-a', 'tcgdex', 'en', 1, 'running', 1)`);
    expect(await runningCatalogueSync(db, () => Promise.resolve('running'))).toBe('catalogue-a');
    expect(await runningCatalogueSync(db, () => Promise.resolve('errored'))).toBeNull();
    expect(raw.prepare("SELECT status FROM sync_runs WHERE id = 'sync_catalogue-a'").get()).toEqual(
      { status: 'failed' },
    );
  });
});
