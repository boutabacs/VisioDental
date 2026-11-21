import { describe, expect, it } from 'vitest';

import {
  parseClinicDate,
  timeZoneOffsetMinutes,
  toClinicDateString,
  toZonedIso,
} from '../../src/lib/time';

describe('toZonedIso', () => {
  it('renders the clinic-local wall clock with its offset', () => {
    // 14:00 UTC = 09:00 à New York (EST, -05:00) en hiver.
    const date = new Date('2026-01-15T14:00:00.000Z');
    expect(toZonedIso(date, 'America/New_York')).toBe('2026-01-15T09:00:00-05:00');
  });

  it('follows daylight saving time', () => {
    const date = new Date('2026-07-15T14:00:00.000Z');
    expect(toZonedIso(date, 'America/New_York')).toBe('2026-07-15T10:00:00-04:00');
  });

  it('supports positive offsets', () => {
    const date = new Date('2026-07-15T07:00:00.000Z');
    expect(toZonedIso(date, 'Europe/Madrid')).toBe('2026-07-15T09:00:00+02:00');
  });
});

describe('parseClinicDate', () => {
  it('interprets a naive datetime as clinic-local time', () => {
    const parsed = parseClinicDate('2026-11-18T09:00:00', 'America/New_York');
    expect(parsed.toISOString()).toBe('2026-11-18T14:00:00.000Z');
  });

  it('honours an explicit offset', () => {
    const parsed = parseClinicDate('2026-11-18T09:00:00+01:00', 'America/New_York');
    expect(parsed.toISOString()).toBe('2026-11-18T08:00:00.000Z');
  });

  it('treats a date-only value as clinic-local midnight', () => {
    const parsed = parseClinicDate('2026-11-18', 'America/New_York');
    expect(parsed.toISOString()).toBe('2026-11-18T05:00:00.000Z');
  });

  it('stabilises around a DST transition', () => {
    // 02:30 n'existe pas le 8 mars 2026 à New York : l'algorithme doit
    // converger vers un instant cohérent sans boucler.
    const parsed = parseClinicDate('2026-03-08T02:30:00', 'America/New_York');
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(parsed.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
});

describe('timeZoneOffsetMinutes', () => {
  it('returns negative offsets west of UTC', () => {
    expect(timeZoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300);
  });

  it('returns zero for UTC', () => {
    expect(timeZoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'UTC')).toBe(0);
  });
});

describe('toClinicDateString', () => {
  it('extracts the clinic-local calendar day', () => {
    // 02:00 UTC le 19 = encore le 18 à New York.
    const date = new Date('2026-11-19T02:00:00Z');
    expect(toClinicDateString(date, 'America/New_York')).toBe('2026-11-18');
  });

  it('passes through date-only strings', () => {
    expect(toClinicDateString('2026-11-18', 'Europe/Madrid')).toBe('2026-11-18');
  });

  it('returns null for empty values', () => {
    expect(toClinicDateString(null, 'UTC')).toBeNull();
    expect(toClinicDateString(undefined, 'UTC')).toBeNull();
  });
});
