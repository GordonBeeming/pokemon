import { describe, expect, it } from 'vitest';
import { apiRoutes, parseDesktopBearer } from './index';

const token = 'a'.repeat(64);

describe('desktop bearer parsing', () => {
  it('accepts an exact paired bearer token', () => {
    expect(parseDesktopBearer(`Bearer ${token}`)).toBe(token);
  });

  it('rejects missing, malformed, raw, and alternate authorization schemes', () => {
    expect(parseDesktopBearer(undefined)).toBeNull();
    expect(parseDesktopBearer(token)).toBeNull();
    expect(parseDesktopBearer(`Basic ${token}`)).toBeNull();
    expect(parseDesktopBearer(`Bearer  ${token}`)).toBeNull();
    expect(parseDesktopBearer(`Bearer ${token.slice(0, -1)}`)).toBeNull();
  });

  it('enforces bearer and browser-session policy structurally', async () => {
    const env = {} as CloudflareEnv;
    const catalogue = await apiRoutes.request('/desktop/catalogue/search', undefined, env);
    expect(catalogue.status).toBe(401);
    await expect(catalogue.json()).resolves.toMatchObject({ error: 'desktop_token_invalid' });

    const tokenManagement = await apiRoutes.request('/desktop/tokens', undefined, env);
    expect(tokenManagement.status).toBe(401);
    await expect(tokenManagement.json()).resolves.toMatchObject({ error: 'unauthorized' });

    const unknown = await apiRoutes.request(
      '/desktop/unknown',
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(unknown.status).toBe(404);
  });

  it('returns a strict 429 with Retry-After before pair redemption work', async () => {
    const env = Object.assign({} as CloudflareEnv, {
      AUTH_COORDINATOR: {
        getByName: () => ({
          rateLimit: () => Promise.resolve({ allowed: false, remaining: 0, retryAfter: 42 }),
        }),
      },
    });
    const response = await apiRoutes.request(
      '/desktop/pair/redeem',
      { method: 'POST', body: JSON.stringify({ code: 'A'.repeat(24), label: 'Scanner' }) },
      env,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'rate_limited' });
  });
});
