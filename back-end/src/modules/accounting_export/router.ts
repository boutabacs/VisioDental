/**
 * Routeur du module `accounting_export` — port de
 * `app/modules/accounting_export/router.py`, monté sous
 * `/api/v1/accounting_export`.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';

import { ok } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import {
  allowedStatuses,
  buildExportZip,
  fetchForExport,
  invoiceRows,
  paymentRows,
  totals,
} from './service';

export const accountingExportRouter = Router();

const SAMPLE = 10;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date ISO attendue (YYYY-MM-DD)')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Date invalide');

function queryDates(req: Request): { dateFrom: string | null; dateTo: string | null } {
  const rawFrom = req.query.date_from;
  const rawTo = req.query.date_to;
  const dateFrom = typeof rawFrom === 'string' ? isoDate.parse(rawFrom) : null;
  const dateTo = typeof rawTo === 'string' ? isoDate.parse(rawTo) : null;
  return { dateFrom, dateTo };
}

function queryStatuses(req: Request): string[] | null {
  const raw = req.query.status;
  const values = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string')
    : typeof raw === 'string'
      ? [raw]
      : [];
  return allowedStatuses(values);
}

/** Les Decimal FastAPI sortent en chaînes à deux décimales. */
function decimalStrings(row: Record<string, string | number | null>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = typeof value === 'number' ? value.toFixed(2) : value;
  }
  return out;
}

accountingExportRouter.get(
  '/preview',
  authenticate,
  requireClinic,
  requirePermission('accounting_export.export.read'),
  async (req, res) => {
    const { dateFrom, dateTo } = queryDates(req);
    const invoices = await fetchForExport(req.clinicId!, {
      dateFrom,
      dateTo,
      statuses: queryStatuses(req),
    });
    const invRows = invoiceRows(invoices);
    const payRows = paymentRows(invoices);
    const sums = totals(invRows);
    res.json(
      ok({
        invoice_count: invRows.length,
        payment_count: payRows.length,
        total_base: sums.base.toFixed(2),
        total_cuota: sums.cuota.toFixed(2),
        total: sums.total.toFixed(2),
        sample_invoices: invRows.slice(0, SAMPLE).map(decimalStrings),
        sample_payments: payRows.slice(0, SAMPLE).map(decimalStrings),
      }),
    );
  },
);

accountingExportRouter.get(
  '/run',
  authenticate,
  requireClinic,
  requirePermission('accounting_export.export.run'),
  async (req, res) => {
    const { dateFrom, dateTo } = queryDates(req);
    const separator = z.enum([',', ';']).parse(req.query.separator ?? ',');
    const invoices = await fetchForExport(req.clinicId!, {
      dateFrom,
      dateTo,
      statuses: queryStatuses(req),
    });
    const content = buildExportZip(invoices, separator);
    const suffix = `${dateFrom ?? 'inicio'}_${dateTo ?? 'fin'}`;
    res.setHeader('Content-Disposition', `attachment; filename="gestoria_${suffix}.zip"`);
    res.type('application/zip').send(content);
  },
);
