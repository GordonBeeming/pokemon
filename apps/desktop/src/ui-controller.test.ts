import { describe, expect, it } from 'vitest';
import { ExclusiveAction, LatestGeneration } from './ui-controller';

describe('desktop async UI controllers', () => {
  it('marks older refresh generations stale', () => {
    const generations = new LatestGeneration();
    const first = generations.next();
    const second = generations.next();
    expect(generations.isCurrent(first)).toBe(false);
    expect(generations.isCurrent(second)).toBe(true);
  });

  it('rejects overlapping exclusive actions and releases after failure', async () => {
    const exclusive = new ExclusiveAction();
    let release: (() => void) | undefined;
    const pending = exclusive.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(exclusive.run(() => Promise.resolve(undefined))).rejects.toThrow(
      'already running',
    );
    release?.();
    await pending;
    await expect(exclusive.run(() => Promise.resolve('done'))).resolves.toBe('done');
  });
});
