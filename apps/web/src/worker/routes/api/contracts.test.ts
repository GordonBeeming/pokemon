import { describe, expect, it } from 'vitest';
import {
  arrangementBody,
  binderFullPokedexPreviewSchema,
  binderPlannerSummarySchema,
  pageOrderBody,
} from './index';
import { catalogueFilters } from './operations';

describe('API contracts', () => {
  it('requires a revision for page reordering and rejects extra fields', () => {
    expect(pageOrderBody.parse({ pageIds: ['page-1'], expectedRevision: 3 })).toEqual({
      pageIds: ['page-1'],
      expectedRevision: 3,
    });
    expect(pageOrderBody.safeParse({ pageIds: ['page-1'] }).success).toBe(false);
    expect(
      pageOrderBody.safeParse({ pageIds: ['page-1'], expectedRevision: 3, ignored: true }).success,
    ).toBe(false);
  });

  it('requires a revision for binder arrangement and rejects extra fields', () => {
    expect(arrangementBody.parse({ mode: 'set-number', expectedRevision: 4 })).toEqual({
      mode: 'set-number',
      expectedRevision: 4,
    });
    expect(arrangementBody.safeParse({ mode: 'set-number' }).success).toBe(false);
    expect(
      arrangementBody.safeParse({ mode: 'set-number', expectedRevision: 4, ignored: true }).success,
    ).toBe(false);
  });

  it('shares catalogue query parsing across browser and desktop routes', () => {
    expect(catalogueFilters({ language: 'en', owned: 'true', limit: '25' }, true)).toMatchObject({
      language: 'en',
      owned: true,
      limit: 25,
      offset: 0,
    });
    expect(catalogueFilters({ owned: 'true' }, false).owned).toBeUndefined();
    expect(() => catalogueFilters({ owned: 'sometimes' }, true)).toThrow('invalid_filter');
  });

  it('defines bounded planner summary and preview response shapes', () => {
    expect(
      binderPlannerSummarySchema.parse({
        pageIds: ['page-1'],
        revision: 2,
        targets: 3,
        placed: 1,
        reservedSleeves: 1,
        reservedPages: 0,
        generatedPadding: 2,
        available: 3,
        capacity: 9,
        pageSize: 9,
      }),
    ).toMatchObject({ pageIds: ['page-1'], generatedPadding: 2, available: 3 });
    expect(
      binderFullPokedexPreviewSchema.parse({
        currentCapacity: 9,
        requiredCapacity: 1035,
        additionalPockets: 1026,
        pageIncrement: 9,
        generatedPadding: 10,
      }),
    ).toMatchObject({ additionalPockets: 1026, pageIncrement: 9 });
  });
});
