export class AsyncSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("El límite de concurrencia debe ser un entero positivo.");
    }
    this.limit = limit;
  }

  async run<T>(task: () => Promise<T>) {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire() {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

export async function retryOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    attempts: number;
    shouldRetry: (error: unknown) => boolean;
    delayMilliseconds: (error: unknown, attempt: number) => number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
) {
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt === options.attempts || !options.shouldRetry(error)) throw error;
      await sleep(Math.max(0, options.delayMilliseconds(error, attempt)));
    }
  }
  throw new Error("La operación no realizó ningún intento.");
}

export async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        await worker(items[index], index);
      }
    },
  );
  const results = await Promise.allSettled(workers);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw rejected.reason;
}
