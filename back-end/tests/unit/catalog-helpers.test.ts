import { describe, expect, it } from 'vitest';

import {
  SessionTemplateError,
  computeDurationSnapshot,
  formatDecimal,
  lockedFieldChanges,
  resolveSurfaceTierPrice,
  validateSessionTemplate,
} from '../../src/modules/catalog/schemas';
import { seedUuid } from '../../src/modules/catalog/seed';

describe('validateSessionTemplate', () => {
  it('is a no-op for a single-session item', () => {
    expect(() => validateSessionTemplate(100, null)).not.toThrow();
    expect(() => validateSessionTemplate(null, [])).not.toThrow();
  });

  it('requires a known item total when sessions are provided', () => {
    expect(() => validateSessionTemplate(null, [{ default_price: 10 }])).toThrow(
      new SessionTemplateError('Cannot define sessions when the item has no default_price'),
    );
  });

  it('accepts a sum equal to the total within one cent', () => {
    expect(() =>
      validateSessionTemplate(400, [{ default_price: 150 }, { default_price: 250.01 }]),
    ).not.toThrow();
    expect(() =>
      validateSessionTemplate(400, [{ default_price: '150.00' }, { default_price: '250' }]),
    ).not.toThrow();
  });

  it('rejects a sum mismatch with the Python message', () => {
    expect(() =>
      validateSessionTemplate(400, [{ default_price: 150 }, { default_price: 100 }]),
    ).toThrow('Sum of session prices (250) must equal item total (400)');
  });

  it('reads the `amount` key when `default_price` is absent', () => {
    expect(() => validateSessionTemplate(30, [{ amount: 10 }, { amount: 20 }])).not.toThrow();
  });
});

describe('formatDecimal', () => {
  it('renders limits like Python Decimal str()', () => {
    expect(formatDecimal(510.5)).toBe('510.5');
    expect(formatDecimal('80.10')).toBe('80.1');
    expect(formatDecimal(120)).toBe('120');
  });
});

describe('resolveSurfaceTierPrice', () => {
  const tiers = { '1': '60.00', '3': '110.00', '5': '135.00' };

  it('picks the highest populated tier below the count', () => {
    expect(resolveSurfaceTierPrice(tiers, 1, '0')).toBe('60.00');
    expect(resolveSurfaceTierPrice(tiers, 2, '0')).toBe('60.00');
    expect(resolveSurfaceTierPrice(tiers, 4, '0')).toBe('110.00');
    expect(resolveSurfaceTierPrice(tiers, 9, '0')).toBe('135.00');
  });

  it('falls back on an empty or unreadable map', () => {
    expect(resolveSurfaceTierPrice(null, 3, '45')).toBe('45');
    expect(resolveSurfaceTierPrice({}, 3, '45')).toBe('45');
    expect(resolveSurfaceTierPrice({ abc: '10' }, 3, '45')).toBe('45');
  });
});

describe('computeDurationSnapshot', () => {
  it('scales per-tooth strategies above one tooth', () => {
    expect(computeDurationSnapshot(30, 'per_tooth', 3)).toBe(90);
    expect(computeDurationSnapshot(30, 'per_role', 2)).toBe(60);
    expect(computeDurationSnapshot(30, 'per_tooth', 1)).toBe(30);
    expect(computeDurationSnapshot(30, 'flat', 4)).toBe(30);
    expect(computeDurationSnapshot(null, 'per_tooth', 4)).toBeNull();
  });
});

describe('lockedFieldChanges', () => {
  it('only reports structural fields whose value changes', () => {
    const current = {
      internal_code: 'CORONA-01',
      category_id: 'cat-a',
      pricing_strategy: 'flat',
      treatment_scope: 'tooth',
      is_diagnostic: false,
      requires_surfaces: false,
    };
    // Le modal renvoie tout le formulaire : rien ne change → aucun verrou.
    expect(lockedFieldChanges(current, { ...current, default_price: 99 })).toEqual([]);
    expect(
      lockedFieldChanges(current, { internal_code: 'CORONA-02', treatment_scope: 'tooth' }),
    ).toEqual(['internal_code']);
  });
});

describe('seedUuid', () => {
  it('derives stable UUID v5 identifiers', () => {
    const id = seedUuid('category', 'clinic', 'diagnostico');
    expect(id).toBe(seedUuid('category', 'clinic', 'diagnostico'));
    expect(id).not.toBe(seedUuid('category', 'clinic', 'cirugia'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
