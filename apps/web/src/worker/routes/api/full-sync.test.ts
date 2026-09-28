import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createSession, SESSION_COOKIE } from '../../lib/auth';
import { applyAllMigrations, sqliteD1 } from '../../lib/d1-test-helper';
import { apiRoutes } from './index';

const database = new DatabaseSync(':memory:');
afterAll(() => database.close());
const db = sqliteD1(database);
applyAllMigrations(database);
database.exec(
  `INSERT INTO users (id, label, role, created_at) VALUES ('admin', 'Admin', 'admin', 1)`,
);

type WorkflowState = 'running' | 'errored' | 'terminated';
let existingState: WorkflowState;
let created: string[];

const env = {
  DB: db,
  SESSION_SECRET: 'full-sync-test-session-secret-thirty-two-bytes',
  SESSION_SECRET_PREV: '',
  CATALOGUE_SYNC: {
    get: (id: string) =>
      Promise.resolve({ id, status: () => Promise.resolve({ status: existingState }) }),
    create: ({ id }: { id: string }) => {
      created.push(id);
      return Promise.resolve({ id });
    },
  },
  AUTH_COORDINATOR: {
    getByName: () => ({ rateLimit: () => Promise.resolve({ allowed: true, retryAfter: 0 }) }),
  },
} as unknown as CloudflareEnv;

async function startSync(): Promise<{ status: number; workflowId: unknown }> {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, { sub: 'admin', label: 'Admin' }, env)}`;
  const response = await apiRoutes.request(
    '/catalogue/full-sync',
    { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' },
    env,
  );
  const body: unknown = await response.json();
  return {
    status: response.status,
    workflowId: body && typeof body === 'object' && 'workflowId' in body ? body.workflowId : null,
  };
}

function runStatus(): unknown {
  return database
    .prepare("SELECT status, refusal_reason FROM sync_runs WHERE id = 'sync_catalogue-old'")
    .get();
}

describe('POST /catalogue/full-sync with a run already marked running', () => {
  beforeEach(() => {
    created = [];
    database.exec(`DELETE FROM sync_runs;`);
    database.exec(`INSERT INTO sync_runs (id, provider, language, started_at, status, complete_source)
      VALUES ('sync_catalogue-old', 'tcgdex', 'en', 1, 'running', 1)`);
  });

  it('hands back the live run instead of starting a second one', async () => {
    existingState = 'running';
    expect(await startSync()).toEqual({ status: 202, workflowId: 'catalogue-old' });
    expect(created).toEqual([]);
    expect(runStatus()).toEqual({ status: 'running', refusal_reason: null });
  });

  it.each(['errored', 'terminated'] as const)(
    'retires a run whose workflow %s and starts a fresh sync',
    async (state) => {
      existingState = state;
      const result = await startSync();
      expect(result.status).toBe(202);
      expect(created).toHaveLength(1);
      expect(result.workflowId).toBe(created[0]);
      expect(runStatus()).toEqual({ status: 'failed', refusal_reason: `workflow_${state}` });
    },
  );
});
