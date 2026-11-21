import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

import { config } from '../config';

/** Limiteur compatible avec `slowapi` côté FastAPI (désactivé en test). */
export function limiter(options: { limit: number; windowMs?: number; key?: 'ip' | 'email' }) {
  return rateLimit({
    windowMs: options.windowMs ?? 60_000,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => config.isTest,
    ...(options.key === 'email'
      ? {
          keyGenerator: (req) => {
            const body = req.body as Record<string, unknown> | undefined;
            const email = (body?.username ?? body?.email) as string | undefined;
            return `${ipKeyGenerator(req.ip ?? '')}:${email ?? ''}`;
          },
        }
      : {}),
  });
}
