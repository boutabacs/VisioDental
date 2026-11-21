import { z } from 'zod';

// --- Validation (miroir de `backend/app/modules/schedules/schemas.py`) -----

/** `HH:MM` de `datetime.time` (les secondes `:SS` et les fractions restent acceptées). */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/;

export const clockTimeSchema = z
  .string()
  .regex(TIME_PATTERN, 'Format horaire attendu (HH:MM)');

export interface ShiftIn {
  start_time: string;
  end_time: string;
}

const shiftFieldsSchema = z.object({
  start_time: clockTimeSchema,
  end_time: clockTimeSchema,
});

/**
 * `ShiftIn` : `end_time` doit être strictement postérieur à `start_time`.
 * La comparaison est lexicographique, ce qui est exact pour `HH:MM[:SS]`
 * (même ordre que l'opérateur `<` sur `datetime.time`).
 */
export const shiftInSchema = shiftFieldsSchema.pipe(
  z.custom<ShiftIn>(
    (value) => {
      const shift = value as ShiftIn;
      const valid = TIME_PATTERN.test(shift.start_time) && TIME_PATTERN.test(shift.end_time);
      return !valid || shift.end_time > shift.start_time;
    },
    { error: 'end_time must be after start_time', path: ['end_time'] },
  ),
);

export const weekdayShiftsInSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  shifts: z.array(shiftInSchema).default([]),
});

export const clinicHoursUpdateSchema = z.object({
  days: z.array(weekdayShiftsInSchema),
});

export const CLINIC_OVERRIDE_KINDS = ['closed', 'custom_hours'] as const;
export const PROFESSIONAL_OVERRIDE_KINDS = ['unavailable', 'custom_hours'] as const;

interface OverrideShapeOutput {
  start_date: string;
  end_date: string;
  kind: string;
  reason?: string | null;
  shifts: ShiftIn[];
}

/**
 * Conteneur d'override : les invariants inter-champs suivent l'ordre des
 * `model_validator(mode="after")` de Pydantic (dates, puis kind/shifts).
 * Chaque invariant est une passe indépendante afin que le premier échec
 * soit celui que Pydantic remonterait.
 */
function overrideShape<K extends readonly [string, ...string[]]>(kinds: K) {
  const closedKind = kinds[0] as string;
  return z
    .object({
      start_date: z.string(),
      end_date: z.string(),
      kind: z.enum(kinds),
      reason: z.string().max(200).nullable().optional(),
      shifts: z.array(shiftInSchema).default([]),
    })
    .pipe(
      z.custom<OverrideShapeOutput>(
        (value) => {
          const shape = value as OverrideShapeOutput;
          return (
            !isDateOnly(shape.start_date)
            || !isDateOnly(shape.end_date)
            || shape.end_date >= shape.start_date
          );
        },
        { error: 'end_date must be on or after start_date', path: ['end_date'] },
      ),
    )
    .pipe(
      z.custom<OverrideShapeOutput>(
        (value) => {
          const shape = value as OverrideShapeOutput;
          return shape.kind !== closedKind || shape.shifts.length === 0;
        },
        { error: `${closedKind} overrides must have no shifts`, path: ['shifts'] },
      ),
    )
    .pipe(
      z.custom<OverrideShapeOutput>(
        (value) => {
          const shape = value as OverrideShapeOutput;
          return shape.kind !== 'custom_hours' || shape.shifts.length > 0;
        },
        { error: 'custom_hours overrides require at least one shift', path: ['shifts'] },
      ),
    );
}

export const clinicOverrideSchema = overrideShape(CLINIC_OVERRIDE_KINDS);
export const professionalOverrideSchema = overrideShape(PROFESSIONAL_OVERRIDE_KINDS);

export type ShiftInInput = z.infer<typeof shiftFieldsSchema>;
export type WeekdayShiftsIn = z.infer<typeof weekdayShiftsInSchema>;
export type ClinicHoursUpdateInput = z.infer<typeof clinicHoursUpdateSchema>;
export type ClinicOverrideInput = OverrideShapeOutput & { kind: string };
export type ProfessionalOverrideInput = OverrideShapeOutput & { kind: string };

// --- DTOs (enveloppe `{data}` gérée par `lib/http`) ----------------------

export interface ShiftDto {
  id: string;
  start_time: string;
  end_time: string;
}

export interface WeekdayShiftsDto {
  weekday: number;
  shifts: ShiftDto[];
}

export interface ClinicHoursDto {
  id: string;
  clinic_id: string;
  timezone: string;
  is_active: boolean;
  days: WeekdayShiftsDto[];
}

export interface ProfessionalHoursDto {
  id: string;
  clinic_id: string;
  user_id: string;
  is_active: boolean;
  days: WeekdayShiftsDto[];
}

export interface ClinicOverrideDto {
  id: string;
  clinic_id: string;
  start_date: string;
  end_date: string;
  kind: string;
  reason: string | null;
  shifts: ShiftDto[];
}

export interface ProfessionalOverrideDto extends ClinicOverrideDto {
  user_id: string;
}

export type AvailabilityState = 'open' | 'clinic_closed' | 'professional_off';

export interface AvailabilityRangeDto {
  start: string;
  end: string;
  state: AvailabilityState;
  professional_id: string | null;
  reason: string | null;
}

export interface AvailabilityDto {
  timezone: string;
  ranges: AvailabilityRangeDto[];
}

export interface OccupancyRowDto {
  cabinet_id: string;
  cabinet_name: string;
  booked_minutes: number;
  available_minutes: number;
  occupancy_rate: number;
}

export interface OccupancyDto {
  start: string;
  end: string;
  rows: OccupancyRowDto[];
}

export interface UtilizationRowDto {
  professional_id: string;
  professional_name: string;
  booked_minutes: number;
  working_minutes: number;
  utilization_rate: number;
}

export interface UtilizationDto {
  start: string;
  end: string;
  rows: UtilizationRowDto[];
}

export interface PeakHourRowDto {
  hour: number;
  appointment_count: number;
}

export interface PeakHoursDto {
  start: string;
  end: string;
  rows: PeakHourRowDto[];
}

// --- Pure helpers --------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_FULL = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/;

export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

/**
 * `date` Python → `YYYY-MM-DD`. Comme Pydantic (`date.fromisoformat`), une
 * valeur non calendaire (`2026-02-30`) ou sans partie date est refusée.
 */
export function parseDateString(value: string): string {
  const match = DATE_FULL.exec(value.trim());
  if (!match) throw new Error(`Input should be a valid date or datetime, invalid date value`);
  const [, year, month, day] = match;
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    utc.getUTCFullYear() !== Number(year)
    || utc.getUTCMonth() !== Number(month) - 1
    || utc.getUTCDate() !== Number(day)
  ) {
    throw new Error('Input should be a valid date or datetime, day is out of range for month');
  }
  return `${year}-${month}-${day}`;
}

/** `date` Prisma → `YYYY-MM-DD` (partie UTC, comme Python). */
export function formatDateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → `Date` à minuit UTC (colonnes `date` de Prisma). */
export function dateOnly(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

/** Jour suivant d'une date `YYYY-MM-DD`. */
export function nextDay(value: string): string {
  const next = new Date(dateOnly(value).getTime() + 86_400_000);
  return next.toISOString().slice(0, 10);
}

/** `datetime.weekday()` — lundi = 0 … dimanche = 6. */
export function weekdayIndex(dateStr: string): number {
  return (dateOnly(dateStr).getUTCDay() + 6) % 7;
}

/** `'09:30'` → `570` minutes depuis minuit (secondes arrondies, comme `time`). */
export function timeToMinutes(value: string): number {
  const [hours, minutes, seconds = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes) + Math.floor(Number(seconds) / 60);
}

/** `570` → `'09:30:00'` (colonne `time(6)` de Prisma). */
export function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:00`;
}

/** `time` Prisma (ancrée au 1970-01-01) → `HH:MM:SS`. */
export function formatTimeValue(value: Date | string): string {
  if (typeof value === 'string') {
    const match = /(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
    if (match) return `${match[1]}:${match[2]}:${match[3] ?? '00'}`;
    return value;
  }
  const hours = String(value.getUTCHours()).padStart(2, '0');
  const minutes = String(value.getUTCMinutes()).padStart(2, '0');
  const seconds = String(value.getUTCSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

// --- Slot generation (pur, testable sans DB) -----------------------------

/** Intervalle `[start, end]` en minutes depuis minuit local. */
export type MinuteInterval = readonly [number, number];

export interface ResolvedRange {
  /** Instant de début (UTC). */
  start: Date;
  /** Instant de fin, inclus dans le fuseau (le mur local est exactement `end`). */
  end: Date;
  state: AvailabilityState;
  professional_id: string | null;
  reason: string | null;
}

/** Tri + suppression des intervalles vides (`start < end`). */
export function sortedIntervals(intervals: readonly MinuteInterval[]): MinuteInterval[] {
  return intervals
    .filter(([start, end]) => start < end)
    .slice()
    .sort((a, b) => a[0] - b[0]);
}

/** Intersection deux à deux, comme `AvailabilityService._intersect`. */
export function intersectIntervals(
  a: readonly MinuteInterval[],
  b: readonly MinuteInterval[],
): MinuteInterval[] {
  const result: MinuteInterval[] = [];
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) {
      const start = Math.max(aStart, bStart);
      const end = Math.min(aEnd, bEnd);
      if (start < end) result.push([start, end]);
    }
  }
  return sortedIntervals(result);
}

/**
 * Découpe une journée en une séquence contiguë de plages : les intervalles
 * `open` demandés + les trous (`clinic_closed` sans professionnel, sinon
 * `professional_off`). Miroir de `_intervals_to_ranges` : la journée va de
 * `00:00` à `endOfDay` (`23:59:59` local côté appelant).
 */
export function intervalsToRanges(
  day: string,
  intervals: readonly MinuteInterval[],
  state: AvailabilityState,
  professionalId: string | null,
  makeInstant: (dateStr: string, minutes: number) => Date,
  endOfDay: Date,
): ResolvedRange[] {
  const gapState: AvailabilityState =
    professionalId !== null ? 'professional_off' : 'clinic_closed';
  const gapProfessionalId = gapState === 'clinic_closed' ? null : professionalId;
  const dayStart = makeInstant(day, 0);
  const dayEnd = endOfDay;

  const ranges: ResolvedRange[] = [];
  let cursor = dayStart;
  for (const [startMin, endMin] of intervals) {
    const start = makeInstant(day, startMin);
    const end = makeInstant(day, endMin);
    if (start.getTime() > cursor.getTime()) {
      ranges.push({
        start: cursor,
        end: start,
        state: gapState,
        professional_id: gapProfessionalId,
        reason: null,
      });
    }
    ranges.push({ start, end, state, professional_id: professionalId, reason: null });
    cursor = end;
  }

  if (cursor.getTime() < dayEnd.getTime()) {
    ranges.push({
      start: cursor,
      end: dayEnd,
      state: gapState,
      professional_id: gapProfessionalId,
      reason: null,
    });
  }
  return ranges;
}

/**
 * Fusionne les plages adjacentes de même état/professionnel/raison — les
 * journées complètes `00:00` → `23:59:59` de deux jours ouvrés consécutifs
 * n'ont pas la même seconde de fin, donc elles restent séparées, comme le
 * resolver Python.
 */
export function mergeAdjacentRanges(ranges: readonly ResolvedRange[]): ResolvedRange[] {
  if (ranges.length === 0) return [];
  const sorted = ranges.slice().sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: ResolvedRange[] = [sorted[0]!];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (
      last.end.getTime() === range.start.getTime()
      && last.state === range.state
      && last.professional_id === range.professional_id
      && last.reason === range.reason
    ) {
      merged[merged.length - 1] = {
        start: last.start,
        end: range.end,
        state: last.state,
        professional_id: last.professional_id,
        reason: last.reason,
      };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** Minutes ouvertes d'une liste de plages (arrondi bas, comme `int(...)`). */
export function openMinutes(ranges: readonly ResolvedRange[]): number {
  let total = 0;
  for (const range of ranges) {
    if (range.state === 'open') {
      total += Math.floor((range.end.getTime() - range.start.getTime()) / 60_000);
    }
  }
  return total;
}

/** Taux plafonné à 1 (0 quand le dénominateur est nul). */
export function cappedRate(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.min(numerator / denominator, 1);
}
