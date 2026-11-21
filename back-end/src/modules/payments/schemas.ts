/**
 * Schémas et logique pure du module `payments` — port de
 * `backend/app/modules/payments/schemas.py` (+ les helpers de
 * `app/core/list_query.py` et `app/core/i18n_names.py`).
 *
 * Tout ce qui ne dépend pas de la base vit ici pour être testable sans
 * PostgreSQL : validation des payloads, sérialisation des DTO, parsing du
 * tri, résolution des noms catalogue, découpage des périodes (trends,
 * aging).
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { unprocessable } from '../../lib/errors';

/** Décimal Prisma (arithmétique exacte, comme `decimal.Decimal`). */
type PrismaDecimal = Prisma.Decimal;
const Decimal = Prisma.Decimal;

// --- Vocabulaire ---------------------------------------------------------

/** `PAYMENT_METHODS` (`payments/models.py`). */
export const PAYMENT_METHODS = [
  'cash',
  'card',
  'bank_transfer',
  'direct_debit',
  'insurance',
  'upi',
  'netbanking',
  'other',
] as const;

/** `ALLOCATION_TARGET_TYPES` (`payments/models.py`). */
export const ALLOCATION_TARGET_TYPES = ['budget', 'on_account'] as const;

/** `REFUND_REASON_CODES` (`payments/models.py`). */
export const REFUND_REASON_CODES = ['duplicate', 'overpaid', 'treatment_cancelled', 'dispute', 'other'] as const;

export const TREND_GRANULARITIES = ['day', 'week', 'month', 'year'] as const;

export const BUDGET_PAYMENT_STATUSES = ['unpaid', 'partial', 'paid'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type AllocationTarget = (typeof ALLOCATION_TARGET_TYPES)[number];
export type RefundReason = (typeof REFUND_REASON_CODES)[number];
export type BudgetPaymentStatus = (typeof BUDGET_PAYMENT_STATUSES)[number];
export type TrendGranularity = (typeof TREND_GRANULARITIES)[number];

// --- Montants -------------------------------------------------------------

const DECIMAL_INPUT = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/**
 * Décimal reçu du client (nombre ou chaîne, comme Pydantic) →
 * `Prisma.Decimal`. `null` quand la valeur n'est pas numérique.
 */
export function decimalFromUnknown(value: unknown): PrismaDecimal | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return new Decimal(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return DECIMAL_INPUT.test(trimmed) ? new Decimal(trimmed) : null;
  }
  return null;
}

/** Décimale d'une colonne `Decimal` Prisma (échoue comme `.toNumber()`). */
export function columnDecimal(value: unknown): PrismaDecimal {
  if (value instanceof Decimal) return value;
  return new Decimal(String(value ?? 0));
}

/** Somme décimale exacte (jamais en flottant). */
export function sumDecimals(values: Iterable<PrismaDecimal>): PrismaDecimal {
  let total = new Decimal(0);
  for (const value of values) total = total.plus(value);
  return total;
}

/** `max(Decimal("0"), value)`. */
export function clampNonNegative(value: PrismaDecimal): PrismaDecimal {
  return value.greaterThan(0) ? value : new Decimal(0);
}

/** Rapport flottant `a / b`, `0.0` quand `b` est zéro (comme le Python). */
export function ratio(numerator: PrismaDecimal, denominator: PrismaDecimal): number {
  if (denominator.isZero()) return 0.0;
  return numerator.dividedBy(denominator).toNumber();
}

// --- Validation des payloads ---------------------------------------------

const uuid = z.string().uuid();

export class PaymentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentValidationError';
  }
}

function emptyToNull(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return value as never;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** `field_validator(mode="before")` : strip puis vide → `null`, non-chaîne → 422. */
function strippedText(field: string, maxLength?: number) {
  const string = z.string({
    error: () => `${field}: Input should be a valid string`,
  });
  const bounded =
    maxLength === undefined
      ? string
      : string.max(maxLength, `String should have at most ${maxLength} characters`);
  return z.preprocess(emptyToNull, bounded.nullable().optional());
}

/** UUID optionnel : `null`, absent ou chaîne vide → `null` (comme `UUID | None`). */
const optionalUuid = () =>
  z.preprocess(
    (value) => (value === undefined || value === null || value === '' ? null : value),
    z.string({ error: () => 'Input should be a valid UUID' }).uuid('Input should be a valid UUID').nullable(),
  );

export interface AllocationInput {
  target_type: AllocationTarget;
  target_id: string | null;
  amount: PrismaDecimal;
}

export const allocationCreateSchema = z
  .object({
    target_type: z.enum(ALLOCATION_TARGET_TYPES),
    target_id: optionalUuid(),
    amount: z.unknown(),
  })
  .superRefine((value, ctx) => {
    if (value.target_type === 'budget' && (value.target_id === null || value.target_id === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: "target_id is required when target_type='budget'",
        path: ['target_id'],
      });
    }
    if (value.target_type === 'on_account' && value.target_id !== null && value.target_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: "target_id must be null when target_type='on_account'",
        path: ['target_id'],
      });
    }
    const amount = decimalFromUnknown(value.amount);
    if (amount === null) {
      ctx.addIssue({ code: 'custom', message: 'Input should be a valid decimal', path: ['amount'] });
    } else if (amount.lessThanOrEqualTo(0)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Input should be greater than 0',
        path: ['amount'],
      });
    }
  })
  .transform((value): AllocationInput => ({
    target_type: value.target_type,
    target_id: value.target_id ?? null,
    amount: decimalFromUnknown(value.amount)!,
  }));

/** Validation « inline » (utilisée par le gateway, qui partage ce schéma). */
export function parseAllocations(raw: unknown): AllocationInput[] {
  const list = z.array(allocationCreateSchema).parse(raw);
  return list;
}

export interface PaymentCreateInput {
  patient_id: string;
  amount: PrismaDecimal;
  method: PaymentMethod;
  payment_date: string | null;
  reference: string | null;
  notes: string | null;
  allocations: AllocationInput[];
  idempotency_key: string | null;
}

export const paymentCreateSchema = z
  .object({
    patient_id: uuid,
    amount: z.unknown(),
    method: z.enum(PAYMENT_METHODS),
    payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Input should be a valid date').nullable().optional(),
    reference: strippedText('reference', 100),
    notes: strippedText('notes'),
    allocations: z.array(allocationCreateSchema).min(1),
    idempotency_key: z.string().max(100).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const amount = decimalFromUnknown(value.amount);
    if (amount === null) {
      ctx.addIssue({ code: 'custom', message: 'Input should be a valid decimal', path: ['amount'] });
      return;
    }
    if (amount.lessThanOrEqualTo(0)) {
      ctx.addIssue({ code: 'custom', message: 'Input should be greater than 0', path: ['amount'] });
      return;
    }
    const allocated = sumDecimals(value.allocations.map((a) => a.amount));
    if (!allocated.equals(amount)) {
      ctx.addIssue({
        code: 'custom',
        message: `Allocations must sum to amount (${amount}); got ${allocated}`,
        path: ['allocations'],
      });
    }
  })
  .transform(
    (value): PaymentCreateInput => ({
      patient_id: value.patient_id,
      amount: decimalFromUnknown(value.amount)!,
      method: value.method,
      payment_date: value.payment_date ?? null,
      reference: value.reference ?? null,
      notes: value.notes ?? null,
      allocations: value.allocations,
      idempotency_key: value.idempotency_key ?? null,
    }),
  );

export const paymentReallocateSchema = z
  .object({
    allocations: z.array(allocationCreateSchema).min(1),
  })
  .transform((value) => ({ allocations: value.allocations }));

export interface RefundCreateInput {
  amount: PrismaDecimal;
  method: PaymentMethod;
  reason_code: RefundReason;
  reason_note: string | null;
}

export const refundCreateSchema = z
  .object({
    amount: z.unknown(),
    method: z.enum(PAYMENT_METHODS),
    reason_code: z.enum(REFUND_REASON_CODES),
    reason_note: strippedText('reason_note'),
  })
  .superRefine((value, ctx) => {
    const amount = decimalFromUnknown(value.amount);
    if (amount === null) {
      ctx.addIssue({ code: 'custom', message: 'Input should be a valid decimal', path: ['amount'] });
    } else if (amount.lessThanOrEqualTo(0)) {
      ctx.addIssue({ code: 'custom', message: 'Input should be greater than 0', path: ['amount'] });
    }
  })
  .transform(
    (value): RefundCreateInput => ({
      amount: decimalFromUnknown(value.amount)!,
      method: value.method,
      reason_code: value.reason_code,
      reason_note: value.reason_note ?? null,
    }),
  );

export const budgetIdsRequestSchema = z.object({
  budget_ids: z.array(uuid).min(1).max(100),
});

export const patientIdsRequestSchema = z.object({
  patient_ids: z.array(uuid).min(1).max(100),
});

// --- Tri (`parse_sort`) ---------------------------------------------------

export const PAYMENT_SORT_FIELDS = ['amount', 'created_at', 'payment_date'] as const;
export const PAYMENT_SORT_DEFAULT = 'payment_date:desc';

export interface SortSpec {
  field: (typeof PAYMENT_SORT_FIELDS)[number];
  direction: 'asc' | 'desc';
}

/** Tri Python : les champs autorisés (`sorted(allow.keys())`). */
export const PAYMENT_SORT_ALLOWED_LABEL = "['amount', 'created_at', 'payment_date']";

/**
 * Port de `parse_sort` : `field:dir` contre une liste blanche.
 * 422 (enveloppe `{detail}`) sur champ vide / inconnu / direction invalide.
 */
export function parseSort(raw: string | null | undefined): SortSpec {
  const value = (raw ?? PAYMENT_SORT_DEFAULT).trim();
  if (!value) {
    throw unprocessable('Empty sort value');
  }
  const [fieldRaw, directionRaw] = value.split(':');
  const field = (fieldRaw ?? '').trim();
  const direction = ((directionRaw ?? 'asc').trim() || 'asc').toLowerCase();

  if (!(PAYMENT_SORT_FIELDS as readonly string[]).includes(field)) {
    throw unprocessable(`Invalid sort field '${field}'. Allowed: ${PAYMENT_SORT_ALLOWED_LABEL}`);
  }
  if (direction !== 'asc' && direction !== 'desc') {
    throw unprocessable(`Invalid sort direction '${direction}'. Use 'asc' or 'desc'.`);
  }
  return { field: field as SortSpec['field'], direction };
}

// --- Dates (bucketisation des trends) -------------------------------------

/** Jour calendaire UTC (colonnes `date` : Prisma les rend à minuit UTC). */
export function utcDateOnly(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/** Début du bucket contenant `value` pour la granularité demandée. */
export function bucketStart(value: Date, granularity: TrendGranularity): Date {
  const day = utcDateOnly(value);
  switch (granularity) {
    case 'day':
      return day;
    case 'week': {
      // `date.weekday()` : lundi = 0.
      const weekday = (day.getUTCDay() + 6) % 7;
      return new Date(day.getTime() - weekday * 86_400_000);
    }
    case 'month':
      return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
    case 'year':
      return new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
    default:
      return day;
  }
}

/**
 * Bucket d'aging par ancienneté (en jours) de l'entrée non payée la plus
 * ancienne — mêmes bornes que `PaymentReportsService.aging_receivables`.
 */
export function agingBucketLabel(ageDays: number): '0-30' | '31-60' | '61-90' | '90+' {
  if (ageDays <= 30) return '0-30';
  if (ageDays <= 60) return '31-60';
  if (ageDays <= 90) return '61-90';
  return '90+';
}

// --- Noms catalogue (`catalog_name`) --------------------------------------

/** `CATALOG_NAME_PRIORITY` (`app/core/i18n_names.py`). */
export const CATALOG_NAME_PRIORITY = [
  'es',
  'en',
  'fr',
  'pt',
  'ta',
  'te',
  'hi',
  'de',
  'hu',
  'it',
  'pl',
  'ar',
] as const;

function usableName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Port de `catalog_name` : priorité linguistique puis toute traduction non vide. */
export function catalogName(names: unknown): string | null {
  if (!names || typeof names !== 'object' || Array.isArray(names)) return null;
  const record = names as Record<string, unknown>;
  for (const lang of CATALOG_NAME_PRIORITY) {
    if (usableName(record[lang])) return record[lang];
  }
  for (const value of Object.values(record)) {
    if (usableName(value)) return value;
  }
  return null;
}

// --- Helpers métier purs --------------------------------------------------

/** `payment_status` d'un budget : `collected <= 0` → unpaid, `>= total > 0` → paid. */
export function budgetPaymentStatus(
  collected: PrismaDecimal,
  total: PrismaDecimal,
): BudgetPaymentStatus {
  if (collected.lessThanOrEqualTo(0)) return 'unpaid';
  if (collected.greaterThanOrEqualTo(total) && total.greaterThan(0)) return 'paid';
  return 'partial';
}

/** `max(0, total - collected)`. */
export function budgetPending(total: PrismaDecimal, collected: PrismaDecimal): PrismaDecimal {
  const pending = total.minus(collected);
  return pending.greaterThan(0) ? pending : new Decimal(0);
}

/**
 * Solde FIFO virtuel : parcourt les entrées gagnées (chronologiques) et
 * déduit le net payé. Retourne les entrées non (entièrement) couvertes,
 * avec le reste dû sur celle qui est partiellement couverte.
 * Port pur de `LedgerService.compute_pending_charges`.
 */
export interface EarnedLike {
  amount: PrismaDecimal;
}

export interface PendingCoverage {
  /** Montant encore dû sur l'entrée (jamais ≤ 0). */
  unpaid: PrismaDecimal;
}

export function pendingCoverage<T extends EarnedLike>(
  earned: T[],
  netPaid: PrismaDecimal,
): Array<{ entry: T; unpaid: PrismaDecimal }> {
  let remaining = netPaid;
  const pending: Array<{ entry: T; unpaid: PrismaDecimal }> = [];
  for (const entry of earned) {
    if (remaining.greaterThanOrEqualTo(entry.amount)) {
      remaining = remaining.minus(entry.amount);
      continue;
    }
    const covered = remaining.greaterThan(0) ? remaining : new Decimal(0);
    const unpaid = entry.amount.minus(covered);
    remaining = new Decimal(0);
    pending.push({ entry, unpaid });
  }
  return pending;
}

/** `str(Decimal)` façon Python pour les payloads générés côté serveur. */
export function decimalToString(value: PrismaDecimal): string {
  return value.toFixed();
}

// --- DTO ------------------------------------------------------------------

export interface UserBriefDto {
  id: string;
  first_name: string;
  last_name: string;
}

export interface PatientBriefDto {
  id: string;
  first_name: string;
  last_name: string;
}

export interface AllocationResponseDto {
  id: string;
  target_type: string;
  target_id: string | null;
  amount: number;
  created_at: string;
  created_by: string;
  method: string | null;
}

export interface PaymentResponseDto {
  id: string;
  clinic_id: string;
  patient_id: string;
  amount: number;
  currency: string;
  method: string;
  payment_date: string;
  reference: string | null;
  notes: string | null;
  recorded_by: string;
  created_at: string;
  updated_at: string;
  allocations: AllocationResponseDto[];
  refunded_total: number;
  net_amount: number;
  recorder: UserBriefDto | null;
  patient: PatientBriefDto | null;
}

export interface RefundResponseDto {
  id: string;
  payment_id: string;
  amount: number;
  method: string;
  reason_code: string;
  reason_note: string | null;
  refunded_at: string;
  refunded_by: string;
  refunder: UserBriefDto | null;
}

export interface LedgerEntryDto {
  entry_type: 'payment' | 'refund' | 'earned';
  occurred_at: string;
  amount: number;
  reference_id: string;
  description: string | null;
  treatment_id: string | null;
  treatment_name: string | null;
  treatment_status: string | null;
  professional_id: string | null;
  professional_name: string | null;
}

export interface PatientLedgerDto {
  patient_id: string;
  currency: string;
  total_paid: number;
  total_earned: number;
  patient_credit: number;
  clinic_receivable: number;
  on_account_balance: number;
  timeline: LedgerEntryDto[];
}

export interface PaymentsSummaryDto {
  period_start: string;
  period_end: string;
  currency: string;
  total_collected: number;
  total_refunded: number;
  net_collected: number;
  patient_credit_total: number;
  clinic_receivable_total: number;
  refund_ratio: number;
  payment_count: number;
  refund_count: number;
}

export interface MethodBreakdownDto {
  method: string;
  total: number;
  count: number;
}

export interface ProfessionalBreakdownDto {
  professional_id: string | null;
  professional_name: string | null;
  total_earned: number;
  count: number;
}

export interface AgingBucketDto {
  label: string;
  total: number;
  patient_count: number;
}

export interface AgingBucketsDto {
  currency: string;
  buckets: AgingBucketDto[];
}

export interface ReasonBreakdownDto {
  reason_code: string;
  total: number;
  count: number;
}

export interface RefundsReportDto {
  period_start: string;
  period_end: string;
  currency: string;
  total_refunded: number;
  refund_ratio: number;
  by_reason: ReasonBreakdownDto[];
  by_method: MethodBreakdownDto[];
}

export interface TrendPointDto {
  bucket_start: string;
  collected: number;
  refunded: number;
  net: number;
}

export interface PaymentsTrendsDto {
  granularity: TrendGranularity;
  currency: string;
  points: TrendPointDto[];
}

export interface BudgetSummaryByIdsDto {
  collected: number;
  pending: number;
  payment_status: BudgetPaymentStatus;
}

export interface PatientSummaryByIdsDto {
  total_paid: number;
  debt: number;
  on_account_balance: number;
}

export interface FilterIdsResponseDto {
  budget_ids: string[] | null;
  patient_ids: string[] | null;
  truncated: boolean;
}
