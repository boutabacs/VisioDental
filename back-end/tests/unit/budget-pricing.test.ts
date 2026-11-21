import { describe, expect, it } from 'vitest';

import {
  allocateGlobalDiscount,
  computeBudgetTotals,
  computeLineTotals,
  netLineAmount,
  netLineTotal,
  repricePendingSessions,
  snapshotSessions,
  type PriceLine,
} from '../../src/modules/budget/pricing';

/** Ligne simple : prix HT `subtotal`, remise de ligne laissée à 0, TTC = HT * (1+v). */
function line(subtotalCents: number, vatRate = 0, discountCents = 0): PriceLine {
  const taxable = subtotalCents - discountCents;
  return {
    lineSubtotalCents: subtotalCents,
    lineDiscountCents: discountCents,
    lineTotalCents: Math.round(taxable * (1 + vatRate / 100)),
    vatRate,
  };
}

/** 10 % exprimé comme les montants : 1000 centièmes de pourcent. */
const TEN_PERCENT = 1000;

describe('allocateGlobalDiscount', () => {
  it('returns zeros without discount or without lines', () => {
    expect(allocateGlobalDiscount(null, 1000, [line(1000)])).toEqual([0]);
    expect(allocateGlobalDiscount('percentage', null, [line(1000), line(500)])).toEqual([0, 0]);
    expect(allocateGlobalDiscount('percentage', 1000, [])).toEqual([]);
    expect(allocateGlobalDiscount('absolute', 0, [line(1000)])).toEqual([0]);
  });

  it('percentage is taken on the post-line-discount base', () => {
    const shares = allocateGlobalDiscount('percentage', TEN_PERCENT, [
      line(10000, 10, 2000),
      line(5000),
    ]);
    // (10000 - 2000) * 10% = 800 ; 5000 * 10% = 500
    expect(shares).toEqual([800, 500]);
  });

  it('absolute discount is prorated on the gross line totals and stays tax-consistent', () => {
    const items = [line(10000, 21), line(5000, 10)];
    const shares = allocateGlobalDiscount('absolute', 2000, items);
    const gross = shares.reduce((sum, share, i) => sum + share * (1 + items[i]!.vatRate / 100), 0);
    expect(Math.round(gross)).toBe(2000);
    // Le prorata suit le TTC : la ligne 6% plus chère porte la plus grosse part.
    expect(shares[0]!).toBeGreaterThan(shares[1]!);
    expect(shares[0]! + shares[1]!).toBeLessThanOrEqual(2000 + 2);
  });

  it('never discounts more than the gross total (0 or negative totals)', () => {
    const items = [line(0), line(0)];
    expect(allocateGlobalDiscount('absolute', 500, items)).toEqual([0, 0]);
  });
});

describe('netLineAmount / netLineTotal', () => {
  it('nets the line discount and the prorated global share', () => {
    const item = line(10000, 21, 1000);
    const share = allocateGlobalDiscount('percentage', TEN_PERCENT, [item])[0]!;
    // (10000 - 1000) - 900 = 8100 HT
    expect(netLineAmount(item, share)).toBe(8100);
    expect(netLineTotal(item, share)).toBe(Math.round(8100 * 1.21));
  });
});

describe('computeLineTotals', () => {
  it('percentage discount then VAT on the discounted base', () => {
    const totals = computeLineTotals({
      unitPriceCents: 10000,
      quantity: 2,
      discountType: 'percentage',
      discountValueCents: TEN_PERCENT,
      vatRate: 21,
    });
    expect(totals.lineSubtotalCents).toBe(20000);
    expect(totals.lineDiscountCents).toBe(2000);
    expect(totals.lineTaxCents).toBe(3780);
    expect(totals.lineTotalCents).toBe(21780);
  });

  it('absolute discount is capped at the line subtotal', () => {
    const totals = computeLineTotals({
      unitPriceCents: 1500,
      quantity: 1,
      discountType: 'absolute',
      discountValueCents: 5000,
      vatRate: 0,
    });
    expect(totals.lineDiscountCents).toBe(1500);
    expect(totals.lineTotalCents).toBe(0);
  });

  it('ignores the discount when only one of type/value is set', () => {
    const totals = computeLineTotals({
      unitPriceCents: 1000,
      quantity: 3,
      discountType: null,
      discountValueCents: 1000,
      vatRate: 10,
    });
    expect(totals.lineSubtotalCents).toBe(3000);
    expect(totals.lineDiscountCents).toBe(0);
    expect(totals.lineTotalCents).toBe(3300);
  });
});

describe('computeBudgetTotals', () => {
  it('sums subtotals, discounts and keeps Σ net_line_total == total', () => {
    const items = [line(10000, 21), line(5000, 10, 500), line(2500)];
    const totals = computeBudgetTotals('percentage', TEN_PERCENT, items);
    expect(totals.subtotalCents).toBe(17500);

    const shares = allocateGlobalDiscount('percentage', TEN_PERCENT, items);
    const expectedTotal = items.reduce(
      (sum, item, i) => sum + netLineTotal(item, shares[i]!),
      0,
    );
    expect(totals.totalCents).toBe(expectedTotal);
    expect(totals.totalTaxCents).toBe(
      totals.totalCents - (totals.subtotalCents - totals.totalDiscountCents),
    );
  });

  it('returns zeros for an empty budget', () => {
    expect(computeBudgetTotals('percentage', 1000, [])).toEqual({
      subtotalCents: 0,
      totalDiscountCents: 0,
      totalTaxCents: 0,
      totalCents: 0,
    });
  });
});

describe('snapshotSessions', () => {
  it('scales template prices to the accepted target, last session absorbing drift', () => {
    const sessions = snapshotSessions(
      [
        { sequence: 2, defaultPriceCents: 5000 },
        { sequence: 1, defaultPriceCents: 5000 },
      ],
      6667,
    );
    expect(sessions.map((s) => s.sequence)).toEqual([1, 2]);
    expect(sessions.reduce((sum, s) => sum + s.amountCents, 0)).toBe(6667);
  });

  it('splits evenly when the template total is zero', () => {
    const sessions = snapshotSessions(
      [
        { sequence: 1, defaultPriceCents: 0 },
        { sequence: 2, defaultPriceCents: 0 },
        { sequence: 3, defaultPriceCents: 0 },
      ],
      1000,
    );
    expect(sessions.map((s) => s.amountCents)).toEqual([333, 333, 334]);
  });

  it('returns an empty list without templates', () => {
    expect(snapshotSessions([], 1000)).toEqual([]);
  });
});

describe('repricePendingSessions', () => {
  it('keeps completed amounts, scales the pending remainder', () => {
    const rows = [
      { sequence: 1, amountCents: 3000, status: 'completed' },
      { sequence: 2, amountCents: 4000, status: 'pending' },
      { sequence: 3, amountCents: 4000, status: 'pending' },
    ];
    const repriced = repricePendingSessions(rows, 7000);
    // Reste 4000 à répartir : 2000 / 2000
    expect(repriced).toEqual([
      { sequence: 2, amountCents: 2000 },
      { sequence: 3, amountCents: 2000 },
    ]);
  });

  it('never goes negative when booked exceeds the target', () => {
    const rows = [
      { sequence: 1, amountCents: 5000, status: 'completed' },
      { sequence: 2, amountCents: 1000, status: 'pending' },
    ];
    expect(repricePendingSessions(rows, 3000)).toEqual([{ sequence: 2, amountCents: 0 }]);
  });

  it('splits evenly when pending amounts are all zero and absorbs drift', () => {
    const rows = [
      { sequence: 1, amountCents: 0, status: 'pending' },
      { sequence: 2, amountCents: 0, status: 'pending' },
      { sequence: 3, amountCents: 0, status: 'pending' },
    ];
    const repriced = repricePendingSessions(rows, 1000);
    expect(repriced.reduce((sum, s) => sum + s.amountCents, 0)).toBe(1000);
    expect(repriced[2]!.amountCents).toBe(334);
  });

  it('returns nothing when no session is pending', () => {
    expect(
      repricePendingSessions([{ sequence: 1, amountCents: 100, status: 'completed' }], 500),
    ).toEqual([]);
  });
});
