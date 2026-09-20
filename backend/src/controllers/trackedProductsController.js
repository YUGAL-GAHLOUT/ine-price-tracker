import { z } from 'zod';
import * as historyRepo from '../db/repositories/historyRepo.js';
import * as logsRepo from '../db/repositories/logsRepo.js';
import * as alertsRepo from '../db/repositories/alertsRepo.js';
import * as trackedRepo from '../db/repositories/trackedProductsRepo.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { runScrape } from '../services/scrapeService.js';
import * as trackingService from '../services/trackingService.js';

export const createSchema = z.object({
  storeProductId: z.coerce.number().int().min(1).max(1_000_000),
  scrapeIntervalMinutes: z.coerce.number().int().min(15).max(10_080).optional(),
});

export const updateSchema = z.object({
  isActive: z.boolean().optional(),
  scrapeIntervalMinutes: z.coerce.number().int().min(15).max(10_080).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const idSchema = z.object({ id: z.string().uuid('id must be a UUID') });

export const list = asyncHandler(async (_req, res) => {
  res.json({ items: await trackingService.listDashboard() });
});

export const create = asyncHandler(async (req, res) => {
  const { storeProductId, scrapeIntervalMinutes } = req.body;
  const { created, product } = await trackingService.trackProduct(storeProductId, { scrapeIntervalMinutes });
  res.status(created ? 201 : 200).json({ created, product: await trackingService.summarise(product) });
});

export const getOne = asyncHandler(async (req, res) => {
  const product = await trackingService.getTrackedOrThrow(req.params.id);
  res.json({ product: await trackingService.summarise(product) });
});

export const update = asyncHandler(async (req, res) => {
  const product = await trackingService.getTrackedOrThrow(req.params.id);
  const patch = {};
  if (req.body.isActive !== undefined) patch.is_active = req.body.isActive;
  if (req.body.scrapeIntervalMinutes !== undefined) patch.scrape_interval_minutes = req.body.scrapeIntervalMinutes;
  res.json({ product: await trackedRepo.update(product.id, patch) });
});

export const remove = asyncHandler(async (req, res) => {
  const product = await trackingService.getTrackedOrThrow(req.params.id);
  await trackedRepo.remove(product.id);
  res.status(204).end();
});

export const history = asyncHandler(async (req, res) => {
  const product = await trackingService.getTrackedOrThrow(req.params.id);
  const limit = Math.min(Number(req.query.limit) || 500, 2000);
  const rows = await historyRepo.listForProduct(product.id, { limit });
  res.json({
    productId: product.id,
    // Ascending is what a chart wants; the API returns it chart-ready.
    items: rows.reverse().map((r) => ({
      scrapedAt: r.scraped_at,
      price: Number(r.price),
      currency: r.currency,
      inStock: r.in_stock,
      stockQuantity: r.stock_quantity,
      mrp: r.mrp === null ? null : Number(r.mrp),
      seller: r.seller,
      crossChecked: r.cross_checked,
    })),
  });
});

export const logs = asyncHandler(async (req, res) => {
  const product = await trackingService.getTrackedOrThrow(req.params.id);
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await logsRepo.listForProduct(product.id, { limit });
  res.json({
    productId: product.id,
    items: rows.map((r) => ({
      id: r.id, status: r.status, attempts: r.attempts,
      startedAt: r.started_at, completedAt: r.completed_at, durationMs: r.duration_ms,
      failureCode: r.failure_code, errorMessage: r.error_message,
      scrapedPrice: r.scraped_price === null ? null : Number(r.scraped_price),
      scrapedStock: r.scraped_stock,
      attemptTrail: r.attempt_trail,
    })),
  });
});

export const alerts = asyncHandler(async (req, res) => {
  const product = await trackingService.getTrackedOrThrow(req.params.id);
  res.json({ items: await alertsRepo.listForProduct(product.id) });
});

/**
 * Manual scrape of a single product, triggered from the dashboard.
 *
 * This holds an HTTP request open while a browser works, so it runs on a reduced
 * retry budget: 3 attempts of at most 45 s bounds the response at roughly 2.5
 * minutes even in the worst case, instead of the ~6 minutes the scheduled budget
 * allows. The scheduled run — where nobody is waiting — keeps the full budget.
 */
const INTERACTIVE_BUDGET = { maxAttempts: 3, attemptTimeoutMs: 45_000 };

export const scrapeNow = asyncHandler(async (req, res) => {
  const product = await trackingService.getTrackedOrThrow(req.params.id);
  const summary = await runScrape({ trigger: 'manual', source: 'dashboard', products: [product], budget: INTERACTIVE_BUDGET });
  res.status(summary.skipped ? 409 : 200).json(summary);
});
