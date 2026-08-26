const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function applySecurityHeaders(headers: Headers, request: Request): void {
  const loopback = LOOPBACK_HOSTS.has(new URL(request.url).hostname);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set(
    'content-security-policy',
    loopback
      ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' ws:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (loopback) headers.delete('strict-transport-security');
  else headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
}
