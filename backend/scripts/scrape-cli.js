#!/usr/bin/env node
/**
 * Run the real scraper from the command line.
 *
 *   npm run scrape:once                  # headless, all due tracked products
 *   npm run scrape:headed                # visible browser, slowed down (for the demo recording)
 *   node scripts/scrape-cli.js --id 88   # scrape one store product id, no DB writes
 *   node scripts/scrape-cli.js --headed --id 88 --repeat 4
 *
 * Flags:
 *   --headed     show the browser window
 *   --slow       add slowMo so each action is watchable
 *   --id <n>     dry-run one store product id (nothing is written to the database)
 *   --repeat <n> repeat the dry run n times, to demonstrate retries and failures
 *   --all        ignore each product's interval and scrape every active product
 */
import { closeBrowser, getBrowser } from '../src/scraper/browser.js';
import { scrapeProductOnce } from '../src/scraper/productScraper.js';
import { retry } from '../src/scraper/retry.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const headed = has('--headed');
const slowMo = has('--slow') ? 250 : 0;
const dryRunId = val('--id', null);
const repeat = Number(val('--repeat', 1)) || 1;

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);

if (dryRunId) {
  // ---- Dry run: no database required, nothing persisted. ------------------
  log(`Dry run: store product ${dryRunId}, ${repeat} pass(es), headed=${headed}`);
  const browser = await getBrowser({ headed, slowMo });
  let ok = 0;

  for (let pass = 1; pass <= repeat; pass++) {
    log(`──── pass ${pass}/${repeat} ────`);
    const result = await retry(
      (attempt) => {
        log(`  attempt ${attempt}: starting`);
        return scrapeProductOnce(browser, { store_product_id: Number(dryRunId) }, {
          timeoutMs: 60_000,
          onStep: (step) => log(`    · ${step}`),
        });
      },
      {
        attempts: 4, baseMs: 1500, maxMs: 15_000,
        onAttempt: ({ attempt, ok: good, error, durationMs }) =>
          log(good
            ? `  attempt ${attempt}: SUCCESS in ${durationMs}ms`
            : `  attempt ${attempt}: FAILED in ${durationMs}ms [${error?.code}] ${error?.message?.slice(0, 120)}`),
      },
    );

    if (result.ok) {
      ok++;
      const o = result.value;
      log(`  RESULT price=₹${o.price} stock=${o.stockQuantity} inStock=${o.inStock} ` +
          `source=${o.priceSource} crossChecked=${o.crossChecked} attempts=${result.attempts}`);
    } else {
      log(`  RESULT failed after ${result.attempts} attempts: [${result.error?.code}] ${result.error?.message}`);
      log('  → nothing would be written to price_history; the failure would be logged.');
    }
  }

  log(`Done. ${ok}/${repeat} passes produced a validated observation.`);
  await closeBrowser();
  process.exit(0);
}

// ---- Real run: writes to Supabase. ---------------------------------------
const { runScrape } = await import('../src/services/scrapeService.js');
const trackedRepo = await import('../src/db/repositories/trackedProductsRepo.js');

const products = await trackedRepo.listDue({ ignoreInterval: has('--all') });
if (!products.length) {
  log('No tracked products are due. Use --all to scrape every active product.');
  await closeBrowser();
  process.exit(0);
}

log(`Scraping ${products.length} product(s), headed=${headed}`);
const summary = await runScrape({
  trigger: 'cli',
  products,
  headed,
  slowMo,
  onStep: ({ attempt, step }) => log(`  attempt ${attempt} · ${step}`),
});

log(JSON.stringify(summary, null, 2));
await closeBrowser();
process.exit(summary.failed > 0 ? 1 : 0);
