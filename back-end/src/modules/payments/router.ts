/**
 * API `/api/v1/payments` — port de
 * `backend/app/modules/payments/router.py`.
 *
 * Les rapports sont imbriqués sous `/reports/*` : le module possède à la
 * fois la surface opérationnelle et analytique (les KPI d'encaissement
 * ne doivent pas être croisés avec les factures — règle « off-books »).
 */
import { Router, type Request } from 'express';
import { z } from 'zod';

import { ApiError, notFound, unprocessable } from '../../lib/errors';
import { ok, paginated } from '../../lib/http';
import { toClinicDateString } from '../../lib/time';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import {
  BUDGET_PAYMENT_STATUSES,
  budgetIdsRequestSchema,
  decimalFromUnknown,
  parseSort,
  patientIdsRequestSchema,
  paymentCreateSchema,
  paymentReallocateSchema,
  refundCreateSchema,
  TREND_GRANULARITIES,
  type TrendGranularity,
} from './schemas';
import {
  budgetIdsByPaymentStatus,
  computePendingCharges,
  getPatientLedger,
  getPayment,
  getAllocationsForBudget,
  listPayments,
  patientIdsWithDebt,
  PaymentWorkflowError,
  recordPayment,
  reallocatePayment,
  refundPayment,
  getRefundsForPayment,
  reportsAgingReceivables,
  reportsByMethod,
  reportsByProfessional,
  reportsRefunds,
  reportsSummary,
  reportsTrends,
  summariesByBudgets,
  summariesByPatients,
  toPaymentDto,
} from './service';

export const paymentsRouter = Router();

const uuid = z.string().uuid();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Input should be a valid date');

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function queryList(req: Request, key: string): string[] {
  const value = req.query[key];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

/** Entier de requête ; 422 quand la valeur n'est pas un entier (FastAPI). */
function queryInt(req: Request, key: string, fallback: number): number {
  const raw = queryString(req, key);
  if (raw === undefined || raw === '') return fallback;
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    throw unprocessable(`Input should be a valid integer, unable to parse string as an integer`);
  }
  return Number.parseInt(raw, 10);
}

function queryBool(req: Request, key: string): boolean | null {
  const raw = queryString(req, key);
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'on', 'yes', 't'].includes(value)) return true;
  if (['false', '0', 'off', 'no', 'f'].includes(value)) return false;
  throw unprocessable('Input should be a valid boolean');
}

function queryDecimal(req: Request, key: string, fallback: string | null): string | null {
  const raw = queryString(req, key);
  if (raw === undefined) return fallback;
  if (decimalFromUnknown(raw) === null) {
    throw unprocessable('Input should be a valid decimal');
  }
  return raw;
}

function queryDate(req: Request, key: string, required: true): string;
function queryDate(req: Request, key: string, required: false): string | null;
function queryDate(req: Request, key: string, required: boolean): string | null {
  const raw = queryString(req, key);
  if (raw === undefined || raw === '') {
    if (required) throw unprocessable('Field required');
    return null;
  }
  const parsed = dateOnly.safeParse(raw);
  if (!parsed.success) {
    throw unprocessable('Input should be a valid date');
  }
  return raw;
}

function parseUuidParam(value: string | string[] | undefined): string {
  const parsed = uuid.safeParse(Array.isArray(value) ? value[0] : value);
  if (!parsed.success) {
    throw unprocessable(`Input should be a valid UUID, invalid character`);
  }
  return parsed.data;
}

/** `PaymentWorkflowError` → 422 `{detail}` (comme `_bad_request` payments). */
function workflowError(error: unknown): never {
  if (error instanceof PaymentWorkflowError) {
    throw new ApiError(422, error.message);
  }
  throw error;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  return schema.parse(body ?? {});
}

// --- Payments -------------------------------------------------------------

paymentsRouter.get(
  '',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const rawPage = queryInt(req, 'page', 1);
    if (rawPage < 1) {
      throw unprocessable('Input should be greater than or equal to 1');
    }
    const rawPageSize = queryInt(req, 'page_size', 20);
    if (rawPageSize < 1) {
      throw unprocessable('Input should be greater than or equal to 1');
    }
    if (rawPageSize > 100) {
      throw unprocessable('Input should be less than or equal to 100');
    }

    const dateFrom = queryDate(req, 'date_from', false);
    const dateTo = queryDate(req, 'date_to', false);
    const method = queryString(req, 'method') ?? null;
    const patientRaw = queryString(req, 'patient_id');
    const patientId = patientRaw ? parseUuidParam(patientRaw) : null;
    const hasRefunds = queryBool(req, 'has_refunds');
    const hasUnallocated = queryBool(req, 'has_unallocated');
    const amountMinRaw = queryDecimal(req, 'amount_min', null);
    const amountMaxRaw = queryDecimal(req, 'amount_max', null);
    const sortRaw = queryString(req, 'sort');
    if (sortRaw !== undefined && sortRaw.length > 50) {
      throw unprocessable('String should have at most 50 characters');
    }
    const sort = sortRaw === undefined || sortRaw === '' ? undefined : parseSort(sortRaw);

    const result = await listPayments(
      req.clinicId!,
      {
        date_from: dateFrom,
        date_to: dateTo,
        method,
        patient_id: patientId,
        has_refunds: hasRefunds,
        has_unallocated: hasUnallocated,
        amount_min: amountMinRaw === null ? null : decimalFromUnknown(amountMinRaw),
        amount_max: amountMaxRaw === null ? null : decimalFromUnknown(amountMaxRaw),
        sort,
      },
      rawPage,
      rawPageSize,
    );

    res.json(paginated(result.rows, result.total, rawPage, rawPageSize));
  },
);

paymentsRouter.post(
  '',
  authenticate,
  requireClinic,
  requirePermission('payments.record.write'),
  async (req, res) => {
    const payload = parseBody(paymentCreateSchema, req.body);

    let payment;
    try {
      payment = await recordPayment({
        clinicId: req.clinicId!,
        currency: req.clinic!.currency,
        patientId: payload.patient_id,
        amount: payload.amount,
        method: payload.method,
        // `date.today()` côté Python : date du calendrier de la clinique.
        paymentDate:
          payload.payment_date ?? toClinicDateString(new Date(), req.clinic!.timezone)!,
        recordedBy: req.user!.id,
        allocations: payload.allocations,
        reference: payload.reference,
        notes: payload.notes,
        idempotencyKey: payload.idempotency_key,
      });
    } catch (error) {
      workflowError(error);
    }

    const fresh = await getPayment(req.clinicId!, payment.id);
    if (!fresh) {
      throw new ApiError(500, 'Payment vanished after create');
    }
    res.status(201).json(ok(toPaymentDto(fresh)));
  },
);

paymentsRouter.get(
  '/:payment_id',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const paymentId = parseUuidParam(req.params.payment_id!);
    const payment = await getPayment(req.clinicId!, paymentId);
    if (!payment) throw notFound('Payment not found');
    res.json(ok(toPaymentDto(payment)));
  },
);

paymentsRouter.post(
  '/:payment_id/reallocate',
  authenticate,
  requireClinic,
  requirePermission('payments.record.write'),
  async (req, res) => {
    const paymentId = parseUuidParam(req.params.payment_id!);
    const payment = await getPayment(req.clinicId!, paymentId);
    if (!payment) throw notFound('Payment not found');

    const payload = parseBody(paymentReallocateSchema, req.body);
    try {
      await reallocatePayment(req.clinicId!, payment, payload.allocations, req.user!.id);
    } catch (error) {
      workflowError(error);
    }

    const fresh = await getPayment(req.clinicId!, paymentId);
    if (!fresh) throw notFound('Payment not found');
    res.json(ok(toPaymentDto(fresh)));
  },
);

// --- Refunds ---------------------------------------------------------------

paymentsRouter.get(
  '/:payment_id/refunds',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const paymentId = parseUuidParam(req.params.payment_id!);
    const payment = await getPayment(req.clinicId!, paymentId);
    if (!payment) throw notFound('Payment not found');
    res.json(ok(await getRefundsForPayment(payment)));
  },
);

paymentsRouter.post(
  '/:payment_id/refunds',
  authenticate,
  requireClinic,
  requirePermission('payments.record.refund'),
  async (req, res) => {
    const paymentId = parseUuidParam(req.params.payment_id!);
    const payment = await getPayment(req.clinicId!, paymentId);
    if (!payment) throw notFound('Payment not found');

    const payload = parseBody(refundCreateSchema, req.body);
    let refund;
    try {
      refund = await refundPayment({
        clinicId: req.clinicId!,
        payment: { id: payment.id, amount: payment.amount },
        amount: payload.amount,
        method: payload.method,
        reasonCode: payload.reason_code,
        reasonNote: payload.reason_note,
        refundedBy: req.user!.id,
      });
    } catch (error) {
      workflowError(error);
    }
    res.status(201).json(ok(refund));
  },
);

// --- Ledger / per-budget ---------------------------------------------------

paymentsRouter.get(
  '/patients/:patient_id/ledger',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const patientId = parseUuidParam(req.params.patient_id!);
    const ledger = await getPatientLedger(req.clinicId!, patientId, req.clinic!.currency);
    res.json(ok(ledger));
  },
);

paymentsRouter.get(
  '/patients/:patient_id/pending-charges',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const patientId = parseUuidParam(req.params.patient_id!);
    const pending = await computePendingCharges(req.clinicId!, patientId);
    res.json(ok(pending));
  },
);

paymentsRouter.get(
  '/budgets/:budget_id/allocations',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const budgetId = parseUuidParam(req.params.budget_id!);
    const rows = await getAllocationsForBudget(req.clinicId!, budgetId);
    res.json(ok(rows));
  },
);

// --- Cross-module summary + filter endpoints --------------------------------

paymentsRouter.post(
  '/summary/by-budgets',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const payload = parseBody(budgetIdsRequestSchema, req.body);
    const summaries = await summariesByBudgets(req.clinicId!, payload.budget_ids);
    res.json(ok({ summaries }));
  },
);

paymentsRouter.post(
  '/summary/by-patients',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const payload = parseBody(patientIdsRequestSchema, req.body);
    const summaries = await summariesByPatients(req.clinicId!, payload.patient_ids);
    res.json(ok({ summaries }));
  },
);

paymentsRouter.get(
  '/filters/budgets-by-status',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const statuses = queryList(req, 'status');
    if (statuses.length === 0) {
      throw unprocessable('Field required');
    }
    for (const status of statuses) {
      if (!(BUDGET_PAYMENT_STATUSES as readonly string[]).includes(status)) {
        throw unprocessable(
          `Input should be 'unpaid', 'partial' or 'paid'`,
        );
      }
    }
    const patientRaw = queryString(req, 'patient_id');
    const professionalRaw = queryString(req, 'assigned_professional_id');

    const result = await budgetIdsByPaymentStatus(req.clinicId!, statuses, {
      patient_id: patientRaw ? parseUuidParam(patientRaw) : null,
      assigned_professional_id: professionalRaw ? parseUuidParam(professionalRaw) : null,
    });
    res.json(ok({ budget_ids: result.ids, truncated: result.truncated }));
  },
);

paymentsRouter.get(
  '/filters/patients-with-debt',
  authenticate,
  requireClinic,
  requirePermission('payments.record.read'),
  async (req, res) => {
    const minDebtRaw = queryDecimal(req, 'min_debt', '0.01')!;
    const minDebt = decimalFromUnknown(minDebtRaw);
    if (minDebt === null || minDebt.lessThan(0)) {
      throw unprocessable('Input should be greater than or equal to 0');
    }
    const result = await patientIdsWithDebt(req.clinicId!, minDebt);
    res.json(ok({ patient_ids: result.ids, truncated: result.truncated }));
  },
);

// --- Reports ---------------------------------------------------------------

paymentsRouter.get(
  '/reports/summary',
  authenticate,
  requireClinic,
  requirePermission('payments.reports.read'),
  async (req, res) => {
    const dateFrom = queryDate(req, 'date_from', true);
    const dateTo = queryDate(req, 'date_to', true);
    res.json(ok(await reportsSummary(req.clinicId!, req.clinic!.currency, dateFrom, dateTo)));
  },
);

paymentsRouter.get(
  '/reports/by-method',
  authenticate,
  requireClinic,
  requirePermission('payments.reports.read'),
  async (req, res) => {
    const dateFrom = queryDate(req, 'date_from', true);
    const dateTo = queryDate(req, 'date_to', true);
    res.json(ok(await reportsByMethod(req.clinicId!, dateFrom, dateTo)));
  },
);

paymentsRouter.get(
  '/reports/by-professional',
  authenticate,
  requireClinic,
  requirePermission('payments.reports.read'),
  async (req, res) => {
    const dateFrom = queryDate(req, 'date_from', true);
    const dateTo = queryDate(req, 'date_to', true);
    res.json(ok(await reportsByProfessional(req.clinicId!, dateFrom, dateTo)));
  },
);

paymentsRouter.get(
  '/reports/aging-receivables',
  authenticate,
  requireClinic,
  requirePermission('payments.reports.read'),
  async (req, res) => {
    const today = toClinicDateString(new Date(), req.clinic!.timezone)!;
    res.json(ok(await reportsAgingReceivables(req.clinicId!, req.clinic!.currency, today)));
  },
);

paymentsRouter.get(
  '/reports/refunds',
  authenticate,
  requireClinic,
  requirePermission('payments.reports.read'),
  async (req, res) => {
    const dateFrom = queryDate(req, 'date_from', true);
    const dateTo = queryDate(req, 'date_to', true);
    res.json(ok(await reportsRefunds(req.clinicId!, req.clinic!.currency, dateFrom, dateTo)));
  },
);

paymentsRouter.get(
  '/reports/trends',
  authenticate,
  requireClinic,
  requirePermission('payments.reports.read'),
  async (req, res) => {
    const dateFrom = queryDate(req, 'date_from', true);
    const dateTo = queryDate(req, 'date_to', true);
    const granularityRaw = queryString(req, 'granularity') ?? 'month';
    if (!(TREND_GRANULARITIES as readonly string[]).includes(granularityRaw)) {
      throw unprocessable(`Input should be 'day', 'week', 'month' or 'year'`);
    }
    const data = await reportsTrends(
      req.clinicId!,
      req.clinic!.currency,
      dateFrom,
      dateTo,
      granularityRaw as TrendGranularity,
    );
    res.json(ok(data));
  },
);
