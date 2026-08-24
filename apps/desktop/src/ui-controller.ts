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
