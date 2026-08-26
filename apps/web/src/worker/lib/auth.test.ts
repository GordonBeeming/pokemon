import { describe, expect, it } from 'vitest';
import {
  cookieSecureFor,
  enrolSecretMatches,
  isLoopbackHost,
  signSession,
  verifySession,
} from './auth';
import { timingSafeStringEqual } from './crypto';

const current = '01234567890123456789012345678901';
const previous = '98765432109876543210987654321098';

describe('auth foundation', () => {
  it('compares bootstrap secrets without accepting a different value', () => {
    expect(timingSafeStringEqual('same-secret', 'same-secret')).toBe(true);
    expect(timingSafeStringEqual('same-secret', 'other-secret')).toBe(false);
    expect(enrolSecretMatches('enrol', { ENROLL_SECRET: 'enrol' })).toBe(true);
  });

  it('signs bounded sessions and accepts the previous rotation secret', async () => {
    const token = await signSession(
      { sub: 'owner', label: 'Owner', sid: 'session-id', epoch: 3 },
      { SESSION_SECRET: previous, SESSION_SECRET_PREV: undefined },
    );
    await expect(
      verifySession(token, { SESSION_SECRET: current, SESSION_SECRET_PREV: previous }),
    ).resolves.toMatchObject({ sub: 'owner', label: 'Owner', sid: 'session-id', epoch: 3 });
  });

  it('only marks secure cookies on non-local origins', () => {
    expect(cookieSecureFor(new Request('http://localhost:5173/login'))).toBe(false);
    expect(cookieSecureFor(new Request('http://[::1]:5173/login'))).toBe(false);
    expect(cookieSecureFor(new Request('https://pokedex.example/login'))).toBe(true);
  });

  it('recognises bracketed IPv6 localhost as loopback', () => {
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('pokedex.example')).toBe(false);
  });
});
