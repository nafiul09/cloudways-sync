// Exponential backoff helper. Callers decide whether an error is
// retriable via the `shouldRetry` predicate; this helper only handles
// scheduling and attempt bookkeeping.

export type RetryOptions = {
  /** Max attempts including the first. */
  maxAttempts: number;
  /** First backoff delay in ms. */
  baseDelayMs: number;
  /** Cap on any single delay in ms. */
  maxDelayMs: number;
  /** Predicate: return true to retry, false to rethrow. */
  shouldRetry: (err: unknown, attempt: number) => boolean;
  /**
   * Optional override for the next delay — lets callers respect server
   * hints like `Retry-After`. Receives the attempt number (1-based).
   */
  computeDelayMs?: (err: unknown, attempt: number, defaultMs: number) => number;
  /** Optional hook for logs/tests. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.maxAttempts || !opts.shouldRetry(err, attempt)) {
        throw err;
      }
      const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
      const delay = opts.computeDelayMs ? opts.computeDelayMs(err, attempt, exp) : exp;
      opts.onRetry?.(err, attempt, delay);
      await sleep(Math.max(0, delay));
    }
  }
}
