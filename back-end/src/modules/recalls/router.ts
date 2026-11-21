/**
 * Routes du module recalls — port de `app/modules/recalls/router.py`.
 *
 * Monté sous `/api/v1/recalls` par `app.ts`. Permissions
 * `recalls.{read,write,delete}`. Enveloppes FastAPI (`{data}`,
 * `{data,total,page,page_size}`), 201/204/409 et messages d'erreur repris
 * mot pour mot.
 *
 * Les chemins fixes (`/stats/dashboard`, `/suggestions/next`, `/settings`,
 * `/export.csv`, `/patients/:id`) sont déclarés avant `/:recallId`.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';

import {
  RecallClosedError,
  RecallReferenceError,
  badRequest,
  conflict,
  notFound,
  unprocessable,
} from '../../lib/errors';
import { ok, paginated } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import {
  RECALL_STATUSES,
  attemptCreateSchema,
  csvFileName,
  csvLine,
  dateOnly,
  formatDateOnly,
  recallCancelSchema,
  recallCreateSchema,
  recallCsvName,
  recallLinkAppointmentSchema,
  recallSettingsUpdateSchema,
  recallSnoozeSchema,
  recallUpdateSchema,
} from './schemas';
import {
  RecallPatientNotFoundError,
  cancelRecall,
  createRecall,
  dashboardStats,
  deleteRecall,
  exportRows,
  getOrCreateSettings,
  getRecall,
  getWithAttempts,
  linkAppointment,
  listAttempts,
  listForPatient,
  listRecalls,
  logAttempt,
  markDone,
  snoozeRecall,
  suggestNextForTreatment,
  toAttemptDto,
  toRecallDetailDto,
  toRecallDto,
  updateRecall,
  updateSettings,
  type RecallFilters,
} from './service';

export const recallsRouter = Router();

const uuid = z.string().uuid();
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** Booléen de requête façon Pydantic (`true/false/1/0/yes/no/on/off`). */
function queryBool(req: Request, key: string, fallback = false): boolean {
  const value = queryString(req, key)?.trim().toLowerCase();
  if (value === undefined || value === '') return fallback;
  if (['true', '1', 'yes', 'on', 't', 'y'].includes(value)) return true;
  if (['false', '0', 'no', 'off', 'f', 'n'].includes(value)) return false;
  return fallback;
}

/** Id de chemin (UUID) — un id malformé est un 422, comme FastAPI. */
function pathId(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || !UUID_PATTERN.test(raw)) {
    throw unprocessable('Input should be a valid UUID');
  }
  return raw;
}

/** `date` Pydantic pour une requête (`YYYY-MM-DD`), sinon 422. */
function queryDate(req: Request, key: string): Date | null {
  const value = queryString(req, key);
  if (value === undefined || value === '') return null;
  if (!DATE_ONLY.test(value) || Number.isNaN(Date.parse(value))) {
    throw unprocessable(`${key}: Input should be a valid date`);
  }
  return dateOnly(value);
}

/** `UUID` Pydantic pour une requête, sinon 422. */
function queryUuid(req: Request, key: string): string | null {
  const value = queryString(req, key);
  if (value === undefined || value === '') return null;
  if (!UUID_PATTERN.test(value)) {
    throw unprocessable(`${key}: Input should be a valid UUID`);
  }
  return value;
}

/** `Literal[...]` Pydantic pour une requête, sinon 422. */
function queryStatus(req: Request): string | null {
  const value = queryString(req, 'status');
  if (value === undefined || value === '') return null;
  if (!(RECALL_STATUSES as readonly string[]).includes(value)) {
    throw unprocessable("status: Input should be 'pending', 'contacted_no_answer', …");
  }
  return value;
}

/** Entier de requête avec bornes (clamps Pydantic `ge`/`le`). */
function queryInt(req: Request, key: string, min: number, max: number, fallback: number): number {
  const raw = queryString(req, key);
  if (raw === undefined || raw === '') return fallback;
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    throw unprocessable(`${key}: Input should be a valid integer`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < min || parsed > max) {
    throw unprocessable(
      parsed < min
        ? `${key}: Input should be greater than or equal to ${min}`
        : `${key}: Input should be less than or equal to ${max}`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Liste + création
// ---------------------------------------------------------------------------

recallsRouter.get(
  '/',
  authenticate,
  requireClinic,
  requirePermission('recalls.read'),
  async (req, res) => {
    const page = queryInt(req, 'page', 1, Number.MAX_SAFE_INTEGER, 1);
    const pageSize = queryInt(req, 'page_size', 1, 200, 50);

    const filters: RecallFilters = {
      month: queryDate(req, 'month'),
      reason: queryString(req, 'reason') || null,
      professionalId: queryUuid(req, 'professional_id'),
      status: queryStatus(req),
      priority: queryString(req, 'priority') || null,
      overdue: queryBool(req, 'overdue', false),
      patientId: queryUuid(req, 'patient_id'),
      includeArchivedPatients: queryBool(req, 'include_archived_patients', false),
      includeDoNotContact: queryBool(req, 'include_do_not_contact', false),
    };

    const { rows, total } = await listRecalls(req.clinicId!, filters, page, pageSize);
    res.json(
      paginated(rows.map((row) => toRecallDto(row.recall, row.patient)), total, page, pageSize),
    );
  },
);

recallsRouter.post(
  '/',
  authenticate,
  requireClinic,
  requirePermission('recalls.write'),
  async (req, res) => {
    const input = recallCreateSchema.parse(req.body);
    try {
      const { recall } = await createRecall(req.clinicId!, input, req.user!.id);
      res.status(201).json(ok(toRecallDto(recall)));
    } catch (error) {
      if (error instanceof RecallReferenceError) throw badRequest(error.message);
      if (error instanceof RecallPatientNotFoundError) throw notFound(error.message);
      throw error;
    }
  },
);

// ---------------------------------------------------------------------------
// Lecture transverse
// ---------------------------------------------------------------------------

recallsRouter.get(
  '/stats/dashboard',
  authenticate,
  requireClinic,
  requirePermission('recalls.read'),
  async (req, res) => {
    const stats = await dashboardStats(req.clinicId!, req.clinic!.timezone);
    res.json(ok(stats));
  },
);

recallsRouter.get(
  '/suggestions/next',
  authenticate,
  requireClinic,
  requirePermission('recalls.read'),
  async (req, res) => {
    // `patient_id` est requis : absent → 422.
    const patientId = queryUuid(req, 'patient_id');
    if (!patientId) throw unprocessable('patient_id: Field required');
    const treatmentId = queryUuid(req, 'treatment_id');
    const suggestion = await suggestNextForTreatment(
      req.clinicId!,
      patientId,
      queryString(req, 'treatment_category_key') || null,
      treatmentId,
      req.clinic!.timezone,
    );
    res.json(ok(suggestion));
  },
);

recallsRouter.get(
  '/settings',
  authenticate,
  requireClinic,
  requirePermission('recalls.read'),
  async (req, res) => {
    const settings = await getOrCreateSettings(req.clinicId!);
    res.json(ok(settings));
  },
);

recallsRouter.put(
  '/settings',
  authenticate,
  requireClinic,
  requirePermission('recalls.write'),
  async (req, res) => {
    const input = recallSettingsUpdateSchema.parse(req.body);
    const settings = await updateSettings(req.clinicId!, input);
    res.json(ok(settings));
  },
);

recallsRouter.get(
  '/export.csv',
  authenticate,
  requireClinic,
  requirePermission('recalls.read'),
  async (req, res) => {
    const filters: RecallFilters = {
      month: queryDate(req, 'month'),
      reason: queryString(req, 'reason') || null,
      status: queryStatus(req),
      priority: queryString(req, 'priority') || null,
      overdue: queryBool(req, 'overdue', false),
      professionalId: queryUuid(req, 'professional_id'),
    };

    const rows = await exportRows(req.clinicId!, filters);
    const lines: string[] = [
      csvLine([
        'due_month',
        'patient',
        'phone',
        'reason',
        'priority',
        'status',
        'attempts',
        'professional',
        'note',
      ]),
    ];
    for (const { recall, patient } of rows) {
      lines.push(
        csvLine([
          formatDateOnly(recall.due_month),
          patient ? `${patient.first_name} ${patient.last_name}`.trim() : '',
          patient?.phone ?? '',
          recall.reason,
          recall.priority,
          recall.status,
          recall.contact_attempt_count,
          recall.assigned_professional_id ?? '',
          (recall.reason_note ?? '').replace(/\n/g, ' '),
        ]),
      );
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', csvFileName(recallCsvName(req.clinic!.name)));
    res.send(lines.join(''));
  },
);

recallsRouter.get(
  '/patients/:patientId',
  authenticate,
  requireClinic,
  requirePermission('recalls.read'),
  async (req, res) => {
    const patientId = pathId(req.params.patientId);
    const rows = await listForPatient(req.clinicId!, patientId);
    res.json(ok(rows.map((row) => toRecallDto(row))));
  },
);

// ---------------------------------------------------------------------------
// Surface par identifiant
// ---------------------------------------------------------------------------

recallsRouter.get(
  '/:recallId',
  authenticate,
  requireClinic,
  requirePermission('recalls.read'),
  async (req, res) => {
    const recallId = pathId(req.params.recallId);
    const { recall, attempts } = await getWithAttempts(req.clinicId!, recallId);
    if (!recall) throw notFound('Recall not found');
    res.json(ok(toRecallDetailDto(recall, attempts)));
  },
);

recallsRouter.patch(
  '/:recallId',
  authenticate,
  requireClinic,
  requirePermission('recalls.write'),
  async (req, res) => {
    const recallId = pathId(req.params.recallId);
    const input = recallUpdateSchema.parse(req.body);
    const recall = await updateRecall(req.clinicId!, recallId, input);
    if (!recall) throw notFound('Recall not found');
    res.json(ok(toRecallDto(recall)));
  },
);

recallsRouter.post(
  '/:recallId/snooze',
  authenticate,
  requireClinic,
  requirePermission('recalls.write'),
  async (req, res) => {
    const recallId = pathId(req.params.recallId);
    const input = recallSnoozeSchema.parse(req.body);
    try {
      const recall = await snoozeRecall(
        req.clinicId!,
        recallId,
        req.clinic!.timezone,
        input.months,
        input.reason_note,
        req.user!.id,
      );
      if (!recall) throw notFound('Recall not found');
      res.json(ok(toRecallDto(recall)));
    } catch (error) {
      if (error instanceof RecallClosedError) throw conflict('Recall is closed');
      throw error;
    }
  },
);

recallsRouter.post(
  '/:recallId/cancel',
  authenticate,
  requireClinic,
  requirePermission('recalls.write'),
  async (req, res) => {
    const recallId = pathId(req.params.recallId);
    const input = recallCancelSchema.parse(req.body);
    try {
      const recall = await cancelRecall(req.clinicId!, recallId, input.note, req.user!.id);
      if (!recall) throw notFound('Recall not found');
      res.json(ok(toRecallDto(recall)));
    } catch (error) {
      if (error instanceof RecallClosedError) throw conflict('Recall is closed');
      throw error;
    }
  },
);

recallsRouter.post(
  '/:recallId/done',
  authenticate,
  requireClinic,
  requirePermission('recalls.write'),
  async (req, res) => {
    const recallId = pathId(req.params.recallId);
    try {
      const recall = await markDone(req.clinicId!, recallId, req.user!.id);
      if (!recall) throw notFound('Recall not found');
      res.json(ok(toRecallDto(recall)));
    } catch (error) {
      if (error instanceof RecallClosedError) throw conflict('Recall is closed');
      throw error;
    }
  },
);

recallsRouter.post(
  '/:recallId/attempts',
  authenticate,
  requireClinic,
  requirePermission('recalls.write'),
  async (req, res) => {
    const recallId = pathId(req.params.recallId);
    const input = attemptCreateSchema.parse(req.body);
    try {
      const result = await logAttempt(req.clinicId!, recallId, input, req.user!.id);
      if (!result) throw notFound('Recall not found');
      res.status(201).json(ok(toAttemptDto(result.attempt)));
    } catch (error) {
      if (error instanceof RecallReferenceError) throw badRequest(error.message);
      if (error instanceof RecallClosedError) throw conflict('Recall is closed');
      throw error;
    }
  },
);

recallsRouter.get(
  '/:recallId/attempts',
  authenticate,
  requireClinic,
  requirePermission('recalls.read'),
  async (req, res) => {
    const recallId = pathId(req.params.recallId);
    const attempts = await listAttempts(req.clinicId!, recallId);
    res.json(ok(attempts.map(toAttemptDto)));
  },
);

recallsRouter.post(
  '/:recallId/link-appointment',
  authenticate,
  requireClinic,
  requirePermission('recalls.write'),
  async (req, res) => {
    const recallId = pathId(req.params.recallId);
    const input = recallLinkAppointmentSchema.parse(req.body);
    try {
      const recall = await linkAppointment(req.clinicId!, recallId, input.appointment_id);
      if (!recall) throw notFound('Recall not found');
      res.json(ok(toRecallDto(recall)));
    } catch (error) {
      if (error instanceof RecallReferenceError) throw badRequest(error.message);
      throw error;
    }
  },
);

recallsRouter.delete(
  '/:recallId',
  authenticate,
  requireClinic,
  requirePermission('recalls.delete'),
  async (req, res) => {
    const recallId = pathId(req.params.recallId);
    const existing = await getRecall(req.clinicId!, recallId);
    if (!existing) throw notFound('Recall not found');
    await deleteRecall(req.clinicId!, recallId);
    res.status(204).end();
  },
);
