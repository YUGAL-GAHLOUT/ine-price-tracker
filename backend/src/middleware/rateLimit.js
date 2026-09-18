import { HttpError } from './errorHandler.js';

/**
 * Tiny in-memory fixed-window limiter.
 *
 * Enough to stop a loop from hammering the mock store through our search endpoint.
 * Per-instance only — fine here, since the free tier runs a single instance.
 */
export function rateLimit({ windowMs = 60_000, max = 60 } = {}) {
  const hits = new Map();
  return (req, _res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      if (hits.size > 5_000) for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
      return next();
    }
    if (++entry.count > max) return next(new HttpError(429, 'Too many requests, slow down'));
    next();
  };
}
