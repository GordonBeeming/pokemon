import { describe, expect, it } from 'vitest';
import { applySecurityHeaders } from './security-headers';

describe('worker security headers', () => {
  it('permits only the Vite development script and socket requirements on loopback', () => {
    const headers = new Headers();
    applySecurityHeaders(headers, new Request('http://127.0.0.1:5173/'));
    const policy = headers.get('content-security-policy') ?? '';
    expect(policy).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(policy).toContain("connect-src 'self' ws://localhost:* ws://127.0.0.1:*");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(headers.has('strict-transport-security')).toBe(false);
  });

  it('keeps production scripts strict and enables HSTS', () => {
    const headers = new Headers();
    applySecurityHeaders(headers, new Request('https://pokedex.gordonbeeming.com/'));
    const policy = headers.get('content-security-policy') ?? '';
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains');
  });
});
