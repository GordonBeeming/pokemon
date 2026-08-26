import type { Context } from 'hono';
import { BinderDomainError, type BinderErrorCode } from '../../lib/binders';
import { CollectionDomainError, type CollectionErrorCode } from '../../lib/collection';
import { ApplicationError, describeError, logError } from '../../lib/log';
import { boundedJson } from '../../lib/request';
import type { AuthVars } from '../../lib/types';

type PublicStatus = 400 | 401 | 403 | 404 | 409 | 413 | 416 | 429 | 500 | 503;

const binderStatuses = {
  binder_version_not_found: 404,
  binder_version_not_draft: 409,
  binder_version_archived: 409,
  binder_revision_conflict: 409,
  binder_page_not_found: 404,
  binder_last_page: 409,
  binder_page_order_invalid: 409,
  binder_page_limit_reached: 409,
  binder_page_window_invalid: 400,
  binder_slot_not_found: 404,
  binder_slot_out_of_bounds: 400,
  binder_arrangement_card_missing: 400,
  card_not_found: 404,
} as const satisfies Record<BinderErrorCode, PublicStatus>;

const collectionStatuses = {
  card_not_found: 404,
  collection_not_found: 404,
  collection_revision_conflict: 409,
  collection_mutation_conflict: 409,
  collection_quantity_out_of_bounds: 409,
  invalid_stored_mutation: 500,
} as const satisfies Record<CollectionErrorCode, PublicStatus>;

export function asApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof BinderDomainError)
    return new ApplicationError(error.code, binderStatuses[error.code]);
  if (error instanceof CollectionDomainError)
    return new ApplicationError(error.code, collectionStatuses[error.code]);
  return new ApplicationError('internal_error', 500);
}

export function apiFailure(
  c: Context<{ Bindings: CloudflareEnv; Variables: AuthVars }>,
  error: unknown,
): Response {
  const failure = asApplicationError(error);
  const requestId = c.get('requestId');
  if (failure.status >= 500)
    logError({
      evt: 'api.request_failed',
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: failure.status,
      code: failure.code,
      err: describeError(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  return c.json(
    {
      ok: false,
      error: failure.status >= 500 ? 'internal_error' : failure.code,
      requestId,
    },
    failure.status,
  );
}

export async function parsedJson(request: Request): Promise<unknown> {
  return boundedJson(request);
}
