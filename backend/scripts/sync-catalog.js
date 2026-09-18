#!/usr/bin/env node
/**
 * Mirror the store's catalogue into Supabase so search is fast and reliable.
 *
 * The store's /api/catalog returns a random sample per call and caps pageSize at
 * 60, so it cannot be paged through. We walk product ids instead (see
 * storeClient.walkCatalog). Re-running is safe — rows are upserted.
 *
 *   npm run catalog:sync
 */
import * as catalogRepo from '../src/db/repositories/catalogRepo.js';
import * as storeClient from '../src/services/storeClient.js';

const t0 = Date.now();
console.log('Fetching catalogue size…');
const total = await storeClient.getCatalogSize();
console.log(`Store reports ${total} products. Walking ids 1..${total}…`);

const rows = await storeClient.walkCatalog({
  total,
  concurrency: 8,
  onProgress: (done, all) => process.stdout.write(`\r  ${done}/${all}`),
});

process.stdout.write('\n');
console.log(`Fetched ${rows.length} products. Upserting…`);

// Chunked so a single request body stays a sane size.
for (let i = 0; i < rows.length; i += 200) {
  await catalogRepo.upsertMany(rows.slice(i, i + 200));
  process.stdout.write(`\r  upserted ${Math.min(i + 200, rows.length)}/${rows.length}`);
}

process.stdout.write('\n');
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s. Catalogue rows: ${await catalogRepo.count()}`);
process.exit(0);
