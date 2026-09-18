import { db, unwrap } from '../supabase.js';

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
    await db.from('alerts').select('*').order('created_at', { ascending: false }).limit(limit),
    'recent alerts',
  ) ?? [];
}

export async function acknowledge(id) {
  const rows = unwrap(await db.from('alerts').update({ acknowledged: true }).eq('id', id).select('*'), 'ack alert');
  return rows?.[0] ?? null;
}
