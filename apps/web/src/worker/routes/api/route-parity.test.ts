import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, signSession } from '../../lib/auth';
import { ApplicationError } from '../../lib/log';
import { apiRoutes } from './index';

type SharedRoute = {
  method: 'GET' | 'PATCH' | 'POST' | 'PUT';
  browser: string;
  desktop: string;
  body?: unknown;
};

const mutationId = '00000000-0000-4000-8000-000000000001';
const sharedRoutes = [
  { method: 'GET', browser: '/catalogue/search', desktop: '/desktop/catalogue/search' },
  { method: 'GET', browser: '/catalogue/card-1', desktop: '/desktop/catalogue/card-1' },
  {
    method: 'PUT',
    browser: '/collection/card-1',
    desktop: '/desktop/collection/card-1',
    body: { mutationId, expectedRevision: 0, quantity: 1, notes: null },
  },
  {
    method: 'POST',
    browser: '/collection/card-1/increment',
    desktop: '/desktop/collection/card-1/increment',
    body: { mutationId, delta: 1 },
  },
  {
    method: 'PATCH',
    browser: '/collection/card-1/notes',
    desktop: '/desktop/collection/card-1/notes',
    body: { mutationId, expectedRevision: 0, notes: 'Route probe' },
  },
  { method: 'GET', browser: '/binders', desktop: '/desktop/binders' },
  {
    method: 'POST',
    browser: '/binders',
    desktop: '/desktop/binders',
    body: { name: 'Route probe', layout: { kind: '2x2', rows: 2, columns: 2 } },
  },
  {
    method: 'GET',
    browser: '/binders/versions/version-1',
    desktop: '/desktop/binders/versions/version-1',
  },
  {
    method: 'GET',
    browser: '/binders/versions/version-1/shortages',
    desktop: '/desktop/binders/versions/version-1/shortages',
  },
  {
    method: 'PUT',
    browser: '/binders/versions/version-1/slot',
    desktop: '/desktop/binders/versions/version-1/slot',
    body: { page: 0, row: 0, column: 0, cardId: null, expectedRevision: 1 },
  },
  {
    method: 'POST',
    browser: '/binders/versions/version-1/swap',
    desktop: '/desktop/binders/versions/version-1/swap',
    body: {
      source: { page: 0, row: 0, column: 0 },
      target: { page: 0, row: 0, column: 1 },
      expectedRevision: 1,
    },
  },
  { method: 'GET', browser: '/art/manifest', desktop: '/desktop/art/manifest' },
  { method: 'GET', browser: '/art/card-1/high', desktop: '/desktop/art/card-1/high' },
] as const satisfies readonly SharedRoute[];

const desktopBearer = 'a'.repeat(64);
const sessionSecret = 'route-parity-session-secret-value';
let sessionCookie = '';

function routeProbeDatabase(): D1Database {
  const operationReached = () =>
    Promise.reject(new ApplicationError('route_business_operation_reached', 400));
  return {
    batch: operationReached,
    dump: operationReached,
    exec: operationReached,
    prepare(sql: string) {
      const statement = {
        bind: () => statement,
        first: () => {
          if (sql.includes('FROM web_sessions'))
            return Promise.resolve({ last_seen_at: Math.floor(Date.now() / 1000) });
          if (sql.includes('FROM desktop_tokens'))
            return Promise.resolve({
              owner_id: 'owner',
              scopes: '[]',
              expires_at: null,
              revoked_at: null,
              last_used_at: Math.floor(Date.now() / 1000),
            });
          return operationReached();
        },
        all: operationReached,
        run: operationReached,
        raw: operationReached,
      };
      return statement as D1PreparedStatement;
    },
    withSession: () => {
      throw new ApplicationError('route_business_operation_reached', 400);
    },
  } as D1Database;
}

const env = {
  DB: routeProbeDatabase(),
  SESSION_SECRET: sessionSecret,
  SESSION_SECRET_PREV: '',
} as CloudflareEnv;

function requestInit(
  route: SharedRoute,
  authorization: 'browser' | 'desktop',
  method: SharedRoute['method'] | 'DELETE' = route.method,
): RequestInit {
  const headers = new Headers();
  if (authorization === 'browser') headers.set('cookie', sessionCookie);
  else headers.set('authorization', `Bearer ${desktopBearer}`);
  if (route.body !== undefined) headers.set('content-type', 'application/json');
  return {
    method,
    headers,
    body:
      method === route.method && route.body !== undefined ? JSON.stringify(route.body) : undefined,
  };
}

beforeAll(async () => {
  const token = await signSession(
    { sub: 'owner', label: 'Route parity', sid: 'route-parity', epoch: 0 },
    env,
  );
  sessionCookie = `${SESSION_COOKIE}=${token}`;
});

describe('browser and desktop route parity', () => {
  it.each(sharedRoutes)(
    'registers $method $browser and $desktop with their expected authorization boundary',
    async (route) => {
      const unauthenticatedBrowser = await apiRoutes.request(route.browser, {
        method: route.method,
      });
      expect(unauthenticatedBrowser.status).toBe(401);

      const browserResponse = await apiRoutes.request(
        route.browser,
        requestInit(route, 'browser'),
        env,
      );
      expect(browserResponse.status).toBe(400);

      const desktopResponse = await apiRoutes.request(
        route.desktop,
        requestInit(route, 'desktop'),
        env,
      );
      expect(desktopResponse.status).toBe(403);

      const wrongBrowserMethod = await apiRoutes.request(
        route.browser,
        requestInit(route, 'browser', 'DELETE'),
        env,
      );
      const wrongDesktopMethod = await apiRoutes.request(
        route.desktop,
        requestInit(route, 'desktop', 'DELETE'),
        env,
      );
      expect([404, 405]).toContain(wrongBrowserMethod.status);
      expect([404, 405]).toContain(wrongDesktopMethod.status);
    },
  );
});
