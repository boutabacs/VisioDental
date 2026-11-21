/**
 * Routes du module reports — port de `app/modules/reports/router.py`.
 *
 * Monté sous `/api/v1/reports` par `app.ts` (non modifié ici). 24 routes,
 * mêmes chemins, mêmes paramètres (dates `YYYY-MM-DD`, `format=json|csv`,
 * alias `format` pour l'ancien `response_format`), mêmes codes et mêmes
 * enveloppes `{data}` ; erreurs `{detail}` via `ApiError`.
 *
 * Permissions (portées telles quelles côté FastAPI) :
 * `reports.billing.read`, `reports.budgets.read`, `reports.scheduling.read`,
 * `reports.financial.read`, `reports.patient_stats.read`,
 * `reports.operational.read`.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { ApiError, unprocessable } from '../../lib/errors';
import { ok } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import {
  csvLine,
  dateOnly,
  formatDateOnly,
  isDateOnly,
  type AppointmentFunnel,
  type AgingReport,
  type BillingSummary,
  type BudgetSummary,
  type Demographics,
  type DurationVarianceStats,
  type FirstVisitsSummary,
  type IssuedTrend,
  type Productivity,
  type PunctualityStats,
  type SchedulingSummary,
  type VisitFrequency,
  type WaitingTimeStats,
} from './schemas';
import {
  AppointmentLifecycleService,
  BillingReportService,
  BudgetReportService,
  FinancialReportService,
  OperationalReportService,
  PatientStatsService,
  SchedulingReportService,
} from './service';

export const reportsRouter = Router();

// ---------------------------------------------------------------------------
// Helpers de requête (mêmes messages d'erreur 422 que Pydantic)
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** Paramètre date requis (`YYYY-MM-DD`), sinon 422. */
function requiredDate(req: Request, key: string): Date {
  const value = queryString(req, key);
  if (value === undefined || value === '') {
    throw unprocessable(`${key}: Field required`);
  }
  if (!isDateOnly(value)) {
    throw unprocessable(`${key}: Input should be a valid date`);
  }
  return dateOnly(value);
}

/** Paramètre entier borné (équivalent `Query(ge, le)`), sinon 422. */
function queryInt(req: Request, key: string, fallback: number, min: number, max: number): number {
  const value = queryString(req, key);
  if (value === undefined || value === '') return fallback;
  if (!/^[+-]?\d+$/.test(value)) {
    throw unprocessable(`${key}: Input should be a valid integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < min || parsed > max) {
    throw unprocessable(`${key}: Input should be between ${min} and ${max}`);
  }
  return parsed;
}

/** UUID optionnel, sinon 422. */
function queryUuid(req: Request, key: string): string | null {
  const value = queryString(req, key);
  if (value === undefined || value === '') return null;
  if (!uuid.safeParse(value).success) {
    throw unprocessable(`${key}: Input should be a valid UUID`);
  }
  return value;
}

/** `format` (et alias `response_format`) borné à `json|csv`, sinon 422. */
function queryFormat(req: Request): 'json' | 'csv' {
  const value = queryString(req, 'format') ?? queryString(req, 'response_format');
  if (value === undefined || value === '') return 'json';
  if (value !== 'json' && value !== 'csv') {
    throw unprocessable("format: String should match pattern '^(json|csv)$'");
  }
  return value;
}

/** Réponse CSV façon FastAPI `Response(media_type="text/csv")`. */
function csvResponse(res: Response, filename: string, header: string[], rows: unknown[][]): void {
  const body = [csvLine(header), ...rows.map((row) => csvLine(row))].join('');
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

/**
 * Traduit le `ValueError` des bornes d'analyse (date_to antérieure, fenêtre
 * > 365 jours) en 400 `{detail}` — même contrat que le router Python.
 */
function lifecycleError<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((error: unknown) => {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error) throw new ApiError(400, error.message);
    throw error;
  });
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

reportsRouter.get(
  '/billing/summary',
  authenticate,
  requireClinic,
  requirePermission('reports.billing.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    const data: BillingSummary = await BillingReportService.getSummary(
      req.clinicId!,
      req.clinic!.timezone,
      dateFrom,
      dateTo,
    );
    res.json(ok(data));
  },
);

reportsRouter.get(
  '/billing/overdue',
  authenticate,
  requireClinic,
  requirePermission('reports.billing.read'),
  async (req, res) => {
    const limit = queryInt(req, 'limit', 200, 1, 1000);
    const data = await BillingReportService.getOverdueInvoices(
      req.clinicId!,
      req.clinic!.timezone,
      limit,
    );
    res.json(ok(data));
  },
);

reportsRouter.get(
  '/billing/by-payment-method',
  authenticate,
  requireClinic,
  requirePermission('reports.billing.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    res.json(ok(await BillingReportService.getByPaymentMethod(req.clinicId!, dateFrom, dateTo)));
  },
);

reportsRouter.get(
  '/billing/by-professional',
  authenticate,
  requireClinic,
  requirePermission('reports.billing.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    res.json(ok(await BillingReportService.getByProfessional(req.clinicId!, dateFrom, dateTo)));
  },
);

reportsRouter.get(
  '/billing/vat-summary',
  authenticate,
  requireClinic,
  requirePermission('reports.billing.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    res.json(ok(await BillingReportService.getVatSummary(req.clinicId!, dateFrom, dateTo)));
  },
);

reportsRouter.get(
  '/billing/gaps',
  authenticate,
  requireClinic,
  requirePermission('reports.billing.read'),
  async (req, res) => {
    res.json(ok(await BillingReportService.getNumberingGaps(req.clinicId!)));
  },
);

// ---------------------------------------------------------------------------
// Financial (axe facture)
// ---------------------------------------------------------------------------

reportsRouter.get(
  '/billing/aging',
  authenticate,
  requireClinic,
  requirePermission('reports.financial.read'),
  async (req, res) => {
    const format = queryFormat(req);
    const buckets = await FinancialReportService.agingBuckets(
      req.clinicId!,
      req.clinic!.timezone,
    );
    if (format === 'csv') {
      csvResponse(
        res,
        'aging.csv',
        ['bucket', 'total', 'invoices', 'patients'],
        buckets.map((bucket) => [bucket.label, bucket.total, bucket.count, bucket.patient_count]),
      );
      return;
    }
    const data: AgingReport = { currency: req.clinic!.currency, buckets };
    res.json(ok(data));
  },
);

reportsRouter.get(
  '/billing/issued-trend',
  authenticate,
  requireClinic,
  requirePermission('reports.financial.read'),
  async (req, res) => {
    const format = queryFormat(req);
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    const points = await FinancialReportService.issuedTrend(req.clinicId!, dateFrom, dateTo);
    if (format === 'csv') {
      csvResponse(
        res,
        'issued-trend.csv',
        ['month', 'total', 'invoices'],
        points.map((point) => [point.month, point.total, point.count]),
      );
      return;
    }
    const data: IssuedTrend = { currency: req.clinic!.currency, points };
    res.json(ok(data));
  },
);

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

reportsRouter.get(
  '/budgets/summary',
  authenticate,
  requireClinic,
  requirePermission('reports.budgets.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    const data: BudgetSummary = await BudgetReportService.getSummary(
      req.clinicId!,
      dateFrom,
      dateTo,
    );
    res.json(ok(data));
  },
);

reportsRouter.get(
  '/budgets/by-professional',
  authenticate,
  requireClinic,
  requirePermission('reports.budgets.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    res.json(ok(await BudgetReportService.getByProfessional(req.clinicId!, dateFrom, dateTo)));
  },
);

reportsRouter.get(
  '/budgets/by-treatment',
  authenticate,
  requireClinic,
  requirePermission('reports.budgets.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    const limit = queryInt(req, 'limit', 10, 1, 50);
    res.json(
      ok(await BudgetReportService.getByTreatment(req.clinicId!, dateFrom, dateTo, limit)),
    );
  },
);

reportsRouter.get(
  '/budgets/by-status',
  authenticate,
  requireClinic,
  requirePermission('reports.budgets.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    res.json(ok(await BudgetReportService.getByStatus(req.clinicId!, dateFrom, dateTo)));
  },
);

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

reportsRouter.get(
  '/scheduling/summary',
  authenticate,
  requireClinic,
  requirePermission('reports.scheduling.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    const data: SchedulingSummary = await SchedulingReportService.getSummary(
      req.clinicId!,
      req.clinic!.timezone,
      dateFrom,
      dateTo,
    );
    res.json(ok(data));
  },
);

reportsRouter.get(
  '/scheduling/first-visits',
  authenticate,
  requireClinic,
  requirePermission('reports.scheduling.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    const data: FirstVisitsSummary = await SchedulingReportService.getFirstVisits(
      req.clinicId!,
      req.clinic!.timezone,
      dateFrom,
      dateTo,
    );
    res.json(ok(data));
  },
);

reportsRouter.get(
  '/scheduling/by-professional',
  authenticate,
  requireClinic,
  requirePermission('reports.scheduling.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    res.json(
      ok(
        await SchedulingReportService.getHoursByProfessional(
          req.clinicId!,
          req.clinic!.timezone,
          dateFrom,
          dateTo,
        ),
      ),
    );
  },
);

reportsRouter.get(
  '/scheduling/by-cabinet',
  authenticate,
  requireClinic,
  requirePermission('reports.scheduling.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    res.json(
      ok(
        await SchedulingReportService.getCabinetUtilization(
          req.clinicId!,
          req.clinic!.timezone,
          dateFrom,
          dateTo,
        ),
      ),
    );
  },
);

reportsRouter.get(
  '/scheduling/by-day-of-week',
  authenticate,
  requireClinic,
  requirePermission('reports.scheduling.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    res.json(
      ok(
        await SchedulingReportService.getByDayOfWeek(
          req.clinicId!,
          req.clinic!.timezone,
          dateFrom,
          dateTo,
        ),
      ),
    );
  },
);

// ---- Analytics du cycle de vie des rendez-vous (#49) ---------------------

reportsRouter.get(
  '/scheduling/waiting-times',
  authenticate,
  requireClinic,
  requirePermission('reports.scheduling.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    const cabinetId = queryUuid(req, 'cabinet_id');
    const professionalId = queryUuid(req, 'professional_id');
    const data: WaitingTimeStats = await lifecycleError(() =>
      AppointmentLifecycleService.waitingTimes(
        req.clinicId!,
        req.clinic!.timezone,
        dateFrom,
        dateTo,
        cabinetId,
        professionalId,
      ),
    );
    res.json(ok(data));
  },
);

reportsRouter.get(
  '/scheduling/punctuality',
  authenticate,
  requireClinic,
  requirePermission('reports.scheduling.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    const cabinetId = queryUuid(req, 'cabinet_id');
    const professionalId = queryUuid(req, 'professional_id');
    const data: PunctualityStats = await lifecycleError(() =>
      AppointmentLifecycleService.punctuality(
        req.clinicId!,
        req.clinic!.timezone,
        dateFrom,
        dateTo,
        cabinetId,
        professionalId,
      ),
    );
    res.json(ok(data));
  },
);

reportsRouter.get(
  '/scheduling/duration-variance',
  authenticate,
  requireClinic,
  requirePermission('reports.scheduling.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    const cabinetId = queryUuid(req, 'cabinet_id');
    const professionalId = queryUuid(req, 'professional_id');
    const data: DurationVarianceStats = await lifecycleError(() =>
      AppointmentLifecycleService.durationVariance(
        req.clinicId!,
        req.clinic!.timezone,
        dateFrom,
        dateTo,
        cabinetId,
        professionalId,
      ),
    );
    res.json(ok(data));
  },
);

reportsRouter.get(
  '/scheduling/funnel',
  authenticate,
  requireClinic,
  requirePermission('reports.scheduling.read'),
  async (req, res) => {
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    const cabinetId = queryUuid(req, 'cabinet_id');
    const professionalId = queryUuid(req, 'professional_id');
    const data: AppointmentFunnel = await lifecycleError(() =>
      AppointmentLifecycleService.funnel(
        req.clinicId!,
        req.clinic!.timezone,
        dateFrom,
        dateTo,
        cabinetId,
        professionalId,
      ),
    );
    res.json(ok(data));
  },
);

// ---------------------------------------------------------------------------
// Patient-stats + operational
// ---------------------------------------------------------------------------

reportsRouter.get(
  '/patients/demographics',
  authenticate,
  requireClinic,
  requirePermission('reports.patient_stats.read'),
  async (req, res) => {
    const format = queryFormat(req);
    const data = await PatientStatsService.demographics(req.clinicId!, req.clinic!.timezone);
    if (format === 'csv') {
      csvResponse(
        res,
        'demographics.csv',
        ['dimension', 'key', 'count'],
        [
          ...data.age_bands.map((band) => ['age', band.band, band.count]),
          ...data.genders.map((gender) => ['gender', gender.gender, gender.count]),
          ...data.areas.map((area) => ['area', area.area, area.count]),
        ],
      );
      return;
    }
    const payload: Demographics = data;
    res.json(ok(payload));
  },
);

reportsRouter.get(
  '/patients/visits',
  authenticate,
  requireClinic,
  requirePermission('reports.patient_stats.read'),
  async (req, res) => {
    const format = queryFormat(req);
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    const data = await PatientStatsService.visitFrequency(
      req.clinicId!,
      req.clinic!.timezone,
      dateFrom,
      dateTo,
    );
    if (format === 'csv') {
      csvResponse(
        res,
        'visits.csv',
        ['new_patients', 'returning_patients', 'total_visits', 'visits_per_patient'],
        [
          [
            data.new_patients,
            data.returning_patients,
            data.total_visits,
            data.visits_per_patient,
          ],
        ],
      );
      return;
    }
    const payload: VisitFrequency = data;
    res.json(ok(payload));
  },
);

reportsRouter.get(
  '/operational/productivity',
  authenticate,
  requireClinic,
  requirePermission('reports.operational.read'),
  async (req, res) => {
    const format = queryFormat(req);
    const dateFrom = requiredDate(req, 'date_from');
    const dateTo = requiredDate(req, 'date_to');
    const data = await OperationalReportService.productivity(
      req.clinicId!,
      req.clinic!.timezone,
      dateFrom,
      dateTo,
    );
    if (format === 'csv') {
      csvResponse(
        res,
        'productivity.csv',
        ['scope', 'key', 'completed'],
        [
          ['total', 'all', data.completed_total],
          ...data.by_professional.map((row) => [
            'professional',
            row.professional_name,
            row.completed,
          ]),
          ...data.by_cabinet.map((row) => ['cabinet', row.cabinet, row.completed]),
        ],
      );
      return;
    }
    const payload: Productivity = data;
    res.json(ok(payload));
  },
);
