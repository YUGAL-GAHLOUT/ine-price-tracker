# INE Product Price Tracker

Tracks the price and stock of products from INE's mock storefront
([demo.inelabteamdev.com](https://demo.inelabteamdev.com)) on a **2-hourly schedule**,
and records an honest history of what was observed — including the scrapes that failed.

The store is deliberately hard to scrape: the price is hidden behind a mouse-movement
gate and a WebAssembly proof-of-work, the page renders **decoy prices on the obvious
selectors**, CSS class names and price formats rotate, and ~35% of price loads are
slowed or dropped on purpose. The scraper is built around those realities — see
[`docs/design-note.md`](docs/design-note.md) for the reasoning and
[`docs/store-analysis.md`](docs/store-analysis.md) for the full teardown.

---

## Table of contents

1. [Overview](#1-overview) · 2. [Architecture](#2-architecture) · 3. [Tech stack](#3-tech-stack)
4. [Project structure](#4-project-structure) · 5. [Local setup](#5-local-setup)
6. [Supabase setup](#6-supabase-setup) · 7. [Database schema](#7-database-schema)
8. [Environment variables](#8-environment-variables) · 9. [Running everything](#9-running-everything)
10. [Headed / observable run](#10-headed--observable-run) · 11. [Manual scraping](#11-manual-scraping)
12. [Scheduled scraping](#12-scheduled-scraping-every-2-hours) · 13. [API reference](#13-api-reference)
14. [Testing](#14-testing) · 15. [Deployment](#15-deployment)
16. [Reliability strategy](#16-scraping-reliability-strategy) · 17. [Known limitations](#17-known-limitations)

---

## 1. Overview

- **Search** the store's catalogue by partial or full product name (brand and SKU match too).
- **Track** a product; it is persisted in Supabase and identified by the store's stable
  numeric product id, never by its display name.
- **Scrape** each tracked product's current price and stock **every 2 hours**, triggered
  by an external cron service.
- **View** price and stock history as a chart and a table.
- **Inspect** a per-product scrape log with every attempt and its outcome
  (`success` / `retried` / `failed`), including a per-attempt breakdown.

Core guarantee: **a failed scrape never writes price history and never overwrites the
last known good price.** It is recorded as a failure, with a reason.

## 2. Architecture

```
┌──────────────┐   HTTPS    ┌───────────────────────┐   supabase-js  ┌──────────────┐
│  React SPA   │──────────▶ │  Express API          │───────────────▶│  Supabase    │
│  (Vercel)    │            │  (Render)             │                │  PostgreSQL  │
└──────────────┘            │                       │                └──────────────┘
                            │  ┌─────────────────┐  │
┌──────────────┐  POST      │  │ Scrape service  │  │   fetch (JSON)   ┌──────────────┐
│ cron-job.org │───────────▶│  │  · retry/backoff│  │─────────────────▶│  INE mock    │
│  every 2h    │  + secret  │  │  · validation   │  │                  │  store       │
└──────────────┘            │  │  · honest logs  │  │   Playwright     │              │
                            │  └─────────────────┘  │═════════════════▶│              │
                            └───────────────────────┘  (price & stock)  └──────────────┘
```

**Why two ways of talking to the store.** Catalogue metadata is plain JSON over HTTP, so
it is fetched with `fetch`. Price and stock are not served as data at all — obtaining
them requires executing WebAssembly, solving a proof-of-work and satisfying a
mouse-movement gate — so those, and only those, use Playwright.

**Why cron is external.** Render's free tier sleeps. An in-process `setInterval` would
simply stop running. An external caller both triggers the run *and* wakes the instance.

## 3. Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite + React Router + Recharts → **Vercel** |
| Backend | Node 22 + Express 4 (ESM) → **Render** |
| Database | **Supabase** (PostgreSQL) |
| Scraping | `fetch` for catalogue JSON · **Playwright** (Chromium) for price & stock |
| Scheduling | **cron-job.org** → `POST /api/cron/scrape`, every 2 hours |
| Validation | zod (API input) · hand-written parsers (scraped values) |
| Tests | `node:test` |

## 4. Project structure

```
backend/
  src/
    config/        env.js, store.js        # store.js pins the only scrapeable origin
    db/            supabase.js, repositories/
    scraper/       browser.js              # shared Chromium + the cross-check hook
                   productScraper.js       # one attempt: navigate → gate → reveal → extract
                   normalize.js            # price/stock parsing (pure, heavily tested)
                   retry.js                # timeout, backoff+jitter, bounded retries
    services/      storeClient.js          # HTTP access to the store's JSON
                   scrapeService.js        # retries, validation, honest logging, concurrency
                   trackingService.js
    controllers/   routes/  middleware/  utils/
    app.js  server.js
  scripts/         scrape-cli.js           # headed + dry-run modes
                   sync-catalog.js
  tests/
frontend/          src/pages, src/components, src/lib
database/          schema.sql
docs/              design-note.md, store-analysis.md
.github/workflows/ ci.yml, scrape-smoke.yml
render.yaml
```

## 5. Local setup

**Prerequisites:** Node ≥ 20 (22 recommended), npm, and a free Supabase project.

```bash
git clone <your-repo-url>
cd iNE
```

**Backend**

```bash
cd backend
npm install                 # also installs Chromium for Playwright
cp .env.example .env        # then fill it in — see §8
```

If the Playwright download is skipped for any reason, run it explicitly:

```bash
npx playwright install chromium chromium-headless-shell
```

**Frontend**

```bash
cd ../frontend
npm install
cp .env.example .env
```

## 6. Supabase setup

1. Create a project at [supabase.com](https://supabase.com) (free tier).
2. Open **SQL Editor**, paste the whole of [`database/schema.sql`](database/schema.sql),
   and **Run**. It is idempotent, so it is safe to re-run.
3. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **`service_role` key** → `SUPABASE_SERVICE_ROLE_KEY` (the secret one, *not* `anon`)
4. Populate the catalogue mirror that powers search:

   ```bash
   cd backend && npm run catalog:sync
   ```

   This walks the store's 1000 product ids and upserts them. **It takes ~15–20 minutes**,
   because the store rate-limits bursts (`429` + `Retry-After`) and the sync backs off
   rather than hammering it. It prints progress, re-sweeps any ids that failed, warns
   loudly and exits non-zero if the catalogue is incomplete, and is safe to re-run.

> **Why a mirror?** The store's `/api/catalog` returns a *random sample* on every call
> and caps `pageSize` at 60, so it cannot be paged through to enumerate the catalogue.
> Product ids are dense in `1..1000`, so walking ids is the only reliable way to build a
> complete search index.

> **Security.** The service-role key bypasses Row Level Security and must stay on the
> backend. RLS is enabled on every table with no policies, so the public `anon` key —
> the only key that could ever reach a browser — can read nothing.

## 7. Database schema

Full DDL in [`database/schema.sql`](database/schema.sql).

| Table | Purpose |
|---|---|
| `catalog_products` | Mirror of the store catalogue; powers partial-name search (trigram index) |
| `tracked_products` | What the user chose to track, keyed by the store's `store_product_id` |
| `scrape_runs` | One row per triggered run; doubles as the lock preventing overlapping runs |
| `price_history` | **Validated observations only** — a failed scrape writes nothing here |
| `scrape_logs` | One row per scrape per product, with a per-attempt `attempt_trail` |
| `alerts` | Price drop / rise, back-in-stock, out-of-stock, page-structure change |

Honesty is enforced by the database, not just by application code:

```sql
-- a failed log cannot carry values; a successful one cannot omit them
constraint success_has_values check (
  (status = 'failed'  and scraped_price is null and scraped_stock is null)
  or (status <> 'failed' and scraped_price is not null and scraped_stock is not null)
)
constraint failure_has_reason check (status <> 'failed' or failure_code is not null)
constraint stock_consistent   check (in_stock = (stock_quantity > 0))
```

## 8. Environment variables

### Backend — `backend/.env`

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SUPABASE_URL` | ✅ | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | — | Service-role key. **Backend only — never expose** |
| `CRON_SECRET` | ✅ | — | Shared secret for every scrape-triggering endpoint. `openssl rand -hex 32` |
| `PORT` | | `8080` | HTTP port (Render sets this automatically) |
| `NODE_ENV` | | `development` | `production` hides internal error details |
| `CORS_ORIGINS` | | `*` | Comma-separated allowed origins; set to your Vercel URL in production |
| `LOG_LEVEL` | | `info` | `debug` \| `info` \| `warn` \| `error` |
| `SCRAPE_MAX_ATTEMPTS` | | `4` | Attempts per product per run, including the first |
| `SCRAPE_ATTEMPT_TIMEOUT_MS` | | `60000` | Hard ceiling on one attempt |
| `SCRAPE_RETRY_BASE_MS` | | `1500` | Backoff base |
| `SCRAPE_RETRY_MAX_MS` | | `15000` | Backoff cap |
| `SCRAPE_CONCURRENCY` | | `2` | Products scraped in parallel (each is a browser tab) |
| `SCRAPE_RUN_LOCK_STALE_MS` | | `1200000` | A `running` run older than this is reaped |

### Frontend — `frontend/.env`

| Variable | Required | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | ✅ | Backend base URL, no trailing slash |
| `VITE_SCRAPE_SECRET` | | Enables the in-app "Scrape now" button. **Anything `VITE_`-prefixed is bundled into public JavaScript** — leave this empty in production and scrape via cron or the CLI. The UI hides the button and explains why when it is unset. |

Real credentials go in `.env`, which is git-ignored. Only `.env.example` is committed.

## 9. Running everything

```bash
# Backend API  → http://localhost:8080
cd backend && npm run dev

# Frontend     → http://localhost:5173
cd frontend && npm run dev
```

Check the API is alive:

```bash
curl http://localhost:8080/api/health
```

Then open <http://localhost:5173>, go to **Add product**, search for something
(e.g. `helix`), and click **Track**.

### Running the scraper directly

```bash
cd backend

# Scrape every tracked product that is due, writing to Supabase
npm run scrape:once

# Ignore each product's interval and scrape all active products
node scripts/scrape-cli.js --all

# Dry run against one store product id — no database needed, nothing persisted
node scripts/scrape-cli.js --id 88
node scripts/scrape-cli.js --id 88 --repeat 5     # exercise retries and failures
```

## 10. Headed / observable run

```bash
cd backend
npm run scrape:headed                                   # visible browser, slowed down
node scripts/scrape-cli.js --headed --slow --id 88 --repeat 4   # dry run, no DB needed
```

`scrape:headed` opens a real Chromium window with `slowMo` so each step is watchable,
and logs every step with a timestamp:

```
[18:55:24.557] ──── pass 4/8 ────
[18:55:25.102]   attempt 1: starting
[18:55:25.140]     · navigate
[18:55:25.881]     · consent
[18:55:27.030]     · hover-gate
[18:55:30.744]     · reveal
[18:55:30.780]     · await-quote
[18:55:31.076]     · store-retry          ← the store reported an internal retry
[18:55:32.784]   attempt 1: SUCCESS in 8227ms
[18:55:32.784]   RESULT price=₹25739 stock=32 inStock=true source=layout_class crossChecked=true
```

**For the 2–4 minute demo recording**, use `--repeat 5` or more. The store fails or
stalls roughly a third of price loads, so a handful of passes reliably shows a slow
response, a failed attempt, the backoff, and a successful retry — plus a run that
exhausts its attempts and is recorded as a failure with **nothing written to history**.

Production always runs headless; headed mode is a development and demonstration tool.

## 11. Manual scraping

Protected by `CRON_SECRET`, so the endpoint is not a free browser for the internet.

```bash
curl -X POST http://localhost:8080/api/tracked-products/<uuid>/scrape \
  -H "Authorization: Bearer $CRON_SECRET"
```

The dashboard also shows a **Scrape now** button, but only when `VITE_SCRAPE_SECRET` is
set (i.e. local/demo builds). Otherwise it explains why the button is hidden.

## 12. Scheduled scraping (every 2 hours)

The backend exposes a cron endpoint instead of running an internal timer:

```
POST /api/cron/scrape        Authorization: Bearer <CRON_SECRET>
```

It reaps stale runs, takes the run lock, loads every active product whose interval has
elapsed, scrapes them with bounded concurrency, writes history for the successes and a
log for every attempt, and returns a summary. A single product failing never aborts the
run.

### Configuring cron-job.org

1. Sign in at [cron-job.org](https://cron-job.org) → **Create cronjob**.
2. **URL:** `https://<your-render-service>.onrender.com/api/cron/scrape`
3. **Schedule:** *Every 2 hours* — or custom: minutes `0`, hours
   `0,2,4,6,8,10,12,14,16,18,20,22`.
4. **Request method:** `POST`
5. **Headers:** `Authorization: Bearer <your CRON_SECRET>`
6. **Advanced → Request timeout:** raise it to the maximum (30 s). Render free-tier cold
   starts take 30–60 s, so the *first* call after an idle period may time out from
   cron's perspective while the run still completes server-side. Treat occasional
   timeouts as expected; the `Activity` page shows what actually ran.
7. Save and use **Test run** to confirm you get `200`.

Response codes: `200` ran · `409` another run already in progress (not an error) ·
`401` bad or missing secret.

> Optionally add a second cronjob hitting `GET /api/status` every 10 minutes to keep the
> instance warm, which removes most cold-start latency.

## 13. API reference

All routes are prefixed `/api`. 🔒 = requires `Authorization: Bearer <CRON_SECRET>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` | `/status` | Recent runs, recent logs, recent alerts |
| `GET` | `/products/search?q=&limit=` | Search the store catalogue (partial or full name, brand, SKU) |
| `GET` | `/tracked-products` | Dashboard list, each with latest price and latest scrape status |
| `POST` | `/tracked-products` | Track a product — `{ storeProductId, scrapeIntervalMinutes? }` |
| `GET` | `/tracked-products/:id` | One tracked product |
| `PATCH` | `/tracked-products/:id` | `{ isActive?, scrapeIntervalMinutes? }` |
| `DELETE` | `/tracked-products/:id` | Stop tracking |
| `GET` | `/tracked-products/:id/history` | Price + stock history, oldest first (chart-ready) |
| `GET` | `/tracked-products/:id/logs` | Scrape log with per-attempt trail |
| `GET` | `/tracked-products/:id/alerts` | Alerts for this product |
| `POST` | `/tracked-products/:id/scrape` | 🔒 Scrape one product now |
| `POST` `GET` | `/cron/scrape` | 🔒 Scheduled run. `?force=1` ignores intervals |

Errors use one shape:

```json
{ "error": { "code": "not_found", "message": "Tracked product … not found" } }
```

## 14. Testing

```bash
cd backend && npm test
```

44 unit tests covering the parts where a bug would corrupt data silently:

- **`parsePrice`** — all seven formats the store rotates through (default, spaced,
  European, trailing-text, full-width Unicode, NBSP, split-carrier with zero-width
  spaces), Indian lakh grouping, genuine paise — and rejection of empty, non-numeric,
  zero and absurd values rather than guessing.
- **`parseStock`** — all five in-stock phrasings, genuine out-of-stock, and the critical
  case that a **missing or unrecognised badge is a failure, not "out of stock"**.
- **`retry`** — success, recovery after transient failures, bounded give-up,
  `PermanentError` short-circuit, and that **every attempt is reported** so the log can
  show failures that preceded a success.
- **`backoffDelay`** — exponential growth, cap respected, genuine jitter.
- **Rate limiting** — `Retry-After` is honoured over our own backoff, and a 429 surfaces
  as its own type so it can never be mistaken for "product not found".
- **`withTimeout`** — rejects when a promise never settles (the store's worst fault).
- **Target guard** — only `demo.inelabteamdev.com` URLs can ever be produced; ids that
  are not positive integers are rejected, so no caller can redirect the scraper.

**Integration testing against the live store** (this is the one that matters):

```bash
node scripts/scrape-cli.js --id 88 --repeat 12
```

Most recent measured result: **26/26 passes produced a validated observation** across
runs of 8, 6 and 12, with 14 individual attempts failing and being recovered by retry.

CI (GitHub Actions) runs the unit tests and a production frontend build on every push;
a separate scheduled workflow smoke-tests the scraper against the live store daily.

## 15. Deployment

### Backend → Render

Use the **Docker** runtime, not Render's native Node runtime.

Chromium needs system libraries (`libnss3`, `libatk`, `libgbm`, fonts…) that
`playwright install --with-deps` installs via `apt-get`. Render's build step runs
without root, so that command fails with `su: Authentication failure` →
`Failed to install browsers`. [`backend/Dockerfile`](backend/Dockerfile) is based on
Playwright's official image, which already contains them.

Either use the committed [`render.yaml`](render.yaml) blueprint (**New → Blueprint**), or
configure a Web Service manually:

| Setting | Value |
|---|---|
| Language / Runtime | **Docker** |
| Dockerfile path | `./backend/Dockerfile` |
| Docker build context | `./backend` |
| Health check path | `/api/health` |

On the free instance (0.1 CPU / 512 MB) also set `SCRAPE_CONCURRENCY=1` and
`SCRAPE_ATTEMPT_TIMEOUT_MS=90000` — one browser at a time, and a longer per-attempt
budget, since Chromium is several times slower there than on a laptop.

Environment variables to set in the dashboard: `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `NODE_ENV=production`,
`CORS_ORIGINS=https://<your-vercel-app>.vercel.app`.

After the first deploy, seed the catalogue once from the Render shell
(or locally against the same Supabase project):

```bash
npm run catalog:sync
```

> Chromium on a 512 MB / 0.1 CPU free instance is tight. `SCRAPE_CONCURRENCY=1` is chosen
> for that; raise it only on a paid plan.

### Frontend → Vercel

| Setting | Value |
|---|---|
| Root directory | `frontend` |
| Framework | Vite |
| Build command | `npm run build` |
| Output directory | `dist` |

Set `VITE_API_BASE_URL` to your Render URL. Leave `VITE_SCRAPE_SECRET` **unset** in
production. [`frontend/vercel.json`](frontend/vercel.json) adds the SPA rewrite so deep
links work.

### Cron → cron-job.org

See [§12](#12-scheduled-scraping-every-2-hours).

### Post-deploy checklist

```bash
curl https://<render>.onrender.com/api/health                      # → {"status":"ok"}
curl "https://<render>.onrender.com/api/products/search?q=helix"    # → matches
curl -X POST https://<render>.onrender.com/api/cron/scrape \
     -H "Authorization: Bearer $CRON_SECRET"                        # → run summary
curl -X POST https://<render>.onrender.com/api/cron/scrape          # → 401 (secret works)
```

Then load the Vercel URL and confirm the dashboard populates (CORS is correct).

## 16. Scraping reliability strategy

Summarised here; the reasoning is in [`docs/design-note.md`](docs/design-note.md).

1. **Right tool per job.** HTTP for catalogue JSON; a browser only for price and stock,
   which genuinely require executing WASM and a proof-of-work.
2. **Obey rate limits, and never mistake one for "not found".** The store answers bursts
   with `429` + `Retry-After`; that has its own error type, the server's delay is
   honoured, and failed ids are re-swept rather than silently dropped. During a browser
   scrape the store renders the 429 into the page instead, so that text is detected too
   and backed off for 30 s, and products in a run are spaced ~5 s apart.
3. **Never trust the obvious selector.** The store renders two *hidden decoy prices* on
   `.price-value` and `[data-price]`. The real element is located via the class the store
   publishes at `/api/layout`, with a structural fallback that raises a
   `structure_change` alert when used.
4. **Parse defensively.** Seven rotating price formats and five stock phrasings are
   normalised; anything not fully understood returns `null` and fails the scrape rather
   than guessing.
5. **Cross-check.** The parsed DOM value is compared against the figure the page itself
   computed. Disagreement fails the scrape (`quote_mismatch`) instead of recording either.
6. **Bound everything.** Per-attempt timeouts, because the store sometimes drops a
   callback and the page hangs forever.
7. **Retry deliberately.** 4 attempts, exponential backoff with full jitter, typed
   failure codes, `PermanentError` short-circuit — never an infinite loop.
8. **Distinguish slow from dead.** The wait extends while the store reports internal
   retries and fails fast when it is silently stuck, because only a reload fixes the latter.
9. **Fail honestly.** Failures write a log row with a reason and **no** history row. The
   last known good price is never overwritten. Database `CHECK` constraints make a
   dishonest log physically impossible.
10. **Survive the schedule.** External cron (free tiers sleep), a database-level run lock
   against duplicate invocations, stale-run reaping, capped concurrency, and per-product
   isolation so one failure never aborts a run.

## 17. Known limitations

- The cross-check depends on a store internal; if it changes, observations degrade to
  `cross_checked = false` rather than failing.
- The catalogue mirror goes stale — re-run `npm run catalog:sync` if inventory changes
  (~15–20 min, since the store rate-limits and the sync backs off politely).
- Render free-tier cold starts add 30–60 s to the first cron call after an idle period.
- Concurrency of 2 means the run lengthens with many tracked products; beyond ~20 the
  2-hour cadence would need a larger instance.
- Alerts are in-app only; SendGrid email was not implemented.
- No user authentication. Read endpoints are open for evaluation; everything that
  triggers a scrape requires the shared secret.
