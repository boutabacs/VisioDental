import crypto from 'node:crypto';

import type {
  clinic_overrides,
  clinic_weekly_schedules,
  professional_overrides,
  professional_weekly_schedules,
  schedule_shifts,
} from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { badRequest, forbidden } from '../../lib/errors';
import { parseClinicDate, toZonedIso } from '../../lib/time';
import { hasPermission } from '../../core/auth/rbac';
import type {
  AvailabilityState,
  ClinicHoursDto,
  ClinicOverrideDto,
  ClinicOverrideInput,
  ProfessionalHoursDto,
  ProfessionalOverrideDto,
  ProfessionalOverrideInput,
  ShiftDto,
  WeekdayShiftsDto,
  WeekdayShiftsIn,
} from './schemas';
import {
  dateOnly,
  formatDateOnly,
  formatTimeValue,
  intersectIntervals,
  intervalsToRanges,
  mergeAdjacentRanges,
  nextDay,
  parseDateString,
  sortedIntervals,
  timeToMinutes,
  weekdayIndex,
  type MinuteInterval,
  type ResolvedRange,
} from './schemas';

/** Fuseau par défaut quand la clinique n'en a pas (ou en a un invalide). */
export const DEFAULT_TIMEZONE = 'Europe/Madrid';

const DAY_MS = 86_400_000;

/** Vrai si `timeZone` est un identifiant IANA accepté par `Intl`. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `clinics.timezone` défensif — une valeur invalide retombe sur le défaut. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  const value = (timeZone ?? '').trim();
  if (value && isValidTimeZone(value)) return value;
  if (value) {
    console.warn(
      `[schedules] Invalid timezone ${JSON.stringify(value)}; falling back to ${DEFAULT_TIMEZONE}`,
    );
  }
  return DEFAULT_TIMEZONE;
}

/**
 * Instant UTC d'un mur d'horloge local, comme `datetime.combine(day, t, tz)`.
 * `parseClinicDate` reproduit la sémantique fold=0 de zoneinfo. Les secondes
 * sont conservées (fin de journée `23:59:59`).
 */
export function zonedInstant(dateStr: string, minutes: number, timeZone: string, seconds = 0): Date {
  const totalSeconds = Math.max(0, Math.round(minutes * 60 + seconds));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const mins = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const secs = String(totalSeconds % 60).padStart(2, '0');
  return parseClinicDate(`${dateStr}T${hours}:${mins}:${secs}`, timeZone);
}

/**
 * Serialisation façon FastAPI d'un datetime TZ-aware : `2026-11-18T09:00:00+01:00`.
 * Pydantic utilise l'offset ISO et non le nom court — `toZonedIso` fait exactement ça.
 */
export function formatZonedDateTime(date: Date, timeZone: string): string {
  return toZonedIso(date, timeZone);
}

/** Intervalles d'une liste de shifts (bornes en minutes depuis minuit). */
export function shiftMinuteIntervals(
  shifts: readonly (Pick<schedule_shifts, 'start_time' | 'end_time'> & { weekday?: number | null })[],
  weekday?: number,
): MinuteInterval[] {
  return sortedIntervals(
    shifts
      .filter((shift) => weekday === undefined || shift.weekday === weekday)
      .map(
        (shift) =>
          [
            timeToMinutes(formatTimeValue(shift.start_time)),
            timeToMinutes(formatTimeValue(shift.end_time)),
          ] as const,
      ),
  );
}

function clockParts(value: string): [number, number, number] {
  const [hours, minutes, seconds = '0'] = value.split(':');
  return [Number(hours), Number(minutes), Math.floor(Number(seconds))];
}

/** `'09:30'` → `Date` ancrée au 1970-01-01 (colonne `time(6)`). */
function timeColumn(value: string): Date {
  return new Date(Date.UTC(1970, 0, 1, ...clockParts(value)));
}

function overrideDateRange(input: ClinicOverrideInput | ProfessionalOverrideInput): {
  startDate: string;
  endDate: string;
} {
  return {
    startDate: parseDateString(input.start_date),
    endDate: parseDateString(input.end_date),
  };
}

// ---------------------------------------------------------------------------
// Mappers (miroir des helpers `_*_to_response` du router Python)
// ---------------------------------------------------------------------------

function toShiftDto(shift: schedule_shifts): ShiftDto {
  return {
    id: shift.id,
    start_time: formatTimeValue(shift.start_time),
    end_time: formatTimeValue(shift.end_time),
  };
}

function byStartTime(a: ShiftDto, b: ShiftDto): number {
  if (a.start_time === b.start_time) return 0;
  return a.start_time < b.start_time ? -1 : 1;
}

/** Sept entrées `0..6`, shifts triés par heure de début. */
function groupShiftsByWeekday(shifts: readonly schedule_shifts[]): WeekdayShiftsDto[] {
  const byDay: WeekdayShiftsDto[] = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    shifts: [],
  }));
  for (const shift of shifts) {
    if (shift.weekday === null) continue;
    byDay[shift.weekday]?.shifts.push(toShiftDto(shift));
  }
  for (const day of byDay) day.shifts.sort(byStartTime);
  return byDay;
}

type WeeklyWithShifts<W> = W & { schedule_shifts: schedule_shifts[] };

export function toClinicHoursDto(
  weekly: WeeklyWithShifts<clinic_weekly_schedules>,
  timeZone: string,
): ClinicHoursDto {
  return {
    id: weekly.id,
    clinic_id: weekly.clinic_id,
    timezone: timeZone,
    is_active: weekly.is_active,
    days: groupShiftsByWeekday(weekly.schedule_shifts),
  };
}

export function toProfessionalHoursDto(
  weekly: WeeklyWithShifts<professional_weekly_schedules>,
): ProfessionalHoursDto {
  return {
    id: weekly.id,
    clinic_id: weekly.clinic_id,
    user_id: weekly.user_id,
    is_active: weekly.is_active,
    days: groupShiftsByWeekday(weekly.schedule_shifts),
  };
}

export function toClinicOverrideDto(
  override: clinic_overrides & { schedule_shifts: schedule_shifts[] },
): ClinicOverrideDto {
  return {
    id: override.id,
    clinic_id: override.clinic_id,
    start_date: formatDateOnly(override.start_date),
    end_date: formatDateOnly(override.end_date),
    kind: override.kind,
    reason: override.reason,
    shifts: override.schedule_shifts.map(toShiftDto).sort(byStartTime),
  };
}

export function toProfessionalOverrideDto(
  override: professional_overrides & { schedule_shifts: schedule_shifts[] },
): ProfessionalOverrideDto {
  return {
    id: override.id,
    clinic_id: override.clinic_id,
    user_id: override.user_id,
    start_date: formatDateOnly(override.start_date),
    end_date: formatDateOnly(override.end_date),
    kind: override.kind,
    reason: override.reason,
    shifts: override.schedule_shifts.map(toShiftDto).sort(byStartTime),
  };
}

// ---------------------------------------------------------------------------
// Horaires de la clinique
// ---------------------------------------------------------------------------

/** Planning hebdomadaire de la clinique, créé en 24/7 à la première lecture. */
export async function getOrCreateClinicWeekly(
  clinicId: string,
): Promise<WeeklyWithShifts<clinic_weekly_schedules>> {
  const existing = await prisma.clinic_weekly_schedules.findUnique({
    where: { clinic_id: clinicId },
    include: { schedule_shifts: true },
  });
  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.clinic_weekly_schedules.create({
        data: { id, clinic_id: clinicId, is_active: true, created_at: now, updated_at: now },
      });
      await tx.schedule_shifts.createMany({
        data: Array.from({ length: 7 }, (_, weekday) => ({
          id: crypto.randomUUID(),
          clinic_weekly_id: id,
          weekday,
          start_time: timeColumn('00:00'),
          end_time: timeColumn('23:59'),
        })),
      });
    });
  } catch (error) {
    // Création concurrente (deux premiers GET simultanés) : on relit.
    const raced = await prisma.clinic_weekly_schedules.findUnique({
      where: { clinic_id: clinicId },
      include: { schedule_shifts: true },
    });
    if (!raced) throw error;
    return raced;
  }

  const created = await prisma.clinic_weekly_schedules.findUnique({
    where: { clinic_id: clinicId },
    include: { schedule_shifts: true },
  });
  if (!created) throw new Error('clinic weekly schedule not created');
  return created;
}

/**
 * Remplace les shifts des seuls jours listés (`days`). Un jour absent garde
 * ses shifts ; un jour présent avec une liste vide est vidé.
 */
export async function replaceClinicWeeklyShifts(
  weeklyId: string,
  days: readonly WeekdayShiftsIn[],
): Promise<WeeklyWithShifts<clinic_weekly_schedules>> {
  const touched = [...new Set(days.map((day) => day.weekday))];

  await prisma.$transaction(async (tx) => {
    await tx.schedule_shifts.deleteMany({
      where: { clinic_weekly_id: weeklyId, weekday: { in: touched } },
    });
    const rows = days.flatMap((day) =>
      day.shifts.map((shift) => ({
        id: crypto.randomUUID(),
        clinic_weekly_id: weeklyId,
        weekday: day.weekday,
        start_time: timeColumn(shift.start_time),
        end_time: timeColumn(shift.end_time),
      })),
    );
    if (rows.length > 0) await tx.schedule_shifts.createMany({ data: rows });
    await tx.clinic_weekly_schedules.update({
      where: { id: weeklyId },
      data: { updated_at: new Date() },
    });
  });

  const weekly = await prisma.clinic_weekly_schedules.findUnique({
    where: { id: weeklyId },
    include: { schedule_shifts: true },
  });
  if (!weekly) throw new Error('clinic weekly schedule vanished');
  return weekly;
}

type ClinicOverrideRow = clinic_overrides & { schedule_shifts: schedule_shifts[] };

export async function listClinicOverrides(
  clinicId: string,
  start: string | null,
  end: string | null,
): Promise<ClinicOverrideRow[]> {
  return prisma.clinic_overrides.findMany({
    where: {
      clinic_id: clinicId,
      ...(start ? { end_date: { gte: dateOnly(start) } } : {}),
      ...(end ? { start_date: { lte: dateOnly(end) } } : {}),
    },
    include: { schedule_shifts: true },
    orderBy: { start_date: 'asc' },
  });
}

export async function getClinicOverride(
  clinicId: string,
  overrideId: string,
): Promise<ClinicOverrideRow | null> {
  return prisma.clinic_overrides.findFirst({
    where: { id: overrideId, clinic_id: clinicId },
    include: { schedule_shifts: true },
  });
}

export async function createClinicOverride(
  clinicId: string,
  input: ClinicOverrideInput,
): Promise<ClinicOverrideRow> {
  const { startDate, endDate } = overrideDateRange(input);
  const id = crypto.randomUUID();
  const now = new Date();

  await prisma.clinic_overrides.create({
    data: {
      id,
      clinic_id: clinicId,
      start_date: dateOnly(startDate),
      end_date: dateOnly(endDate),
      kind: input.kind,
      reason: input.reason ?? null,
      created_at: now,
      updated_at: now,
      schedule_shifts: {
        // Les shifts d'un override sont ancrés sur `start_date`.
        create: input.shifts.map((shift) => ({
          id: crypto.randomUUID(),
          shift_date: dateOnly(startDate),
          start_time: timeColumn(shift.start_time),
          end_time: timeColumn(shift.end_time),
        })),
      },
    },
  });

  const created = await getClinicOverride(clinicId, id);
  if (!created) throw new Error('clinic override not created');
  return created;
}

export async function updateClinicOverride(
  clinicId: string,
  overrideId: string,
  input: ClinicOverrideInput,
): Promise<ClinicOverrideRow | null> {
  const { startDate, endDate } = overrideDateRange(input);

  await prisma.$transaction(async (tx) => {
    await tx.clinic_overrides.update({
      where: { id: overrideId },
      data: {
        start_date: dateOnly(startDate),
        end_date: dateOnly(endDate),
        kind: input.kind,
        reason: input.reason ?? null,
        updated_at: new Date(),
      },
    });
    await tx.schedule_shifts.deleteMany({ where: { clinic_override_id: overrideId } });
    if (input.shifts.length > 0) {
      await tx.schedule_shifts.createMany({
        data: input.shifts.map((shift) => ({
          id: crypto.randomUUID(),
          clinic_override_id: overrideId,
          shift_date: dateOnly(startDate),
          start_time: timeColumn(shift.start_time),
          end_time: timeColumn(shift.end_time),
        })),
      });
    }
  });

  return getClinicOverride(clinicId, overrideId);
}

export async function deleteClinicOverride(overrideId: string): Promise<void> {
  await prisma.clinic_overrides.delete({ where: { id: overrideId } });
}

// ---------------------------------------------------------------------------
// Horaires des professionnels
// ---------------------------------------------------------------------------

/** Existence d'une adhésion professionnelle (tolère les doublons, cf. #590). */
export async function isProfessional(clinicId: string, userId: string): Promise<boolean> {
  const row = await prisma.clinic_memberships.findFirst({
    where: { clinic_id: clinicId, user_id: userId, is_professional: true },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Contrôle d'accès « horaires d'un professionnel » (miroir de
 * `_require_professional_access`) : permission générale, ou permission
 * « own » quand la cible est l'utilisateur courant. Sinon 403.
 */
export async function requireProfessionalAccess(
  clinicId: string,
  role: string,
  actorId: string,
  userId: string,
  action: 'read' | 'write',
): Promise<void> {
  const general = `schedules.professional.${action}`;
  const own = `schedules.professional.own.${action}`;
  if (await hasPermission(clinicId, role, general)) return;
  if (userId === actorId && (await hasPermission(clinicId, role, own))) return;
  throw forbidden(`Permission denied: ${general}`);
}

export async function getOrCreateProfessionalWeekly(
  clinicId: string,
  userId: string,
): Promise<WeeklyWithShifts<professional_weekly_schedules>> {
  const existing = await prisma.professional_weekly_schedules.findUnique({
    where: { clinic_id_user_id: { clinic_id: clinicId, user_id: userId } },
    include: { schedule_shifts: true },
  });
  if (existing) return existing;

  const now = new Date();
  try {
    await prisma.professional_weekly_schedules.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: clinicId,
        user_id: userId,
        is_active: true,
        created_at: now,
        updated_at: now,
      },
    });
  } catch (error) {
    const raced = await prisma.professional_weekly_schedules.findUnique({
      where: { clinic_id_user_id: { clinic_id: clinicId, user_id: userId } },
      include: { schedule_shifts: true },
    });
    if (!raced) throw error;
    return raced;
  }

  const created = await prisma.professional_weekly_schedules.findUnique({
    where: { clinic_id_user_id: { clinic_id: clinicId, user_id: userId } },
    include: { schedule_shifts: true },
  });
  if (!created) throw new Error('professional weekly schedule not created');
  return created;
}

export async function replaceProfessionalWeeklyShifts(
  weeklyId: string,
  days: readonly WeekdayShiftsIn[],
): Promise<WeeklyWithShifts<professional_weekly_schedules>> {
  const touched = [...new Set(days.map((day) => day.weekday))];

  await prisma.$transaction(async (tx) => {
    await tx.schedule_shifts.deleteMany({
      where: { professional_weekly_id: weeklyId, weekday: { in: touched } },
    });
    const rows = days.flatMap((day) =>
      day.shifts.map((shift) => ({
        id: crypto.randomUUID(),
        professional_weekly_id: weeklyId,
        weekday: day.weekday,
        start_time: timeColumn(shift.start_time),
        end_time: timeColumn(shift.end_time),
      })),
    );
    if (rows.length > 0) await tx.schedule_shifts.createMany({ data: rows });
    await tx.professional_weekly_schedules.update({
      where: { id: weeklyId },
      data: { updated_at: new Date() },
    });
  });

  const weekly = await prisma.professional_weekly_schedules.findUnique({
    where: { id: weeklyId },
    include: { schedule_shifts: true },
  });
  if (!weekly) throw new Error('professional weekly schedule vanished');
  return weekly;
}

type ProfessionalOverrideRow = professional_overrides & { schedule_shifts: schedule_shifts[] };

export async function listProfessionalOverrides(
  clinicId: string,
  userId: string,
  start: string | null,
  end: string | null,
): Promise<ProfessionalOverrideRow[]> {
  return prisma.professional_overrides.findMany({
    where: {
      clinic_id: clinicId,
      user_id: userId,
      ...(start ? { end_date: { gte: dateOnly(start) } } : {}),
      ...(end ? { start_date: { lte: dateOnly(end) } } : {}),
    },
    include: { schedule_shifts: true },
    orderBy: { start_date: 'asc' },
  });
}

export async function getProfessionalOverride(
  clinicId: string,
  userId: string,
  overrideId: string,
): Promise<ProfessionalOverrideRow | null> {
  return prisma.professional_overrides.findFirst({
    where: { id: overrideId, clinic_id: clinicId, user_id: userId },
    include: { schedule_shifts: true },
  });
}

export async function createProfessionalOverride(
  clinicId: string,
  userId: string,
  input: ProfessionalOverrideInput,
): Promise<ProfessionalOverrideRow> {
  const { startDate, endDate } = overrideDateRange(input);
  const id = crypto.randomUUID();
  const now = new Date();

  await prisma.professional_overrides.create({
    data: {
      id,
      clinic_id: clinicId,
      user_id: userId,
      start_date: dateOnly(startDate),
      end_date: dateOnly(endDate),
      kind: input.kind,
      reason: input.reason ?? null,
      created_at: now,
      updated_at: now,
      schedule_shifts: {
        create: input.shifts.map((shift) => ({
          id: crypto.randomUUID(),
          shift_date: dateOnly(startDate),
          start_time: timeColumn(shift.start_time),
          end_time: timeColumn(shift.end_time),
        })),
      },
    },
  });

  const created = await getProfessionalOverride(clinicId, userId, id);
  if (!created) throw new Error('professional override not created');
  return created;
}

export async function updateProfessionalOverride(
  clinicId: string,
  userId: string,
  overrideId: string,
  input: ProfessionalOverrideInput,
): Promise<ProfessionalOverrideRow | null> {
  const { startDate, endDate } = overrideDateRange(input);

  await prisma.$transaction(async (tx) => {
    // `user_id` garde l'écriture dans l'espace du professionnel ciblé.
    await tx.professional_overrides.update({
      where: { id: overrideId, user_id: userId, clinic_id: clinicId },
      data: {
        start_date: dateOnly(startDate),
        end_date: dateOnly(endDate),
        kind: input.kind,
        reason: input.reason ?? null,
        updated_at: new Date(),
      },
    });
    await tx.schedule_shifts.deleteMany({ where: { professional_override_id: overrideId } });
    if (input.shifts.length > 0) {
      await tx.schedule_shifts.createMany({
        data: input.shifts.map((shift) => ({
          id: crypto.randomUUID(),
          professional_override_id: overrideId,
          shift_date: dateOnly(startDate),
          start_time: timeColumn(shift.start_time),
          end_time: timeColumn(shift.end_time),
        })),
      });
    }
  });

  return getProfessionalOverride(clinicId, userId, overrideId);
}

export async function deleteProfessionalOverride(
  userId: string,
  overrideId: string,
): Promise<void> {
  await prisma.professional_overrides.delete({ where: { id: overrideId, user_id: userId } });
}

// ---------------------------------------------------------------------------
// Disponibilité — résolveur pur + chargement
// ---------------------------------------------------------------------------

interface OverrideLike {
  start_date: Date;
  end_date: Date;
  kind: string;
  reason: string | null;
  created_at: Date | null;
  schedule_shifts: schedule_shifts[];
}

interface ShiftLike {
  weekday: number | null;
  start_time: Date;
  end_time: Date;
}

/**
 * Override le plus spécifique couvrant `day` : plus grand `start_date`,
 * puis création la plus récente (miroir de `_pick_override`).
 */
export function pickOverride<T extends OverrideLike>(overrides: readonly T[], day: string): T | null {
  const candidates = overrides.filter(
    (override) => formatDateOnly(override.start_date) <= day && day <= formatDateOnly(override.end_date),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const aStart = formatDateOnly(a.start_date);
    const bStart = formatDateOnly(b.start_date);
    if (aStart !== bStart) return aStart < bStart ? 1 : -1;
    return (b.created_at?.getTime() ?? 0) - (a.created_at?.getTime() ?? 0);
  });
  return candidates[0] ?? null;
}

export interface ResolveDayInput {
  /** Jour local `YYYY-MM-DD`. */
  day: string;
  timeZone: string;
  clinicShifts: readonly ShiftLike[];
  clinicOverrides: readonly OverrideLike[];
  professionalShifts: readonly ShiftLike[];
  professionalOverrides: readonly OverrideLike[];
  professionalId: string | null;
}

/**
 * Résolution d'une journée ; précédence décroissante :
 * 1. override pro `unavailable` → `professional_off`
 * 2. override pro `custom_hours` → remplace le planning pro
 * 3. planning pro hebdo → intersecté avec la clinique
 * 4. override clinique `closed` → `clinic_closed`
 * 5. override clinique `custom_hours` → remplace le planning clinique
 * 6. planning clinique hebdo → plage ouverte de base
 *
 * Journée entière = `00:00` → `23:59:59` local (comme le resolver Python).
 */
export function resolveDay(input: ResolveDayInput): ResolvedRange[] {
  const { day, timeZone, professionalId } = input;
  const makeInstant = (dateStr: string, minutes: number) => zonedInstant(dateStr, minutes, timeZone);
  const weekday = weekdayIndex(day);

  /** Journée entière `00:00` → `23:59:59` local. */
  const wholeDay = (state: AvailabilityState, reason: string | null): ResolvedRange => ({
    start: makeInstant(day, 0),
    end: zonedInstant(day, 23 * 60 + 59, timeZone, 59),
    state,
    professional_id: state === 'professional_off' ? professionalId : null,
    reason,
  });

  let clinicIntervals: MinuteInterval[] = [];
  let clinicClosedReason: string | null = null;

  const clinicOverride = pickOverride(input.clinicOverrides, day);
  if (clinicOverride) {
    if (clinicOverride.kind === 'closed') {
      return [wholeDay('clinic_closed', clinicOverride.reason)];
    }
    clinicIntervals = shiftMinuteIntervals(clinicOverride.schedule_shifts);
    clinicClosedReason = clinicOverride.reason;
  } else {
    clinicIntervals = shiftMinuteIntervals(input.clinicShifts, weekday);
  }

  // Aucun horaire clinique → journée entière fermée.
  if (clinicIntervals.length === 0) {
    return [wholeDay('clinic_closed', clinicClosedReason)];
  }

  if (professionalId === null) {
    return intervalsToRanges(day, clinicIntervals, 'open', null, makeInstant, endOfDay(day, timeZone));
  }

  const professionalOverride = pickOverride(input.professionalOverrides, day);
  let professionalIntervals: MinuteInterval[];
  if (professionalOverride) {
    if (professionalOverride.kind === 'unavailable') {
      return [wholeDay('professional_off', professionalOverride.reason)];
    }
    professionalIntervals = shiftMinuteIntervals(professionalOverride.schedule_shifts);
  } else if (input.professionalShifts.length === 0) {
    // Aucun planning pro défini → hérite des horaires de la clinique.
    professionalIntervals = [...clinicIntervals];
  } else {
    professionalIntervals = shiftMinuteIntervals(input.professionalShifts, weekday);
  }

  if (professionalIntervals.length === 0) {
    return [wholeDay('professional_off', professionalOverride ? professionalOverride.reason : null)];
  }

  const intersected = intersectIntervals(clinicIntervals, professionalIntervals);
  return intervalsToRanges(
    day,
    intersected,
    'open',
    professionalId,
    makeInstant,
    endOfDay(day, timeZone),
  );
}

/** `23:59:59` local (le resolver Python termine chaque journée là). */
export function endOfDay(day: string, timeZone: string): Date {
  return zonedInstant(day, 23 * 60 + 59, timeZone, 59);
}

export interface AvailabilityResult {
  timeZone: string;
  ranges: ResolvedRange[];
}

/** Résout `[start, end]` (dates `YYYY-MM-DD`, incluses) pour une clinique. */
export async function resolveAvailability(
  clinicId: string,
  clinicTimeZone: string | null,
  start: string,
  end: string,
  professionalId: string | null,
): Promise<AvailabilityResult> {
  const timeZone = safeTimeZone(clinicTimeZone);

  const clinicWeekly = await prisma.clinic_weekly_schedules.findUnique({
    where: { clinic_id: clinicId },
    include: { schedule_shifts: true },
  });
  const clinicOverrides = await prisma.clinic_overrides.findMany({
    where: {
      clinic_id: clinicId,
      start_date: { lte: dateOnly(end) },
      end_date: { gte: dateOnly(start) },
    },
    include: { schedule_shifts: true },
  });

  let professionalShifts: ShiftLike[] = [];
  let professionalOverrides: OverrideLike[] = [];
  if (professionalId !== null) {
    const professionalWeekly = await prisma.professional_weekly_schedules.findUnique({
      where: { clinic_id_user_id: { clinic_id: clinicId, user_id: professionalId } },
      include: { schedule_shifts: true },
    });
    professionalShifts = professionalWeekly ? professionalWeekly.schedule_shifts : [];
    professionalOverrides = await prisma.professional_overrides.findMany({
      where: {
        clinic_id: clinicId,
        user_id: professionalId,
        start_date: { lte: dateOnly(end) },
        end_date: { gte: dateOnly(start) },
      },
      include: { schedule_shifts: true },
    });
  }

  const allRanges: ResolvedRange[] = [];
  for (let day = start; day <= end; day = nextDay(day)) {
    allRanges.push(
      ...resolveDay({
        day,
        timeZone,
        clinicShifts: clinicWeekly ? clinicWeekly.schedule_shifts : [],
        clinicOverrides,
        professionalShifts,
        professionalOverrides,
        professionalId,
      }),
    );
  }

  return { timeZone, ranges: mergeAdjacentRanges(allRanges) };
}

export function toAvailabilityRangeDto(range: ResolvedRange, timeZone: string) {
  return {
    start: formatZonedDateTime(range.start, timeZone),
    end: formatZonedDateTime(range.end, timeZone),
    state: range.state,
    professional_id: range.professional_id,
    reason: range.reason,
  };
}

// ---------------------------------------------------------------------------
// Analytics (occupation / utilisation / heures de pointe)
// ---------------------------------------------------------------------------

/** Bornes d'une plage de jours locaux, comme `_bound(day, "lo"|"hi", tz)`. */
export function dayBounds(
  start: string,
  end: string,
  timeZone: string,
): { lo: Date; hi: Date } {
  return {
    lo: zonedInstant(start, 0, timeZone),
    hi: zonedInstant(nextDay(end), 0, timeZone),
  };
}

/** Somme des minutes, arrondie bas comme `int(total_seconds() / 60)`. */
export function totalMinutes(ranges: readonly { start: Date; end: Date }[]): number {
  let total = 0;
  for (const range of ranges) {
    total += Math.floor((range.end.getTime() - range.start.getTime()) / 60_000);
  }
  return total;
}

export interface OccupancyRow {
  cabinet_id: string;
  cabinet_name: string;
  booked_minutes: number;
  available_minutes: number;
  occupancy_rate: number;
}

/**
 * Miroir de `AnalyticsService.occupancy` : minutes ouvertes de la clinique
 * au dénominateur, minutes de rendez-vous non annulés par cabinet.
 */
export async function occupancy(
  clinicId: string,
  clinicTimeZone: string | null,
  start: string,
  end: string,
  cabinetId: string | null,
): Promise<OccupancyRow[]> {
  const availability = await resolveAvailability(clinicId, clinicTimeZone, start, end, null);
  const availableMinutes = totalMinutes(
    availability.ranges.filter((range) => range.state === 'open'),
  );

  const cabinets = await prisma.cabinets.findMany({
    where: { clinic_id: clinicId, ...(cabinetId ? { id: cabinetId } : {}) },
    orderBy: { name: 'asc' },
  });
  if (cabinets.length === 0) return [];

  // Un rendez-vous est compté sur son `start_time` (jointure Python).
  const { lo, hi } = dayBounds(start, end, availability.timeZone);
  const rows = await prisma.appointments.findMany({
    where: {
      clinic_id: clinicId,
      status: { not: 'cancelled' },
      start_time: { gte: lo, lte: hi },
      cabinet_id: { in: cabinets.map((cabinet) => cabinet.id) },
    },
    select: { cabinet_id: true, start_time: true, end_time: true },
  });
  const bookedByCabinet = new Map<string, number>();
  for (const row of rows) {
    if (!row.cabinet_id) continue;
    bookedByCabinet.set(
      row.cabinet_id,
      (bookedByCabinet.get(row.cabinet_id) ?? 0) + (row.end_time.getTime() - row.start_time.getTime()) / 60_000,
    );
  }

  return cabinets.map((cabinet) => {
    const booked = Math.trunc(bookedByCabinet.get(cabinet.id) ?? 0);
    const rate = availableMinutes ? booked / availableMinutes : 0;
    return {
      cabinet_id: cabinet.id,
      cabinet_name: cabinet.name,
      booked_minutes: booked,
      available_minutes: availableMinutes,
      occupancy_rate: Math.min(rate, 1),
    };
  });
}

export interface UtilizationRow {
  professional_id: string;
  professional_name: string;
  booked_minutes: number;
  working_minutes: number;
  utilization_rate: number;
}

/**
 * Miroir de `AnalyticsService.utilization` : minutes ouvertes du
 * professionnel (résolveur avec `professional_id`) au dénominateur.
 */
export async function utilization(
  clinicId: string,
  clinicTimeZone: string | null,
  start: string,
  end: string,
  professionalId: string | null,
): Promise<UtilizationRow[]> {
  const memberships = await prisma.clinic_memberships.findMany({
    where: {
      clinic_id: clinicId,
      is_professional: true,
      ...(professionalId ? { user_id: professionalId } : {}),
    },
    select: { user_id: true },
    distinct: ['user_id'],
  });
  if (memberships.length === 0) return [];
  const userIds = memberships.map((membership) => membership.user_id);

  const users = await prisma.users.findMany({
    where: { id: { in: userIds } },
    select: { id: true, first_name: true, last_name: true },
    orderBy: [{ last_name: 'asc' }, { first_name: 'asc' }],
  });
  if (users.length === 0) return [];

  const timeZone = safeTimeZone(clinicTimeZone);
  const { lo, hi } = dayBounds(start, end, timeZone);
  const appointments = await prisma.appointments.findMany({
    where: {
      clinic_id: clinicId,
      professional_id: { in: users.map((user) => user.id) },
      status: { not: 'cancelled' },
      start_time: { gte: lo, lte: hi },
    },
    select: { professional_id: true, start_time: true, end_time: true },
  });
  const bookedByUser = new Map<string, number>();
  for (const row of appointments) {
    bookedByUser.set(
      row.professional_id,
      (bookedByUser.get(row.professional_id) ?? 0) + (row.end_time.getTime() - row.start_time.getTime()) / 60_000,
    );
  }

  const rows: UtilizationRow[] = [];
  for (const user of users) {
    const availability = await resolveAvailability(clinicId, timeZone, start, end, user.id);
    const workingMinutes = totalMinutes(
      availability.ranges.filter((range) => range.state === 'open'),
    );
    const booked = Math.trunc(bookedByUser.get(user.id) ?? 0);
    const rate = workingMinutes ? booked / workingMinutes : 0;
    rows.push({
      professional_id: user.id,
      professional_name: `${user.first_name} ${user.last_name}`.trim(),
      booked_minutes: booked,
      working_minutes: workingMinutes,
      utilization_rate: Math.min(rate, 1),
    });
  }
  return rows;
}

export interface PeakHourRow {
  hour: number;
  appointment_count: number;
}

/** Heure locale (fuseau clinique) d'un instant — équivalent `AT TIME ZONE`. */
export function clinicHour(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
}

/** Regroupe des instants par heure locale (pur, testable sans DB). */
export function bucketByClinicHour(dates: readonly Date[], timeZone: string): PeakHourRow[] {
  const counts = new Map<number, number>();
  for (const date of dates) {
    const hour = clinicHour(date, timeZone);
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, count]) => ({ hour, appointment_count: count }));
}

/** Miroir de `AnalyticsService.peak_hours`. */
export async function peakHours(
  clinicId: string,
  clinicTimeZone: string | null,
  start: string,
  end: string,
): Promise<PeakHourRow[]> {
  const timeZone = safeTimeZone(clinicTimeZone);
  const { lo, hi } = dayBounds(start, end, timeZone);
  const rows = await prisma.appointments.findMany({
    where: {
      clinic_id: clinicId,
      status: { not: 'cancelled' },
      start_time: { gte: lo, lte: hi },
    },
    select: { start_time: true },
  });
  return bucketByClinicHour(
    rows.map((row) => row.start_time),
    timeZone,
  );
}

// ---------------------------------------------------------------------------
// Divers
// ---------------------------------------------------------------------------

/** Borne de sécurité : au-delà, la génération jour par jour ferait un 500. */
export const MAX_RANGE_DAYS = 732;

export function assertRangeOrder(start: string, end: string): void {
  if (end < start) throw badRequest('end must be on or after start');
}

export function assertRangeLength(start: string, end: string): void {
  const days = Math.floor((dateOnly(end).getTime() - dateOnly(start).getTime()) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw badRequest(`Range too large (max ${MAX_RANGE_DAYS} days)`);
  }
}
