import { STORE_ORIGIN } from '../config/store.js';
import { retry } from '../scraper/retry.js';

/**
 * Lightweight HTTP access to the store's JSON endpoints.
 *
 * Catalogue metadata (id, name, brand, sku…) IS available over plain HTTP, so we
 * use fetch for it and reserve the headless browser for price/stock, which is the
 * only thing that genuinely needs a browser.
 */
async function getJson(path, { timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${STORE_ORIGIN}${path}`, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      const err = new Error(`GET ${path} -> ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getJsonWithRetry(path, opts) {
  const result = await retry(() => getJson(path, opts), { attempts: 3, baseMs: 500, maxMs: 4_000 });
  if (!result.ok) throw result.error;
  return result.value;
}

/** Total number of products the store reports. */
export async function getCatalogSize() {
  const page = await getJsonWithRetry('/api/catalog?page=1&pageSize=1');
  return Number(page.total) || 0;
}

/**
 * Fetch one product's metadata. Returns null for 404 (a gap in the id range)
 * rather than throwing, so a catalogue walk isn't derailed by a missing id.
 */
export async function getProduct(id) {
  try {
    return await getJsonWithRetry(`/api/product/${id}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/**
 * Walk the whole catalogue by product id.
 *
 * `/api/catalog` returns a *random sample* on every call and caps pageSize at 60,
 * so paging through it never reliably enumerates all 1000 products. Product ids
 * are dense in 1..total, so walking ids is the deterministic way to build a
 * complete search index.
 */
export async function walkCatalog({ total, concurrency = 8, onProgress } = {}) {
  const size = total ?? (await getCatalogSize());
  const ids = Array.from({ length: size }, (_, i) => i + 1);
  const out = [];
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const p = await getProduct(id).catch(() => null);
      if (p) {
        out.push({
          store_product_id: p.id,
          slug: p.slug,
          name: p.name,
          brand: p.brand ?? null,
          category: p.category ?? null,
          sku: p.sku ?? null,
          description: p.description ?? null,
          synced_at: new Date().toISOString(),
        });
      }
      done++;
      if (onProgress && done % 50 === 0) onProgress(done, ids.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  out.sort((a, b) => a.store_product_id - b.store_product_id);
  return out;
}

/**
 * Live fallback search, used only when the cached catalogue is empty.
 * Draws random samples until it has seen enough matches or runs out of budget.
 */
export async function liveSearch(query, { draws = 8, limit = 25 } = {}) {
  const q = query.trim().toLowerCase();
  const seen = new Map();
  for (let i = 0; i < draws && seen.size < limit; i++) {
    const page = await getJson(`/api/catalog?page=${i + 1}&pageSize=60`).catch(() => null);
    for (const item of page?.items ?? []) {
      if (item.name.toLowerCase().includes(q) || (item.brand ?? '').toLowerCase().includes(q)) {
        seen.set(item.id, item);
      }
    }
  }
  return [...seen.values()].slice(0, limit);
}
