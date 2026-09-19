import { Router } from 'express';
import * as products from '../controllers/productsController.js';
import * as tracked from '../controllers/trackedProductsController.js';
import * as cron from '../controllers/cronController.js';
import { allowManualScrape, requireScrapeSecret } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const router = Router();

router.get('/health', (_req, res) => res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) }));

// --- Store catalogue search (public, rate limited) -------------------------
router.get(
  '/products/search',
  rateLimit({ windowMs: 60_000, max: 60 }),
  validate(products.searchQuerySchema, 'query'),
  products.search,
);

// --- Tracked products -----------------------------------------------------
router.get('/tracked-products', tracked.list);
router.post('/tracked-products', validate(tracked.createSchema), tracked.create);
router.get('/tracked-products/:id', validate(tracked.idSchema, 'params'), tracked.getOne);
router.patch('/tracked-products/:id', validate(tracked.idSchema, 'params'), validate(tracked.updateSchema), tracked.update);
router.delete('/tracked-products/:id', validate(tracked.idSchema, 'params'), tracked.remove);
router.get('/tracked-products/:id/history', validate(tracked.idSchema, 'params'), tracked.history);
router.get('/tracked-products/:id/logs', validate(tracked.idSchema, 'params'), tracked.logs);
router.get('/tracked-products/:id/alerts', validate(tracked.idSchema, 'params'), tracked.alerts);

// Manual re-scrape of one ALREADY-TRACKED product. Accepts the full cron secret
// or the low-privilege MANUAL_SCRAPE_TOKEN the dashboard holds. See auth.js.
router.post(
  '/tracked-products/:id/scrape',
  allowManualScrape,
  validate(tracked.idSchema, 'params'),
  tracked.scrapeNow,
);

// --- Scheduled scrape (external cron) -------------------------------------
router.post('/cron/scrape', requireScrapeSecret, cron.runScheduledScrape);
// cron-job.org can be configured for GET; both map to the same handler.
router.get('/cron/scrape', requireScrapeSecret, cron.runScheduledScrape);

router.get('/status', cron.status);
