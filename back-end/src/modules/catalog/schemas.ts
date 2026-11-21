import { z } from 'zod';

/**
 * Schémas du module catalog — port de `app/modules/catalog/schemas.py`.
 *
 * Les helpers purs (`validateSessionTemplate`, `resolveSurfaceTierPrice`,
 * `computeDurationSnapshot`, `lockedFieldChanges`) sont exportés pour être
 * testés sans base de données.
 */

export const PRICING_STRATEGIES = ['flat', 'per_tooth', 'per_surface', 'per_role'] as const;

export const TREATMENT_SCOPES = [
  'tooth',
  'multi_tooth',
  'global_mouth',
  'global_arch',
] as const;

// ---------------------------------------------------------------------------
// Montants (Decimal Python → number JS, comme les floats FastAPI)
// ---------------------------------------------------------------------------

/**
 * Montant décimal : les Pydantic ``Decimal`` acceptent aussi bien le JSON
 * numérique que la chaîne ``"12.50"``. Un champ vidé envoie ``""`` (Nuxt UI
 * garde ``""`` même pour ``type="number"``) : ce n'est pas un nombre malformé
 * mais « pas de valeur » → ``null``.
 */
const decimalString = z.preprocess(
  (value) => {
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
  },
  z
    .union([z.number(), z.string()])
    .refine((value) => toDecimalString(value) !== null, 'Valeur numérique attendue')
    .nullable(),
);

/** Même règle, sans `null` (les paliers de surfaces sont toujours des prix). */
const decimalValue = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z
    .union([z.number(), z.string()])
    .refine((value) => toDecimalString(value) !== null, 'Valeur numérique attendue'),
);

/** Chaîne décimale exacte du montant, ou `null` s'il n'est pas numérique. */
export function toDecimalString(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return String(value);
  }
  if (typeof value === 'string' && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) {
    return value.trim();
  }
  return null;
}

function decimalGte(value: number | string | null): boolean {
  if (value === null) return true;
  const parsed = Number(toDecimalString(value));
  return Number.isFinite(parsed) && parsed >= 0;
}

const nonNegativeDecimal = decimalString.refine(
  (value) => decimalGte(value),
  'Input should be greater than or equal to 0',
);

const nonNegativeDecimalOptional = nonNegativeDecimal.optional();

const namesSchema = z.record(z.string(), z.string());
const descriptionsSchema = z.record(z.string(), z.string());

// ---------------------------------------------------------------------------
// VAT types
// ---------------------------------------------------------------------------

const rateSchema = z
  .number()
  .refine((value) => value >= 0 && value <= 100, 'Input should be between 0 and 100');

export const vatTypeCreateSchema = z.object({
  names: namesSchema.default({}),
  rate: rateSchema.default(0),
  legal_note: z.string().max(300).nullable().optional(),
  is_default: z.boolean().default(false),
});

export const vatTypeUpdateSchema = z.object({
  names: namesSchema.nullable().optional(),
  rate: rateSchema.nullable().optional(),
  legal_note: z.string().max(300).nullable().optional(),
  is_default: z.boolean().nullable().optional(),
  is_active: z.boolean().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Catégories
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

export const categoryCreateSchema = z.object({
  key: z.string().min(1).max(50),
  names: namesSchema.default({}),
  descriptions: descriptionsSchema.nullable().optional(),
  parent_id: uuid.nullable().optional(),
  display_order: z.number().int().default(0),
  icon: z.string().max(50).nullable().optional(),
});

export const categoryUpdateSchema = z.object({
  key: z.string().min(1).max(50).nullable().optional(),
  names: namesSchema.nullable().optional(),
  descriptions: descriptionsSchema.nullable().optional(),
  parent_id: uuid.nullable().optional(),
  display_order: z.number().int().nullable().optional(),
  icon: z.string().max(50).nullable().optional(),
  is_active: z.boolean().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Mapping odontogramme / modèle de séances
// ---------------------------------------------------------------------------

export const odontogramMappingSchema = z.object({
  odontogram_treatment_type: z.string().max(30),
  visualization_rules: z.array(z.record(z.string(), z.unknown())).default([]),
  visualization_config: z.record(z.string(), z.unknown()).default({}),
  clinical_category: z.string().max(20),
});

export const sessionInputSchema = z.object({
  sequence: z.number().int().min(1).nullable().optional(),
  labels: namesSchema.default({}),
  default_price: decimalValue,
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const durationSchema = z
  .preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    z
      .number()
      .int()
      .refine((value) => value >= 0 && value <= 480, 'Input should be between 0 and 480')
      .nullable(),
  );

export const catalogItemCreateSchema = z.object({
  internal_code: z.string().min(1).max(50),
  category_id: uuid,
  names: namesSchema.default({}),
  descriptions: descriptionsSchema.nullable().optional(),

  default_price: nonNegativeDecimalOptional,
  cost_price: nonNegativeDecimalOptional,

  default_duration_minutes: durationSchema.optional(),
  requires_appointment: z.boolean().default(true),

  vat_type_id: uuid.nullable().optional(),

  pricing_strategy: z.enum(PRICING_STRATEGIES).default('flat'),
  pricing_config: z.record(z.string(), z.unknown()).nullable().optional(),
  surface_prices: z.record(z.string(), decimalValue).nullable().optional(),

  treatment_scope: z.enum(TREATMENT_SCOPES).default('tooth'),
  is_diagnostic: z.boolean().default(false),
  requires_surfaces: z.boolean().default(false),

  material_notes: z.string().nullable().optional(),

  odontogram_mapping: odontogramMappingSchema.nullable().optional(),
  sessions: z.array(sessionInputSchema).nullable().optional(),
});

export const catalogItemUpdateSchema = z.object({
  internal_code: z.string().min(1).max(50).nullable().optional(),
  category_id: uuid.nullable().optional(),
  names: namesSchema.nullable().optional(),
  descriptions: descriptionsSchema.nullable().optional(),

  default_price: nonNegativeDecimalOptional,
  cost_price: nonNegativeDecimalOptional,

  default_duration_minutes: durationSchema.optional(),
  requires_appointment: z.boolean().nullable().optional(),

  vat_type_id: uuid.nullable().optional(),

  pricing_strategy: z.enum(PRICING_STRATEGIES).nullable().optional(),
  pricing_config: z.record(z.string(), z.unknown()).nullable().optional(),
  surface_prices: z.record(z.string(), decimalValue).nullable().optional(),

  treatment_scope: z.enum(TREATMENT_SCOPES).nullable().optional(),
  is_diagnostic: z.boolean().nullable().optional(),
  requires_surfaces: z.boolean().nullable().optional(),

  material_notes: z.string().nullable().optional(),

  is_active: z.boolean().nullable().optional(),

  odontogram_mapping: odontogramMappingSchema.nullable().optional(),
  sessions: z.array(sessionInputSchema).nullable().optional(),
});

export type CatalogItemCreateInput = z.infer<typeof catalogItemCreateSchema>;
export type CatalogItemUpdateInput = z.infer<typeof catalogItemUpdateSchema>;
export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>;
export type CategoryUpdateInput = z.infer<typeof categoryUpdateSchema>;
export type VatTypeCreateInput = z.infer<typeof vatTypeCreateSchema>;
export type VatTypeUpdateInput = z.infer<typeof vatTypeUpdateSchema>;
export type OdontogramMappingInput = z.infer<typeof odontogramMappingSchema>;
export type SessionInput = z.infer<typeof sessionInputSchema>;

// ---------------------------------------------------------------------------
// Helpers purs (port de service.py / pricing.py)
// ---------------------------------------------------------------------------

/** Tolérance d'arrondi quand on compare la somme des séances au total. */
export const SESSION_SUM_TOLERANCE = 0.01;

/** Erreur de validation d'un modèle de séances (→ 422). */
export class SessionTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTemplateError';
  }
}

/** Centimes entiers d'une chaîne/nombre décimal (arithmétique exacte). */
function toCents(value: string | number): number {
  const text = toDecimalString(value) ?? '0';
  return Math.round(Number(text) * 100);
}

/** Montant avec le format Python `Decimal.__str__` (ex. `150.00`, `12.5`). */
export function formatDecimal(value: string | number): string {
  const text = toDecimalString(value) ?? '0';
  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const [integerRaw = '0', fraction = ''] = unsigned.split('.');
  const integer = integerRaw.replace(/^0+(?=\d)/, '');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const body = trimmedFraction ? `${integer}.${trimmedFraction}` : integer;
  return negative && body !== '0' ? `-${body}` : body;
}

/**
 * Vérifie que la somme des séances égale le total de l'item.
 *
 * Port de `validate_session_template` : pas de séances → no-op ; séances sans
 * total connu → erreur ; écart > 0.01 → erreur (messages identiques).
 */
export function validateSessionTemplate(
  itemTotal: string | number | null | undefined,
  sessions: Array<{ default_price?: string | number | null; amount?: string | number | null }> | null | undefined,
): void {
  if (!sessions || sessions.length === 0) return;
  if (itemTotal === null || itemTotal === undefined) {
    throw new SessionTemplateError(
      'Cannot define sessions when the item has no default_price',
    );
  }

  const first = sessions[0]!;
  const key = first.default_price !== undefined ? 'default_price' : 'amount';
  let totalCents = 0;
  for (const session of sessions) {
    totalCents += toCents((session[key] ?? 0) as string | number);
  }
  const itemCents = toCents(itemTotal);
  if (Math.abs(totalCents - itemCents) / 100 > SESSION_SUM_TOLERANCE) {
    const total = totalCents / 100;
    throw new SessionTemplateError(
      `Sum of session prices (${formatDecimal(total)}) must equal item total (${formatDecimal(
        itemTotal,
      )})`,
    );
  }
}

/**
 * Prix du palier de surfaces : plus haut palier ≤ `count`, sinon le plus petit.
 * Rend `fallback` (chaîne) si la carte est vide ou illisible.
 */
export function resolveSurfaceTierPrice(
  surfacePrices: Record<string, string | number> | null | undefined,
  surfaceCount: number,
  fallback: string,
): string {
  if (!surfacePrices) return fallback;
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
  return toDecimalString(surfacePrices[String(tier)]) ?? fallback;
}

/** Durée effective d'un traitement (port de `compute_duration_snapshot`). */
export function computeDurationSnapshot(
  defaultDurationMinutes: number | null | undefined,
  pricingStrategy: string | null | undefined,
  teethCount: number,
): number | null {
  if (defaultDurationMinutes === null || defaultDurationMinutes === undefined) return null;
  const strategy = pricingStrategy || 'flat';
  if ((strategy === 'per_tooth' || strategy === 'per_role') && teethCount > 1) {
    return defaultDurationMinutes * teethCount;
  }
  return defaultDurationMinutes;
}

/**
 * Champs structurels possédés par le seeder : une modification réelle
 * renvoie 403 sur un item système (#237). Prix, coût, TVA, noms, durée,
 * séances et `is_active` restent modifiables.
 */
export const SYSTEM_ITEM_LOCKED_FIELDS = [
  'internal_code',
  'category_id',
  'pricing_strategy',
  'treatment_scope',
  'is_diagnostic',
  'requires_surfaces',
] as const;

/** Sous-ensemble trié des champs verrouillés réellement modifiés. */
export function lockedFieldChanges(
  current: Record<string, unknown>,
  update: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  for (const field of SYSTEM_ITEM_LOCKED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(update, field)) continue;
    if (update[field] !== current[field]) changed.push(field);
  }
  return changed.sort();
}

/** Champs nullables qu'un `null` explicite efface (`_CLEARABLE_ITEM_FIELDS`). */
export const CLEARABLE_ITEM_FIELDS = [
  'default_price',
  'cost_price',
  'default_duration_minutes',
] as const;
