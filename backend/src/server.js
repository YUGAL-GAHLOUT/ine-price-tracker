import { config } from './config/env.js';
import { createApp } from './app.js';
import { closeBrowser } from './scraper/browser.js';
import { releaseActiveRun } from './services/scrapeService.js';
import { startBackgroundScrape } from './controllers/cronController.js';
import { logger } from './utils/logger.js';

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info('server.started', { port: config.port, env: config.nodeEnv });
  scheduleCatchUp();
});

/**
 * Catch up on anything overdue, shortly after this process comes up.
 *
 * This is the part that makes the schedule survive its own trigger failing.
 * On the free tier the instance is usually asleep when the 2-hourly trigger
 * arrives, so the request has to wake it; if that wake runs past the caller's
 * request timeout, or the edge answers before the instance is routable, the
 * caller records a failure and — after enough of them — disables the job. But
 * the wake still happened: this process is running precisely because a request
 * arrived. So we do the work anyway instead of letting it depend on whether the
 * HTTP response got back in time.
 *
 * It is not a timer standing in for cron (an in-process timer dies with the
 * instance). It only runs once per process start, and only for products whose
 * own interval has actually elapsed — so a deploy or a restart minutes after a
 * successful run finds nothing due and does nothing. The run lock keeps it from
 * overlapping the request-triggered run that woke us.
 */
function scheduleCatchUp() {
  if (process.env.DISABLE_BOOT_CATCHUP === '1') return;
  // Let the request that woke us take the lock first, so the common case is one
  // run started by the trigger rather than two racing for it.
  setTimeout(() => {
    startBackgroundScrape({ reason: 'boot-catchup' });
  }, 20_000).unref();
}

async function shutdown(signal) {
  logger.info('server.shutdown', { signal });
  // Hand back the run lock FIRST, before closing anything. A deploy or a
  // free-tier restart that lands mid-scrape otherwise leaves a `running` row
  // that blocks every subsequent scrape until the reaper catches up, and the
  // platform gives no promise about how long this handler gets — so the one
  // write that matters goes first and does not queue behind a browser teardown.
  //
  // It is still best-effort: a SIGKILL skips this entirely. The reaper, not this
  // handler, is what guarantees the lock is eventually freed.
  await releaseActiveRun(`Interrupted: process received ${signal} mid-run`).catch(() => {});
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A crash inside a detached scrape must not take the API down silently.
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', { reason: String(reason) }));
process.on('uncaughtException', (err) => logger.error('uncaughtException', { message: err.message, stack: err.stack }));
