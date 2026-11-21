/**
 * Jetons signés de check-in QR (ADR 0037), port de
 * `backend/app/modules/agenda/checkin.py`.
 *
 * Un JWT courte durée (purpose `checkin`) permet au patient de
 * s'enregistrer en scannant un QR — sans compte ni login. Le jeton ne
 * porte que des identifiants opaques ; la ligne `appointments` reste
 * l'autorité. Le claim `source` indique à la page publique comment le
 * jeton est arrivé : `counter` (scan au comptoir, auto-submit),
 * `reminder`/`kiosk` exigent une pression. Une source absente ou
 * inconnue retombe sur `reminder` (jamais d'auto-submit).
 */

import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';

import { config } from '../../config';

export const CHECKIN_TOKEN_TTL_MINUTES = 15;
export const CHECKIN_SOURCES = ['counter', 'reminder', 'kiosk'] as const;
export type CheckinSource = (typeof CHECKIN_SOURCES)[number];

export class CheckinTokenError extends Error {
  constructor(message = 'Invalid or expired check-in code') {
    super(message);
    this.name = 'CheckinTokenError';
  }
}

export class CheckinConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckinConfigError';
  }
}

/** Secret dédié aux jetons publics ; repli SECRET_KEY hors production. */
export function checkinSecret(): string {
  const key = (process.env.AGENDA_PUBLIC_SECRET_KEY ?? '').trim();
  if (key) return key;
  if (config.isProduction) {
    throw new CheckinConfigError(
      'AGENDA_PUBLIC_SECRET_KEY is required in production: refusing to sign QR check-in tokens with the staff-JWT key.',
    );
  }
  return config.secretKey;
}

interface CheckinPayload {
  type: string;
  appointment_id: string;
  clinic_id: string;
  source: CheckinSource;
  exp: number;
}

/** Émet un jeton check-in pour un rendez-vous ; renvoie (token, expire le). */
export function mintCheckinToken(
  appointmentId: string,
  clinicId: string,
  source: CheckinSource = 'counter',
  ttlMinutes: number = CHECKIN_TOKEN_TTL_MINUTES,
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  const payload = {
    type: 'checkin',
    appointment_id: appointmentId,
    clinic_id: clinicId,
    source,
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  const token = jwt.sign(payload, checkinSecret(), { algorithm: 'HS256' });
  return { token, expiresAt };
}

/** Vérifie un jeton ; renvoie (appointmentId, clinicId, source). */
export function verifyCheckinToken(token: string): [string, string, CheckinSource] {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, checkinSecret(), {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
  } catch {
    throw new CheckinTokenError();
  }
  if (payload.type !== 'checkin') throw new CheckinTokenError();
  const appointmentId = payload.appointment_id;
  const clinicId = payload.clinic_id;
  if (typeof appointmentId !== 'string' || typeof clinicId !== 'string') {
    throw new CheckinTokenError();
  }
  let source = payload.source as string | undefined;
  if (!source || !CHECKIN_SOURCES.includes(source as CheckinSource)) {
    source = 'reminder';
  }
  return [appointmentId, clinicId, source as CheckinSource];
}

/** URL patient d'un jeton, origine issue de `ALLOWED_ORIGINS[0]`. */
export function buildCheckinUrl(token: string): string {
  const origin = config.allowedOrigins[0];
  if (!origin) {
    throw new CheckinConfigError('Set ALLOWED_ORIGINS to render check-in QR codes');
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new CheckinConfigError('ALLOWED_ORIGINS must hold http(s) origins');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.host) {
    throw new CheckinConfigError('ALLOWED_ORIGINS must hold http(s) origins');
  }
  return `${parsed.protocol}//${parsed.host}/p/check-in/${token}`;
}

/** Rend l'URL de check-in en PNG (niveau de correction M, comme Python). */
export async function renderCheckinQr(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 4,
    scale: 8,
  });
}
