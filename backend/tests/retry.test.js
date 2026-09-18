import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermanentError, RateLimitError, TimeoutError, backoffDelay, retry, withTimeout } from '../src/scraper/retry.js';

describe('retry', () => {
  it('returns immediately on a first-attempt success', async () => {
    let calls = 0;
    const r = await retry(async () => { calls++; return 'ok'; }, { attempts: 3, baseMs: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.value, 'ok');
    assert.equal(r.attempts, 1);
    assert.equal(calls, 1);
  });

  it('retries a transient failure and reports how many attempts it took', async () => {
    let calls = 0;
    const r = await retry(async () => {
      if (++calls < 3) throw new Error('flaky');
      return 'recovered';
    }, { attempts: 4, baseMs: 1 });

    assert.equal(r.ok, true);
    assert.equal(r.value, 'recovered');
    assert.equal(r.attempts, 3);
  });

  it('gives up after the configured number of attempts — it does not loop forever', async () => {
    let calls = 0;
    const r = await retry(async () => { calls++; throw new Error('always down'); }, { attempts: 3, baseMs: 1 });
    assert.equal(r.ok, false);
    assert.equal(calls, 3);
    assert.match(r.error.message, /always down/);
  });

  it('reports EVERY attempt, including ones that failed before a later success', async () => {
    const seen = [];
    let calls = 0;
    await retry(async () => {
      if (++calls < 3) throw new Error(`boom ${calls}`);
      return 'ok';
    }, { attempts: 4, baseMs: 1, onAttempt: (a) => seen.push({ attempt: a.attempt, ok: a.ok }) });

    // This is what makes the scrape log honest rather than "it worked".
    assert.deepEqual(seen, [
      { attempt: 1, ok: false },
      { attempt: 2, ok: false },
      { attempt: 3, ok: true },
    ]);
  });

  it('stops immediately on a PermanentError', async () => {
    let calls = 0;
    const r = await retry(async () => { calls++; throw new PermanentError('invalid id'); }, { attempts: 5, baseMs: 1 });
    assert.equal(r.ok, false);
    assert.equal(calls, 1);
  });
});

describe('retry — rate limiting', () => {
  it('waits at least as long as the server asked before retrying', async () => {
    let calls = 0;
    const started = Date.now();
    const r = await retry(async () => {
      if (++calls === 1) throw new RateLimitError('429', 300);
      return 'ok';
    }, { attempts: 3, baseMs: 1 });

    assert.equal(r.ok, true);
    // Our own backoff base is 1ms, so anything near 300ms proves Retry-After won.
    assert.ok(Date.now() - started >= 300, 'should have honoured Retry-After');
  });

  it('surfaces a rate limit as its own error type, not a generic failure', async () => {
    // The catalogue walk must be able to tell "slow down" apart from "no such
    // product" — conflating them silently drops real products from the index.
    const r = await retry(async () => { throw new RateLimitError('429', 1); }, { attempts: 2, baseMs: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.error instanceof RateLimitError);
    assert.equal(r.error.retryAfterMs, 1);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and stays within the cap', () => {
    for (const attempt of [1, 2, 3, 4, 5, 9]) {
      const cap = Math.min(10_000, 100 * 2 ** (attempt - 1));
      for (let i = 0; i < 40; i++) {
        const d = backoffDelay(attempt, { baseMs: 100, maxMs: 10_000 });
        assert.ok(d >= 0 && d <= cap, `attempt ${attempt} produced ${d}, cap ${cap}`);
      }
    }
  });

  it('jitters, so parallel retries do not re-collide', () => {
    const seen = new Set(Array.from({ length: 60 }, () => backoffDelay(5, { baseMs: 100, maxMs: 10_000 })));
    assert.ok(seen.size > 5, 'expected jittered delays, got a constant');
  });
});

describe('withTimeout', () => {
  it('passes a value through when it resolves in time', async () => {
    assert.equal(await withTimeout(Promise.resolve(7), 500, 'x'), 7);
  });

  it('rejects with a TimeoutError when the promise never settles', async () => {
    // This is the store's worst failure mode: a callback that is simply dropped.
    await assert.rejects(
      () => withTimeout(new Promise(() => {}), 50, 'stuck op'),
      (e) => e instanceof TimeoutError && /stuck op timed out/.test(e.message),
    );
  });
});
