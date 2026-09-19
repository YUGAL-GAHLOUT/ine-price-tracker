import { STORE_ORIGIN } from '../config/store.js';
import { newScrapePage } from './browser.js';
import { parsePrice, parseStock } from './normalize.js';
import { PermanentError, TimeoutError, withTimeout } from './retry.js';

/**
 * Failure reasons. These are stored verbatim in `scrape_logs.failure_code` so the
 * dashboard can say *why* a scrape failed rather than just "error".
 */
export const FailureCode = {
  NAVIGATION_FAILED: 'navigation_failed',
  PRICE_BLOCK_MISSING: 'price_block_missing',
  RATE_LIMITED: 'rate_limited',
  REVEAL_GATE_FAILED: 'reveal_gate_failed',
  REVEAL_CLICK_FAILED: 'reveal_click_failed',
  REVEAL_TIMEOUT: 'reveal_timeout',
  STORE_ERROR: 'store_error',
  PRICE_PENDING: 'price_pending',
  PRICE_NOT_FOUND: 'price_not_found',
  PRICE_UNPARSEABLE: 'price_unparseable',
  STOCK_NOT_FOUND: 'stock_not_found',
  STOCK_UNPARSEABLE: 'stock_unparseable',
  QUOTE_MISMATCH: 'quote_mismatch',
  ATTEMPT_TIMEOUT: 'attempt_timeout',
  UNKNOWN: 'unknown',
};

export class ScrapeError extends Error {
  constructor(code, message, { permanent = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'ScrapeError';
    this.code = code;
    this.permanent = permanent;
    // When set, retry() waits at least this long instead of its own backoff.
    this.retryAfterMs = retryAfterMs;
  }
}

/** How long to wait out a rate limit before trying the product again. */
const RATE_LIMIT_BACKOFF_MS = 30_000;

/**
 * The store rate-limits bursts, and says so in the page rather than in a status
 * code we can see from here: the product page renders "Couldn't load this
 * product: Error: product 429", and the price block renders "upstream 429".
 *
 * Retrying straight away just deepens the limit, so these are detected and given
 * a long, explicit backoff.
 */
function rateLimitedIf(text, context) {
  if (!/\b429\b|too many requests/i.test(text ?? '')) return null;
  return new ScrapeError(
    FailureCode.RATE_LIMITED,
    `Store rate-limited us during ${context}: ${text.replace(/\s+/g, ' ').trim().slice(0, 160)}`,
    { retryAfterMs: RATE_LIMIT_BACKOFF_MS },
  );
}

/** Refuse to point the browser at anything other than the assigned mock store. */
export function productUrl(storeProductId) {
  const id = Number(storeProductId);
  if (!Number.isInteger(id) || id < 1) throw new PermanentError(`Invalid store product id: ${storeProductId}`);
  return `${STORE_ORIGIN}/product/${id}`;
}

/**
 * Drive the behavioural gate in front of the "Reveal price" button.
 *
 * The store only counts a mousemove if it is >=40ms after the previous one, and
 * requires both a minimum number of moves and a minimum dwell time. We move in a
 * slow arc across the price block rather than teleporting to its centre.
 */
async function passHoverGate(page, block) {
  const button = page.getByRole('button', { name: /reveal price/i });
  const deadline = Date.now() + 25_000;
  let box = await block.boundingBox();
  if (!box) throw new ScrapeError(FailureCode.PRICE_BLOCK_MISSING, 'Price block has no layout box');

  for (let i = 0; Date.now() < deadline; i++) {
    // The consent overlay can mount late and swallow pointer events; if it turns
    // up mid-gate, dismiss it and re-measure rather than moving over a dead area.
    if (i > 0 && i % 20 === 0) {
      if (await page.locator('.cookie-overlay').isVisible().catch(() => false)) {
        await dismissConsent(page);
        box = (await block.boundingBox()) ?? box;
      }
    }

    const t = (i % 30) / 29;
    await page.mouse.move(
      box.x + 24 + t * Math.max(1, box.width - 48),
      box.y + box.height / 2 + Math.sin(t * Math.PI * 2) * Math.min(14, box.height / 4),
    );
    await page.waitForTimeout(60); // > the store's 40ms throttle between counted moves
    if (i >= 12 && !(await button.isDisabled().catch(() => true))) return;
  }
  throw new ScrapeError(FailureCode.REVEAL_GATE_FAILED, 'Reveal button never became enabled');
}

/** Dismiss the cookie consent overlay, which the SPA mounts after hydration. */
async function dismissConsent(page) {
  try {
    const overlay = page.locator('.cookie-overlay');
    // Mounted right after hydration, so a short wait is enough. Waiting longer
    // just burns budget on every scrape where no overlay appears at all.
    await overlay.waitFor({ state: 'visible', timeout: 3_000 });
    await page.getByRole('button', { name: /decline/i }).first().click({ timeout: 5_000 });
    await overlay.waitFor({ state: 'detached', timeout: 8_000 });
  } catch {
    // No overlay this time; nothing to dismiss.
  }
}

/**
 * Read price and stock out of the rendered price block.
 *
 * Deliberately does NOT use `.price-value` or `[data-price]` — those are hidden
 * decoy elements carrying wrong numbers. The real price element is found by the
 * rotating class from `/api/layout`, with a structural fallback.
 */
async function extractFromDom(page) {
  // The store rate-limits bursts (429 + Retry-After). Losing the layout here would
  // push us onto the structural fallback and raise a false "structure change"
  // alert, so give it a couple of tries before giving up.
  const layout = await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch('/api/layout');
        if (res.ok) return await res.json();
        if (res.status === 429) {
          const wait = (Number(res.headers.get('retry-after')) || 1) * 1000;
          await new Promise((r) => setTimeout(r, wait + 200));
          continue;
        }
        return null;
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    return null;
  });

  return page.evaluate((classes) => {
    const main = document.querySelector('.price-main');
    if (!main) return { error: 'no_price_main' };

    const visible = [...main.children].filter(
      (el) => el.offsetParent !== null && el.getAttribute('aria-hidden') !== 'true',
    );

    // Primary: the class the store's own layout endpoint says carries the price.
    let priceEl = classes?.priceValue ? main.querySelector(`.${CSS.escape(classes.priceValue)}`) : null;
    let priceSource = 'layout_class';

    // Fallback: the price is the only element rendered at 2.4rem/700. Used if the
    // layout rotated between render and our fetch.
    if (!priceEl || priceEl.offsetParent === null) {
      priceEl = visible.find((el) => el.style.fontSize === '2.4rem' && el.style.fontWeight === '700') ?? null;
      priceSource = 'structural';
    }

    const badge = document.querySelector('.stock-badge');
    const wrap = document.querySelector('.price-block');

    return {
      priceText: priceEl ? priceEl.textContent : null,
      priceSource,
      // `Updating…` marks a non-final figure that must not be recorded.
      pending: !!(wrap && /Updating…/.test(wrap.textContent ?? '')),
      stockBadge: badge ? { className: badge.className, text: badge.textContent } : null,
      mrpText: classes?.mrp ? main.querySelector(`.${CSS.escape(classes.mrp)}`)?.textContent ?? null : null,
      quotes: window.__ineQuotes ?? [],
    };
  }, layout?.classes ?? null).then((dom) => ({ ...dom, layout }));
}

/**
 * One full scrape attempt against one product. Throws a ScrapeError on any problem;
 * returns a validated observation on success.
 */
export async function scrapeProductOnce(browser, product, { timeoutMs = 60_000, onStep = () => {} } = {}) {
  const url = productUrl(product.store_product_id);
  const { context, page } = await newScrapePage(browser);

  try {
    return await withTimeout((async () => {
      onStep('navigate', { url });
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(30_000, timeoutMs) });
      } catch (e) {
        throw new ScrapeError(FailureCode.NAVIGATION_FAILED, `Navigation failed: ${e.message}`);
      }

      onStep('consent');
      await dismissConsent(page);

      const block = page.locator('.price-block').first();
      try {
        await block.waitFor({ state: 'visible', timeout: 20_000 });
      } catch (e) {
        // Say WHAT the page showed instead. Without this the log just claims the
        // price block was missing, which hides the real cause (the product fetch
        // failing, a rate limit, or the SPA rendering an error state).
        const visible = (await page.locator('body').innerText().catch(() => '')) || '';
        throw (
          rateLimitedIf(visible, 'page load') ??
          new ScrapeError(
            FailureCode.PRICE_BLOCK_MISSING,
            `Price block never rendered (${e.message.split('\n')[0]}). Page showed: ` +
              `${visible.replace(/\s+/g, ' ').trim().slice(0, 160) || '<empty>'}`,
          )
        );
      }

      onStep('hover-gate');
      await passHoverGate(page, block);

      onStep('reveal');
      try {
        await page.getByRole('button', { name: /reveal price/i }).click({ timeout: 10_000 });
      } catch (e) {
        // Usually the consent overlay reappearing and intercepting the click.
        throw new ScrapeError(FailureCode.REVEAL_CLICK_FAILED, `Could not click Reveal price: ${e.message.split('\n')[0]}`);
      }

      // The store injects faults here: ~35% of loads either stall for 900ms or
      // never resolve at all. Poll for a terminal state instead of trusting it.
      onStep('await-quote');
      // The store's fault injector either delays the callback or drops it entirely.
      // Those two need opposite handling, so we tell them apart: while the block
      // reports "Retrying (attempt n/6)" the store is making progress and we extend
      // the deadline; if it just sits on "loading" the callback is gone and no
      // amount of waiting helps, so we fail fast and let the outer retry reload.
      const HARD_DEADLINE = Date.now() + 45_000;
      let quietDeadline = Date.now() + 18_000;
      let phase = null;
      let storeAttempts = 0;

      while (Date.now() < quietDeadline && Date.now() < HARD_DEADLINE) {
        const cls = (await block.getAttribute('class')) ?? '';
        if (cls.includes('price-success')) { phase = 'success'; break; }
        if (cls.includes('price-error')) { phase = 'error'; break; }

        const text = (await block.innerText().catch(() => '')) || '';
        const m = /Retrying \(attempt (\d+)/.exec(text);
        if (m && Number(m[1]) > storeAttempts) {
          storeAttempts = Number(m[1]);
          onStep('store-retry', { storeAttempt: storeAttempts });
          quietDeadline = Date.now() + 18_000; // it is alive; give it another window
        }
        await page.waitForTimeout(250);
      }

      if (phase === 'error') {
        const msg = (await block.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
        throw rateLimitedIf(msg, 'price reveal') ??
          new ScrapeError(FailureCode.STORE_ERROR, `Store reported a price error: ${msg}`);
      }
      if (phase !== 'success') {
        throw new ScrapeError(FailureCode.REVEAL_TIMEOUT, 'Price never resolved to success or error');
      }

      onStep('extract');
      const dom = await extractFromDom(page);
      if (dom.error) throw new ScrapeError(FailureCode.PRICE_NOT_FOUND, `DOM shape unexpected: ${dom.error}`);
      if (dom.pending) throw new ScrapeError(FailureCode.PRICE_PENDING, 'Store marked the price as still updating');
      if (dom.priceText == null) throw new ScrapeError(FailureCode.PRICE_NOT_FOUND, 'No price element found');

      const price = parsePrice(dom.priceText);
      if (price == null) {
        throw new ScrapeError(
          FailureCode.PRICE_UNPARSEABLE,
          `Could not parse price text: ${JSON.stringify(dom.priceText).slice(0, 120)}`,
        );
      }

      if (!dom.stockBadge) throw new ScrapeError(FailureCode.STOCK_NOT_FOUND, 'No stock badge found');
      const stock = parseStock(dom.stockBadge);
      if (!stock) {
        throw new ScrapeError(
          FailureCode.STOCK_UNPARSEABLE,
          `Could not parse stock badge: ${JSON.stringify(dom.stockBadge).slice(0, 120)}`,
        );
      }

      // Cross-check against the figure the page itself decrypted. If the DOM and
      // the underlying quote disagree we have read the wrong element, so we fail
      // rather than record a wrong price.
      const quote = dom.quotes.at(-1) ?? null;
      let verified = false;
      if (quote) {
        if (Math.round(quote.p) !== Math.round(price) || quote.s !== stock.quantity) {
          throw new ScrapeError(
            FailureCode.QUOTE_MISMATCH,
            `DOM price/stock (${price}/${stock.quantity}) disagrees with quote (${quote.p}/${quote.s})`,
          );
        }
        verified = true;
      }

      return {
        price,
        currency: quote?.c ?? 'INR',
        inStock: stock.inStock,
        stockQuantity: stock.quantity,
        mrp: dom.mrpText ? parsePrice(dom.mrpText) : null,
        seller: quote?.sl ?? null,
        rating: quote?.r ?? null,
        priceSource: dom.priceSource,
        crossChecked: verified,
        layoutRevision: dom.layout?.revision ?? null,
        layoutVariant: dom.layout?.variant ?? null,
        priceFormat: quote?.f ?? null,
      };
    })(), timeoutMs, 'scrape attempt');
  } catch (e) {
    if (e instanceof ScrapeError) throw e;
    if (e instanceof TimeoutError) throw new ScrapeError(FailureCode.ATTEMPT_TIMEOUT, e.message);
    if (e instanceof PermanentError) throw new ScrapeError(FailureCode.UNKNOWN, e.message, { permanent: true });
    throw new ScrapeError(FailureCode.UNKNOWN, e?.message ?? String(e));
  } finally {
    await context.close().catch(() => {});
  }
}
