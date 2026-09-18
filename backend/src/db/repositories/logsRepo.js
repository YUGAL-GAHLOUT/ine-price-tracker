import { db, unwrap } from '../supabase.js';

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
    await db.from('scrape_logs').select('*').order('started_at', { ascending: false }).limit(limit),
    'recent scrape logs',
  ) ?? [];
}
