import { apiErrorSchema, type ApiErrorDetails } from '@pokedex/shared';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId: string | null,
    public readonly retryAfterSeconds: number | null,
    public readonly details: ApiErrorDetails | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Dispatched whenever a request comes back 401. Nothing here knows about the router,
// so the app shell owns turning this into an actual navigation to sign-in.
export const AUTH_LOST_EVENT = 'pokedex:authentication-lost';
export const RETURN_TO_STORAGE_KEY = 'pokedex:return-to';

async function purgePrivateCaches(): Promise<void> {
  navigator.serviceWorker?.controller?.postMessage({ type: 'PURGE_PRIVATE_CACHES' });
  if (!('caches' in globalThis)) return;
  const names = await caches.keys();
  await Promise.all(
    names.filter((name) => name.startsWith('pokedex-')).map(async (name) => caches.delete(name)),
  );
}

function rememberReturnTo(): void {
  try {
    sessionStorage.setItem(RETURN_TO_STORAGE_KEY, `${location.pathname}${location.search}`);
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts; the
    // sign-in gate simply falls back to the app's home route.
  }
}

export interface ApiFetchInit extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

/**
 * Every /api/* call in the new app goes through here: it parses the response with the
 * caller's Zod schema, maps the worker's `apiFailure` envelope to a typed `ApiError`,
 * and treats a 401 as a signal to drop back to sign-in rather than a generic failure.
 */
export async function apiFetch<Output>(
  path: string,
  schema: z.ZodType<Output>,
  init: ApiFetchInit = {},
): Promise<Output> {
  const headers = new Headers(init.headers);
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (body !== undefined && !headers.has('content-type'))
    headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...init, body, credentials: 'same-origin', headers });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new ApiError(
      'invalid_response',
      cause instanceof Error ? cause.message : 'The server response was not valid JSON.',
      response.status,
      response.headers.get('x-request-id'),
      null,
    );
  }
  const failure = apiErrorSchema.safeParse(payload);
  if (!response.ok || failure.success) {
    const code = failure.success ? failure.data.error : 'invalid_response';
    const requestId = failure.success
      ? (failure.data.requestId ?? response.headers.get('x-request-id'))
      : response.headers.get('x-request-id');
    const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
    if (response.status === 401) {
      rememberReturnTo();
      await purgePrivateCaches();
      if (typeof globalThis.dispatchEvent === 'function')
        globalThis.dispatchEvent(new Event(AUTH_LOST_EVENT));
    }
    throw new ApiError(
      code,
      failure.success ? (failure.data.message ?? code) : 'The server returned an invalid response.',
      response.status,
      requestId,
      Number.isFinite(retryAfter) ? retryAfter : null,
      failure.success ? (failure.data.details ?? null) : null,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    throw new ApiError(
      'invalid_response',
      'The server returned an unexpected response.',
      response.status,
      response.headers.get('x-request-id'),
      null,
    );
  return parsed.data;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
