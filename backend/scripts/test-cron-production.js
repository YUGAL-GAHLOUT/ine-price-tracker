#!/usr/bin/env node
/**
 * Reproduce exactly what a cron service sees when it calls the scrape trigger,
 * so a failure can be diagnosed without waiting for the next scheduled slot.
 *
 * Reports status, timing, content type, body SIZE (the thing cron-job.org
 * aborts on) and whether the body is JSON at all — an HTML body means the
 * platform edge answered and the request never reached Node.
 *
 *   node scripts/test-cron-production.js
 *   node scripts/test-cron-production.js --base https://... --method GET
 *
 * The secret is read from CRON_SECRET (or backend/.env) and never printed.
 */
import 'dotenv/config';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const base = arg('base', process.env.CRON_TEST_BASE_URL ?? 'https://ine-price-tracker-backend-vwt5.onrender.com');
const method = arg('method', 'POST').toUpperCase();
const secret = process.env.CRON_SECRET;

if (!secret) {
  console.error('CRON_SECRET is not set (put it in backend/.env or the environment).');
  process.exit(2);
}

async function probe(label, url, init = {}) {
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    console.log(`\n${label}\n  request failed after ${Date.now() - startedAt} ms: ${error.message}`);
    return null;
  }
  const body = await res.text();
  const durationMs = Date.now() - startedAt;
  const type = res.headers.get('content-type') ?? '(none)';
  const bytes = Buffer.byteLength(body, 'utf8');

  let json = null;
  try { json = JSON.parse(body); } catch { /* not JSON */ }

  console.log(`\n${label}`);
  console.log(`  ${method === 'GET' ? 'GET' : init.method ?? 'GET'} ${url.replace(/\?.*/, (m) => m)}`);
  console.log(`  status        ${res.status} ${res.statusText}`);
  console.log(`  duration      ${durationMs} ms`);
  console.log(`  content-type  ${type}`);
  console.log(`  body size     ${bytes} bytes`);
  console.log(`  valid JSON    ${json ? 'yes' : 'NO — see body below'}`);
  // Render / Cloudflare answer with an HTML page when no instance is routable.
  // That page is what a cron service aborts as "output too large".
  if (!json) console.log(`  edge headers  x-render-routing=${res.headers.get('x-render-routing') ?? '(none)'} server=${res.headers.get('server') ?? '(none)'}`);
  console.log(`  body          ${body.slice(0, 400)}${bytes > 400 ? ` … (+${bytes - 400} bytes)` : ''}`);

  if (bytes > 1024) console.log('  ⚠ over 1 KB — a hosted cron service may abort this as "output too large".');
  if (!type.includes('json')) console.log('  ⚠ not a JSON response — the request probably never reached the app.');
  return { status: res.status, bytes, durationMs, json: Boolean(json) };
}

console.log(`Target: ${base}`);
console.log('Secret: present (not printed)');

await probe('[1] health (what the keep-warm job calls)', `${base}/api/health`);

await probe('[2] scrape trigger, no credential (expect 401, small JSON)', `${base}/api/cron/scrape?async=1`, {
  method,
});

const main = await probe('[3] scrape trigger, exactly as the cron job calls it', `${base}/api/cron/scrape?async=1`, {
  method,
  headers: { authorization: `Bearer ${secret}` },
});

console.log('');
if (!main) process.exit(1);
if (main.json && main.bytes <= 1024 && [200, 202, 409].includes(main.status)) {
  console.log(`PASS — ${main.status}, ${main.bytes} bytes of JSON in ${main.durationMs} ms. A cron service accepts this.`);
  console.log('The run itself is recorded in scrape_runs / scrape_logs; check the dashboard Activity page.');
} else {
  console.log('FAIL — see the warnings above.');
  process.exit(1);
}
