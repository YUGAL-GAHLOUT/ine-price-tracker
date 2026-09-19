import { config } from '../config/env.js';
import { getBrowser } from '../scraper/browser.js';
import { FailureCode, ScrapeError, scrapeProductOnce } from '../scraper/productScraper.js';
import { retry, sleep } from '../scraper/retry.js';
import * as alertsRepo from '../db/repositories/alertsRepo.js';
import * as historyRepo from '../db/repositories/historyRepo.js';
import * as logsRepo from '../db/repositories/logsRepo.js';
import * as runsRepo from '../db/repositories/runsRepo.js';
import * as trackedRepo from '../db/repositories/trackedProductsRepo.js';
import { logger } from '../utils/logger.js';

/** Pause between products in a run, to stay under the store's rate limit. */
const PRODUCT_GAP_MS = 5_000;

/**
 * Scrape one tracked product, with retries, and record the outcome honestly.
 *
 * Guarantees:
 *  - exactly one `scrape_logs` row per call, whatever happens;
 *  - `price_history` is written ONLY after the observation passed validation
 *    and (where available) was cross-checked against the store's own figure;
 *  - a failure never overwrites or corrupts the last known good price.
 */
export async function scrapeOneProduct(browser, product, { runId = null, headed = false, onStep } = {}) {
  const startedAt = new Date();
  const trail = [];

  const result = await retry(
    (attempt) => {
      logger.info('scrape.attempt', { product: product.store_product_id, attempt });
      return scrapeProductOnce(browser, product, {
        timeoutMs: config.scraper.attemptTimeoutMs,
        onStep: (step, meta) => onStep?.({ attempt, step, meta }),
      });
    },
    {
      attempts: config.scraper.maxAttempts,
      baseMs: config.scraper.retryBaseMs,
      maxMs: config.scraper.retryMaxMs,
      onAttempt: ({ attempt, ok, error, durationMs }) => {
        trail.push({
          attempt,
          ok,
          durationMs,
          failureCode: ok ? null : error?.code ?? FailureCode.UNKNOWN,
          error: ok ? null : String(error?.message ?? error).slice(0, 300),
        });
        if (!ok) logger.warn('scrape.attempt.failed', { product: product.store_product_id, attempt, code: error?.code, message: error?.message });
      },
    },
  );

  const completedAt = new Date();
  const durationMs = completedAt - startedAt;
  const attempts = trail.length || 1;

  if (!result.ok) {
    const err = result.error instanceof ScrapeError ? result.error : null;
    await logsRepo.insert({
      tracked_product_id: product.id,
      run_id: runId,
      status: 'failed',
      attempts,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: durationMs,
      failure_code: err?.code ?? FailureCode.UNKNOWN,
      error_message: String(result.error?.message ?? result.error).slice(0, 500),
      scraped_price: null,
      scraped_stock: null,
      attempt_trail: trail,
    });
    await trackedRepo.markScraped(product.id, { success: false });
    logger.error('scrape.failed', { product: product.store_product_id, code: err?.code, attempts });
    return { ok: false, product, failureCode: err?.code ?? FailureCode.UNKNOWN, error: result.error?.message, attempts };
  }

  const obs = result.value;
  const previous = await historyRepo.latest(product.id);

  const history = await historyRepo.insert({
    tracked_product_id: product.id,
    price: obs.price,
    currency: obs.currency,
    in_stock: obs.inStock,
    stock_quantity: obs.stockQuantity,
    mrp: obs.mrp,
    seller: obs.seller,
    price_source: obs.priceSource,
    cross_checked: obs.crossChecked,
    layout_revision: obs.layoutRevision,
    scraped_at: completedAt.toISOString(),
  });

  await logsRepo.insert({
    tracked_product_id: product.id,
    run_id: runId,
    // "retried" = eventually succeeded, but not on the first attempt. The log
    // must show that the earlier attempts happened.
    status: attempts > 1 ? 'retried' : 'success',
    attempts,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: durationMs,
    failure_code: null,
    error_message: null,
    scraped_price: obs.price,
    scraped_stock: obs.stockQuantity,
    attempt_trail: trail,
  });

  await trackedRepo.markScraped(product.id, { success: true });
  await raiseAlerts(product, previous, obs).catch((e) => logger.warn('alerts.failed', { error: e.message }));

  logger.info('scrape.success', { product: product.store_product_id, price: obs.price, stock: obs.stockQuantity, attempts });
  return { ok: true, product, observation: obs, history, attempts };
}

/** Bonus: price-drop / back-in-stock / structure-change notices. */
async function raiseAlerts(product, previous, obs) {
  if (!previous) return;
  const prevPrice = Number(previous.price);

  if (obs.price < prevPrice) {
    const pct = (((prevPrice - obs.price) / prevPrice) * 100).toFixed(1);
    await alertsRepo.insert({
      tracked_product_id: product.id, type: 'price_drop',
      message: `Price dropped ${pct}% (₹${prevPrice} → ₹${obs.price})`,
      previous_value: prevPrice, new_value: obs.price,
    });
  } else if (obs.price > prevPrice) {
    await alertsRepo.insert({
      tracked_product_id: product.id, type: 'price_rise',
      message: `Price rose from ₹${prevPrice} to ₹${obs.price}`,
      previous_value: prevPrice, new_value: obs.price,
    });
  }

  if (!previous.in_stock && obs.inStock) {
    await alertsRepo.insert({
      tracked_product_id: product.id, type: 'back_in_stock',
      message: `Back in stock (${obs.stockQuantity} available)`, new_value: obs.stockQuantity,
    });
  } else if (previous.in_stock && !obs.inStock) {
    await alertsRepo.insert({
      tracked_product_id: product.id, type: 'out_of_stock', message: 'Now out of stock',
    });
  }

  // We only found the price by falling back to structural matching, which means
  // the layout classes we expected were not there. Worth surfacing.
  if (obs.priceSource === 'structural') {
    await alertsRepo.insert({
      tracked_product_id: product.id, type: 'structure_change',
      message: 'Price element was not found via the layout class; used structural fallback.',
    });
  }
}

/**
 * Run a scrape across many products with bounded concurrency.
 *
 * One failing product must never abort the run, so each task is individually
 * guarded — `scrapeOneProduct` already logs its own failure, and anything that
 * escapes it is caught here.
 */
export async function runScrape({ trigger = 'manual', products, headed = false, slowMo = 0, onStep } = {}) {
  await runsRepo.reapStale(config.scraper.runLockStaleMs);

  const { conflict, run } = await runsRepo.start(trigger);
  if (conflict) {
    logger.warn('scrape.run.conflict', { trigger });
    return { skipped: true, reason: 'a scrape run is already in progress', results: [] };
  }

  const browser = await getBrowser({ headed, slowMo });
  const results = [];
  let cursor = 0;
  const limit = Math.max(1, Math.min(config.scraper.concurrency, headed ? 1 : 8));

  async function worker() {
    while (cursor < products.length) {
      const index = cursor++;
      const product = products[index];
      // Space requests out. Scraping several products back to back is exactly what
      // earns a 429 from the store, which then costs far more time than this wait.
      if (index > 0) await sleep(PRODUCT_GAP_MS + Math.floor(Math.random() * 2_000));
      try {
        results.push(await scrapeOneProduct(browser, product, { runId: run.id, headed, onStep }));
      } catch (e) {
        logger.error('scrape.product.crashed', { product: product.store_product_id, error: e.message });
        results.push({ ok: false, product, failureCode: 'orchestrator_error', error: e.message, attempts: 0 });
      }
    }
  }

  let status = 'completed';
  try {
    await Promise.all(Array.from({ length: limit }, worker));
  } catch (e) {
    status = 'failed';
    logger.error('scrape.run.failed', { error: e.message });
  } finally {
    const success = results.filter((r) => r.ok).length;
    await runsRepo.finish(run.id, {
      status,
      productsTotal: products.length,
      productsSuccess: success,
      productsFailed: results.length - success,
    });
  }

  const succeeded = results.filter((r) => r.ok).length;
  return {
    skipped: false,
    runId: run.id,
    trigger,
    total: products.length,
    succeeded,
    failed: results.length - succeeded,
    results: results.map((r) => ({
      storeProductId: r.product.store_product_id,
      name: r.product.name,
      ok: r.ok,
      attempts: r.attempts,
      ...(r.ok ? { price: r.observation.price, stockQuantity: r.observation.stockQuantity, inStock: r.observation.inStock } : { failureCode: r.failureCode, error: r.error }),
    })),
  };
}
