export class LatestGeneration {
  private current = 0;

  next(): number {
    this.current += 1;
    return this.current;
  }

  isCurrent(generation: number): boolean {
    return generation === this.current;
  }
}

export class ExclusiveAction {
  private running = false;

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.running) throw new Error('This action is already running.');
    this.running = true;
    try {
      return await action();
    } finally {
      this.running = false;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }
}

export class BoundedAsyncQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error('Queue concurrency must be a positive integer.');
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit)
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    this.active += 1;
    try {
      return await action();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  get activeCount(): number {
    return this.active;
  }
}
