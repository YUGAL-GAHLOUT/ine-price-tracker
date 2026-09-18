import { STORE_ORIGIN } from '../config/store.js';
import * as catalogRepo from '../db/repositories/catalogRepo.js';
import * as trackedRepo from '../db/repositories/trackedProductsRepo.js';
import * as historyRepo from '../db/repositories/historyRepo.js';
import * as logsRepo from '../db/repositories/logsRepo.js';
import { HttpError } from '../middleware/errorHandler.js';
import * as storeClient from './storeClient.js';

/**
 * Search the store's catalogue by partial or full name.
 *
 * Served from the cached mirror; falls back to querying the store directly if the
 * mirror has not been synced yet, so a fresh deployment still works.
 */
export async function searchProducts(query, limit) {
  const cached = await catalogRepo.count();
  if (cached > 0) {
    const rows = await catalogRepo.search(query, limit);
    return { source: 'cache', catalogSize: cached, items: rows };
  }
  const items = await storeClient.liveSearch(query, { limit });
  return {
    source: 'live',
    catalogSize: null,
    items: items.map((i) => ({
      store_product_id: i.id, slug: i.slug, name: i.name,
      brand: i.brand, category: i.category, sku: i.sku, description: i.description,
    })),
  };
}

/** Start tracking a store product. Idempotent: re-adding reactivates it. */
export async function trackProduct(storeProductId, { scrapeIntervalMinutes } = {}) {
  const existing = await trackedRepo.getByStoreId(storeProductId);
  if (existing) {
    if (existing.is_active && !scrapeIntervalMinutes) return { created: false, product: existing };
    const patch = { is_active: true };
    if (scrapeIntervalMinutes) patch.scrape_interval_minutes = scrapeIntervalMinutes;
    return { created: false, product: await trackedRepo.update(existing.id, patch) };
  }

  // Resolve against the store (or its mirror) so we never persist a product the
  // store does not actually have.
  const cached = await catalogRepo.getByStoreId(storeProductId);
  const meta = cached ?? (await storeClient.getProduct(storeProductId));
  if (!meta) throw new HttpError(404, `Product ${storeProductId} does not exist in the store catalogue`);

  const product = await trackedRepo.create({
    store_product_id: cached ? cached.store_product_id : meta.id,
    slug: meta.slug,
    name: meta.name,
    brand: meta.brand ?? null,
    category: meta.category ?? null,
    sku: meta.sku ?? null,
    url: `${STORE_ORIGIN}/product/${cached ? cached.store_product_id : meta.id}`,
    ...(scrapeIntervalMinutes ? { scrape_interval_minutes: scrapeIntervalMinutes } : {}),
  });
  return { created: true, product };
}

export async function getTrackedOrThrow(id) {
  const product = await trackedRepo.getById(id);
  if (!product) throw new HttpError(404, `Tracked product ${id} not found`);
  return product;
}

/** Everything the dashboard needs for one product, in a single round trip. */
export async function summarise(product) {
  const [latestPrice, latestLog] = await Promise.all([
    historyRepo.latest(product.id),
    logsRepo.latest(product.id),
  ]);
  return {
    ...product,
    latest: latestPrice
      ? {
          price: Number(latestPrice.price),
          currency: latestPrice.currency,
          inStock: latestPrice.in_stock,
          stockQuantity: latestPrice.stock_quantity,
          mrp: latestPrice.mrp === null ? null : Number(latestPrice.mrp),
          seller: latestPrice.seller,
          crossChecked: latestPrice.cross_checked,
          scrapedAt: latestPrice.scraped_at,
        }
      : null,
    latestScrape: latestLog
      ? {
          status: latestLog.status,
          attempts: latestLog.attempts,
          failureCode: latestLog.failure_code,
          errorMessage: latestLog.error_message,
          startedAt: latestLog.started_at,
          durationMs: latestLog.duration_ms,
        }
      : null,
  };
}

export async function listDashboard() {
  const products = await trackedRepo.list();
  return Promise.all(products.map(summarise));
}
