import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { BinderDomainError, type BinderErrorCode } from '../../lib/binders';
import { CollectionDomainError, type CollectionErrorCode } from '../../lib/collection';
import { ApplicationError } from '../../lib/log';
import type { AuthVars } from '../../lib/types';
import { apiFailure, asApplicationError, parsedJson } from './errors';

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
  binder_capacity_exceeded: 409,
  binder_capacity_invalid: 400,
  binder_shrink_occupied: 409,
  binder_assignment_incompatible: 409,
  binder_assignment_quantity_exceeded: 409,
  binder_reserved_page_not_empty: 409,
  card_not_found: 404,
} as const satisfies Record<BinderErrorCode, number>;

const collectionStatuses = {
  card_not_found: 404,
  collection_not_found: 404,
  collection_revision_conflict: 409,
  collection_mutation_conflict: 409,
  collection_quantity_out_of_bounds: 409,
  collection_quantity_below_active_assignments: 409,
  invalid_stored_mutation: 500,
} as const satisfies Record<CollectionErrorCode, number>;

describe('API error mapping', () => {
  it.each(Object.entries(binderStatuses))('maps binder error %s to %i', (code, status) => {
    expect(asApplicationError(new BinderDomainError(code as BinderErrorCode))).toMatchObject({
      code,
      status,
    });
  });

  it.each(Object.entries(collectionStatuses))('maps collection error %s to %i', (code, status) => {
    expect(
      asApplicationError(new CollectionDomainError(code as CollectionErrorCode)),
    ).toMatchObject({ code, status });
  });

  it('preserves typed application errors and hides unexpected errors', () => {
    const expected = new ApplicationError('rate_limited', 429);
    expect(asApplicationError(expected)).toBe(expected);
    expect(asApplicationError(new Error('card_not_found'))).toMatchObject({
      code: 'internal_error',
      status: 500,
    });
  });

  it('maps malformed JSON without exposing parser messages', async () => {
    await expect(
      parsedJson(new Request('https://example.test', { method: 'POST', body: '{' })),
    ).rejects.toMatchObject({ code: 'invalid_json', status: 400 });
  });

  it('returns capacity details with the request ID', async () => {
    const app = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();
    app.get('/', (c) => {
      c.set('requestId', 'request-409');
      return apiFailure(
        c,
        new BinderDomainError('binder_capacity_exceeded', {
          currentCapacity: 9,
          requiredCapacity: 18,
          additionalPockets: 9,
          pageIncrement: 9,
        }),
      );
    });
    const response = await app.request('https://example.test/');
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'binder_capacity_exceeded',
      details: {
        currentCapacity: 9,
        requiredCapacity: 18,
        additionalPockets: 9,
        pageIncrement: 9,
      },
      requestId: 'request-409',
    });
  });
});
