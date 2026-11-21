import { describe, expect, it } from 'vitest';

import {
  BUDGET_STATUSES,
  PUBLIC_REJECTION_REASONS,
  VALID_TRANSITIONS,
  addDays,
  budgetItemUpdateSchema,
  canTransition,
  centsToDecimalString,
  clinicTodayDateString,
  isExpired,
  nextBudgetNumberSequence,
  parseSort,
  phoneDigits,
  resolveSendMethod,
  serializeForJson,
  setPublicCodeSchema,
} from '../../src/modules/budget/schemas';

describe('canTransition', () => {
  it('mirrors VALID_TRANSITIONS for every status pair', () => {
    for (const from of BUDGET_STATUSES) {
      for (const to of BUDGET_STATUSES) {
        expect(canTransition(from, to)).toBe(VALID_TRANSITIONS[from]!.includes(to));
      }
    }
  });

  it('allows draft → sent / accepted / rejected / cancelled only', () => {
    expect(canTransition('draft', 'sent')).toBe(true);
    expect(canTransition('draft', 'accepted')).toBe(true);
    expect(canTransition('draft', 'expired')).toBe(false);
    expect(canTransition('draft', 'completed')).toBe(false);
  });

  it('treats completed, rejected, expired and cancelled as terminal', () => {
    for (const status of ['completed', 'rejected', 'expired', 'cancelled']) {
      expect(VALID_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('only lets accepted budgets be cancelled', () => {
    expect(canTransition('accepted', 'cancelled')).toBe(true);
    expect(canTransition('accepted', 'sent')).toBe(false);
  });

  it('rejects unknown statuses', () => {
    expect(canTransition('unknown', 'sent')).toBe(false);
  });
});

describe('isExpired / addDays', () => {
  it('expires only strictly before today', () => {
    expect(isExpired('2026-03-01', '2026-03-02')).toBe(true);
    expect(isExpired('2026-03-02', '2026-03-02')).toBe(false);
    expect(isExpired(null, '2026-03-02')).toBe(false);
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('clinicTodayDateString', () => {
  it('uses the clinic timezone, not UTC', () => {
    const instant = new Date('2026-03-01T01:00:00.000Z');
    expect(clinicTodayDateString('Europe/Madrid', instant)).toBe('2026-03-01');
    expect(clinicTodayDateString('America/New_York', instant)).toBe('2026-02-28');
    expect(clinicTodayDateString('UTC', instant)).toBe('2026-03-01');
  });
});

describe('nextBudgetNumberSequence', () => {
  it('starts at 0001 without a previous number', () => {
    expect(nextBudgetNumberSequence('PRES-2026-', null)).toBe('PRES-2026-0001');
  });

  it('increments the numeric tail', () => {
    expect(nextBudgetNumberSequence('PRES-2026-', 'PRES-2026-0041')).toBe('PRES-2026-0042');
    expect(nextBudgetNumberSequence('PRES-2026-', 'PRES-2026-9999')).toBe('PRES-2026-10000');
  });

  it('falls back to 1 on a non-numeric tail', () => {
    expect(nextBudgetNumberSequence('PRES-2026-', 'PRES-2026-AB')).toBe('PRES-2026-0001');
  });
});

describe('parseSort', () => {
  it('defaults to created_at:desc', () => {
    expect(parseSort(null)).toEqual({ field: 'created_at', direction: 'desc' });
    expect(parseSort(undefined)).toEqual({ field: 'created_at', direction: 'desc' });
    expect(parseSort('')).toEqual({ field: 'created_at', direction: 'desc' });
  });

  it('accepts whitelisted fields with optional direction', () => {
    expect(parseSort('total')).toEqual({ field: 'total', direction: 'desc' });
    expect(parseSort('total:asc')).toEqual({ field: 'total', direction: 'asc' });
    expect(parseSort('budget_number:desc')).toEqual({
      field: 'budget_number',
      direction: 'desc',
    });
  });

  it('falls back on unknown fields or directions', () => {
    expect(parseSort('payment_status:asc')).toEqual({ field: 'created_at', direction: 'desc' });
    expect(parseSort('total:sideways')).toEqual({ field: 'created_at', direction: 'desc' });
  });
});

describe('phoneDigits', () => {
  it('keeps digits only', () => {
    expect(phoneDigits('+34 612-34-56')).toBe('346123456');
    expect(phoneDigits(null)).toBe('');
  });
});

describe('resolveSendMethod', () => {
  it('prefers send_method, else maps the legacy flag', () => {
    expect(resolveSendMethod({ send_method: 'whatsapp', send_email: true })).toBe('whatsapp');
    expect(resolveSendMethod({ send_method: null, send_email: true })).toBe('email');
    expect(resolveSendMethod({ send_email: false })).toBe('manual');
  });
});

describe('serializeForJson / centsToDecimalString', () => {
  it('formats cents as a two-decimal string', () => {
    expect(centsToDecimalString(0)).toBe('0.00');
    expect(centsToDecimalString(123456)).toBe('1234.56');
    expect(centsToDecimalString(-5)).toBe('-0.05');
  });

  it('serializes dates and monetary keys, keeping nulls', () => {
    const serialized = serializeForJson(
      {
        when: new Date('2026-03-01T10:00:00.000Z'),
        total: 12345,
        note: null,
      },
      new Set(['total']),
    );
    expect(serialized).toEqual({
      when: '2026-03-01T10:00:00.000Z',
      total: '123.45',
      note: null,
    });
    expect(serializeForJson(null)).toBeNull();
  });
});

describe('schemas', () => {
  it('keeps null explicit on clearable item fields', () => {
    const parsed = budgetItemUpdateSchema.parse({ discount_value: null, notes: null });
    expect(parsed.discount_value).toBeNull();
    expect(parsed.notes).toBeNull();
  });

  it('converts item money to cents', () => {
    const parsed = budgetItemUpdateSchema.parse({ unit_price: '12.30' });
    expect(parsed.unit_price).toBe(1230);
  });

  it('rejects tooth numbers outside 11..85', () => {
    expect(budgetItemUpdateSchema.safeParse({ tooth_number: 10 }).success).toBe(false);
    expect(budgetItemUpdateSchema.safeParse({ tooth_number: 86 }).success).toBe(false);
    expect(budgetItemUpdateSchema.safeParse({ tooth_number: 11 }).success).toBe(true);
  });

  it('requires a 4-6 digit manual code', () => {
    expect(setPublicCodeSchema.safeParse({ code: '1234' }).success).toBe(true);
    expect(setPublicCodeSchema.safeParse({ code: '123456' }).success).toBe(true);
    expect(setPublicCodeSchema.safeParse({ code: '123' }).success).toBe(false);
    expect(setPublicCodeSchema.safeParse({ code: '12a4' }).success).toBe(false);
  });

  it('lists the closed public rejection reasons', () => {
    expect(PUBLIC_REJECTION_REASONS).toEqual(['price', 'time', 'second_opinion', 'other']);
  });
});
