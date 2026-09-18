-- =====================================================================
-- INE Product Price Tracker — Supabase / PostgreSQL schema
-- Run this once in the Supabase SQL editor (see README "Supabase setup").
-- Safe to re-run: every statement is idempotent.
-- =====================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;    -- fast ILIKE '%partial%' search

-- ---------------------------------------------------------------------
-- 1. catalog_products
--    A local mirror of the store's catalogue, used only to power search.
--    The store's /api/catalog endpoint returns a RANDOM sample on every
--    call, so it cannot be paged through reliably; we enumerate product
--    ids instead and cache the result here (see scripts/sync-catalog.js).
-- ---------------------------------------------------------------------
create table if not exists catalog_products (
  store_product_id integer primary key,
  slug             text not null,
  name             text not null,
  brand            text,
  category         text,
  sku              text,
  description      text,
  synced_at        timestamptz not null default now()
);

create index if not exists catalog_products_name_trgm
  on catalog_products using gin (name gin_trgm_ops);
create index if not exists catalog_products_brand_idx on catalog_products (brand);
create index if not exists catalog_products_category_idx on catalog_products (category);

-- ---------------------------------------------------------------------
-- 2. tracked_products
--    Products the user has chosen to track. Identified by the store's
--    stable numeric product id, never by display name.
-- ---------------------------------------------------------------------
create table if not exists tracked_products (
  id                      uuid primary key default gen_random_uuid(),
  store_product_id        integer not null unique,
  slug                    text not null,
  name                    text not null,
  brand                   text,
  category                text,
  sku                     text,
  url                     text not null,
  is_active               boolean not null default true,
  -- Bonus: per-product frequency. The cron endpoint honours this; the
  -- default matches the assignment's every-2-hours schedule.
  scrape_interval_minutes integer not null default 120
                            check (scrape_interval_minutes between 15 and 10080),
  last_scraped_at         timestamptz,
  last_success_at         timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists tracked_products_active_idx on tracked_products (is_active);

-- ---------------------------------------------------------------------
-- 3. scrape_runs
--    One row per triggered run (cron or manual). Doubles as an advisory
--    lock so a duplicate cron invocation cannot start an overlapping run.
-- ---------------------------------------------------------------------
create table if not exists scrape_runs (
  id                uuid primary key default gen_random_uuid(),
  trigger           text not null check (trigger in ('cron', 'manual', 'cli')),
  status            text not null default 'running'
                      check (status in ('running', 'completed', 'failed')),
  started_at        timestamptz not null default now(),
  completed_at      timestamptz,
  products_total    integer not null default 0,
  products_success  integer not null default 0,
  products_failed   integer not null default 0,
  notes             text
);

create index if not exists scrape_runs_started_idx on scrape_runs (started_at desc);
-- At most one run in flight at a time.
create unique index if not exists scrape_runs_single_active
  on scrape_runs ((status)) where status = 'running';

-- ---------------------------------------------------------------------
-- 4. price_history
--    ONLY validated observations land here. A failed scrape never writes
--    a row, so the history contains no zeroes, nulls or guesses.
-- ---------------------------------------------------------------------
create table if not exists price_history (
  id                 bigserial primary key,
  tracked_product_id uuid not null references tracked_products (id) on delete cascade,
  price              numeric(12, 2) not null check (price > 0),
  currency           text not null default 'INR',
  in_stock           boolean not null,
  stock_quantity     integer not null check (stock_quantity >= 0),
  mrp                numeric(12, 2) check (mrp is null or mrp > 0),
  seller             text,
  -- Provenance: how we found the price element, and whether the value was
  -- confirmed against the figure the page itself computed.
  price_source       text,
  cross_checked      boolean not null default false,
  layout_revision    bigint,
  scraped_at         timestamptz not null default now(),
  -- An out-of-stock listing must still report a quantity of 0, never null.
  constraint stock_consistent check (in_stock = (stock_quantity > 0))
);

create index if not exists price_history_product_time_idx
  on price_history (tracked_product_id, scraped_at desc);

-- ---------------------------------------------------------------------
-- 5. scrape_logs
--    One row per scrape of one product, recording EVERY attempt — including
--    attempts that failed before a later one succeeded.
-- ---------------------------------------------------------------------
create table if not exists scrape_logs (
  id                 bigserial primary key,
  tracked_product_id uuid not null references tracked_products (id) on delete cascade,
  run_id             uuid references scrape_runs (id) on delete set null,
  status             text not null check (status in ('success', 'retried', 'failed')),
  attempts           integer not null check (attempts >= 1),
  started_at         timestamptz not null,
  completed_at       timestamptz not null,
  duration_ms        integer not null check (duration_ms >= 0),
  failure_code       text,
  error_message      text,
  scraped_price      numeric(12, 2),
  scraped_stock      integer,
  -- Per-attempt breakdown: [{attempt, ok, durationMs, failureCode, error}]
  attempt_trail      jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  -- A successful log must carry the values it recorded; a failed one must not.
  constraint success_has_values check (
    (status = 'failed' and scraped_price is null and scraped_stock is null)
    or (status <> 'failed' and scraped_price is not null and scraped_stock is not null)
  ),
  constraint failure_has_reason check (status <> 'failed' or failure_code is not null)
);

create index if not exists scrape_logs_product_time_idx
  on scrape_logs (tracked_product_id, started_at desc);
create index if not exists scrape_logs_run_idx on scrape_logs (run_id);
create index if not exists scrape_logs_status_idx on scrape_logs (status);

-- ---------------------------------------------------------------------
-- 6. alerts  (bonus: price-drop / back-in-stock)
-- ---------------------------------------------------------------------
create table if not exists alerts (
  id                 bigserial primary key,
  tracked_product_id uuid not null references tracked_products (id) on delete cascade,
  type               text not null check (type in ('price_drop', 'price_rise', 'back_in_stock', 'out_of_stock', 'structure_change')),
  message            text not null,
  previous_value     numeric(12, 2),
  new_value          numeric(12, 2),
  acknowledged       boolean not null default false,
  created_at         timestamptz not null default now()
);

create index if not exists alerts_product_time_idx on alerts (tracked_product_id, created_at desc);
create index if not exists alerts_unack_idx on alerts (acknowledged) where acknowledged = false;

-- ---------------------------------------------------------------------
-- 7. updated_at trigger
-- ---------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tracked_products_set_updated_at on tracked_products;
create trigger tracked_products_set_updated_at
  before update on tracked_products
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 8. Row Level Security
--    The API talks to Postgres with the service-role key, which bypasses
--    RLS. Enabling RLS with no policies means the anon/public key — the
--    only key that could ever leak to a browser — can read nothing.
-- ---------------------------------------------------------------------
alter table catalog_products  enable row level security;
alter table tracked_products  enable row level security;
alter table scrape_runs       enable row level security;
alter table price_history     enable row level security;
alter table scrape_logs       enable row level security;
alter table alerts            enable row level security;
