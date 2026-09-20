import * as trackedRepo from '../db/repositories/trackedProductsRepo.js';
import * as runsRepo from '../db/repositories/runsRepo.js';
import * as logsRepo from '../db/repositories/logsRepo.js';
import * as alertsRepo from '../db/repositories/alertsRepo.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { runScrape } from '../services/scrapeService.js';
import { logger } from '../utils/logger.js';

/**
 * The endpoint cron-job.org calls every 2 hours.
 *
 * Deliberately NOT an in-process timer: Render's free tier sleeps, so an
 * always-on loop would simply stop running. An external caller also wakes the
 * instance up, which is exactly what we need.
 *
 * `?force=1` ignores each product's configured interval (used for manual runs).
 *
 * `?async=1` acknowledges the trigger and runs the scrape in the background.
 * This is what the scheduled caller should use: a full run takes 40-90s, while
 * cron services cap a request at ~30s, so a synchronous response would be
 * recorded as a failure on every single run — and cron-job.org disables a job
 * that keeps failing, silently stopping the schedule. The run itself is still
 * recorded honestly in `scrape_runs` and `scrape_logs`; only the HTTP
 * acknowledgement is early.
 */
export const runScheduledScrape = asyncHandler(async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const background = req.query.async === '1' || req.query.async === 'true';

  if (background) {
    // Answer BEFORE touching Supabase. On a cold start the wake itself already
    // eats most of the caller's ~30s request budget, and a DB round trip added
    // on top of it is what turns a slow wake into a reported failure. Nothing
    // here depends on the answer, so there is no reason to wait for it.
    //
    // The body is a fixed string: its size cannot vary with how many products
    // are tracked or what the run finds. Cron services abort a response that
    // exceeds their cap and record the job as failed, and a job that keeps
    // failing gets disabled.
    res.status(202).json({ accepted: true, mode: 'async' });

    startBackgroundScrape({ force, reason: 'cron' });
    return;
  }

  const products = await trackedRepo.listDue({ ignoreInterval: force });
  if (!products.length) {
    return res.json({ ok: true, skipped: true, total: 0, succeeded: 0, failed: 0 });
  }

  logger.info('cron.run.start', { products: products.length, force, background: false });
  const summary = await runScrape({ trigger: 'cron', products });
  logger.info('cron.run.end', { total: summary.total, succeeded: summary.succeeded, failed: summary.failed });

  // 409 tells the caller this invocation did nothing because another run held the
  // lock, which is distinguishable from a real failure in its history view.
  if (summary.skipped) return res.status(409).json({ ok: false, skipped: true, reason: 'run in progress' });

  // Small on purpose: the per-product detail lives in scrape_runs, scrape_logs
  // and price_history, which is what the dashboard reads. Echoing it here only
  // risks the response being aborted by the caller.
  res.json({
    ok: summary.failed === 0,
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
  });
});

/**
 * Run a scheduled scrape detached from any HTTP request.
 *
 * Detached work is not a durable queue, and this does not pretend to be one: the
 * run takes a row in `scrape_runs` before it starts, so a process that dies
 * mid-run leaves a `running` row that `reapStale` (or the SIGTERM handler)
 * settles honestly rather than a silent gap. What makes it safe to detach is
 * that nothing depends on the HTTP response — the database is the record.
 */
export async function startBackgroundScrape({ force = false, reason = 'cron' } = {}) {
  try {
    const products = await trackedRepo.listDue({ ignoreInterval: force });
    if (!products.length) {
      logger.info('cron.run.skipped', { reason: 'nothing due', source: reason });
      return;
    }
    logger.info('cron.run.start', { products: products.length, force, source: reason });
    const summary = await runScrape({ trigger: 'cron', products });
    logger.info('cron.run.end', {
      source: reason,
      skipped: summary.skipped ?? false,
      total: summary.total,
      succeeded: summary.succeeded,
      failed: summary.failed,
    });
  } catch (error) {
    logger.error('cron.run.crashed', { source: reason, error: error.message });
  }
}

/** Cheap endpoint for a keep-warm ping and for the dashboard's health badge. */
export const status = asyncHandler(async (_req, res) => {
  const [runs, logs, alerts] = await Promise.all([
    runsRepo.recent(10),
    logsRepo.recent({ limit: 50 }),
    alertsRepo.recent({ limit: 20 }),
  ]);
  res.json({ runs, recentLogs: logs, alerts });
});
