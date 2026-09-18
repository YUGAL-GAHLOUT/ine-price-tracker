import cors from 'cors';
import express from 'express';
import { config } from './config/env.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { router } from './routes/index.js';
import { logger } from './utils/logger.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // Render sits behind a proxy; needed for req.ip
  app.disable('x-powered-by');

  const allowAll = config.corsOrigins.includes('*');
  app.use(cors({
    origin: allowAll ? true : config.corsOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Cron-Secret'],
  }));

  app.use(express.json({ limit: '64kb' }));

  app.use((req, _res, next) => {
    logger.debug('http.request', { method: req.method, path: req.path });
    next();
  });

  app.use('/api', router);
  app.get('/', (_req, res) => res.json({ name: 'INE Product Price Tracker API', docs: '/api/health' }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
