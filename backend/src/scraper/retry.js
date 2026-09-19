/** Sleep helper. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a promise with a hard timeout.
 *
 * The store's fault injector sometimes never resolves at all, so every attempt
 * must be bounded externally — an `await` with no timeout would hang the run.
 */
export async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class TimeoutError extends Error {
  constructor(message) { super(message); this.name = 'TimeoutError'; }
}

/** The server asked us to slow down and said for how long. */
export class RateLimitError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Errors that mean "this will never succeed, stop retrying". */
export class PermanentError extends Error {
  constructor(message) { super(message); this.name = 'PermanentError'; }
}

/**
 * Exponential backoff with full jitter.
 *
 * Full jitter (random between 0 and the cap) rather than fixed backoff so that
 * several products retrying at once do not re-collide on every round.
 */
export function backoffDelay(attempt, { baseMs = 1000, maxMs = 15000 } = {}) {
  const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * cap);
}

/**
 * Run `fn` until it succeeds or attempts are exhausted.
 *
 * `onAttempt` is called with the outcome of every single attempt so the caller
 * can record each one honestly in the scrape log, including the ones that failed
 * before a later attempt succeeded.
 *
 * When the server tells us how long to wait (HTTP 429 `Retry-After`), that wins
 * over our own backoff — guessing shorter just earns another 429.
 *
 * @returns {Promise<{ok: true, value: any, attempts: number}|{ok: false, error: Error, attempts: number}>}
 */
export async function retry(fn, { attempts = 3, baseMs = 1000, maxMs = 15000, onAttempt } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = Date.now();
    try {
      const value = await fn(attempt);
      await onAttempt?.({ attempt, ok: true, durationMs: Date.now() - startedAt });
      return { ok: true, value, attempts: attempt };
    } catch (error) {
      lastError = error;
      await onAttempt?.({ attempt, ok: false, error, durationMs: Date.now() - startedAt });
      if (error instanceof PermanentError) break;
      if (attempt < attempts) {
        // Any error may carry retryAfterMs — HTTP 429 from fetch, or a rate limit
        // the store rendered into the page during a browser scrape.
        const serverAsked = Number(error?.retryAfterMs) || 0;
        // Jitter on top of Retry-After so parallel workers do not all wake together.
        const wait = serverAsked
          ? serverAsked + Math.floor(Math.random() * 400)
          : backoffDelay(attempt, { baseMs, maxMs });
        await sleep(wait);
      }
    }
  }
  return { ok: false, error: lastError, attempts: Math.min(attempts, (lastError && attempts) || attempts) };
}
