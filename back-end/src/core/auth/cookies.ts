import crypto from 'node:crypto';

import { config } from '../../config';

/** Noms et options des cookies de session — identiques au backend FastAPI. */
export const ACCESS_COOKIE = 'dp_access';
export const REFRESH_COOKIE = 'dp_refresh';
export const CSRF_COOKIE = 'dp_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function newCsrfToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

interface CookieRequestInfo {
  secure?: boolean;
}

/**
 * `Secure` uniquement en production (localhost en HTTP ne le supporterait
 * pas). `COOKIE_SECURE` force le choix : indispensable pour un serveur de
 * cabinet joignable en HTTP sur le réseau local.
 */
function isSecure(info?: CookieRequestInfo): boolean {
  if (config.cookieSecure !== 'auto') return config.cookieSecure;
  if (!config.isProduction) return false;
  return info?.secure ?? true;
}

interface SessionCookies {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
}

interface CookieOptions {
  httpOnly?: boolean;
  maxAge?: number;
  sameSite?: 'lax' | 'strict' | 'none';
  secure?: boolean;
  domain?: string;
  path?: string;
}

// Typage minimal pour éviter d'importer les types Express ici.
interface CookieResponse {
  cookie(name: string, value: string, options?: CookieOptions): unknown;
  clearCookie(name: string, options?: CookieOptions): unknown;
}

export function setSessionCookies(res: CookieResponse, cookies: SessionCookies, info?: CookieRequestInfo): void {
  const common = {
    secure: isSecure(info),
    sameSite: 'lax' as const,
    path: '/',
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  };
  res.cookie(ACCESS_COOKIE, cookies.accessToken, {
    ...common,
    httpOnly: true,
    maxAge: config.accessTokenExpireMinutes * 60 * 1000,
  });
  res.cookie(REFRESH_COOKIE, cookies.refreshToken, {
    ...common,
    httpOnly: true,
    maxAge: config.refreshTokenExpireDays * 24 * 60 * 60 * 1000,
  });
  res.cookie(CSRF_COOKIE, cookies.csrfToken, {
    ...common,
    httpOnly: false,
    maxAge: config.refreshTokenExpireDays * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookies(res: CookieResponse): void {
  const common = {
    path: '/',
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  };
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE]) {
    res.clearCookie(name, common);
  }
}
