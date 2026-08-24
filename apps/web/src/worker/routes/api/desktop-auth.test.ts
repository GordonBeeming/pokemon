import { describe, expect, it } from 'vitest';
import { isDesktopBearerRoute, parseDesktopBearer } from './index';

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

  it('only bypasses browser sessions for dedicated bearer routes', () => {
    expect(isDesktopBearerRoute('/api/desktop/catalogue/search')).toBe(true);
    expect(isDesktopBearerRoute('/api/desktop/binders/versions/binder-1/slot')).toBe(true);
    expect(isDesktopBearerRoute('/api/desktop/tokens')).toBe(false);
    expect(isDesktopBearerRoute('/api/desktop/unknown')).toBe(false);
  });
});
