import { db, unwrap } from '../supabase.js';

/** Insert one validated observation. Callers must never reach here on failure. */
export async function insert(row) {
  const rows = unwrap(await db.from('price_history').insert(row).select('*'), 'insert price history');
  return rows[0];
}

export async function listForProduct(trackedProductId, { limit = 500, since } = {}) {
  let q = db
    .from('price_history')
    .select('*')
    .eq('tracked_product_id', trackedProductId)
    .order('scraped_at', { ascending: false })
    .limit(limit);
  if (since) q = q.gte('scraped_at', since);
  return unwrap(await q, 'list price history') ?? [];
}

/** The most recent good observation — what the dashboard shows as "current". */
export async function latest(trackedProductId) {
  const rows = unwrap(
    await db
      .from('price_history')
      .select('*')
      .eq('tracked_product_id', trackedProductId)
      .order('scraped_at', { ascending: false })
      .limit(1),
    'latest price',
  );
  return rows?.[0] ?? null;
}
