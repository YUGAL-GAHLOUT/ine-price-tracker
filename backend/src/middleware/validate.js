import { HttpError } from './errorHandler.js';

/** Validate `req[source]` against a zod schema, replacing it with the parsed value. */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    return next(new HttpError(400, 'Request validation failed', result.error.issues.map((i) => ({
      path: i.path.join('.'), message: i.message,
    }))));
  }
  if (source === 'body') req.body = result.data;
  else req.validated = result.data;
  next();
};
