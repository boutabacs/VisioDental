/**
 * Routes du module `odontogram` — port de `app/modules/odontogram/router.py`.
 *
 * Enveloppes FastAPI (`{data}` / `{data,total,page,page_size}`), codes 201/204,
 * messages d'erreur repris mot pour mot (`{detail:"..."}` via `ApiError`).
 * Permissions : `odontogram.read`, `odontogram.write`,
 * `odontogram.treatments.read`, `odontogram.treatments.write`.
 */

import { Router, type Request, type Response } from 'express';

import { badRequest, notFound, unprocessable } from '../../lib/errors';
import { ok, paginated } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import {
  bulkUpdateSchema,
  isoDateSchema,
  isValidToothNumber,
  parseIsoDate,
  toothRecordUpdateSchema,
  treatmentCreateSchema,
  treatmentPerformSchema,
  treatmentUpdateSchema,
  uuid,
  type ToothInput,
  type TreatmentCreateInput,
} from './schemas';
import {
  bulkUpdateTeeth,
  createTreatment,
  deleteTreatment,
  getOdontogram,
  getOdontogramAtDate,
  getPatientHistory,
  getTimelineDates,
  getToothHistory,
  getToothRecord,
  getToothWithTreatments,
  getTreatment,
  listPatientTreatments,
  performTreatment,
  toToothRecordDto,
  updateTreatment,
  upsertTooth,
  validatePatientAccess,
} from './service';

export const odontogramRouter = Router();

// ---------------------------------------------------------------------------
// Query helpers (validés comme Pydantic : type correct sinon 422)
// ---------------------------------------------------------------------------

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** `Query(int | None)` : absent → `null`, malformé → 422. */
function queryOptionalInt(req: Request, key: string): number | null {
  const raw = queryString(req, key);
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(parsed)) {
    throw unprocessable(`Input should be a valid integer for \`${key}\``);
  }
  return Math.trunc(parsed);
}

/** `Query(int, ge=1)` / `le=…` avec bornes et 422 Pydantic. */
function queryBoundedInt(req: Request, key: string, fallback: number, min: number, max?: number): number {
  const raw = queryString(req, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(parsed)) {
    throw unprocessable(`Input should be a valid integer for \`${key}\``);
  }
  if (parsed < min) {
    throw unprocessable(`Input should be greater than or equal to ${min} for \`${key}\``);
  }
  if (max !== undefined && parsed > max) {
    throw unprocessable(`Input should be less than or equal to ${max} for \`${key}\``);
  }
  return parsed;
}

/** Convertit une `ValueError` métier en 400 (contrat du router Python). */
async function asBadRequest<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Error && error.name === 'OdontogramValidationError') {
      throw badRequest(error.message);
    }
    throw error;
  }
}

function paramUuid(req: Request, key: string): string {
  return uuid.parse(req.params[key]);
}

/** `tooth_number: int` dans le chemin — un segment non entier est un 422. */
function paramToothNumber(req: Request, key: string): number {
  const value = req.params[key];
  const raw = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  if (!/^-?\d+$/.test(raw)) {
    throw unprocessable('Input should be a valid integer');
  }
  return Number(raw);
}

function assertValidTooth(toothNumber: number): void {
  if (!isValidToothNumber(toothNumber)) {
    throw badRequest(`Invalid tooth number: ${toothNumber}`);
  }
}

// ---------------------------------------------------------------------------
// Tooth record endpoints
// ---------------------------------------------------------------------------

odontogramRouter.get(
  '/patients/:patientId/odontogram',
  authenticate,
  requireClinic,
  requirePermission('odontogram.read'),
  async (req, res) => {
    const patientId = paramUuid(req, 'patientId');
    await validatePatientAccess(req.clinicId!, patientId);
    res.json(ok(await getOdontogram(req.clinicId!, patientId)));
  },
);

odontogramRouter.get(
  '/patients/:patientId/teeth/:toothNumber',
  authenticate,
  requireClinic,
  requirePermission('odontogram.read'),
  async (req, res) => {
    const patientId = paramUuid(req, 'patientId');
    const toothNumber = paramToothNumber(req, 'toothNumber');
    await validatePatientAccess(req.clinicId!, patientId);
    assertValidTooth(toothNumber);
    const tooth = await getToothRecord(req.clinicId!, patientId, toothNumber);
    if (!tooth) throw notFound(`Tooth ${toothNumber} not found for this patient`);
    res.json(ok(toToothRecordDto(tooth)));
  },
);

async function createOrUpdateToothHandler(req: Request, res: Response) {
  const patientId = paramUuid(req, 'patientId');
  const toothNumber = paramToothNumber(req, 'toothNumber');
  await validatePatientAccess(req.clinicId!, patientId);
  assertValidTooth(toothNumber);

  const data = toothRecordUpdateSchema.parse(req.body ?? {});
  const tooth = await upsertTooth(req.clinicId!, patientId, toothNumber, req.user!.id, {
    generalCondition: data.general_condition ?? null,
    surfaceUpdates: data.surface_updates ?? null,
    notes: data.notes ?? null,
    isDisplaced: data.is_displaced ?? null,
    isRotated: data.is_rotated ?? null,
    displacementNotes: data.displacement_notes ?? null,
  });
  res.json(ok(tooth));
}

odontogramRouter.put(
  '/patients/:patientId/teeth/:toothNumber',
  authenticate,
  requireClinic,
  requirePermission('odontogram.write'),
  createOrUpdateToothHandler,
);

// `PATCH /teeth/bulk` est déclaré avant `PATCH /teeth/:toothNumber` — comme
// l'ordre d'enregistrement FastAPI, « bulk » n'est donc jamais un tooth_number.
odontogramRouter.patch(
  '/patients/:patientId/teeth/bulk',
  authenticate,
  requireClinic,
  requirePermission('odontogram.write'),
  async (req, res) => {
    const patientId = paramUuid(req, 'patientId');
    await validatePatientAccess(req.clinicId!, patientId);

    const data = bulkUpdateSchema.parse(req.body ?? {});
    for (const update of data.updates) {
      assertValidTooth(update.tooth_number);
    }

    const teeth = await bulkUpdateTeeth(
      req.clinicId!,
      patientId,
      req.user!.id,
      data.updates.map((update) => ({
        toothNumber: update.tooth_number,
        // Python : `.get("general_condition")` → `null` préservé, d'où un
        // `general_condition or "healthy"` à la création uniquement.
        generalCondition: update.general_condition ?? null,
        surfaceUpdates: update.surface_updates ?? null,
        notes: update.notes ?? null,
      })),
    );
    res.json(ok(teeth));
  },
);

odontogramRouter.patch(
  '/patients/:patientId/teeth/:toothNumber',
  authenticate,
  requireClinic,
  requirePermission('odontogram.write'),
  createOrUpdateToothHandler,
);

odontogramRouter.get(
  '/patients/:patientId/teeth/:toothNumber/history',
  authenticate,
  requireClinic,
  requirePermission('odontogram.read'),
  async (req, res) => {
    const patientId = paramUuid(req, 'patientId');
    const toothNumber = paramToothNumber(req, 'toothNumber');
    const page = queryBoundedInt(req, 'page', 1, 1);
    const pageSize = queryBoundedInt(req, 'page_size', 50, 1, 100);
    await validatePatientAccess(req.clinicId!, patientId);
    assertValidTooth(toothNumber);
    const { items, total } = await getToothHistory(
      req.clinicId!,
      patientId,
      toothNumber,
      page,
      pageSize,
    );
    res.json(paginated(items, total, page, pageSize));
  },
);

odontogramRouter.get(
  '/patients/:patientId/history',
  authenticate,
  requireClinic,
  requirePermission('odontogram.read'),
  async (req, res) => {
    const patientId = paramUuid(req, 'patientId');
    const page = queryBoundedInt(req, 'page', 1, 1);
    const pageSize = queryBoundedInt(req, 'page_size', 50, 1, 100);
    await validatePatientAccess(req.clinicId!, patientId);
    const { items, total } = await getPatientHistory(req.clinicId!, patientId, page, pageSize);
    res.json(paginated(items, total, page, pageSize));
  },
);

odontogramRouter.get(
  '/patients/:patientId/odontogram/timeline',
  authenticate,
  requireClinic,
  requirePermission('odontogram.read'),
  async (req, res) => {
    const patientId = paramUuid(req, 'patientId');
    await validatePatientAccess(req.clinicId!, patientId);
    const dates = await getTimelineDates(req.clinicId!, patientId, req.clinic!.timezone);
    res.json(ok({ dates, total: dates.length }));
  },
);

odontogramRouter.get(
  '/patients/:patientId/odontogram/at',
  authenticate,
  requireClinic,
  requirePermission('odontogram.read'),
  async (req, res) => {
    const patientId = paramUuid(req, 'patientId');
    const rawDate = queryString(req, 'date');
    if (rawDate === undefined) {
      throw unprocessable('Field required: `date`');
    }
    const parsed = isoDateSchema.safeParse(rawDate);
    const targetDate = parsed.success ? parseIsoDate(parsed.data) : null;
    if (targetDate === null) throw unprocessable('Input should be a valid date');

    await validatePatientAccess(req.clinicId!, patientId);
    const historical = await getOdontogramAtDate(
      req.clinicId!,
      patientId,
      targetDate,
      req.clinic!.timezone,
    );
    res.json(ok(historical));
  },
);

odontogramRouter.get(
  '/patients/:patientId/teeth/:toothNumber/full',
  authenticate,
  requireClinic,
  requirePermission('odontogram.read'),
  async (req, res) => {
    const patientId = paramUuid(req, 'patientId');
    const toothNumber = paramToothNumber(req, 'toothNumber');
    await validatePatientAccess(req.clinicId!, patientId);
    assertValidTooth(toothNumber);
    const result = await getToothWithTreatments(req.clinicId!, patientId, toothNumber);
    if (!result) throw notFound(`Tooth ${toothNumber} not found`);
    res.json(ok({ ...result.tooth, treatments: result.treatments }));
  },
);

// ---------------------------------------------------------------------------
// Treatment endpoints (single ou multi-dents, unifiés)
// ---------------------------------------------------------------------------

odontogramRouter.post(
  '/patients/:patientId/treatments',
  authenticate,
  requireClinic,
  requirePermission('odontogram.treatments.write'),
  async (req, res) => {
    const patientId = paramUuid(req, 'patientId');
    await validatePatientAccess(req.clinicId!, patientId);

    // `scope` est toujours résolu par `validate_shape` (sinon 422).
    const data: TreatmentCreateInput = treatmentCreateSchema.parse(req.body ?? {});

    const treatment = await asBadRequest(() =>
      createTreatment(req.clinicId!, patientId, req.user!.id, {
        catalogItemId: data.catalog_item_id,
        clinicalType: data.clinical_type,
        toothNumbers: data.tooth_numbers,
        teeth: data.teeth as ToothInput[] | null,
        commonSurfaces: data.surfaces,
        status: data.status,
        notes: data.notes,
        budgetItemId: data.budget_item_id,
        sourceModule: data.source_module,
        scope: data.scope,
        arch: data.arch,
      }),
    );
    res.status(201).json(ok(treatment));
  },
);

odontogramRouter.get(
  '/patients/:patientId/treatments',
  authenticate,
  requireClinic,
  requirePermission('odontogram.treatments.read'),
  async (req, res) => {
    const patientId = paramUuid(req, 'patientId');
    const catalogItemId = queryString(req, 'catalog_item_id');

    const page = queryBoundedInt(req, 'page', 1, 1);
    const pageSize = queryBoundedInt(req, 'page_size', 50, 1, 100);
    const toothNumber = queryOptionalInt(req, 'tooth_number');

    await validatePatientAccess(req.clinicId!, patientId);

    const { rows, total } = await listPatientTreatments(req.clinicId!, patientId, {
      status: queryString(req, 'status') ?? null,
      clinicalType: queryString(req, 'clinical_type') ?? null,
      toothNumber,
      catalogItemId: catalogItemId !== undefined ? uuid.parse(catalogItemId) : null,
      page,
      pageSize,
    });
    res.json(paginated(rows, total, page, pageSize));
  },
);

odontogramRouter.get(
  '/treatments/:treatmentId',
  authenticate,
  requireClinic,
  requirePermission('odontogram.treatments.read'),
  async (req, res) => {
    const treatmentId = paramUuid(req, 'treatmentId');
    const treatment = await getTreatment(req.clinicId!, treatmentId);
    if (!treatment) throw notFound('Treatment not found');
    res.json(ok(treatment));
  },
);

odontogramRouter.put(
  '/treatments/:treatmentId',
  authenticate,
  requireClinic,
  requirePermission('odontogram.treatments.write'),
  async (req, res) => {
    const treatmentId = paramUuid(req, 'treatmentId');
    const data = treatmentUpdateSchema.parse(req.body ?? {});
    const treatment = await asBadRequest(() =>
      updateTreatment(req.clinicId!, treatmentId, req.user!.id, {
        status: data.status ?? null,
        notes: data.notes ?? null,
        surfaces: data.surfaces ?? null,
      }),
    );
    if (!treatment) throw notFound('Treatment not found');
    res.json(ok(treatment));
  },
);

odontogramRouter.delete(
  '/treatments/:treatmentId',
  authenticate,
  requireClinic,
  requirePermission('odontogram.treatments.write'),
  async (req, res) => {
    const treatmentId = paramUuid(req, 'treatmentId');
    const deleted = await deleteTreatment(req.clinicId!, treatmentId, req.user!.id);
    if (!deleted) throw notFound('Treatment not found');
    res.status(204).end();
  },
);

odontogramRouter.patch(
  '/treatments/:treatmentId/perform',
  authenticate,
  requireClinic,
  requirePermission('odontogram.treatments.write'),
  async (req, res) => {
    const treatmentId = paramUuid(req, 'treatmentId');
    const data = treatmentPerformSchema.parse(req.body ?? {});
    const treatment = await performTreatment(
      req.clinicId!,
      treatmentId,
      req.user!.id,
      data.notes ?? null,
    );
    if (!treatment) throw notFound('Treatment not found');
    res.json(ok(treatment));
  },
);
