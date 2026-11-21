import crypto from 'node:crypto';

import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { users } from '@prisma/client';

import { config } from '../../config';
import { prisma } from '../../lib/prisma';

export interface AccessClaims extends JwtPayload {
  sub: string;
  type: 'access';
  token_version: number;
  exp: number;
  clinic_id?: string;
  fam?: string;
}

export interface RefreshClaims extends JwtPayload {
  sub: string;
  type: 'refresh';
  token_version: number;
  jti?: string;
  fam?: string;
}

export class TokenError extends Error {}

const SIGN_OPTIONS: jwt.SignOptions = { algorithm: 'HS256' };

export function createAccessToken(
  userId: string,
  options: { clinicId?: string | null; tokenVersion: number; familyId?: string | null },
): string {
  const payload: Record<string, unknown> = {
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + config.accessTokenExpireMinutes * 60,
    type: 'access',
    token_version: options.tokenVersion,
  };
  if (options.clinicId) payload.clinic_id = options.clinicId;
  if (options.familyId) payload.fam = options.familyId;
  return jwt.sign(payload, config.secretKey, SIGN_OPTIONS);
}

export function createRefreshToken(
  userId: string,
  options: { tokenVersion: number; jti: string; familyId: string },
): string {
  return jwt.sign(
    {
      sub: userId,
      exp: Math.floor(Date.now() / 1000) + config.refreshTokenExpireDays * 24 * 3600,
      type: 'refresh',
      token_version: options.tokenVersion,
      jti: options.jti,
      fam: options.familyId,
    },
    config.secretKey,
    SIGN_OPTIONS,
  );
}

export interface InviteToken {
  token: string;
  expiresAt: Date;
}

/**
 * Jeton « définir votre mot de passe » à usage unique, lié à
 * `token_version` : le consommer (version +1) invalide le lien et les
 * anciennes sessions. Refusé comme jeton bearer (`type !== "access"`).
 */
export function createInviteToken(userId: string, tokenVersion: number): InviteToken {
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const token = jwt.sign(
    {
      sub: userId,
      exp: Math.floor(expiresAt.getTime() / 1000),
      type: 'invite',
      token_version: tokenVersion,
    },
    config.secretKey,
    SIGN_OPTIONS,
  );
  return { token, expiresAt };
}

export function decodeToken<T extends JwtPayload = JwtPayload>(token: string): T {
  try {
    return jwt.verify(token, config.secretKey, { algorithms: ['HS256'] }) as T;
  } catch (error) {
    throw new TokenError(error instanceof Error ? error.message : 'Invalid token');
  }
}

function hashUserAgent(userAgent?: string): string | null {
  if (!userAgent) return null;
  return crypto.createHash('sha256').update(userAgent).digest('hex');
}

export interface IssuedRefreshToken {
  token: string;
  familyId: string;
}

/** Crée une ligne `auth_refresh_tokens` et le JWT qui la référence. */
export async function issueRefreshToken(
  user: Pick<users, 'id' | 'token_version'>,
  options: { familyId?: string; userAgent?: string; clientIp?: string } = {},
): Promise<IssuedRefreshToken> {
  const familyId = options.familyId ?? crypto.randomUUID();
  const now = new Date();
  const row = await prisma.auth_refresh_tokens.create({
    data: {
      id: crypto.randomUUID(),
      user_id: user.id,
      family_id: familyId,
      issued_at: now,
      expires_at: new Date(now.getTime() + config.refreshTokenExpireDays * 24 * 3600 * 1000),
      user_agent_hash: hashUserAgent(options.userAgent),
      last_ip: options.clientIp ? options.clientIp.slice(0, 64) : null,
    },
  });
  return {
    token: createRefreshToken(user.id, {
      tokenVersion: user.token_version,
      jti: row.id,
      familyId,
    }),
    familyId,
  };
}

export async function revokeFamily(familyId: string): Promise<number> {
  const result = await prisma.auth_refresh_tokens.updateMany({
    where: { family_id: familyId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
  return result.count;
}

export async function revokeAllForUser(userId: string): Promise<number> {
  const result = await prisma.auth_refresh_tokens.updateMany({
    where: { user_id: userId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
  return result.count;
}

export interface RotationResult {
  user: users;
  token: string;
  familyId: string;
}

/**
 * Successeur renvoyé pendant la fenêtre de grâce : le jeton présenté vient
 * d'être révoqué (rotation concurrente — deux onglets, ou deux rendus SSR
 * simultanés ont présenté le même cookie). Tant que la révocation est
 * récente et que son successeur n'a pas lui-même tourné, on renvoie ce
 * successeur au lieu de brûler la famille.
 */
async function withinGraceSuccessor(
  user: users,
  revokedRow: { revoked_at: Date | null; replaced_by: string | null },
  now: Date,
): Promise<RotationResult | null> {
  if (!revokedRow.revoked_at || !revokedRow.replaced_by) return null;
  const withinGrace =
    now.getTime() - revokedRow.revoked_at.getTime() <= config.refreshReuseGraceSeconds * 1000;
  if (!withinGrace) return null;
  const successor = await prisma.auth_refresh_tokens.findUnique({
    where: { id: revokedRow.replaced_by },
  });
  if (!successor || successor.revoked_at) return null;
  return {
    user,
    token: createRefreshToken(user.id, {
      tokenVersion: user.token_version,
      jti: successor.id,
      familyId: successor.family_id,
    }),
    familyId: successor.family_id,
  };
}

/**
 * Rotation avec détection de rejeu (ADR 0023) : le jeton présenté est
 * révoqué et remplacé. Un jeton déjà révoqué est traité comme un vol,
 * sauf pendant la fenêtre de grâce (onglets concurrents) où le
 * successeur encore vivant est renvoyé.
 *
 * La révocation est un compare-and-set (`revoked_at: null` dans le
 * `where`). Sans lui, deux refresh simultanés passaient tous deux le
 * contrôle « non révoqué » et émettaient chacun un successeur : le
 * navigateur ne gardait qu'un cookie, la chaîne `replaced_by` pointait
 * sur l'autre, et le prochain refresh présentait un jeton révoqué hors
 * délai de grâce — révocation de toute la famille et déconnexion
 * inexpliquée.
 */
export async function rotateRefreshToken(
  token: string,
  options: { userAgent?: string; clientIp?: string } = {},
): Promise<RotationResult> {
  let claims: RefreshClaims;
  try {
    claims = decodeToken<RefreshClaims>(token);
  } catch {
    throw new TokenError('Invalid or expired refresh token');
  }
  if (claims.type !== 'refresh' || !claims.sub) {
    throw new TokenError('Invalid refresh token');
  }

  const user = await prisma.users.findUnique({ where: { id: claims.sub } });
  if (!user || !user.is_active) throw new TokenError('User not found or inactive');
  if (user.token_version !== (claims.token_version ?? 0)) throw new TokenError('Token has been revoked');

  if (!claims.jti) {
    // Jeton hérité (sans ligne) : on démarre une famille suivie.
    const issued = await issueRefreshToken(user, options);
    return { user, token: issued.token, familyId: issued.familyId };
  }

  const row = await prisma.auth_refresh_tokens.findUnique({ where: { id: claims.jti } });
  if (!row || row.user_id !== user.id) throw new TokenError('Unknown refresh token');

  const now = new Date();
  if (row.revoked_at) {
    const recovered = await withinGraceSuccessor(user, row, now);
    if (recovered) return recovered;
    await revokeFamily(row.family_id);
    throw new TokenError('Refresh token reuse detected; session revoked');
  }
  if (row.expires_at <= now) throw new TokenError('Refresh token expired');

  const issued = await issueRefreshToken(user, { familyId: row.family_id, ...options });
  const newClaims = decodeToken<RefreshClaims>(issued.token);
  const claimed = await prisma.auth_refresh_tokens.updateMany({
    where: { id: row.id, revoked_at: null },
    data: { revoked_at: now, replaced_by: newClaims.jti ?? null },
  });
  if (claimed.count === 1) {
    return { user, token: issued.token, familyId: issued.familyId };
  }

  // Course perdue : un refresh concurrent a révoqué le jeton présenté entre
  // notre lecture et notre écriture. Le successeur qu'on vient d'émettre
  // n'est détenu par aucun client — on le révoque, puis on suit la chaîne
  // du gagnant (fenêtre de grâce) au lieu de considérer cela comme un vol.
  if (newClaims.jti) {
    await prisma.auth_refresh_tokens.updateMany({
      where: { id: newClaims.jti, revoked_at: null },
      data: { revoked_at: now },
    });
  }
  const winner = await prisma.auth_refresh_tokens.findUnique({ where: { id: row.id } });
  const recovered = winner ? await withinGraceSuccessor(user, winner, now) : null;
  if (recovered) return recovered;
  await revokeFamily(row.family_id);
  throw new TokenError('Refresh token reuse detected; session revoked');
}
