import { Router, type Request } from 'express';
import { z } from 'zod';

import { notFound, unprocessable } from '../../lib/errors';
import { ok } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import {
  clinicHoursUpdateSchema,
  clinicOverrideSchema,
  parseDateString,
  professionalOverrideSchema,
} from './schemas';
import {
  assertRangeLength,
  assertRangeOrder,
  createClinicOverride,
  createProfessionalOverride,
  deleteClinicOverride,
  deleteProfessionalOverride,
  getClinicOverride,
  getOrCreateClinicWeekly,
  getOrCreateProfessionalWeekly,
  getProfessionalOverride,
  isProfessional,
  listClinicOverrides,
  listProfessionalOverrides,
  occupancy,
  peakHours,
  replaceClinicWeeklyShifts,
  replaceProfessionalWeeklyShifts,
  requireProfessionalAccess,
  resolveAvailability,
  safeTimeZone,
  toAvailabilityRangeDto,
  toClinicHoursDto,
  toClinicOverrideDto,
  toProfessionalHoursDto,
  toProfessionalOverrideDto,
  updateClinicOverride,
  updateProfessionalOverride,
  utilization,
} from './service';

/**
 * Horaires de la clinique + des professionnels, disponibilité et analytics.
 * Monté sous `/api/v1/schedules`.
 */
export const schedulesRouter = Router();

const uuid = z.string().uuid();

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/**
 * `Query(...)` obligatoire. Un `date` invalide vaut 422 comme Pydantic ;
 * le format de `{detail}` suit celui du gestionnaire d'erreurs Zod.
 */
function requiredDate(req: Request, key: string): string {
  const raw = queryString(req, key);
  if (raw === undefined || raw === '') {
    throw unprocessable(`${key}: Field required`);
  }
  try {
    return parseDateString(raw);
  } catch {
    throw unprocessable(`${key}: Invalid date`);
  }
}

function optionalDate(req: Request, key: string): string | null {
  const raw = queryString(req, key);
  if (raw === undefined || raw === '') return null;
  try {
    return parseDateString(raw);
  } catch {
    throw unprocessable(`${key}: Invalid date`);
  }
}

function optionalUuid(req: Request, key: string): string | null {
  const raw = queryString(req, key);
  if (raw === undefined || raw === '') return null;
  return uuid.parse(raw);
}

// ---------------------------------------------------------------------------
// Horaires de la clinique
// ---------------------------------------------------------------------------

schedulesRouter.get(
  '/clinic-hours',
  authenticate,
  requireClinic,
  requirePermission('schedules.clinic_hours.read'),
  async (req, res) => {
    const weekly = await getOrCreateClinicWeekly(req.clinicId!);
    res.json(ok(toClinicHoursDto(weekly, safeTimeZone(req.clinic!.timezone))));
  },
);

schedulesRouter.put(
  '/clinic-hours',
  authenticate,
  requireClinic,
  requirePermission('schedules.clinic_hours.write'),
  async (req, res) => {
    const input = clinicHoursUpdateSchema.parse(req.body);
    const weekly = await getOrCreateClinicWeekly(req.clinicId!);
    const updated = await replaceClinicWeeklyShifts(weekly.id, input.days);
    res.json(ok(toClinicHoursDto(updated, safeTimeZone(req.clinic!.timezone))));
  },
);

schedulesRouter.get(
  '/clinic-overrides',
  authenticate,
  requireClinic,
  requirePermission('schedules.clinic_hours.read'),
  async (req, res) => {
    const overrides = await listClinicOverrides(
      req.clinicId!,
      optionalDate(req, 'start'),
      optionalDate(req, 'end'),
    );
    res.json(ok(overrides.map(toClinicOverrideDto)));
  },
);

schedulesRouter.post(
  '/clinic-overrides',
  authenticate,
  requireClinic,
  requirePermission('schedules.clinic_hours.write'),
  async (req, res) => {
    const input = clinicOverrideSchema.parse(req.body);
    const override = await createClinicOverride(req.clinicId!, input);
    res.status(201).json(ok(toClinicOverrideDto(override)));
  },
);

schedulesRouter.put(
  '/clinic-overrides/:overrideId',
  authenticate,
  requireClinic,
  requirePermission('schedules.clinic_hours.write'),
  async (req, res) => {
    const overrideId = uuid.parse(req.params.overrideId);
    const current = await getClinicOverride(req.clinicId!, overrideId);
    if (!current) throw notFound('Override not found');
    const input = clinicOverrideSchema.parse(req.body);
    const updated = await updateClinicOverride(req.clinicId!, overrideId, input);
    if (!updated) throw notFound('Override not found');
    res.json(ok(toClinicOverrideDto(updated)));
  },
);

schedulesRouter.delete(
  '/clinic-overrides/:overrideId',
  authenticate,
  requireClinic,
  requirePermission('schedules.clinic_hours.write'),
  async (req, res) => {
    const overrideId = uuid.parse(req.params.overrideId);
    const current = await getClinicOverride(req.clinicId!, overrideId);
    if (!current) throw notFound('Override not found');
    await deleteClinicOverride(overrideId);
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Horaires des professionnels (garde propre : général ou « own »)
// ---------------------------------------------------------------------------

schedulesRouter.get(
  '/professionals/:userId/hours',
  authenticate,
  requireClinic,
  async (req, res) => {
    const userId = uuid.parse(req.params.userId);
    await requireProfessionalAccess(req.clinicId!, req.role!, req.user!.id, userId, 'read');
    if (!(await isProfessional(req.clinicId!, userId))) throw notFound('Professional not found');
    const weekly = await getOrCreateProfessionalWeekly(req.clinicId!, userId);
    res.json(ok(toProfessionalHoursDto(weekly)));
  },
);

schedulesRouter.put(
  '/professionals/:userId/hours',
  authenticate,
  requireClinic,
  async (req, res) => {
    const userId = uuid.parse(req.params.userId);
    await requireProfessionalAccess(req.clinicId!, req.role!, req.user!.id, userId, 'write');
    if (!(await isProfessional(req.clinicId!, userId))) throw notFound('Professional not found');
    const input = clinicHoursUpdateSchema.parse(req.body);
    const weekly = await getOrCreateProfessionalWeekly(req.clinicId!, userId);
    const updated = await replaceProfessionalWeeklyShifts(weekly.id, input.days);
    res.json(ok(toProfessionalHoursDto(updated)));
  },
);

schedulesRouter.get(
  '/professionals/:userId/overrides',
  authenticate,
  requireClinic,
  async (req, res) => {
    const userId = uuid.parse(req.params.userId);
    await requireProfessionalAccess(req.clinicId!, req.role!, req.user!.id, userId, 'read');
    if (!(await isProfessional(req.clinicId!, userId))) throw notFound('Professional not found');
    const overrides = await listProfessionalOverrides(
      req.clinicId!,
      userId,
      optionalDate(req, 'start'),
      optionalDate(req, 'end'),
    );
    res.json(ok(overrides.map(toProfessionalOverrideDto)));
  },
);

schedulesRouter.post(
  '/professionals/:userId/overrides',
  authenticate,
  requireClinic,
  async (req, res) => {
    const userId = uuid.parse(req.params.userId);
    await requireProfessionalAccess(req.clinicId!, req.role!, req.user!.id, userId, 'write');
    if (!(await isProfessional(req.clinicId!, userId))) throw notFound('Professional not found');
    const input = professionalOverrideSchema.parse(req.body);
    const override = await createProfessionalOverride(req.clinicId!, userId, input);
    res.status(201).json(ok(toProfessionalOverrideDto(override)));
  },
);

schedulesRouter.put(
  '/professionals/:userId/overrides/:overrideId',
  authenticate,
  requireClinic,
  async (req, res) => {
    const userId = uuid.parse(req.params.userId);
    const overrideId = uuid.parse(req.params.overrideId);
    await requireProfessionalAccess(req.clinicId!, req.role!, req.user!.id, userId, 'write');
    const current = await getProfessionalOverride(req.clinicId!, userId, overrideId);
    if (!current) throw notFound('Override not found');
    const input = professionalOverrideSchema.parse(req.body);
    const updated = await updateProfessionalOverride(req.clinicId!, userId, overrideId, input);
    if (!updated) throw notFound('Override not found');
    res.json(ok(toProfessionalOverrideDto(updated)));
  },
);

schedulesRouter.delete(
  '/professionals/:userId/overrides/:overrideId',
  authenticate,
  requireClinic,
  async (req, res) => {
    const userId = uuid.parse(req.params.userId);
    const overrideId = uuid.parse(req.params.overrideId);
    await requireProfessionalAccess(req.clinicId!, req.role!, req.user!.id, userId, 'write');
    const current = await getProfessionalOverride(req.clinicId!, userId, overrideId);
    if (!current) throw notFound('Override not found');
    await deleteProfessionalOverride(userId, overrideId);
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Disponibilité
// ---------------------------------------------------------------------------

schedulesRouter.get(
  '/availability',
  authenticate,
  requireClinic,
  requirePermission('schedules.availability.read'),
  async (req, res) => {
    const start = requiredDate(req, 'start');
    const end = requiredDate(req, 'end');
    const professionalId = optionalUuid(req, 'professional_id');
    assertRangeOrder(start, end);
    assertRangeLength(start, end);

    const result = await resolveAvailability(
      req.clinicId!,
      req.clinic!.timezone,
      start,
      end,
      professionalId,
    );
    res.json(
      ok({
        timezone: result.timeZone,
        ranges: result.ranges.map((range) => toAvailabilityRangeDto(range, result.timeZone)),
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

schedulesRouter.get(
  '/analytics/occupancy',
  authenticate,
  requireClinic,
  requirePermission('schedules.analytics.read'),
  async (req, res) => {
    const start = requiredDate(req, 'start');
    const end = requiredDate(req, 'end');
    const cabinetId = optionalUuid(req, 'cabinet_id');
    assertRangeOrder(start, end);
    assertRangeLength(start, end);

    const rows = await occupancy(req.clinicId!, req.clinic!.timezone, start, end, cabinetId);
    res.json(ok({ start, end, rows }));
  },
);

schedulesRouter.get(
  '/analytics/utilization',
  authenticate,
  requireClinic,
  requirePermission('schedules.analytics.read'),
  async (req, res) => {
    const start = requiredDate(req, 'start');
    const end = requiredDate(req, 'end');
    const professionalId = optionalUuid(req, 'professional_id');
    assertRangeOrder(start, end);
    assertRangeLength(start, end);

    const rows = await utilization(req.clinicId!, req.clinic!.timezone, start, end, professionalId);
    res.json(ok({ start, end, rows }));
  },
);

schedulesRouter.get(
  '/analytics/peak-hours',
  authenticate,
  requireClinic,
  requirePermission('schedules.analytics.read'),
  async (req, res) => {
    const start = requiredDate(req, 'start');
    const end = requiredDate(req, 'end');
    assertRangeOrder(start, end);
    assertRangeLength(start, end);

    const rows = await peakHours(req.clinicId!, req.clinic!.timezone, start, end);
    res.json(ok({ start, end, rows }));
  },
);
