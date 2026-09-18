import { z } from 'zod';
import * as trackingService from '../services/trackingService.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'q is required').max(100),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

export const search = asyncHandler(async (req, res) => {
  const { q, limit } = req.validated;
  const result = await trackingService.searchProducts(q, limit);
  res.json({ query: q, count: result.items.length, source: result.source, catalogSize: result.catalogSize, items: result.items });
});
