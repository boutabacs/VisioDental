/**
 * Couche service du module `billing` — port de
 * `app/modules/billing/{service,workflow,payment_bridge}.py`.
 *
 * Conventions reproduites :
 * - multi-tenant strict : toute lecture/écriture est filtrée par `clinicId`,
 *   les lignes d'une autre clinique sont traitées comme inexistantes ;
 * - les messages d'erreur (`ValueError` Python → 400) sont conservés au
 *   caractère près ;
 * - les décimales sont sérialisées en nombres (floats Pydantic), les
 *   colonnes `date` en `YYYY-MM-DD`, les horodatages en ISO naïf UTC (format
 *   pydantic d'une colonne `timestamp with time zone`) ;
 * - le compteur de série est incrémenté sous verrou de ligne
 *   (`SELECT ... FOR UPDATE`), dans la transaction de l'appelant.
 */

import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { lookupLinkedPlan, type TreatmentPlanBriefDto } from '../budget/service';
import {
  addDays,
  allocateGlobalDiscount,
  centsToDecimal,
  clinicTodayAsDate,
  computeLineTotals,
  dateOnlyFromString,
  dec,
  formatDateOnly,
  formatInvoiceNumber,
  nextNumber,
  parseInvoiceSort,
  toCents,
  type LineTotals,
} from './schemas';

export type Db = Prisma.TransactionClient;

/** Écart métier (Python `ValueError` / `InvoiceWorkflowError`) → 400. */
export class BillingValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingValueError';
  }
}

export function fail400(message: string): never {
  throw new BillingValueError(message);
}

/** Corps HTML de la facture : `generateInvoiceHtml`, ré-exporté pour le routeur. */
export { generateInvoiceHtml } from './pdf';

/**
 * Exécute un travail dans une transaction dont les verrous de ligne
 * n'attendent pas indéfiniment (miroir du `statement_timeout` côté pool
 * Python) : une requête concurrente bloquée échoue plutôt que de pendre.
 */
export async function inTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
    return work(tx);
  });
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

/** Timestamptz → ISO naïf (`2026-01-31T09:05:00.123456`), format pydantic. */
export function naiveIso(value: Date): string {
  return value.toISOString().replace('Z', '');
}

function isoOrNull(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : naiveIso(value);
}

function dateOrNull(value: Date | null | undefined): string | null {
  return formatDateOnly(value ?? null);
}

function asJsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringArray(value: Prisma.JsonValue | null | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => String(entry));
}

/** `date` Pydantic : `YYYY-MM-DD` (ou ISO complet) → colonne `date`. */
export function parseDateInput(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) return dateOnlyFromString(trimmed);
  // Datetime fourni : seul le jour calendaire est conservé par pydantic.
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    fail400(`Invalid date value: ${value}`);
  }
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function jsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === null || value === undefined) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface UserBriefDto {
  id: string;
  first_name: string;
  last_name: string;
}

export interface PatientBriefDto {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  billing_name: string | null;
  billing_tax_id: string | null;
  billing_address: Record<string, unknown> | null;
  billing_email: string | null;
  has_complete_billing_info: boolean;
}

export interface CatalogItemBriefDto {
  id: string;
  internal_code: string;
  names: Record<string, unknown>;
  default_price: number | null;
}

export interface VatTypeBriefDto {
  id: string;
  names: Record<string, unknown>;
  rate: number;
}

export interface InvoiceItemDto {
  id: string;
  invoice_id: string;
  budget_item_id: string | null;
  catalog_item_id: string | null;
  description: string;
  internal_code: string | null;
  unit_price: number;
  quantity: number;
  discount_type: string | null;
  discount_value: number | null;
  vat_type_id: string | null;
  vat_rate: number;
  vat_exempt_reason: string | null;
  line_subtotal: number;
  line_discount: number;
  line_tax: number;
  line_total: number;
  tooth_number: number | null;
  surfaces: string[] | null;
  display_order: number;
  created_at: string;
  updated_at: string;
  catalog_item: CatalogItemBriefDto | null;
  vat_type: VatTypeBriefDto | null;
}

export interface InvoicePaymentLinkDto {
  id: string;
  invoice_id: string;
  payment_id: string;
  amount: number;
  created_by: string;
  created_at: string;
}

export interface InvoiceResponseDto {
  id: string;
  clinic_id: string;
  patient_id: string;
  invoice_number: string | null;
  sequential_number: number | null;
  series_id: string | null;
  budget_id: string | null;
  credit_note_for_id: string | null;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  payment_term_days: number;
  billing_name: string | null;
  billing_tax_id: string | null;
  billing_address: Record<string, unknown> | null;
  billing_email: string | null;
  subtotal: number;
  total_discount: number;
  total_tax: number;
  total: number;
  total_paid: number;
  balance_due: number;
  internal_notes: string | null;
  public_notes: string | null;
  compliance_data: Record<string, unknown> | null;
  document_hash: string | null;
  pdf_stale: boolean;
  created_by: string;
  issued_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  patient: PatientBriefDto | null;
  creator: UserBriefDto | null;
  issuer: UserBriefDto | null;
  budget: { id: string; budget_number: string; status: string; total: number } | null;
  treatment_plan: TreatmentPlanBriefDto | null;
  credit_note_for: {
    id: string;
    invoice_number: string | null;
    status: string;
    total: number;
    issue_date: string | null;
  } | null;
}

export interface InvoiceDetailDto extends InvoiceResponseDto {
  items: InvoiceItemDto[];
  invoice_payments: InvoicePaymentLinkDto[];
}

export interface InvoiceListDto {
  id: string;
  invoice_number: string | null;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  total: number;
  total_paid: number;
  balance_due: number;
  created_at: string;
  compliance_data: Record<string, unknown> | null;
  patient: PatientBriefDto | null;
  creator: UserBriefDto | null;
}

export interface InvoiceSeriesDto {
  id: string;
  clinic_id: string;
  prefix: string;
  series_type: string;
  description: string | null;
  current_number: number;
  reset_yearly: boolean;
  last_reset_year: number | null;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface InvoiceHistoryDto {
  id: string;
  invoice_id: string;
  action: string;
  changed_by: string;
  changed_at: string;
  previous_state: Record<string, unknown> | null;
  new_state: Record<string, unknown> | null;
  notes: string | null;
  user: UserBriefDto | null;
}

export interface PaymentAllocationDto {
  id: string;
  target_type: string;
  target_id: string | null;
  amount: number;
  created_at: string;
  created_by: string;
  method: string | null;
}

export interface PaymentDto {
  id: string;
  clinic_id: string;
  patient_id: string;
  amount: number;
  currency: string;
  method: string;
  payment_date: string | null;
  reference: string | null;
  notes: string | null;
  recorded_by: string;
  created_at: string;
  updated_at: string;
  allocations: PaymentAllocationDto[];
  refunded_total: number;
  net_amount: number;
  recorder: UserBriefDto | null;
  patient: { id: string; first_name: string; last_name: string } | null;
}

export interface InvoicePaymentDetailDto extends InvoicePaymentLinkDto {
  payment: PaymentDto;
}

export interface PatientBillingSummaryDto {
  patient_id: string;
  total_budgeted: number;
  total_discount: number;
  work_in_progress: number;
  work_completed: number;
  total_invoiced: number;
  total_paid: number;
  balance_pending: number;
}

// ---------------------------------------------------------------------------
// Includes
// ---------------------------------------------------------------------------

const patientSelect = {
  id: true,
  first_name: true,
  last_name: true,
  email: true,
  phone: true,
  billing_name: true,
  billing_tax_id: true,
  billing_address: true,
  billing_email: true,
  national_id: true,
  national_id_type: true,
} satisfies Prisma.patientsSelect;

const userSelect = {
  id: true,
  first_name: true,
  last_name: true,
} satisfies Prisma.usersSelect;

const itemInclude = {
  treatment_catalog_items: {
    select: { id: true, internal_code: true, names: true, default_price: true },
  },
  vat_types: { select: { id: true, names: true, rate: true } },
} satisfies Prisma.invoice_itemsInclude;

const paymentInclude = {
  payment_allocations: { orderBy: { created_at: 'asc' } },
  refunds: { select: { amount: true } },
  users: { select: userSelect },
  patients: { select: { id: true, first_name: true, last_name: true } },
} satisfies Prisma.paymentsInclude;

const invoiceBaseInclude = {
  patients: { select: patientSelect },
  users_invoices_created_byTousers: { select: userSelect },
  users_invoices_issued_byTousers: { select: userSelect },
  budgets: { select: { id: true, budget_number: true, status: true, total: true } },
  invoices: { select: { id: true, invoice_number: true, status: true, total: true, issue_date: true } },
  invoice_series: { select: { id: true, prefix: true } },
} satisfies Prisma.invoicesInclude;

const invoiceDetailInclude = {
  ...invoiceBaseInclude,
  invoice_items: { orderBy: { display_order: 'asc' }, include: itemInclude },
  invoice_payments: { orderBy: { created_at: 'asc' } },
} satisfies Prisma.invoicesInclude;

const invoiceListInclude = {
  patients: { select: patientSelect },
  users_invoices_created_byTousers: { select: userSelect },
} satisfies Prisma.invoicesInclude;

type InvoiceBaseRow = Prisma.invoicesGetPayload<{ include: typeof invoiceBaseInclude }>;
export type InvoiceDetailRow = Prisma.invoicesGetPayload<{ include: typeof invoiceDetailInclude }>;
type InvoiceListRow = Prisma.invoicesGetPayload<{ include: typeof invoiceListInclude }>;
type PatientRow = Prisma.patientsGetPayload<{ select: typeof patientSelect }>;
type PaymentRow = Prisma.paymentsGetPayload<{ include: typeof paymentInclude }>;

function toUserBrief(user: { id: string; first_name: string; last_name: string } | null): UserBriefDto | null {
  return user ? { id: user.id, first_name: user.first_name, last_name: user.last_name } : null;
}

function toPatientBrief(patient: PatientRow | null): PatientBriefDto | null {
  if (!patient) return null;
  const taxId =
    patient.billing_tax_id ??
    (patient.national_id && patient.national_id_type !== 'passport' ? patient.national_id : null);
  return {
    id: patient.id,
    first_name: patient.first_name,
    last_name: patient.last_name,
    email: patient.email,
    billing_name: patient.billing_name,
    billing_tax_id: patient.billing_tax_id,
    billing_address: asJsonObject(patient.billing_address),
    billing_email: patient.billing_email,
    has_complete_billing_info: Boolean(taxId),
  };
}

export function toItemDto(
  item: Prisma.invoice_itemsGetPayload<{ include: typeof itemInclude }>,
): InvoiceItemDto {
  const catalog = item.treatment_catalog_items;
  const vat = item.vat_types;
  return {
    id: item.id,
    invoice_id: item.invoice_id,
    budget_item_id: item.budget_item_id,
    catalog_item_id: item.catalog_item_id,
    description: item.description,
    internal_code: item.internal_code,
    unit_price: dec(item.unit_price),
    quantity: item.quantity,
    discount_type: item.discount_type,
    discount_value: dec(item.discount_value),
    vat_type_id: item.vat_type_id,
    vat_rate: item.vat_rate,
    vat_exempt_reason: item.vat_exempt_reason,
    line_subtotal: dec(item.line_subtotal),
    line_discount: dec(item.line_discount),
    line_tax: dec(item.line_tax),
    line_total: dec(item.line_total),
    tooth_number: item.tooth_number,
    surfaces: asStringArray(item.surfaces),
    display_order: item.display_order,
    created_at: naiveIso(item.created_at),
    updated_at: naiveIso(item.updated_at),
    catalog_item: catalog
      ? {
          id: catalog.id,
          internal_code: catalog.internal_code,
          names: (catalog.names as Record<string, unknown> | null) ?? {},
          default_price: dec(catalog.default_price),
        }
      : null,
    vat_type: vat
      ? { id: vat.id, names: (vat.names as Record<string, unknown> | null) ?? {}, rate: vat.rate }
      : null,
  };
}

function toLinkDto(row: {
  id: string;
  invoice_id: string;
  payment_id: string;
  amount: Prisma.Decimal;
  created_by: string;
  created_at: Date;
}): InvoicePaymentLinkDto {
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    payment_id: row.payment_id,
    amount: dec(row.amount),
    created_by: row.created_by,
    created_at: naiveIso(row.created_at),
  };
}

/** Miroir de `PaymentResponse.from_model`. */
export function toPaymentDto(payment: PaymentRow): PaymentDto {
  const refunded = payment.refunds.reduce((sum, refund) => sum + toCents(refund.amount), 0);
  const amount = toCents(payment.amount);
  return {
    id: payment.id,
    clinic_id: payment.clinic_id,
    patient_id: payment.patient_id,
    amount: dec(payment.amount),
    currency: payment.currency,
    method: payment.method,
    payment_date: dateOrNull(payment.payment_date),
    reference: payment.reference,
    notes: payment.notes,
    recorded_by: payment.recorded_by,
    created_at: naiveIso(payment.created_at),
    updated_at: naiveIso(payment.updated_at),
    allocations: payment.payment_allocations.map((allocation) => ({
      id: allocation.id,
      target_type: allocation.target_type,
      target_id: allocation.target_type === 'budget' ? allocation.budget_id : null,
      amount: dec(allocation.amount),
      created_at: naiveIso(allocation.created_at),
      created_by: allocation.created_by,
      method: payment.method,
    })),
    refunded_total: centsToDecimal(refunded).toNumber(),
    net_amount: centsToDecimal(amount - refunded).toNumber(),
    recorder: toUserBrief(payment.users),
    patient: payment.patients
      ? {
          id: payment.patients.id,
          first_name: payment.patients.first_name,
          last_name: payment.patients.last_name,
        }
      : null,
  };
}

/** `InvoiceResponse.model_validate` (hors `total_paid`/`balance_due`). */
export function toInvoiceResponse(
  invoice: InvoiceBaseRow,
  treatmentPlan: TreatmentPlanBriefDto | null = null,
): InvoiceResponseDto {
  const creditNoteFor = invoice.invoices;
  return {
    id: invoice.id,
    clinic_id: invoice.clinic_id,
    patient_id: invoice.patient_id,
    invoice_number: invoice.invoice_number,
    sequential_number: invoice.sequential_number,
    series_id: invoice.series_id,
    budget_id: invoice.budget_id,
    credit_note_for_id: invoice.credit_note_for_id,
    status: invoice.status,
    issue_date: dateOrNull(invoice.issue_date),
    due_date: dateOrNull(invoice.due_date),
    payment_term_days: invoice.payment_term_days,
    billing_name: invoice.billing_name,
    billing_tax_id: invoice.billing_tax_id,
    billing_address: asJsonObject(invoice.billing_address),
    billing_email: invoice.billing_email,
    subtotal: dec(invoice.subtotal),
    total_discount: dec(invoice.total_discount),
    total_tax: dec(invoice.total_tax),
    total: dec(invoice.total),
    total_paid: 0,
    balance_due: 0,
    internal_notes: invoice.internal_notes,
    public_notes: invoice.public_notes,
    compliance_data: asJsonObject(invoice.compliance_data),
    document_hash: invoice.document_hash,
    pdf_stale: invoice.pdf_stale,
    created_by: invoice.created_by,
    issued_by: invoice.issued_by,
    created_at: naiveIso(invoice.created_at),
    updated_at: naiveIso(invoice.updated_at),
    deleted_at: isoOrNull(invoice.deleted_at),
    patient: toPatientBrief(invoice.patients),
    creator: toUserBrief(invoice.users_invoices_created_byTousers),
    issuer: toUserBrief(invoice.users_invoices_issued_byTousers),
    budget: invoice.budgets
      ? {
          id: invoice.budgets.id,
          budget_number: invoice.budgets.budget_number,
          status: invoice.budgets.status,
          total: dec(invoice.budgets.total),
        }
      : null,
    treatment_plan: treatmentPlan,
    credit_note_for: creditNoteFor
      ? {
          id: creditNoteFor.id,
          invoice_number: creditNoteFor.invoice_number,
          status: creditNoteFor.status,
          total: dec(creditNoteFor.total),
          issue_date: dateOrNull(creditNoteFor.issue_date),
        }
      : null,
  };
}

export function toInvoiceDetail(invoice: InvoiceDetailRow): InvoiceDetailDto {
  return {
    ...toInvoiceResponse(invoice),
    items: invoice.invoice_items.map(toItemDto),
    invoice_payments: invoice.invoice_payments.map(toLinkDto),
  };
}

export function toInvoiceList(invoice: InvoiceListRow): InvoiceListDto {
  return {
    id: invoice.id,
    invoice_number: invoice.invoice_number,
    status: invoice.status,
    issue_date: dateOrNull(invoice.issue_date),
    due_date: dateOrNull(invoice.due_date),
    total: dec(invoice.total),
    total_paid: 0,
    balance_due: 0,
    created_at: naiveIso(invoice.created_at),
    compliance_data: asJsonObject(invoice.compliance_data),
    patient: toPatientBrief(invoice.patients),
    creator: toUserBrief(invoice.users_invoices_created_byTousers),
  };
}

export function toSeriesDto(series: Prisma.invoice_seriesGetPayload<object>): InvoiceSeriesDto {
  return {
    id: series.id,
    clinic_id: series.clinic_id,
    prefix: series.prefix,
    series_type: series.series_type,
    description: series.description,
    current_number: series.current_number,
    reset_yearly: series.reset_yearly,
    last_reset_year: series.last_reset_year,
    is_default: series.is_default,
    is_active: series.is_active,
    created_at: naiveIso(series.created_at),
    updated_at: naiveIso(series.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Résumé payé (compute_paid_summary / compute_paid_summaries_for_invoices)
// ---------------------------------------------------------------------------

type PaidSummary = { total_paid: number; balance_due: number };

interface ImputationRow {
  invoice_id: string;
  payment_id: string;
  amount: Prisma.Decimal;
}

/**
 * `(total_paid, balance_due)` par facture, hors remboursements au prorata
 * (`refund.amount × imputé / montant du paiement`).
 */
export async function computePaidSummariesForInvoices(
  db: Db,
  clinicId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, PaidSummary>> {
  const result = new Map<string, PaidSummary>();
  if (invoiceIds.length === 0) return result;

  const grouped = await db.invoice_payments.groupBy({
    by: ['invoice_id', 'payment_id'],
    where: { clinic_id: clinicId, invoice_id: { in: [...invoiceIds] } },
    _sum: { amount: true },
  });
  const imputedByInvoice = new Map<string, Array<{ payment_id: string; cents: number }>>();
  const paymentIds = new Set<string>();
  for (const row of grouped) {
    const cents = toCents(row._sum.amount ?? 0);
    const list = imputedByInvoice.get(row.invoice_id) ?? [];
    list.push({ payment_id: row.payment_id, cents });
    imputedByInvoice.set(row.invoice_id, list);
    paymentIds.add(row.payment_id);
  }

  const paymentAmount = new Map<string, number>();
  const refundedPerPayment = new Map<string, number>();
  if (paymentIds.size > 0) {
    const payments = await db.payments.findMany({
      where: { id: { in: [...paymentIds] } },
      select: { id: true, amount: true },
    });
    for (const payment of payments) paymentAmount.set(payment.id, toCents(payment.amount));

    const refunds = await db.refunds.groupBy({
      by: ['payment_id'],
      where: { payment_id: { in: [...paymentIds] } },
      _sum: { amount: true },
    });
    for (const refund of refunds) refundedPerPayment.set(refund.payment_id, toCents(refund._sum.amount ?? 0));
  }

  const totals = await db.invoices.findMany({
    where: { id: { in: [...invoiceIds] } },
    select: { id: true, total: true },
  });
  const totalsById = new Map(totals.map((row) => [row.id, toCents(row.total)]));

  for (const invoiceId of invoiceIds) {
    let netPaid = 0;
    for (const { payment_id, cents } of imputedByInvoice.get(invoiceId) ?? []) {
      const full = paymentAmount.get(payment_id) ?? cents;
      const refunded = refundedPerPayment.get(payment_id) ?? 0;
      // Part du remboursement qui touche cette imputation (arrondie au centime).
      const adjustment =
        full > 0 ? Math.round((refunded * cents) / full) : 0;
      netPaid += cents - adjustment;
    }
    const total = totalsById.get(invoiceId) ?? 0;
    result.set(invoiceId, {
      total_paid: centsToDecimal(netPaid).toNumber(),
      balance_due: centsToDecimal(total - netPaid).toNumber(),
    });
  }
  return result;
}

export async function computePaidSummary(
  db: Db,
  clinicId: string,
  invoiceId: string,
): Promise<PaidSummary> {
  const summary = await computePaidSummariesForInvoices(db, clinicId, [invoiceId]);
  return summary.get(invoiceId) ?? { total_paid: 0, balance_due: 0 };
}

/** Centimes exacts de `(total_paid, balance_due)` pour un calcul interne. */
async function paidSummaryCents(
  db: Db,
  clinicId: string,
  invoiceId: string,
): Promise<{ paid: number; balance: number }> {
  const summary = await computePaidSummary(db, clinicId, invoiceId);
  return { paid: toCents(summary.total_paid), balance: toCents(summary.balance_due) };
}

// ---------------------------------------------------------------------------
// Notes légales TVA (`vat_legal_notes_for_invoice`)
// ---------------------------------------------------------------------------

export async function vatLegalNotesForInvoice(
  db: Db,
  clinicId: string,
  invoice:
    | { invoice_items: Array<{ vat_type_id: string | null }> }
    | { items: Array<{ vat_type_id: string | null }> },
): Promise<string[]> {
  const items = 'invoice_items' in invoice ? invoice.invoice_items : invoice.items;
  const ids = [...new Set(items.map((item) => item.vat_type_id).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return [];
  const rows = await db.vat_types.findMany({
    where: { clinic_id: clinicId, id: { in: ids }, legal_note: { not: null } },
    select: { legal_note: true },
    orderBy: { legal_note: 'asc' },
  });
  const notes = new Set<string>();
  for (const row of rows) {
    if (row.legal_note && row.legal_note !== '') notes.add(row.legal_note);
  }
  return [...notes].sort();
}

// ---------------------------------------------------------------------------
// Séries (InvoiceSeriesService / InvoiceNumberService)
// ---------------------------------------------------------------------------

/** Section critique : verrouille et lit le compteur sous `FOR UPDATE`. */
async function lockSeries(
  db: Db,
  clinicId: string,
  seriesId: string,
): Promise<{
  id: string;
  clinic_id: string;
  prefix: string;
  series_type: string;
  description: string | null;
  current_number: number;
  reset_yearly: boolean;
  last_reset_year: number | null;
  is_default: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
} | null> {
  const locked = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM invoice_series
    WHERE id = ${seriesId}::uuid AND clinic_id = ${clinicId}::uuid
    FOR UPDATE`;
  if (locked.length === 0) return null;
  return db.invoice_series.findUnique({ where: { id: seriesId } });
}

/**
 * Numéro suivant d'une série (`InvoiceNumberService.generate_number`).
 * Le reset annuel repart de 1 quand `last_reset_year` diffère de l'année.
 */
export async function generateNumber(
  db: Db,
  clinicId: string,
  seriesId: string,
  today: Date | null,
): Promise<{ invoice_number: string; sequential_number: number; fiscal_year: number }> {
  const series = await lockSeries(db, clinicId, seriesId);
  if (!series) fail400(`Series ${seriesId} not found`);
  if (!series.is_active) fail400(`Series ${series.prefix} is not active`);

  const fiscalYear = (today ?? clinicTodayAsDate('UTC')).getUTCFullYear();
  const next = nextNumber(
    series.prefix,
    {
      current_number: series.current_number,
      reset_yearly: series.reset_yearly,
      last_reset_year: series.last_reset_year,
    },
    fiscalYear,
  );

  await db.invoice_series.update({
    where: { id: series.id },
    data: {
      current_number: next.current_number,
      last_reset_year: next.last_reset_year,
      updated_at: new Date(),
    },
  });
  return {
    invoice_number: formatInvoiceNumber(series.prefix, fiscalYear, next.sequential_number),
    sequential_number: next.sequential_number,
    fiscal_year: fiscalYear,
  };
}

export async function listSeries(
  db: Db,
  clinicId: string,
  seriesType: string | null,
  activeOnly: boolean,
): Promise<InvoiceSeriesDto[]> {
  const rows = await db.invoice_series.findMany({
    where: {
      clinic_id: clinicId,
      ...(seriesType ? { series_type: seriesType } : {}),
      ...(activeOnly ? { is_active: true } : {}),
    },
    orderBy: [{ series_type: 'asc' }, { prefix: 'asc' }],
  });
  return rows.map(toSeriesDto);
}

export async function getDefaultSeries(
  db: Db,
  clinicId: string,
  seriesType: string,
): Promise<{ id: string; prefix: string } | null> {
  const series = await db.invoice_series.findFirst({
    where: {
      clinic_id: clinicId,
      series_type: seriesType,
      is_default: true,
      is_active: true,
    },
  });
  return series ? { id: series.id, prefix: series.prefix } : null;
}

/**
 * Crée une série. Une `is_default` détrône les autres séries par défaut du
 * même type. La collision de préfixe lève `PrefixConflictError` (409 côté
 * routeur), comme le `IntegrityError` Python.
 */
export class PrefixConflictError extends Error {
  constructor() {
    super('A series with prefix already exists in this clinic');
    this.name = 'PrefixConflictError';
  }
}

export async function createSeries(
  db: Db,
  clinicId: string,
  data: {
    prefix: string;
    series_type: string;
    description?: string | null;
    reset_yearly?: boolean;
    is_default?: boolean;
  },
): Promise<InvoiceSeriesDto> {
  const existing = await db.invoice_series.findFirst({
    where: { clinic_id: clinicId, prefix: data.prefix },
    select: { id: true },
  });
  if (existing) throw new PrefixConflictError();

  if (data.is_default) {
    await db.$queryRaw`
      SELECT id FROM invoice_series
      WHERE clinic_id = ${clinicId}::uuid
        AND series_type = ${data.series_type}
        AND is_default = true
      FOR UPDATE`;
    await db.invoice_series.updateMany({
      where: { clinic_id: clinicId, series_type: data.series_type, is_default: true },
      data: { is_default: false, updated_at: new Date() },
    });
  }

  const now = new Date();
  try {
    const series = await db.invoice_series.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: clinicId,
        prefix: data.prefix,
        series_type: data.series_type,
        description: data.description ?? null,
        current_number: 0,
        reset_yearly: data.reset_yearly ?? true,
        // `date.today().year` (serveur, comme Python).
        last_reset_year: new Date().getUTCFullYear(),
        is_default: data.is_default ?? false,
        is_active: true,
        created_at: now,
        updated_at: now,
      },
    });
    return toSeriesDto(series);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new PrefixConflictError();
    }
    throw error;
  }
}

export async function getSeries(
  db: Db,
  clinicId: string,
  seriesId: string,
): Promise<Prisma.invoice_seriesGetPayload<object> | null> {
  return db.invoice_series.findFirst({ where: { id: seriesId, clinic_id: clinicId } });
}

export async function updateSeries(
  db: Db,
  series: Prisma.invoice_seriesGetPayload<object>,
  data: {
    prefix?: string | null;
    description?: string | null;
    reset_yearly?: boolean | null;
    is_default?: boolean | null;
    is_active?: boolean | null;
  },
  changedBy: string | null,
): Promise<InvoiceSeriesDto> {
  const previousState = {
    prefix: series.prefix,
    description: series.description,
    reset_yearly: series.reset_yearly,
    is_default: series.is_default,
    is_active: series.is_active,
  };

  if (data.is_default && !series.is_default) {
    await db.invoice_series.updateMany({
      where: {
        clinic_id: series.clinic_id,
        series_type: series.series_type,
        is_default: true,
        id: { not: series.id },
      },
      data: { is_default: false, updated_at: new Date() },
    });
  }

  const update: Prisma.invoice_seriesUpdateInput = { updated_at: new Date() };
  if ('prefix' in data && data.prefix !== null && data.prefix !== undefined) {
    update.prefix = data.prefix;
  }
  if ('description' in data) update.description = data.description ?? null;
  if ('reset_yearly' in data) update.reset_yearly = data.reset_yearly ?? false;
  if ('is_default' in data) update.is_default = data.is_default ?? false;
  if ('is_active' in data) update.is_active = data.is_active ?? false;

  let updated: Prisma.invoice_seriesGetPayload<object>;
  try {
    updated = await db.invoice_series.update({ where: { id: series.id }, data: update });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new PrefixConflictError();
    }
    throw error;
  }

  if (changedBy) {
    await addSeriesHistory(db, {
      clinic_id: updated.clinic_id,
      series_id: updated.id,
      action: 'updated',
      changed_by: changedBy,
      previous_state: previousState,
      new_state: {
        prefix: updated.prefix,
        description: updated.description,
        reset_yearly: updated.reset_yearly,
        is_default: updated.is_default,
        is_active: updated.is_active,
      },
    });
  }
  return toSeriesDto(updated);
}

/**
 * Remet le compteur à `newNumber` : doit dépasser le plus grand séquentiel
 * déjà émis pour l'année courante (séries à reset annuel) ou pour toujours.
 */
export async function resetSeriesCounter(
  db: Db,
  series: Prisma.invoice_seriesGetPayload<object>,
  newNumber: number,
  changedBy: string,
): Promise<InvoiceSeriesDto> {
  const maxRow = await db.invoices.aggregate({
    where: {
      series_id: series.id,
      clinic_id: series.clinic_id,
      ...(series.reset_yearly ? { fiscal_year: series.last_reset_year } : {}),
    },
    _max: { sequential_number: true },
  });
  const maxSequential = maxRow._max.sequential_number ?? 0;
  if (newNumber <= maxSequential) {
    fail400(`New number must be greater than ${maxSequential} (highest existing invoice number)`);
  }

  const previousNumber = series.current_number;
  const updated = await db.invoice_series.update({
    where: { id: series.id },
    data: { current_number: newNumber, updated_at: new Date() },
  });

  await addSeriesHistory(db, {
    clinic_id: updated.clinic_id,
    series_id: updated.id,
    action: 'reset',
    changed_by: changedBy,
    previous_state: { current_number: previousNumber },
    new_state: { current_number: newNumber },
    notes: `Counter reset from ${previousNumber} to ${newNumber}`,
  });
  return toSeriesDto(updated);
}

async function addSeriesHistory(
  db: Db,
  entry: {
    clinic_id: string;
    series_id: string;
    action: string;
    changed_by: string;
    previous_state?: unknown;
    new_state?: unknown;
    notes?: string | null;
  },
): Promise<void> {
  await db.invoice_series_history.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: entry.clinic_id,
      series_id: entry.series_id,
      action: entry.action,
      changed_by: entry.changed_by,
      changed_at: new Date(),
      previous_state: jsonOrNull(entry.previous_state ?? null),
      new_state: jsonOrNull(entry.new_state ?? null),
      notes: entry.notes ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Historique des factures (InvoiceHistoryService)
// ---------------------------------------------------------------------------

export async function addHistory(
  db: Db,
  entry: {
    clinic_id: string;
    invoice_id: string;
    action: string;
    changed_by: string;
    previous_state?: unknown;
    new_state?: unknown;
    notes?: string | null;
  },
): Promise<void> {
  await db.invoice_history.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: entry.clinic_id,
      invoice_id: entry.invoice_id,
      action: entry.action,
      changed_by: entry.changed_by,
      changed_at: new Date(),
      previous_state: jsonOrNull(entry.previous_state ?? null),
      new_state: jsonOrNull(entry.new_state ?? null),
      notes: entry.notes ?? null,
    },
  });
}

export async function listHistory(
  db: Db,
  clinicId: string,
  invoiceId: string,
): Promise<InvoiceHistoryDto[]> {
  const rows = await db.invoice_history.findMany({
    where: { clinic_id: clinicId, invoice_id: invoiceId },
    include: { users: { select: userSelect } },
    orderBy: { changed_at: 'desc' },
  });
  return rows.map((row) => ({
    id: row.id,
    invoice_id: row.invoice_id,
    action: row.action,
    changed_by: row.changed_by,
    changed_at: naiveIso(row.changed_at),
    previous_state: asJsonObject(row.previous_state),
    new_state: asJsonObject(row.new_state),
    notes: row.notes,
    user: toUserBrief(row.users),
  }));
}

// ---------------------------------------------------------------------------
// Lectures facture (InvoiceService.get_invoice / list_invoices)
// ---------------------------------------------------------------------------

export type InvoiceMode = 'base' | 'detail';

export async function getInvoice(
  db: Db,
  clinicId: string,
  invoiceId: string,
  mode: 'detail',
): Promise<InvoiceDetailRow | null>;
export async function getInvoice(
  db: Db,
  clinicId: string,
  invoiceId: string,
  mode?: 'base',
): Promise<InvoiceBaseRow | null>;
export async function getInvoice(
  db: Db,
  clinicId: string,
  invoiceId: string,
  mode: InvoiceMode = 'base',
): Promise<InvoiceBaseRow | InvoiceDetailRow | null> {
  if (mode === 'detail') {
    return db.invoices.findFirst({
      where: { id: invoiceId, clinic_id: clinicId, deleted_at: null },
      include: invoiceDetailInclude,
    });
  }
  return db.invoices.findFirst({
    where: { id: invoiceId, clinic_id: clinicId, deleted_at: null },
    include: invoiceBaseInclude,
  });
}

export interface ListInvoicesFilters {
  page: number;
  pageSize: number;
  patientId?: string | null;
  status?: string[] | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  dueFrom?: string | null;
  dueTo?: string | null;
  overdue?: boolean | null;
  search?: string | null;
  budgetId?: string | null;
  isCreditNote?: boolean | null;
  complianceSeverity?: string[] | null;
  sort?: string | null;
}

export async function listInvoices(
  db: Db,
  clinicId: string,
  timeZone: string,
  filters: ListInvoicesFilters,
): Promise<{ rows: InvoiceListRow[]; total: number }> {
  const where: Prisma.invoicesWhereInput = {
    clinic_id: clinicId,
    deleted_at: null,
  };

  if (filters.patientId) where.patient_id = filters.patientId;
  if (filters.status && filters.status.length > 0) where.status = { in: filters.status };
  if (filters.dateFrom) where.issue_date = { gte: dateOnlyFromString(filters.dateFrom) };
  if (filters.dateTo) {
    where.issue_date = { ...(where.issue_date as object), lte: dateOnlyFromString(filters.dateTo) };
  }
  if (filters.dueFrom) where.due_date = { gte: dateOnlyFromString(filters.dueFrom) };
  if (filters.dueTo) {
    where.due_date = { ...(where.due_date as object), lte: dateOnlyFromString(filters.dueTo) };
  }
  if (filters.overdue) {
    const today = clinicTodayAsDate(timeZone);
    where.due_date = { ...(where.due_date as object), lt: today };
    where.status = { in: ['issued', 'partial'] };
  }
  if (filters.budgetId) where.budget_id = filters.budgetId;
  if (filters.isCreditNote === true) where.credit_note_for_id = { not: null };
  if (filters.isCreditNote === false) where.credit_note_for_id = null;
  if (filters.search) {
    where.patients = {
      is: {
        OR: [
          { first_name: { contains: filters.search, mode: 'insensitive' } },
          { last_name: { contains: filters.search, mode: 'insensitive' } },
        ],
      },
    };
    where.OR = [
      { invoice_number: { contains: filters.search, mode: 'insensitive' } },
      { patients: { is: where.patients.is as Prisma.patientsWhereInput } },
    ];
  }

  const path = filters.complianceSeverity?.length
    ? `$.* ? (${filters.complianceSeverity.map((severity) => `@.severity == "${severity}"`).join(' || ')})`
    : null;

  if (path) {
    // jsonb_path_exists sur `compliance_data` ; le jsonpath est un paramètre
    // casté (comme `CAST(:jp AS jsonpath)` côté asyncpg).
    const ids = await db.$queryRaw<Array<{ id: string }>>`
      SELECT invoices.id FROM invoices
      WHERE invoices.clinic_id = ${clinicId}::uuid
        AND invoices.deleted_at IS NULL
        AND jsonb_path_exists(invoices.compliance_data, CAST(${path} AS jsonpath))`;
    const allowed = ids.map((row) => row.id);
    // Aucune correspondance → ensemble vide (and_() impossible en Prisma).
    if (allowed.length === 0) return { rows: [], total: 0 };
    where.id = { in: allowed };
  }

  const total = await db.invoices.count({ where });
  const rows = await db.invoices.findMany({
    where,
    include: invoiceListInclude,
    orderBy: parseInvoiceSort(filters.sort),
    skip: (filters.page - 1) * filters.pageSize,
    take: filters.pageSize,
  });
  return { rows, total };
}

// ---------------------------------------------------------------------------
// Calculs de lignes (InvoiceService.calculate_item_totals / recalculate_totals)
// ---------------------------------------------------------------------------

type ItemLike = {
  unit_price: Prisma.Decimal;
  quantity: number;
  discount_type: string | null;
  discount_value: Prisma.Decimal | null;
  vat_rate: number;
};

/** `(a / b).quantize(0.01)` en centimes, arrondi « half away from zero ». */
function divRoundBig(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  const sign = Math.sign(numerator) * Math.sign(denominator) || 1;
  const abs = Math.floor((Math.abs(numerator) + Math.abs(denominator) / 2) / Math.abs(denominator));
  return sign * abs;
}

function itemTotals(item: ItemLike): LineTotals {
  return computeLineTotals({
    unit_price: item.unit_price,
    quantity: item.quantity,
    discount_type: item.discount_type,
    discount_value: item.discount_value,
    vat_rate: item.vat_rate,
  });
}

async function recalculateTotals(db: Db, invoice: { id: string; clinic_id: string }): Promise<void> {
  const items = await db.invoice_items.findMany({ where: { invoice_id: invoice.id } });
  let subtotal = 0;
  let totalDiscount = 0;
  let totalTax = 0;
  let total = 0;
  for (const item of items) {
    subtotal += toCents(item.line_subtotal);
    totalDiscount += toCents(item.line_discount);
    totalTax += toCents(item.line_tax);
    total += toCents(item.line_total);
  }
  await db.invoices.update({
    where: { id: invoice.id },
    data: {
      subtotal: centsToDecimal(subtotal),
      total_discount: centsToDecimal(totalDiscount),
      total_tax: centsToDecimal(totalTax),
      total: centsToDecimal(total),
      updated_at: new Date(),
    },
  });
}

async function clinicVatRate(db: Db, clinicId: string, vatTypeId: string): Promise<number> {
  const vat = await db.vat_types.findFirst({
    where: { id: vatTypeId, clinic_id: clinicId },
    select: { rate: true },
  });
  if (!vat) fail400('VAT type not found');
  return vat.rate;
}

async function checkClinicCatalogItem(db: Db, clinicId: string, itemId: string): Promise<void> {
  const found = await db.treatment_catalog_items.findFirst({
    where: { id: itemId, clinic_id: clinicId },
    select: { id: true },
  });
  if (!found) fail400('Catalog item not found');
}

// ---------------------------------------------------------------------------
// Lignes de facture (InvoiceItemService)
// ---------------------------------------------------------------------------

export interface ItemCreateData {
  description: string;
  internal_code?: string | null;
  catalog_item_id?: string | null;
  unit_price: number;
  quantity?: number;
  discount_type?: string | null;
  discount_value?: number | null;
  vat_type_id?: string | null;
  vat_exempt_reason?: string | null;
  tooth_number?: number | null;
  surfaces?: string[] | null;
  display_order?: number;
}

function itemsIncludeById(db: Db, itemId: string) {
  return db.invoice_items.findUniqueOrThrow({ where: { id: itemId }, include: itemInclude });
}

export async function createItem(
  db: Db,
  clinicId: string,
  invoice: { id: string; clinic_id: string },
  data: ItemCreateData,
): Promise<InvoiceItemDto> {
  let vatRate = 0;
  if (data.vat_type_id) vatRate = await clinicVatRate(db, clinicId, data.vat_type_id);
  if (data.catalog_item_id) await checkClinicCatalogItem(db, clinicId, data.catalog_item_id);

  const draft: ItemLike = {
    unit_price: new Prisma.Decimal(data.unit_price.toFixed(2)),
    quantity: data.quantity ?? 1,
    discount_type: data.discount_type ?? null,
    discount_value:
      data.discount_value !== null && data.discount_value !== undefined && data.discount_value !== 0
        ? new Prisma.Decimal(data.discount_value.toFixed(2))
        : null,
    vat_rate: vatRate,
  };
  const totals = itemTotals(draft);
  const now = new Date();

  const created = await db.invoice_items.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: clinicId,
      invoice_id: invoice.id,
      budget_item_id: null,
      catalog_item_id: data.catalog_item_id ?? null,
      description: data.description,
      internal_code: data.internal_code ?? null,
      unit_price: draft.unit_price,
      quantity: draft.quantity,
      discount_type: draft.discount_type,
      discount_value: draft.discount_value,
      vat_type_id: data.vat_type_id ?? null,
      vat_rate: vatRate,
      vat_exempt_reason: data.vat_exempt_reason ?? null,
      line_subtotal: centsToDecimal(totals.line_subtotal),
      line_discount: centsToDecimal(totals.line_discount),
      line_tax: centsToDecimal(totals.line_tax),
      line_total: centsToDecimal(totals.line_total),
      tooth_number: data.tooth_number ?? null,
      surfaces: jsonOrNull(data.surfaces ?? null),
      display_order: data.display_order ?? 0,
      created_at: now,
      updated_at: now,
    },
  });

  await recalculateTotals(db, invoice);
  return toItemDto(await itemsIncludeById(db, created.id));
}

export interface ItemUpdateData {
  description?: string | null;
  unit_price?: number | null;
  quantity?: number | null;
  discount_type?: string | null;
  discount_value?: number | null;
  vat_type_id?: string | null;
  vat_exempt_reason?: string | null;
  display_order?: number | null;
}

export async function updateItem(
  db: Db,
  clinicId: string,
  item: Prisma.invoice_itemsGetPayload<object>,
  invoice: { id: string; clinic_id: string },
  data: ItemUpdateData,
): Promise<InvoiceItemDto> {
  const update: Prisma.invoice_itemsUncheckedUpdateInput = { updated_at: new Date() };
  if ('description' in data && data.description !== null && data.description !== undefined) {
    update.description = data.description;
  }
  if ('unit_price' in data && data.unit_price !== null && data.unit_price !== undefined) {
    update.unit_price = new Prisma.Decimal(data.unit_price.toFixed(2));
  }
  if ('quantity' in data && data.quantity !== null && data.quantity !== undefined) {
    update.quantity = data.quantity;
  }
  if ('discount_type' in data) update.discount_type = data.discount_type ?? null;
  if ('discount_value' in data) {
    update.discount_value =
      data.discount_value !== null && data.discount_value !== undefined && data.discount_value !== 0
        ? new Prisma.Decimal(data.discount_value.toFixed(2))
        : null;
  }
  if ('vat_type_id' in data) {
    const vatTypeId = data.vat_type_id ?? null;
    update.vat_rate = vatTypeId ? await clinicVatRate(db, clinicId, vatTypeId) : 0;
    update.vat_type_id = vatTypeId;
  }
  if ('vat_exempt_reason' in data) update.vat_exempt_reason = data.vat_exempt_reason ?? null;
  if ('display_order' in data && data.display_order !== null && data.display_order !== undefined) {
    update.display_order = data.display_order;
  }

  const merged = {
    ...item,
    ...update,
  } as unknown as ItemLike;
  const totals = itemTotals(merged);
  update.line_subtotal = centsToDecimal(totals.line_subtotal);
  update.line_discount = centsToDecimal(totals.line_discount);
  update.line_tax = centsToDecimal(totals.line_tax);
  update.line_total = centsToDecimal(totals.line_total);

  const updated = await db.invoice_items.update({ where: { id: item.id }, data: update });
  await recalculateTotals(db, invoice);
  await resyncInvoicedQuantities(db, clinicId, [updated.budget_item_id]);
  return toItemDto(await itemsIncludeById(db, updated.id));
}

export async function deleteItem(
  db: Db,
  item: Prisma.invoice_itemsGetPayload<object>,
  invoice: { id: string; clinic_id: string },
): Promise<void> {
  const budgetItemId = item.budget_item_id;
  // Hook `on_draft_item_deleted` : aucun module country n'est enregistré
  // sur le backend Express (registre vide côté Python aussi).
  await db.invoice_items.delete({ where: { id: item.id } });
  await recalculateTotals(db, invoice);
  await resyncInvoicedQuantities(db, invoice.clinic_id, [budgetItemId]);
}

// ---------------------------------------------------------------------------
// Quantités facturées (resync_invoiced_quantities)
// ---------------------------------------------------------------------------

/**
 * Recalcule `budget_items.invoiced_quantity` depuis les lignes vivantes :
 * une ligne compte tant que son document n'est pas supprimé/annulé, les
 * lignes d'avoir se soustraient. Idempotent.
 */
export async function resyncInvoicedQuantities(
  db: Db,
  clinicId: string,
  budgetItemIds: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const ids = [...new Set(budgetItemIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return;

  const rows = await db.$queryRaw<
    Array<{ budget_item_id: string; signed_qty: number | bigint | null }>
  >`
    SELECT invoice_items.budget_item_id,
           SUM(CASE WHEN invoices.credit_note_for_id IS NOT NULL
                    THEN -invoice_items.quantity ELSE invoice_items.quantity END) AS signed_qty
    FROM invoice_items
    JOIN invoices ON invoices.id = invoice_items.invoice_id
    WHERE invoices.clinic_id = ${clinicId}::uuid
      AND invoices.deleted_at IS NULL
      AND invoice_items.budget_item_id = ANY(${ids}::uuid[])
    GROUP BY invoice_items.budget_item_id`;
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.budget_item_id, Number(row.signed_qty ?? 0));
  }

  const items = await db.budget_items.findMany({
    where: { id: { in: ids }, clinic_id: clinicId },
    select: { id: true, invoiced_quantity: true },
  });
  for (const item of items) {
    const next = Math.max(0, totals.get(item.id) ?? 0);
    if (next !== item.invoiced_quantity) {
      await db.budget_items.update({
        where: { id: item.id },
        data: { invoiced_quantity: next, updated_at: new Date() },
      });
    }
  }
}

export async function resyncInvoicedQuantitiesForInvoice(
  db: Db,
  invoice: { id: string; clinic_id: string },
): Promise<void> {
  const rows = await db.invoice_items.findMany({
    where: { invoice_id: invoice.id, budget_item_id: { not: null } },
    select: { budget_item_id: true },
  });
  await resyncInvoicedQuantities(
    db,
    invoice.clinic_id,
    rows.map((row) => row.budget_item_id),
  );
}

// ---------------------------------------------------------------------------
// Workflow (InvoiceWorkflowService)
// ---------------------------------------------------------------------------

export const VALID_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ['issued', 'voided'],
  issued: ['paid', 'partial', 'cancelled'],
  partial: ['paid', 'cancelled'],
  paid: [],
  cancelled: [],
  voided: [],
};

export function canTransition(currentStatus: string, newStatus: string): boolean {
  return (VALID_TRANSITIONS[currentStatus] ?? []).includes(newStatus);
}

export function canEdit(invoice: { status: string }): boolean {
  return invoice.status === 'draft';
}

export function canIssue(invoice: { status: string }, itemCount: number): boolean {
  return invoice.status === 'draft' && itemCount > 0;
}

export function canRecordPayment(invoice: { status: string }): boolean {
  return invoice.status === 'issued' || invoice.status === 'partial';
}

export function canVoid(invoice: { status: string }): boolean {
  return invoice.status === 'draft';
}

export function canCreateCreditNote(invoice: {
  credit_note_for_id: string | null;
  status: string;
}): boolean {
  if (invoice.credit_note_for_id !== null) return false;
  return invoice.status === 'issued' || invoice.status === 'partial' || invoice.status === 'paid';
}

/** Montant créditable restant sur la facture d'origine (centimes). */
async function creditableCheck(
  db: Db,
  creditNote: { id: string; clinic_id: string; credit_note_for_id: string | null; total: Prisma.Decimal },
): Promise<void> {
  // Verrouille la facture d'origine : deux avoirs concurrents sont
  // contrôlés l'un après l'autre.
  const originals = await db.$queryRaw<Array<{ total: Prisma.Decimal }>>`
    SELECT total FROM invoices
    WHERE id = ${creditNote.credit_note_for_id}::uuid AND clinic_id = ${creditNote.clinic_id}::uuid
    FOR UPDATE`;
  if (originals.length === 0) {
    // `scalar_one()` Python lève : la FK garantit normalement la présence.
    throw new BillingValueError('Original invoice not found');
  }
  const originalTotal = toCents(originals[0]!.total);

  const others = await db.invoices.aggregate({
    where: {
      credit_note_for_id: creditNote.credit_note_for_id,
      id: { not: creditNote.id },
      status: { notIn: ['voided', 'cancelled'] },
      deleted_at: null,
    },
    _sum: { total: true },
  });
  // Les totaux d'avoir sont négatifs.
  const alreadyCredited = -toCents(others._sum.total ?? 0);
  const remaining = originalTotal - alreadyCredited;
  const requested = -toCents(creditNote.total);
  if (requested > remaining) {
    fail400(
      `Credit note of ${centsToDecimal(requested).toFixed(2)} exceeds the amount still creditable `
        + `on this invoice (${centsToDecimal(remaining).toFixed(2)}); other credit notes, drafts included, `
        + `already cover ${centsToDecimal(alreadyCredited).toFixed(2)}`,
    );
  }
}

export interface IssueOptions {
  issuedBy: string;
  issueDate?: Date | null;
  /** Date calendaire de la clinique (année du numéro et date par défaut). */
  today: Date;
}

/**
 * Émet une facture/avoir (draft → issued).
 *
 * Aucun hook de conformité n'est enregistré sur Express (registre vide par
 * défaut côté Python) : le contrôle strict du `billing_tax_id` s'applique.
 */
export async function issueInvoice(
  db: Db,
  invoiceId: string,
  options: IssueOptions,
): Promise<InvoiceBaseRow> {
  const invoice = await db.invoices.findFirst({
    where: { id: invoiceId },
    include: { invoice_items: true, patients: { select: patientSelect } },
  });
  if (!invoice) throw new BillingValueError('Invoice not found');

  if (!canIssue(invoice, invoice.invoice_items.length)) {
    if (invoice.status !== 'draft') {
      fail400(`Cannot issue invoice from status '${invoice.status}'`);
    }
    fail400('Cannot issue empty invoice');
  }

  let billingName = invoice.billing_name;
  let billingTaxId = invoice.billing_tax_id;
  let billingAddress = invoice.billing_address;
  let billingEmail = invoice.billing_email;

  if (billingName === null) {
    const patient = invoice.patients;
    if (!patient) fail400('Patient not found');
    // Snapshot des données de facturation du patient.
    billingName = patient.billing_name || `${patient.first_name} ${patient.last_name}`;
    billingTaxId =
      patient.billing_tax_id ??
      (patient.national_id && patient.national_id_type !== 'passport' ? patient.national_id : null);
    billingAddress = patient.billing_address;
    billingEmail = patient.billing_email ?? patient.email;
  }

  const billingErrors: string[] = [];
  if (!billingName) billingErrors.push('billing_name is required');
  if (!billingTaxId) {
    // Pas de hook pays → `billing_tax_id` obligatoire.
    billingErrors.push('billing_tax_id is required (update patient billing info)');
  }
  if (billingErrors.length > 0) {
    fail400(`Cannot issue invoice: incomplete billing data. ${billingErrors.join(', ')}`);
  }

  if (invoice.credit_note_for_id !== null) {
    await creditableCheck(db, invoice);
  }

  let invoiceNumber = invoice.invoice_number;
  let sequentialNumber = invoice.sequential_number;
  let fiscalYear = invoice.fiscal_year;
  let seriesId = invoice.series_id;

  if (invoiceNumber === null) {
    if (!seriesId) {
      const seriesType = invoice.credit_note_for_id ? 'credit_note' : 'invoice';
      const series = await getDefaultSeries(db, invoice.clinic_id, seriesType);
      if (!series) fail400(`No default ${seriesType} series configured`);
      seriesId = series.id;
    }
    const generated = await generateNumber(db, invoice.clinic_id, seriesId, options.today);
    invoiceNumber = generated.invoice_number;
    sequentialNumber = generated.sequential_number;
    fiscalYear = generated.fiscal_year;
  }

  const previousStatus = invoice.status;
  const issueDate = options.issueDate ?? options.today;
  const dueDate =
    invoice.due_date ?? new Date(issueDate.getTime() + invoice.payment_term_days * 86400000);

  const updated = await db.invoices.update({
    where: { id: invoice.id },
    data: {
      status: 'issued',
      invoice_number: invoiceNumber,
      sequential_number: sequentialNumber,
      fiscal_year: fiscalYear,
      series_id: seriesId,
      issue_date: issueDate,
      due_date: dueDate,
      issued_by: options.issuedBy,
      billing_name: billingName,
      billing_tax_id: billingTaxId,
      billing_address: jsonOrNull(billingAddress),
      billing_email: billingEmail,
      updated_at: new Date(),
    },
    include: { invoice_items: true },
  });

  await addHistory(db, {
    clinic_id: updated.clinic_id,
    invoice_id: updated.id,
    action: 'issued',
    changed_by: options.issuedBy,
    previous_state: { status: previousStatus },
    new_state: {
      status: 'issued',
      issue_date: formatDateOnly(updated.issue_date),
      due_date: formatDateOnly(updated.due_date),
    },
  });

  if (updated.credit_note_for_id) {
    // L'avoir ne change pas le statut de la facture d'origine ; l'historique
    // de celle-ci garde la trace de l'émission.
    const original = await db.invoices.findUnique({ where: { id: updated.credit_note_for_id } });
    if (original) {
      await addHistory(db, {
        clinic_id: original.clinic_id,
        invoice_id: original.id,
        action: 'credit_note_issued',
        changed_by: options.issuedBy,
        previous_state: {},
        new_state: {
          credit_note_id: updated.id,
          credit_note_number: updated.invoice_number,
          credit_note_total: updated.total.toFixed(2),
        },
        notes: 'Credit note issued. Original invoice status unchanged.',
      });
    }
  }

  // Les acomptes déjà perçus sur le devis rejoignent la facture (#178).
  if (updated.credit_note_for_id === null) {
    await sweepBudgetIntoInvoice(db, { invoice: updated, actorId: options.issuedBy });
  }

  const reloaded = await db.invoices.findUniqueOrThrow({
    where: { id: updated.id },
    include: invoiceBaseInclude,
  });
  return reloaded;
}

/** `datetime` fourni par le client (ISO, naïf interprété comme UTC). */
export function parseInstantInput(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const trimmed = value.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const parsed = new Date(hasZone ? trimmed : `${trimmed}Z`);
  if (Number.isNaN(parsed.getTime())) fail400(`Invalid datetime value: ${value}`);
  return parsed;
}

/**
 * Édition du destinataire fiscal d'une facture émise. Sans hook pays, une
 * facture non brouillon est immuable (422 via `InvoiceWorkflowError`).
 */
export async function updateBillingParty(
  db: Db,
  invoice: Prisma.invoicesGetPayload<object>,
  params: {
    newName: string | null | undefined;
    newTaxId: string | null | undefined;
    newAddress: Record<string, unknown> | null | undefined;
    expectedUpdatedAt: Date | null;
    changedBy: string;
  },
): Promise<Prisma.invoicesGetPayload<object>> {
  if (params.expectedUpdatedAt !== null && invoice.updated_at !== null) {
    if (Math.abs(invoice.updated_at.getTime() - params.expectedUpdatedAt.getTime()) > 1000) {
      fail400('concurrent edit detected — refresh and try again');
    }
  }

  if (invoice.status !== 'draft') {
    fail400(`Cannot edit billing party on invoice with status '${invoice.status}'`);
  }

  const previous = {
    billing_name: invoice.billing_name,
    billing_tax_id: invoice.billing_tax_id,
    billing_address: asJsonObject(invoice.billing_address),
  };
  const update: Prisma.invoicesUncheckedUpdateInput = { updated_at: new Date() };
  if (params.newName !== null && params.newName !== undefined) {
    update.billing_name = params.newName.trim() || null;
  }
  if (params.newTaxId !== null && params.newTaxId !== undefined) {
    update.billing_tax_id = params.newTaxId.trim().toUpperCase() || null;
  }
  if (params.newAddress !== null && params.newAddress !== undefined) {
    update.billing_address = params.newAddress as Prisma.InputJsonValue;
  }

  const updated = await db.invoices.update({ where: { id: invoice.id }, data: update });

  await addHistory(db, {
    clinic_id: updated.clinic_id,
    invoice_id: updated.id,
    action: 'billing_party_updated',
    changed_by: params.changedBy,
    previous_state: previous,
    new_state: {
      billing_name: updated.billing_name,
      billing_tax_id: updated.billing_tax_id,
      billing_address: asJsonObject(updated.billing_address),
    },
  });
  return updated;
}

export async function voidInvoice(
  db: Db,
  invoice: Prisma.invoicesGetPayload<object> | InvoiceBaseRow,
  voidedBy: string,
  reason: string | null,
): Promise<InvoiceBaseRow> {
  if (!canVoid(invoice)) fail400(`Cannot void invoice from status '${invoice.status}'`);

  const previousStatus = invoice.status;
  const updated = await db.invoices.update({
    where: { id: invoice.id },
    data: { status: 'voided', deleted_at: new Date(), updated_at: new Date() },
  });

  await addHistory(db, {
    clinic_id: updated.clinic_id,
    invoice_id: updated.id,
    action: 'voided',
    changed_by: voidedBy,
    previous_state: { status: previousStatus },
    new_state: { status: 'voided', reason },
  });
  await resyncInvoicedQuantitiesForInvoice(db, updated);
  const reloaded = await db.invoices.findUniqueOrThrow({
    where: { id: updated.id },
    include: invoiceBaseInclude,
  });
  return reloaded;
}

/**
 * Recalcule `status` depuis `invoice_payments`.
 * `balance_due <= 0` et total > 0 → paid ; total_paid > 0 → partial ;
 * sinon issued. Les brouillons/annulées ne bougent jamais.
 */
export async function recalcInvoiceStatus(
  db: Db,
  invoice: { id: string; clinic_id: string; status: string; total: Prisma.Decimal },
  actorId: string,
): Promise<string> {
  const { paid, balance } = await paidSummaryCents(db, invoice.clinic_id, invoice.id);

  if (invoice.status === 'draft' || invoice.status === 'cancelled' || invoice.status === 'voided') {
    return invoice.status;
  }

  const previousStatus = invoice.status;
  let status: string;
  if (balance <= 0 && toCents(invoice.total) > 0) status = 'paid';
  else if (paid > 0) status = 'partial';
  else status = 'issued';

  if (status !== previousStatus) {
    await db.invoices.update({
      where: { id: invoice.id },
      data: { status, updated_at: new Date() },
    });
    await addHistory(db, {
      clinic_id: invoice.clinic_id,
      invoice_id: invoice.id,
      action: 'status_recomputed',
      changed_by: actorId,
      previous_state: { status: previousStatus },
      new_state: {
        status,
        total_paid: centsToDecimal(paid).toFixed(2),
        balance_due: centsToDecimal(balance).toFixed(2),
      },
    });
  }
  return status;
}

export interface CreditNoteItemSpec {
  invoice_item_id: string;
  quantity?: number | null;
}

/** Crée un avoir (rectificativa) en brouillon, montants négatifs. */
export async function createCreditNote(
  db: Db,
  originalInvoice: InvoiceDetailRow | InvoiceBaseRow,
  params: {
    createdBy: string;
    reason: string;
    items?: CreditNoteItemSpec[] | null;
    seriesId?: string | null;
  },
): Promise<string> {
  if (!canCreateCreditNote(originalInvoice)) {
    fail400(`Cannot create credit note for invoice with status '${originalInvoice.status}'`);
  }

  const now = new Date();
  const creditNoteId = crypto.randomUUID();

  await db.invoices.create({
    data: {
      id: creditNoteId,
      clinic_id: originalInvoice.clinic_id,
      patient_id: originalInvoice.patient_id,
      invoice_number: null,
      series_id: params.seriesId ?? null,
      sequential_number: null,
      fiscal_year: null,
      budget_id: null,
      credit_note_for_id: originalInvoice.id,
      status: 'draft',
      issue_date: null,
      due_date: null,
      payment_term_days: 0,
      billing_name: originalInvoice.billing_name,
      billing_tax_id: originalInvoice.billing_tax_id,
      billing_address: jsonOrNull(asJsonObject(originalInvoice.billing_address)),
      billing_email: originalInvoice.billing_email,
      subtotal: new Prisma.Decimal(0),
      total_discount: new Prisma.Decimal(0),
      total_tax: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      internal_notes: `Nota de crédito por: ${params.reason}`,
      public_notes: `Rectificación de factura ${originalInvoice.invoice_number ?? ''}`,
      compliance_data: Prisma.DbNull,
      document_hash: null,
      previous_hash: null,
      pdf_stale: false,
      created_by: params.createdBy,
      issued_by: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    },
  });

  type CreditSource = {
    id: string;
    budget_item_id: string | null;
    catalog_item_id: string | null;
    description: string;
    internal_code: string | null;
    unit_price: Prisma.Decimal;
    quantity: number;
    discount_type: string | null;
    discount_value: Prisma.Decimal | null;
    vat_type_id: string | null;
    vat_rate: number;
    vat_exempt_reason: string | null;
    tooth_number: number | null;
    surfaces: Prisma.JsonValue;
    display_order: number;
  };
  let sources: CreditSource[] = [];
  if ('invoice_items' in originalInvoice) {
    sources = await db.invoice_items.findMany({
      where: { invoice_id: originalInvoice.id },
      orderBy: { display_order: 'asc' },
    });
  }

  const createLine = async (source: CreditSource, quantity: number, displayOrder: number) => {
    const negated: ItemLike = {
      unit_price: source.unit_price.negated(),
      quantity,
      discount_type: source.discount_type,
      discount_value: source.discount_value,
      vat_rate: source.vat_rate,
    };
    const totals = itemTotals(negated);
    const at = new Date();
    await db.invoice_items.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: originalInvoice.clinic_id,
        invoice_id: creditNoteId,
        budget_item_id: source.budget_item_id,
        catalog_item_id: source.catalog_item_id,
        description: source.description,
        internal_code: source.internal_code,
        unit_price: negated.unit_price,
        quantity,
        discount_type: negated.discount_type,
        discount_value: negated.discount_value,
        vat_type_id: source.vat_type_id,
        vat_rate: source.vat_rate,
        vat_exempt_reason: source.vat_exempt_reason,
        line_subtotal: centsToDecimal(totals.line_subtotal),
        line_discount: centsToDecimal(totals.line_discount),
        line_tax: centsToDecimal(totals.line_tax),
        line_total: centsToDecimal(totals.line_total),
        tooth_number: source.tooth_number,
        surfaces: jsonOrNull(source.surfaces),
        display_order: displayOrder,
        created_at: at,
        updated_at: at,
      },
    });
  };

  if (params.items && params.items.length > 0) {
    for (const spec of params.items) {
      const source = sources.find((item) => item.id === spec.invoice_item_id);
      if (!source) fail400(`Item ${spec.invoice_item_id} not found in original invoice`);
      const quantity = spec.quantity ?? source.quantity;
      if (quantity > source.quantity) {
        fail400(`Credit note quantity (${quantity}) exceeds original (${source.quantity})`);
      }
      await createLine(source, quantity, source.display_order);
    }
  } else {
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      await createLine(source, source.quantity, index);
    }
  }

  await recalculateTotals(db, { id: creditNoteId, clinic_id: originalInvoice.clinic_id });
  const creditNote = await db.invoices.findUniqueOrThrow({ where: { id: creditNoteId } });
  await creditableCheck(db, creditNote);

  await addHistory(db, {
    clinic_id: creditNote.clinic_id,
    invoice_id: creditNote.id,
    action: 'created',
    changed_by: params.createdBy,
    new_state: {
      status: 'draft',
      credit_note_for: originalInvoice.invoice_number,
      reason: params.reason,
    },
  });

  await resyncInvoicedQuantitiesForInvoice(db, creditNote);
  return creditNoteId;
}

// ---------------------------------------------------------------------------
// Création de factures
// ---------------------------------------------------------------------------

export async function createInvoice(
  db: Db,
  clinicId: string,
  createdBy: string,
  params: {
    patientId: string;
    seriesId?: string | null;
    paymentTermDays: number;
    dueDate: Date | null;
    internalNotes: string | null;
    publicNotes: string | null;
  },
): Promise<{ id: string; clinic_id: string }> {
  const patient = await db.patients.findFirst({
    where: { id: params.patientId, clinic_id: clinicId },
    select: { id: true },
  });
  if (!patient) fail400('Patient not found');

  if (params.seriesId) {
    const series = await db.invoice_series.findFirst({
      where: { id: params.seriesId, clinic_id: clinicId },
      select: { id: true },
    });
    if (!series) fail400('Invoice series not found');
  }

  const now = new Date();
  const id = crypto.randomUUID();
  // Un brouillon ne stocke pas les données fiscales (reprises du patient à
  // l'émission) et n'a pas encore de numéro.
  await db.invoices.create({
    data: {
      id,
      clinic_id: clinicId,
      patient_id: params.patientId,
      invoice_number: null,
      series_id: params.seriesId ?? null,
      sequential_number: null,
      fiscal_year: null,
      budget_id: null,
      credit_note_for_id: null,
      status: 'draft',
      issue_date: null,
      due_date: params.dueDate,
      payment_term_days: params.paymentTermDays,
      billing_name: null,
      billing_tax_id: null,
      billing_address: Prisma.DbNull,
      billing_email: null,
      subtotal: new Prisma.Decimal(0),
      total_discount: new Prisma.Decimal(0),
      total_tax: new Prisma.Decimal(0),
      total: new Prisma.Decimal(0),
      internal_notes: params.internalNotes,
      public_notes: params.publicNotes,
      compliance_data: Prisma.DbNull,
      document_hash: null,
      previous_hash: null,
      pdf_stale: false,
      created_by: createdBy,
      issued_by: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    },
  });

  await addHistory(db, {
    clinic_id: clinicId,
    invoice_id: id,
    action: 'created',
    changed_by: createdBy,
    new_state: { status: 'draft' },
  });
  return { id, clinic_id: clinicId };
}

export interface InvoiceUpdateData {
  patient_id?: string | null;
  payment_term_days?: number | null;
  due_date?: Date | null;
  internal_notes?: string | null;
  public_notes?: string | null;
}

export async function updateInvoice(
  db: Db,
  invoice: Prisma.invoicesGetPayload<object>,
  updatedBy: string,
  data: InvoiceUpdateData,
): Promise<void> {
  if (!canEdit(invoice)) fail400('Can only edit draft invoices');

  const previous: Record<string, unknown> = {};
  const update: Prisma.invoicesUncheckedUpdateInput = { updated_at: new Date() };

  if (data.patient_id) {
    if (data.patient_id !== invoice.patient_id) {
      if (invoice.budget_id) fail400('Cannot change patient for invoice linked to a budget');
      const patient = await db.patients.findFirst({
        where: { id: data.patient_id, clinic_id: invoice.clinic_id },
        select: { id: true },
      });
      if (!patient) fail400('Patient not found');
      previous.patient_id = invoice.patient_id;
      update.patient_id = data.patient_id;
    }
  }

  if ('payment_term_days' in data && data.payment_term_days !== null && data.payment_term_days !== undefined) {
    previous.payment_term_days = invoice.payment_term_days;
    update.payment_term_days = data.payment_term_days;
  }
  if ('due_date' in data) {
    previous.due_date = formatDateOnly(invoice.due_date);
    update.due_date = data.due_date ?? null;
  }
  if ('internal_notes' in data) {
    previous.internal_notes = invoice.internal_notes;
    update.internal_notes = data.internal_notes ?? null;
  }
  if ('public_notes' in data) {
    previous.public_notes = invoice.public_notes;
    update.public_notes = data.public_notes ?? null;
  }

  const updated = await db.invoices.update({ where: { id: invoice.id }, data: update });

  if (Object.keys(previous).length > 0) {
    const newState: Record<string, string> = {};
    for (const key of Object.keys(previous)) {
      const value = (updated as unknown as Record<string, unknown>)[key];
      newState[key] = value === null || value === undefined ? 'None' : String(value instanceof Date ? formatDateOnly(value) : value);
    }
    await addHistory(db, {
      clinic_id: invoice.clinic_id,
      invoice_id: invoice.id,
      action: 'updated',
      changed_by: updatedBy,
      previous_state: previous,
      new_state: newState,
    });
  }
}

export async function deleteInvoice(
  db: Db,
  invoice: Prisma.invoicesGetPayload<object>,
  deletedBy: string,
): Promise<void> {
  if (!canEdit(invoice)) fail400('Can only delete draft invoices');

  await db.invoices.update({
    where: { id: invoice.id },
    data: { deleted_at: new Date(), updated_at: new Date() },
  });
  await addHistory(db, {
    clinic_id: invoice.clinic_id,
    invoice_id: invoice.id,
    action: 'deleted',
    changed_by: deletedBy,
  });
  await resyncInvoicedQuantitiesForInvoice(db, { id: invoice.id, clinic_id: invoice.clinic_id });
}

/** `catalog_name(names)` : première langue disponible (en → es → première). */
function catalogName(names: Record<string, unknown>): string | null {
  for (const key of ['en', 'es']) {
    const value = names[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  for (const value of Object.values(names)) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

export interface FromBudgetItemSpec {
  budget_item_id: string;
  quantity?: number | null;
}

/** Facture un devis accepté/terminé, partiellement ou totalement. */
export async function createFromBudget(
  db: Db,
  clinicId: string,
  createdBy: string,
  params: {
    budgetId: string;
    items: FromBudgetItemSpec[];
    paymentTermDays: number | null;
    dueDate: Date | null;
    internalNotes: string | null;
    publicNotes: string | null;
  },
): Promise<{ id: string }> {
  // Sérialise les assistants concurrents sur le même devis (contrôle de
  // quantité disponible ci-dessous).
  await lockBudget(db, clinicId, params.budgetId);

  const budget = await db.budgets.findFirst({
    where: { id: params.budgetId, clinic_id: clinicId, deleted_at: null },
    include: {
      budget_items: { include: { treatment_catalog_items: true } },
    },
  });
  if (!budget) fail400('Budget not found');
  if (budget.status !== 'accepted' && budget.status !== 'completed') {
    fail400(`Cannot invoice budget with status '${budget.status}'`);
  }

  const invoice = await createInvoice(db, clinicId, createdBy, {
    patientId: budget.patient_id,
    seriesId: null,
    paymentTermDays: params.paymentTermDays || 30,
    dueDate: params.dueDate,
    internalNotes: params.internalNotes,
    publicNotes: params.publicNotes,
  });
  await db.invoices.update({
    where: { id: invoice.id },
    data: { budget_id: params.budgetId, updated_at: new Date() },
  });

  const itemsById = new Map(budget.budget_items.map((item) => [item.id, item]));
  const shares = allocateGlobalDiscount(budget.global_discount_type, budget.global_discount_value, budget.budget_items);
  const globalShares = new Map(budget.budget_items.map((item, index) => [item.id, shares[index] ?? 0]));

  for (const spec of params.items) {
    const budgetItem = itemsById.get(spec.budget_item_id);
    if (!budgetItem) fail400(`Budget item ${spec.budget_item_id} not found`);

    const available = budgetItem.quantity - budgetItem.invoiced_quantity;
    if (available <= 0) fail400(`Budget item ${spec.budget_item_id} is fully invoiced`);

    let quantity: number;
    if (spec.quantity === null || spec.quantity === undefined) {
      quantity = available;
    } else {
      if (spec.quantity > available) {
        fail400(`Requested quantity (${spec.quantity}) exceeds available (${available})`);
      }
      quantity = spec.quantity;
    }

    let description = 'Unknown treatment';
    let internalCode: string | null = null;
    const catalog = budgetItem.treatment_catalog_items;
    if (catalog) {
      const names = (catalog.names as Record<string, unknown> | null) ?? {};
      description = catalogName(names) ?? description;
      internalCode = catalog.internal_code;
    }

    // La remise globale du devis est répartie hors taxe sur chaque ligne
    // (Verifactu dérive la base par ligne).
    const globalShare = globalShares.get(spec.budget_item_id) ?? 0;
    const lineDiscount = toCents(budgetItem.line_discount) + globalShare;
    let discountType: string | null;
    let discountValue: number | null;
    if (globalShare === 0 && budgetItem.discount_type === 'percentage') {
      discountType = 'percentage';
      discountValue = dec(budgetItem.discount_value);
    } else if (lineDiscount > 0) {
      discountType = 'absolute';
      discountValue = divRoundBig(lineDiscount * quantity, budgetItem.quantity);
    } else {
      discountType = null;
      discountValue = null;
    }

    const line: ItemLike = {
      unit_price: budgetItem.unit_price,
      quantity,
      discount_type: discountType,
      discount_value: discountValue === null ? null : new Prisma.Decimal(discountValue.toFixed(2)),
      vat_rate: budgetItem.vat_rate,
    };
    const totals = itemTotals(line);
    const now = new Date();
    await db.invoice_items.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: clinicId,
        invoice_id: invoice.id,
        budget_item_id: budgetItem.id,
        catalog_item_id: budgetItem.catalog_item_id,
        description,
        internal_code: internalCode,
        unit_price: line.unit_price,
        quantity,
        discount_type: line.discount_type,
        discount_value: line.discount_value,
        vat_type_id: budgetItem.vat_type_id,
        vat_rate: budgetItem.vat_rate,
        vat_exempt_reason: null,
        line_subtotal: centsToDecimal(totals.line_subtotal),
        line_discount: centsToDecimal(totals.line_discount),
        line_tax: centsToDecimal(totals.line_tax),
        line_total: centsToDecimal(totals.line_total),
        tooth_number: budgetItem.tooth_number,
        surfaces: jsonOrNull(budgetItem.surfaces),
        display_order: budgetItem.display_order,
        created_at: now,
        updated_at: now,
      },
    });
  }

  await recalculateTotals(db, { id: invoice.id, clinic_id: clinicId });
  await resyncInvoicedQuantitiesForInvoice(db, { id: invoice.id, clinic_id: clinicId });
  return invoice;
}

// ---------------------------------------------------------------------------
// Pont devis ↔ facture (payment_bridge)
// ---------------------------------------------------------------------------

/** Sérialise toute imputation touchant ce devis (verrou devis → factures). */
export async function lockBudget(db: Db, clinicId: string, budgetId: string): Promise<void> {
  await db.$queryRaw`
    SELECT id FROM budgets
    WHERE id = ${budgetId}::uuid AND clinic_id = ${clinicId}::uuid
    FOR UPDATE`;
}

/** Factures émises/partielles du devis, verrouillées, facture préférée en tête. */
async function openInvoices(
  db: Db,
  clinicId: string,
  budgetId: string,
  preferInvoiceId: string | null,
): Promise<Array<{ id: string }>> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM invoices
    WHERE clinic_id = ${clinicId}::uuid
      AND budget_id = ${budgetId}::uuid
      AND status IN ('issued', 'partial')
      AND credit_note_for_id IS NULL
      AND deleted_at IS NULL
    ORDER BY issue_date, created_at, id
    FOR UPDATE`;
  if (preferInvoiceId === null) return rows;
  const preferred = rows.filter((row) => row.id === preferInvoiceId);
  const others = rows.filter((row) => row.id !== preferInvoiceId);
  return [...preferred, ...others];
}

/**
 * Aligne `invoice_payments` sur les allocations devis du paiement :
 * excédent imputé FIFO sur les factures ouvertes du devis (plafonné au solde
 * dû), excès retiré LIFO. Idempotent ; statuts recalculés pour les factures
 * dont les liens ont changé.
 */
export async function reconcilePayment(
  db: Db,
  params: {
    clinicId: string;
    paymentId: string;
    actorId: string;
    preferInvoiceId?: string | null;
  },
): Promise<void> {
  const { clinicId, paymentId, actorId } = params;
  const preferInvoiceId = params.preferInvoiceId ?? null;

  const objectiveRows = await db.payment_allocations.groupBy({
    by: ['budget_id'],
    where: { clinic_id: clinicId, payment_id: paymentId, target_type: 'budget' },
    _sum: { amount: true },
  });
  const objective = new Map<string, number>();
  for (const row of objectiveRows) {
    if (row.budget_id) objective.set(row.budget_id, toCents(row._sum.amount ?? 0));
  }

  const links = await db.invoice_payments.findMany({
    where: { clinic_id: clinicId, payment_id: paymentId, invoices: { budget_id: { not: null } } },
    select: { id: true, invoice_id: true, amount: true, invoices: { select: { budget_id: true } } },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  });
  const linked = new Map<string, Array<{ id: string; invoice_id: string; cents: number }>>();
  for (const link of links) {
    const budgetId = link.invoices.budget_id;
    if (!budgetId) continue;
    const list = linked.get(budgetId) ?? [];
    list.push({ id: link.id, invoice_id: link.invoice_id, cents: toCents(link.amount) });
    linked.set(budgetId, list);
  }

  const budgetIds = [...new Set([...objective.keys(), ...linked.keys()])].sort();
  const touched = new Set<string>();

  for (const budgetId of budgetIds) {
    await lockBudget(db, clinicId, budgetId);
    const target = objective.get(budgetId) ?? 0;
    const budgetLinks = linked.get(budgetId) ?? [];
    const current = budgetLinks.reduce((sum, link) => sum + link.cents, 0);

    if (target > current) {
      let remaining = target - current;
      for (const invoice of await openInvoices(db, clinicId, budgetId, preferInvoiceId)) {
        const { balance } = await paidSummaryCents(db, clinicId, invoice.id);
        const take = Math.min(remaining, balance);
        if (take <= 0) continue;
        const now = new Date();
        await db.invoice_payments.create({
          data: {
            id: crypto.randomUUID(),
            clinic_id: clinicId,
            invoice_id: invoice.id,
            payment_id: paymentId,
            amount: centsToDecimal(take),
            created_by: actorId,
            created_at: now,
            updated_at: now,
          },
        });
        touched.add(invoice.id);
        remaining -= take;
        if (remaining <= 0) break;
      }
      // Le reliquat reste sur le devis jusqu'à facturation du reste.
    } else if (target < current) {
      let excess = current - target;
      for (const link of [...budgetLinks].reverse()) {
        if (excess <= 0) break;
        touched.add(link.invoice_id);
        if (link.cents <= excess) {
          excess -= link.cents;
          await db.invoice_payments.delete({ where: { id: link.id } });
        } else {
          // Réimputation partielle : on retire le surplus de la ligne
          // conservée (elle porte le reste du montant imputé).
          await db.invoice_payments.update({
            where: { id: link.id },
            data: { amount: centsToDecimal(link.cents - excess), updated_at: new Date() },
          });
          excess = 0;
        }
      }
    }
  }

  if (touched.size === 0) return;

  const invoices = await db.invoices.findMany({
    where: { id: { in: [...touched] } },
    select: { id: true, clinic_id: true, status: true, total: true },
  });
  for (const invoice of invoices) {
    await recalcInvoiceStatus(db, invoice, actorId);
  }
}

/**
 * À l'émission : les acomptes déjà perçus sur le devis atterrissent sur la
 * nouvelle facture, du plus ancien paiement au plus récent.
 */
export async function sweepBudgetIntoInvoice(
  db: Db,
  params: { invoice: { id: string; clinic_id: string; budget_id: string | null }; actorId: string },
): Promise<void> {
  const { invoice, actorId } = params;
  if (invoice.budget_id === null) return;

  const rows = await db.$queryRaw<Array<{ payment_id: string }>>`
    SELECT payment_id FROM payment_allocations
    WHERE clinic_id = ${invoice.clinic_id}::uuid
      AND budget_id = ${invoice.budget_id}::uuid
      AND target_type = 'budget'
    GROUP BY payment_id
    ORDER BY MIN(created_at)`;
  for (const row of rows) {
    await reconcilePayment(db, {
      clinicId: invoice.clinic_id,
      paymentId: row.payment_id,
      actorId,
      preferInvoiceId: invoice.id,
    });
  }
}

// ---------------------------------------------------------------------------
// Paiements d'une facture (InvoicePaymentService)
// ---------------------------------------------------------------------------

export async function listInvoicePayments(
  db: Db,
  clinicId: string,
  invoiceId: string,
): Promise<InvoicePaymentDetailDto[]> {
  const rows = await db.invoice_payments.findMany({
    where: { clinic_id: clinicId, invoice_id: invoiceId },
    include: { payments: { include: paymentInclude } },
    orderBy: { created_at: 'desc' },
  });
  return rows.map((row) => ({
    ...toLinkDto(row),
    payment: toPaymentDto(row.payments),
  }));
}

/** Crée le `payments` brut d'un encaissement orchestré par billing. */
export async function createPaymentRow(
  db: Db,
  params: {
    clinicId: string;
    currency: string;
    patientId: string;
    amountCents: number;
    method: string;
    paymentDate: Date;
    recordedBy: string;
    allocations: Array<{ target_type: 'budget' | 'on_account'; budgetId: string | null; cents: number }>;
    reference: string | null;
    notes: string | null;
  },
): Promise<string> {
  const now = new Date();
  const paymentId = crypto.randomUUID();
  await db.payments.create({
    data: {
      id: paymentId,
      clinic_id: params.clinicId,
      patient_id: params.patientId,
      amount: centsToDecimal(params.amountCents),
      currency: params.currency,
      method: params.method,
      payment_date: params.paymentDate,
      reference: params.reference,
      notes: params.notes,
      recorded_by: params.recordedBy,
      created_at: now,
      updated_at: now,
      idempotency_key: null,
    },
  });
  for (const allocation of params.allocations) {
    await db.payment_allocations.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: params.clinicId,
        payment_id: paymentId,
        target_type: allocation.target_type,
        budget_id: allocation.target_type === 'budget' ? allocation.budgetId : null,
        amount: centsToDecimal(allocation.cents),
        created_by: params.recordedBy,
        created_at: now,
        updated_at: now,
      },
    });
  }
  return paymentId;
}

export async function linkInvoicePayment(
  db: Db,
  params: {
    clinicId: string;
    invoiceId: string;
    paymentId: string;
    cents: number;
    createdBy: string;
  },
): Promise<InvoicePaymentLinkDto> {
  const now = new Date();
  const row = await db.invoice_payments.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: params.clinicId,
      invoice_id: params.invoiceId,
      payment_id: params.paymentId,
      amount: centsToDecimal(params.cents),
      created_by: params.createdBy,
      created_at: now,
      updated_at: now,
    },
  });
  return toLinkDto(row);
}

// ---------------------------------------------------------------------------
// Résumé de facturation patient (BillingReportService.get_patient_summary)
// ---------------------------------------------------------------------------

export async function getPatientBillingSummary(
  db: Db,
  clinicId: string,
  patientId: string,
): Promise<PatientBillingSummaryDto> {
  const itemsState = await db.$queryRaw<
    Array<{ budget_id: string; fully_invoiced: boolean }>
  >`
    SELECT budget_items.budget_id,
           bool_and(budget_items.invoiced_quantity >= budget_items.quantity) AS fully_invoiced
    FROM budget_items
    JOIN budgets ON budgets.id = budget_items.budget_id
    WHERE budget_items.clinic_id = ${clinicId}::uuid
      AND budgets.clinic_id = ${clinicId}::uuid
      AND budgets.patient_id = ${patientId}::uuid
    GROUP BY budget_items.budget_id`;
  const fullyInvoiced = new Map(itemsState.map((row) => [row.budget_id, row.fully_invoiced]));

  const budgets = await db.budgets.findMany({
    where: { clinic_id: clinicId, patient_id: patientId, deleted_at: null },
    select: { id: true, status: true, total: true, total_discount: true },
  });

  let totalBudgeted = 0;
  let totalDiscount = 0;
  let workInProgress = 0;
  let workCompleted = 0;
  for (const budget of budgets) {
    totalBudgeted += toCents(budget.total);
    totalDiscount += toCents(budget.total_discount);
    const complete = fullyInvoiced.get(budget.id) ?? false;
    if (budget.status === 'accepted' && !complete) workInProgress += toCents(budget.total);
    if (budget.status === 'accepted' && complete) workCompleted += toCents(budget.total);
  }

  const invoices = await db.invoices.findMany({
    where: {
      clinic_id: clinicId,
      patient_id: patientId,
      status: { in: ['issued', 'partial', 'paid'] },
      deleted_at: null,
    },
    select: { id: true, total: true },
  });
  const totalInvoiced = invoices.reduce((sum, invoice) => sum + toCents(invoice.total), 0);
  const summaries = await computePaidSummariesForInvoices(
    db,
    clinicId,
    invoices.map((invoice) => invoice.id),
  );
  const totalPaid = [...summaries.values()].reduce((sum, summary) => sum + toCents(summary.total_paid), 0);

  return {
    patient_id: patientId,
    total_budgeted: centsToDecimal(totalBudgeted).toNumber(),
    total_discount: centsToDecimal(totalDiscount).toNumber(),
    work_in_progress: centsToDecimal(workInProgress).toNumber(),
    work_completed: centsToDecimal(workCompleted).toNumber(),
    total_invoiced: centsToDecimal(totalInvoiced).toNumber(),
    total_paid: centsToDecimal(totalPaid).toNumber(),
    balance_pending: centsToDecimal(totalInvoiced - totalPaid).toNumber(),
  };
}

export { addDays, lookupLinkedPlan };
