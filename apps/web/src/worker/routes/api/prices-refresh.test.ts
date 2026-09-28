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

let created: Array<{ id: string; params: unknown }>;

const env = {
  DB: db,
  SESSION_SECRET: 'prices-refresh-test-session-secret-32-bytes',
  SESSION_SECRET_PREV: '',
  PRICE_SYNC: {
    create: (options: { id: string; params: unknown }) => {
      created.push(options);
      return Promise.resolve({ id: options.id });
    },
  },
  AUTH_COORDINATOR: {
    getByName: () => ({ rateLimit: () => Promise.resolve({ allowed: true, retryAfter: 0 }) }),
  },
} as unknown as CloudflareEnv;

async function refresh(body?: unknown): Promise<number> {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, { sub: 'admin', label: 'Admin' }, env)}`;
  const headers = new Headers({ cookie });
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await apiRoutes.request(
    '/prices/refresh',
    { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
  return response.status;
}

describe('POST /prices/refresh', () => {
  beforeEach(() => {
    created = [];
  });

  it('with no body prices the cards in use', async () => {
    expect(await refresh()).toBe(202);
    expect(created).toHaveLength(1);
    expect(created[0]?.id).toMatch(/^prices-refresh-/);
    expect(created[0]?.params).toEqual({ scope: 'in-use' });
  });

  it('with everyCard starts the first link of a whole-catalogue chain', async () => {
    expect(await refresh({ everyCard: true })).toBe(202);
    expect(created).toHaveLength(1);
    const [link] = created;
    expect(link?.id).toMatch(/^prices-all-.+-p0$/);
    expect(link?.params).toMatchObject({ scope: 'catalogue', chain: { page: 0 } });
  });

  it('refuses an unknown body', async () => {
    expect(await refresh({ everything: 'please' })).toBe(400);
    expect(created).toEqual([]);
  });
});
