import { db, unwrap } from '../supabase.js';

const COLUMNS = '*';

export async function list() {
  return unwrap(await db.from('tracked_products').select(COLUMNS).order('created_at', { ascending: false }), 'list tracked') ?? [];
}

/**
 * How much early a product may be scraped and still count as due.
 *
 * Without this, a 2-hourly schedule silently becomes a 4-hourly one. `last_scraped_at`
 * is stamped when the scrape *finishes*, so the 08:00 run compares against 06:00:45
 * — 1 h 59 m 15 s, just under the interval — skips the product, and the next chance
 * is 10:00. The drift compounds every run. A grace window absorbs the run's own
 * duration plus the cron service's jitter and cold-start delay.
 */
const DUE_GRACE_MS = 10 * 60_000;

/** Active products whose configured interval has (near enough) elapsed. */
export async function listDue({ ignoreInterval = false } = {}) {
  const rows = unwrap(
    await db.from('tracked_products').select(COLUMNS).eq('is_active', true).order('created_at'),
    'list due',
  ) ?? [];
  if (ignoreInterval) return rows;
  const now = Date.now();
  return rows.filter((p) => {
    if (!p.last_scraped_at) return true;
    const elapsed = now - new Date(p.last_scraped_at).getTime();
    return elapsed >= p.scrape_interval_minutes * 60_000 - DUE_GRACE_MS;
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
