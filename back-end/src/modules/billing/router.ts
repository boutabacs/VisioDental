/**
 * Routeur du module `billing` — port route par route de
 * `backend/app/modules/billing/router.py` (26 routes, montées sous
 * `/api/v1/billing`).
 *
 * Gouvernance : `authenticate` → `requireClinic` → `requirePermission`
 * (`billing.read`, `billing.write`, `billing.admin`). Chaque accès est
 * scopé par `req.clinicId` : les lignes d'une autre clinique → 404.
 *
 * Écarts assumés par rapport à Python :
 * - `GET /invoices/:id/pdf` répond **501**
 *   `{"detail":"PDF generation is not available on the Express backend yet"}` :
 *   aucun moteur HTML→PDF (WeasyPrint) n'est installé et le contrat
 *   interdit d'ajouter des dépendances natives. L'aperçu
 *   (`/pdf/preview`) sert le HTML fidèle du générateur (`pdf.ts`).
 * - `POST /invoices/:id/send-email` n'a pas de bus d'événements : il
 *   valide la facture et le canal, journalise l'envoi et ajoute l'entrée
 *   d'historique `sent` (même état observable que Python sans abonné).
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';

import { ApiError, badRequest, notFound, unprocessable } from '../../lib/errors';
import { ok, paginated } from '../../lib/http';
import { prisma } from '../../lib/prisma';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import { getValues, SettingsClinicNotFoundError, updateValues } from '../settings/service';
import { SettingValueError } from '../settings/spec';
import {
  billingPartyUpdateSchema,
  billingSettingsUpdateSchema,
  clinicTodayAsDate,
  creditNoteCreateSchema,
  invoiceCreateSchema,
  invoiceFromBudgetCreateSchema,
  invoiceIssueRequestSchema,
  invoiceItemCreateSchema,
  invoiceItemUpdateSchema,
  invoicePaymentApplySchema,
  invoiceSendRequestSchema,
  invoiceSeriesCreateSchema,
  invoiceSeriesUpdateSchema,
  invoiceUpdateSchema,
  resolvedSendMethod,
  seriesResetSchema,
} from './schemas';
import { type PdfInvoice, invoicePdfFilename } from './pdf';
import { PdfEngineUnavailableError, renderPdf } from '../../lib/pdf-renderer';import {
  BillingValueError,
  PrefixConflictError,
  addHistory,
  canEdit,
  canRecordPayment,
  computePaidSummariesForInvoices,
  computePaidSummary,
  createCreditNote,
  createFromBudget,
  createInvoice,
  createItem,
  createPaymentRow,
  createSeries,
  deleteInvoice,
  deleteItem,
  generateInvoiceHtml,
  getInvoice,
  getPatientBillingSummary,
  getSeries,
  inTransaction,
  issueInvoice,
  linkInvoicePayment,
  listHistory,
  listInvoicePayments,
  listInvoices,
  listSeries,
  lockBudget,
  lookupLinkedPlan,
  parseDateInput,
  parseInstantInput,
  recalcInvoiceStatus,
  reconcilePayment,
  resetSeriesCounter,
  toInvoiceDetail,
  toInvoiceList,
  toInvoiceResponse,
  toPaymentDto,
  updateBillingParty,
  updateInvoice,
  updateItem,
  updateSeries,
  vatLegalNotesForInvoice,
  voidInvoice,
  type Db,
  type InvoiceDetailRow,
  type InvoiceResponseDto,
} from './service';

export const billingRouter = Router();

// ---------------------------------------------------------------------------
// Validation des requêtes (comportement Pydantic : erreurs → 422)
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();

function param(req: Request, key: string): string {
  const raw = req.params[key];
  if (typeof raw !== 'string' || raw === '') throw notFound('Not found');
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) throw unprocessable(`${key}: Input should be a valid UUID`);
  return parsed.data;
}

function queryValues(req: Request, key: string): string[] {
  const value = req.query[key];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function queryString(req: Request, key: string): string | null {
  const values = queryValues(req, key);
  return values.length > 0 ? values[0]! : null;
}

/** Paramètre liste (`?status=issued&status=draft`) : absent → `null`. */
function queryList(req: Request, key: string): string[] | null {
  const values = queryValues(req, key);
  return values.length > 0 ? values : null;
}

function queryBool(req: Request, key: string, fallback: boolean | null = null): boolean | null {
  const value = queryString(req, key);
  if (value === null || value === '') return fallback;
  const normalized = value.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw unprocessable(`${key}: Input should be a valid boolean`);
}

function queryInt(req: Request, key: string, fallback: number): number {
  const value = queryString(req, key);
  if (value === null || value === '') return fallback;
  if (!/^[+-]?\d+$/.test(value)) {
    throw unprocessable(`${key}: Input should be a valid integer`);
  }
  return Number.parseInt(value, 10);
}

function queryDate(req: Request, key: string): string | null {
  const value = queryString(req, key);
  if (value === null || value === '') return null;
  if (Number.isNaN(new Date(value).getTime())) {
    throw unprocessable(`${key}: Input should be a valid date`);
  }
  return value;
}

function queryUuid(req: Request, key: string): string | null {
  const value = queryString(req, key);
  if (value === null || value === '') return null;
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw unprocessable(`${key}: Input should be a valid UUID`);
  return parsed.data;
}

/** Corps validé par zod ; `ZodError` → 422 via le handler global. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  return schema.parse(body ?? null);
}

/** `ValueError` (`BillingValueError`) → 400, comme le routeur Python. */
async function orBadRequest<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BillingValueError) throw badRequest(error.message);
    throw error;
  }
}

function timeZone(req: Request): string {
  return req.clinic!.timezone;
}

function clinicToday(req: Request): Date {
  return clinicTodayAsDate(timeZone(req));
}

/** `_attach_paid_summary` : renseigne `total_paid` / `balance_due` en place. */
async function attachPaidSummary(
  db: Db,
  clinicId: string,
  response: InvoiceResponseDto,
): Promise<InvoiceResponseDto> {
  const summary = await computePaidSummary(db, clinicId, response.id);
  response.total_paid = summary.total_paid;
  response.balance_due = summary.balance_due;
  return response;
}

type Handler = (req: Request, res: Response) => Promise<void>;

function asyncRoute(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch((error: unknown) => {
      next(error);
    });
  };
}

/** Recharge la facture « base » pour la réponse, ou 404. */
async function reloadBase(req: Request, invoiceId: string): Promise<InvoiceResponseDto> {
  const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'base');
  if (!invoice) throw notFound('Invoice not found');
  return toInvoiceResponse(invoice, null);
}

// ============================================================================
// Séries de factures
// ============================================================================

billingRouter.get(
  '/series',
  authenticate,
  requireClinic,
  requirePermission('billing.admin'),
  asyncRoute(async (req, res) => {
    const series = await listSeries(
      prisma,
      req.clinicId!,
      queryString(req, 'series_type'),
      queryBool(req, 'active_only', true) ?? true,
    );
    res.json(ok(series));
  }),
);

billingRouter.post(
  '/series',
  authenticate,
  requireClinic,
  requirePermission('billing.admin'),
  asyncRoute(async (req, res) => {
    const data = parseBody(invoiceSeriesCreateSchema, req.body);
    const series = await orBadRequest(() =>
      inTransaction((tx) => createSeries(tx, req.clinicId!, data)),
    );
    res.status(201).json(ok(series));
  }),
);

billingRouter.put(
  '/series/:seriesId',
  authenticate,
  requireClinic,
  requirePermission('billing.admin'),
  asyncRoute(async (req, res) => {
    const seriesId = param(req, 'seriesId');
    const data = parseBody(invoiceSeriesUpdateSchema, req.body);
    const series = await getSeries(prisma, req.clinicId!, seriesId);
    if (!series) throw notFound('Series not found');
    // `exclude_unset` : ne transmettre que les clés présentes.
    const changes: Record<string, unknown> = {};
    for (const key of ['prefix', 'description', 'reset_yearly', 'is_default', 'is_active']) {
      if (key in data) changes[key] = (data as Record<string, unknown>)[key];
    }
    const updated = await orBadRequest(() =>
      inTransaction((tx) => updateSeries(tx, series, changes, req.user!.id)),
    );
    res.json(ok(updated));
  }),
);

billingRouter.post(
  '/series/:seriesId/reset',
  authenticate,
  requireClinic,
  requirePermission('billing.admin'),
  asyncRoute(async (req, res) => {
    const seriesId = param(req, 'seriesId');
    const data = parseBody(seriesResetSchema, req.body);
    const series = await getSeries(prisma, req.clinicId!, seriesId);
    if (!series) throw notFound('Series not found');
    const updated = await orBadRequest(() =>
      inTransaction((tx) => resetSeriesCounter(tx, series, data.new_number, req.user!.id)),
    );
    res.json(ok(updated));
  }),
);

// ============================================================================
// Factures — liste et détail
// ============================================================================

const VALID_COMPLIANCE_SEVERITIES = new Set(['ok', 'warning', 'pending', 'error']);

billingRouter.get(
  '/invoices',
  authenticate,
  requireClinic,
  requirePermission('billing.read'),
  asyncRoute(async (req, res) => {
    // `page`/`page_size` : bornes Pydantic (422 hors [1,1] / [1,100]).
    const page = queryInt(req, 'page', 1);
    if (page < 1) throw unprocessable('page: Input should be greater than or equal to 1');
    const pageSize = queryInt(req, 'page_size', 20);
    if (pageSize < 1) throw unprocessable('page_size: Input should be greater than or equal to 1');
    if (pageSize > 100) throw unprocessable('page_size: Input should be less than or equal to 100');

    const sort = queryString(req, 'sort');
    if (sort !== null && sort.length > 50) {
      throw unprocessable('sort: String should have at most 50 characters');
    }
    const complianceSeverity = queryList(req, 'compliance_severity');
    if (complianceSeverity) {
      const invalid = [...new Set(complianceSeverity)]
        .filter((severity) => !VALID_COMPLIANCE_SEVERITIES.has(severity))
        .sort();
      if (invalid.length > 0) {
        throw unprocessable(
          `Invalid compliance_severity values: [${invalid.map((value) => `'${value}'`).join(', ')}]`,
        );
      }
    }

    const { rows, total } = await listInvoices(prisma, req.clinicId!, timeZone(req), {
      page,
      pageSize,
      patientId: queryUuid(req, 'patient_id'),
      status: queryList(req, 'status'),
      dateFrom: queryDate(req, 'date_from'),
      dateTo: queryDate(req, 'date_to'),
      dueFrom: queryDate(req, 'due_from'),
      dueTo: queryDate(req, 'due_to'),
      overdue: queryBool(req, 'overdue'),
      search: queryString(req, 'search'),
      budgetId: queryUuid(req, 'budget_id'),
      isCreditNote: queryBool(req, 'is_credit_note'),
      complianceSeverity,
      sort,
    });
    const items = rows.map(toInvoiceList);
    const summaries = await computePaidSummariesForInvoices(
      prisma,
      req.clinicId!,
      rows.map((row) => row.id),
    );
    rows.forEach((row, index) => {
      const summary = summaries.get(row.id);
      items[index]!.total_paid = summary ? summary.total_paid : 0;
      items[index]!.balance_due = summary ? summary.balance_due : Number(row.total);
    });
    res.json(paginated(items, total, page, pageSize));
  }),
);

billingRouter.get(
  '/invoices/:invoiceId',
  authenticate,
  requireClinic,
  requirePermission('billing.read'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'detail');
    if (!invoice) throw notFound('Invoice not found');
    const response = toInvoiceDetail(invoice);
    if (invoice.budget_id) {
      response.treatment_plan = await lookupLinkedPlan(prisma, req.clinicId!, invoice.budget_id);
    }
    res.json(ok(await attachPaidSummary(prisma, req.clinicId!, response)));
  }),
);

billingRouter.post(
  '/invoices',
  authenticate,
  requireClinic,
  requirePermission('billing.write'),
  asyncRoute(async (req, res) => {
    const data = parseBody(invoiceCreateSchema, req.body);
    const created = await orBadRequest(() =>
      inTransaction(async (tx) => {
        const invoice = await createInvoice(tx, req.clinicId!, req.user!.id, {
          patientId: data.patient_id,
          seriesId: data.series_id ?? null,
          paymentTermDays: data.payment_term_days,
          dueDate: parseDateInput(data.due_date),
          internalNotes: data.internal_notes ?? null,
          publicNotes: data.public_notes ?? null,
        });
        for (const item of data.items) {
          await createItem(tx, req.clinicId!, invoice, item);
        }
        return invoice;
      }),
    );
    res.status(201).json(ok(await reloadBase(req, created.id)));
  }),
);

billingRouter.post(
  '/invoices/from-budget/:budgetId',
  authenticate,
  requireClinic,
  requirePermission('billing.write'),
  asyncRoute(async (req, res) => {
    const budgetId = param(req, 'budgetId');
    const data = parseBody(invoiceFromBudgetCreateSchema, req.body);
    const created = await orBadRequest(() =>
      inTransaction((tx) =>
        createFromBudget(tx, req.clinicId!, req.user!.id, {
          budgetId,
          items: data.items,
          paymentTermDays: data.payment_term_days ?? null,
          dueDate: parseDateInput(data.due_date),
          internalNotes: data.internal_notes ?? null,
          publicNotes: data.public_notes ?? null,
        }),
      ),
    );
    res.status(201).json(ok(await reloadBase(req, created.id)));
  }),
);

billingRouter.put(
  '/invoices/:invoiceId',
  authenticate,
  requireClinic,
  requirePermission('billing.write'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const data = parseBody(invoiceUpdateSchema, req.body);
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'base');
    if (!invoice) throw notFound('Invoice not found');

    await orBadRequest(() =>
      inTransaction((tx) =>
        updateInvoice(tx, invoice, req.user!.id, {
          ...(data.patient_id !== undefined ? { patient_id: data.patient_id } : {}),
          ...(data.payment_term_days !== undefined
            ? { payment_term_days: data.payment_term_days }
            : {}),
          ...(data.due_date !== undefined ? { due_date: parseDateInput(data.due_date) } : {}),
          ...(data.internal_notes !== undefined ? { internal_notes: data.internal_notes } : {}),
          ...(data.public_notes !== undefined ? { public_notes: data.public_notes } : {}),
        }),
      ),
    );
    res.json(ok(await reloadBase(req, invoiceId)));
  }),
);

billingRouter.patch(
  '/invoices/:invoiceId/billing-party',
  authenticate,
  requireClinic,
  requirePermission('billing.write'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const data = parseBody(billingPartyUpdateSchema, req.body);
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'base');
    if (!invoice) throw notFound('Invoice not found');

    try {
      await inTransaction((tx) =>
        updateBillingParty(tx, invoice, {
          newName: data.billing_name,
          newTaxId: data.billing_tax_id,
          newAddress: data.billing_address,
          expectedUpdatedAt: parseInstantInput(data.expected_updated_at),
          changedBy: req.user!.id,
        }),
      );
    } catch (error) {
      if (error instanceof BillingValueError) {
        // Conflit d'édition optimiste → 409 ; autre règle métier → 422.
        throw new ApiError(/concurrent/i.test(error.message) ? 409 : 422, error.message);
      }
      throw error;
    }
    res.json(ok(await reloadBase(req, invoiceId)));
  }),
);

billingRouter.delete(
  '/invoices/:invoiceId',
  authenticate,
  requireClinic,
  requirePermission('billing.write'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'base');
    if (!invoice) throw notFound('Invoice not found');
    await orBadRequest(() =>
      inTransaction(async (tx) => {
        const fresh = await getInvoice(tx, req.clinicId!, invoiceId, 'base');
        if (!fresh) throw notFound('Invoice not found');
        await deleteInvoice(tx, fresh, req.user!.id);
      }),
    );
    res.status(204).end();
  }),
);

// ============================================================================
// Lignes de facture
// ============================================================================

billingRouter.post(
  '/invoices/:invoiceId/items',
  authenticate,
  requireClinic,
  requirePermission('billing.write'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const data = parseBody(invoiceItemCreateSchema, req.body);
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'detail');
    if (!invoice) throw notFound('Invoice not found');
    if (!canEdit(invoice)) throw badRequest('Can only edit draft invoices');
    const item = await orBadRequest(() =>
      inTransaction((tx) => createItem(tx, req.clinicId!, invoice, data)),
    );
    res.status(201).json(ok(item));
  }),
);

billingRouter.put(
  '/invoices/:invoiceId/items/:itemId',
  authenticate,
  requireClinic,
  requirePermission('billing.write'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const itemId = param(req, 'itemId');
    const data = parseBody(invoiceItemUpdateSchema, req.body);
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'detail');
    if (!invoice) throw notFound('Invoice not found');
    if (!canEdit(invoice)) throw badRequest('Can only edit draft invoices');
    const item = invoice.invoice_items.find((entry) => entry.id === itemId);
    if (!item) throw notFound('Item not found');
    const updated = await orBadRequest(() =>
      inTransaction((tx) => updateItem(tx, req.clinicId!, item, invoice, data)),
    );
    res.json(ok(updated));
  }),
);

billingRouter.delete(
  '/invoices/:invoiceId/items/:itemId',
  authenticate,
  requireClinic,
  requirePermission('billing.write'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const itemId = param(req, 'itemId');
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'detail');
    if (!invoice) throw notFound('Invoice not found');
    if (!canEdit(invoice)) throw badRequest('Can only edit draft invoices');
    const item = invoice.invoice_items.find((entry) => entry.id === itemId);
    if (!item) throw notFound('Item not found');
    await inTransaction((tx) => deleteItem(tx, item, invoice));
    res.status(204).end();
  }),
);

// ============================================================================
// Workflow
// ============================================================================

billingRouter.post(
  '/invoices/:invoiceId/issue',
  authenticate,
  requireClinic,
  requirePermission('billing.write'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const data = parseBody(invoiceIssueRequestSchema, req.body);
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'base');
    if (!invoice) throw notFound('Invoice not found');

    const issued = await orBadRequest(() =>
      inTransaction(async (tx) => {
        // Sérialise deux émissions concurrentes du même brouillon : le
        // second appel voit « issued » et la garde brouillon le refuse.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM invoices
          WHERE id = ${invoiceId}::uuid AND clinic_id = ${req.clinicId!}::uuid
          FOR UPDATE`;
        if (locked.length === 0) throw notFound('Invoice not found');
        return issueInvoice(tx, invoiceId, {
          issuedBy: req.user!.id,
          issueDate: parseDateInput(data?.issue_date),
          today: clinicToday(req),
        });
      }),
    );
    res.json(ok(toInvoiceResponse(issued, null)));
  }),
);

billingRouter.post(
  '/invoices/:invoiceId/send-email',
  authenticate,
  requireClinic,
  requirePermission('billing.write'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const data = parseBody(invoiceSendRequestSchema, req.body);
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'base');
    if (!invoice) throw notFound('Invoice not found');

    if (!['issued', 'partial', 'paid'].includes(invoice.status)) {
      throw badRequest(
        `Cannot send invoice with status '${invoice.status}'. Invoice must be issued first.`,
      );
    }

    const sendMethod = resolvedSendMethod(data);
    const patient = invoice.patients;
    if (sendMethod === 'email' && (!patient || !patient.email)) {
      throw badRequest('Cannot send email: patient has no email address');
    }
    if (sendMethod === 'whatsapp' && (!patient || !patient.phone)) {
      throw badRequest('Cannot send WhatsApp: patient has no phone number');
    }
    const recipientEmail = patient && sendMethod === 'email' ? patient.email : null;

    // Remplace `event_bus.publish(INVOICE_SENT)` : pas de bus côté Express
    // ni d'expéditeur SMTP ; l'effet observable restant est l'historique.
    console.info(
      `[billing] invoice.sent invoice=${invoice.id} patient=${invoice.patient_id} method=${sendMethod} email=${recipientEmail ?? '-'}`,
    );
    await inTransaction((tx) =>
      addHistory(tx, {
        clinic_id: invoice.clinic_id,
        invoice_id: invoice.id,
        action: 'sent',
        changed_by: req.user!.id,
        previous_state: {},
        new_state: { send_method: sendMethod, recipient_email: recipientEmail },
      }),
    );
    res.json(ok(await reloadBase(req, invoiceId)));
  }),
);

billingRouter.post(
  '/invoices/:invoiceId/void',
  authenticate,
  requireClinic,
  requirePermission('billing.admin'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const reason = queryString(req, 'reason');
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'base');
    if (!invoice) throw notFound('Invoice not found');
    const voided = await orBadRequest(() =>
      inTransaction((tx) => voidInvoice(tx, invoice, req.user!.id, reason)),
    );
    res.json(ok(toInvoiceResponse(voided, null)));
  }),
);

billingRouter.post(
  '/invoices/:invoiceId/credit-note',
  authenticate,
  requireClinic,
  requirePermission('billing.write'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const data = parseBody(creditNoteCreateSchema, req.body);
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'detail');
    if (!invoice) throw notFound('Invoice not found');
    const creditNoteId = await orBadRequest(() =>
      inTransaction((tx) =>
        createCreditNote(tx, invoice, {
          createdBy: req.user!.id,
          reason: data.reason,
          items: data.items.length > 0 ? data.items : null,
        }),
      ),
    );
    res.status(201).json(ok(await reloadBase(req, creditNoteId)));
  }),
);

// ============================================================================
// Liens facture ↔ paiement
// ============================================================================

billingRouter.get(
  '/invoices/:invoiceId/payments',
  authenticate,
  requireClinic,
  requirePermission('billing.read'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'base');
    if (!invoice) throw notFound('Invoice not found');
    res.json(ok(await listInvoicePayments(prisma, req.clinicId!, invoiceId)));
  }),
);

/** `Decimal` → `12.50` pour les messages (`f"{Decimal}"`). */
function centsLabel(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

billingRouter.post(
  '/invoices/:invoiceId/payments',
  authenticate,
  requireClinic,
  requirePermission('billing.write'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const data = parseBody(invoicePaymentApplySchema, req.body);
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'base');
    if (!invoice) throw notFound('Invoice not found');
    if (!canRecordPayment(invoice)) {
      throw badRequest(`Cannot record payment for invoice with status '${invoice.status}'`);
    }

    const amountCents = Math.round(data.amount * 100);
    // `payment_date` par défaut : aujourd'hui (heure serveur, comme Python).
    const now = new Date();
    const paymentDate =
      parseDateInput(data.payment_date) ??
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const linkId = await orBadRequest(() =>
      inTransaction(async (tx) => {
        // Ordre de verrouillage imposé : devis puis facture.
        if (invoice.budget_id !== null) await lockBudget(tx, req.clinicId!, invoice.budget_id);
        await tx.$queryRaw`
          SELECT id FROM invoices
          WHERE id = ${invoiceId}::uuid AND clinic_id = ${req.clinicId!}::uuid
          FOR UPDATE`;

        const summary = await computePaidSummary(tx, req.clinicId!, invoiceId);
        const balanceCents = Math.round(summary.balance_due * 100);
        if (amountCents > balanceCents) {
          throw badRequest(
            `Payment amount (${centsLabel(amountCents)}) exceeds balance due (${centsLabel(balanceCents)})`,
          );
        }

        const fromBudget = invoice.budget_id !== null;
        const paymentId = await createPaymentRow(tx, {
          clinicId: req.clinicId!,
          currency: req.clinic!.currency,
          patientId: invoice.patient_id,
          amountCents,
          method: data.method,
          paymentDate,
          recordedBy: req.user!.id,
          allocations: [
            fromBudget
              ? { target_type: 'budget', budgetId: invoice.budget_id, cents: amountCents }
              : { target_type: 'on_account', budgetId: null, cents: amountCents },
          ],
          reference: data.reference ?? null,
          notes: data.notes ?? null,
        });

        if (fromBudget) {
          // Le bridge crée le lien via l'allocataire `budget`, en préférant
          // cette facture.
          await reconcilePayment(tx, {
            clinicId: req.clinicId!,
            paymentId,
            actorId: req.user!.id,
            preferInvoiceId: invoiceId,
          });
          const created = await tx.invoice_payments.findFirst({
            where: { invoice_id: invoiceId, payment_id: paymentId },
          });
          if (!created) throw badRequest('Payment could not be imputed to this invoice');
          return created.id;
        }

        const created = await linkInvoicePayment(tx, {
          clinicId: req.clinicId!,
          invoiceId,
          paymentId,
          cents: amountCents,
          createdBy: req.user!.id,
        });
        await recalcInvoiceStatus(tx, invoice, req.user!.id);
        return created.id;
      }),
    );

    // `InvoicePaymentResponse.model_validate(link)`.
    const link = await prisma.invoice_payments.findUniqueOrThrow({ where: { id: linkId } });
    res.status(201).json(
      ok({
        id: link.id,
        invoice_id: link.invoice_id,
        payment_id: link.payment_id,
        amount: Number(link.amount),
        created_by: link.created_by,
        created_at: link.created_at.toISOString().replace('Z', ''),
      }),
    );
  }),
);

// ============================================================================
// Historique
// ============================================================================

billingRouter.get(
  '/invoices/:invoiceId/history',
  authenticate,
  requireClinic,
  requirePermission('billing.read'),
  asyncRoute(async (req, res) => {
    const invoiceId = param(req, 'invoiceId');
    const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'base');
    if (!invoice) throw notFound('Invoice not found');
    res.json(ok(await listHistory(prisma, req.clinicId!, invoiceId)));
  }),
);

// ============================================================================
// PDF
// ============================================================================

const PDF_LOCALE_VALUES = [
  'es', 'en', 'ta', 'te', 'hi', 'fr', 'pt', 'pt-BR', 'de', 'hu', 'pl', 'it', 'ar',
];

function pdfLocale(req: Request): string {
  const locale = queryString(req, 'locale') ?? 'es';
  if (!PDF_LOCALE_VALUES.includes(locale)) {
    throw unprocessable(
      `locale: String should match pattern '^(${PDF_LOCALE_VALUES.join('|')})$'`,
    );
  }
  return locale;
}

/** `_merge_vat_legal_notes` (registre de hooks pays vide côté Express). */
async function pdfExtras(invoice: InvoiceDetailRow): Promise<Record<string, unknown> | null> {
  const notes = await vatLegalNotesForInvoice(prisma, invoice.clinic_id, invoice);
  return notes.length > 0 ? { legal_notices: notes } : null;
}

async function invoiceForPdf(req: Request): Promise<InvoiceDetailRow> {
  const invoiceId = param(req, 'invoiceId');
  const invoice = await getInvoice(prisma, req.clinicId!, invoiceId, 'detail');
  if (!invoice) throw notFound('Invoice not found');
  return invoice;
}

/** `PdfInvoice` depuis la ligne détaillée (relations ORM → dictionnaire Python). */
function toPdfInvoice(invoice: InvoiceDetailRow): PdfInvoice {
  return {
    status: invoice.status,
    credit_note_for_id: invoice.credit_note_for_id,
    invoice_number: invoice.invoice_number,
    issue_date: invoice.issue_date,
    due_date: invoice.due_date,
    payment_term_days: invoice.payment_term_days,
    billing_name: invoice.billing_name,
    billing_tax_id: invoice.billing_tax_id,
    billing_address: invoice.billing_address,
    subtotal: invoice.subtotal,
    total_discount: invoice.total_discount,
    total_tax: invoice.total_tax,
    total: invoice.total,
    public_notes: invoice.public_notes,
    patient: invoice.patients
      ? { first_name: invoice.patients.first_name, last_name: invoice.patients.last_name }
      : null,
    credit_note_for: invoice.invoices
      ? { invoice_number: invoice.invoices.invoice_number }
      : null,
    items: invoice.invoice_items.map((item) => ({
      description: item.description,
      internal_code: item.internal_code,
      quantity: item.quantity,
      unit_price: item.unit_price,
      line_discount: item.line_discount,
      vat_rate: item.vat_rate,
      line_total: item.line_total,
      tooth_number: item.tooth_number,
      surfaces: item.surfaces,
    })),
  };
}

function clinicForPdf(req: Request) {
  const clinic = req.clinic!;
  return {
    name: clinic.name,
    tax_id: clinic.tax_id,
    address: clinic.address,
    phone: clinic.phone,
    email: clinic.email,
    timezone: clinic.timezone,
    settings: clinic.settings,
    currency: clinic.currency,
  };
}

/** Rend le HTML et envoie le PDF ; 501 si aucun moteur Chromium n'est installé. */
async function sendInvoicePdf(
  res: Response,
  html: string,
  filename: string,
  disposition: 'attachment' | 'inline',
): Promise<void> {
  let pdf: Buffer;
  try {
    pdf = await renderPdf(html);
  } catch (error) {
    if (error instanceof PdfEngineUnavailableError) {
      throw new ApiError(501, 'PDF generation is not available on the Express backend yet');
    }
    throw error;
  }
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.type('application/pdf').send(pdf);
}

billingRouter.get(
  '/invoices/:invoiceId/pdf',
  authenticate,
  requireClinic,
  requirePermission('billing.read'),
  asyncRoute(async (req, res) => {
    const locale = pdfLocale(req);
    const invoice = await invoiceForPdf(req);
    const summary = await computePaidSummary(prisma, req.clinicId!, invoice.id);
    const html = generateInvoiceHtml(toPdfInvoice(invoice), clinicForPdf(req), {
      isPreview: false,
      locale,
      extraPdfData: await pdfExtras(invoice),
      totalPaid: summary.total_paid,
      balanceDue: summary.balance_due,
    });
    await sendInvoicePdf(res, html, invoicePdfFilename(invoice), 'attachment');
  }),
);

billingRouter.get(
  '/invoices/:invoiceId/pdf/preview',
  authenticate,
  requireClinic,
  requirePermission('billing.read'),
  asyncRoute(async (req, res) => {
    const locale = pdfLocale(req);
    const invoice = await invoiceForPdf(req);
    const summary = await computePaidSummary(prisma, req.clinicId!, invoice.id);
    const html = generateInvoiceHtml(toPdfInvoice(invoice), clinicForPdf(req), {
      isPreview: true,
      locale,
      extraPdfData: await pdfExtras(invoice),
      totalPaid: summary.total_paid,
      balanceDue: summary.balance_due,
    });
    res.setHeader('Content-Disposition', 'inline');
    res.type('text/html; charset=utf-8').send(html);
  }),
);

// ============================================================================
// Paramètres de facturation (clinics.settings['billing'])
// ============================================================================

interface BillingSettingsDto {
  default_payment_term_days: number;
  invoice_footer_text: string | null;
  bank_account_info: string | null;
}

function toBillingSettings(values: Record<string, unknown>): BillingSettingsDto {
  const term = values.default_payment_term_days;
  const text = (key: string): string | null =>
    typeof values[key] === 'string' ? (values[key] as string) : null;
  return {
    default_payment_term_days: typeof term === 'number' ? term : 30,
    invoice_footer_text: text('invoice_footer_text'),
    bank_account_info: text('bank_account_info'),
  };
}

billingRouter.get(
  '/settings',
  authenticate,
  requireClinic,
  requirePermission('billing.read'),
  asyncRoute(async (req, res) => {
    try {
      res.json(ok(toBillingSettings(await getValues(req.clinicId!, 'billing'))));
    } catch (error) {
      if (error instanceof SettingsClinicNotFoundError) throw notFound('Clinic not found');
      throw error;
    }
  }),
);

billingRouter.put(
  '/settings',
  authenticate,
  requireClinic,
  requirePermission('billing.admin'),
  asyncRoute(async (req, res) => {
    const data = parseBody(billingSettingsUpdateSchema, req.body);
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && value !== null) values[key] = value;
    }
    try {
      res.json(ok(toBillingSettings(await updateValues(req.clinicId!, 'billing', values))));
    } catch (error) {
      if (error instanceof SettingsClinicNotFoundError) throw notFound('Clinic not found');
      if (error instanceof SettingValueError) throw unprocessable(error.message);
      throw error;
    }
  }),
);

// ============================================================================
// Résumé de facturation patient
// ============================================================================

billingRouter.get(
  '/patients/:patientId/summary',
  authenticate,
  requireClinic,
  requirePermission('billing.read'),
  asyncRoute(async (req, res) => {
    const patientId = param(req, 'patientId');
    res.json(ok(await getPatientBillingSummary(prisma, req.clinicId!, patientId)));
  }),
);
