import { isProd } from '../config/env.js';
import { logger } from '../utils/logger.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const notFound = (req, res) =>
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });

/** Centralised error handling: one response shape, and no internals leaked in prod. */
export function errorHandler(err, _req, res, _next) {
  const status = err.status ?? 500;
  if (status >= 500) logger.error('http.error', { message: err.message, stack: err.stack?.split('\n')[1]?.trim() });
  else logger.warn('http.client_error', { status, message: err.message });

  res.status(status).json({
    error: {
      code: err.code ?? (status >= 500 ? 'internal_error' : 'bad_request'),
      message: status >= 500 && isProd ? 'Internal server error' : err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
}

/** Wrap an async handler so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
