import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma';

/**
 * Abonnements WebPush et jetons d'abonnement single-use — port de
 * `PushSubscriptionService` / `PushSubscribeTokenService` (`push.py`).
 * Tout est cloisonné par clinique.
 */

/** Équivalent de `raise LookupError(...)` en Python. */
export class LookupErrorLike extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LookupErrorLike';
  }
}

/** Équivalent de `raise ValueError(...)`. */
export class ValueErrorLike extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueErrorLike';
  }
}

const TOKEN_TTL_HOURS = 24;

/** Le worker POSTe là où on lui dit : refuser tout ce qui n'est pas HTTPS. */
function requireHttpsEndpoint(endpoint: string): void {
  if (!endpoint.startsWith('https://')) {
    throw new ValueErrorLike('subscription endpoint must be an https:// URL');
  }
}

function requireKeys(keys: unknown, message: string): { p256dh: string; auth: string } {
  if (!keys || typeof keys !== 'object' || ('p256dh' in keys) === false || ('auth' in keys) === false) {
    throw new ValueErrorLike(message);
  }
  return keys as { p256dh: string; auth: string };
}

export interface PushSubscriptionRow {
  id: string;
  clinic_id: string;
  patient_id: string;
  endpoint: string;
  created_at: Date;
  updated_at: Date;
}

/** Upsert par (clinic, endpoint) : se réabonner rafraîchit les clés. */
export async function subscribe(
  clinicId: string,
  patientId: string,
  endpoint: string,
  keys: { p256dh: string; auth: string },
  userAgent: string | null,
): Promise<PushSubscriptionRow> {
  const patient = await prisma.patients.findFirst({
    where: { id: patientId, clinic_id: clinicId },
    select: { id: true },
  });
  if (!patient) throw new LookupErrorLike('Patient not found');
  requireHttpsEndpoint(endpoint);
  const safeKeys = requireKeys(keys, 'subscription needs endpoint + keys.p256dh + keys.auth');

  const existing = await prisma.notification_push_subscriptions.findFirst({
    where: { clinic_id: clinicId, endpoint },
  });
  if (existing) {
    return prisma.notification_push_subscriptions.update({
      where: { id: existing.id },
      data: {
        patient_id: patientId,
        keys: safeKeys as unknown as Prisma.InputJsonValue,
        user_agent: userAgent,
        updated_at: new Date(),
      },
      select: {
        id: true,
        clinic_id: true,
        patient_id: true,
        endpoint: true,
        created_at: true,
        updated_at: true,
      },
    });
  }
  const now = new Date();
  return prisma.notification_push_subscriptions.create({
    data: {
      id: crypto.randomUUID(),
      created_at: now,
      updated_at: now,
      clinic_id: clinicId,
      patient_id: patientId,
      endpoint,
      keys: safeKeys as unknown as Prisma.InputJsonValue,
      user_agent: userAgent,
    },
    select: {
      id: true,
      clinic_id: true,
      patient_id: true,
      endpoint: true,
      created_at: true,
      updated_at: true,
    },
  });
}

export async function listPushSubscriptions(
  clinicId: string,
  patientId: string,
): Promise<PushSubscriptionRow[]> {
  return prisma.notification_push_subscriptions.findMany({
    where: { clinic_id: clinicId, patient_id: patientId },
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      clinic_id: true,
      patient_id: true,
      endpoint: true,
      created_at: true,
      updated_at: true,
    },
  });
}

export async function unsubscribe(clinicId: string, subscriptionId: string): Promise<boolean> {
  const row = await prisma.notification_push_subscriptions.findFirst({
    where: { id: subscriptionId, clinic_id: clinicId },
    select: { id: true },
  });
  if (!row) return false;
  await prisma.notification_push_subscriptions.delete({ where: { id: row.id } });
  return true;
}

/** Abonnements auxquels l'adaptateur diffuse (existence = opt-in). */
export async function activeForPatient(clinicId: string, patientId: string) {
  return prisma.notification_push_subscriptions.findMany({
    where: { clinic_id: clinicId, patient_id: patientId },
    orderBy: { created_at: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Jetons d'abonnement (flux patient, 24 h, usage unique)
// ---------------------------------------------------------------------------

export interface SubscribeTokenRow {
  token: string;
  patient_id: string;
  expires_at: Date;
}

/** Le staff émet un jeton single-use pour un patient. */
export async function mintSubscribeToken(
  clinicId: string,
  patientId: string,
): Promise<SubscribeTokenRow> {
  const patient = await prisma.patients.findFirst({
    where: { id: patientId, clinic_id: clinicId },
    select: { id: true },
  });
  if (!patient) throw new LookupErrorLike('Patient not found');
  const now = new Date();
  return prisma.notification_push_subscribe_tokens.create({
    data: {
      id: crypto.randomUUID(),
      created_at: now,
      updated_at: now,
      clinic_id: clinicId,
      patient_id: patientId,
      token: crypto.randomUUID(),
      expires_at: new Date(now.getTime() + TOKEN_TTL_HOURS * 3600_000),
    },
    select: { token: true, patient_id: true, expires_at: true },
  });
}

/**
 * Consommation du jeton : résolution en lecture d'abord (un abonnement mal
 * formé ne doit pas brûler le jeton), puis consommation atomique — un seul
 * redeem concurrent l'emporte.
 */
export async function redeemSubscribeToken(
  token: string,
  endpoint: string,
  keys: { p256dh: string; auth: string },
  userAgent: string | null,
): Promise<void> {
  requireHttpsEndpoint(endpoint);
  requireKeys(keys, 'subscription needs keys.p256dh + keys.auth');

  const row = await prisma.notification_push_subscribe_tokens.findUnique({ where: { token } });
  if (!row || row.used_at !== null || row.expires_at < new Date()) {
    throw new LookupErrorLike('Invalid or expired subscribe token');
  }
  const patient = await prisma.patients.findFirst({
    where: { id: row.patient_id, clinic_id: row.clinic_id },
    select: { id: true },
  });
  if (!patient) throw new LookupErrorLike('Invalid or expired subscribe token');

  const consumed = await prisma.notification_push_subscribe_tokens.updateMany({
    where: { id: row.id, used_at: null },
    data: { used_at: new Date() },
  });
  if (consumed.count === 0) throw new LookupErrorLike('Invalid or expired subscribe token');

  await subscribe(row.clinic_id, row.patient_id, endpoint, keys, userAgent);
}

/** Validité + données de l'écran de consentement, sans consommation. */
export async function validateSubscribeToken(
  token: string,
): Promise<{ clinic_name: string; expires_at: Date } | null> {
  const row = await prisma.notification_push_subscribe_tokens.findUnique({ where: { token } });
  if (!row || row.used_at !== null || row.expires_at < new Date()) return null;
  const clinic = await prisma.clinics.findUnique({
    where: { id: row.clinic_id },
    select: { name: true },
  });
  return { clinic_name: clinic?.name ?? '', expires_at: row.expires_at };
}
