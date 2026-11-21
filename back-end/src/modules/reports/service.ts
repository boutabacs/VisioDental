/**
 * Services de reporting — port de `app/modules/reports/services/*.py`.
 *
 * Répartition :
 * - `BillingReportService`     ← billing.py
 * - `FinancialReportService`   ← financial.py (axe facture uniquement)
 * - `BudgetReportService`      ← budget.py
 * - `SchedulingReportService`  ← scheduling.py
 * - `AppointmentLifecycleService` ← appointment_lifecycle.py
 * - `PatientStatsService`      ← patients.py
 * - `OperationalReportService` ← operational.py
 *
 * Les agrégats sont exprimés avec `groupBy` / `aggregate` Prisma quand la
 * sémantique le permet ; les expressions SQL (percentiles, fenêtres,
 * extractions) passent par `$queryRaw` paramétré. Les noms de schéma sont
 * préfixés `public.` (comme `search_path` côté FastAPI) pour que les
 * requêtes brutes résolvent les mêmes tables que Prisma.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import {
  AGING_BUCKETS,
  DAY_NAMES,
  FUNNEL_STATUSES,
  NON_ISSUED_STATUSES,
  NON_TREND_STATUSES,
  OPEN_STATUSES,
  ageBandLabel,
  ageOn,
  agingBucketLabel,
  clinicDayStart,
  clinicToday,
  dateOnly,
  formatDateOnly,
  missingNumbers,
  monthKey,
  nullableRate,
  optionalRound,
  periodBounds,
  punctualityBucket,
  pyRound,
  rate,
  sortAreasByCount,
  sortedGenderEntries,
  validateAnalyticsRange,
  vatName,
  waitingBucket,
  type AgingBucket,
  type AgeBand,
  type AppointmentFunnel,
  type AreaSplit,
  type BudgetByProfessional,
  type BudgetByStatus,
  type BudgetByTreatment,
  type BudgetSummary,
  type BillingSummary,
  type CabinetUtilization,
  type DayOfWeekStats,
  type Demographics,
  type DurationVarianceStats,
  type FirstVisitsSummary,
  type GenderSplit,
  type HoursByProfessional,
  type IssuedTrend,
  type NumberingGap,
  type OverdueInvoice,
  type PaymentMethodSummary,
  type Productivity,
  type ProfessionalBillingSummary,
  type PunctualityStats,
  type SchedulingSummary,
  type TrendPoint,
  type VatSummaryItem,
  type VisitFrequency,
  type WaitingTimeStats,
} from './schemas';

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function num(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : value.toNumber();
}

function toCount(value: number | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

/** `f"{first} {last}"` de Python (espace même si un champ est vide). */
function fullName(user: { first_name: string; last_name: string } | null | undefined): string {
  return user ? `${user.first_name} ${user.last_name}` : '-';
}

const DAY_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export interface PaidSummary {
  total_paid: number;
  balance_due: number;
}

/**
 * Montants réglés / solde par facture, nets des remboursements — port de
 * `compute_paid_summaries_for_invoices` (billing/service.py).
 *
 * Pour chaque imputation, la part remboursée est proportionnelle
 * (`remboursé * imputé / payé`), sinon un remboursement total baisserait
 * à tort les recevables (#690).
 */
export async function computePaidSummaries(
  clinicId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, PaidSummary>> {
  const out = new Map<string, PaidSummary>();
  if (invoiceIds.length === 0) return out;

  const imputed = await prisma.invoice_payments.groupBy({
    by: ['invoice_id', 'payment_id'],
    where: { clinic_id: clinicId, invoice_id: { in: [...invoiceIds] } },
    _sum: { amount: true },
  });

  const paymentIds = [...new Set(imputed.map((row) => row.payment_id))];
  const paymentAmount = new Map<string, number>();
  const refundedPerPayment = new Map<string, number>();
  if (paymentIds.length > 0) {
    const payments = await prisma.payments.findMany({
      where: { id: { in: paymentIds } },
      select: { id: true, amount: true },
    });
    for (const payment of payments) paymentAmount.set(payment.id, num(payment.amount));

    const refunds = await prisma.refunds.groupBy({
      by: ['payment_id'],
      where: { payment_id: { in: paymentIds } },
      _sum: { amount: true },
    });
    for (const refund of refunds) {
      refundedPerPayment.set(refund.payment_id, num(refund._sum.amount));
    }
  }

  const totals = await prisma.invoices.findMany({
    where: { id: { in: [...invoiceIds] } },
    select: { id: true, total: true },
  });
  const totalById = new Map(totals.map((row) => [row.id, num(row.total)]));

  for (const invoiceId of invoiceIds) {
    out.set(invoiceId, { total_paid: 0, balance_due: 0 });
  }
  for (const row of imputed) {
    const imputedAmount = num(row._sum.amount);
    const full = paymentAmount.get(row.payment_id) ?? imputedAmount;
    const refunded = refundedPerPayment.get(row.payment_id) ?? 0;
    const adjustment = full > 0 ? refunded * (imputedAmount / full) : 0;
    const entry = out.get(row.invoice_id);
    if (entry) entry.total_paid += imputedAmount - adjustment;
  }
  for (const [invoiceId, entry] of out) {
    const total = totalById.get(invoiceId) ?? 0;
    entry.balance_due = pyRound(total - entry.total_paid, 2);
    entry.total_paid = pyRound(entry.total_paid, 2);
  }
  return out;
}

async function vatBreakdown(
  clinicId: string,
  from: Date,
  to: Date,
): Promise<VatSummaryItem[]> {
  const rows = await prisma.invoice_items.groupBy({
    by: ['vat_type_id', 'vat_rate'],
    where: {
      invoices: {
        clinic_id: clinicId,
        status: { notIn: [...NON_ISSUED_STATUSES] },
        issue_date: { gte: from, lte: to },
        deleted_at: null,
      },
    },
    _sum: { line_subtotal: true, line_discount: true, line_tax: true },
  });

  const ids = rows.map((row) => row.vat_type_id).filter((id): id is string => id !== null);
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const vats = await prisma.vat_types.findMany({
      where: { id: { in: ids } },
      select: { id: true, names: true, rate: true },
    });
    for (const vat of vats) names.set(vat.id, vatName(vat.names, vat.rate));
  }

  const items = rows.map((row) => {
    const base = num(row._sum.line_subtotal) - num(row._sum.line_discount);
    const tax = num(row._sum.line_tax);
    return {
      vat_type_id: row.vat_type_id,
      vat_rate: row.vat_rate,
      vat_name: (row.vat_type_id ? names.get(row.vat_type_id) : undefined)
        ?? `IVA ${row.vat_rate}%`,
      base_amount: base,
      tax_amount: tax,
      total_amount: pyRound(base + tax, 2),
    } satisfies VatSummaryItem;
  });

  // Sans `ORDER BY` côté Python, l'ordre suit le plan d'exécution ; on
  // garantit ici un ordre stable (taux croissant, puis libellé).
  return items.sort(
    (a, b) => a.vat_rate - b.vat_rate || (a.vat_name < b.vat_name ? -1 : a.vat_name > b.vat_name ? 1 : 0),
  );
}

export const BillingReportService = {
  async getSummary(
    clinicId: string,
    timeZone: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<BillingSummary> {
    const today = clinicToday(timeZone);

    const totals = await prisma.invoices.aggregate({
      where: {
        clinic_id: clinicId,
        status: { notIn: [...NON_ISSUED_STATUSES] },
        issue_date: { gte: dateFrom, lte: dateTo },
        deleted_at: null,
      },
      _count: { _all: true },
      _sum: { total: true },
    });

    const openInvoices = await prisma.invoices.findMany({
      where: {
        clinic_id: clinicId,
        status: { in: [...OPEN_STATUSES] },
        deleted_at: null,
      },
      select: { id: true },
    });
    const paidByInvoice = await computePaidSummaries(
      clinicId,
      openInvoices.map((invoice) => invoice.id),
    );
    let totalPending = 0;
    for (const summary of paidByInvoice.values()) totalPending += summary.balance_due;

    // `total_paid` : imputations dont le `created_at` tombe dans la fenêtre.
    // PostgreSQL interprétait la borne « naïve » dans le fuseau serveur
    // (UTC côté FastAPI).
    const paidWindow = periodBounds(dateFrom, dateTo, null);
    const payments = await prisma.invoice_payments.aggregate({
      where: {
        clinic_id: clinicId,
        created_at: { gte: paidWindow.start, lte: paidWindow.end },
      },
      _sum: { amount: true },
    });

    const paidCount = await prisma.invoices.count({
      where: {
        clinic_id: clinicId,
        status: 'paid',
        issue_date: { gte: dateFrom, lte: dateTo },
        deleted_at: null,
      },
    });

    const overdueCount = await prisma.invoices.count({
      where: {
        clinic_id: clinicId,
        status: { in: [...OPEN_STATUSES] },
        due_date: { lt: today },
        deleted_at: null,
      },
    });

    return {
      period_start: formatDateOnly(dateFrom)!,
      period_end: formatDateOnly(dateTo)!,
      total_invoiced: pyRound(num(totals._sum.total), 2),
      total_paid: pyRound(num(payments._sum.amount), 2),
      total_pending: pyRound(totalPending, 2),
      invoice_count: toCount(totals._count._all),
      paid_count: paidCount,
      overdue_count: overdueCount,
      vat_breakdown: await vatBreakdown(clinicId, dateFrom, dateTo),
    };
  },

  async getOverdueInvoices(
    clinicId: string,
    timeZone: string,
    limit = 200,
  ): Promise<OverdueInvoice[]> {
    const today = clinicToday(timeZone);

    const invoices = await prisma.invoices.findMany({
      where: {
        clinic_id: clinicId,
        status: { in: [...OPEN_STATUSES] },
        due_date: { lt: today },
        deleted_at: null,
      },
      select: {
        id: true,
        invoice_number: true,
        issue_date: true,
        due_date: true,
        total: true,
        patients: { select: { first_name: true, last_name: true } },
      },
      orderBy: [{ due_date: 'asc' }],
      take: limit,
    });

    const paidByInvoice = await computePaidSummaries(
      clinicId,
      invoices.map((invoice) => invoice.id),
    );

    return invoices.map((invoice) => {
      const issueDate = formatDateOnly(invoice.issue_date)!;
      const dueDate = formatDateOnly(invoice.due_date)!;
      const patient = invoice.patients;
      return {
        id: invoice.id,
        invoice_number: invoice.invoice_number ?? '',
        patient_name: patient ? `${patient.last_name}, ${patient.first_name}` : '-',
        issue_date: issueDate,
        due_date: dueDate,
        days_overdue: Math.round(
          (dateOnly(formatDateOnly(today)!).getTime() - dateOnly(dueDate).getTime()) / DAY_MS,
        ),
        balance_due: pyRound(
          paidByInvoice.get(invoice.id)?.balance_due ?? num(invoice.total),
          2,
        ),
      } satisfies OverdueInvoice;
    });
  },

  async getByPaymentMethod(
    clinicId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<PaymentMethodSummary[]> {
    const rows = await prisma.invoice_payments.groupBy({
      by: ['payment_id'],
      where: {
        clinic_id: clinicId,
        payments: { payment_date: { gte: dateFrom, lte: dateTo } },
      },
      _count: { _all: true },
      _sum: { amount: true },
    });

    const paymentIds = rows.map((row) => row.payment_id);
    const methods = new Map<string, string>();
    if (paymentIds.length > 0) {
      const payments = await prisma.payments.findMany({
        where: { id: { in: paymentIds } },
        select: { id: true, method: true },
      });
      for (const payment of payments) methods.set(payment.id, payment.method);
    }

    const byMethod = new Map<string, PaymentMethodSummary>();
    for (const row of rows) {
      const method = methods.get(row.payment_id) ?? '';
      const entry = byMethod.get(method) ?? {
        payment_method: method,
        total_amount: 0,
        payment_count: 0,
      };
      entry.total_amount += num(row._sum.amount);
      entry.payment_count += toCount(row._count._all);
      byMethod.set(method, entry);
    }

    return [...byMethod.values()]
      .map((entry) => ({ ...entry, total_amount: pyRound(entry.total_amount, 2) }))
      .sort((a, b) => b.total_amount - a.total_amount || (a.payment_method < b.payment_method ? -1 : 1));
  },

  async getByProfessional(
    clinicId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<ProfessionalBillingSummary[]> {
    const rows = await prisma.invoices.groupBy({
      by: ['created_by'],
      where: {
        clinic_id: clinicId,
        status: { notIn: [...NON_ISSUED_STATUSES] },
        issue_date: { gte: dateFrom, lte: dateTo },
        deleted_at: null,
      },
      _count: { _all: true },
      _sum: { total: true },
    });

    const userIds = rows.map((row) => row.created_by).filter((id): id is string => id !== null);
    const names = new Map<string, string>();
    if (userIds.length > 0) {
      const users = await prisma.users.findMany({
        where: { id: { in: userIds } },
        select: { id: true, first_name: true, last_name: true },
      });
      for (const user of users) names.set(user.id, fullName(user));
    }

    return rows.map((row) => ({
      professional_id: row.created_by,
      professional_name: names.get(row.created_by) ?? '-',
      total_invoiced: pyRound(num(row._sum.total), 2),
      invoice_count: toCount(row._count._all),
    }));
  },

  async getVatSummary(
    clinicId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<VatSummaryItem[]> {
    const rows = await prisma.invoice_items.groupBy({
      by: ['vat_type_id', 'vat_rate'],
      where: {
        invoices: {
          clinic_id: clinicId,
          status: { notIn: [...NON_ISSUED_STATUSES] },
          issue_date: { gte: dateFrom, lte: dateTo },
          deleted_at: null,
        },
      },
      _sum: { line_subtotal: true, line_discount: true, line_tax: true },
      orderBy: [{ vat_rate: 'asc' }],
    });

    const ids = rows.map((row) => row.vat_type_id).filter((id): id is string => id !== null);
    const names = new Map<string, string>();
    if (ids.length > 0) {
      const vats = await prisma.vat_types.findMany({
        where: { id: { in: ids } },
        select: { id: true, names: true, rate: true },
      });
      for (const vat of vats) names.set(vat.id, vatName(vat.names, vat.rate));
    }

    return rows.map((row) => {
      const base = num(row._sum.line_subtotal) - num(row._sum.line_discount);
      const tax = num(row._sum.line_tax);
      return {
        vat_type_id: row.vat_type_id,
        vat_rate: row.vat_rate,
        vat_name: (row.vat_type_id ? names.get(row.vat_type_id) : undefined)
          ?? `IVA ${row.vat_rate}%`,
        base_amount: base,
        tax_amount: tax,
        total_amount: pyRound(base + tax, 2),
      } satisfies VatSummaryItem;
    });
  },

  async getNumberingGaps(clinicId: string): Promise<NumberingGap[]> {
    const seriesList = await prisma.invoice_series.findMany({
      where: { clinic_id: clinicId, is_active: true },
      select: { id: true, prefix: true },
    });

    const gaps: NumberingGap[] = [];
    for (const series of seriesList) {
      const invoices = await prisma.invoices.findMany({
        where: {
          clinic_id: clinicId,
          series_id: series.id,
          sequential_number: { not: null },
          deleted_at: null,
        },
        select: { sequential_number: true, fiscal_year: true, issue_date: true },
      });

      const byYear = new Map<number, number[]>();
      for (const invoice of invoices) {
        const year = invoice.fiscal_year ?? invoice.issue_date?.getUTCFullYear() ?? 0;
        const numbers = byYear.get(year) ?? [];
        numbers.push(invoice.sequential_number!);
        byYear.set(year, numbers);
      }

      for (const year of [...byYear.keys()].sort((a, b) => a - b)) {
        const missing = missingNumbers(byYear.get(year)!);
        if (missing.length > 0) {
          gaps.push({ series_prefix: series.prefix, year, missing_numbers: missing });
        }
      }
    }
    return gaps;
  },
};

// ---------------------------------------------------------------------------
// Financial (axe facture uniquement)
// ---------------------------------------------------------------------------

export const FinancialReportService = {
  async agingBuckets(clinicId: string, timeZone: string): Promise<AgingBucket[]> {
    const today = clinicToday(timeZone);
    const rows = await prisma.invoices.groupBy({
      by: ['due_date', 'patient_id'],
      where: {
        clinic_id: clinicId,
        status: { in: [...OPEN_STATUSES] },
        deleted_at: null,
      },
      _sum: { total: true },
      _count: { _all: true },
    });

    const buckets = new Map<string, AgingBucket>();
    const patients = new Map<string, Set<string>>();
    for (const [label] of AGING_BUCKETS) {
      buckets.set(label, { label, total: 0, count: 0, patient_count: 0 });
      patients.set(label, new Set());
    }
    for (const row of rows) {
      const label = agingBucketLabel(row.due_date ?? null, today);
      const slot = buckets.get(label)!;
      slot.total += num(row._sum.total);
      slot.count += toCount(row._count._all);
      patients.get(label)!.add(row.patient_id);
    }
    for (const [label, ids] of patients) {
      buckets.get(label)!.patient_count = ids.size;
      buckets.get(label)!.total = pyRound(buckets.get(label)!.total, 2);
    }
    return AGING_BUCKETS.map(([label]) => buckets.get(label)!);
  },

  async issuedTrend(
    clinicId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<TrendPoint[]> {
    const rows = await prisma.invoices.groupBy({
      by: ['issue_date'],
      where: {
        clinic_id: clinicId,
        status: { notIn: [...NON_TREND_STATUSES] },
        issue_date: { not: null, gte: dateFrom, lte: dateTo },
        deleted_at: null,
      },
      _sum: { total: true },
      _count: { _all: true },
    });

    const months = new Map<string, TrendPoint>();
    for (const row of rows) {
      const key = monthKey(row.issue_date!);
      const entry = months.get(key) ?? { month: key, total: 0, count: 0 };
      entry.total += num(row._sum.total);
      entry.count += toCount(row._count._all);
      months.set(key, entry);
    }
    return [...months.values()]
      .map((entry) => ({ ...entry, total: pyRound(entry.total, 2) }))
      .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  },
};

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export const BudgetReportService = {
  async getSummary(
    clinicId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<BudgetSummary> {
    const range = periodBounds(dateFrom, dateTo, null);
    const statusRows = await prisma.budgets.groupBy({
      by: ['status'],
      where: {
        clinic_id: clinicId,
        created_at: { gte: range.start, lte: range.end },
        deleted_at: null,
      },
      _count: { _all: true },
      _sum: { total: true },
    });
    const overall = await prisma.budgets.aggregate({
      where: {
        clinic_id: clinicId,
        created_at: { gte: range.start, lte: range.end },
        deleted_at: null,
      },
      _count: { _all: true },
      _sum: { total: true },
    });

    const byStatus = new Map(statusRows.map((row) => [row.status, row]));
    const countOf = (status: string) => toCount(byStatus.get(status)?._count._all);
    const sumOf = (status: string) => pyRound(num(byStatus.get(status)?._sum.total), 2);

    const acceptedCount = countOf('accepted');
    const rejectedCount = countOf('rejected');
    const totalCreated = toCount(overall._count._all);
    const totalAmount = num(overall._sum.total);
    const decided = acceptedCount + rejectedCount;

    return {
      period_start: formatDateOnly(dateFrom)!,
      period_end: formatDateOnly(dateTo)!,
      total_created: totalCreated,
      total_amount: pyRound(totalAmount, 2),
      accepted_count: acceptedCount,
      accepted_amount: sumOf('accepted'),
      rejected_count: rejectedCount,
      pending_count: countOf('draft'),
      completed_count: countOf('completed'),
      completed_amount: sumOf('completed'),
      acceptance_rate: decided > 0 ? pyRound((acceptedCount / decided) * 100, 1) : 0,
      average_value: totalCreated > 0 ? pyRound(totalAmount / totalCreated, 2) : 0,
    };
  },

  async getByProfessional(
    clinicId: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<BudgetByProfessional[]> {
    const range = periodBounds(dateFrom, dateTo, null);
    const base = {
      clinic_id: clinicId,
      created_at: { gte: range.start, lte: range.end },
      deleted_at: null,
    };

    const rows = await prisma.budgets.groupBy({
      by: ['created_by'],
      where: base,
      _count: { _all: true },
      _sum: { total: true },
    });
    const accepted = await prisma.budgets.groupBy({
      by: ['created_by'],
      where: { ...base, status: 'accepted' },
      _count: { _all: true },
    });
    const acceptedBy = new Map(accepted.map((row) => [row.created_by, toCount(row._count._all)]));

    const userIds = rows.map((row) => row.created_by).filter((id): id is string => id !== null);
    const names = new Map<string, string>();
    if (userIds.length > 0) {
      const users = await prisma.users.findMany({
        where: { id: { in: userIds } },
        select: { id: true, first_name: true, last_name: true },
      });
      for (const user of users) names.set(user.id, fullName(user));
    }

    return rows.map((row) => {
      const budgetCount = toCount(row._count._all);
      const acceptedCount = row.created_by ? (acceptedBy.get(row.created_by) ?? 0) : 0;
      return {
        professional_id: row.created_by,
        professional_name: names.get(row.created_by) ?? '-',
        budget_count: budgetCount,
        total_amount: pyRound(num(row._sum.total), 2),
        accepted_count: acceptedCount,
        acceptance_rate: budgetCount > 0 ? pyRound((acceptedCount / budgetCount) * 100, 1) : 0,
      } satisfies BudgetByProfessional;
    });
  },

  async getByTreatment(
    clinicId: string,
    dateFrom: Date,
    dateTo: Date,
    limit = 10,
  ): Promise<BudgetByTreatment[]> {
    const { start, end } = periodBounds(dateFrom, dateTo, null);
    // `ORDER BY COUNT(id) DESC` + `GROUP BY catalog_item_id` : sémantique
    // d'agrégat PostgreSQL (le `catalog_item_id IS NOT NULL` est un filtre
    // sur la colonne groupée) → requête brute paramétrée.
    const rows = await prisma.$queryRaw<
      Array<{
        catalog_item_id: string;
        occurrence_count: bigint;
        total_quantity: bigint | number | null;
        total_amount: Prisma.Decimal | null;
      }>
    >`
      SELECT bi.catalog_item_id AS catalog_item_id,
             COUNT(bi.id)::bigint AS occurrence_count,
             COALESCE(SUM(bi.quantity), 0)::bigint AS total_quantity,
             COALESCE(SUM(bi.line_total), 0) AS total_amount
      FROM public.budget_items bi
      JOIN public.budgets b ON b.id = bi.budget_id
      WHERE b.clinic_id = ${clinicId}::uuid
        AND b.created_at >= ${start}
        AND b.created_at <= ${end}
        AND b.deleted_at IS NULL
        AND bi.catalog_item_id IS NOT NULL
      GROUP BY bi.catalog_item_id
      ORDER BY COUNT(bi.id) DESC, bi.catalog_item_id
      LIMIT ${limit}
    `;

    const catalogIds = rows.map((row) => row.catalog_item_id);
    const names = new Map<string, string>();
    if (catalogIds.length > 0) {
      const items = await prisma.treatment_catalog_items.findMany({
        where: { id: { in: catalogIds } },
        select: { id: true, names: true, internal_code: true },
      });
      for (const item of items) {
        const namesJson = item.names;
        const spanish =
          namesJson && typeof namesJson === 'object' && !Array.isArray(namesJson)
            ? (namesJson as Record<string, unknown>).es
            : undefined;
        names.set(item.id, typeof spanish === 'string' ? spanish : item.internal_code);
      }
    }

    return rows.map((row) => ({
      catalog_item_id: row.catalog_item_id,
      treatment_name: names.get(row.catalog_item_id) ?? '-',
      occurrence_count: toCount(row.occurrence_count),
      total_quantity: toCount(row.total_quantity),
      total_amount: pyRound(num(row.total_amount), 2),
    }));
  },

  async getByStatus(clinicId: string, dateFrom: Date, dateTo: Date): Promise<BudgetByStatus[]> {
    const range = periodBounds(dateFrom, dateTo, null);
    const rows = await prisma.budgets.groupBy({
      by: ['status'],
      where: {
        clinic_id: clinicId,
        created_at: { gte: range.start, lte: range.end },
        deleted_at: null,
      },
      _count: { _all: true },
      _sum: { total: true },
      orderBy: { status: 'asc' },
    });

    return rows.map((row) => ({
      status: row.status,
      count: toCount(row._count._all),
      total_amount: pyRound(num(row._sum.total), 2),
    }));
  },
};

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Filtre commun borné sur le jour local de `start_time`. */
function appointmentRange(clinicId: string, timeZone: string, dateFrom: Date, dateTo: Date) {
  return {
    clinic_id: clinicId,
    start_time: {
      gte: clinicDayStart(formatDateOnly(dateFrom)!, timeZone),
      lt: clinicDayStart(formatDateOnly(dateTo)!, timeZone),
    },
  } satisfies Prisma.appointmentsWhereInput;
}

export const SchedulingReportService = {
  async getSummary(
    clinicId: string,
    timeZone: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<SchedulingSummary> {
    const where = appointmentRange(clinicId, timeZone, dateFrom, dateTo);
    const rows = await prisma.appointments.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    const counts = new Map(rows.map((row) => [row.status, toCount(row._count._all)]));
    const countOf = (status: string) => counts.get(status) ?? 0;
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);

    const completed = countOf('completed');
    const cancelled = countOf('cancelled');
    const noShow = countOf('no_show');
    const decided = completed + cancelled + noShow;

    return {
      period_start: formatDateOnly(dateFrom)!,
      period_end: formatDateOnly(dateTo)!,
      total_appointments: total,
      completed,
      cancelled,
      no_show: noShow,
      scheduled: countOf('scheduled'),
      confirmed: countOf('confirmed'),
      checked_in: countOf('checked_in'),
      in_treatment: countOf('in_treatment'),
      completion_rate: rate(completed, decided),
      cancellation_rate: rate(cancelled, decided),
      no_show_rate: rate(noShow, decided),
    };
  },

  async getFirstVisits(
    clinicId: string,
    timeZone: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<FirstVisitsSummary> {
    // Premier rendez-vous (non annulé) de chaque patient à vie, puis
    // comptage de ceux dont ce premier RDV tombe dans la fenêtre locale.
    const firstVisits = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n
      FROM (
        SELECT a.patient_id, MIN(a.start_time) AS first_at
        FROM public.appointments a
        WHERE a.clinic_id = ${clinicId}::uuid
          AND a.status <> 'cancelled'
          AND a.patient_id IS NOT NULL
        GROUP BY a.patient_id
      ) f
      WHERE (f.first_at AT TIME ZONE ${timeZone}::text)::date
        BETWEEN ${formatDateOnly(dateFrom)!}::date AND ${formatDateOnly(dateTo)!}::date
    `;

    const totalAppointments = await prisma.appointments.count({
      where: { ...appointmentRange(clinicId, timeZone, dateFrom, dateTo), status: { not: 'cancelled' } },
    });
    const newPatients = toCount(firstVisits[0]?.n);

    return {
      period_start: formatDateOnly(dateFrom)!,
      period_end: formatDateOnly(dateTo)!,
      new_patients: newPatients,
      total_appointments: totalAppointments,
      first_visit_rate: rate(newPatients, totalAppointments),
    };
  },

  async getHoursByProfessional(
    clinicId: string,
    timeZone: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<HoursByProfessional[]> {
    const where = {
      ...appointmentRange(clinicId, timeZone, dateFrom, dateTo),
    } satisfies Prisma.appointmentsWhereInput;

    // `professional_id` est obligatoire en base : le filtre `isnot(None)`
    // de Python est une formalité, Prisma n'expose pas `not: null` sur un UUID.
    const rows = await prisma.appointments.groupBy({
      by: ['professional_id', 'status'],
      where,
      _count: { _all: true },
    });
    const durations = await prisma.appointments.findMany({
      where: { ...where, status: 'completed' },
      select: { professional_id: true, start_time: true, end_time: true },
      orderBy: [{ start_time: 'asc' }],
    });

    const minutes = new Map<string, number>();
    for (const row of durations) {
      const id = row.professional_id;
      const value = (row.end_time.getTime() - row.start_time.getTime()) / 1000 / 60;
      minutes.set(id, (minutes.get(id) ?? 0) + value);
    }

    const stats = new Map<string, HoursByProfessional>();
    for (const row of rows) {
      const id = row.professional_id!;
      const entry = stats.get(id) ?? {
        professional_id: id,
        professional_name: '-',
        appointment_count: 0,
        completed_count: 0,
        cancelled_count: 0,
        no_show_count: 0,
        total_minutes: 0,
        total_hours: 0,
      };
      const count = toCount(row._count._all);
      entry.appointment_count += count;
      if (row.status === 'completed') entry.completed_count += count;
      if (row.status === 'cancelled') entry.cancelled_count += count;
      if (row.status === 'no_show') entry.no_show_count += count;
      stats.set(id, entry);
    }

    const ids = [...stats.keys()];
    if (ids.length > 0) {
      const users = await prisma.users.findMany({
        where: { id: { in: ids } },
        select: { id: true, first_name: true, last_name: true },
      });
      for (const user of users) {
        const entry = stats.get(user.id);
        if (entry) entry.professional_name = fullName(user);
      }
    }

    for (const entry of stats.values()) {
      const totalMinutes = minutes.get(entry.professional_id!) ?? 0;
      entry.total_minutes = Math.trunc(totalMinutes);
      entry.total_hours = pyRound(totalMinutes / 60, 1);
    }
    return [...stats.values()];
  },

  async getCabinetUtilization(
    clinicId: string,
    timeZone: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<CabinetUtilization[]> {
    const rows = await prisma.appointments.groupBy({
      by: ['cabinet', 'status'],
      where: {
        ...appointmentRange(clinicId, timeZone, dateFrom, dateTo),
        cabinet: { not: null },
      },
      _count: { _all: true },
    });
    const durations = await prisma.appointments.findMany({
      where: {
        ...appointmentRange(clinicId, timeZone, dateFrom, dateTo),
        cabinet: { not: null },
      },
      select: { cabinet: true, start_time: true, end_time: true },
      orderBy: [{ start_time: 'asc' }],
    });

    const minutes = new Map<string, number>();
    for (const row of durations) {
      const key = row.cabinet!;
      const value = (row.end_time.getTime() - row.start_time.getTime()) / 1000 / 60;
      minutes.set(key, (minutes.get(key) ?? 0) + value);
    }

    const stats = new Map<string, CabinetUtilization>();
    for (const row of rows) {
      const key = row.cabinet!;
      const entry = stats.get(key) ?? {
        cabinet: key,
        appointment_count: 0,
        completed_count: 0,
        total_minutes: 0,
        total_hours: 0,
      };
      const count = toCount(row._count._all);
      entry.appointment_count += count;
      if (row.status === 'completed') entry.completed_count += count;
      stats.set(key, entry);
    }

    return [...stats.values()]
      .map((entry) => {
        const totalMinutes = minutes.get(entry.cabinet) ?? 0;
        return {
          ...entry,
          total_minutes: Math.trunc(totalMinutes),
          total_hours: pyRound(totalMinutes / 60, 1),
        };
      })
      .sort((a, b) => (a.cabinet < b.cabinet ? -1 : a.cabinet > b.cabinet ? 1 : 0));
  },

  async getByDayOfWeek(
    clinicId: string,
    timeZone: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<DayOfWeekStats[]> {
    const rows = await prisma.$queryRaw<
      Array<{ dow: number; status: string; n: bigint }>
    >`
      SELECT EXTRACT(DOW FROM (a.start_time AT TIME ZONE ${timeZone}::text))::int AS dow,
             a.status AS status,
             COUNT(*)::bigint AS n
      FROM public.appointments a
      WHERE a.clinic_id = ${clinicId}::uuid
        AND a.start_time >= ${clinicDayStart(formatDateOnly(dateFrom)!, timeZone)}
        AND a.start_time < ${clinicDayStart(formatDateOnly(dateTo)!, timeZone)}
      GROUP BY dow, a.status
    `;

    const stats = new Map<number, DayOfWeekStats>();
    for (const row of rows) {
      const dow = Number(row.dow);
      const entry = stats.get(dow) ?? {
        day_of_week: dow,
        day_name: DAY_NAMES[dow] ?? 'unknown',
        appointment_count: 0,
        completed_count: 0,
        cancelled_count: 0,
        no_show_count: 0,
      };
      const count = toCount(row.n);
      entry.appointment_count += count;
      if (row.status === 'completed') entry.completed_count += count;
      if (row.status === 'cancelled') entry.cancelled_count += count;
      if (row.status === 'no_show') entry.no_show_count += count;
      stats.set(dow, entry);
    }
    return [...stats.values()].sort((a, b) => a.day_of_week - b.day_of_week);
  },
};

// ---------------------------------------------------------------------------
// Appointment lifecycle analytics (#49)
// ---------------------------------------------------------------------------

interface MinuteRow {
  delta: number | string | null;
}

/** Extrait les minutes d'une ligne agrégée (PostgreSQL renvoie un numeric). */
function minutesOf(rows: readonly MinuteRow[]): number[] {
  return rows
    .map((row) => (row.delta === null ? null : Number(row.delta)))
    .filter((value): value is number => value !== null);
}

/** `percentile_cont` (interpolation linéaire) sur une série triée. */
export function percentileCont(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

export const AppointmentLifecycleService = {
  async waitingTimes(
    clinicId: string,
    timeZone: string,
    dateFrom: Date,
    dateTo: Date,
    cabinetId: string | null = null,
    professionalId: string | null = null,
  ): Promise<WaitingTimeStats> {
    validateAnalyticsRange(dateFrom, dateTo);
    const start = clinicDayStart(formatDateOnly(dateFrom)!, timeZone);
    const end = clinicDayStart(formatDateOnly(dateTo)!, timeZone);

    const rows = await prisma.$queryRaw<MinuteRow[]>`
      SELECT EXTRACT(EPOCH FROM (it.at - ci.at)) / 60.0 AS delta
      FROM public.appointments a
      JOIN (
        SELECT e.appointment_id AS apt_id, MIN(e.changed_at) AS at
        FROM public.appointment_status_events e
        WHERE e.clinic_id = ${clinicId}::uuid AND e.to_status = 'checked_in'
        GROUP BY e.appointment_id
      ) ci ON ci.apt_id = a.id
      JOIN (
        SELECT e.appointment_id AS apt_id, MIN(e.changed_at) AS at
        FROM public.appointment_status_events e
        WHERE e.clinic_id = ${clinicId}::uuid AND e.to_status = 'in_treatment'
        GROUP BY e.appointment_id
      ) it ON it.apt_id = a.id
      WHERE a.clinic_id = ${clinicId}::uuid
        AND a.start_time >= ${start} AND a.start_time < ${end}
        AND (${cabinetId}::uuid IS NULL OR a.cabinet_id = ${cabinetId}::uuid)
        AND (${professionalId}::uuid IS NULL OR a.professional_id = ${professionalId}::uuid)
    `;

    const values = minutesOf(rows);
    const sorted = [...values].sort((a, b) => a - b);
    const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

    const counts = new Map<string, number>([
      ['0-5', 0],
      ['5-10', 0],
      ['10-20', 0],
      ['20+', 0],
    ]);
    for (const value of values) {
      const label = waitingBucket(value);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    return {
      period_start: formatDateOnly(dateFrom)!,
      period_end: formatDateOnly(dateTo)!,
      sample_size: values.length,
      avg_minutes: avg,
      median_minutes: sorted.length ? percentileCont(sorted, 0.5) : null,
      p90_minutes: sorted.length ? percentileCont(sorted, 0.9) : null,
      distribution: ['0-5', '5-10', '10-20', '20+'].map((label) => ({
        label,
        count: counts.get(label) ?? 0,
      })),
    };
  },

  async punctuality(
    clinicId: string,
    timeZone: string,
    dateFrom: Date,
    dateTo: Date,
    cabinetId: string | null = null,
    professionalId: string | null = null,
  ): Promise<PunctualityStats> {
    validateAnalyticsRange(dateFrom, dateTo);
    const start = clinicDayStart(formatDateOnly(dateFrom)!, timeZone);
    const end = clinicDayStart(formatDateOnly(dateTo)!, timeZone);

    const rows = await prisma.$queryRaw<MinuteRow[]>`
      SELECT EXTRACT(EPOCH FROM (ci.at - a.start_time)) / 60.0 AS delta
      FROM public.appointments a
      JOIN (
        SELECT e.appointment_id AS apt_id, MIN(e.changed_at) AS at
        FROM public.appointment_status_events e
        WHERE e.clinic_id = ${clinicId}::uuid AND e.to_status = 'checked_in'
        GROUP BY e.appointment_id
      ) ci ON ci.apt_id = a.id
      WHERE a.clinic_id = ${clinicId}::uuid
        AND a.start_time >= ${start} AND a.start_time < ${end}
        AND (${cabinetId}::uuid IS NULL OR a.cabinet_id = ${cabinetId}::uuid)
        AND (${professionalId}::uuid IS NULL OR a.professional_id = ${professionalId}::uuid)
    `;

    const values = minutesOf(rows);
    const n = values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const avg = n ? values.reduce((sum, value) => sum + value, 0) / n : null;
    const onTime = values.filter((value) => Math.abs(value) <= 5).length;

    const counts = new Map<string, number>([
      ['early', 0],
      ['on_time', 0],
      ['late_short', 0],
      ['late_long', 0],
    ]);
    for (const value of values) {
      const label = punctualityBucket(value);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    return {
      period_start: formatDateOnly(dateFrom)!,
      period_end: formatDateOnly(dateTo)!,
      sample_size: n,
      avg_delta_minutes: avg,
      median_delta_minutes: n ? percentileCont(sorted, 0.5) : null,
      on_time_pct: n > 0 ? pyRound((onTime / n) * 100, 1) : null,
      distribution: ['early', 'on_time', 'late_short', 'late_long'].map((label) => ({
        label,
        count: counts.get(label) ?? 0,
      })),
    };
  },

  async durationVariance(
    clinicId: string,
    timeZone: string,
    dateFrom: Date,
    dateTo: Date,
    cabinetId: string | null = null,
    professionalId: string | null = null,
  ): Promise<DurationVarianceStats> {
    validateAnalyticsRange(dateFrom, dateTo);
    const start = clinicDayStart(formatDateOnly(dateFrom)!, timeZone);
    const end = clinicDayStart(formatDateOnly(dateTo)!, timeZone);

    const rows = await prisma.$queryRaw<
      Array<{ delta: number | string | null; overrun: number | string | null }>
    >`
      SELECT EXTRACT(EPOCH FROM (c.at - it.at)) / 60.0
               - EXTRACT(EPOCH FROM (a.end_time - a.start_time)) / 60.0 AS delta,
             CASE
               WHEN EXTRACT(EPOCH FROM (a.end_time - a.start_time)) / 60.0 > 0
               THEN (
                 EXTRACT(EPOCH FROM (c.at - it.at)) / 60.0
                 - EXTRACT(EPOCH FROM (a.end_time - a.start_time)) / 60.0
               ) / (EXTRACT(EPOCH FROM (a.end_time - a.start_time)) / 60.0) * 100.0
               ELSE NULL
             END AS overrun
      FROM public.appointments a
      JOIN (
        SELECT e.appointment_id AS apt_id, MIN(e.changed_at) AS at
        FROM public.appointment_status_events e
        WHERE e.clinic_id = ${clinicId}::uuid AND e.to_status = 'in_treatment'
        GROUP BY e.appointment_id
      ) it ON it.apt_id = a.id
      JOIN (
        SELECT e.appointment_id AS apt_id, MAX(e.changed_at) AS at
        FROM public.appointment_status_events e
        WHERE e.clinic_id = ${clinicId}::uuid AND e.to_status = 'completed'
        GROUP BY e.appointment_id
      ) c ON c.apt_id = a.id
      WHERE a.clinic_id = ${clinicId}::uuid
        AND a.start_time >= ${start} AND a.start_time < ${end}
        AND (${cabinetId}::uuid IS NULL OR a.cabinet_id = ${cabinetId}::uuid)
        AND (${professionalId}::uuid IS NULL OR a.professional_id = ${professionalId}::uuid)
    `;

    const deltas = rows
      .map((row) => (row.delta === null ? null : Number(row.delta)))
      .filter((value): value is number => value !== null);
    const overruns = rows
      .map((row) => (row.overrun === null ? null : Number(row.overrun)))
      .filter((value): value is number => value !== null);

    return {
      period_start: formatDateOnly(dateFrom)!,
      period_end: formatDateOnly(dateTo)!,
      sample_size: deltas.length,
      avg_overrun_pct: overruns.length
        ? overruns.reduce((sum, value) => sum + value, 0) / overruns.length
        : null,
      avg_delta_minutes: deltas.length
        ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length
        : null,
      overrun_count: deltas.filter((value) => value > 0).length,
      under_count: deltas.filter((value) => value <= 0).length,
    };
  },

  async funnel(
    clinicId: string,
    timeZone: string,
    dateFrom: Date,
    dateTo: Date,
    cabinetId: string | null = null,
    professionalId: string | null = null,
  ): Promise<AppointmentFunnel> {
    validateAnalyticsRange(dateFrom, dateTo);
    const start = clinicDayStart(formatDateOnly(dateFrom)!, timeZone);
    const end = clinicDayStart(formatDateOnly(dateTo)!, timeZone);

    const rows = await prisma.$queryRaw<Array<{ status: string; n: bigint }>>`
      SELECT a.status AS status, COUNT(*)::bigint AS n
      FROM public.appointments a
      WHERE a.clinic_id = ${clinicId}::uuid
        AND a.start_time >= ${start} AND a.start_time < ${end}
        AND (${cabinetId}::uuid IS NULL OR a.cabinet_id = ${cabinetId}::uuid)
        AND (${professionalId}::uuid IS NULL OR a.professional_id = ${professionalId}::uuid)
      GROUP BY a.status
    `;

    const counts: Record<string, number> = {};
    for (const status of FUNNEL_STATUSES) counts[status] = 0;
    for (const row of rows) counts[row.status] = toCount(row.n);

    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const decided = counts.completed! + counts.cancelled! + counts.no_show!;
    return {
      period_start: formatDateOnly(dateFrom)!,
      period_end: formatDateOnly(dateTo)!,
      total,
      counts_by_status: counts,
      completion_rate: nullableRate(counts.completed!, decided),
      no_show_rate: nullableRate(counts.no_show!, decided),
      cancellation_rate: nullableRate(counts.cancelled!, decided),
    };
  },
};

// ---------------------------------------------------------------------------
// Patient stats
// ---------------------------------------------------------------------------

export const PatientStatsService = {
  async demographics(clinicId: string, timeZone: string): Promise<Demographics> {
    const today = clinicToday(timeZone);
    const rows = await prisma.patients.findMany({
      where: { clinic_id: clinicId, status: { not: 'archived' } },
      select: { date_of_birth: true, gender: true, address: true },
    });

    const bands = new Map<string, number>([
      ['0-17', 0],
      ['18-34', 0],
      ['35-54', 0],
      ['55-74', 0],
      ['75+', 0],
      ['unknown', 0],
    ]);
    const genders = new Map<string, number>();
    const areas = new Map<string, number>();

    for (const row of rows) {
      if (row.date_of_birth === null) {
        bands.set('unknown', (bands.get('unknown') ?? 0) + 1);
      } else {
        const label = ageBandLabel(ageOn(row.date_of_birth, today));
        bands.set(label, (bands.get(label) ?? 0) + 1);
      }
      const gender = row.gender ?? 'unknown';
      genders.set(gender, (genders.get(gender) ?? 0) + 1);

      const address = row.address;
      const city =
        address && typeof address === 'object' && !Array.isArray(address)
          ? (address as Record<string, unknown>).city
          : undefined;
      const area = (typeof city === 'string' ? city.trim() : '') || 'unknown';
      areas.set(area, (areas.get(area) ?? 0) + 1);
    }

    const areaList: AreaSplit[] = [...areas.entries()].map(([area, count]) => ({ area, count }));

    return {
      total_patients: rows.length,
      age_bands: [...bands.entries()].map(([band, count]) => ({ band, count })) as AgeBand[],
      genders: sortedGenderEntries(genders) as GenderSplit[],
      areas: sortAreasByCount(areaList, 50),
    };
  },

  async visitFrequency(
    clinicId: string,
    timeZone: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<VisitFrequency> {
    const start = clinicDayStart(formatDateOnly(dateFrom)!, timeZone);
    const end = clinicDayStart(formatDateOnly(dateTo)!, timeZone);

    const rows = await prisma.$queryRaw<Array<{ n: bigint; seen_before: boolean }>>`
      SELECT w.n AS n, (b.patient_id IS NOT NULL) AS seen_before
      FROM (
        SELECT a.patient_id, COUNT(*)::bigint AS n
        FROM public.appointments a
        WHERE a.clinic_id = ${clinicId}::uuid
          AND a.patient_id IS NOT NULL
          AND a.status IN ('scheduled', 'confirmed', 'checked_in', 'in_treatment', 'completed')
          AND a.start_time >= ${start} AND a.start_time < ${end}
        GROUP BY a.patient_id
      ) w
      LEFT JOIN (
        SELECT DISTINCT a.patient_id
        FROM public.appointments a
        WHERE a.clinic_id = ${clinicId}::uuid
          AND a.patient_id IS NOT NULL
          AND a.status IN ('scheduled', 'confirmed', 'checked_in', 'in_treatment', 'completed')
          AND a.start_time < ${start}
      ) b ON b.patient_id = w.patient_id
    `;

    let newPatients = 0;
    let returning = 0;
    let totalVisits = 0;
    for (const row of rows) {
      if (row.seen_before) returning += 1;
      else newPatients += 1;
      totalVisits += toCount(row.n);
    }
    const active = rows.length;

    return {
      new_patients: newPatients,
      returning_patients: returning,
      total_visits: totalVisits,
      visits_per_patient: active > 0 ? pyRound(totalVisits / active, 2) : 0,
    };
  },
};

// ---------------------------------------------------------------------------
// Operational
// ---------------------------------------------------------------------------

export const OperationalReportService = {
  async productivity(
    clinicId: string,
    timeZone: string,
    dateFrom: Date,
    dateTo: Date,
  ): Promise<Productivity> {
    const start = clinicDayStart(formatDateOnly(dateFrom)!, timeZone);
    const end = clinicDayStart(formatDateOnly(dateTo)!, timeZone);

    const byProfessionalRows = await prisma.$queryRaw<
      Array<{ professional_id: string; name: string; completed: bigint }>
    >`
      SELECT a.professional_id AS professional_id,
             u.first_name || ' ' || u.last_name AS name,
             COUNT(a.id)::bigint AS completed
      FROM public.appointments a
      JOIN public.users u ON u.id = a.professional_id
      WHERE a.clinic_id = ${clinicId}::uuid
        AND a.status = 'completed'
        AND a.start_time >= ${start} AND a.start_time < ${end}
      GROUP BY a.professional_id, u.first_name, u.last_name
      ORDER BY COUNT(a.id) DESC, a.professional_id
    `;

    const byCabinetRows = await prisma.$queryRaw<Array<{ cabinet: string; completed: bigint }>>`
      SELECT COALESCE(a.cabinet, 'unassigned') AS cabinet,
             COUNT(a.id)::bigint AS completed
      FROM public.appointments a
      WHERE a.clinic_id = ${clinicId}::uuid
        AND a.status = 'completed'
        AND a.start_time >= ${start} AND a.start_time < ${end}
      GROUP BY COALESCE(a.cabinet, 'unassigned')
      ORDER BY COUNT(a.id) DESC, COALESCE(a.cabinet, 'unassigned')
    `;

    const planRows = await prisma.treatment_plans.groupBy({
      by: ['status'],
      where: { clinic_id: clinicId, deleted_at: null },
      _count: { _all: true },
      orderBy: { status: 'asc' },
    });

    const byProfessional = byProfessionalRows.map((row) => ({
      professional_id: row.professional_id,
      professional_name: row.name,
      completed: toCount(row.completed),
    }));
    const byCabinet = byCabinetRows.map((row) => ({
      cabinet: row.cabinet,
      completed: toCount(row.completed),
    }));
    const completedTotal = byProfessional.reduce((sum, row) => sum + row.completed, 0);

    return {
      completed_total: completedTotal,
      by_professional: byProfessional,
      by_cabinet: byCabinet,
      plan_pipeline: planRows.map((row) => ({
        status: row.status,
        count: toCount(row._count._all),
      })),
    };
  },
};
