import { db, unwrap } from '../supabase.js';

/** See logsRepo: a cross-product alert list needs the product it refers to. */
const WITH_PRODUCT = '*, tracked_products ( name, store_product_id )';

function withProduct(row) {
  const { tracked_products: product, ...rest } = row;
  return {
    ...rest,
    product_name: product?.name ?? null,
    store_product_id: product?.store_product_id ?? null,
  };
}

export async function insert(row) {
  const rows = unwrap(await db.from('alerts').insert(row).select('*'), 'insert alert');
  return rows[0];
}

export async function listForProduct(trackedProductId, { limit = 50 } = {}) {
  return unwrap(
    await db.from('alerts').select('*').eq('tracked_product_id', trackedProductId)
      .order('created_at', { ascending: false }).limit(limit),
    'list alerts',
  ) ?? [];
}

export async function recent({ limit = 50 } = {}) {
  return unwrap(
    await db.from('alerts').select(WITH_PRODUCT).order('created_at', { ascending: false }).limit(limit),
    'recent alerts',
  )?.map(withProduct) ?? [];
}

export async function acknowledge(id) {
  const rows = unwrap(await db.from('alerts').update({ acknowledged: true }).eq('id', id).select('*'), 'ack alert');
  return rows?.[0] ?? null;
}
