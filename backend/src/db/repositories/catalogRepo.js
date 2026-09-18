import { db, unwrap } from '../supabase.js';

export async function upsertMany(rows) {
  if (!rows.length) return 0;
  unwrap(await db.from('catalog_products').upsert(rows, { onConflict: 'store_product_id' }), 'upsert catalog');
  return rows.length;
}

export async function count() {
  const { count: n, error } = await db.from('catalog_products').select('*', { count: 'exact', head: true });
  if (error) throw new Error(`count catalog: ${error.message}`);
  return n ?? 0;
}

/**
 * Partial or full name search. Also matches brand and SKU, which is what a user
 * typing "helix" or "HEL-10088" actually expects.
 */
export async function search(query, limit = 25) {
  const q = query.trim().replace(/[%_,()]/g, ' ');
  const rows = unwrap(
    await db
      .from('catalog_products')
      .select('store_product_id, slug, name, brand, category, sku, description')
      .or(`name.ilike.%${q}%,brand.ilike.%${q}%,sku.ilike.%${q}%`)
      .order('name')
      .limit(limit),
    'search catalog',
  );
  return rows ?? [];
}

export async function getByStoreId(storeProductId) {
  const rows = unwrap(
    await db.from('catalog_products').select('*').eq('store_product_id', storeProductId).limit(1),
    'get catalog product',
  );
  return rows?.[0] ?? null;
}
