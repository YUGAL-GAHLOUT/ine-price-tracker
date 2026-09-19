import { db, unwrap } from '../supabase.js';

/**
 * Embedded columns of the parent product. The Activity page lists logs across
 * every product, so a row is meaningless without the name it belongs to.
 */
const WITH_PRODUCT = '*, tracked_products ( name, store_product_id )';

/** Flatten the embed so callers see plain `product_name` / `store_product_id`. */
function withProduct(row) {
  const { tracked_products: product, ...rest } = row;
  return {
    ...rest,
    product_name: product?.name ?? null,
    store_product_id: product?.store_product_id ?? null,
  };
}

export async function insert(row) {
  const rows = unwrap(await db.from('scrape_logs').insert(row).select('*'), 'insert scrape log');
  return rows[0];
}

export async function listForProduct(trackedProductId, { limit = 100 } = {}) {
  return unwrap(
    await db
      .from('scrape_logs')
      .select('*')
      .eq('tracked_product_id', trackedProductId)
      .order('started_at', { ascending: false })
      .limit(limit),
    'list scrape logs',
  ) ?? [];
}

export async function latest(trackedProductId) {
  const rows = await listForProduct(trackedProductId, { limit: 1 });
  return rows[0] ?? null;
}

export async function recent({ limit = 100 } = {}) {
  return unwrap(
    await db.from('scrape_logs').select(WITH_PRODUCT).order('started_at', { ascending: false }).limit(limit),
    'recent scrape logs',
  )?.map(withProduct) ?? [];
}
