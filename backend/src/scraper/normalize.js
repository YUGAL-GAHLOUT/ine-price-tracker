/**
 * Pure parsing / validation helpers for the values we pull out of the store DOM.
 *
 * These are deliberately free of Playwright so they can be unit-tested against the
 * exact strings the store produces. The store rotates through several price formats
 * (see docs/store-analysis.md), so text extraction is the riskiest part of the
 * scraper and gets the most direct test coverage.
 */

/** Characters the store injects purely to break naive text parsing. */
const INVISIBLE = /[​‌‍﻿ \s]/g;

/** Currency / marketing noise that can surround the number. */
const NOISE = /(?:₹|Rs\.?|INR|\/-|\(incl\.?\s*of\s*all\s*taxes\)|[A-Za-z()·—–-])/gi;

/** Widest price we will believe from this store, in rupees. */
export const PRICE_MIN = 1;
export const PRICE_MAX = 10_000_000;

/** Full-width digits (U+FF10–U+FF19) -> ASCII. */
function foldFullWidthDigits(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30));
}

/**
 * Turn a rendered price string into a number.
 *
 * Handles every format the store emits: `₹25,739`, `₹25 739` (spaced),
 * `₹25.739,00` (euro), `₹25,739/- (incl. of all taxes)` (trailing),
 * full-width digits (unicode), NBSP/zero-width separated (nbsp + split carrier)
 * and `Rs. 25,739.00` (lakh).
 *
 * @returns {number|null} the price, or null if the text cannot be trusted.
 */
export function parsePrice(raw) {
  if (typeof raw !== 'string') return null;

  let s = foldFullWidthDigits(raw).replace(INVISIBLE, '').replace(NOISE, '');
  if (!/\d/.test(s)) return null;

  // Anything left that is not a digit or a separator means we did not understand
  // the string; guessing here is how scrapers silently record wrong numbers.
  if (/[^\d.,]/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    // Both separators present: whichever comes last is the decimal point.
    const [dec, group] = lastComma > lastDot ? [',', '.'] : ['.', ','];
    s = s.split(group).join('').replace(dec, '.');
  } else if (lastDot !== -1 || lastComma !== -1) {
    const sep = lastDot !== -1 ? '.' : ',';
    const parts = s.split(sep);
    const tail = parts[parts.length - 1];
    // A single separator with exactly 2 trailing digits is a decimal point
    // (`25739.00`); otherwise it is a thousands separator (`25,739`, `2,57,39`).
    if (parts.length === 2 && tail.length === 2) s = `${parts[0]}.${tail}`;
    else s = parts.join('');
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  if (rounded < PRICE_MIN || rounded > PRICE_MAX) return null;
  return rounded;
}

/**
 * Read a stock badge.
 *
 * The badge's `in-stock` / `out-stock` class is the authoritative signal — the
 * wording rotates between five templates. A *missing* badge is NOT out of stock;
 * it is a scrape failure, so this returns null rather than `{inStock:false}`.
 *
 * @param {{className?: string, text?: string}|null} badge
 * @returns {{inStock: boolean, quantity: number|null}|null}
 */
export function parseStock(badge) {
  if (!badge || typeof badge.className !== 'string') return null;
  const cls = badge.className;
  const text = typeof badge.text === 'string' ? badge.text : '';

  if (/\bout-stock\b/.test(cls)) return { inStock: false, quantity: 0 };
  if (!/\bin-stock\b/.test(cls)) return null;

  // All five in-stock templates contain exactly one integer: the quantity.
  const digits = foldFullWidthDigits(text).replace(INVISIBLE, '').match(/\d+/g);
  if (!digits || digits.length !== 1) return null;

  const quantity = Number(digits[0]);
  if (!Number.isInteger(quantity) || quantity <= 0) return null;
  return { inStock: true, quantity };
}
