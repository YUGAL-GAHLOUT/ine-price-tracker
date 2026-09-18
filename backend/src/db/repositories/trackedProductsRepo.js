import { db, unwrap } from '../supabase.js';

const COLUMNS = '*';

export async function list() {
  return unwrap(await db.from('tracked_products').select(COLUMNS).order('created_at', { ascending: false }), 'list tracked') ?? [];
}

/** Active products whose configured interval has elapsed since the last attempt. */
export async function listDue({ ignoreInterval = false } = {}) {
  const rows = unwrap(
    await db.from('tracked_products').select(COLUMNS).eq('is_active', true).order('created_at'),
    'list due',
  ) ?? [];
  if (ignoreInterval) return rows;
  const now = Date.now();
  return rows.filter((p) => {
    if (!p.last_scraped_at) return true;
    return now - new Date(p.last_scraped_at).getTime() >= p.scrape_interval_minutes * 60_000;
  });
}

export async function getById(id) {
  const rows = unwrap(await db.from('tracked_products').select(COLUMNS).eq('id', id).limit(1), 'get tracked');
  return rows?.[0] ?? null;
}

export async function getByStoreId(storeProductId) {
  const rows = unwrap(
    await db.from('tracked_products').select(COLUMNS).eq('store_product_id', storeProductId).limit(1),
    'get tracked by store id',
  );
  return rows?.[0] ?? null;
}

export async function create(row) {
  const rows = unwrap(await db.from('tracked_products').insert(row).select(COLUMNS), 'create tracked');
  return rows[0];
}

export async function update(id, patch) {
  const rows = unwrap(await db.from('tracked_products').update(patch).eq('id', id).select(COLUMNS), 'update tracked');
  return rows?.[0] ?? null;
}

export async function remove(id) {
  unwrap(await db.from('tracked_products').delete().eq('id', id), 'delete tracked');
}

/** Record that an attempt happened, whether or not it produced data. */
export async function markScraped(id, { success }) {
  const patch = { last_scraped_at: new Date().toISOString() };
  if (success) patch.last_success_at = patch.last_scraped_at;
  await db.from('tracked_products').update(patch).eq('id', id);
}
