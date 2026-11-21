/**
 * Module `payments` — lecture (list/get, ledger, rapports, agrégats
 * cross-module) et workflows transactionnels (create/reallocate/refund).
 *
 * Port de `backend/app/modules/payments/{service,workflow}.py`.
 *
 * Frontière « off-books » préservée à l'identique : tout ce qui est
 * calculé ici ne lit que l'axe encaissement (`payments`, `refunds`,
 * `payment_allocations`, `patient_earned_entries`, `budgets.total`) et
 * n'est **jamais** comparé aux totaux facturés (`invoices`). Les seules
 * lectures « hors module » sont `budgets` (légal : `budget ∈
 * payments.depends`) et des snapshots de libellé (`treatments`,
 * `treatment_catalog_items`, `users`) pour la timeline.
 */
import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import {
  agingBucketLabel,
  AllocationInput,
  budgetPaymentStatus,
  budgetPending,
  bucketStart,
  catalogName as catalogNameOf,
  clampNonNegative,
  columnDecimal,
  decimalToString,
  PaymentResponseDto,
  pendingCoverage,
  ratio,
  RefundResponseDto,
  sumDecimals,
  utcDateOnly,
} from './schemas';

const Decimal = Prisma.Decimal;

/** `PaymentWorkflowError` : précondition métier (400 côté routeur). */
export class PaymentWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentWorkflowError';
  }
}

const ZERO = new Decimal(0);

function uuidv4(): string {
  return crypto.randomUUID();
}

function nowMs(): Date {
  return new Date();
}

// ---------------------------------------------------------------------------
// Includes Prisma
// ---------------------------------------------------------------------------

const paymentInclude = {
  payment_allocations: { orderBy: { created_at: 'asc' } },
  refunds: { orderBy: { refunded_at: 'desc' } },
  users: { select: { id: true, first_name: true, last_name: true } },
  patients: { select: { id: true, first_name: true, last_name: true } },
} satisfies Prisma.paymentsInclude;

export type PaymentWithRefs = Prisma.paymentsGetPayload<{ include: typeof paymentInclude }>;

/** `datetime.combine(payment_date, min.time(), tzinfo=UTC)` → `YYYY-MM-DD`. */
export function paymentDateString(paymentDate: Date): string {
  return paymentDate.toISOString().slice(0, 10);
}

export function toAllocationDto(
  alloc: PaymentWithRefs['payment_allocations'][number],
  paymentMethod: string | null,
): PaymentResponseDto['allocations'][number] {
  return {
    id: alloc.id,
    target_type: alloc.target_type,
    target_id: alloc.target_type === 'budget' ? alloc.budget_id : null,
    amount: columnDecimal(alloc.amount).toNumber(),
    created_at: alloc.created_at.toISOString(),
    created_by: alloc.created_by,
    method: paymentMethod,
  };
}

/** `PaymentResponse.from_model` — montants décimaux sérialisés comme Pydantic. */
export function toPaymentDto(payment: PaymentWithRefs): PaymentResponseDto {
  const amount = columnDecimal(payment.amount);
  const refunded = sumDecimals((payment.refunds ?? []).map((r) => columnDecimal(r.amount)));
  return {
    id: payment.id,
    clinic_id: payment.clinic_id,
    patient_id: payment.patient_id,
    amount: amount.toNumber(),
    currency: payment.currency,
    method: payment.method,
    payment_date: paymentDateString(payment.payment_date),
    reference: payment.reference,
    notes: payment.notes,
    recorded_by: payment.recorded_by,
    created_at: payment.created_at.toISOString(),
    updated_at: payment.updated_at.toISOString(),
    allocations: (payment.payment_allocations ?? []).map((a) => toAllocationDto(a, payment.method)),
    refunded_total: refunded.toNumber(),
    net_amount: amount.minus(refunded).toNumber(),
    recorder: payment.users
      ? {
          id: payment.users.id,
          first_name: payment.users.first_name,
          last_name: payment.users.last_name,
        }
      : null,
    patient: payment.patients
      ? {
          id: payment.patients.id,
          first_name: payment.patients.first_name,
          last_name: payment.patients.last_name,
        }
      : null,
  };
}

export interface RefundRow {
  id: string;
  payment_id: string;
  amount: Prisma.Decimal;
  method: string;
  reason_code: string;
  reason_note: string | null;
  refunded_at: Date;
  refunded_by: string;
  users?: { id: string; first_name: string; last_name: string } | null;
}

export function toRefundDto(refund: RefundRow): RefundResponseDto {
  return {
    id: refund.id,
    payment_id: refund.payment_id,
    amount: columnDecimal(refund.amount).toNumber(),
    method: refund.method,
    reason_code: refund.reason_code,
    reason_note: refund.reason_note,
    refunded_at: refund.refunded_at.toISOString(),
    refunded_by: refund.refunded_by,
    refunder: refund.users
      ? {
          id: refund.users.id,
          first_name: refund.users.first_name,
          last_name: refund.users.last_name,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// PaymentService (list / get)
// ---------------------------------------------------------------------------

export interface PaymentListFilters {
  date_from: string | null;
  date_to: string | null;
  method: string | null;
  patient_id: string | null;
  has_refunds: boolean | null;
  has_unallocated: boolean | null;
  amount_min: Prisma.Decimal | null;
  amount_max: Prisma.Decimal | null;
  sort?: { field: 'amount' | 'created_at' | 'payment_date'; direction: 'asc' | 'desc' };
}

function listWhere(clinicId: string, filters: PaymentListFilters): Prisma.paymentsWhereInput[] {
  const where: Prisma.paymentsWhereInput[] = [{ clinic_id: clinicId }];
  if (filters.date_from !== null) {
    where.push({ payment_date: { gte: new Date(`${filters.date_from}T00:00:00.000Z`) } });
  }
  if (filters.date_to !== null) {
    where.push({ payment_date: { lte: new Date(`${filters.date_to}T00:00:00.000Z`) } });
  }
  if (filters.method) where.push({ method: filters.method });
  if (filters.patient_id) where.push({ patient_id: filters.patient_id });
  if (filters.amount_min !== null) where.push({ amount: { gte: filters.amount_min } });
  if (filters.amount_max !== null) where.push({ amount: { lte: filters.amount_max } });
  if (filters.has_refunds !== null) {
    where.push(filters.has_refunds ? { refunds: { some: {} } } : { refunds: { none: {} } });
  }
  if (filters.has_unallocated !== null) {
    // « non affecté » = au moins une allocation `on_account` (réaffectable).
    const onAccount = { payment_allocations: { some: { target_type: 'on_account' } } };
    const noneOnAccount = { payment_allocations: { none: { target_type: 'on_account' } } };
    where.push(filters.has_unallocated ? onAccount : noneOnAccount);
  }
  return where;
}

export async function listPayments(
  clinicId: string,
  filters: PaymentListFilters,
  page: number,
  pageSize: number,
): Promise<{ rows: PaymentResponseDto[]; total: number }> {
  const AND = listWhere(clinicId, filters);
  const sort = filters.sort ?? { field: 'payment_date' as const, direction: 'desc' as const };
  const orderBy: Prisma.paymentsOrderByWithRelationInput[] = [
    { [sort.field]: sort.direction },
    { created_at: 'desc' },
    { id: 'asc' },
  ];

  const [total, rows] = await Promise.all([
    prisma.payments.count({ where: { AND } }),
    prisma.payments.findMany({
      where: { AND },
      include: paymentInclude,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return { rows: rows.map(toPaymentDto), total };
}

export async function getPayment(clinicId: string, paymentId: string): Promise<PaymentWithRefs | null> {
  return prisma.payments.findFirst({
    where: { id: paymentId, clinic_id: clinicId },
    include: paymentInclude,
  });
}

export async function getPaymentWithRefunds(paymentId: string): Promise<PaymentWithRefs | null> {
  return prisma.payments.findUnique({ where: { id: paymentId }, include: paymentInclude });
}

// ---------------------------------------------------------------------------
// Validation des allocations (workflow)
// ---------------------------------------------------------------------------

async function validateAllocationsForClinic(
  clinicId: string,
  allocations: AllocationInput[],
): Promise<void> {
  const budgetIds = [
    ...new Set(
      allocations
        .filter((a) => a.target_type === 'budget' && a.target_id !== null)
        .map((a) => a.target_id as string),
    ),
  ];
  if (budgetIds.length === 0) return;

  const rows = await prisma.budgets.findMany({
    where: { id: { in: budgetIds } },
    select: { id: true, clinic_id: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const budgetId of budgetIds) {
    const row = byId.get(budgetId);
    if (!row) throw new PaymentWorkflowError(`Budget ${budgetId} not found`);
    if (row.clinic_id !== clinicId) {
      throw new PaymentWorkflowError(`Budget ${budgetId} belongs to another clinic`);
    }
  }
}

function allocationsSum(allocations: AllocationInput[]): Prisma.Decimal {
  return sumDecimals(allocations.map((a) => a.amount));
}

// ---------------------------------------------------------------------------
// Workflows (workflow.py)
// ---------------------------------------------------------------------------

export interface RecordPaymentInput {
  clinicId: string;
  currency: string;
  patientId: string;
  amount: Prisma.Decimal;
  method: string;
  /** Date calendaire de la clinique `YYYY-MM-DD`. */
  paymentDate: string;
  recordedBy: string;
  allocations: AllocationInput[];
  reference?: string | null;
  notes?: string | null;
  /** Contexte opaque (gateway) : jamais interprété, seulement tracé. */
  context?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
}

/**
 * Crée un `Payment` et ses allocations dans une seule transaction.
 *
 * `idempotencyKey` (#365) : même clé + même clinique ⇒ le paiement
 * existant est renvoyé, rien n'est écrit (un retry ne peut pas doubler
 * l'encaissement). Deux appels concurrents sont arbitrés par l'index
 * unique partiel `uq_payments_clinic_idempotency` (P2002 → on adopte la
 * ligne gagnante).
 */
export async function recordPayment(input: RecordPaymentInput): Promise<PaymentWithRefs> {
  const { clinicId, idempotencyKey } = input;

  if (idempotencyKey) {
    const existing = await prisma.payments.findFirst({
      where: { clinic_id: clinicId, idempotency_key: idempotencyKey },
      include: paymentInclude,
    });
    if (existing) return existing;
  }

  if (input.allocations.length === 0) {
    throw new PaymentWorkflowError('At least one allocation required');
  }
  const allocatedTotal = allocationsSum(input.allocations);
  if (!allocatedTotal.equals(input.amount)) {
    throw new PaymentWorkflowError(
      `Allocations sum ${allocatedTotal} does not match payment amount ${input.amount}`,
    );
  }

  await validateAllocationsForClinic(clinicId, input.allocations);

  const paymentId = uuidv4();
  const now = nowMs();

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.payments.create({
        data: {
          id: paymentId,
          clinic_id: clinicId,
          patient_id: input.patientId,
          amount: input.amount,
          currency: input.currency,
          method: input.method,
          payment_date: new Date(`${input.paymentDate}T00:00:00.000Z`),
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          recorded_by: input.recordedBy,
          idempotency_key: idempotencyKey ?? null,
          created_at: now,
          updated_at: now,
          payment_allocations: {
            create: input.allocations.map((spec) => ({
              id: uuidv4(),
              clinic_id: clinicId,
              target_type: spec.target_type,
              budget_id: spec.target_type === 'budget' ? spec.target_id : null,
              amount: spec.amount,
              created_by: input.recordedBy,
              created_at: now,
              updated_at: now,
            })),
          },
          payment_history: {
            create: {
              id: uuidv4(),
              clinic_id: clinicId,
              action: 'created',
              changed_by: input.recordedBy,
              changed_at: now,
              previous_state: Prisma.JsonNull,
              new_state: {
                amount: decimalToString(input.amount),
                method: input.method,
                allocations: input.allocations.map((spec) => ({
                  target_type: spec.target_type,
                  target_id: spec.target_id ?? null,
                  amount: decimalToString(spec.amount),
                })),
              },
            },
          },
        },
      });
      return (await tx.payments.findUnique({
        where: { id: paymentId },
        include: paymentInclude,
      }))!;
    });
  } catch (error) {
    // Course d'idempotence : l'index partiel a arbitré, on adopte le gagnant.
    if (
      idempotencyKey &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const winner = await prisma.payments.findFirst({
        where: { clinic_id: clinicId, idempotency_key: idempotencyKey },
        include: paymentInclude,
      });
      if (winner) return winner;
    }
    throw error;
  }
}

/**
 * Remplace atomiquement les allocations d'un paiement.
 * Les nouvelles doivent sommer à `payment.amount` ; les anciennes lignes
 * sont supprimées puis recréées (un événement d'audit `reallocated`).
 */
export async function reallocatePayment(
  clinicId: string,
  payment: PaymentWithRefs,
  newAllocations: AllocationInput[],
  changedBy: string,
): Promise<PaymentWithRefs> {
  if (newAllocations.length === 0) {
    throw new PaymentWorkflowError('At least one allocation required');
  }
  if (!allocationsSum(newAllocations).equals(columnDecimal(payment.amount))) {
    throw new PaymentWorkflowError('New allocations must sum to payment.amount');
  }

  await validateAllocationsForClinic(clinicId, newAllocations);

  const previousState = (payment.payment_allocations ?? []).map((a) => ({
    id: a.id,
    target_type: a.target_type,
    target_id: a.budget_id ?? null,
    amount: decimalToString(columnDecimal(a.amount)),
  }));
  const now = nowMs();

  await prisma.$transaction(async (tx) => {
    await tx.payment_allocations.deleteMany({
      where: { payment_id: payment.id, clinic_id: clinicId },
    });
    await tx.payment_allocations.createMany({
      data: newAllocations.map((spec) => ({
        id: uuidv4(),
        clinic_id: clinicId,
        payment_id: payment.id,
        target_type: spec.target_type,
        budget_id: spec.target_type === 'budget' ? spec.target_id : null,
        amount: spec.amount,
        created_by: changedBy,
        created_at: now,
        updated_at: now,
      })),
    });
    await tx.payment_history.create({
      data: {
        id: uuidv4(),
        clinic_id: clinicId,
        payment_id: payment.id,
        action: 'reallocated',
        changed_by: changedBy,
        changed_at: now,
        previous_state: { allocations: previousState },
        new_state: {
          allocations: newAllocations.map((spec) => ({
            target_type: spec.target_type,
            target_id: spec.target_id ?? null,
            amount: decimalToString(spec.amount),
          })),
        },
      },
    });
    await tx.payments.update({
      where: { id: payment.id },
      data: { updated_at: now },
    });
  });

  return (await getPaymentWithRefunds(payment.id))!;
}

export interface RefundWorkflowInput {
  clinicId: string;
  payment: { id: string; amount: Prisma.Decimal };
  amount: Prisma.Decimal;
  method: string;
  reasonCode: string;
  reasonNote: string | null;
  refundedBy: string;
}

/**
 * Crée un `Refund` en respectant le plafond `Σ refunds ≤ payment.amount`.
 * La ligne `payments` est verrouillée (`FOR UPDATE`) pour sérialiser deux
 * remboursements concurrents (audit S3/C1, #97).
 */
export async function refundPayment(input: RefundWorkflowInput): Promise<RefundResponseDto> {
  if (input.amount.lessThanOrEqualTo(0)) {
    throw new PaymentWorkflowError('Refund amount must be > 0');
  }
  const paymentAmount = columnDecimal(input.payment.amount);
  const refundId = uuidv4();
  const now = nowMs();

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${input.payment.id}::uuid FOR UPDATE`;

    const aggregate = await tx.refunds.aggregate({
      where: { payment_id: input.payment.id },
      _sum: { amount: true },
    });
    const alreadyRefunded = columnDecimal(aggregate._sum.amount ?? 0);
    if (alreadyRefunded.plus(input.amount).greaterThan(paymentAmount)) {
      throw new PaymentWorkflowError(
        `Refund ${input.amount} exceeds remaining cap ` +
          `${paymentAmount.minus(alreadyRefunded)} for payment ${input.payment.id}`,
      );
    }

    const refund = await tx.refunds.create({
      data: {
        id: refundId,
        clinic_id: input.clinicId,
        payment_id: input.payment.id,
        amount: input.amount,
        method: input.method,
        reason_code: input.reasonCode,
        reason_note: input.reasonNote,
        refunded_at: now,
        refunded_by: input.refundedBy,
        created_at: now,
        updated_at: now,
      },
      include: { users: { select: { id: true, first_name: true, last_name: true } } },
    });

    await tx.payment_history.create({
      data: {
        id: uuidv4(),
        clinic_id: input.clinicId,
        payment_id: input.payment.id,
        action: 'refunded',
        changed_by: input.refundedBy,
        changed_at: now,
        previous_state: { refunded_total: decimalToString(alreadyRefunded) },
        new_state: {
          refunded_total: decimalToString(alreadyRefunded.plus(input.amount)),
          refund_amount: decimalToString(input.amount),
          reason_code: input.reasonCode,
        },
      },
    });

    await tx.payments.update({ where: { id: input.payment.id }, data: { updated_at: now } });

    return toRefundDto(refund);
  });
}

// ---------------------------------------------------------------------------
// PaymentReadService
// ---------------------------------------------------------------------------

export async function getRefundsForPayment(payment: PaymentWithRefs): Promise<RefundResponseDto[]> {
  const rows = await prisma.refunds.findMany({
    where: { payment_id: payment.id },
    include: { users: { select: { id: true, first_name: true, last_name: true } } },
    orderBy: { refunded_at: 'desc' },
  });
  return rows.map(toRefundDto);
}

export async function getAllocationsForBudget(
  clinicId: string,
  budgetId: string,
): Promise<PaymentResponseDto['allocations']> {
  const rows = await prisma.payment_allocations.findMany({
    where: { clinic_id: clinicId, target_type: 'budget', budget_id: budgetId },
    include: { payments: { select: { method: true } } },
    orderBy: { created_at: 'asc' },
  });
  return rows.map((row) => toAllocationDto({ ...row }, row.payments?.method ?? null));
}

/** Σ allocations `budget` d'un budget donné (axe encaissement). */
export async function totalCollectedForBudget(clinicId: string, budgetId: string): Promise<Prisma.Decimal> {
  const aggregate = await prisma.payment_allocations.aggregate({
    where: { clinic_id: clinicId, target_type: 'budget', budget_id: budgetId },
    _sum: { amount: true },
  });
  return columnDecimal(aggregate._sum.amount ?? 0);
}

export interface BudgetSummaryByIds {
  collected: number;
  pending: number;
  payment_status: 'unpaid' | 'partial' | 'paid';
}

/**
 * Bulk `collected / pending / payment_status` par budget.
 * `collected = Σ allocation.amount` ; `pending = max(0, total − collected)`.
 * Ne touche jamais aux totaux facturés (off-books safe).
 */
export async function summariesByBudgets(
  clinicId: string,
  budgetIds: string[],
): Promise<Record<string, BudgetSummaryByIds>> {
  if (budgetIds.length === 0) return {};

  const [allocRows, budgetRows] = await Promise.all([
    prisma.payment_allocations.groupBy({
      by: ['budget_id'],
      where: { clinic_id: clinicId, target_type: 'budget', budget_id: { in: budgetIds } },
      _sum: { amount: true },
    }),
    prisma.budgets.findMany({
      where: { clinic_id: clinicId, id: { in: budgetIds }, deleted_at: null },
      select: { id: true, total: true },
    }),
  ]);

  const collectedPerBudget = new Map<string, Prisma.Decimal>();
  for (const row of allocRows) {
    if (row.budget_id) collectedPerBudget.set(row.budget_id, columnDecimal(row._sum.amount ?? 0));
  }

  const out: Record<string, BudgetSummaryByIds> = {};
  for (const budget of budgetRows) {
    const total = columnDecimal(budget.total ?? 0);
    const collected = collectedPerBudget.get(budget.id) ?? ZERO;
    out[budget.id] = {
      collected: collected.toNumber(),
      pending: budgetPending(total, collected).toNumber(),
      payment_status: budgetPaymentStatus(collected, total),
    };
  }
  return out;
}

interface PatientAggregates {
  paid: Map<string, Prisma.Decimal>;
  refunded: Map<string, Prisma.Decimal>;
  earned: Map<string, Prisma.Decimal>;
  onAccount: Map<string, Prisma.Decimal>;
}

async function patientAggregates(
  clinicId: string,
  patientIds: string[] | null,
): Promise<PatientAggregates> {
  const scope = patientIds
    ? { clinic_id: clinicId, patient_id: { in: patientIds } }
    : { clinic_id: clinicId };

  const [paidRows, refundRows, earnedRows, onAccountRows] = await Promise.all([
    prisma.payments.groupBy({
      by: ['patient_id'],
      where: scope,
      _sum: { amount: true },
    }),
    prisma.refunds.findMany({
      where: { clinic_id: clinicId, payments: scope },
      select: { amount: true, payments: { select: { patient_id: true } } },
    }),
    prisma.patient_earned_entries.groupBy({
      by: ['patient_id'],
      where: scope,
      _sum: { amount: true },
    }),
    prisma.payment_allocations.findMany({
      where: { clinic_id: clinicId, target_type: 'on_account', payments: scope },
      select: { amount: true, payments: { select: { patient_id: true } } },
    }),
  ]);

  const paid = new Map<string, Prisma.Decimal>();
  for (const row of paidRows) paid.set(row.patient_id, columnDecimal(row._sum.amount ?? 0));

  const earned = new Map<string, Prisma.Decimal>();
  for (const row of earnedRows) earned.set(row.patient_id, columnDecimal(row._sum.amount ?? 0));

  const refunded = new Map<string, Prisma.Decimal>();
  for (const row of refundRows) {
    const pid = row.payments.patient_id;
    refunded.set(pid, (refunded.get(pid) ?? ZERO).plus(columnDecimal(row.amount)));
  }

  const onAccount = new Map<string, Prisma.Decimal>();
  for (const row of onAccountRows) {
    const pid = row.payments.patient_id;
    onAccount.set(pid, (onAccount.get(pid) ?? ZERO).plus(columnDecimal(row.amount)));
  }

  return { paid, refunded, earned, onAccount };
}

export interface PatientSummaryByIds {
  total_paid: number;
  debt: number;
  on_account_balance: number;
}

/** Bulk `total_paid / debt / on_account_balance` par patient (`debt = max(0, earned − net_paid)`). */
export async function summariesByPatients(
  clinicId: string,
  patientIds: string[],
): Promise<Record<string, PatientSummaryByIds>> {
  if (patientIds.length === 0) return {};
  const agg = await patientAggregates(clinicId, patientIds);
  const out: Record<string, PatientSummaryByIds> = {};
  for (const pid of patientIds) {
    const netPaid = (agg.paid.get(pid) ?? ZERO).minus(agg.refunded.get(pid) ?? ZERO);
    const earned = agg.earned.get(pid) ?? ZERO;
    out[pid] = {
      total_paid: netPaid.toNumber(),
      debt: clampNonNegative(earned.minus(netPaid)).toNumber(),
      on_account_balance: (agg.onAccount.get(pid) ?? ZERO).toNumber(),
    };
  }
  return out;
}

/** Cap des endpoints de filtre cross-module (contrat `cross-module-summaries.md`). */
export const FILTER_IDS_CAP = 1000;

/**
 * Ids de budgets dont le statut d'encaissement est dans `statuses`
 * (tri `budget.created_at DESC`, cap +1 pour `truncated`).
 */
export async function budgetIdsByPaymentStatus(
  clinicId: string,
  statuses: string[],
  filters: { patient_id: string | null; assigned_professional_id: string | null },
  cap: number = FILTER_IDS_CAP,
): Promise<{ ids: string[]; truncated: boolean }> {
  if (statuses.length === 0) return { ids: [], truncated: false };

  const budgetWhere: Prisma.budgetsWhereInput = { clinic_id: clinicId, deleted_at: null };
  if (filters.patient_id !== null) budgetWhere.patient_id = filters.patient_id;
  if (filters.assigned_professional_id !== null) {
    budgetWhere.assigned_professional_id = filters.assigned_professional_id;
  }

  const budgets = await prisma.budgets.findMany({
    where: budgetWhere,
    select: { id: true, total: true },
    orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
  });

  const budgetIds = budgets.map((b) => b.id);
  const collected = new Map<string, Prisma.Decimal>();
  if (budgetIds.length > 0) {
    const rows = await prisma.payment_allocations.groupBy({
      by: ['budget_id'],
      where: { clinic_id: clinicId, target_type: 'budget', budget_id: { in: budgetIds } },
      _sum: { amount: true },
    });
    for (const row of rows) {
      if (row.budget_id) collected.set(row.budget_id, columnDecimal(row._sum.amount ?? 0));
    }
  }

  const wanted = new Set(statuses);
  const ids: string[] = [];
  let truncated = false;
  for (const budget of budgets) {
    const collectedAmount = collected.get(budget.id) ?? ZERO;
    const status = budgetPaymentStatus(collectedAmount, columnDecimal(budget.total ?? 0));
    if (!wanted.has(status)) continue;
    if (ids.length >= cap) {
      truncated = true;
      break;
    }
    ids.push(budget.id);
  }
  return { ids, truncated };
}

/** Ids de patients dont `earned − net_paid >= minDebt` (cap +1 pour `truncated`). */
export async function patientIdsWithDebt(
  clinicId: string,
  minDebt: Prisma.Decimal,
  cap: number = FILTER_IDS_CAP,
): Promise<{ ids: string[]; truncated: boolean }> {
  const agg = await patientAggregates(clinicId, null);
  const ids: string[] = [];
  let truncated = false;
  for (const [pid, earned] of agg.earned) {
    const netPaid = (agg.paid.get(pid) ?? ZERO).minus(agg.refunded.get(pid) ?? ZERO);
    const debt = earned.minus(netPaid);
    if (debt.greaterThanOrEqualTo(minDebt)) {
      if (ids.length >= cap) {
        truncated = true;
        break;
      }
      ids.push(pid);
    }
  }
  return { ids, truncated };
}

// ---------------------------------------------------------------------------
// LedgerService
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  entry_type: 'payment' | 'refund' | 'earned';
  occurred_at: Date;
  amount: Prisma.Decimal;
  reference_id: string;
  description: string | null;
  treatment_id?: string | null;
  treatment_name?: string | null;
  treatment_status?: string | null;
  professional_id?: string | null;
  professional_name?: string | null;
}

export async function getPatientLedger(
  clinicId: string,
  patientId: string,
  currency: string,
) {
  const where = { clinic_id: clinicId, patient_id: patientId };
  const [paidAgg, refundAgg, earnedAgg, onAccountAgg] = await Promise.all([
    prisma.payments.aggregate({ where, _sum: { amount: true } }),
    prisma.refunds.aggregate({ where: { clinic_id: clinicId, payments: where }, _sum: { amount: true } }),
    prisma.patient_earned_entries.aggregate({ where, _sum: { amount: true } }),
    prisma.payment_allocations.aggregate({
      where: { clinic_id: clinicId, target_type: 'on_account', payments: where },
      _sum: { amount: true },
    }),
  ]);

  const totalPaid = columnDecimal(paidAgg._sum.amount ?? 0).minus(
    columnDecimal(refundAgg._sum.amount ?? 0),
  );
  const totalEarned = columnDecimal(earnedAgg._sum.amount ?? 0);
  const timeline = await buildTimeline(clinicId, patientId);

  return {
    patient_id: patientId,
    currency,
    total_paid: totalPaid.toNumber(),
    total_earned: totalEarned.toNumber(),
    patient_credit: clampNonNegative(totalPaid.minus(totalEarned)).toNumber(),
    clinic_receivable: clampNonNegative(totalEarned.minus(totalPaid)).toNumber(),
    on_account_balance: columnDecimal(onAccountAgg._sum.amount ?? 0).toNumber(),
    timeline: timeline.map((entry) => ({
      entry_type: entry.entry_type,
      occurred_at: entry.occurred_at.toISOString(),
      amount: entry.amount.toNumber(),
      reference_id: entry.reference_id,
      description: entry.description,
      treatment_id: entry.treatment_id ?? null,
      treatment_name: entry.treatment_name ?? null,
      treatment_status: entry.treatment_status ?? null,
      professional_id: entry.professional_id ?? null,
      professional_name: entry.professional_name ?? null,
    })),
  };
}

async function buildTimeline(clinicId: string, patientId: string): Promise<LedgerEntry[]> {
  const entries: LedgerEntry[] = [];

  const payments = await prisma.payments.findMany({
    where: { clinic_id: clinicId, patient_id: patientId },
    orderBy: { payment_date: 'asc' },
  });
  for (const payment of payments) {
    entries.push({
      entry_type: 'payment',
      // `datetime.combine(payment_date, min.time(), tzinfo=UTC)`
      occurred_at: new Date(`${paymentDateString(payment.payment_date)}T00:00:00.000Z`),
      amount: columnDecimal(payment.amount),
      reference_id: payment.id,
      description: payment.method,
    });
  }

  const refunds = await prisma.refunds.findMany({
    where: { clinic_id: clinicId, payments: { clinic_id: clinicId, patient_id: patientId } },
  });
  for (const refund of refunds) {
    entries.push({
      entry_type: 'refund',
      occurred_at: refund.refunded_at,
      amount: columnDecimal(refund.amount).negated(),
      reference_id: refund.id,
      description: refund.reason_code,
    });
  }

  // Contexte clinique enrichi (nom catalogue, statut, praticien) — même
  // jointure SQL que le `text()` Python, en lectures Prisma groupées.
  const earned = await prisma.patient_earned_entries.findMany({
    where: { clinic_id: clinicId, patient_id: patientId },
  });
  const treatmentIds = [...new Set(earned.map((e) => e.treatment_id))];
  const catalogIds = [...new Set(earned.map((e) => e.catalog_item_id).filter((v): v is string => !!v))];
  const professionalIds = [
    ...new Set(earned.map((e) => e.professional_id).filter((v): v is string => !!v)),
  ];

  const [treatments, catalogItems, professionals] = await Promise.all([
    treatmentIds.length
      ? prisma.treatments.findMany({
          where: { id: { in: treatmentIds } },
          select: { id: true, status: true },
        })
      : Promise.resolve([]),
    catalogIds.length
      ? prisma.treatment_catalog_items.findMany({
          where: { id: { in: catalogIds } },
          select: { id: true, names: true },
        })
      : Promise.resolve([]),
    professionalIds.length
      ? prisma.users.findMany({
          where: { id: { in: professionalIds } },
          select: { id: true, first_name: true, last_name: true },
        })
      : Promise.resolve([]),
  ]);

  const treatmentStatus = new Map(treatments.map((t) => [t.id, t.status]));
  const catalogNames = new Map(catalogIds.map((id) => [id, null as string | null]));
  for (const item of catalogItems) catalogNames.set(item.id, catalogNameOf(item.names));
  const profNames = new Map(
    professionals.map((u) => [u.id, `${u.first_name} ${u.last_name}`.trim()]),
  );

  for (const row of earned) {
    const treatmentName =
      (row.catalog_item_id ? catalogNames.get(row.catalog_item_id) ?? null : null) ?? null;
    const profName = row.professional_id
      ? profNames.get(row.professional_id) || null
      : null;
    // Chaîne de libellés : nom catalogue → description du snapshot → source_event.
    const displayDescription = treatmentName || row.description || row.source_event;
    entries.push({
      entry_type: 'earned',
      occurred_at: row.performed_at,
      amount: columnDecimal(row.amount),
      reference_id: row.id,
      description: displayDescription,
      treatment_id: row.treatment_id,
      treatment_name: treatmentName,
      treatment_status: treatmentStatus.get(row.treatment_id) ?? null,
      professional_id: row.professional_id,
      professional_name: profName,
    });
  }

  entries.sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
  return entries;
}

export interface PendingChargeDto {
  entry_id: string;
  treatment_id: string;
  session_id: string | null;
  description: string | null;
  amount: string;
  occurred_at: string;
}

/**
 * Entrées gagnées non encore couvertes par les paiements nets
 * (règlement virtuel FIFO). Pas de FK Payment ↔ earned : seul l'ordre
 * chronologique fait l'affectation.
 */
export async function computePendingCharges(
  clinicId: string,
  patientId: string,
): Promise<PendingChargeDto[]> {
  const where = { clinic_id: clinicId, patient_id: patientId };
  const [paidAgg, refundAgg] = await Promise.all([
    prisma.payments.aggregate({ where, _sum: { amount: true } }),
    prisma.refunds.aggregate({ where: { clinic_id: clinicId, payments: where }, _sum: { amount: true } }),
  ]);
  const netPaid = columnDecimal(paidAgg._sum.amount ?? 0).minus(
    columnDecimal(refundAgg._sum.amount ?? 0),
  );

  const earned = await prisma.patient_earned_entries.findMany({
    where,
    orderBy: [{ performed_at: 'asc' }, { id: 'asc' }],
  });

  return pendingCoverage(
    earned.map((row) => ({ row, amount: columnDecimal(row.amount) })),
    netPaid,
  ).map(({ entry, unpaid }) => ({
    entry_id: entry.row.id,
    treatment_id: entry.row.treatment_id,
    session_id: entry.row.source_session_id ?? null,
    description: entry.row.description,
    amount: decimalToString(unpaid),
    occurred_at: entry.row.performed_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// PaymentReportsService
// ---------------------------------------------------------------------------

function dateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `datetime.combine(d, min.time(), UTC)` / `datetime.combine(d, max.time(), UTC)`. */
export function dayStart(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}
export function dayEnd(date: string): Date {
  return new Date(`${date}T23:59:59.999999Z`);
}

async function patientTotals(
  clinicId: string,
): Promise<{ patientCredit: Prisma.Decimal; clinicReceivable: Prisma.Decimal }> {
  const agg = await patientAggregates(clinicId, null);
  let patientCredit = ZERO;
  let clinicReceivable = ZERO;
  const patientIds = new Set<string>([...agg.paid.keys(), ...agg.earned.keys()]);
  for (const pid of patientIds) {
    const netPaid = (agg.paid.get(pid) ?? ZERO).minus(agg.refunded.get(pid) ?? ZERO);
    const netEarned = agg.earned.get(pid) ?? ZERO;
    if (netPaid.greaterThan(netEarned)) patientCredit = patientCredit.plus(netPaid.minus(netEarned));
    else if (netEarned.greaterThan(netPaid)) {
      clinicReceivable = clinicReceivable.plus(netEarned.minus(netPaid));
    }
  }
  return { patientCredit, clinicReceivable };
}

export async function reportsSummary(clinicId: string, currency: string, dateFrom: string, dateTo: string) {
  const [collectedAgg, refundAgg] = await Promise.all([
    prisma.payments.aggregate({
      where: { clinic_id: clinicId, payment_date: { gte: dayStart(dateFrom), lte: dayStart(dateTo) } },
      _sum: { amount: true },
      _count: { id: true },
    }),
    prisma.refunds.aggregate({
      where: { clinic_id: clinicId, refunded_at: { gte: dayStart(dateFrom), lte: dayEnd(dateTo) } },
      _sum: { amount: true },
      _count: { id: true },
    }),
  ]);

  const totalCollected = columnDecimal(collectedAgg._sum.amount ?? 0);
  const paymentCount = collectedAgg._count.id;
  const totalRefunded = columnDecimal(refundAgg._sum.amount ?? 0);
  const refundCount = refundAgg._count.id;

  const { patientCredit, clinicReceivable } = await patientTotals(clinicId);

  return {
    period_start: dateFrom,
    period_end: dateTo,
    currency,
    total_collected: totalCollected.toNumber(),
    total_refunded: totalRefunded.toNumber(),
    net_collected: totalCollected.minus(totalRefunded).toNumber(),
    patient_credit_total: patientCredit.toNumber(),
    clinic_receivable_total: clinicReceivable.toNumber(),
    refund_ratio: ratio(totalRefunded, totalCollected),
    payment_count: paymentCount,
    refund_count: refundCount,
  };
}

export async function reportsByMethod(clinicId: string, dateFrom: string, dateTo: string) {
  const rows = await prisma.payments.groupBy({
    by: ['method'],
    where: { clinic_id: clinicId, payment_date: { gte: dayStart(dateFrom), lte: dayStart(dateTo) } },
    _sum: { amount: true },
    _count: { id: true },
    orderBy: { _sum: { amount: 'desc' } },
  });
  return rows.map((row) => ({
    method: row.method,
    total: columnDecimal(row._sum.amount ?? 0).toNumber(),
    count: row._count.id,
  }));
}

export async function reportsByProfessional(clinicId: string, dateFrom: string, dateTo: string) {
  const rows = await prisma.patient_earned_entries.groupBy({
    by: ['professional_id'],
    where: {
      clinic_id: clinicId,
      performed_at: { gte: dayStart(dateFrom), lte: dayEnd(dateTo) },
    },
    _sum: { amount: true },
    _count: { id: true },
  });

  const profIds = rows.map((r) => r.professional_id).filter((v): v is string => v !== null);
  const names = new Map<string, string>();
  if (profIds.length > 0) {
    const users = await prisma.users.findMany({
      where: { id: { in: profIds } },
      select: { id: true, first_name: true, last_name: true },
    });
    for (const user of users) names.set(user.id, `${user.first_name} ${user.last_name}`.trim());
  }

  return rows.map((row) => ({
    professional_id: row.professional_id,
    professional_name: row.professional_id ? names.get(row.professional_id) ?? null : null,
    total_earned: columnDecimal(row._sum.amount ?? 0).toNumber(),
    count: row._count.id,
  }));
}

/**
 * Créances par ancienneté de l'entrée gagnée impayée la plus ancienne.
 * `today` = date locale de la clinique (comme `clinic_today_for`).
 */
export async function reportsAgingReceivables(clinicId: string, currency: string, today: string) {
  const [paidRows, refundRows, earnedRows] = await Promise.all([
    prisma.payments.groupBy({ by: ['patient_id'], where: { clinic_id: clinicId }, _sum: { amount: true } }),
    prisma.refunds.findMany({
      where: { clinic_id: clinicId },
      select: { amount: true, payments: { select: { patient_id: true } } },
    }),
    prisma.patient_earned_entries.groupBy({
      by: ['patient_id'],
      where: { clinic_id: clinicId },
      _sum: { amount: true },
      _min: { performed_at: true },
    }),
  ]);

  const paid = new Map<string, Prisma.Decimal>();
  for (const row of paidRows) paid.set(row.patient_id, columnDecimal(row._sum.amount ?? 0));
  const refunded = new Map<string, Prisma.Decimal>();
  for (const row of refundRows) {
    const pid = row.payments.patient_id;
    refunded.set(pid, (refunded.get(pid) ?? ZERO).plus(columnDecimal(row.amount)));
  }

  const labels = ['0-30', '31-60', '61-90', '90+'] as const;
  const buckets = new Map<string, { total: Prisma.Decimal; patients: Set<string> }>();
  for (const label of labels) buckets.set(label, { total: ZERO, patients: new Set() });

  const todayUtc = dayStart(today);
  for (const row of earnedRows) {
    const earnedTotal = columnDecimal(row._sum.amount ?? 0);
    const netPaid = (paid.get(row.patient_id) ?? ZERO).minus(refunded.get(row.patient_id) ?? ZERO);
    const receivable = earnedTotal.minus(netPaid);
    if (receivable.lessThanOrEqualTo(0)) continue;

    const oldest = row._min.performed_at ?? null;
    const ageDays = oldest
      ? Math.round((todayUtc.getTime() - utcDateOnly(oldest).getTime()) / 86_400_000)
      : 0;
    const bucket = buckets.get(agingBucketLabel(ageDays))!;
    bucket.total = bucket.total.plus(receivable);
    bucket.patients.add(row.patient_id);
  }

  return {
    currency,
    buckets: labels.map((label) => {
      const bucket = buckets.get(label)!;
      return {
        label,
        total: bucket.total.toNumber(),
        patient_count: bucket.patients.size,
      };
    }),
  };
}

export async function reportsRefunds(clinicId: string, currency: string, dateFrom: string, dateTo: string) {
  const range = { gte: dayStart(dateFrom), lte: dayEnd(dateTo) };

  const [byReasonRows, byMethodRows, collectedAgg] = await Promise.all([
    prisma.refunds.groupBy({
      by: ['reason_code'],
      where: { clinic_id: clinicId, refunded_at: range },
      _sum: { amount: true },
      _count: { id: true },
      orderBy: { _sum: { amount: 'desc' } },
    }),
    prisma.refunds.groupBy({
      by: ['method'],
      where: { clinic_id: clinicId, refunded_at: range },
      _sum: { amount: true },
      _count: { id: true },
    }),
    prisma.payments.aggregate({
      where: { clinic_id: clinicId, payment_date: { gte: dayStart(dateFrom), lte: dayStart(dateTo) } },
      _sum: { amount: true },
    }),
  ]);

  const byReason = byReasonRows.map((row) => ({
    reason_code: row.reason_code,
    total: columnDecimal(row._sum.amount ?? 0).toNumber(),
    count: row._count.id,
  }));
  const byMethod = byMethodRows.map((row) => ({
    method: row.method,
    total: columnDecimal(row._sum.amount ?? 0).toNumber(),
    count: row._count.id,
  }));

  const totalRefunded = sumDecimals(byReasonRows.map((row) => columnDecimal(row._sum.amount ?? 0)));
  const totalCollected = columnDecimal(collectedAgg._sum.amount ?? 0);

  return {
    period_start: dateFrom,
    period_end: dateTo,
    currency,
    total_refunded: totalRefunded.toNumber(),
    refund_ratio: ratio(totalRefunded, totalCollected),
    by_reason: byReason,
    by_method: byMethod,
  };
}

export async function reportsTrends(
  clinicId: string,
  currency: string,
  dateFrom: string,
  dateTo: string,
  granularity: 'day' | 'week' | 'month' | 'year',
) {
  const [paymentRows, refundRows] = await Promise.all([
    prisma.payments.findMany({
      where: { clinic_id: clinicId, payment_date: { gte: dayStart(dateFrom), lte: dayStart(dateTo) } },
      select: { payment_date: true, amount: true },
    }),
    prisma.refunds.findMany({
      where: { clinic_id: clinicId, refunded_at: { gte: dayStart(dateFrom), lte: dayEnd(dateTo) } },
      select: { refunded_at: true, amount: true },
    }),
  ]);

  const agg = new Map<string, { start: Date; collected: Prisma.Decimal; refunded: Prisma.Decimal }>();
  const add = (date: Date, key: 'collected' | 'refunded', amount: Prisma.Decimal) => {
    const start = bucketStart(date, granularity);
    const bucketKey = start.toISOString();
    const bucket = agg.get(bucketKey) ?? { start, collected: ZERO, refunded: ZERO };
    bucket[key] = bucket[key].plus(amount);
    agg.set(bucketKey, bucket);
  };

  for (const row of paymentRows) add(row.payment_date, 'collected', columnDecimal(row.amount));
  for (const row of refundRows) add(row.refunded_at, 'refunded', columnDecimal(row.amount));

  const points = [...agg.values()]
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map((bucket) => ({
      bucket_start: dateOnlyString(bucket.start),
      collected: bucket.collected.toNumber(),
      refunded: bucket.refunded.toNumber(),
      net: bucket.collected.minus(bucket.refunded).toNumber(),
    }));

  return { granularity, currency, points };
}
