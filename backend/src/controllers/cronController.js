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
  const products = await trackedRepo.listDue({ ignoreInterval: force });

  if (!products.length) {
    return res.json({ skipped: true, reason: 'no tracked products are due', total: 0, succeeded: 0, failed: 0, results: [] });
  }

  logger.info('cron.run.start', { products: products.length, force, background });

  if (background) {
    // Detached on purpose. Failures inside are logged per product and recorded on
    // the run row, so nothing is swallowed just because no one is awaiting it.
    runScrape({ trigger: 'cron', products })
      .then((summary) => logger.info('cron.run.end', { ...summary, results: undefined }))
      .catch((error) => logger.error('cron.run.crashed', { error: error.message }));

    return res.status(202).json({
      accepted: true,
      mode: 'async',
      products: products.length,
      message: 'Scrape started. Track progress at GET /api/status or in the dashboard Activity page.',
    });
  }

  const summary = await runScrape({ trigger: 'cron', products });
  logger.info('cron.run.end', { ...summary, results: undefined });

  // 409 tells the caller this invocation did nothing because another run held the
  // lock, which is distinguishable from a real failure in its history view.
  res.status(summary.skipped ? 409 : 200).json(summary);
});

/** Cheap endpoint for a keep-warm ping and for the dashboard's health badge. */
export const status = asyncHandler(async (_req, res) => {
  const [runs, logs, alerts] = await Promise.all([
    runsRepo.recent(10),
    logsRepo.recent({ limit: 50 }),
    alertsRepo.recent({ limit: 20 }),
  ]);
  res.json({ runs, recentLogs: logs, alerts });
});
