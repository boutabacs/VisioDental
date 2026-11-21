import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

// Charge d'abord le .env local, puis la racine du dépôt en secours.
// dotenv n'écrase jamais une variable déjà définie.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

// Le `.env` historique (FastAPI) utilise le driver SQLAlchemy
// `postgresql+asyncpg://` — Prisma n'accepte que `postgresql://`.
if (/^postgresql\+[A-Za-z0-9_]+:/.test(process.env.DATABASE_URL ?? '')) {
  process.env.DATABASE_URL = process.env.DATABASE_URL!.replace(
    /^postgresql\+[A-Za-z0-9_]+:/,
    'postgresql:',
  );
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL est requis'),
  SECRET_KEY: z.string().min(32, 'SECRET_KEY doit faire au moins 32 caractères'),
  ALGORITHM: z.string().default('HS256'),
  ACCESS_TOKEN_EXPIRE_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_EXPIRE_DAYS: z.coerce.number().int().positive().default(7),
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().nonnegative().default(30),
  ENVIRONMENT: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8100),
  // Interface d'écoute de l'API. En cabinet, l'API reste en boucle locale
  // derrière le proxy Nuxt (seul le site écoute sur le réseau).
  API_HOST: z.string().default('0.0.0.0'),
  COOKIE_DOMAIN: z.string().default(''),
  // Cookies `Secure` : 'auto' (comportement historique : activé en
  // production), 'true' forcé, 'false' forcé. Un serveur de cabinet en HTTP
  // sur le réseau local doit utiliser 'false', sinon le navigateur rejette
  // les cookies de session.
  COOKIE_SECURE: z
    .enum(['auto', 'true', 'false'])
    .default('auto')
    .transform((value) => (value === 'auto' ? ('auto' as const) : value === 'true')),
  ALLOWED_ORIGINS: z.string().default(''),
  // Miroir de FastAPI (`FORWARDED_ALLOW_IPS`) : liste des proxys de confiance
  // pour `X-Forwarded-For` (Express `trust proxy`).
  FORWARDED_ALLOW_IPS: z
    .string()
    .default('127.0.0.1,::1,172.16.0.0/12,192.168.0.0/16'),
  DEMO_MODE: z.string().default('false'),
  // Stockage média (miroir de `STORAGE_*` côté FastAPI).
  STORAGE_BACKEND: z.string().default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage'),
  STORAGE_MAX_FILE_SIZE: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  STORAGE_ALLOWED_MIME_TYPES: z.string().default('application/pdf,image/jpeg,image/png'),
  // Couche agentique / copilot — mêmes noms de variables que FastAPI
  // (`app/config.py`). Les clés restent `undefined` si absentes : elles ne
  // sont jamais journalisées ni renvoyées au client.
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default('http://ollama:11434'),
  COPILOT_PROVIDER_DEFAULT: z.string().default('openai'),
  COPILOT_MODEL_CHAT_OPENAI: z.string().default('gpt-5.4-mini'),
  COPILOT_MODEL_CHAT_ANTHROPIC: z.string().default('claude-sonnet-5'),
  COPILOT_MODEL_CHAT_GEMINI: z.string().default('gemini-3.5-flash'),
  COPILOT_MODEL_CHAT_OPENROUTER: z.string().default('meta-llama/llama-3.3-70b-instruct'),
  COPILOT_MODEL_CHAT_GROQ: z.string().default('llama-3.3-70b-versatile'),
  COPILOT_MODEL_CHAT_OLLAMA: z.string().default('llama3.1:8b'),
  COPILOT_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  COPILOT_REDACTION_DEFAULT: z
    .string()
    .default('true')
    .transform((value) => value.toLowerCase() !== 'false' && value !== '0'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
  console.error(`Configuration invalide :\n${details.join('\n')}`);
  process.exit(1);
}

const raw = parsed.data;

export const config = {
  databaseUrl: raw.DATABASE_URL,
  secretKey: raw.SECRET_KEY,
  algorithm: raw.ALGORITHM,
  accessTokenExpireMinutes: raw.ACCESS_TOKEN_EXPIRE_MINUTES,
  refreshTokenExpireDays: raw.REFRESH_TOKEN_EXPIRE_DAYS,
  refreshReuseGraceSeconds: raw.REFRESH_REUSE_GRACE_SECONDS,
  environment: raw.ENVIRONMENT,
  port: raw.PORT,
  apiHost: raw.API_HOST.trim() || '0.0.0.0',
  cookieDomain: raw.COOKIE_DOMAIN.trim() || undefined,
  cookieSecure: raw.COOKIE_SECURE,
  allowedOrigins: raw.ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  forwardedAllowIps: raw.FORWARDED_ALLOW_IPS,
  demoMode: raw.DEMO_MODE.toLowerCase() === 'true',
  storageBackend: raw.STORAGE_BACKEND.trim().toLowerCase(),
  /** Racine disque ; `MEDIA_ROOT` (plus explicite) prime sur `STORAGE_LOCAL_PATH`. */
  mediaRoot: (process.env.MEDIA_ROOT?.trim() || raw.STORAGE_LOCAL_PATH || './storage'),
  storageMaxFileSize: raw.STORAGE_MAX_FILE_SIZE,
  storageAllowedMimeTypes: raw.STORAGE_ALLOWED_MIME_TYPES,
  // Couche agentique / copilot. Les clés API ne sont lues que par
  // `modules/copilot/provider.ts` (via `process.env[spec.apiKeySetting]`) :
  // elles ne sont volontairement pas propagées dans cet objet.
  ollamaBaseUrl: raw.OLLAMA_BASE_URL,
  copilotProviderDefault: raw.COPILOT_PROVIDER_DEFAULT,
  copilotModelChatOpenai: raw.COPILOT_MODEL_CHAT_OPENAI,
  copilotModelChatAnthropic: raw.COPILOT_MODEL_CHAT_ANTHROPIC,
  copilotModelChatGemini: raw.COPILOT_MODEL_CHAT_GEMINI,
  copilotModelChatOpenrouter: raw.COPILOT_MODEL_CHAT_OPENROUTER,
  copilotModelChatGroq: raw.COPILOT_MODEL_CHAT_GROQ,
  copilotModelChatOllama: raw.COPILOT_MODEL_CHAT_OLLAMA,
  copilotMaxTokens: raw.COPILOT_MAX_TOKENS,
  copilotRedactionDefault: raw.COPILOT_REDACTION_DEFAULT,
  isProduction: raw.ENVIRONMENT === 'production',
  isTest: raw.ENVIRONMENT === 'test' || process.env.NODE_ENV === 'test',
} as const;
