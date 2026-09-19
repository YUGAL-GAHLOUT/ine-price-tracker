import { config } from './config/env.js';
import { createApp } from './app.js';
import { closeBrowser } from './scraper/browser.js';
import { releaseActiveRun } from './services/scrapeService.js';
import { logger } from './utils/logger.js';

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info('server.started', { port: config.port, env: config.nodeEnv });
});

async function shutdown(signal) {
  logger.info('server.shutdown', { signal });
  server.close();
  // Hand back the run lock before we go. Otherwise a deploy or a free-tier
  // restart that lands mid-scrape blocks every subsequent scrape until the
  // stale-run reaper catches up 20 minutes later.
  await releaseActiveRun(`Interrupted: process received ${signal} mid-run`).catch(() => {});
  await closeBrowser();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A crash inside a detached scrape must not take the API down silently.
process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', { reason: String(reason) }));
process.on('uncaughtException', (err) => logger.error('uncaughtException', { message: err.message, stack: err.stack }));
