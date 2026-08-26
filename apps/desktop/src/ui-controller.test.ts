import { describe, expect, it } from 'vitest';
import { BoundedAsyncQueue, ExclusiveAction, LatestGeneration } from './ui-controller';

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

  it('bounds queued preview work', async () => {
    const queue = new BoundedAsyncQueue(2);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let running = 0;
    let peak = 0;
    const tasks = Array.from({ length: 4 }, () =>
      queue.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate;
        running -= 1;
      }),
    );
    await Promise.resolve();
    expect(queue.activeCount).toBe(2);
    release?.();
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });
});
