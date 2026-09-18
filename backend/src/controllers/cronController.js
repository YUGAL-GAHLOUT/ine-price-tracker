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
 */
export const runScheduledScrape = asyncHandler(async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const products = await trackedRepo.listDue({ ignoreInterval: force });

  if (!products.length) {
    return res.json({ skipped: true, reason: 'no tracked products are due', total: 0, succeeded: 0, failed: 0, results: [] });
  }

  logger.info('cron.run.start', { products: products.length, force });
  const summary = await runScrape({ trigger: 'cron', products });
  logger.info('cron.run.end', { ...summary, results: undefined });

  // 409 tells cron-job.org this invocation did nothing because another run held
  // the lock, which is distinguishable from a real failure in its history view.
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
