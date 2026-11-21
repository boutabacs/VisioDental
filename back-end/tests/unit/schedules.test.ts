import { describe, expect, it } from 'vitest';

import {
  clinicOverrideSchema,
  clinicHoursUpdateSchema,
  formatDateOnly,
  formatTimeValue,
  intersectIntervals,
  intervalsToRanges,
  mergeAdjacentRanges,
  minutesToTime,
  nextDay,
  parseDateString,
  professionalOverrideSchema,
  timeToMinutes,
  weekdayIndex,
} from '../../src/modules/schedules/schemas';
import {
  bucketByClinicHour,
  dayBounds,
  endOfDay,
  pickOverride,
  resolveDay,
  safeTimeZone,
  shiftMinuteIntervals,
  toAvailabilityRangeDto,
  toClinicHoursDto,
  toProfessionalOverrideDto,
  totalMinutes,
  zonedInstant,
} from '../../src/modules/schedules/service';

/** Heure `HH:MM` → `Date` ancrée au 1970-01-01 (colonne `time(6)`). */
function t(value: string): Date {
  const [h, m] = value.split(':').map(Number);
  return new Date(Date.UTC(1970, 0, 1, h!, m ?? 0));
}

function shift(weekday: number | null, start: string, end: string) {
  return { weekday, start_time: t(start), end_time: t(end), id: '', shift_date: null } as never;
}

function override(
  startDate: string,
  endDate: string,
  kind: string,
  shifts: [string, string][] = [],
  createdAt = '2026-01-01T00:00:00Z',
) {
  return {
    start_date: new Date(`${startDate}T00:00:00Z`),
    end_date: new Date(`${endDate}T00:00:00Z`),
    kind,
    reason: kind === 'closed' || kind === 'unavailable' ? `${kind} reason` : null,
    created_at: new Date(createdAt),
    schedule_shifts: shifts.map(([start, end]) => ({
      start_time: t(start),
      end_time: t(end),
      weekday: null,
      shift_date: null,
    })),
  } as never;
}

const MADRID = 'Europe/Madrid';

describe('pure time helpers', () => {
  it('converts clock strings to minutes and back', () => {
    expect(timeToMinutes('09:30')).toBe(570);
    expect(timeToMinutes('23:59:59')).toBe(1439);
    expect(minutesToTime(570)).toBe('09:30:00');
    expect(formatTimeValue(t('23:59'))).toBe('23:59:00');
  });

  it('walks local calendar days', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    // 2026-11-16 est un lundi.
    expect(weekdayIndex('2026-11-16')).toBe(0);
    expect(weekdayIndex('2026-11-22')).toBe(6);
  });

  it('validates calendar dates like Pydantic', () => {
    expect(parseDateString('2026-02-28')).toBe('2026-02-28');
    expect(parseDateString('2026-02-28T10:00:00')).toBe('2026-02-28');
    expect(() => parseDateString('2026-02-30')).toThrow();
    expect(() => parseDateString('not-a-date')).toThrow();
    expect(formatDateOnly(new Date('2026-02-28T00:00:00Z'))).toBe('2026-02-28');
  });
});

describe('interval helpers', () => {
  it('drops empty shifts and sorts by start', () => {
    expect(
      shiftMinuteIntervals([shift(1, '16:00', '20:00'), shift(1, '09:00', '14:00'), shift(1, '10:00', '10:00')], 1),
    ).toEqual([
      [540, 840],
      [960, 1200],
    ]);
    expect(shiftMinuteIntervals([shift(1, '09:00', '14:00')], 2)).toEqual([]);
  });

  it('intersects clinic and professional windows', () => {
    expect(
      intersectIntervals(
        [
          [540, 840],
          [960, 1200],
        ],
        [
          [540, 840],
          [960, 1140],
        ],
      ),
    ).toEqual([
      [540, 840],
      [960, 1140],
    ]);
    // Aucune intersection.
    expect(intersectIntervals([[540, 600]], [[600, 700]])).toEqual([]);
  });

  it('fills gaps with clinic_closed when no professional is requested', () => {
    const ranges = intervalsToRanges(
      '2026-11-16',
      [
        [540, 840],
        [960, 1200],
      ],
      'open',
      null,
      (day, minutes) => zonedInstant(day, minutes, MADRID),
      endOfDay('2026-11-16', MADRID),
    );
    expect(ranges.map((range) => range.state)).toEqual([
      'clinic_closed',
      'open',
      'clinic_closed',
      'open',
      'clinic_closed',
    ]);
    // La journée se termine à 23:59:59 locales, comme Python.
    expect(toAvailabilityRangeDto(ranges[ranges.length - 1]!, MADRID).end).toBe(
      '2026-11-16T23:59:59+01:00',
    );
  });

  it('fills gaps with professional_off when a professional is requested', () => {
    const ranges = intervalsToRanges(
      '2026-07-15',
      [[540, 780]],
      'open',
      'pro-1',
      (day, minutes) => zonedInstant(day, minutes, MADRID),
      endOfDay('2026-07-15', MADRID),
    );
    expect(ranges[0]).toMatchObject({ state: 'professional_off', professional_id: 'pro-1' });
    expect(toAvailabilityRangeDto(ranges[1]!, MADRID)).toMatchObject({
      start: '2026-07-15T09:00:00+02:00',
      end: '2026-07-15T13:00:00+02:00',
      state: 'open',
      professional_id: 'pro-1',
    });
  });

  it('merges adjacent ranges only with identical state/owner/reason', () => {
    const mk = (start: string, end: string, state: 'open' | 'clinic_closed', reason: string | null) => ({
      start: new Date(start),
      end: new Date(end),
      state,
      professional_id: null,
      reason,
    });
    const merged = mergeAdjacentRanges([
      mk('2026-11-16T08:00:00Z', '2026-11-16T09:00:00Z', 'open', null),
      mk('2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z', 'open', null),
      mk('2026-11-16T10:00:00Z', '2026-11-16T11:00:00Z', 'open', 'holiday'),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      start: new Date('2026-11-16T08:00:00Z'),
      end: new Date('2026-11-16T10:00:00Z'),
    });
  });

  it('sums open minutes and floors partial minutes', () => {
    expect(
      totalMinutes([
        { start: new Date('2026-11-16T08:00:00Z'), end: new Date('2026-11-16T08:00:59Z') },
        { start: new Date('2026-11-16T09:00:00Z'), end: new Date('2026-11-16T10:30:00Z') },
      ]),
    ).toBe(90);
  });
});

describe('resolveDay', () => {
  const weekdayClinic = [0, 1, 2, 3, 4].flatMap((weekday) => [
    shift(weekday, '09:00', '14:00'),
    shift(weekday, '16:00', '20:00'),
  ]);

  it('is clinic_closed on a weekday without clinic hours', () => {
    const ranges = resolveDay({
      day: '2026-11-21', // samedi
      timeZone: MADRID,
      clinicShifts: weekdayClinic,
      clinicOverrides: [],
      professionalShifts: [],
      professionalOverrides: [],
      professionalId: null,
    });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ state: 'clinic_closed', professional_id: null, reason: null });
    expect(toAvailabilityRangeDto(ranges[0]!, MADRID)).toMatchObject({
      start: '2026-11-21T00:00:00+01:00',
      end: '2026-11-21T23:59:59+01:00',
    });
  });

  it('uses an open clinic override instead of the weekly template', () => {
    const ranges = resolveDay({
      day: '2026-11-21',
      timeZone: MADRID,
      clinicShifts: weekdayClinic,
      clinicOverrides: [override('2026-11-21', '2026-11-21', 'custom_hours', [['10:00', '12:00']])],
      professionalShifts: [],
      professionalOverrides: [],
      professionalId: null,
    });
    const open = ranges.filter((range) => range.state === 'open');
    expect(open).toHaveLength(1);
    expect(toAvailabilityRangeDto(open[0]!, MADRID)).toMatchObject({
      start: '2026-11-21T10:00:00+01:00',
      end: '2026-11-21T12:00:00+01:00',
    });
  });

  it('closes the whole day with the override reason', () => {
    const ranges = resolveDay({
      day: '2026-12-25',
      timeZone: MADRID,
      clinicShifts: weekdayClinic,
      clinicOverrides: [override('2026-12-24', '2026-12-26', 'closed')],
      professionalShifts: [],
      professionalOverrides: [],
      professionalId: null,
    });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ state: 'clinic_closed', reason: 'closed reason' });
  });

  it('intersects the professional weekly template with clinic hours', () => {
    const ranges = resolveDay({
      day: '2026-11-16', // lundi
      timeZone: MADRID,
      clinicShifts: weekdayClinic,
      clinicOverrides: [],
      professionalShifts: [shift(0, '09:00', '14:00'), shift(0, '16:00', '19:00')],
      professionalOverrides: [],
      professionalId: 'pro-1',
    });
    const open = ranges.filter((range) => range.state === 'open');
    expect(open).toHaveLength(2);
    expect(toAvailabilityRangeDto(open[1]!, MADRID)).toMatchObject({
      start: '2026-11-16T16:00:00+01:00',
      end: '2026-11-16T19:00:00+01:00',
      professional_id: 'pro-1',
    });
    // L'après-midi 19:00 → 20:00 est un trou professionnel, pas une fermeture.
    expect(ranges.some((range) => range.state === 'professional_off')).toBe(true);
  });

  it('inherits clinic hours when the professional has no template', () => {
    const ranges = resolveDay({
      day: '2026-11-16',
      timeZone: MADRID,
      clinicShifts: weekdayClinic,
      clinicOverrides: [],
      professionalShifts: [],
      professionalOverrides: [],
      professionalId: 'pro-1',
    });
    expect(ranges.filter((range) => range.state === 'open')).toHaveLength(2);
    expect(ranges.filter((range) => range.state === 'professional_off')).toHaveLength(3);
  });

  it('marks the professional off for an unavailable override, even inside clinic hours', () => {
    const ranges = resolveDay({
      day: '2026-11-18',
      timeZone: MADRID,
      clinicShifts: weekdayClinic,
      clinicOverrides: [],
      professionalShifts: [shift(2, '09:00', '14:00')],
      professionalOverrides: [override('2026-11-16', '2026-11-20', 'unavailable')],
      professionalId: 'pro-1',
    });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({
      state: 'professional_off',
      professional_id: 'pro-1',
      reason: 'unavailable reason',
    });
  });

  it('treats a weekly template without the weekday as professional_off', () => {
    const ranges = resolveDay({
      day: '2026-11-20', // vendredi
      timeZone: MADRID,
      clinicShifts: weekdayClinic,
      clinicOverrides: [],
      professionalShifts: [shift(0, '09:00', '14:00')],
      professionalOverrides: [],
      professionalId: 'pro-1',
    });
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ state: 'professional_off', reason: null });
  });

  it('keeps clinic hours when the clinic override has no shifts', () => {
    const ranges = resolveDay({
      day: '2026-11-16',
      timeZone: MADRID,
      clinicShifts: weekdayClinic,
      clinicOverrides: [override('2026-11-16', '2026-11-16', 'custom_hours', [], '2026-03-01T00:00:00Z')],
      professionalShifts: [],
      professionalOverrides: [],
      professionalId: null,
    });
    // custom_hours sans shifts remplace le template → journée fermée.
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.state).toBe('clinic_closed');
  });
});

describe('pickOverride', () => {
  it('prefers the latest start_date, then the latest created_at', () => {
    const broad = override('2026-08-01', '2026-08-31', 'closed', [], '2026-01-01T00:00:00Z');
    const narrow = override('2026-08-10', '2026-08-12', 'custom_hours', [['10:00', '11:00']], '2026-01-01T00:00:00Z');
    const newer = override('2026-08-10', '2026-08-12', 'closed', [], '2026-02-01T00:00:00Z');

    expect(pickOverride([broad, narrow], '2026-08-11')).toBe(narrow);
    expect(pickOverride([narrow, newer], '2026-08-11')).toBe(newer);
    expect(pickOverride([broad], '2026-09-01')).toBeNull();
    expect(pickOverride([], '2026-08-11')).toBeNull();
  });
});

describe('analytics helpers', () => {
  it('bounds a date range in the clinic timezone', () => {
    const { lo, hi } = dayBounds('2026-07-15', '2026-07-16', MADRID);
    expect(lo.toISOString()).toBe('2026-07-14T22:00:00.000Z');
    expect(hi.toISOString()).toBe('2026-07-16T22:00:00.000Z');
  });

  it('buckets appointments by clinic-local hour, sorted', () => {
    const rows = bucketByClinicHour(
      [
        new Date('2026-11-16T08:15:00Z'), // 09:15 Madrid (CET)
        new Date('2026-11-16T08:45:00Z'), // 09:45 Madrid
        new Date('2026-11-16T15:00:00Z'), // 16:00 Madrid
        new Date('2026-07-15T06:30:00Z'), // 08:30 Madrid (CEST)
      ],
      MADRID,
    );
    expect(rows).toEqual([
      { hour: 8, appointment_count: 1 },
      { hour: 9, appointment_count: 2 },
      { hour: 16, appointment_count: 1 },
    ]);
  });

  it('normalises clock values read back from Prisma', () => {
    expect(formatTimeValue(t('09:05'))).toBe('09:05:00');
    expect(formatTimeValue('09:05:30')).toBe('09:05:30');
  });
});

describe('timezone guard', () => {
  it('falls back to Europe/Madrid on missing or invalid zones', () => {
    expect(safeTimeZone('America/New_York')).toBe('America/New_York');
    expect(safeTimeZone(null)).toBe('Europe/Madrid');
    expect(safeTimeZone('Bad/Zone')).toBe('Europe/Madrid');
  });
});

describe('validation mirrors Pydantic', () => {
  it('rejects an inverted shift', () => {
    const result = clinicHoursUpdateSchema.safeParse({
      days: [{ weekday: 1, shifts: [{ start_time: '14:00', end_time: '09:00' }] }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('end_time must be after start_time');
  });

  it('accepts an empty weekday list (cleared day)', () => {
    const result = clinicHoursUpdateSchema.safeParse({ days: [{ weekday: 6 }] });
    expect(result.success).toBe(true);
    expect(result.data?.days[0]?.shifts).toEqual([]);
  });

  it('rejects a weekday out of 0..6', () => {
    expect(clinicHoursUpdateSchema.safeParse({ days: [{ weekday: 7 }] }).success).toBe(false);
  });

  it('enforces override date order and kind/shifts coherence', () => {
    const base = { start_date: '2026-08-01', end_date: '2026-08-14', reason: null };
    expect(
      clinicOverrideSchema.safeParse({ ...base, end_date: '2026-07-31', kind: 'closed', shifts: [] })
        .error?.issues[0]?.message,
    ).toBe('end_date must be on or after start_date');
    expect(
      clinicOverrideSchema.safeParse({ ...base, kind: 'custom_hours', shifts: [] }).error?.issues[0]
        ?.message,
    ).toBe('custom_hours overrides require at least one shift');
    expect(
      clinicOverrideSchema.safeParse({
        ...base,
        kind: 'closed',
        shifts: [{ start_time: '09:00', end_time: '10:00' }],
      }).error?.issues[0]?.message,
    ).toBe('closed overrides must have no shifts');
    expect(
      professionalOverrideSchema.safeParse({
        ...base,
        kind: 'unavailable',
        shifts: [{ start_time: '09:00', end_time: '10:00' }],
      }).error?.issues[0]?.message,
    ).toBe('unavailable overrides must have no shifts');
    expect(
      professionalOverrideSchema.safeParse({ ...base, kind: 'unavailable', shifts: [] }).success,
    ).toBe(true);
  });
});

describe('response mappers', () => {
  it('renders seven weekday buckets with sorted shifts', () => {
    const dto = toClinicHoursDto(
      {
        id: 'w1',
        clinic_id: 'c1',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
        schedule_shifts: [
          { id: 's2', weekday: 0, start_time: t('16:00'), end_time: t('20:00') },
          { id: 's1', weekday: 0, start_time: t('09:00'), end_time: t('14:00') },
          { id: 's3', weekday: null, start_time: t('09:00'), end_time: t('10:00') },
        ],
      } as never,
      MADRID,
    );
    expect(dto.days).toHaveLength(7);
    expect(dto.days[0]?.shifts.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(dto.days[1]?.shifts).toEqual([]);
    expect(dto.timezone).toBe('Europe/Madrid');
  });

  it('renders an override with its anchors and sorted shifts', () => {
    const dto = toProfessionalOverrideDto(
      {
        id: 'o1',
        clinic_id: 'c1',
        user_id: 'u1',
        start_date: new Date('2026-08-03T00:00:00Z'),
        end_date: new Date('2026-08-14T00:00:00Z'),
        kind: 'custom_hours',
        reason: 'training',
        created_at: new Date(),
        updated_at: new Date(),
        schedule_shifts: [
          { id: 'b', start_time: t('16:00'), end_time: t('18:00') },
          { id: 'a', start_time: t('09:00'), end_time: t('12:00') },
        ],
      } as never,
    );
    expect(dto).toMatchObject({
      user_id: 'u1',
      start_date: '2026-08-03',
      end_date: '2026-08-14',
      kind: 'custom_hours',
      reason: 'training',
    });
    expect(dto.shifts.map((s) => s.id)).toEqual(['a', 'b']);
  });
});
