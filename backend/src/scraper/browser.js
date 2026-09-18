import { chromium } from 'playwright';

/**
 * A single shared Chromium instance.
 *
 * Launching a browser costs a second or two and a lot of memory, which matters on
 * Render's free tier. Every scrape gets its own *context* (clean cookies/storage,
 * so the consent modal and any per-session state start fresh) but shares the process.
 */
let browserPromise = null;
let launchedHeaded = null;

export async function getBrowser({ headed = false, slowMo = 0 } = {}) {
  // Headed and headless cannot share one instance; relaunch if the mode changes.
  if (browserPromise && launchedHeaded !== headed) await closeBrowser();
  if (!browserPromise) {
    launchedHeaded = headed;
    browserPromise = chromium.launch({ headless: !headed, slowMo });
  }
  return browserPromise;
}

export async function closeBrowser() {
  const p = browserPromise;
  browserPromise = null;
  launchedHeaded = null;
  if (p) {
    try { (await p).close(); } catch { /* already gone */ }
  }
}

/** Create an isolated context + page for one scrape attempt. */
export async function newScrapePage(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });

  // Capture the quote object the page decrypts in memory. This is only ever used
  // to CROSS-CHECK what we read from the DOM — never as the sole source — so that
  // a change to the store's internals degrades us to DOM-only rather than silently
  // producing nothing.
  await context.addInitScript(() => {
    window.__ineQuotes = [];
    const decode = TextDecoder.prototype.decode;
    TextDecoder.prototype.decode = function (...args) {
      const out = decode.apply(this, args);
      try {
        if (typeof out === 'string' && out.length < 2000 && out.startsWith('{') && out.includes('"p"')) {
          const q = JSON.parse(out);
          if (typeof q.p === 'number' && typeof q.s === 'number') window.__ineQuotes.push(q);
        }
      } catch { /* not a quote payload */ }
      return out;
    };
  });

  const page = await context.newPage();
  return { context, page };
}
