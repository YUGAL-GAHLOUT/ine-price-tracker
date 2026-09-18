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

const { rows, failedIds, expected } = await storeClient.walkCatalog({
  total,
  concurrency: 4,
  onProgress: (done, all, missed) => process.stdout.write(`\r  ${done}/${all}  (retrying ${missed})   `),
});

process.stdout.write('\n');
console.log(`Fetched ${rows.length} of ${expected} products.`);

// The store rate-limits bursts. If ids are still missing after the retry sweeps,
// say so loudly rather than quietly shipping a partial search index.
if (failedIds.length) {
  console.warn(`WARNING: ${failedIds.length} product id(s) could not be fetched: ` +
    `${failedIds.slice(0, 20).join(', ')}${failedIds.length > 20 ? ', …' : ''}`);
  console.warn('Re-run `npm run catalog:sync` to fill the gaps (upserts are idempotent).');
}

console.log('Upserting…');

// Chunked so a single request body stays a sane size.
for (let i = 0; i < rows.length; i += 200) {
  await catalogRepo.upsertMany(rows.slice(i, i + 200));
  process.stdout.write(`\r  upserted ${Math.min(i + 200, rows.length)}/${rows.length}`);
}

process.stdout.write('\n');
const finalCount = await catalogRepo.count();
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s. Catalogue rows: ${finalCount}/${expected}`);
process.exit(failedIds.length ? 1 : 0);
