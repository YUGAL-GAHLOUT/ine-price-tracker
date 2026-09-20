# INE Product Price Tracker

| | |
|---|---|
| **Live site** | https://ine-price-tracker.vercel.app |
| **API** | https://ine-price-tracker-backend-vwt5.onrender.com |

> The API runs on Render's free tier, which sleeps after inactivity. The first request
> after a quiet period takes 30–60 s to wake it; everything after that is immediate.

Tracks the price and stock of products from INE's mock storefront
([demo.inelabteamdev.com](https://demo.inelabteamdev.com)) on a 2-hourly schedule, and
records an honest history of what was observed — including the scrapes that failed.

The store is deliberately hard to scrape: the price is behind a mouse-movement gate and
a WebAssembly proof-of-work, the page renders decoy prices on the obvious selectors,
class names and price formats rotate, and ~35% of price loads are slowed or dropped on
purpose. The scraper is built around those realities — see
[`docs/design-note.md`](docs/design-note.md) for the reasoning and
[`docs/store-analysis.md`](docs/store-analysis.md) for the teardown.

## Overview

- **Search** the catalogue by partial or full name (brand and SKU match too).
- **Track** a product, identified by the store's stable numeric id, never by display name.
- **Scrape** each tracked product every 2 hours, triggered by an external cron service.
- **View** price and stock history as a chart and a table.
- **Inspect** a per-product scrape log with every attempt and its outcome.

Core guarantee: **a failed scrape never writes price history and never overwrites the
last known good price.** It is recorded as a failure, with a reason.

## Architecture

A React SPA on Vercel talks over HTTPS to an Express API on Render, which is the only
thing that touches Supabase (via `supabase-js`) or the store. cron-job.org POSTs to the
API every 2 hours with a shared secret; the scrape service handles retries and backoff,
validation, honest logging and bounded concurrency.

**Why two ways of talking to the store.** Catalogue metadata is plain JSON over HTTP, so
it is fetched with `fetch`. Price and stock are not served as data at all — getting them
requires executing WebAssembly, solving a proof-of-work and satisfying a mouse-movement
gate — so those, and only those, use Playwright.

**Why cron is external.** Render's free tier sleeps, so an in-process `setInterval` would
simply stop running. An external caller both triggers the run and wakes the instance.

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite + React Router + Recharts → Vercel |
| Backend | Node 22 + Express 4 (ESM) → Render |
| Database | Supabase (PostgreSQL) |
| Scraping | `fetch` for catalogue JSON · Playwright (Chromium) for price & stock |
| Scheduling | cron-job.org → `POST /api/cron/scrape`, every 2 hours |
| Validation | zod (API input) · hand-written parsers (scraped values) |

## Project structure

```
backend/src/
  scraper/   browser.js (shared Chromium + cross-check hook) · productScraper.js (one
             attempt: navigate → gate → reveal → extract) · normalize.js (price/stock
             parsing, pure and side-effect free) · retry.js (timeout, backoff, jitter)
  services/  storeClient.js (store JSON) · scrapeService.js (retries, validation, honest
             logging, concurrency) · trackingService.js
  config/ db/ controllers/ routes/ middleware/ utils/
backend/scripts/  scrape-cli.js (headed + dry-run modes) · sync-catalog.js
frontend/src/ pages, components, lib · database/schema.sql · docs/ · render.yaml
```

## Local setup

Prerequisites: Node >= 20 (22 recommended), npm, and a free Supabase project.

```bash
cd backend && npm install && cp .env.example .env    # installs Chromium too
cd ../frontend && npm install && cp .env.example .env
```

If the Playwright download is skipped, run
`npx playwright install chromium chromium-headless-shell` explicitly.

### Supabase

Create a free project, run the whole of [`database/schema.sql`](database/schema.sql) in
the SQL Editor (it is idempotent), then from **Project Settings → API** copy the Project
URL to `SUPABASE_URL` and the `service_role` key — the secret one, not `anon` — to
`SUPABASE_SERVICE_ROLE_KEY`. Finally populate the catalogue mirror that powers search:

```bash
cd backend && npm run catalog:sync
```

That walks the store's 1000 product ids and upserts them. It takes **~15–20 minutes**,
because the store rate-limits bursts (`429` + `Retry-After`) and the sync backs off rather
than hammering it; it re-sweeps failed ids, exits non-zero on an incomplete catalogue, and
is safe to re-run.

**Why a mirror?** `/api/catalog` returns a *random sample* per call and caps `pageSize` at
60, so it cannot be paged to enumerate the catalogue. Ids are dense in `1..1000`, so
walking ids is the only reliable way to build a search index.

**Security.** The service-role key bypasses Row Level Security and must stay on the
backend. RLS is enabled on every table with no policies, so the public `anon` key — the
only key that could ever reach a browser — can read nothing.

## Database schema

Full DDL in [`database/schema.sql`](database/schema.sql).

| Table | Purpose |
|---|---|
| `catalog_products` | Catalogue mirror; powers partial-name search (trigram index) |
| `tracked_products` | What the user chose to track, keyed by `store_product_id` |
| `scrape_runs` | One row per run; doubles as the lock preventing overlapping runs |
| `price_history` | **Validated observations only** — a failed scrape writes nothing here |
| `scrape_logs` | One row per scrape per product, with a per-attempt `attempt_trail` |
| `alerts` | Price drop / rise, back-in-stock, out-of-stock, page-structure change |

Honesty is enforced by the database, not just by application code — a failed log cannot
carry values, a successful one cannot omit them, a failure must carry a reason, and
`in_stock` must agree with `stock_quantity`:

```sql
constraint success_has_values check (
  (status = 'failed'  and scraped_price is null and scraped_stock is null)
  or (status <> 'failed' and scraped_price is not null and scraped_stock is not null)
)
```

## Environment variables

`backend/.env` — required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `CRON_SECRET`
(`openssl rand -hex 32`; full scrape-trigger rights, server-side only).

| Optional | Default | Purpose |
|---|---|---|
| `MANUAL_SCRAPE_TOKEN` | — | Low-privilege token enabling the dashboard's "Scrape now" button. Must differ from `CRON_SECRET` (the server refuses to start otherwise). Unset ⇒ button hidden |
| `PORT` | `8080` | HTTP port (Render sets this) |
| `NODE_ENV` | `development` | `production` hides internal error details |
| `CORS_ORIGINS` | `*` | Comma-separated; set to your Vercel URL in production |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `SCRAPE_*` | see below | Tuning: `MAX_ATTEMPTS` 4, `ATTEMPT_TIMEOUT_MS` 60000, `RETRY_BASE_MS` 1500, `RETRY_MAX_MS` 15000, `CONCURRENCY` 2 (each is a browser tab), `RUN_LOCK_STALE_MS` 1200000 |

`frontend/.env` — `VITE_API_BASE_URL` (required, no trailing slash) and optionally
`VITE_MANUAL_SCRAPE_TOKEN`, which must equal the backend's `MANUAL_SCRAPE_TOKEN`.
Anything `VITE_`-prefixed is bundled into public JavaScript, which is exactly why that
is a separate, deliberately weak credential. **Never put `CRON_SECRET` there.**

Real credentials live in `.env`, which is git-ignored; only `.env.example` is committed.

## Running

```bash
cd backend && npm run dev        # API      → http://localhost:8080
cd frontend && npm run dev       # frontend → http://localhost:5173
```

Open <http://localhost:5173> → **Add product**, search `helix`, click **Track**.

### Running the scraper directly

```bash
cd backend
npm run scrape:once                            # every due tracked product → Supabase
node scripts/scrape-cli.js --all               # ignore intervals, scrape all active
node scripts/scrape-cli.js --id 88 --repeat 5  # dry run, no database, exercises retries
npm run scrape:demo                            # visible Chromium, 5 passes, no database
npm run scrape:headed                          # visible, all tracked products → Supabase
```

The headed modes open a real Chromium window with `slowMo` and log every step with a
timestamp:

```
[18:55:27.030]     · hover-gate
[18:55:30.744]     · reveal
[18:55:31.076]     · store-retry          ← the store reported an internal retry
[18:55:32.784]   attempt 1: SUCCESS in 8227ms
[18:55:32.784]   RESULT price=₹25739 stock=32 source=layout_class crossChecked=true
```

Since the store fails or stalls roughly a third of price loads, a handful of passes
reliably shows a slow response, a failed attempt, the backoff, a successful retry, and a
run that exhausts its attempts and is recorded as a failure with nothing written to
history. Production always runs headless; headed mode is a development tool.

## Scraping on a schedule

```
POST /api/cron/scrape?async=1     Authorization: Bearer <CRON_SECRET>
```

**Use `?async=1` for the scheduled caller.** A full run takes 40–90 s but cron services
cap a request at ~30 s, so a synchronous call would be logged as a failure on *every*
run — and cron-job.org disables a job that keeps failing, silently stopping the schedule.
With `async=1` the endpoint answers `202 {"accepted":true,"mode":"async"}` — **32 bytes, a
fixed string** — before it touches the database, then runs the scrape in the background.
The run is recorded in `scrape_runs` and `scrape_logs`, so the dashboard stays the source of
truth. Other responses: `200` ran to completion (synchronous, ≤ 100 bytes), `409` another
run already in progress (not an error), `401` bad secret.

The response never carries per-product results. A cron service aborts a response that
exceeds its cap and records the job as *failed (output too large)*, and enough failures
disable the job — so a response whose size grows with the number of tracked products is a
schedule that breaks once the dataset gets big enough.

The run reaps stale runs, takes the run lock, loads every active product whose interval has
elapsed (with a 10-minute grace window, since `last_scraped_at` is stamped when a scrape
*finishes* — a strict comparison turns a 2-hourly schedule into a 4-hourly one), scrapes
with bounded concurrency, and writes history for the successes and a log for every attempt.
One product failing never aborts the run.

#### Why the schedule does not depend on one cron service

On the free tier the instance is asleep when the trigger arrives, so the trigger has to
wake it — and the wake takes most of the caller's 30 s budget. Three things then go wrong
in a way the app cannot see: the wake overruns the request timeout; the edge answers with
an HTML error page while no instance is routable (this is the ~1 s *"output too large"* a
cron service reports, since its cap is far below the size of that page); or the free tier's
750 monthly instance-hours run out and the service is suspended, which looks identical.
Each is recorded by cron-job.org as a failed job, and a job that keeps failing is
**disabled** — which is why a bad slot costs fourteen hours rather than two.

Three independent mechanisms, so no single one stopping halts the schedule:

1. **cron-job.org** (primary) — the 2-hourly trigger, below.
2. **Boot catch-up** (`backend/src/server.js`) — on process start, anything overdue is
   scraped. The trigger that timed out at the HTTP level still *woke the instance*, so the
   work happens regardless of whether the response got back in time. Once per process, only
   for products whose interval has actually elapsed, and behind the same run lock — so a
   deploy right after a good run does nothing. Set `DISABLE_BOOT_CATCHUP=1` to turn it off.
3. **GitHub Actions** (`.github/workflows/scheduled-scrape.yml`) — the same trigger on the
   odd hours, halfway between cron-job.org's. It can wait out a cold start (no 30 s cap, no
   response cap) and does not disable itself on failure. Needs a `CRON_SECRET` repository
   secret. A slot the primary missed is picked up an hour later, and calls for products that
   are not due are no-ops server-side.

On cron-job.org, two jobs, both in the **same timezone** (UTC) so their offsets line up:

- **Scrape** — `POST` to `.../api/cron/scrape?async=1` on `0 */2 * * *`, header
  `Authorization: Bearer <CRON_SECRET>`, request timeout 30 s, and **2 retries 60-120 s
  apart**. Mark `409` as a success alongside `2xx`: a retry landing while the first
  attempt's background run still holds the lock gets `409`, which is correct behaviour and
  not a failure.
- **Keep warm** — `GET /api/health` on `50,55 1-23/2 * * *`, i.e. 5 and 10 minutes before
  each scrape, so the trigger at `:00` lands on an instance that is already awake. This is
  an optimisation, not a dependency: with the boot catch-up in place, a scrape still happens
  if it is missing.

Use `/api/health` (35 bytes), **not** `/api/status` — the latter returns recent runs, logs
and alerts (~40 KB), which exceeds cron-job.org's response cap. That fails the job every
run, and a job that keeps failing gets disabled — leaving the instance cold, so the next
scheduled scrape hits a spun-down service and returns Render's HTML error page instead.

Warm the instance *before* each scrape rather than around the clock. A ping every 10 or 15
minutes works, but it never lets the instance sleep: that is ~730 of the free tier's 750
monthly instance-hours for a service that needs to be awake twelve times a day, and running
out suspends the service — which looks like exactly the same HTML error page. A 15-minute
ping is also marginal on its own terms, since Render sleeps after ~15 minutes idle and
cron-job.org fires with up to a minute of jitter, so two pings can fall more than 15 minutes
apart. Two pings just before the scrape are both cheaper and more reliable.

#### Diagnosing a failed scheduled run

```bash
cd backend && node scripts/test-cron-production.js
```

Reproduces the cron service's exact request and reports status, duration, content type,
**body size** and whether the body is JSON. A non-JSON body means the platform edge answered
and the request never reached Node — check Render first, not the cron configuration. The
secret is read from `CRON_SECRET` and never printed.

### Manual scraping

**Why two credentials.** Anything the browser sends is baked into the public Vite bundle,
so shipping `CRON_SECRET` there would hand the scheduled-scrape endpoint to anyone who
opened DevTools. `CRON_SECRET` triggers full runs and never leaves the server;
`MANUAL_SCRAPE_TOKEN` can only re-scrape an *already-tracked* product, is rate limited to 6
requests per 10 minutes per IP, and is bounded by the global run lock (a concurrent request
gets `409`, not a second browser). An interactive scrape also runs on a reduced budget
(3 attempts × 45 s) so it cannot hold a spinner open for minutes.

## API reference

All routes are prefixed `/api`. **[C]** requires `CRON_SECRET`; **[M]** accepts
`CRON_SECRET` or the low-privilege `MANUAL_SCRAPE_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` · `/status` | Liveness · recent runs, logs and alerts |
| `GET` | `/products/search?q=&limit=` | Search the catalogue (partial name, brand, SKU) |
| `GET` | `/tracked-products` | Dashboard list with latest price and scrape status |
| `POST` | `/tracked-products` | Track — `{ storeProductId, scrapeIntervalMinutes? }` |
| `GET` `PATCH` `DELETE` | `/tracked-products/:id` | Read · `{ isActive?, scrapeIntervalMinutes? }` · stop tracking |
| `GET` | `/tracked-products/:id/history` | Price + stock history, oldest first (chart-ready) |
| `GET` | `/tracked-products/:id/logs` · `/alerts` | Scrape log with per-attempt trail · alerts |
| `POST` | `/tracked-products/:id/scrape` | **[M]** Scrape one tracked product now (rate limited) |
| `POST` `GET` | `/cron/scrape` | **[C]** Scheduled run. `?async=1` returns 202; `?force=1` ignores intervals |

Errors use one shape:
`{ "error": { "code": "not_found", "message": "Tracked product … not found" } }`

## Testing

Verification is against the live store, which is the only environment that reproduces its
faults — rotating price formats, decoy selectors, dropped callbacks and rate limiting:

```bash
cd backend
node scripts/scrape-cli.js --id 88 --repeat 12
```

The run prints every attempt and its outcome, so retries and recovered failures are visible
as they happen. Most recent measured result: **26/26 passes produced a validated
observation** across runs of 8, 6 and 12, with 14 individual attempts failing and recovered
by retry. CI builds the production frontend on every push, and a scheduled workflow
smoke-tests the scraper against the live store daily.

## Deployment

**Backend → Render, on the Docker runtime, not the native Node runtime.** Chromium needs
system libraries that `playwright install --with-deps` installs via `apt-get`, and Render's
build step runs without root, so that fails with `su: Authentication failure`.
[`backend/Dockerfile`](backend/Dockerfile) is based on Playwright's official image, which
already has them. Use the committed [`render.yaml`](render.yaml) blueprint, or a Web Service
with Dockerfile path `./backend/Dockerfile`, build context `./backend`, health check
`/api/health`. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`,
`NODE_ENV=production`, `CORS_ORIGINS=https://<your-app>.vercel.app`; on the free instance
(0.1 CPU / 512 MB) also `SCRAPE_CONCURRENCY=1` and `SCRAPE_ATTEMPT_TIMEOUT_MS=90000`, since
Chromium is several times slower there. Then seed the catalogue once with
`npm run catalog:sync`.

**Frontend → Vercel:** root directory `frontend`, framework Vite, build `npm run build`,
output `dist`, `VITE_API_BASE_URL` set to the Render URL.
[`frontend/vercel.json`](frontend/vercel.json) adds the SPA rewrite so deep links work.
Vercel bakes env vars in at *build* time, so redeploy after changing one.

Post-deploy, `/api/health` should return `{"status":"ok"}`,
`/api/products/search?q=helix` should return matches, `POST /api/cron/scrape` with the
secret should return a run summary and without it `401`. Then load the Vercel URL and
confirm the dashboard populates, which also confirms CORS.

## Reliability strategy

Set out in full in [`docs/design-note.md`](docs/design-note.md). The load-bearing points:
HTTP for catalogue JSON and a browser only for price and stock; the real price element is
found via the class published at `/api/layout`, never the decoy selectors; a value that is
not fully understood returns `null` and fails the scrape instead of being guessed; the
parsed value is cross-checked against the figure the page computed, and disagreement fails
the scrape rather than recording either; every wait is bounded, and extends while the store
reports internal retries but fails fast when it is silently stuck; 4 attempts with
exponential backoff and full jitter, typed failure codes, no infinite loops; a failure
writes a log row with a reason and no history row, so the last known good price is never
overwritten.

## Known limitations

- The cross-check depends on a store internal; if it changes, observations degrade to
  `cross_checked = false` rather than failing.
- The catalogue mirror goes stale — re-run `npm run catalog:sync` if inventory changes.
- Render free-tier cold starts add 30–60 s to the first cron call after an idle period.
- Concurrency of 2 means the run lengthens with many tracked products; beyond ~20 the
  2-hour cadence would need a larger instance.
- Alerts are in-app only; email delivery was not implemented.
- No user authentication. Read endpoints are open for evaluation; everything that triggers
  a scrape requires the shared secret.
