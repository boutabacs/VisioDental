import type { RequestHandler } from 'express';

import { config } from '../config';

/** Journal de requêtes lisible en développement (désactivé en test). */
export const requestLogger: RequestHandler = (req, res, next) => {
  if (config.isTest) {
    next();
    return;
  }
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.log(
      `[api] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs.toFixed(1)} ms)`,
    );
  });
  next();
};
