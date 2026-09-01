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

  async run<T>(task: () => Promise<T>, signal?: AbortSignal) {
    await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const resume = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = this.queue.indexOf(resume);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal?.reason ?? new DOMException("Operación cancelada.", "AbortError"));
      };
      this.queue.push(resume);
      signal?.addEventListener("abort", abort, { once: true });
    });
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
    signal?: AbortSignal;
  },
) {
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await operation(attempt);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (attempt === options.attempts || !options.shouldRetry(error)) throw error;
      const milliseconds = Math.max(0, options.delayMilliseconds(error, attempt));
      if (!options.signal) {
        await (options.sleep?.(milliseconds) ??
          new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
        continue;
      }
      const signal = options.signal;
      if (!options.sleep) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, milliseconds);
          const abort = () => {
            clearTimeout(timeout);
            reject(signal.reason ?? new DOMException("Operación cancelada.", "AbortError"));
          };
          signal.addEventListener("abort", abort, { once: true });
        });
        continue;
      }
      const delay = options.sleep(milliseconds);
      await new Promise<void>((resolve, reject) => {
        const abort = () =>
          reject(signal.reason ?? new DOMException("Operación cancelada.", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        delay.then(resolve, reject).finally(() =>
          signal.removeEventListener("abort", abort),
        );
      });
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
