import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { HttpError } from './errorHandler.js';
import { rateLimit } from './rateLimit.js';

/** Constant-time compare, so the secret can't be recovered by timing the endpoint. */
function safeEqual(a, b) {
  const ab = Buffer.from(a ?? '', 'utf8');
  const bb = Buffer.from(b ?? '', 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Guards every endpoint that can start a scrape (the cron trigger and the manual
 * trigger). Without this, anyone could drive our browser fleet at will.
 *
 * Accepts `Authorization: Bearer <secret>` or `X-Cron-Secret: <secret>`.
 */
export function requireScrapeSecret(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const provided = bearer ?? req.get('x-cron-secret');

  if (!provided || !safeEqual(provided, config.cronSecret)) {
    return next(new HttpError(401, 'Missing or invalid scrape secret'));
  }
  next();
}

/**
 * Guard for the single-product **manual** scrape behind the dashboard's
 * "Scrape now" button.
 *
 * `CRON_SECRET` must never be used for this. Anything the browser sends has to be
 * baked into the Vite bundle, which is public, so shipping the cron secret to the
 * frontend would hand the scheduled-scrape endpoint to the internet.
 *
 * So the two capabilities get two separate credentials:
 *
 *  - `CRON_SECRET`          — full trigger rights (cron, CLI, curl). Server-side only.
 *  - `MANUAL_SCRAPE_TOKEN`  — may re-scrape ONE already-tracked product, nothing else.
 *                             Safe to ship to the browser; rate limited per IP.
 *
 * Both are required to be non-empty to be accepted, so an unset token can never
 * turn into an open endpoint. If neither is configured the endpoint stays closed.
 */
export function allowManualScrape(req, res, next) {
  const header = req.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const provided = bearer ?? req.get('x-cron-secret');

  if (!provided) return next(new HttpError(401, 'Missing scrape credential'));
  if (safeEqual(provided, config.cronSecret)) return next();

  const token = config.manualScrapeToken;
  if (token && safeEqual(provided, token)) return manualScrapeLimiter(req, res, next);

  return next(new HttpError(401, 'Missing or invalid scrape credential'));
}

/** A browser-held token is low privilege, but still must not become a scrape loop. */
const manualScrapeLimiter = rateLimit({ windowMs: 10 * 60_000, max: 6 });
