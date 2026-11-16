import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginStagedCatalogueRun, stageCatalogueCards } from './catalogue';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import {
  catalogueRestartPending,
  recordCatalogueExecutionError,
  restoreUnappliedCatalogueRun,
  resumeCachedCatalogueSync,
} from './catalogue-recovery';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1)");
  return { raw, db: sqliteD1(raw) };
}
const card = {
  sourceId: 'me06-106',
  checksum: 'a'.repeat(64),
  sourceUpdatedAt: 1,
  name: 'Growlithe',
  language: 'en' as const,
  category: 'pokemon' as const,
  setId: 'me06',
  setName: 'Delta Reign',
  number: '106',
};
function failed(raw: DatabaseSync, id = 'workflow_catalogue-test') {
  raw
    .prepare(
      `INSERT INTO sync_runs(id,provider,language,started_at,completed_at,status,complete_source,refusal_reason)
 VALUES(?,'tcgdex','en',1,2,'failed',1,'execution interrupted')`,
    )
    .run(id);
}
describe('catalogue replay and recovery', () => {
  it('records an execution error without blocking the engine’s later staging replay', async () => {
    const { raw, db } = setup();
    await beginStagedCatalogueRun(db, 'en', { runId: 'workflow_catalogue-test' });
    await recordCatalogueExecutionError(db, 'workflow_catalogue-test', 'execution interrupted');
    expect(raw.prepare('SELECT status,refusal_reason FROM sync_runs').get()).toEqual({
      status: 'running',
      refusal_reason: 'execution interrupted',
    });
    await stageCatalogueCards(db, 'workflow_catalogue-test', [card]);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM catalogue_stage_cards').get()).toEqual({
      count: 1,
    });
  });
  it('restores only unapplied tracking and preserves its original failure in the audit', async () => {
    const { raw, db } = setup();
    failed(raw);
    await restoreUnappliedCatalogueRun(db, 'workflow_catalogue-test', 'owner');
    expect(raw.prepare('SELECT status,completed_at,refusal_reason FROM sync_runs').get()).toEqual({
      status: 'running',
      completed_at: null,
      refusal_reason: null,
    });
    const audit = raw.prepare('SELECT actor,action,meta FROM audit').get() as {
      actor: string;
      action: string;
      meta: string;
    };
    expect(audit.actor).toBe('owner');
    expect(audit.action).toBe('catalogue.sync_tracking_recovered');
    expect(JSON.parse(audit.meta)).toMatchObject({
      previousFailure: 'execution interrupted',
      previousCompletedAt: 2,
    });
    await stageCatalogueCards(db, 'workflow_catalogue-test', [card]);
  });
  it.each(['applied', 'newer', 'ordinary', 'other-running', 'claimed'])(
    'refuses unsafe recovery: %s',
    async (scenario) => {
      const { raw, db } = setup();
      failed(raw, scenario === 'ordinary' ? 'sync_ordinary' : 'workflow_catalogue-test');
      if (scenario === 'claimed')
        raw.exec(
          "INSERT INTO sync_run_claims(run_id,claim_token,claimed_at) VALUES('workflow_catalogue-test','already-claimed',1)",
        );
      if (scenario === 'applied') raw.exec('UPDATE sync_runs SET source_count=1,imported_count=1');
      if (scenario === 'newer')
        raw.exec(
          "INSERT INTO sync_runs(id,provider,language,started_at,status,complete_source) VALUES('workflow_newer','tcgdex','en',3,'complete',1)",
        );
      if (scenario === 'other-running')
        raw.exec(
          "INSERT INTO sync_runs(id,provider,language,started_at,status,complete_source) VALUES('workflow_other','tcgdex','en',0,'running',1)",
        );
      await expect(
        restoreUnappliedCatalogueRun(
          db,
          scenario === 'ordinary' ? 'sync_ordinary' : 'workflow_catalogue-test',
          'owner',
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM audit').get()).toEqual({ count: 0 });
    },
  );
  it('resumes the first staging step while retaining all earlier fetch checkpoints', async () => {
    const { raw, db } = setup();
    failed(raw);
    const restart = vi.fn(() => Promise.resolve());
    const result = await resumeCachedCatalogueSync(db, 'owner', () =>
      Promise.resolve({
        status: () =>
          Promise.resolve({
            status: 'errored',
            error: { name: 'Error', message: 'ApplicationError: staged_sync_not_running' },
          }),
        restart,
      }),
    );
    expect(result).toEqual({
      workflowId: 'catalogue-test',
      resumed: true,
      previousFailure: 'execution interrupted',
    });
    expect(restart).toHaveBeenCalledExactlyOnceWith({
      from: { name: 'stage-en-0', count: 1, type: 'do' },
    });
  });
  it('does not resume an unrelated provider failure or an already applied run', async () => {
    const { raw, db } = setup();
    failed(raw);
    const restart = vi.fn(() => Promise.resolve());
    expect(
      await resumeCachedCatalogueSync(db, 'owner', () =>
        Promise.resolve({
          status: () =>
            Promise.resolve({
              status: 'errored',
              error: { name: 'Error', message: 'tcgdex_fetch_failed_503' },
            }),
          restart,
        }),
      ),
    ).toBeNull();
    raw.exec('UPDATE sync_runs SET source_count=10,imported_count=10');
    expect(
      await resumeCachedCatalogueSync(db, 'owner', () =>
        Promise.resolve({
          status: () =>
            Promise.resolve({
              status: 'errored',
              error: { name: 'Error', message: 'staged_sync_not_running' },
            }),
          restart,
        }),
      ),
    ).toBeNull();
    expect(restart).not.toHaveBeenCalled();
  });
});

it('starts a fresh sync when an old failed instance has expired', async () => {
  const { raw, db } = setup();
  failed(raw);
  expect(
    await resumeCachedCatalogueSync(db, 'owner', () =>
      Promise.reject(new Error('instance.not_found')),
    ),
  ).toBeNull();
});
it('leaves tracking recoverable if the restart acknowledgement is lost', async () => {
  const { raw, db } = setup();
  failed(raw);
  await expect(
    resumeCachedCatalogueSync(db, 'owner', () =>
      Promise.resolve({
        status: () =>
          Promise.resolve({
            status: 'errored',
            error: { name: 'Error', message: 'staged_sync_not_running' },
          }),
        restart: () => Promise.reject(new Error('network timeout')),
      }),
    ),
  ).rejects.toThrow('network timeout');
  expect(raw.prepare('SELECT status FROM sync_runs').get()).toEqual({ status: 'running' });
});

it('records scheduled recovery with a null service actor', async () => {
  const { raw, db } = setup();
  failed(raw);
  await restoreUnappliedCatalogueRun(db, 'workflow_catalogue-test', null);
  expect(raw.prepare('SELECT actor FROM audit').get()).toEqual({ actor: null });
});

it('joins another caller’s in-flight recovery instead of creating a new full import', async () => {
  const { raw, db } = setup();
  failed(raw);
  await restoreUnappliedCatalogueRun(db, 'workflow_catalogue-test', 'owner');
  const restart = vi.fn(() => Promise.resolve());
  const getWorkflow = vi.fn(() =>
    Promise.resolve({
      status: () =>
        Promise.resolve<InstanceStatus>({
          status: 'errored',
          error: { name: 'Error', message: 'staged_sync_not_running' },
        }),
      restart,
    }),
  );
  expect(await resumeCachedCatalogueSync(db, 'owner', getWorkflow)).toEqual({
    workflowId: 'catalogue-test',
    resumed: false,
  });
  expect(restart).not.toHaveBeenCalled();
});
it('keeps a scheduled recovery usable after its original actor was deleted', async () => {
  const { raw, db } = setup();
  failed(raw);
  raw.exec("DELETE FROM users WHERE id='owner'");
  await restoreUnappliedCatalogueRun(db, 'workflow_catalogue-test', 'owner');
  expect(raw.prepare('SELECT actor FROM audit').get()).toEqual({ actor: null });
});

it('bounds restart acknowledgement grace and never masks an applied or claimed run', async () => {
  const { raw, db } = setup();
  failed(raw);
  await restoreUnappliedCatalogueRun(db, 'workflow_catalogue-test', 'owner');
  expect(await catalogueRestartPending(db, 'workflow_catalogue-test')).toBe(true);
  raw.exec(
    "INSERT INTO sync_run_claims(run_id,claim_token,claimed_at) VALUES('workflow_catalogue-test','claimed',1)",
  );
  expect(await catalogueRestartPending(db, 'workflow_catalogue-test')).toBe(false);
  raw.exec('DELETE FROM sync_run_claims; UPDATE sync_runs SET source_count=1,imported_count=1');
  expect(await catalogueRestartPending(db, 'workflow_catalogue-test')).toBe(false);
  raw.exec('UPDATE sync_runs SET source_count=0,imported_count=0');
  raw.exec('UPDATE audit SET created_at=0');
  expect(await catalogueRestartPending(db, 'workflow_catalogue-test')).toBe(false);
});
it('does not join a finished engine forever when D1 still says running', async () => {
  const { db } = setup();
  await beginStagedCatalogueRun(db, 'en', { runId: 'workflow_catalogue-test' });
  expect(
    await resumeCachedCatalogueSync(db, 'owner', () =>
      Promise.resolve({
        status: () => Promise.resolve({ status: 'complete' }),
        restart: () => Promise.resolve(),
      }),
    ),
  ).toBeNull();
});
