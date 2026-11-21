/**
 * Schémas et constantes du module `odontogram` — port de
 * `app/modules/odontogram/{constants,schemas,pricing}.py` ainsi que de
 * `app/modules/catalog/pricing.py` (partie consommée par les traitements).
 *
 * Les helpers purs (`isValidToothNumber`, `getToothType`, `computePriceSnapshot`,
 * `computeDurationSnapshot`, `assignRoles`, `reconstructTeethAtDate`,
 * `resolveClinicalType`…) sont exportés pour être testés sans base.
 */

import { Prisma } from '@prisma/client';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// FDI
// ---------------------------------------------------------------------------

/** Dents permanentes (quadrants 1-4). */
export const PERMANENT_TEETH: readonly number[] = [
  // Quadrant 1 (upper right)
  18, 17, 16, 15, 14, 13, 12, 11,
  // Quadrant 2 (upper left)
  21, 22, 23, 24, 25, 26, 27, 28,
  // Quadrant 3 (lower left)
  38, 37, 36, 35, 34, 33, 32, 31,
  // Quadrant 4 (lower right)
  41, 42, 43, 44, 45, 46, 47, 48,
];

/** Dents temporaires (quadrants 5-8). */
export const DECIDUOUS_TEETH: readonly number[] = [
  // Quadrant 5 (upper right)
  55, 54, 53, 52, 51,
  // Quadrant 6 (upper left)
  61, 62, 63, 64, 65,
  // Quadrant 7 (lower left)
  75, 74, 73, 72, 71,
  // Quadrant 8 (lower right)
  81, 82, 83, 84, 85,
];

export const ALL_TEETH: readonly number[] = [...PERMANENT_TEETH, ...DECIDUOUS_TEETH];

const PERMANENT_SET = new Set(PERMANENT_TEETH);
const DECIDUOUS_SET = new Set(DECIDUOUS_TEETH);

export type ToothType = 'permanent' | 'deciduous';

/** `constants.is_valid_tooth_number`. */
export function isValidToothNumber(toothNumber: number): boolean {
  return PERMANENT_SET.has(toothNumber) || DECIDUOUS_SET.has(toothNumber);
}

/** `constants.get_tooth_type` — lève hors notation FDI. */
export function getToothType(toothNumber: number): ToothType {
  if (PERMANENT_SET.has(toothNumber)) return 'permanent';
  if (DECIDUOUS_SET.has(toothNumber)) return 'deciduous';
  throw new Error(`Invalid tooth number: ${toothNumber}`);
}

// ---------------------------------------------------------------------------
// Surfaces / conditions / scopes
// ---------------------------------------------------------------------------

export const SURFACES = ['M', 'D', 'O', 'V', 'L'] as const;

/** Surfaces par défaut d'un enregistrement de dent (port de `_default_surfaces`). */
export function defaultSurfaces(): Record<string, string> {
  return { M: 'healthy', D: 'healthy', O: 'healthy', V: 'healthy', L: 'healthy' };
}

export const TOOTH_CONDITIONS = [
  'healthy',
  'caries',
  'filling',
  'crown',
  'missing',
  'root_canal',
  'implant',
  'extraction_indicated',
  'sealant',
  'fracture',
] as const;

export const CONDITION_COLORS: Record<string, string> = {
  healthy: '#FFFFFF',
  caries: '#EF4444',
  filling: '#3B82F6',
  crown: '#F59E0B',
  missing: '#9CA3AF',
  root_canal: '#8B5CF6',
  implant: '#10B981',
  extraction_indicated: '#DC2626',
  sealant: '#06B6D4',
  fracture: '#BE185D',
};

export const TREATMENT_STATUSES = ['planned', 'performed'] as const;

export const TREATMENT_SCOPES = ['tooth', 'multi_tooth', 'global_mouth', 'global_arch'] as const;

export const ARCHES = ['upper', 'lower'] as const;

/** `constants.TreatmentType` — valeurs acceptées explicitement par l'API. */
export const TREATMENT_TYPES = [
  // Diagnóstico
  'pulpitis',
  'caries',
  'incipient_caries',
  'pigmentation',
  'fracture',
  'missing',
  'periapical_small',
  'periapical_medium',
  'periapical_large',
  'rotated',
  'displaced',
  'unerupted',
  // Restauradora
  'filling_composite',
  'filling_amalgam',
  'filling_temporary',
  'sealant',
  'veneer',
  'inlay',
  'overlay',
  'crown',
  'crown_on_implant',
  'provisional_crown_on_implant',
  'bridge',
  'splint',
  // Cirugía
  'extraction',
  'implant',
  'apicoectomy',
  // Endodoncia
  'root_canal_full',
  'root_canal_two_thirds',
  'root_canal_half',
  'post',
  'root_canal_overfill',
  // Ortodoncia
  'bracket',
  'tube',
  'band',
  'attachment',
  'retainer',
] as const;

/** Traitements « atomiques » multi-dents (bridge, splint) : ≥ 2 dents. */
export const ATOMIC_MULTI_TOOTH_TYPES: ReadonlySet<string> = new Set(['bridge', 'splint']);

/** Types internes jamais acceptés en entrée (`other`, `migrated`). */
export const INTERNAL_CLINICAL_TYPES: ReadonlySet<string> = new Set(['other', 'migrated']);

// ---------------------------------------------------------------------------
// Validation (helpers purs)
// ---------------------------------------------------------------------------

export class OdontogramValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OdontogramValidationError';
  }
}

/** `SurfaceUpdate.validate_surface` — message repris mot pour mot. */
export function assertValidSurface(surface: string): string {
  if (!(SURFACES as readonly string[]).includes(surface)) {
    throw new OdontogramValidationError(
      `Invalid surface: ${surface}. Must be one of ${JSON.stringify([...SURFACES])}`,
    );
  }
  return surface;
}

/** `SurfaceUpdate.validate_condition`. */
export function assertValidCondition(condition: string): string {
  if (!(TOOTH_CONDITIONS as readonly string[]).includes(condition)) {
    throw new OdontogramValidationError(
      `Invalid condition: ${condition}. Must be one of ${JSON.stringify([...TOOTH_CONDITIONS])}`,
    );
  }
  return condition;
}

// ---------------------------------------------------------------------------
// Pricing (port de `app/modules/catalog/pricing.py`)
// ---------------------------------------------------------------------------

/** Dent réduite aux champs utiles au calcul (`PricingTooth`). */
export interface PricingTooth {
  role?: string | null;
  surfaces?: readonly string[] | null;
}

/** Champs du catalogue consommés par le calcul (sous-ensemble de la ligne). */
export interface PricingCatalogItem {
  default_price: unknown; // Prisma.Decimal | number | string | null
  pricing_strategy?: string | null;
  surface_prices?: unknown;
  pricing_config?: unknown;
  default_duration_minutes?: number | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Représentation « brutes » d'un montant : `Decimal.toString()` ou nombre. */
function decimalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'bigint') return value.toString();
  // Prisma.Decimal / Decimal.js : `toString()` renvoie la valeur exacte
  // (jamais la notation exponentielle).
  const maybe = value as { toString?: () => string };
  if (typeof maybe.toString === 'function') return maybe.toString();
  return null;
}

/**
 * Addition en précision exacte (décimales en chaîne). Source de vérité pour
 * les sommes de prix ; l'appelant convertit ensuite en `Prisma.Decimal`.
 */
function addDecimals(values: readonly string[]): string {
  let scale = 0;
  for (const value of values) {
    const dot = value.indexOf('.');
    if (dot >= 0) scale = Math.max(scale, value.length - dot - 1);
  }
  const toMinor = (value: string): bigint => {
    const negative = value.startsWith('-');
    const digits = negative ? value.slice(1) : value;
    const [whole = '0', frac = ''] = digits.split('.');
    const scaled = `${whole}${frac.padEnd(scale, '0')}`.replace(/^0+(?=\d)/, '');
    const big = BigInt(scaled || '0');
    return negative ? -big : big;
  };
  const total = values.reduce((sum, value) => sum + toMinor(value), BigInt(0));
  const negative = total < BigInt(0);
  const text = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const whole = text.slice(0, text.length - scale) || '0';
  const frac = scale > 0 ? text.slice(text.length - scale) : '';
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

function multiplyDecimal(value: string, factor: number): string {
  if (factor === 0) return '0';
  const negative = value.startsWith('-');
  const digits = (negative ? value.slice(1) : value).replace('.', '');
  const scale = (value.split('.')[1] ?? '').length;
  const scaled = BigInt(digits || '0') * BigInt(factor);
  const text = scaled.toString().padStart(scale + 1, '0');
  const whole = text.slice(0, text.length - scale) || '0';
  const frac = scale > 0 ? text.slice(text.length - scale) : '';
  return `${negative && scaled !== BigInt(0) ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Prix du palier de surfaces : plus haut palier ≤ `count`, sinon le plus petit
 * (`_resolve_surface_tier_price`). `fallback` si la carte est vide/illisible.
 */
export function resolveSurfaceTierPrice(
  surfacePrices: unknown,
  surfaceCount: number,
  fallback: string,
): string {
  if (!isPlainRecord(surfacePrices)) return fallback;
  const entries = Object.entries(surfacePrices);
  if (entries.length === 0) return fallback;

  const keys: number[] = [];
  for (const [key] of entries) {
    const parsed = Number(key);
    if (!Number.isInteger(parsed)) return fallback;
    keys.push(parsed);
  }
  keys.sort((a, b) => a - b);

  let tier = keys[0]!;
  for (const key of keys) {
    if (key <= surfaceCount) tier = key;
    else break;
  }
  const raw = surfacePrices[String(tier)];
  if (raw === null || raw === undefined) return fallback;
  return decimalString(raw) ?? fallback;
}

/**
 * `compute_price_snapshot` : prix d'un traitement construit sur cet item.
 * `null` quand l'item n'a pas de `default_price`.
 */
export function computePriceSnapshot(
  catalogItem: PricingCatalogItem,
  teeth: readonly PricingTooth[],
): string | null {
  const base = decimalString(catalogItem.default_price);
  if (base === null) return null;

  const strategy = catalogItem.pricing_strategy || 'flat';

  if (strategy === 'flat' || teeth.length === 0) return base;

  if (strategy === 'per_tooth') return multiplyDecimal(base, teeth.length);

  if (strategy === 'per_surface') {
    const surfaceCount = teeth.reduce((sum, tooth) => sum + (tooth.surfaces?.length ?? 0), 0);
    if (surfaceCount === 0) return base;
    const surfacePrices = catalogItem.surface_prices;
    if (isPlainRecord(surfacePrices) && Object.keys(surfacePrices).length > 0) {
      return resolveSurfaceTierPrice(surfacePrices, surfaceCount, base);
    }
    return multiplyDecimal(base, surfaceCount);
  }

  if (strategy === 'per_role') {
    const config = isPlainRecord(catalogItem.pricing_config) ? catalogItem.pricing_config : {};
    const parts: string[] = [];
    for (const tooth of teeth) {
      const rolePrice =
        tooth.role !== null && tooth.role !== undefined ? config[tooth.role] : undefined;
      const part = decimalString(rolePrice);
      parts.push(part ?? base);
    }
    return addDecimals(parts.length > 0 ? parts : ['0']);
  }

  // Python : `raise ValueError(f"Unknown pricing strategy: {strategy!r}")`.
  throw new OdontogramValidationError(`Unknown pricing strategy: ${pyRepr(strategy)}`);
}

/** `compute_duration_snapshot` (minutes). */
export function computeDurationSnapshot(
  catalogItem: Pick<PricingCatalogItem, 'default_duration_minutes' | 'pricing_strategy'>,
  teethCount: number,
): number | null {
  const duration = catalogItem.default_duration_minutes;
  if (duration === null || duration === undefined) return null;
  const strategy = catalogItem.pricing_strategy || 'flat';
  if ((strategy === 'per_tooth' || strategy === 'per_role') && teethCount > 1) {
    return duration * teethCount;
  }
  return duration;
}

/**
 * Montant décimal (chaîne) → colonne `numeric(10,2)` (BigInt en centimes).
 * Arrondi half-up sur le troisième chiffre, comme Postgres/Prisma.
 */
export function toMinorUnits(value: string): bigint {
  const negative = value.trim().startsWith('-');
  const [whole = '0', frac = ''] = value.trim().replace('-', '').split('.');
  const padded = frac.padEnd(3, '0');
  const cents = Number(padded.slice(0, 2));
  const third = Number(padded[2] ?? '0');
  const minor = BigInt(whole || '0') * BigInt(100) + BigInt(cents + (third >= 5 ? 1 : 0));
  return negative ? -minor : minor;
}

/** Prix (chaîne décimale) → `Prisma.Decimal` quantize 2, `null` si non numérique. */
export function priceDecimal(value: string | null | undefined): Prisma.Decimal | null {
  if (value === null || value === undefined) return null;
  try {
    return new Prisma.Decimal(value).toDecimalPlaces(2);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Résolution du type clinique et des rôles (helpers purs)
// ---------------------------------------------------------------------------

export interface ClinicalTypeMapping {
  odontogram_treatment_type: string;
}

/**
 * `TreatmentService._resolve_clinical_type` : le mapping catalogue gagne ; les
 * traitements globaux sans mapping tombent sur `other`.
 */
export function resolveClinicalType(
  explicit: string | null | undefined,
  mapping: ClinicalTypeMapping | null,
  scope: string,
): string {
  if (mapping !== null) {
    if (explicit && explicit !== mapping.odontogram_treatment_type) {
      // `{explicit!r}` / `{type!r}` = repr Python (guillemets simples).
      throw new OdontogramValidationError(
        `clinical_type=${pyRepr(explicit)} conflicts with catalog mapping ${pyRepr(
          mapping.odontogram_treatment_type,
        )}`,
      );
    }
    return mapping.odontogram_treatment_type;
  }
  if (explicit === null || explicit === undefined) {
    if (scope === 'global_mouth' || scope === 'global_arch') return 'other';
    throw new OdontogramValidationError(
      'clinical_type is required when catalog item has no odontogram mapping',
    );
  }
  return explicit;
}

/** `repr()` Python pour les chaînes (guillemets simples, échappements usuels). */
export function pyRepr(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `'${escaped}'`;
}

export interface ToothInput {
  tooth_number: number;
  role?: string | null;
  surfaces?: readonly string[] | null;
}

/** `_build_teeth_inputs` : `teeth[]` prime, sinon `tooth_numbers` + surfaces communes. */
export function buildTeethInputs(
  toothNumbers: readonly number[],
  teeth: readonly ToothInput[] | null | undefined,
  commonSurfaces: readonly string[] | null | undefined,
): ToothInput[] {
  if (teeth && teeth.length > 0) {
    return teeth.map((tooth) => ({
      tooth_number: tooth.tooth_number,
      role: tooth.role ?? null,
      surfaces: tooth.surfaces !== null && tooth.surfaces !== undefined
        ? tooth.surfaces
        : (commonSurfaces ?? null),
    }));
  }
  return toothNumbers.map((toothNumber) => ({
    tooth_number: toothNumber,
    role: null,
    surfaces: commonSurfaces ?? null,
  }));
}

/**
 * `_assign_roles` : pour les bridges, respecte les rôles fournis (complète en
 * `pontic`), sinon premier/dernier = pillar, milieu = pontic. Exige ≥ 1 pillar.
 * Trie les dents par numéro (comme Python) avant de renvoyer.
 */
export function assignRoles(teethInputs: readonly ToothInput[], clinicalType: string): ToothInput[] {
  if (clinicalType !== 'bridge') return teethInputs.map((tooth) => ({ ...tooth }));

  const sorted = [...teethInputs].sort((a, b) => a.tooth_number - b.tooth_number);
  const hasExplicit = sorted.some(
    (tooth) => tooth.role === 'pillar' || tooth.role === 'pontic',
  );

  if (hasExplicit) {
    for (const tooth of sorted) {
      if (tooth.role !== 'pillar' && tooth.role !== 'pontic') tooth.role = 'pontic';
    }
  } else {
    const first = sorted[0]?.tooth_number;
    const last = sorted[sorted.length - 1]?.tooth_number;
    for (const tooth of sorted) {
      tooth.role =
        tooth.tooth_number === first || tooth.tooth_number === last ? 'pillar' : 'pontic';
    }
  }

  if (!sorted.some((tooth) => tooth.role === 'pillar')) {
    throw new OdontogramValidationError('bridge requires at least one pillar tooth');
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Reconstruction historique (pur)
// ---------------------------------------------------------------------------

export interface HistoryEntryLike {
  tooth_number: number;
  change_type: string;
  surface: string | null;
  old_condition: string | null;
  new_condition: string | null;
  notes: string | null;
}

export interface HistoricalToothState {
  tooth_number: number;
  tooth_type: ToothType;
  general_condition: string;
  surfaces: Record<string, string>;
  notes: string | null;
  is_displaced: boolean;
  is_rotated: boolean;
}

/**
 * `get_odontogram_at_date` — rejoue l'historique (ordre chronologique) pour
 * reconstruire l'état de chaque dent à la date demandée.
 */
export function reconstructTeethAtDate(
  entries: readonly HistoryEntryLike[],
): HistoricalToothState[] {
  const state = new Map<number, HistoricalToothState>();
  const ordered = [...entries].sort((a, b) => a.tooth_number - b.tooth_number);

  for (const entry of ordered) {
    const toothNumber = entry.tooth_number;
    let tooth = state.get(toothNumber);
    if (!tooth) {
      tooth = {
        tooth_number: toothNumber,
        tooth_type: toothNumber < 50 ? 'permanent' : 'deciduous',
        general_condition: 'healthy',
        surfaces: defaultSurfaces(),
        notes: null,
        is_displaced: false,
        is_rotated: false,
      };
      state.set(toothNumber, tooth);
    }
    if (entry.change_type === 'created' && entry.new_condition) {
      tooth.general_condition = entry.new_condition;
    } else if (entry.change_type === 'general_condition' && entry.new_condition) {
      tooth.general_condition = entry.new_condition;
    } else if (entry.change_type === 'surface_update' && entry.surface && entry.new_condition) {
      tooth.surfaces[entry.surface] = entry.new_condition;
    } else if (entry.change_type === 'note' && entry.notes) {
      tooth.notes = entry.notes;
    }
  }

  // `Map` conserve l'ordre d'insertion (première apparition dans l'historique),
  // exactement comme le dict Python.
  return [...state.values()];
}

// ---------------------------------------------------------------------------
// Schémas Zod des requêtes
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

/** Liste de surfaces validée (message Pydantic `Invalid surface: …`). */
function surfaceList() {
  return z
    .array(z.string())
    .superRefine((values, ctx) => {
      for (const value of values) {
        if (!(SURFACES as readonly string[]).includes(value)) {
          ctx.addIssue({
            code: 'custom',
            message: `Invalid surface: ${value}. Must be one of ${JSON.stringify([...SURFACES])}`,
          });
        }
      }
    });
}

/**
 * `TreatmentCreate.validate_shape` — modèle après résolution, exporté pour
 * les tests (le router n'utilise que `treatmentCreateSchema`).
 */
export const treatmentShapeSchema = z
  .object({
    catalog_item_id: uuid.nullable(),
    clinical_type: z.string().nullable(),
    /**
     * Résolu : si la requête l'omet et qu'il y a des dents, il est déduit
     * (1 → `tooth`, 2+ → `multi_tooth`). Les traitements globaux doivent
     * le fournir explicitement.
     */
    scope: z.enum(TREATMENT_SCOPES).nullable(),
    arch: z.enum(ARCHES).nullable(),
    tooth_numbers: z.array(z.number().int()),
    teeth: z
      .array(
        z.object({
          tooth_number: z.number().int(),
          role: z.string().max(20).nullable(),
          surfaces: surfaceList().nullable(),
        }),
      )
      .nullable(),
    surfaces: surfaceList().nullable(),
    status: z.enum(TREATMENT_STATUSES),
    notes: z.string().nullable(),
    budget_item_id: uuid.nullable(),
    source_module: z.string(),
  })
  .superRefine((data, ctx) => {
    const teeth = data.teeth ?? null;
    if (teeth && teeth.length > 0) {
      const numbers = teeth.map((tooth) => tooth.tooth_number);
      for (const number of numbers) {
        if (!isValidToothNumber(number)) {
          ctx.addIssue({ code: 'custom', message: `Invalid tooth number: ${number}` });
        }
      }
      if (numbers.length !== new Set(numbers).size) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate tooth numbers in teeth[] not allowed' });
      }
    }

    const count = teeth && teeth.length > 0 ? teeth.length : data.tooth_numbers.length;

    let scope = data.scope;
    if (scope === null) {
      if (count === 0) {
        ctx.addIssue({
          code: 'custom',
          message:
            'scope is required for treatments with no teeth (use global_mouth or global_arch)',
        });
        return;
      }
      scope = count === 1 ? 'tooth' : 'multi_tooth';
    }

    if (scope === 'tooth' && count !== 1) {
      ctx.addIssue({ code: 'custom', message: 'scope=tooth requires exactly 1 tooth' });
    }
    if (scope === 'multi_tooth' && count < 2) {
      ctx.addIssue({ code: 'custom', message: 'scope=multi_tooth requires at least 2 teeth' });
    }
    if ((scope === 'global_mouth' || scope === 'global_arch') && count !== 0) {
      ctx.addIssue({ code: 'custom', message: `scope=${scope} must have no teeth` });
    }

    if (scope === 'global_arch' && data.arch === null) {
      ctx.addIssue({ code: 'custom', message: 'arch is required when scope=global_arch' });
    }
    if (scope !== 'global_arch' && data.arch !== null) {
      ctx.addIssue({ code: 'custom', message: 'arch is only valid when scope=global_arch' });
    }

    if (data.catalog_item_id === null && data.clinical_type === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Either catalog_item_id or clinical_type is required',
      });
    }

    const clinicalType = data.clinical_type;
    if (clinicalType !== null) {
      if (
        !(TREATMENT_TYPES as readonly string[]).includes(clinicalType)
        || INTERNAL_CLINICAL_TYPES.has(clinicalType)
      ) {
        ctx.addIssue({ code: 'custom', message: `Invalid clinical_type: ${clinicalType}` });
      }
      if (
        (scope === 'tooth' || scope === 'multi_tooth')
        && ATOMIC_MULTI_TOOTH_TYPES.has(clinicalType)
        && count < 2
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `clinical_type=${clinicalType} requires at least 2 teeth`,
        });
      }
    }
  })
  .transform((data) => {
    const count =
      data.teeth && data.teeth.length > 0 ? data.teeth.length : data.tooth_numbers.length;
    return {
      ...data,
      /** Toujours résolu ici (cf. `validate_shape`) — `null` impossible sans issue. */
      scope: data.scope ?? (count === 1 ? 'tooth' : 'multi_tooth'),
    } as typeof data & { scope: (typeof TREATMENT_SCOPES)[number] };
  });

export type TreatmentShapeInput = z.output<typeof treatmentShapeSchema>;

/**
 * `TreatmentCreate` : champs Pydantic (defaults, longueurs, validateurs) puis
 * `validate_shape` (`scope` déduit, contraintes scope/arch/type).
 */
export const treatmentCreateSchema = z
  .object({
    catalog_item_id: uuid.nullable().optional(),
    clinical_type: z.string().max(30).nullable().optional(),
    scope: z.enum(TREATMENT_SCOPES).nullable().optional(),
    arch: z.enum(ARCHES).nullable().optional(),
    tooth_numbers: z
      .array(z.number().int())
      .optional()
      .superRefine((values, ctx) => {
        if (!values) return;
        for (const value of values) {
          if (!isValidToothNumber(value)) {
            ctx.addIssue({ code: 'custom', message: `Invalid tooth number: ${value}` });
          }
        }
        if (values.length !== new Set(values).size) {
          ctx.addIssue({ code: 'custom', message: 'Duplicate tooth numbers not allowed' });
        }
      }),
    teeth: z
      .array(
        z
          .object({
            tooth_number: z.number().int(),
            // `role: str | None = Field(default=None, max_length=20)`.
            role: z.string().max(20).nullable().default(null).optional(),
            surfaces: surfaceList().nullable().default(null).optional(),
          })
          // `ToothInput.validate_tooth_number` (temps de validation).
          .superRefine((tooth, ctx) => {
            if (!isValidToothNumber(tooth.tooth_number)) {
              ctx.addIssue({
                code: 'custom',
                message: `Invalid tooth number: ${tooth.tooth_number}`,
              });
            }
          }),
      )
      .nullable()
      .optional(),
    surfaces: surfaceList().nullable().optional(),
    status: z.enum(TREATMENT_STATUSES).optional(),
    notes: z.string().nullable().optional(),
    budget_item_id: uuid.nullable().optional(),
    source_module: z.string().max(30).optional(),
  })
  .transform((data) => ({
    catalog_item_id: data.catalog_item_id ?? null,
    clinical_type: data.clinical_type ?? null,
    scope: data.scope ?? null,
    arch: data.arch ?? null,
    tooth_numbers: data.tooth_numbers ?? [],
    teeth: data.teeth ?? null,
    surfaces: data.surfaces ?? null,
    status: data.status ?? 'planned',
    notes: data.notes ?? null,
    budget_item_id: data.budget_item_id ?? null,
    source_module: data.source_module ?? 'odontogram',
  }))
  .pipe(treatmentShapeSchema);

export type TreatmentCreateInput = z.output<typeof treatmentCreateSchema>;

export const treatmentUpdateSchema = z.object({
  status: z.enum(TREATMENT_STATUSES).nullable().optional(),
  notes: z.string().nullable().optional(),
  surfaces: surfaceList().nullable().optional(),
});

export type TreatmentUpdateInput = z.infer<typeof treatmentUpdateSchema>;

export const treatmentPerformSchema = z.object({
  notes: z.string().nullable().optional(),
});

export type TreatmentPerformInput = z.infer<typeof treatmentPerformSchema>;

const surfaceUpdateSchema = z.object({
  surface: z.string(),
  condition: z.string(),
});

/**
 * `ToothRecordUpdate` — les validateurs Pydantic (`surface`, `condition`)
 * renvoient directement le message métier, portés ici via `superRefine`.
 */
export const toothRecordUpdateSchema = z
  .object({
    general_condition: z.string().nullable().optional(),
    surface_updates: z.array(surfaceUpdateSchema).nullable().optional(),
    notes: z.string().nullable().optional(),
    is_displaced: z.boolean().nullable().optional(),
    is_rotated: z.boolean().nullable().optional(),
    displacement_notes: z.string().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.general_condition !== null
      && data.general_condition !== undefined
      && !(TOOTH_CONDITIONS as readonly string[]).includes(data.general_condition)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `Invalid condition: ${data.general_condition}. Must be one of ${JSON.stringify(
          [...TOOTH_CONDITIONS],
        )}`,
      });
    }
    for (const update of data.surface_updates ?? []) {
      try {
        assertValidSurface(update.surface);
        assertValidCondition(update.condition);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
      }
    }
  });

export type ToothRecordUpdateInput = z.infer<typeof toothRecordUpdateSchema>;

export const bulkUpdateSchema = z.object({
  updates: z.array(
    z
      .object({
        tooth_number: z.number().int(),
        general_condition: z.string().nullable().optional(),
        surface_updates: z.array(surfaceUpdateSchema).nullable().optional(),
        notes: z.string().nullable().optional(),
      })
      .superRefine((data, ctx) => {
        if (!isValidToothNumber(data.tooth_number)) {
          ctx.addIssue({
            code: 'custom',
            message: `Invalid tooth number: ${data.tooth_number}`,
          });
        }
        for (const update of data.surface_updates ?? []) {
          try {
            assertValidSurface(update.surface);
            assertValidCondition(update.condition);
          } catch (error) {
            ctx.addIssue({ code: 'custom', message: (error as Error).message });
          }
        }
        if (
          data.general_condition !== null
          && data.general_condition !== undefined
          && !(TOOTH_CONDITIONS as readonly string[]).includes(data.general_condition)
        ) {
          ctx.addIssue({
            code: 'custom',
            message: `Invalid condition: ${data.general_condition}. Must be one of ${JSON.stringify(
              [...TOOTH_CONDITIONS],
            )}`,
          });
        }
      }),
  ),
});

export type BulkUpdateInput = z.infer<typeof bulkUpdateSchema>;

/** `YYYY-MM-DD` strict (query `date`). */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Input should be a valid date');

/** Parse une date ISO `YYYY-MM-DD` en `Date` UTC minuit, `null` si invalide. */
export function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** `datetime.combine(date, time.max)` à minuit UTC du lendemain inclus. */
export function endOfDayUtc(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0),
  );
}

export { uuid };
