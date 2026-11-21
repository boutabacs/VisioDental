import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  assignRoles,
  buildTeethInputs,
  computeDurationSnapshot,
  computePriceSnapshot,
  defaultSurfaces,
  getToothType,
  isValidToothNumber,
  priceDecimal,
  pyRepr,
  reconstructTeethAtDate,
  resolveClinicalType,
  resolveSurfaceTierPrice,
  toMinorUnits,
  treatmentCreateSchema,
} from '../../src/modules/odontogram/schemas';

/**
 * Port de `app/modules/catalog/pricing.py` + `odontogram/constants.py`.
 * Les attentes reprennent les valeurs du seed du cabinet de démo
 * (`surface_prices` 1-5 paliers, `pricing_config` bridge pillar/pontic).
 */

const FILLING = {
  default_price: new Prisma.Decimal('60.00'),
  pricing_strategy: 'per_surface',
  surface_prices: { '1': '60.00', '2': '85.00', '3': '110.00', '4': '125.00', '5': '135.00' },
};

describe('FDI', () => {
  it('accepts permanent and deciduous teeth only', () => {
    expect(isValidToothNumber(11)).toBe(true);
    expect(isValidToothNumber(48)).toBe(true);
    expect(isValidToothNumber(85)).toBe(true);
    expect(isValidToothNumber(49)).toBe(false);
    expect(isValidToothNumber(19)).toBe(false);
    expect(isValidToothNumber(0)).toBe(false);
  });

  it('derives the dentition', () => {
    expect(getToothType(11)).toBe('permanent');
    expect(getToothType(75)).toBe('deciduous');
    expect(() => getToothType(99)).toThrow('Invalid tooth number: 99');
  });

  it('defaults every surface to healthy', () => {
    expect(defaultSurfaces()).toEqual({ M: 'healthy', D: 'healthy', O: 'healthy', V: 'healthy', L: 'healthy' });
  });
});

describe('resolveSurfaceTierPrice', () => {
  it('picks the highest populated tier at or below the count', () => {
    expect(resolveSurfaceTierPrice(FILLING.surface_prices, 1, '0')).toBe('60.00');
    expect(resolveSurfaceTierPrice(FILLING.surface_prices, 2, '0')).toBe('85.00');
    expect(resolveSurfaceTierPrice(FILLING.surface_prices, 3, '0')).toBe('110.00');
    expect(resolveSurfaceTierPrice(FILLING.surface_prices, 5, '0')).toBe('135.00');
  });

  it('clamps above the top tier and below the first tier', () => {
    const tiers = { '1': '60.00', '3': '110.00' };
    expect(resolveSurfaceTierPrice(tiers, 9, '0')).toBe('110.00');
    expect(resolveSurfaceTierPrice(tiers, 2, '0')).toBe('60.00');
  });

  it('falls back on empty, non-object or unreadable maps', () => {
    expect(resolveSurfaceTierPrice(null, 3, '45')).toBe('45');
    expect(resolveSurfaceTierPrice({}, 3, '45')).toBe('45');
    expect(resolveSurfaceTierPrice({ abc: '10' }, 3, '45')).toBe('45');
    expect(resolveSurfaceTierPrice(['60'], 3, '45')).toBe('45');
  });
});

describe('computePriceSnapshot', () => {
  it('returns null without a default price even for global scopes', () => {
    expect(computePriceSnapshot({ default_price: null }, [])).toBeNull();
    expect(
      computePriceSnapshot({ default_price: null, pricing_strategy: 'per_tooth' }, [
        { surfaces: ['O'] },
      ]),
    ).toBeNull();
  });

  it('flat ignores tooth count and empty teeth', () => {
    const item = { default_price: '200.00', pricing_strategy: 'flat' };
    expect(computePriceSnapshot(item, [])).toBe('200.00');
    expect(computePriceSnapshot(item, [{}, {}, {}])).toBe('200.00');
    expect(computePriceSnapshot({ default_price: '200.00' }, [{}, {}])).toBe('200.00');
  });

  it('per_tooth multiplies by tooth count', () => {
    const item = { default_price: '400.00', pricing_strategy: 'per_tooth' };
    expect(computePriceSnapshot(item, [{}, {}, {}])).toBe('1200.00');
    expect(computePriceSnapshot(item, [{}])).toBe('400.00');
  });

  it('per_surface sums surfaces then reads the tier map', () => {
    expect(computePriceSnapshot(FILLING, [{ surfaces: ['O'] }])).toBe('60.00');
    expect(computePriceSnapshot(FILLING, [{ surfaces: ['M', 'D'] }])).toBe('85.00');
    // 1 + 3 surfaces = 4 → palier 4.
    expect(computePriceSnapshot(FILLING, [{ surfaces: ['O'] }, { surfaces: ['M', 'D', 'V'] }])).toBe(
      '125.00',
    );
    // 5 surfaces → 135, 6 surfaces → still 135 (clamp).
    expect(
      computePriceSnapshot(FILLING, [{ surfaces: ['M', 'D', 'O', 'V', 'L'] }, { surfaces: ['O'] }]),
    ).toBe('135.00');
  });

  it('per_surface without surfaces falls back to the base price', () => {
    // `Decimal(base)` : `Decimal('60.00')` garde ses zéros, un JSON numérique
    // (`60`) devient `'60'` — la colonne numeric(10,2) normalise les deux.
    const stringPriced = { default_price: '60.00', pricing_strategy: 'per_surface' };
    expect(computePriceSnapshot(stringPriced, [{}])).toBe('60.00');
    expect(computePriceSnapshot(stringPriced, [])).toBe('60.00');

    const numericPriced = { default_price: 60, pricing_strategy: 'per_surface' };
    expect(computePriceSnapshot(numericPriced, [{}])).toBe('60');
    expect(computePriceSnapshot(numericPriced, [])).toBe('60');
  });

  it('per_surface without a tier map keeps the legacy linear behaviour', () => {
    const item = { default_price: '45.00', pricing_strategy: 'per_surface', surface_prices: null };
    expect(computePriceSnapshot(item, [{ surfaces: ['M', 'O', 'D'] }])).toBe('135.00');
  });

  it('per_role sums the per-role prices, defaulting to base', () => {
    const bridge = {
      default_price: '500.00',
      pricing_strategy: 'per_role',
      pricing_config: { pillar: 500, pontic: 400 },
    };
    expect(
      computePriceSnapshot(bridge, [
        { role: 'pillar' },
        { role: 'pontic' },
        { role: 'pillar' },
      ]),
    ).toBe('1400');
    // Role absent du config ou rôle nul → prix de base.
    // `Decimal(base)` conserve les zéros du prix catalogue.
    expect(computePriceSnapshot(bridge, [{ role: 'cantilever' }, { role: null }])).toBe('1000.00');
  });

  it('rejects an unknown strategy like Python', () => {
    expect(() =>
      computePriceSnapshot({ default_price: '10.00', pricing_strategy: 'per_arch' }, [{}]),
    ).toThrow("Unknown pricing strategy: 'per_arch'");
  });

  it('is exact on cents (no float drift)', () => {
    const item = {
      default_price: '0.10',
      pricing_strategy: 'per_role',
      pricing_config: { pillar: 0.2 },
    };
    // `Decimal('0.2') * 10` → `'2.0'` (Python ne rajoute pas de zéros).
    expect(computePriceSnapshot(item, new Array(10).fill({ role: 'pillar' }))).toBe('2.0');
    expect(priceDecimal('2.0')?.toString()).toBe('2');
    expect(
      computePriceSnapshot(
        { default_price: '19.99', pricing_strategy: 'per_tooth' },
        [{}, {}, {}],
      ),
    ).toBe('59.97');
    // per_role additionne les paliers sans dérive binaire.
    expect(
      computePriceSnapshot(
        { default_price: '0.1', pricing_strategy: 'per_role', pricing_config: { p: 0.2 } },
        [{ role: 'p' }, { role: 'p' }, { role: 'p' }],
      ),
    ).toBe('0.6');
  });
});

describe('computeDurationSnapshot', () => {
  it('scales per-tooth strategies above one tooth', () => {
    expect(computeDurationSnapshot({ default_duration_minutes: 30, pricing_strategy: 'per_tooth' }, 3)).toBe(90);
    expect(computeDurationSnapshot({ default_duration_minutes: 30, pricing_strategy: 'per_role' }, 2)).toBe(60);
    expect(computeDurationSnapshot({ default_duration_minutes: 30, pricing_strategy: 'per_tooth' }, 1)).toBe(30);
    expect(computeDurationSnapshot({ default_duration_minutes: 30, pricing_strategy: 'flat' }, 4)).toBe(30);
    expect(computeDurationSnapshot({ default_duration_minutes: null, pricing_strategy: 'per_tooth' }, 4)).toBeNull();
  });
});

describe('price serialisation', () => {
  it('quantises to numeric(10,2) like Prisma', () => {
    expect(priceDecimal('85.005')?.toString()).toBe('85.01');
    expect(priceDecimal('85.004')?.toString()).toBe('85');
    expect(priceDecimal(null)).toBeNull();
  });

  it('converts decimal strings to exact minor units', () => {
    expect(toMinorUnits('135.00')).toBe(BigInt(13500));
    expect(toMinorUnits('0.005')).toBe(BigInt(1));
    expect(toMinorUnits('-2.5')).toBe(BigInt(-250));
  });
});

describe('resolveClinicalType', () => {
  const mapping = { odontogram_treatment_type: 'crown' };

  it('prefers the catalog mapping', () => {
    expect(resolveClinicalType(null, mapping, 'tooth')).toBe('crown');
    expect(resolveClinicalType('crown', mapping, 'tooth')).toBe('crown');
  });

  it('rejects a conflicting explicit type with the Python repr message', () => {
    expect(() => resolveClinicalType('filling_composite', mapping, 'tooth')).toThrow(
      "clinical_type='filling_composite' conflicts with catalog mapping 'crown'",
    );
    expect(pyRepr("it's")).toBe("'it\\'s'");
  });

  it('falls back to `other` for globals without mapping, else requires a type', () => {
    expect(resolveClinicalType(null, null, 'global_mouth')).toBe('other');
    expect(resolveClinicalType(null, null, 'global_arch')).toBe('other');
    expect(() => resolveClinicalType(null, null, 'tooth')).toThrow(
      'clinical_type is required when catalog item has no odontogram mapping',
    );
  });
});

describe('buildTeethInputs / assignRoles', () => {
  it('lets teeth[] win over tooth_numbers and applies common surfaces', () => {
    expect(buildTeethInputs([11, 12], null, ['O'])).toEqual([
      { tooth_number: 11, role: null, surfaces: ['O'] },
      { tooth_number: 12, role: null, surfaces: ['O'] },
    ]);
    expect(buildTeethInputs([11], [{ tooth_number: 21, surfaces: ['M'] }], ['O'])).toEqual([
      { tooth_number: 21, role: null, surfaces: ['M'] },
    ]);
  });

  it('assigns pillar/pontic to bridges (first/last = pillar), sorted', () => {
    expect(assignRoles(buildTeethInputs([36, 34, 35], null, null), 'bridge')).toEqual([
      { tooth_number: 34, role: 'pillar', surfaces: null },
      { tooth_number: 35, role: 'pontic', surfaces: null },
      { tooth_number: 36, role: 'pillar', surfaces: null },
    ]);
  });

  it('honours explicit roles and completes the rest as pontic', () => {
    const result = assignRoles(
      [
        { tooth_number: 11, role: 'pillar' },
        { tooth_number: 12, role: null },
        { tooth_number: 13, role: 'pillar' },
      ],
      'bridge',
    );
    expect(result.map((tooth) => tooth.role)).toEqual(['pillar', 'pontic', 'pillar']);
  });

  it('leaves non-bridge treatments untouched', () => {
    expect(assignRoles([{ tooth_number: 11, role: null }], 'crown')).toEqual([
      { tooth_number: 11, role: null },
    ]);
  });
});

describe('reconstructTeethAtDate', () => {
  it('replays the history in order', () => {
    const teeth = reconstructTeethAtDate([
      { tooth_number: 11, change_type: 'created', surface: null, old_condition: null, new_condition: 'healthy', notes: null },
      { tooth_number: 11, change_type: 'surface_update', surface: 'O', old_condition: 'healthy', new_condition: 'caries', notes: null },
      { tooth_number: 11, change_type: 'general_condition', surface: null, old_condition: 'healthy', new_condition: 'crown', notes: null },
      { tooth_number: 75, change_type: 'created', surface: null, old_condition: null, new_condition: 'healthy', notes: null },
    ]);
    expect(teeth).toHaveLength(2);
    expect(teeth[0]).toMatchObject({
      tooth_number: 11,
      tooth_type: 'permanent',
      general_condition: 'crown',
      surfaces: { M: 'healthy', D: 'healthy', O: 'caries', V: 'healthy', L: 'healthy' },
      is_displaced: false,
      is_rotated: false,
    });
    expect(teeth[1]).toMatchObject({ tooth_number: 75, tooth_type: 'deciduous' });
  });

  it('ignores note entries without text and unknown change types', () => {
    const [tooth] = reconstructTeethAtDate([
      { tooth_number: 11, change_type: 'note', surface: null, old_condition: null, new_condition: null, notes: null },
      { tooth_number: 11, change_type: 'weird', surface: null, old_condition: null, new_condition: 'caries', notes: null },
    ]);
    expect(tooth?.general_condition).toBe('healthy');
    expect(tooth?.notes).toBeNull();
  });
});

describe('treatmentCreateSchema', () => {
  const messages = (body: unknown): string[] => {
    const parsed = treatmentCreateSchema.safeParse(body);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
  };

  it('derives scope from the tooth count', () => {
    const single = treatmentCreateSchema.parse({ clinical_type: 'crown', tooth_numbers: [11] });
    expect(single.scope).toBe('tooth');
    const multi = treatmentCreateSchema.parse({
      clinical_type: 'filling_composite',
      tooth_numbers: [11, 12],
    });
    expect(multi.scope).toBe('multi_tooth');
  });

  it('requires an explicit scope for globals and a matching arch', () => {
    expect(messages({ clinical_type: 'crown' })).toContain(
      'scope is required for treatments with no teeth (use global_mouth or global_arch)',
    );
    expect(messages({ clinical_type: 'crown', arch: 'upper' })).toContain(
      'scope is required for treatments with no teeth (use global_mouth or global_arch)',
    );
    expect(messages({ clinical_type: 'crown', scope: 'global_arch' })).toContain(
      'arch is required when scope=global_arch',
    );
    expect(
      messages({ clinical_type: 'crown', scope: 'global_mouth', arch: 'lower' }),
    ).toContain('arch is only valid when scope=global_arch');
    expect(
      messages({ clinical_type: 'crown', scope: 'global_mouth', tooth_numbers: [11] }),
    ).toContain('scope=global_mouth must have no teeth');
  });

  it('enforces scope ↔ tooth count and atomic multi-tooth minimums', () => {
    expect(messages({ clinical_type: 'crown', scope: 'tooth', tooth_numbers: [11, 12] })).toContain(
      'scope=tooth requires exactly 1 tooth',
    );
    expect(messages({ clinical_type: 'crown', scope: 'multi_tooth', tooth_numbers: [11] })).toContain(
      'scope=multi_tooth requires at least 2 teeth',
    );
    expect(messages({ clinical_type: 'bridge', tooth_numbers: [11] })).toContain(
      'clinical_type=bridge requires at least 2 teeth',
    );
    expect(messages({ clinical_type: 'bridge', tooth_numbers: [11, 12] })).toEqual([]);
  });

  it('rejects internal and unknown types, duplicates and bad teeth', () => {
    expect(messages({ clinical_type: 'other', tooth_numbers: [11] })).toContain(
      'Invalid clinical_type: other',
    );
    expect(messages({ clinical_type: 'migrated', tooth_numbers: [11] })).toContain(
      'Invalid clinical_type: migrated',
    );
    expect(messages({ clinical_type: 'crown', tooth_numbers: [11, 11] })).toContain(
      'Duplicate tooth numbers not allowed',
    );
    expect(messages({ clinical_type: 'crown', tooth_numbers: [11, 99] })).toContain(
      'Invalid tooth number: 99',
    );
    expect(messages({ clinical_type: 'crown', teeth: [{ tooth_number: 99 }] })).toContain(
      'Invalid tooth number: 99',
    );
    expect(
      messages({
        clinical_type: 'crown',
        teeth: [{ tooth_number: 11 }, { tooth_number: 11 }],
      }),
    ).toContain('Duplicate tooth numbers in teeth[] not allowed');
  });

  it('requires a catalog item or a clinical type', () => {
    expect(messages({ tooth_numbers: [11] })).toContain(
      'Either catalog_item_id or clinical_type is required',
    );
  });

  it('validates surfaces and roles lengths', () => {
    expect(messages({ clinical_type: 'crown', tooth_numbers: [11], surfaces: ['Z'] })).toContain(
      'Invalid surface: Z. Must be one of ["M","D","O","V","L"]',
    );
    expect(
      messages({ clinical_type: 'crown', teeth: [{ tooth_number: 11, role: 'x'.repeat(21) }] }),
    ).not.toEqual([]);
  });
});
