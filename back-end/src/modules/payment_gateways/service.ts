/**
 * Logique métier `payment_gateways` — port de
 * `backend/app/modules/payment_gateways/service.py`.
 *
 * `PaymentRequestService` possède le cycle pré-paiement et est le *seul*
 * chemin autorisé à créer un `payments.Payment` depuis une confirmation
 * gateway ; `GatewayRefundService` fait de même pour les remboursements.
 * Les écritures financières délèguent toujours à `payments.service`
 * (workflow) — ce module ne construit jamais de Payment/Refund lui-même.
 *
 * Le fournisseur (razorpay) est activable par module ; ici l'on
 * n'interroge que le registre d'adaptateurs.
 */
import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { toClinicDateString } from '../../lib/time';
import {
  recordPayment,
  refundPayment,
  PaymentWorkflowError,
} from '../payments/service';
import { columnDecimal, sumDecimals, AllocationInput } from '../payments/schemas';
import {
  gatewayRegistry,
  type GatewayAdapter,
  type GatewayConfirmation,
  type GatewayCustomerInfo,
  type GatewayRefundRequestLike,
  type PaymentRequestLike,
} from './adapters';
import {
  TERMINAL_REFUND_STATES,
  TERMINAL_REQUEST_STATES,
  validatePaymentRequestTransition,
  validateRefundTransition,
  type GatewayRefundState,
  type PaymentRequestState,
} from './constants';

/** `GatewayError` — précondition métier (400 au routeur). */
export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayError';
  }
}

function uuidv4(): string {
  return crypto.randomUUID();
}

function now(): Date {
  return new Date();
}

export function newIdempotencyKey(): string {
  return uuidv4().replace(/-/g, '');
}

/**
 * Lignes des tables `payment_requests` / `gateway_refund_requests`.
 *
 * Ces deux tables existent dans PostgreSQL (module Python) mais n'ont
 * pas encore été introspectées dans `prisma/schema.prisma` (la
 * modification du schéma Prisma est hors périmètre de ce port). Les
 * accès passent donc par `$queryRaw` typé, avec les mêmes colonnes.
 */
interface PaymentRequestRow {
  id: string;
  clinic_id: string;
  patient_id: string;
  provider_key: string;
  requested_amount: Prisma.Decimal;
  currency: string;
  requested_method: string;
  state: string;
  allocation_input: unknown;
  context: unknown;
  idempotency_key: string;
  provider_reference: string | null;
  provider_payment_reference: string | null;
  checkout_payload_snapshot: unknown;
  raw_status_snapshot: unknown;
  payment_id: string | null;
  expires_at: Date | null;
  confirmed_at: Date | null;
  failed_at: Date | null;
  cancelled_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface GatewayRefundRow {
  id: string;
  clinic_id: string;
  payment_id: string;
  payment_request_id: string;
  provider_key: string;
  provider_payment_reference: string;
  requested_amount: Prisma.Decimal;
  reason_code: string;
  reason_note: string | null;
  state: string;
  idempotency_key: string;
  provider_refund_reference: string | null;
  raw_status_snapshot: unknown;
  refund_id: string | null;
  requested_by: string;
  completed_at: Date | null;
  failed_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PaymentRequestWithRefunds extends PaymentRequestRow {
  gateway_refund_requests: GatewayRefundRow[];
}

export type GatewayRefundRequestRow = GatewayRefundRow;

const REQUEST_COLUMNS = Prisma.sql`
  id, clinic_id, patient_id, provider_key, requested_amount, currency,
  requested_method, state, allocation_input, context, idempotency_key,
  provider_reference, provider_payment_reference, checkout_payload_snapshot,
  raw_status_snapshot, payment_id, expires_at, confirmed_at, failed_at,
  cancelled_at, error_code, error_message, created_by, created_at, updated_at`;

const REFUND_COLUMNS = Prisma.sql`
  id, clinic_id, payment_id, payment_request_id, provider_key,
  provider_payment_reference, requested_amount, reason_code, reason_note,
  state, idempotency_key, provider_refund_reference, raw_status_snapshot,
  refund_id, requested_by, completed_at, failed_at, error_code,
  error_message, created_at, updated_at`;

async function refundsForRequests(
  tx: Prisma.TransactionClient | typeof prisma,
  requestIds: string[],
): Promise<Map<string, GatewayRefundRow[]>> {
  const grouped = new Map<string, GatewayRefundRow[]>();
  if (requestIds.length === 0) return grouped;
  const idList = Prisma.join(requestIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await tx.$queryRaw<GatewayRefundRow[]>(
    Prisma.sql`SELECT ${REFUND_COLUMNS} FROM gateway_refund_requests
               WHERE payment_request_id IN (${idList})
               ORDER BY created_at DESC`,
  );
  for (const row of rows) {
    const list = grouped.get(row.payment_request_id) ?? [];
    list.push(row);
    grouped.set(row.payment_request_id, list);
  }
  return grouped;
}

async function hydrateRequests(
  tx: Prisma.TransactionClient | typeof prisma,
  rows: PaymentRequestRow[],
): Promise<PaymentRequestWithRefunds[]> {
  const refunds = await refundsForRequests(
    tx,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({ ...row, gateway_refund_requests: refunds.get(row.id) ?? [] }));
}

async function findRequestById(
  tx: Prisma.TransactionClient | typeof prisma,
  clinicId: string,
  requestId: string,
): Promise<PaymentRequestWithRefunds | null> {
  const rows = await tx.$queryRaw<PaymentRequestRow[]>(
    Prisma.sql`SELECT ${REQUEST_COLUMNS} FROM payment_requests
               WHERE id = ${requestId}::uuid AND clinic_id = ${clinicId}::uuid
               LIMIT 1`,
  );
  if (rows.length === 0) return null;
  const [hydrated] = await hydrateRequests(tx, rows);
  return hydrated ?? null;
}

/** Requêtes (hydratées avec leurs remboursements) pour une clause WHERE donnée. */
async function findRequests(
  whereClause: Prisma.Sql,
): Promise<PaymentRequestWithRefunds[]> {
  const rows = await prisma.$queryRaw<PaymentRequestRow[]>(
    Prisma.sql`SELECT ${REQUEST_COLUMNS} FROM payment_requests ${whereClause}`,
  );
  return hydrateRequests(prisma, rows);
}

async function updateRequest(
  data: Partial<Omit<PaymentRequestRow, 'allocation_input' | 'context' | 'checkout_payload_snapshot' | 'raw_status_snapshot'>> & {
    allocation_input?: Prisma.InputJsonValue;
    context?: Prisma.InputJsonValue;
    checkout_payload_snapshot?: Prisma.InputJsonValue;
    raw_status_snapshot?: Prisma.InputJsonValue;
  },
): Promise<void> {
  const sets: Prisma.Sql[] = [Prisma.sql`updated_at = ${now()}`];
  const assign = (column: string, value: unknown) => {
    if (value === undefined) return;
    sets.push(Prisma.sql`${Prisma.raw(column)} = ${value}`);
  };
  assign('state', data.state);
  assign('provider_reference', data.provider_reference);
  assign('provider_payment_reference', data.provider_payment_reference);
  assign('payment_id', data.payment_id);
  assign('expires_at', data.expires_at);
  assign('confirmed_at', data.confirmed_at);
  assign('failed_at', data.failed_at);
  assign('cancelled_at', data.cancelled_at);
  assign('error_code', data.error_code);
  assign('error_message', data.error_message);
  if (data.checkout_payload_snapshot !== undefined) {
    sets.push(
      Prisma.sql`checkout_payload_snapshot = ${JSON.stringify(data.checkout_payload_snapshot)}::jsonb`,
    );
  }
  if (data.raw_status_snapshot !== undefined) {
    sets.push(Prisma.sql`raw_status_snapshot = ${JSON.stringify(data.raw_status_snapshot)}::jsonb`);
  }
  if (data.context !== undefined) {
    sets.push(Prisma.sql`context = ${JSON.stringify(data.context)}::jsonb`);
  }
  await prisma.$executeRaw(
    Prisma.sql`UPDATE payment_requests SET ${Prisma.join(sets, ', ')} WHERE id = ${data.id}::uuid`,
  );
}

async function updateRefundRequest(
  id: string,
  data: {
    state?: string;
    provider_refund_reference?: string | null;
    refund_id?: string | null;
    completed_at?: Date | null;
    failed_at?: Date | null;
    error_code?: string | null;
    error_message?: string | null;
  },
): Promise<GatewayRefundRow> {
  const sets: Prisma.Sql[] = [Prisma.sql`updated_at = ${now()}`];
  const assign = (column: string, value: unknown) => {
    if (value === undefined) return;
    sets.push(Prisma.sql`${Prisma.raw(column)} = ${value}`);
  };
  assign('state', data.state);
  assign('provider_refund_reference', data.provider_refund_reference);
  assign('refund_id', data.refund_id);
  assign('completed_at', data.completed_at);
  assign('failed_at', data.failed_at);
  assign('error_code', data.error_code);
  assign('error_message', data.error_message);
  const rows = await prisma.$queryRaw<GatewayRefundRow[]>(
    Prisma.sql`UPDATE gateway_refund_requests SET ${Prisma.join(sets, ', ')}
               WHERE id = ${id}::uuid RETURNING ${REFUND_COLUMNS}`,
  );
  return rows[0]!;
}

function asPaymentRequestLike(row: PaymentRequestWithRefunds): PaymentRequestLike {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    patient_id: row.patient_id,
    provider_key: row.provider_key,
    requested_amount: columnDecimal(row.requested_amount),
    currency: row.currency,
    requested_method: row.requested_method,
    state: row.state,
    provider_reference: row.provider_reference,
    provider_payment_reference: row.provider_payment_reference,
    payment_id: row.payment_id,
    created_by: row.created_by,
  };
}

function asGatewayRefundLike(row: GatewayRefundRequestRow): GatewayRefundRequestLike {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    payment_id: row.payment_id,
    payment_request_id: row.payment_request_id,
    provider_key: row.provider_key,
    provider_payment_reference: row.provider_payment_reference,
    requested_amount: columnDecimal(row.requested_amount),
    reason_code: row.reason_code,
    requested_by: row.requested_by,
    state: row.state,
  };
}

function rawSnapshot(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PaymentRequestService
// ---------------------------------------------------------------------------

export async function getPaymentRequest(
  clinicId: string,
  requestId: string,
): Promise<PaymentRequestWithRefunds | null> {
  return findRequestById(prisma, clinicId, requestId);
}

export async function getPaymentRequestForPayment(
  clinicId: string,
  paymentId: string,
): Promise<PaymentRequestWithRefunds | null> {
  const found = await findRequests(
    Prisma.sql`WHERE clinic_id = ${clinicId}::uuid AND payment_id = ${paymentId}::uuid LIMIT 1`,
  );
  return found[0] ?? null;
}

export async function getPaymentRequestsForPaymentsBatch(
  clinicId: string,
  paymentIds: string[],
): Promise<Map<string, PaymentRequestWithRefunds>> {
  const out = new Map<string, PaymentRequestWithRefunds>();
  if (paymentIds.length === 0) return out;
  const idList = Prisma.join(paymentIds.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await findRequests(
    Prisma.sql`WHERE clinic_id = ${clinicId}::uuid AND payment_id IN (${idList})`,
  );
  for (const row of rows) {
    if (row.payment_id) out.set(row.payment_id, row);
  }
  return out;
}

export async function getPaymentRequestLocked(
  clinicId: string,
  requestId: string,
): Promise<PaymentRequestWithRefunds | null> {
  // La transaction ne contient que le verrou : les lignes sont relues avec
  // les mêmes garanties qu'une lecture simple (`populate_existing`).
  const found = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM payment_requests
                 WHERE id = ${requestId}::uuid AND clinic_id = ${clinicId}::uuid
                 FOR UPDATE`,
    );
    return rows.length > 0;
  });
  if (!found) return null;
  return findRequestById(prisma, clinicId, requestId);
}

/** Adaptateur actif pour une clé fournisseur, ou `null`. */
function adapterFor(providerKey: string): GatewayAdapter | null {
  return gatewayRegistry.get(providerKey);
}

/** `payment.amount` moins les remboursements core *complétés*. */
async function refundableAmount(clinicId: string, payment: { id: string; amount: Prisma.Decimal }) {
  const aggregate = await prisma.refunds.aggregate({
    where: { payment_id: payment.id, clinic_id: clinicId },
    _sum: { amount: true },
  });
  return columnDecimal(payment.amount).minus(columnDecimal(aggregate._sum.amount ?? 0));
}

export interface CreateAndInitiateInput {
  clinicId: string;
  patientId: string;
  providerKey: string;
  amount: Prisma.Decimal;
  currency: string;
  method: string;
  allocations: AllocationInput[];
  context: Record<string, unknown> | null;
  createdBy: string;
  idempotencyKey: string | null;
}

/**
 * Crée un `PaymentRequest` et démarre le checkout fournisseur.
 *
 * Réutilise la règle de somme des allocations de `payments` (échec avant
 * tout appel fournisseur). Un retry avec la même `idempotencyKey` renvoie
 * la requête existante au lieu d'ouvrir une seconde commande.
 */
export async function createAndInitiatePaymentRequest(
  input: CreateAndInitiateInput,
): Promise<PaymentRequestWithRefunds> {
  const idempotencyKey = input.idempotencyKey || newIdempotencyKey();

  const existing = await findRequests(
    Prisma.sql`WHERE clinic_id = ${input.clinicId}::uuid AND idempotency_key = ${idempotencyKey} LIMIT 1`,
  );
  if (existing[0]) return existing[0];

  const adapter = adapterFor(input.providerKey);
  if (!adapter) {
    throw new GatewayError(`Unknown or inactive payment gateway provider '${input.providerKey}'`);
  }
  if (!adapter.supported_methods.includes(input.method)) {
    throw new GatewayError(`${input.providerKey} does not support method '${input.method}'`);
  }
  if (!adapter.supported_currencies.includes(input.currency)) {
    // Échec avant tout appel fournisseur / réservation de la clé.
    throw new GatewayError(`${input.providerKey} does not support currency '${input.currency}'`);
  }
  if (!(await adapter.supports(input.clinicId))) {
    throw new GatewayError(`${input.providerKey} is not configured for this clinic`);
  }

  if (input.allocations.length === 0) {
    throw new GatewayError('At least one allocation required');
  }
  const allocatedTotal = sumDecimals(input.allocations.map((a) => a.amount));
  if (!allocatedTotal.equals(input.amount)) {
    throw new GatewayError(
      `Allocations sum ${allocatedTotal} does not match amount ${input.amount}`,
    );
  }

  const patient = await prisma.patients.findFirst({
    where: { id: input.patientId, clinic_id: input.clinicId },
  });
  if (!patient) {
    throw new GatewayError('Patient not found');
  }

  const requestId = uuidv4();
  const createdAt = now();
  await prisma.$executeRaw(
    Prisma.sql`INSERT INTO payment_requests (
        id, clinic_id, patient_id, provider_key, requested_amount, currency,
        requested_method, state, allocation_input, context, idempotency_key,
        created_by, created_at, updated_at)
      VALUES (
        ${requestId}::uuid, ${input.clinicId}::uuid, ${input.patientId}::uuid,
        ${input.providerKey}, ${input.amount.toString()}::numeric, ${input.currency},
        ${input.method}, 'pending',
        ${JSON.stringify(
          input.allocations.map((a) => ({
            target_type: a.target_type,
            target_id: a.target_id,
            amount: a.amount.toFixed(),
          })),
        )}::jsonb,
        ${JSON.stringify(input.context ?? {})}::jsonb, ${idempotencyKey},
        ${input.createdBy}::uuid, ${createdAt}, ${createdAt})`,
  );

  const customer: GatewayCustomerInfo = {
    name: `${patient.first_name} ${patient.last_name}`.trim() || null,
    email: patient.email,
    phone: patient.phone,
  };

  const request = (await findRequestById(prisma, input.clinicId, requestId))!;

  let checkout;
  try {
    checkout = await adapter.initiate_payment(asPaymentRequestLike(request), customer);
  } catch (error) {
    // Ligne « failed » persistée (traçabilité du panneau de collecte) :
    // le routeur transforme l'erreur en 4xx, la ligne doit survivre.
    await updateRequest({
      id: requestId,
      state: 'failed',
      failed_at: now(),
      error_message: String((error as Error).message ?? error).slice(0, 500),
    });
    throw new GatewayError(
      `Could not start payment with ${input.providerKey}: ${(error as Error).message ?? error}`,
    );
  }

  validatePaymentRequestTransition(request.state, 'awaiting_customer_action');
  await updateRequest({
    id: requestId,
    provider_reference: checkout.provider_reference,
    expires_at: checkout.expires_at,
    checkout_payload_snapshot: {
      redirect_url: checkout.redirect_url,
      checkout_payload: checkout.checkout_payload as Prisma.InputJsonValue | null,
      qr_image_url: checkout.qr_image_url,
      qr_payload: checkout.qr_payload,
    } as Prisma.InputJsonValue,
    raw_status_snapshot: {
      provider_status: checkout.raw_provider_status,
    } as Prisma.InputJsonValue,
    state: 'awaiting_customer_action',
  });
  return (await findRequestById(prisma, input.clinicId, requestId))!;
}

/**
 * Crée atomiquement le `payments.Payment` et marque la requête
 * `succeeded`. Idempotent : une requête déjà terminale est un no-op (une
 * confirmation tardive est tracée dans `raw_status_snapshot`).
 */
export async function confirmPaymentRequest(
  request: PaymentRequestWithRefunds,
  confirmation: GatewayConfirmation,
  recordedBy?: string | null,
): Promise<PaymentRequestWithRefunds> {
  if (TERMINAL_REQUEST_STATES.has(request.state as PaymentRequestState)) {
    if (request.state !== 'succeeded') {
      const snapshot = rawSnapshot(request.raw_status_snapshot) ?? {};
      await updateRequest({
        id: request.id,
        raw_status_snapshot: {
          ...snapshot,
          late_confirmation_after_terminal_state: request.state,
          late_confirmation_provider_payment_reference: confirmation.provider_payment_reference,
        },
      });
    }
    return request;
  }

  if (
    request.provider_payment_reference !== null &&
    request.provider_payment_reference !== confirmation.provider_payment_reference
  ) {
    throw new GatewayError(
      "Confirmation payment reference does not match the request's own reference",
    );
  }
  if (!confirmation.amount.equals(columnDecimal(request.requested_amount))) {
    // Ne jamais enregistrer un montant différent de celui sur lequel les
    // allocations ont été calculées (invariant de somme du workflow).
    throw new GatewayError(
      `Confirmed amount ${confirmation.amount} does not match ` +
        `requested amount ${request.requested_amount}`,
    );
  }
  if (confirmation.currency !== request.currency) {
    // record_payment ne connaît que request.currency : un écart silencieux
    // comptabiliserait le paiement dans la mauvaise devise.
    throw new GatewayError(
      `Confirmed currency '${confirmation.currency}' does not match ` +
        `requested currency '${request.currency}'`,
    );
  }

  validatePaymentRequestTransition(request.state, 'succeeded');

  // Comptabilisation à la date calendaire de la clinique, pas la date UTC
  // de capture (une capture à 00:15 IST reste la veille en UTC).
  const capturedAt =
    confirmation.captured_at instanceof Date ? confirmation.captured_at : new Date(confirmation.captured_at);
  const clinic = await prisma.clinics.findUnique({
    where: { id: request.clinic_id },
    select: { timezone: true },
  });
  const paymentDate = toClinicDateString(capturedAt, clinic?.timezone ?? 'UTC')!;

  const allocationInput = (request.allocation_input as unknown[]) ?? [];
  const allocations: AllocationInput[] = allocationInput.map((raw) => {
    const spec = raw as { target_type: 'budget' | 'on_account'; target_id?: string | null; amount: unknown };
    return {
      target_type: spec.target_type,
      target_id: spec.target_id ?? null,
      amount: columnDecimal(spec.amount),
    };
  });

  let payment;
  try {
    payment = await recordPayment({
      clinicId: request.clinic_id,
      currency: request.currency,
      patientId: request.patient_id,
      amount: columnDecimal(request.requested_amount),
      method: confirmation.confirmed_method,
      paymentDate,
      recordedBy: recordedBy || request.created_by,
      allocations,
      reference: `${request.provider_key}:${confirmation.provider_payment_reference}`.slice(0, 100),
      notes: null,
      context: request.context as Record<string, unknown> | null,
    });
  } catch (error) {
    if (error instanceof PaymentWorkflowError) throw new GatewayError(error.message);
    throw error;
  }

  await updateRequest({
    id: request.id,
    payment_id: payment.id,
    provider_payment_reference: confirmation.provider_payment_reference,
    confirmed_at: capturedAt,
    state: 'succeeded',
  });
  return (await findRequestById(prisma, request.clinic_id, request.id))!;
}

export async function failPaymentRequest(
  request: PaymentRequestWithRefunds,
  errorCode: string | null = null,
  errorMessage: string | null = null,
): Promise<PaymentRequestWithRefunds> {
  if (TERMINAL_REQUEST_STATES.has(request.state as PaymentRequestState)) return request;
  validatePaymentRequestTransition(request.state, 'failed');
  await updateRequest({
    id: request.id,
    state: 'failed',
    failed_at: now(),
    error_code: errorCode,
    error_message: errorMessage,
  });
  return (await findRequestById(prisma, request.clinic_id, request.id))!;
}

export async function expirePaymentRequest(
  request: PaymentRequestWithRefunds,
): Promise<PaymentRequestWithRefunds> {
  if (TERMINAL_REQUEST_STATES.has(request.state as PaymentRequestState)) return request;
  validatePaymentRequestTransition(request.state, 'expired');
  await updateRequest({ id: request.id, state: 'expired' });
  return (await findRequestById(prisma, request.clinic_id, request.id))!;
}

export async function cancelPaymentRequest(
  request: PaymentRequestWithRefunds,
): Promise<PaymentRequestWithRefunds> {
  if (TERMINAL_REQUEST_STATES.has(request.state as PaymentRequestState)) return request;
  validatePaymentRequestTransition(request.state, 'cancelled');
  await updateRequest({ id: request.id, state: 'cancelled', cancelled_at: now() });
  return (await findRequestById(prisma, request.clinic_id, request.id))!;
}

// ---------------------------------------------------------------------------
// GatewayRefundService
// ---------------------------------------------------------------------------

export async function getGatewayRefund(
  clinicId: string,
  refundRequestId: string,
): Promise<GatewayRefundRequestRow | null> {
  const rows = await prisma.$queryRaw<GatewayRefundRow[]>(
    Prisma.sql`SELECT ${REFUND_COLUMNS} FROM gateway_refund_requests
               WHERE id = ${refundRequestId}::uuid AND clinic_id = ${clinicId}::uuid
               LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function listGatewayRefundsForPayment(
  clinicId: string,
  paymentId: string,
): Promise<GatewayRefundRequestRow[]> {
  return prisma.$queryRaw<GatewayRefundRow[]>(
    Prisma.sql`SELECT ${REFUND_COLUMNS} FROM gateway_refund_requests
               WHERE clinic_id = ${clinicId}::uuid AND payment_id = ${paymentId}::uuid
               ORDER BY created_at DESC`,
  );
}

export interface RequestRefundInput {
  clinicId: string;
  payment: { id: string; amount: Prisma.Decimal; method: string };
  paymentRequest: PaymentRequestWithRefunds;
  amount: Prisma.Decimal;
  reasonCode: string;
  reasonNote: string | null;
  requestedBy: string;
  idempotencyKey: string | null;
}

/**
 * Crée un `GatewayRefundRequest` et demande le remboursement au
 * fournisseur. Le `payments.Refund` core n'est créé que par `complete`.
 */
export async function requestGatewayRefund(
  input: RequestRefundInput,
): Promise<GatewayRefundRequestRow> {
  if (input.amount.lessThanOrEqualTo(0)) {
    throw new GatewayError('Refund amount must be > 0');
  }

  const idempotencyKey = input.idempotencyKey || newIdempotencyKey();
  const existing = await prisma.$queryRaw<GatewayRefundRow[]>(
    Prisma.sql`SELECT ${REFUND_COLUMNS} FROM gateway_refund_requests
               WHERE clinic_id = ${input.clinicId}::uuid AND idempotency_key = ${idempotencyKey}
               LIMIT 1`,
  );
  if (existing[0]) return existing[0];

  const refundable = await refundableAmount(input.clinicId, input.payment);
  if (input.amount.greaterThan(refundable)) {
    throw new GatewayError(
      `Refund ${input.amount} exceeds remaining refundable amount ${refundable} ` +
        `for payment ${input.payment.id}`,
    );
  }

  const adapter = adapterFor(input.paymentRequest.provider_key);
  if (!adapter) {
    throw new GatewayError(
      `Unknown or inactive payment gateway provider '${input.paymentRequest.provider_key}'`,
    );
  }

  if (!input.paymentRequest.provider_payment_reference) {
    throw new GatewayError('Payment request has no confirmed provider payment reference');
  }

  const refundRequestId = uuidv4();
  const createdAt = now();
  let created = (
    await prisma.$queryRaw<GatewayRefundRow[]>(
      Prisma.sql`INSERT INTO gateway_refund_requests (
          id, clinic_id, payment_id, payment_request_id, provider_key,
          provider_payment_reference, requested_amount, reason_code,
          reason_note, state, idempotency_key, requested_by, created_at, updated_at)
        VALUES (
          ${refundRequestId}::uuid, ${input.clinicId}::uuid, ${input.payment.id}::uuid,
          ${input.paymentRequest.id}::uuid, ${input.paymentRequest.provider_key},
          ${input.paymentRequest.provider_payment_reference},
          ${input.amount.toString()}::numeric, ${input.reasonCode}, ${input.reasonNote},
          'requested', ${idempotencyKey}, ${input.requestedBy}::uuid,
          ${createdAt}, ${createdAt})
        RETURNING ${REFUND_COLUMNS}`,
    )
  )[0]!;

  let result;
  try {
    result = await adapter.initiate_refund(asGatewayRefundLike(created));
  } catch (error) {
    await updateRefundRequest(refundRequestId, {
      state: 'failed',
      failed_at: now(),
      error_message: String((error as Error).message ?? error).slice(0, 500),
    });
    throw new GatewayError(
      `Could not start refund with ${input.paymentRequest.provider_key}: ${(error as Error).message ?? error}`,
    );
  }

  created = await updateRefundRequest(refundRequestId, {
    provider_refund_reference: result.provider_refund_reference,
  });

  if (result.state === 'completed') {
    // Certains fournisseurs résolvent synchronement — le Refund core est
    // toutefois créé uniquement dans `complete`, un seul chemin d'écriture.
    return completeGatewayRefund(created);
  }
  if (result.state === 'failed') {
    return updateRefundRequest(refundRequestId, {
      state: 'failed',
      failed_at: now(),
      error_code: result.error_code,
      error_message: result.error_message,
    });
  }
  validateRefundTransition(created.state, 'processing');
  return updateRefundRequest(refundRequestId, { state: 'processing' });
}

/**
 * Crée atomiquement le `payments.Refund` core et marque la demande
 * `completed`. Idempotent : déjà `completed` → no-op.
 */
export async function completeGatewayRefund(
  refundRequest: GatewayRefundRequestRow,
  completedAt: Date | null = null,
): Promise<GatewayRefundRequestRow> {
  if (refundRequest.state === 'completed') return refundRequest;

  validateRefundTransition(refundRequest.state, 'completed');

  const payment = await prisma.payments.findFirst({
    where: { id: refundRequest.payment_id, clinic_id: refundRequest.clinic_id },
  });
  if (!payment) {
    throw new GatewayError('Original payment not found');
  }

  let refund;
  try {
    refund = await refundPayment({
      clinicId: refundRequest.clinic_id,
      payment: { id: payment.id, amount: payment.amount },
      amount: columnDecimal(refundRequest.requested_amount),
      method: payment.method,
      reasonCode: refundRequest.reason_code,
      reasonNote: refundRequest.reason_note,
      refundedBy: refundRequest.requested_by,
    });
  } catch (error) {
    if (!(error instanceof PaymentWorkflowError)) throw error;
    // Le plafond core est le dernier rempart (course acceptée entre deux
    // tentatives concurrentes) : on le remonte en demande échouée.
    await updateRefundRequest(refundRequest.id, {
      state: 'failed',
      failed_at: now(),
      error_message: error.message.slice(0, 500),
    });
    throw new GatewayError(error.message);
  }

  return updateRefundRequest(refundRequest.id, {
    refund_id: refund.id,
    state: 'completed',
    completed_at: completedAt ?? now(),
  });
}

/** Vérifie qu'un état est bien un état terminal de remboursement. */
export function isTerminalRefundState(state: string): boolean {
  return TERMINAL_REFUND_STATES.has(state as GatewayRefundState);
}
