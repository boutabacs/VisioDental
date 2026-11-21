/**
 * Schémas et arithmétique pure du module `budget` — port de
 * `app/modules/budget/schemas.py`, `workflow.py` (constantes) et des
 * helpers de `service.py`.
 *
 * Aucune I/O ici : les valeurs de date/devis sont manipulées en
 * `YYYY-MM-DD` (colonnes `date`) et en centimes entiers.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types / constantes
// ---------------------------------------------------------------------------

export const BUDGET_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'completed',
  'rejected',
  'expired',
  'cancelled',
] as const;

export const DISCOUNT_TYPES = ['percentage', 'absolute'] as const;

export const SIGNATURE_METHODS = ['click_accept', 'drawn', 'external_provider'] as const;

export const RELATIONSHIPS_TO_PATIENT = ['patient', 'guardian', 'representative'] as const;

export const SEND_METHODS = ['manual', 'email', 'whatsapp'] as const;

export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

/**
 * Transitions de statut valides. `completed` n'est plus atteignable — il
 * reste une entrée terminale pour les lignes historiques.
 */
export const VALID_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ['sent', 'accepted', 'rejected', 'cancelled'],
  sent: ['accepted', 'rejected', 'expired', 'cancelled'],
  accepted: ['cancelled'],
  completed: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

/** Méthodes d'authentification du lien public (`Budget.public_auth_method`). */
export const PUBLIC_AUTH_METHODS = ['phone_last4', 'dob', 'manual_code', 'none'] as const;

/** Motifs de refus côté patient (catalogue fermé du lien public). */
export const PUBLIC_REJECTION_REASONS = ['price', 'time', 'second_opinion', 'other'] as const;

/** Politique anti-force-brute du lien public (ADR 0006). */
export const PUBLIC_AUTH_FAIL_LIMIT_WINDOW = 5;
export const PUBLIC_AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
export const PUBLIC_AUTH_TOTAL_FAIL_LOCKOUT = 10;
export const PUBLIC_SESSION_TTL_SECONDS = 30 * 60;

/** Validité par défaut d'un budget quand la clinique n'a pas d'override. */
export const DEFAULT_BUDGET_VALIDITY_DAYS = 30;

/** Sorties autorisées pour `list_budgets` (même liste que Python). */
export const SORT_ALLOW = ['created_at', 'valid_until', 'total', 'status', 'budget_number'] as const;
export const SORT_DEFAULT_FIELD = 'created_at';
export const SORT_DEFAULT_DIRECTION = 'desc';

/** Colonnes de `budget_items` effaçables par un `null` explicite. */
export const CLEARABLE_ITEM_FIELDS = new Set([
  'discount_type',
  'discount_value',
  'tooth_number',
  'surfaces',
  'notes',
]);

/** Colonnes de `budgets` effaçables par un `null` explicite. */
export const CLEARABLE_BUDGET_FIELDS = new Set([
  'valid_until',
  'assigned_professional_id',
  'global_discount_type',
  'global_discount_value',
  'internal_notes',
  'patient_notes',
]);

// ---------------------------------------------------------------------------
// Statut / échéance
// ---------------------------------------------------------------------------

/** `WorkflowService.can_transition` : la transition est-elle autorisée ? */
export function canTransition(current: string, next: string): boolean {
  return (VALID_TRANSITIONS[current] ?? []).includes(next);
}

/** Validité dépassée ? (`valid_until < today`, jour de la clinique). */
export function isExpired(validUntil: string | null | undefined, today: string): boolean {
  return validUntil !== null && validUntil !== undefined && validUntil < today;
}

/** `today + days` en calendrier grégorien (colonnes `date`, UTC). */
export function addDays(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.slice(0, 10).split('-').map(Number);
  const base = new Date(Date.UTC(year!, month! - 1, day!));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * Jour « aujourd'hui » dans le fuseau de la clinique, en `YYYY-MM-DD`.
 * Miroir de `clinic_today_for` (qui lit `clinics.timezone`).
 */
export function clinicTodayDateString(timeZone: string | null | undefined, now: Date = new Date()): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(now);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    // Fuseau inconnu : Python lève, on retombe sur UTC (comportement de repli
    // déjà utilisé par le PDF).
    return now.toISOString().slice(0, 10);
  }
}

/** Numéro de budget suivant à partir du plus grand existant (`PRES-YYYY-NNNN`). */
export function nextBudgetNumberSequence(prefix: string, maxNumber: string | null): string {
  let sequence = 1;
  if (maxNumber) {
    const parsed = Number.parseInt(maxNumber.split('-').pop() ?? '', 10);
    sequence = Number.isNaN(parsed) ? 1 : parsed + 1;
  }
  return `${prefix}${String(sequence).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Tri (`parse_sort`)
// ---------------------------------------------------------------------------

export interface ParsedSort {
  field: (typeof SORT_ALLOW)[number];
  direction: 'asc' | 'desc';
}

/**
 * `field[:direction]` → `{field, direction}`. Champ inconnu ou direction
 * invalide → défaut `created_at:desc` (jamais d'erreur, comme Python).
 */
export function parseSort(raw: string | null | undefined): ParsedSort {
  const fallback: ParsedSort = {
    field: SORT_DEFAULT_FIELD,
    direction: SORT_DEFAULT_DIRECTION,
  };
  if (!raw) return fallback;
  const [field, direction] = raw.split(':', 2);
  if (!field || !(SORT_ALLOW as readonly string[]).includes(field)) return fallback;
  if (direction !== undefined && direction !== 'asc' && direction !== 'desc') return fallback;
  return {
    field: field as ParsedSort['field'],
    direction: direction === 'asc' ? 'asc' : direction === 'desc' ? 'desc' : fallback.direction,
  };
}

// ---------------------------------------------------------------------------
// Chiffres d'un téléphone (cascade du lien public)
// ---------------------------------------------------------------------------

/** Chrome le téléphone en gardant les chiffres (`str.isdigit`). */
export function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

// ---------------------------------------------------------------------------
// Sérialisation JSONB des entrées d'historique
// ---------------------------------------------------------------------------

/**
 * `_serialize_for_json` : dates → ISO, décimaux (en centimes ici) →
 * chaîne `x.yz`, UUID → chaîne, null conservé.
 */
export function serializeForJson(
  cents: Record<string, unknown> | null | undefined,
  decimalKeys: ReadonlySet<string> = new Set(),
): Record<string, unknown> | null {
  if (cents === null || cents === undefined) return null;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cents)) {
    if (value === null || value === undefined) {
      result[key] = null;
    } else if (decimalKeys.has(key) && typeof value === 'number') {
      result[key] = centsToDecimalString(value);
    } else if (value instanceof Date) {
      result[key] = value.toISOString();
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** `Decimal` → chaîne à deux décimales (sérialisation `str(Decimal)`). */
export function centsToDecimalString(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(Math.round(cents));
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

// ---------------------------------------------------------------------------
// Schémas zod (miroir des schémas Pydantic)
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

/** Montant décimal ≥ 0 (accepté en nombre ou chaîne, converti en centimes). */
const moneyAmount = z
  .union([z.number(), z.string()])
  .transform((value) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) throw new Error('Invalid decimal');
    if (parsed < 0) throw new Error('Input should be greater than or equal to 0');
    return Math.round(parsed * 100);
  });

const optionalMoney = moneyAmount.nullable().optional();

const discountType = z.enum(DISCOUNT_TYPES).nullable().optional();

const surfaces = z.array(z.string()).nullable().optional();

const toothNumber = z.coerce
  .number()
  .int()
  .min(11, 'Input should be greater than or equal to 11')
  .max(85, 'Input should be less than or equal to 85')
  .nullable()
  .optional();

const quantity = z.coerce.number().int().min(1, 'Input should be greater than or equal to 1');

/** `null` explicite = effacement (types autorisés par `_CLEARABLE_*_FIELDS`). */
const itemCreateSchema = z.object({
  catalog_item_id: uuid,
  quantity: quantity.default(1),
  unit_price: optionalMoney,
  discount_type: discountType,
  discount_value: optionalMoney,
  tooth_number: toothNumber,
  surfaces,
  treatment_id: uuid.nullable().optional(),
  display_order: z.coerce.number().int().default(0),
  notes: z.string().nullable().optional(),
});

export const budgetItemCreateSchema = itemCreateSchema;

/** Même grammaire que la création (le `null` est filtré par la couche service). */
export const budgetItemUpdateSchema = itemCreateSchema.partial();

export interface BudgetItemCreateInput {
  catalog_item_id: string;
  quantity: number;
  unit_price?: number | null;
  discount_type?: string | null;
  discount_value?: number | null;
  tooth_number?: number | null;
  surfaces?: string[] | null;
  treatment_id?: string | null;
  display_order: number;
  notes?: string | null;
}

export interface BudgetItemUpdateInput {
  catalog_item_id?: string;
  quantity?: number;
  unit_price?: number | null;
  discount_type?: string | null;
  discount_value?: number | null;
  tooth_number?: number | null;
  surfaces?: string[] | null;
  treatment_id?: string | null;
  display_order?: number;
  notes?: string | null;
}

/** `YYYY-MM-DD` (date Pydantic) → même chaîne, validée au calendrier. */
const dateOnlyField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Input should be a valid date')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Input should be a valid date');

export const budgetCreateSchema = z.object({
  patient_id: uuid,
  valid_from: dateOnlyField.optional(),
  valid_until: dateOnlyField.nullable().optional(),
  assigned_professional_id: uuid.nullable().optional(),
  global_discount_type: discountType,
  global_discount_value: optionalMoney,
  internal_notes: z.string().nullable().optional(),
  patient_notes: z.string().nullable().optional(),
  items: z.array(budgetItemCreateSchema).default([]),
});

export interface BudgetCreateInput {
  patient_id: string;
  valid_from?: string;
  valid_until?: string | null;
  assigned_professional_id?: string | null;
  global_discount_type?: string | null;
  global_discount_value?: number | null;
  internal_notes?: string | null;
  patient_notes?: string | null;
  items: BudgetItemCreateInput[];
}

export const budgetUpdateSchema = z.object({
  valid_from: dateOnlyField.nullable().optional(),
  valid_until: dateOnlyField.nullable().optional(),
  assigned_professional_id: uuid.nullable().optional(),
  global_discount_type: discountType,
  global_discount_value: optionalMoney,
  internal_notes: z.string().nullable().optional(),
  patient_notes: z.string().nullable().optional(),
});

export interface BudgetUpdateInput {
  valid_from?: string | null;
  valid_until?: string | null;
  assigned_professional_id?: string | null;
  global_discount_type?: string | null;
  global_discount_value?: number | null;
  internal_notes?: string | null;
  patient_notes?: string | null;
}

export const signatureCreateSchema = z.object({
  signed_by_name: z.string().min(1).max(200),
  signed_by_email: z.string().max(255).nullable().optional(),
  relationship_to_patient: z.enum(RELATIONSHIPS_TO_PATIENT).default('patient'),
  signature_data: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type SignatureCreateInput = z.infer<typeof signatureCreateSchema> & {
  /** Posé par les routes « signature en clinique / lien public ». */
  signature_method?: string;
};

export const budgetSendRequestSchema = z.object({
  send_method: z.enum(SEND_METHODS).nullable().optional(),
  send_email: z.boolean().default(false),
  custom_message: z.string().nullable().optional(),
});

/**
 * `resolved_send_method` : `send_method` gagne, sinon le drapeau legacy
 * `send_email` mappe vers `email`/`manual`.
 */
export function resolveSendMethod(input: {
  send_method?: string | null;
  send_email?: boolean | null;
}): string {
  if (input.send_method !== null && input.send_method !== undefined) {
    return input.send_method;
  }
  return input.send_email ? 'email' : 'manual';
}

export const budgetAcceptRequestSchema = z.object({
  signature: signatureCreateSchema,
});

export const budgetRejectRequestSchema = z.object({
  reason: z.string().nullable().optional(),
  signature: signatureCreateSchema.nullable().optional(),
});

export const budgetCancelRequestSchema = z.object({
  reason: z.string().nullable().optional(),
});

export const acceptInClinicSchema = z.object({
  signer_name: z.string().min(1).max(200),
  signature_data: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const setPublicCodeSchema = z.object({
  code: z
    .string()
    .min(4, 'String should have at least 4 characters')
    .max(6, 'String should have at most 6 characters')
    .regex(/^[0-9]+$/, 'String should match pattern \'^[0-9]+$\''),
});

export const sendReminderSchema = z.object({
  milestone_days: z.coerce.number().int().min(0).max(365).default(0),
});

export const publicVerifySchema = z.object({
  method: z.enum(['phone_last4', 'dob', 'manual_code', 'none']),
  value: z.string().min(1).max(64),
});

export const publicAcceptSchema = z.object({
  signer_name: z.string().min(1).max(200),
  signature_data: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const publicRejectSchema = z.object({
  reason: z.string(),
  note: z.string().max(2000).nullable().optional(),
});

/** Locales acceptées par les PDF (`PDF_LOCALE_PATTERN`). */
export const PDF_LOCALES = [
  'es',
  'en',
  'ta',
  'te',
  'hi',
  'fr',
  'pt',
  'pt-BR',
  'de',
  'hu',
  'pl',
  'it',
  'ar',
] as const;
