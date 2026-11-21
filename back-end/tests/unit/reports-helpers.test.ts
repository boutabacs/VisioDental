import { describe, expect, it } from 'vitest';

import {
  addDays,
  ageBandLabel,
  agingBucketLabel,
  clinicDayStart,
  clinicToday,
  csvCell,
  csvField,
  csvLine,
  dateOnly,
  formatDateOnly,
  isDateOnly,
  missingNumbers,
  monthKey,
  nullableRate,
  periodBounds,
  punctualityBucket,
  pyRound,
  rate,
  sortAreasByCount,
  sortedGenderEntries,
  validateAnalyticsRange,
  vatName,
  waitingBucket,
} from '../../src/modules/reports/schemas';
import { percentileCont } from '../../src/modules/reports/service';

describe('dates', () => {
  it('accepte uniquement des dates réelles', () => {
    expect(isDateOnly('2026-02-28')).toBe(true);
    expect(isDateOnly('2026-02-30')).toBe(false);
    expect(isDateOnly('2026-2-3')).toBe(false);
    expect(isDateOnly('2026-02-28T00:00:00')).toBe(false);
  });

  it('round-trip date-only', () => {
    expect(formatDateOnly(dateOnly('2026-03-17'))).toBe('2026-03-17');
    expect(monthKey(dateOnly('2026-03-17'))).toBe('2026-03');
  });

  it('clinicToday suit le fuseau de la clinique', () => {
    // 23:30 UTC le 31 mars = 01:30 le 1er avril à Madrid.
    expect(formatDateOnly(clinicToday('Europe/Madrid', new Date('2026-03-31T23:30:00Z')))).toBe(
      '2026-04-01',
    );
    // 03:00 UTC le 1er avril = 23:00 le 31 mars à New York.
    expect(
      formatDateOnly(clinicToday('America/New_York', new Date('2026-04-01T03:00:00Z'))),
    ).toBe('2026-03-31');
  });

  it('clinicDayStart = minuit local (pas UTC)', () => {
    expect(clinicDayStart('2026-01-15', 'America/New_York').toISOString()).toBe(
      '2026-01-15T05:00:00.000Z',
    );
    expect(clinicDayStart('2026-07-15', 'America/New_York').toISOString()).toBe(
      '2026-07-15T04:00:00.000Z',
    );
  });

  it('periodBounds : fenêtre naïve UTC ou locale inclusive', () => {
    const naive = periodBounds(dateOnly('2026-01-01'), dateOnly('2026-01-31'), null);
    expect(naive.start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(naive.end.toISOString()).toBe('2026-01-31T23:59:59.999Z');

    const local = periodBounds(dateOnly('2026-01-01'), dateOnly('2026-01-31'), 'Europe/Madrid');
    expect(local.start.toISOString()).toBe('2025-12-31T23:00:00.000Z');
    expect(local.end.toISOString()).toBe('2026-01-31T23:00:00.000Z');
  });

  it('addDays traverse les mois', () => {
    expect(formatDateOnly(addDays(dateOnly('2026-01-31'), 1))).toBe('2026-02-01');
  });

  it('validateAnalyticsRange reprend les messages Python', () => {
    expect(() => validateAnalyticsRange(dateOnly('2026-02-01'), dateOnly('2026-01-01'))).toThrow(
      'date_to must be on or after date_from',
    );
    expect(() => validateAnalyticsRange(dateOnly('2025-01-01'), dateOnly('2026-01-02'))).toThrow(
      'date range exceeds 365 days',
    );
    expect(() =>
      validateAnalyticsRange(dateOnly('2025-01-01'), dateOnly('2026-01-01')),
    ).not.toThrow();
  });
});

describe('arrondis façon Python', () => {
  it('pyRound : half-even', () => {
    expect(pyRound(0.5)).toBe(0);
    expect(pyRound(1.5)).toBe(2);
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(66.65, 1)).toBe(66.6);
    expect(pyRound(66.66, 1)).toBe(66.7);
    expect(pyRound(1 / 3, 1)).toBe(0.3);
    expect(pyRound(-0.5)).toBe(0);
    expect(pyRound(0.25, 1)).toBe(0.2);
    expect(pyRound(1.25, 1)).toBe(1.2);
  });

  it('rate / nullableRate', () => {
    expect(rate(1, 3)).toBe(33.3);
    expect(rate(2, 0)).toBe(0);
    expect(nullableRate(2, 0)).toBeNull();
    expect(nullableRate(0, 4)).toBe(0);
  });
});

describe('buckets', () => {
  it('tranches d’âge', () => {
    expect(ageBandLabel(0)).toBe('0-17');
    expect(ageBandLabel(17)).toBe('0-17');
    expect(ageBandLabel(18)).toBe('18-34');
    expect(ageBandLabel(74)).toBe('55-74');
    expect(ageBandLabel(75)).toBe('75+');
    expect(ageBandLabel(-1)).toBe('unknown');
  });

  it('antigüedad ancrée sur l’échéance', () => {
    const today = dateOnly('2026-04-10');
    expect(agingBucketLabel(null, today)).toBe('0-30');
    expect(agingBucketLabel(dateOnly('2026-04-11'), today)).toBe('not_due');
    expect(agingBucketLabel(dateOnly('2026-04-10'), today)).toBe('0-30');
    expect(agingBucketLabel(dateOnly('2026-03-11'), today)).toBe('0-30');
    expect(agingBucketLabel(dateOnly('2026-03-10'), today)).toBe('31-60');
    expect(agingBucketLabel(dateOnly('2026-01-10'), today)).toBe('61-90');
    expect(agingBucketLabel(dateOnly('2026-01-09'), today)).toBe('90+');
  });

  it('attente / ponctualité', () => {
    expect(waitingBucket(4.9)).toBe('0-5');
    expect(waitingBucket(5)).toBe('5-10');
    expect(waitingBucket(19.9)).toBe('10-20');
    expect(waitingBucket(20)).toBe('20+');
    expect(punctualityBucket(-5.1)).toBe('early');
    expect(punctualityBucket(-5)).toBe('on_time');
    expect(punctualityBucket(5)).toBe('on_time');
    expect(punctualityBucket(15)).toBe('late_short');
    expect(punctualityBucket(15.1)).toBe('late_long');
  });

  it('percentile_cont interpole', () => {
    expect(percentileCont([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentileCont([10], 0.9)).toBe(10);
    expect(percentileCont([1, 2], 0.9)).toBeCloseTo(1.9, 10);
  });
});

describe('divers', () => {
  it('missingNumbers liste les trous depuis 1', () => {
    expect(missingNumbers([1, 2, 4, 7])).toEqual([3, 5, 6]);
    expect(missingNumbers([1, 2, 3])).toEqual([]);
    expect(missingNumbers([])).toEqual([]);
    expect(missingNumbers([3])).toEqual([1, 2]);
  });

  it('areas triées par count décroissant puis plafonnées', () => {
    const areas = [
      { area: 'A', count: 1 },
      { area: 'B', count: 3 },
      { area: 'C', count: 3 },
    ];
    expect(sortAreasByCount(areas, 2)).toEqual([
      { area: 'B', count: 3 },
      { area: 'C', count: 3 },
    ]);
  });

  it('genres triés par clé', () => {
    const map = new Map([
      ['other', 1],
      ['female', 2],
      ['unknown', 1],
    ]);
    expect(sortedGenderEntries(map).map((row) => row.gender)).toEqual([
      'female',
      'other',
      'unknown',
    ]);
  });

  it('nom VAT', () => {
    expect(vatName({ es: 'IVA general', en: 'General' }, 21)).toBe('IVA general');
    expect(vatName({ en: 'General' }, 10)).toBe('IVA 10%');
    expect(vatName(null, 0)).toBe('IVA 0%');
  });

  it('CSV : formule neutralisée, quoting minimal', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell(-10)).toBe(-10);
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvLine(['x', 1.5, null])).toBe('x,1.5,\r\n');
  });
});
