/**
 * Export comptable (« gestoría ») — port de
 * `backend/app/modules/accounting_export/service.py`.
 *
 * Centré facture : seules les factures émises et les paiements qui leur
 * sont **alloués** (`invoice_payments`) sortent. Le grand livre brut des
 * paiements n'est jamais exposé (frontière off-books, ADR 0010).
 */

import type { Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { buildZip } from './zip';

/** Univers d'export : tout sauf les brouillons, qui ne sont pas fiscaux. */
export const EXPORTABLE_STATUSES = ['issued', 'partial', 'paid', 'cancelled', 'voided'] as const;

export const INVOICE_HEADERS = [
  'numero',
  'serie',
  'fecha_emision',
  'cliente',
  'nif',
  'base',
  'tipo_iva',
  'cuota_iva',
  'total',
  'estado',
] as const;

export const PAYMENT_HEADERS = [
  'fecha_pago',
  'factura',
  'importe',
  'metodo',
  'referencia',
] as const;

const exportInclude = {
  invoice_series: { select: { prefix: true } },
  invoice_items: { select: { vat_rate: true } },
  invoice_payments: {
    orderBy: { created_at: 'asc' },
    include: {
      payments: { select: { payment_date: true, method: true, reference: true } },
    },
  },
} satisfies Prisma.invoicesInclude;

type ExportInvoice = Prisma.invoicesGetPayload<{ include: typeof exportInclude }>;
export type ExportRow = Record<string, string | number | null>;

/** `_statuses` : sous-ensemble autorisé ; brouillons jamais inclus. */
export function allowedStatuses(requested: string[] | null | undefined): string[] | null {
  if (!requested || requested.length === 0) return null;
  const allowed = requested.filter((status) =>
    (EXPORTABLE_STATUSES as readonly string[]).includes(status),
  );
  return allowed.length > 0 ? allowed : null;
}

export async function fetchForExport(
  clinicId: string,
  filters: { dateFrom?: string | null; dateTo?: string | null; statuses?: string[] | null },
): Promise<ExportInvoice[]> {
  const where: Prisma.invoicesWhereInput = {
    clinic_id: clinicId,
    deleted_at: null,
    status: { not: 'draft' },
  };
  if (filters.statuses && filters.statuses.length > 0) {
    where.status = { in: filters.statuses };
  }
  const issueDate: Prisma.DateTimeNullableFilter = {};
  if (filters.dateFrom) issueDate.gte = new Date(`${filters.dateFrom}T00:00:00Z`);
  if (filters.dateTo) issueDate.lte = new Date(`${filters.dateTo}T00:00:00Z`);
  if (filters.dateFrom || filters.dateTo) where.issue_date = issueDate;

  return prisma.invoices.findMany({
    where,
    include: exportInclude,
    orderBy: [{ issue_date: 'asc' }, { invoice_number: 'asc' }],
  });
}

/** Taux unique (`21`/`10`) ou `varios` si la facture mélange les taux. */
export function vatRateLabel(invoice: ExportInvoice): string {
  const rates = new Set(invoice.invoice_items.map((item) => Number(item.vat_rate)));
  if (rates.size === 1) {
    const value = [...rates][0]!;
    return String(value);
  }
  return 'varios';
}

function cents(value: Prisma.Decimal | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 100);
}

function money(centsValue: number): number {
  return centsValue / 100;
}

function isoDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '';
}

export function invoiceRows(invoices: ExportInvoice[]): ExportRow[] {
  return invoices.map((invoice) => ({
    numero: invoice.invoice_number ?? '',
    serie: invoice.invoice_series?.prefix ?? '',
    fecha_emision: isoDate(invoice.issue_date),
    cliente: invoice.billing_name ?? '',
    nif: invoice.billing_tax_id ?? '',
    // Base imposable = sous-total avant taxe moins remises.
    base: money(cents(invoice.subtotal) - cents(invoice.total_discount)),
    tipo_iva: vatRateLabel(invoice),
    cuota_iva: money(cents(invoice.total_tax)),
    total: money(cents(invoice.total)),
    estado: invoice.status,
  }));
}

/** Une ligne par allocation facture ↔ paiement (off-books safe). */
export function paymentRows(invoices: ExportInvoice[]): ExportRow[] {
  const rows: ExportRow[] = [];
  for (const invoice of invoices) {
    for (const link of invoice.invoice_payments) {
      const payment = link.payments;
      rows.push({
        fecha_pago: isoDate(payment?.payment_date ?? null),
        factura: invoice.invoice_number ?? '',
        importe: money(cents(link.amount)),
        metodo: payment?.method ?? '',
        referencia: payment?.reference ?? '',
      });
    }
  }
  return rows;
}

export function totals(rows: ExportRow[]): { base: number; cuota: number; total: number } {
  let base = 0;
  let cuota = 0;
  let total = 0;
  for (const row of rows) {
    base += cents(row.base as number);
    cuota += cents(row.cuota_iva as number);
    total += cents(row.total as number);
  }
  return { base: money(base), cuota: money(cuota), total: money(total) };
}

const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Neutralise les formules tableur sur les valeurs texte (#611). */
export function csvCell(value: unknown): unknown {
  if (typeof value === 'string' && FORMULA_LEADERS.has(value.slice(0, 1))) {
    return `'${value}`;
  }
  return value;
}

function formatCell(value: string | number | null, separator: string): string {
  if (typeof value === 'number') {
    const text = value.toFixed(2);
    // Excel espagnol : « ; » avec virgule décimale, « , » avec point.
    return separator === ';' ? text.replace('.', ',') : text;
  }
  if (value === null || value === undefined) return '';
  return String(csvCell(String(value)));
}

function quoteField(text: string, separator: string): string {
  if (
    text.includes(separator) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r')
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** CSV UTF-8 avec BOM (comme Python), fins de ligne CRLF. */
export function toCsv(
  rows: ExportRow[],
  headers: readonly string[],
  separator = ',',
): Buffer {
  const lines = [headers.map((h) => quoteField(h, separator)).join(separator)];
  for (const row of rows) {
    lines.push(
      headers
        .map((header) => quoteField(formatCell(row[header] ?? null, separator), separator))
        .join(separator),
    );
  }
  return Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8'),
  ]);
}

/** Archive `facturas.csv` + `cobros.csv`. */
export function buildExportZip(invoices: ExportInvoice[], separator = ','): Buffer {
  return buildZip({
    'facturas.csv': toCsv(invoiceRows(invoices), INVOICE_HEADERS, separator),
    'cobros.csv': toCsv(paymentRows(invoices), PAYMENT_HEADERS, separator),
  });
}
