import { describe, expect, it } from 'vitest';
import { arrangementBody, mapConcurrent, pageOrderBody } from './index';

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

  it('bounds concurrent bulk work while preserving input order', async () => {
    let active = 0;
    let maximum = 0;
    const values = Array.from({ length: 25 }, (_, index) => index);
    const mapped = await mapConcurrent(values, 8, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return value * 2;
    });
    expect(maximum).toBe(8);
    expect(mapped).toEqual(values.map((value) => value * 2));
  });
});
