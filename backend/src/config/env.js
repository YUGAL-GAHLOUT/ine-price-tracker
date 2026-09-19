import 'dotenv/config';

export { STORE_ORIGIN } from './store.js';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

const int = (name, fallback) => {
  const v = process.env[name];
  const n = v === undefined ? fallback : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: int('PORT', 8080),
  corsOrigins: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),

  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },

  cronSecret: required('CRON_SECRET'),

  /**
   * Low-privilege token for the dashboard's "Scrape now" button: it may re-scrape
   * one already-tracked product and nothing else. Optional — when unset, the
   * button is simply not offered. MUST be different from CRON_SECRET, because
   * this one is bundled into the public frontend build.
   */
  manualScrapeToken: process.env.MANUAL_SCRAPE_TOKEN ?? '',

  scraper: {
    /** Attempts per product per run, including the first. */
    maxAttempts: int('SCRAPE_MAX_ATTEMPTS', 4),
    /** Hard ceiling on a single attempt (navigation + gate + reveal). */
    attemptTimeoutMs: int('SCRAPE_ATTEMPT_TIMEOUT_MS', 60_000),
    /** Base for exponential backoff between attempts. */
    retryBaseMs: int('SCRAPE_RETRY_BASE_MS', 1_500),
    retryMaxMs: int('SCRAPE_RETRY_MAX_MS', 15_000),
    /** How many products are scraped in parallel. Keep small: each is a browser tab. */
    concurrency: int('SCRAPE_CONCURRENCY', 2),
    /** A run older than this is assumed dead and no longer blocks a new run. */
    runLockStaleMs: int('SCRAPE_RUN_LOCK_STALE_MS', 20 * 60_000),
  },
};

// Fail fast on the one misconfiguration that would defeat the whole split: the
// browser-visible token being the same string as the server-only cron secret.
if (config.manualScrapeToken && config.manualScrapeToken === config.cronSecret) {
  throw new Error('MANUAL_SCRAPE_TOKEN must not be the same value as CRON_SECRET: it is bundled into the public frontend build.');
}

export const isProd = config.nodeEnv === 'production';
