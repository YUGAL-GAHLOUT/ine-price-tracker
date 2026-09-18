import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { HttpError } from './errorHandler.js';

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
