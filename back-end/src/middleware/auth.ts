import crypto from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { config } from '../config';
import { prisma } from '../lib/prisma';
import { forbidden, unauthorized } from '../lib/errors';
import { hasPermission } from '../core/auth/rbac';
import { ACCESS_COOKIE, CSRF_COOKIE, CSRF_HEADER, SAFE_METHODS } from '../core/auth/cookies';
import { decodeToken, type AccessClaims } from '../core/auth/tokens';

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Authentifie par `Authorization: Bearer` ou cookie `dp_access`.
 * Les requêtes non sûres authentifiées par cookie doivent renvoyer le
 * jeton CSRF (double-submit) dans `X-CSRF-Token`.
 */
export const authenticate: RequestHandler = async (req, res, next) => {
  try {
    const authorization = req.headers.authorization ?? '';
    const bearer = authorization.toLowerCase().startsWith('bearer ')
      ? authorization.slice(7).trim()
      : null;

    let token: string | null = bearer;
    let viaCookie = false;

    if (!token) {
      const cookieToken = (req.cookies as Record<string, string | undefined>)[ACCESS_COOKIE];
      if (cookieToken) {
        token = cookieToken;
        viaCookie = true;
        if (!SAFE_METHODS.has(req.method.toUpperCase())) {
          const header = req.headers[CSRF_HEADER];
          const expected = (req.cookies as Record<string, string | undefined>)[CSRF_COOKIE];
          const headerValue = Array.isArray(header) ? header[0] : header;
          if (!headerValue || !expected || !timingSafeEqualStrings(headerValue, expected)) {
            throw forbidden('CSRF token missing or invalid');
          }
        }
      }
    }

    if (!token) throw unauthorized('Not authenticated');

    let claims: AccessClaims;
    try {
      claims = decodeToken<AccessClaims>(token);
    } catch {
      throw unauthorized('Could not validate credentials');
    }
    if (!claims.sub || claims.type !== 'access') {
      throw unauthorized('Could not validate credentials');
    }

    const user = await prisma.users.findUnique({ where: { id: claims.sub } });
    if (!user) throw unauthorized('Could not validate credentials');
    if (!user.is_active) throw forbidden('User account is inactive');
    if (user.token_version !== (claims.token_version ?? 0)) {
      throw unauthorized('Could not validate credentials');
    }

    const memberships = await prisma.clinic_memberships.findMany({
      where: { user_id: user.id },
      include: { clinics: true },
      orderBy: { created_at: 'asc' },
    });

    const membership =
      (claims.clinic_id ? memberships.find((m) => m.clinic_id === claims.clinic_id) : undefined) ??
      memberships[0];

    req.user = user;
    req.auth = claims;
    req.authViaCookie = viaCookie;
    if (membership) {
      req.membership = membership;
      req.clinic = membership.clinics;
      req.clinicId = membership.clinic_id;
      req.role = membership.role;
    }
    next();
  } catch (error) {
    next(error);
  }
};

/** Exige une appartenance à une clinique (multi-tenant). */
export const requireClinic: RequestHandler = (req, _res, next) => {
  if (!req.clinicId || !req.clinic || !req.role) {
    next(forbidden('User is not a member of any clinic'));
    return;
  }
  next();
};

/** Exige une permission RBAC namespacée, ex. `patients.read`. */
export function requirePermission(permission: string): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.clinicId || !req.role) {
        throw forbidden('User is not a member of any clinic');
      }
      if (!(await hasPermission(req.clinicId, req.role, permission))) {
        throw forbidden(`Permission denied: ${permission}`);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Refuse les mutations sur l'instance de démonstration publique. */
export const blockInDemo: RequestHandler = (req, _res, next) => {
  if (config.demoMode && !SAFE_METHODS.has(req.method.toUpperCase())) {
    next(forbidden('This action is disabled on the public demo.'));
    return;
  }
  next();
};
