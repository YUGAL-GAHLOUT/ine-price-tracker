# Design Note — INE Product Price Tracker

How the scraping was made reliable, what was traded away, and the wrong turns I took
before getting there.

---

## 1. The store is not a normal scraping target

Before writing any scraper I read the store's JavaScript bundle and watched the page
in a real browser. The full findings are in [`store-analysis.md`](./store-analysis.md);
the parts that shaped the design:

- The site is a React SPA. The server returns an empty `<div id="root">`, so there is
  **no server-rendered price to fetch**.
- `/api/catalog` and `/api/product/:id` return product metadata over plain HTTP but
  contain **no price and no stock at all**.
- The price is hidden behind a **"Reveal price" button that starts disabled**. A
  behavioural gate records `mousemove` events over the price block (throttled to one
  per 40 ms) and only enables the button after a minimum number of moves and a
  minimum dwell time.
- Clicking it runs an anti-bot pipeline: fetch a challenge, **compile and execute a
  WebAssembly module**, solve a **proof-of-work**, exchange it for a bearer token,
  fetch the quote, and **XOR-decrypt** the payload with that token.
- The rendered result is then deliberately booby-trapped (section 3).

## 2. HTTP first, browser only where it is genuinely required

The assignment asks for lightweight HTTP where possible and a headless browser only
where the page truly needs one. The split follows the data:

| Data | Method | Why |
|---|---|---|
| Catalogue metadata (name, brand, SKU, slug) — powers search | **`fetch` + JSON** | Plainly available over HTTP; a browser would be pure waste |
| Price and stock | **Playwright (Chromium)** | Only obtainable by executing WASM, solving a PoW and satisfying a mouse-movement gate |

Reimplementing the WASM + proof-of-work + XOR chain in Node was considered and
rejected. It would have been a few hundred lines of reverse-engineered arithmetic that
breaks the first time the challenge changes, and it would be inherently unverifiable.
Driving the real UI is more honest and degrades far more gracefully. Playwright was
chosen over Puppeteer for its auto-waiting locators, `isDisabled()`/state assertions
and first-class `mouse.move` — all directly useful against the hover gate.

The cost is real and worth stating: a browser scrape takes **~5–8 s per product**
versus milliseconds for an HTTP call, and Chromium needs a few hundred MB of RAM on
Render's free tier. That is why concurrency is capped at 2 (§6).

## 3. Never storing the wrong number

This was the single most dangerous part of the assignment, because the failure is
silent. The store renders **two hidden decoy prices** on exactly the selectors a
scraper reaches for first:

```html
<span class="price-value" aria-hidden="true" style="display:none">₹27,130</span>   <!-- wrong -->
<span class="amount" data-price="true" aria-hidden="true" style="display:none">₹30,547</span> <!-- wrong -->
```

The true price that run was **₹25,739**. A scraper using `.price-value` or
`[data-price]` returns a plausible number, passes every sanity check, and quietly
records a wrong price history forever.

Four layers defend against that:

1. **Layout-driven selection.** The real price element carries a class that the store
   itself publishes at `/api/layout` (`classes.priceValue`), and it rotates. The
   scraper fetches the layout at scrape time instead of hardcoding class names.
2. **Structural fallback.** If the layout class is missing, the price is found by the
   only inline style that identifies it (`font-size: 2.4rem; font-weight: 700`) among
   the *visible*, non-`aria-hidden` children of `.price-main`. Using this fallback is
   recorded as `price_source = 'structural'`. It raises a `structure_change` alert only
   when `/api/layout` actually answered and its class still did not match — if the
   layout fetch was rate-limited we never knew what to expect, and alerting there would
   be a false alarm on an otherwise perfect scrape.
3. **Format-tolerant parsing.** The store rotates through seven price renderings —
   `₹25,739`, `₹25 739`, `₹25.739,00` (European), `₹25,739/- (incl. of all taxes)`,
   full-width Unicode digits, NBSP-separated, and a "split" carrier that wraps every
   character in its own `<span>` with a zero-width space between. `parsePrice`
   normalises all of them and **returns `null` rather than guessing** on anything it
   does not fully understand.
4. **Cross-check against the store's own figure.** The browser context hooks
   `TextDecoder.prototype.decode` and captures the quote object the page decrypts for
   itself. If the number parsed from the DOM disagrees with it, the scrape **fails**
   (`quote_mismatch`) instead of recording either value. When the hook yields nothing,
   the scrape still succeeds on the DOM value alone but is flagged
   `cross_checked = false`, so the dashboard can show how the figure was established.

Stock gets the same treatment. The `in-stock` / `out-stock` class is authoritative;
the wording rotates through five templates (`Only 7 left`, `Selling fast — 7 left`, …).
Critically, **a missing badge is a failure, not "out of stock"** — conflating those two
is how a scraper invents an outage that never happened. `parseStock` returns `null` for
a missing or unrecognised badge, and a genuine `out-stock` badge returns
`{inStock: false, quantity: 0}`, which is a real observation and *is* recorded.

## 4. Retries, timeouts, and telling the two failure modes apart

The store injects faults on roughly 35% of price loads. Watching the bundle showed
these are not one failure but two, and they need opposite handling:

```js
if (Math.random() < 0.35) {
  if (Math.random() < 0.5) return;        // callback dropped — page hangs forever
  window.setTimeout(callback, 900);       // just slow
}
```

A dropped callback means the page's own retry never fires either, so **waiting cannot
help** — only a reload can. A delay means the store is still working and should be
given room. The scraper distinguishes them by reading the store's own status text:
while the block reports `Retrying (attempt n/6)` the deadline is extended by another
18 s; if it sits silently on "loading" past 18 s, the attempt is abandoned and the
outer retry reloads the page. A 45 s hard ceiling bounds the whole wait either way.

Around that:

- **Every attempt is bounded.** `withTimeout` wraps the whole attempt, because an
  `await` on a promise the page never settles would otherwise hang the run forever.
- **Bounded retries, never infinite.** 4 attempts by default, then an honest failure.
- **Exponential backoff with full jitter** (`random(0, min(cap, base · 2ⁿ))`). Full
  jitter rather than fixed backoff so that several products retrying after a shared
  outage do not re-collide on every round.
- **Rate limits are obeyed, not guessed.** The store answers bursts with `429` +
  `Retry-After`. That gets its own error type and the server's own delay is honoured,
  because retrying sooner just earns another 429 — and, crucially, it is never confused
  with "not found".
- **Typed failure codes** — `reveal_gate_failed`, `reveal_timeout`, `price_pending`,
  `quote_mismatch`, `price_unparseable`, `stock_not_found`, … — stored per attempt, so
  the log says *why*, not just "error".
- **`PermanentError` short-circuits.** An invalid product id is not retried 4 times.

Measured over **26 consecutive live passes** against the store after these fixes
(runs of 8, 6 and 12): **26/26 produced a validated observation, 0 final failures.**
14 individual attempts failed along the way and were recovered by retry — the worst
pass needed 4 attempts (`reveal_click_failed` → `reveal_timeout` → `price_pending` →
success). Observed attempt-level failure modes, all handled:

| Failure code | What it means |
|---|---|
| `reveal_timeout` | the store dropped the quote callback; only a reload fixes it |
| `price_pending` | the figure was rendered as "Updating…" and is not final |
| `reveal_click_failed` | the consent overlay re-appeared and intercepted the click |
| `price_block_missing` | the product page did not render (error message captured in the log) |
| `rate_limited` | the store returned 429; backs off 30 s rather than retrying immediately |

Before the adaptive-wait fix the same test failed 1 pass in 5.

## 5. Honest history and logging

Two rules are enforced in the database itself, not just in application code:

- **`price_history` is written only after validation passes.** A failed scrape writes
  no row at all — so the history has no zeroes, no nulls, and no gap-filling. A gap in
  the chart genuinely means "no good data for that window", and the last known good
  price is never overwritten by a failure.
- **`scrape_logs` gets exactly one row per scrape, whatever happened**, carrying the
  per-attempt `attempt_trail`. A scrape that failed twice and then succeeded is logged
  as `retried`, not `success`, and the UI shows the failed attempts underneath it.

Postgres `CHECK` constraints make the dishonest states unrepresentable:

```sql
constraint success_has_values check (
  (status = 'failed'  and scraped_price is null and scraped_stock is null)
  or (status <> 'failed' and scraped_price is not null and scraped_stock is not null)
),
constraint failure_has_reason check (status <> 'failed' or failure_code is not null),
constraint stock_consistent   check (in_stock = (stock_quantity > 0))
```

A bug that tried to log a failure as a success would be rejected by the database.

## 6. Scheduling, concurrency and overlap

Render's free tier sleeps, so an in-process `setInterval` would simply stop running —
and would also be wrong on a restart. Scheduling is therefore external:
**cron-job.org calls `POST /api/cron/scrape` every 2 hours**, authenticated with a
shared secret compared in constant time, plus a second unauthenticated job hitting
`GET /api/health` every 10 minutes as the keep-warm ping.

The keep-warm ping must target `/api/health`, not `/api/status`: `/api/status` carries
recent runs, logs and alerts (~26 KB) and exceeds cron-job.org's response cap, so it fails
on every run and the job is eventually disabled. The instance then goes cold, and a
scheduled scrape arriving at a spun-down service is answered by Render's edge
(`x-render-routing: no-deploy`) with an HTML error page — the request never reaches Node,
so nothing is recorded in `scrape_runs` and the miss is invisible from inside the app.

The scheduled caller uses `?async=1`, which acknowledges with `202` and runs the scrape
in the background. A run takes 40–90 s while cron services cap a request at ~30 s, so a
synchronous endpoint would be logged as a failure on every single run — and cron-job.org
**disables** a job that keeps failing. That would have stopped the schedule silently,
which is the exact failure mode the assignment warns about. Only the HTTP acknowledgement
is early: the run is still recorded in full in `scrape_runs` and `scrape_logs`.

Because an external trigger can fire twice, or overlap a manual scrape:

- A partial unique index (`scrape_runs_single_active`) permits **one `running` row at a
  time**. A duplicate invocation gets a unique violation and returns `409` rather than
  starting a second browser fleet.
- A run abandoned by a killed process is **reaped** after 20 minutes so the lock cannot
  wedge the scheduler permanently.
- **Concurrency is capped at 2** browser contexts. Each is a real Chromium tab; on a
  512 MB free instance, more would OOM. Products are scraped by a small worker pool,
  and **one product's failure never aborts the run** — each task is individually
  guarded and each product's outcome is logged on its own.

## 7. Trade-offs made

| Decision | Gained | Given up |
|---|---|---|
| Playwright for price/stock | Actually works; survives challenge changes | ~6 s and ~300 MB per scrape |
| HTTP for catalogue | Fast search, no browser cost | Two code paths to maintain |
| Cross-check via a `TextDecoder` hook | Catches decoy-price mistakes outright | Depends on a store internal; degrades to DOM-only, never hard-fails |
| Mirroring the catalogue into Postgres | Instant partial-name search over 1000 products | Needs a periodic `catalog:sync`; can go stale |
| Concurrency of 2 | Fits the free tier | ~1 min for 10 products |
| Fail on `quote_mismatch` | Never records a wrong price | Occasionally discards a scrape that was probably fine |
| External cron | Correct on a sleeping free tier | An extra service to configure |

## 8. Wrong turns, and how they were corrected

These are the actual mistakes I made while building this, in order.

**1. I assumed the price was in the HTML.** My first instinct was a `fetch` +
Cheerio scraper. `curl` on the homepage returned a 459-byte empty SPA shell — no price,
no product data, nothing. *Correction:* read the JS bundle instead of guessing, which
revealed the `/api/*` endpoints and, eventually, that price is not served as data at all.

**2. I assumed the JSON API had the price.** Having found `/api/product/:id`, the
obvious conclusion was "great, skip the browser entirely". That endpoint returns specs
and reviews and **no price or stock field**. *Correction:* traced the price-rendering
component through the bundle and found the challenge/WASM/PoW pipeline, which settled
the HTTP-vs-browser question on evidence rather than preference.

**3. I would have scraped a decoy price.** The natural selectors — `.price-value` and
`[data-price]` — are exactly the two hidden decoys. This is the mistake that matters
most, because it produces no error: the scraper "works" and the history is quietly
wrong. *Correction:* found the decoys in the render code, switched to the layout-published
class, and added the cross-check in §3. The live probe confirmed the decoys read
₹27,130 and ₹30,547 while the true price was ₹25,739.

**4. Pagination looked like a way to enumerate the catalogue.** `/api/catalog?page=N`
looks ordinary. Calling `page=1` twice returns **different products** — the endpoint
samples randomly and caps `pageSize` at 60, so paging never enumerates all 1000.
*Correction:* verified ids are dense in `1..1000` (1000 → 200, 1001 → 404) and built
the index by walking ids instead.

**5. The consent modal was handled too optimistically.** The first version clicked
"Decline" immediately after `goto`. The SPA mounts the overlay *after* hydration, so
the click ran before the modal existed and every later click was intercepted by
`.cookie-overlay`. *Correction:* wait for the overlay explicitly — and, since it can
also reappear mid-gate, re-check for it inside the hover loop.

**6. The first timeout strategy was simply "wait longer".** Waiting 45 s for the price
turned the store's dropped-callback fault into a 45 s stall before each retry, and a
5-pass test failed 1/5. *Correction:* recognised the two distinct fault modes (§4) and
made the wait adaptive — extend while the store reports progress, fail fast when it is
silently stuck. The same test then passed 8/8.

**7. The catalogue sync silently lost 86% of the store.** The first sync run reported
`Fetched 143 products` out of 1000 and **exited successfully**. The store rate-limits
bursts with `429` + `Retry-After: 1`, and the HTTP client treated any non-404 error the
same as a 404 — "this product does not exist" — so 857 products were quietly dropped and
the search index shipped 14% complete. This is the same class of bug as the decoy price:
wrong data, no error. *Correction:* gave rate limiting its own `RateLimitError` type,
honoured `Retry-After` (with jitter) instead of guessing a shorter backoff, lowered
concurrency from 8 to 4, added re-sweep rounds over ids that genuinely failed, and made
the script **warn loudly and exit non-zero** on an incomplete sync. The re-run went
1000 → 208 missed → 4 → 0, and now reports `Catalogue rows: 1000/1000`.

**8. The browser scraper ignored rate limits that the HTTP client already handled.**
The first production run on Render scraped two products back to back and both failed
after four attempts each. The scrape log gave the reason verbatim: *"Couldn't load this
product: Error: product 429"* and *"upstream 429"*. The store rate-limits bursts — which
the HTTP catalogue client had been taught to respect (mistake 7) — but the browser path
treated a 429 like any other failure, burning four attempts in ~100 s and deepening the
limit it was hitting. *Correction:* the store renders the 429 into the page rather than
returning a status code we can see, so those strings are now detected and raised as
`rate_limited` with an explicit 30 s `retryAfterMs`, which `retry()` honours over its own
backoff; and products within a run are now spaced ~5 s apart, since back-to-back scraping
was what provoked the limit in the first place. Worth noting that nothing dishonest was
recorded during the failure — no history rows were written, and the diagnostic added in
mistake 9 is what made the cause obvious in seconds rather than hours.

**9. A real failure was mis-labelled `unknown`.** A `locator.click` timeout on the
reveal button surfaced as an untyped error, which would have made the scrape log less
useful precisely when it mattered. *Correction:* added a dedicated
`reveal_click_failed` code.

The pattern across all nine: every one was caught by **checking against the live site**
rather than by reasoning about it. Three of them — the decoy price, the random
pagination and the silent 86% catalogue loss — produced *no error at all*; they would
have shipped as quietly wrong data. Nothing here was verified by assumption.

## 9. Known limitations

- The cross-check hooks `TextDecoder.prototype.decode`, a store internal. If the store
  changes how it decodes payloads, observations silently drop to `cross_checked = false`
  rather than failing — correct behaviour, but the safety net is thinner until fixed.
- The mirrored catalogue goes stale; `npm run catalog:sync` must be re-run if the store
  changes its inventory. New products are otherwise invisible to search. A full sync
  takes ~16 minutes because the store rate-limits and we deliberately back off rather
  than hammer it.
- Free-tier Render cold starts add roughly 30–60 s to the first cron call of a quiet
  period. The run still completes; it just takes longer.
- Concurrency of 2 means a large number of tracked products lengthens the run
  substantially. Beyond ~20 products the 2-hour cadence would need a bigger instance.
- Alerts are recorded in-app only. Email delivery (SendGrid) was not implemented.
- There is no user authentication: anyone reaching the deployed API can read and track
  products. The endpoints that *cost* something are credential-protected, and the two
  capabilities are split so the browser never holds the powerful one: `CRON_SECRET`
  (server-side only) triggers full scheduled runs, while `MANUAL_SCRAPE_TOKEN` — which
  is bundled into the public frontend build — can only re-scrape an already-tracked
  product, is rate limited per IP, and is bounded by the global run lock. The read
  endpoints are deliberately open for the evaluator's convenience.
