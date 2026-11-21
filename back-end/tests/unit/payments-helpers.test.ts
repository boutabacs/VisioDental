import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  agingBucketLabel,
  allocationCreateSchema,
  budgetPaymentStatus,
  budgetPending,
  bucketStart,
  catalogName,
  clampNonNegative,
  columnDecimal,
  decimalFromUnknown,
  parseSort,
  paymentCreateSchema,
  pendingCoverage,
  ratio,
  refundCreateSchema,
  sumDecimals,
  utcDateOnly,
} from '../../src/modules/payments/schemas';

const D = (value: string) => new Prisma.Decimal(value);

const PATIENT_ID = '6f1c1d8e-1f9d-4f0e-9a1a-0b8f0b5f1e11';
const BUDGET_ID = '0b0a3a68-5c33-4dcd-a1b0-0a4c9c6b4d22';

function firstMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const issues = (error as { issues?: Array<{ message: string }> }).issues;
    if (issues && issues.length > 0) return issues[0]!.message;
    return (error as Error).message;
  }
  throw new Error('expected a throw');
}

describe('decimal helpers', () => {
  it('parses numbers and decimal strings', () => {
    expect(decimalFromUnknown(12.5)!.toString()).toBe('12.5');
    expect(decimalFromUnknown(' 10.25 ')!.toString()).toBe('10.25');
    expect(decimalFromUnknown('.5')!.toString()).toBe('0.5');
    expect(decimalFromUnknown('+3')!.toString()).toBe('3');
  });

  it('rejects non-numeric input', () => {
    expect(decimalFromUnknown('abc')).toBeNull();
    expect(decimalFromUnknown('1e3')).toBeNull();
    expect(decimalFromUnknown(Number.NaN)).toBeNull();
    expect(decimalFromUnknown(Number.POSITIVE_INFINITY)).toBeNull();
    expect(decimalFromUnknown({})).toBeNull();
    expect(decimalFromUnknown(null)).toBeNull();
  });

  it('sums exactly without float drift', () => {
    expect(sumDecimals([D('0.1'), D('0.2')]).toString()).toBe('0.3');
    expect(sumDecimals([]).toString()).toBe('0');
  });

  it('clamps negatives to zero', () => {
    expect(clampNonNegative(D('-4.2')).toString()).toBe('0');
    expect(clampNonNegative(D('4.2')).toString()).toBe('4.2');
  });

  it('ratio returns 0.0 on zero denominator', () => {
    expect(ratio(D('1'), D('0'))).toBe(0);
    expect(ratio(D('1'), D('4'))).toBe(0.25);
  });

  it('columnDecimal coerces raw SQL values', () => {
    expect(columnDecimal('12.34').toString()).toBe('12.34');
    expect(columnDecimal(null).toString()).toBe('0');
  });
});

describe('parseSort', () => {
  it('defaults to payment_date desc', () => {
    expect(parseSort(null)).toEqual({ field: 'payment_date', direction: 'desc' });
    expect(parseSort(undefined)).toEqual({ field: 'payment_date', direction: 'desc' });
  });

  it('accepts whitelisted fields and directions', () => {
    expect(parseSort('amount:asc')).toEqual({ field: 'amount', direction: 'asc' });
    expect(parseSort(' created_at : DESC ')).toEqual({ field: 'created_at', direction: 'desc' });
    expect(parseSort('created_at:')).toEqual({ field: 'created_at', direction: 'asc' });
  });

  it('rejects empty, unknown fields and bad directions', () => {
    expect(firstMessage(() => parseSort('   '))).toBe('Empty sort value');
    expect(firstMessage(() => parseSort('notes:asc'))).toBe(
      "Invalid sort field 'notes'. Allowed: ['amount', 'created_at', 'payment_date']",
    );
    expect(firstMessage(() => parseSort('amount:up'))).toBe(
      "Invalid sort direction 'up'. Use 'asc' or 'desc'.",
    );
  });
});

describe('date bucketing', () => {
  it('utcDateOnly truncates to the UTC calendar day', () => {
    expect(utcDateOnly(new Date('2026-03-04T23:59:59.999Z')).toISOString()).toBe(
      '2026-03-04T00:00:00.000Z',
    );
  });

  it('bucketStart follows Python weekday/week/month/year', () => {
    // 2026-03-04 is a Wednesday.
    const wed = new Date('2026-03-04T15:00:00.000Z');
    expect(bucketStart(wed, 'day').toISOString()).toBe('2026-03-04T00:00:00.000Z');
    expect(bucketStart(wed, 'week').toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(bucketStart(wed, 'month').toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(bucketStart(wed, 'year').toISOString()).toBe('2026-01-01T00:00:00.000Z');
    // A Sunday belongs to the week starting the previous Monday.
    expect(bucketStart(new Date('2026-03-08T00:00:00.000Z'), 'week').toISOString()).toBe(
      '2026-03-02T00:00:00.000Z',
    );
    // A Monday is its own week start.
    expect(bucketStart(new Date('2026-03-02T00:00:00.000Z'), 'week').toISOString()).toBe(
      '2026-03-02T00:00:00.000Z',
    );
  });

  it('agingBucketLabel uses the Python boundaries', () => {
    expect(agingBucketLabel(0)).toBe('0-30');
    expect(agingBucketLabel(30)).toBe('0-30');
    expect(agingBucketLabel(31)).toBe('31-60');
    expect(agingBucketLabel(60)).toBe('31-60');
    expect(agingBucketLabel(61)).toBe('61-90');
    expect(agingBucketLabel(90)).toBe('61-90');
    expect(agingBucketLabel(91)).toBe('90+');
  });
});

describe('catalogName', () => {
  it('prefers the language priority list', () => {
    expect(catalogName({ fr: 'Détartrage', es: 'Limpieza' })).toBe('Limpieza');
    expect(catalogName({ xx: 'Fallback', fr: 'Détartrage' })).toBe('Détartrage');
  });

  it('falls back to any non-empty translation, else null', () => {
    expect(catalogName({ zz: 'Only', aa: '   ' })).toBe('Only');
    expect(catalogName({ es: '   ', en: '' })).toBeNull();
    expect(catalogName(null)).toBeNull();
    expect(catalogName(['es'])).toBeNull();
  });
});

describe('budget aggregates', () => {
  it('budgetPaymentStatus mirrors collected/total', () => {
    expect(budgetPaymentStatus(D('0'), D('100'))).toBe('unpaid');
    expect(budgetPaymentStatus(D('-5'), D('100'))).toBe('unpaid');
    expect(budgetPaymentStatus(D('40'), D('100'))).toBe('partial');
    expect(budgetPaymentStatus(D('100'), D('100'))).toBe('paid');
    expect(budgetPaymentStatus(D('100'), D('0'))).toBe('partial');
  });

  it('budgetPending never goes negative', () => {
    expect(budgetPending(D('100'), D('40')).toString()).toBe('60');
    expect(budgetPending(D('100'), D('140')).toString()).toBe('0');
  });
});

describe('pendingCoverage (FIFO ledger)', () => {
  const entries = (amounts: string[]) => amounts.map((amount) => ({ amount: D(amount) }));

  it('returns everything pending when nothing is paid', () => {
    const result = pendingCoverage(entries(['10', '20']), D('0'));
    expect(result.map((r) => r.unpaid.toString())).toEqual(['10', '20']);
  });

  it('settles oldest entries first and keeps the partial remainder', () => {
    const result = pendingCoverage(entries(['10', '20', '5']), D('25'));
    expect(result.map((r) => r.unpaid.toString())).toEqual(['5', '5']);
  });

  it('fully covered ledger leaves no pending entries', () => {
    expect(pendingCoverage(entries(['10', '20']), D('30'))).toHaveLength(0);
  });

  it('surplus payment does not create negative pending', () => {
    const result = pendingCoverage(entries(['10']), D('99'));
    expect(result).toHaveLength(0);
  });

  it('ignores an exactly-settled boundary entry', () => {
    const result = pendingCoverage(entries(['10', '5']), D('10'));
    expect(result.map((r) => r.unpaid.toString())).toEqual(['5']);
  });
});

describe('allocationCreateSchema', () => {
  it('accepts a budget allocation', () => {
    const parsed = allocationCreateSchema.parse({
      target_type: 'budget',
      target_id: BUDGET_ID,
      amount: '12.50',
    });
    expect(parsed.target_id).toBe(BUDGET_ID);
    expect(parsed.amount.toString()).toBe('12.5');
  });

  it('requires target_id for budget and forbids it for on_account', () => {
    expect(
      firstMessage(() => allocationCreateSchema.parse({ target_type: 'budget', amount: '1' })),
    ).toBe("target_id is required when target_type='budget'");
    expect(
      firstMessage(() =>
        allocationCreateSchema.parse({ target_type: 'on_account', target_id: BUDGET_ID, amount: '1' }),
      ),
    ).toBe("target_id must be null when target_type='on_account'");
  });

  it('treats empty target_id as null', () => {
    const parsed = allocationCreateSchema.parse({
      target_type: 'on_account',
      target_id: '',
      amount: 3,
    });
    expect(parsed.target_id).toBeNull();
  });

  it('requires a positive amount', () => {
    expect(
      firstMessage(() =>
        allocationCreateSchema.parse({ target_type: 'on_account', target_id: null, amount: 0 }),
      ),
    ).toBe('Input should be greater than 0');
    expect(
      firstMessage(() =>
        allocationCreateSchema.parse({ target_type: 'on_account', target_id: null, amount: 'x' }),
      ),
    ).toBe('Input should be a valid decimal');
  });
});

describe('paymentCreateSchema', () => {
  const base = {
    patient_id: PATIENT_ID,
    amount: 100,
    method: 'cash',
    allocations: [{ target_type: 'budget', target_id: BUDGET_ID, amount: 100 }],
  };

  it('normalises text fields (trim, empty -> null)', () => {
    const parsed = paymentCreateSchema.parse({
      ...base,
      reference: '  REC-1 ',
      notes: '   ',
      payment_date: '2026-02-10',
    });
    expect(parsed.reference).toBe('REC-1');
    expect(parsed.notes).toBeNull();
    expect(parsed.payment_date).toBe('2026-02-10');
    expect(parsed.idempotency_key).toBeNull();
  });

  it('rejects an allocation sum mismatch with the Python message', () => {
    expect(
      firstMessage(() =>
        paymentCreateSchema.parse({
          ...base,
          allocations: [{ target_type: 'budget', target_id: BUDGET_ID, amount: 60 }],
        }),
      ),
    ).toBe('Allocations must sum to amount (100); got 60');
  });

  it('treats decimal strings as exact', () => {
    const parsed = paymentCreateSchema.parse({
      ...base,
      amount: '0.3',
      allocations: [
        { target_type: 'budget', target_id: BUDGET_ID, amount: '0.1' },
        { target_type: 'on_account', target_id: null, amount: '0.2' },
      ],
    });
    expect(parsed.amount.toString()).toBe('0.3');
  });

  it('requires at least one allocation and a positive amount', () => {
    expect(firstMessage(() => paymentCreateSchema.parse({ ...base, allocations: [] }))).toContain(
      'Too small',
    );
    expect(firstMessage(() => paymentCreateSchema.parse({ ...base, amount: -1 }))).toBe(
      'Input should be greater than 0',
    );
  });

  it('rejects malformed payment_date', () => {
    expect(
      firstMessage(() => paymentCreateSchema.parse({ ...base, payment_date: '10/02/2026' })),
    ).toBe('Input should be a valid date');
  });
});

describe('refundCreateSchema', () => {
  it('accepts a valid refund and strips the note', () => {
    const parsed = refundCreateSchema.parse({
      amount: '15',
      method: 'card',
      reason_code: 'duplicate',
      reason_note: '  double charge ',
    });
    expect(parsed.amount.toString()).toBe('15');
    expect(parsed.reason_note).toBe('double charge');
    expect(parsed.method).toBe('card');
  });

  it('rejects unknown reason codes and zero amounts', () => {
    expect(
      firstMessage(() =>
        refundCreateSchema.parse({ amount: 5, method: 'cash', reason_code: 'nope' }),
      ),
    ).toMatch(/expected one of/);
    expect(
      firstMessage(() =>
        refundCreateSchema.parse({ amount: 0, method: 'cash', reason_code: 'other' }),
      ),
    ).toBe('Input should be greater than 0');
  });
});
