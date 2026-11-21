/**
 * Schémas de validation — port de
 * `backend/app/modules/patients_clinical/schemas.py`.
 *
 * Les validateurs Pydantic `mode="before"` (`_blank_is_none`) transforment
 * une chaîne vide en `None` pour les champs numériques/date/e-mail, et
 * Pydantic v2 les IGNORE silencieusement pour les champs booléens
 * (`is_pregnant=''` reste une erreur de booléen). On reproduit exactement
 * cette répartition : `is_pregnant` n'est PAS coerce, `pregnancy_week` /
 * `inr_value` / `last_inr_date` acceptent `""` → `null`.
 */

import { z } from 'zod';

/** `_blank_is_none` : chaîne vide/blanche → `null`, sinon valeur inchangée. */
export function blankToNull(value: unknown): unknown {
  if (typeof value === 'string' && value.trim() === '') return null;
  return value;
}

const uuid = z.string().uuid();

/**
 * `int | None` avec `ge`/`le` — miroir du message Pydantic
 * (« Input should be a valid integer »). Les bornes ne sont vérifiées que
 * si `range` est fourni.
 */
function pydanticInt(ge?: number, le?: number): z.ZodType<number | null> {
  return z
    .custom<number | null>(
      (value) => typeof value === 'number' && Number.isInteger(value),
      { message: 'Input should be a valid integer' },
    )
    .refine((value) => value === null || ge === undefined || value >= ge, {
      message: `Input should be greater than or equal to ${ge}`,
    })
    .refine((value) => value === null || le === undefined || value <= le, {
      message: `Input should be less than or equal to ${le}`,
    });
}

/**
 * `float | None`. Pydantic coerce les chaînes numériques (`"1.5"` → 1.5)
 * et refuse `bool`.
 */
function pydanticFloat(ge?: number, le?: number): z.ZodType<number | null> {
  const number = z
    .union([z.number(), z.string()], { message: 'Input should be a valid number' })
    .transform((value, ctx) => {
      if (typeof value === 'number') return value;
      return coerceNumberString(value, ctx);
    });
  return number
    .refine((value) => value === null || !Number.isNaN(value), {
      message: 'Input should be a valid number',
    })
    .refine((value) => value === null || ge === undefined || value >= ge, {
      message: `Input should be greater than or equal to ${ge}`,
    })
    .refine((value) => value === null || le === undefined || value <= le, {
      message: `Input should be less than or equal to ${le}`,
    }) as unknown as z.ZodType<number | null>;
}

function coerceNumberString(
  value: string,
  ctx: z.RefinementCtx,
): number | null {
  const trimmed = value.trim();
  // Pydantic accepte inf/nan sous forme de chaîne.
  const lowered = trimmed.toLowerCase();
  if (lowered === 'inf' || lowered === '+inf' || lowered === 'infinity') return Infinity;
  if (lowered === '-inf' || lowered === '-infinity') return -Infinity;
  if (lowered === 'nan') return NaN;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: 'custom', message: 'Input should be a valid number' });
    return z.NEVER as unknown as number;
  }
  return parsed;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PREFIX =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/i;

/** `true` si la valeur est une date Pydantic valide ; renvoie `YYYY-MM-DD`. */
export function pydanticDateString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const dateOnly = DATE_ONLY.exec(trimmed);
  const match = dateOnly ?? DATETIME_PREFIX.exec(trimmed);
  if (!match) return null;
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d, Number(hour), Number(minute), Number(second)));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return `${year}-${month}-${day}`;
}

/**
 * `date | None` (pydantic `date` : accepte aussi un datetime ISO, dont on ne
 * garde que la partie date). Retourne la chaîne `YYYY-MM-DD`.
 */
function pydanticDate(): z.ZodType<string | null> {
  return z.custom<string | null>(
    (value) => value === null || pydanticDateString(value) !== null,
    { message: 'Input should be a valid date' },
  );
}

/** `EmailStr | None` (Pydantic `email-validator` : rejette `""`). */
function emailField(): z.ZodType<string | null> {
  return z
    .string()
    .refine((value) => z.string().email().safeParse(value).success, {
      message: 'value is not a valid email address',
    })
    .nullable();
}

/** Champ `X | None` qui tolère `""` (validateur `_blank_is_none`). */
function blankNullable<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(blankToNull, schema).nullable();
}

/**
 * Champ optionnel `X | None` avec nettoyage des blancs : `""` → `null`,
 * `undefined` (clé absente) reste `undefined` pour ne pas écraser la valeur
 * en base lors d'un PATCH partiel (`exclude_unset`).
 */
function preblank<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (value === undefined ? undefined : blankToNull(value)),
    schema.nullable(),
  );
}

/**
 * Coercition Pydantic `bool` (`mode="strict"` simulé) :
 * `true/false/0/1/"0"/"1"/"off"/"on"/"f"/"t"/"n"/"y"/...`.
 */
export function pydanticBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 0) return false;
  if (value === 1) return true;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['0', 'off', 'f', 'false', 'n', 'no'].includes(lowered)) return false;
    if (['1', 'on', 't', 'true', 'y', 'yes'].includes(lowered)) return true;
  }
  return null;
}

const boolField = z.custom<boolean>(
  (value) => pydanticBool(value) !== null,
  { message: 'Input should be a valid boolean' },
);
const boolDefault = (fallback: boolean) =>
  z.preprocess((value) => (value === undefined ? fallback : pydanticBool(value)), boolField);
const boolOptional = z.preprocess(
  (value) => (value === undefined ? undefined : pydanticBool(value)),
  boolField.optional(),
);

/** `str | None` borné. La chaîne vide reste une valeur valide (comme Pydantic). */
const str = (max: number) => z.string().max(max).nullable();
const strOptional = (max: number) => z.string().max(max).nullable().optional();
const strRequired = (min: number, max: number) => z.string().min(min).max(max);

// ---------------------------------------------------------------------------
// Contexte médical
// ---------------------------------------------------------------------------

export const medicalContextUpdateSchema = z.object({
  is_pregnant: boolDefault(false),
  pregnancy_week: preblank(pydanticInt(1, 42)).optional(),
  is_lactating: boolDefault(false),
  is_on_anticoagulants: boolDefault(false),
  anticoagulant_medication: preblank(str(100)).optional(),
  inr_value: preblank(pydanticFloat(0, 20)).optional(),
  last_inr_date: preblank(pydanticDate()).optional(),
  is_smoker: boolDefault(false),
  smoking_frequency: preblank(str(100)).optional(),
  alcohol_consumption: preblank(str(100)).optional(),
  bruxism: boolDefault(false),
  adverse_reactions_to_anesthesia: boolDefault(false),
  anesthesia_reaction_details: preblank(str(500)).optional(),
});

export type MedicalContextUpdateInput = z.infer<typeof medicalContextUpdateSchema>;

// ---------------------------------------------------------------------------
// Allergies
// ---------------------------------------------------------------------------

/** Seules `high` et `critical` déclenchent une alerte (`compute_alerts`). */
export const ALLERGY_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

export const allergyCreateSchema = z.object({
  name: strRequired(1, 100),
  type: strOptional(50),
  severity: z.enum(ALLERGY_SEVERITIES).optional(),
  reaction: strOptional(500),
  notes: z.string().nullable().optional(),
  reference_id: uuid.nullable().optional(),
});

export const allergyUpdateSchema = z.object({
  name: strRequired(1, 100).nullable().optional(),
  type: strOptional(50),
  severity: z.enum(ALLERGY_SEVERITIES).nullable().optional(),
  reaction: strOptional(500),
  notes: z.string().nullable().optional(),
  reference_id: uuid.nullable().optional(),
});

export type AllergyCreateInput = z.infer<typeof allergyCreateSchema>;
export type AllergyUpdateInput = z.infer<typeof allergyUpdateSchema>;

// ---------------------------------------------------------------------------
// Médicaments
// ---------------------------------------------------------------------------

export const medicationCreateSchema = z.object({
  name: strRequired(1, 100),
  dosage: strOptional(100),
  frequency: strOptional(100),
  start_date: blankNullable(pydanticDate()).optional(),
  notes: z.string().nullable().optional(),
  reference_id: uuid.nullable().optional(),
});

export const medicationUpdateSchema = z.object({
  name: strRequired(1, 100).nullable().optional(),
  dosage: strOptional(100),
  frequency: strOptional(100),
  start_date: blankNullable(pydanticDate()).optional(),
  notes: z.string().nullable().optional(),
  reference_id: uuid.nullable().optional(),
});

export type MedicationCreateInput = z.infer<typeof medicationCreateSchema>;
export type MedicationUpdateInput = z.infer<typeof medicationUpdateSchema>;

// ---------------------------------------------------------------------------
// Maladies systémiques
// ---------------------------------------------------------------------------

export const systemicDiseaseCreateSchema = z.object({
  name: strRequired(1, 100),
  type: strOptional(50),
  diagnosis_date: preblank(pydanticDate()).optional(),
  is_controlled: boolDefault(true),
  is_critical: boolDefault(false),
  medications: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  reference_id: uuid.nullable().optional(),
});

export const systemicDiseaseUpdateSchema = z.object({
  name: strRequired(1, 100).nullable().optional(),
  type: strOptional(50),
  diagnosis_date: preblank(pydanticDate()).optional(),
  is_controlled: boolOptional,
  is_critical: boolOptional,
  medications: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  reference_id: uuid.nullable().optional(),
});

export type SystemicDiseaseCreateInput = z.infer<typeof systemicDiseaseCreateSchema>;
export type SystemicDiseaseUpdateInput = z.infer<typeof systemicDiseaseUpdateSchema>;

// ---------------------------------------------------------------------------
// Antécédents chirurgicaux
// ---------------------------------------------------------------------------

export const surgicalHistoryCreateSchema = z.object({
  procedure: strRequired(1, 200),
  surgery_date: preblank(pydanticDate()).optional(),
  complications: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  reference_id: uuid.nullable().optional(),
});

export const surgicalHistoryUpdateSchema = z.object({
  procedure: strRequired(1, 200).nullable().optional(),
  surgery_date: preblank(pydanticDate()).optional(),
  complications: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  reference_id: uuid.nullable().optional(),
});

export type SurgicalHistoryCreateInput = z.infer<typeof surgicalHistoryCreateSchema>;
export type SurgicalHistoryUpdateInput = z.infer<typeof surgicalHistoryUpdateSchema>;

// ---------------------------------------------------------------------------
// Contact d'urgence / tuteur légal
// ---------------------------------------------------------------------------

export const emergencyContactUpsertSchema = z.object({
  name: strRequired(1, 100),
  relationship: strOptional(50),
  phone: strRequired(1, 20),
  email: preblank(emailField()).optional(),
  is_legal_guardian: boolDefault(false),
});

export const legalGuardianUpsertSchema = z.object({
  name: strRequired(1, 100),
  relationship: strRequired(0, 50),
  dni: strOptional(20),
  phone: strRequired(1, 20),
  email: preblank(emailField()).optional(),
  address: strOptional(200),
  notes: z.string().nullable().optional(),
});

export type EmergencyContactUpsertInput = z.infer<typeof emergencyContactUpsertSchema>;
export type LegalGuardianUpsertInput = z.infer<typeof legalGuardianUpsertSchema>;

// ---------------------------------------------------------------------------
// Historique médical agrégé (ancienne forme JSONB du formulaire)
// ---------------------------------------------------------------------------

export const medicalHistoryUpdateSchema = z.object({
  allergies: z.array(allergyCreateSchema).optional(),
  medications: z.array(medicationCreateSchema).optional(),
  systemic_diseases: z.array(systemicDiseaseCreateSchema).optional(),
  surgical_history: z.array(surgicalHistoryCreateSchema).optional(),

  is_pregnant: boolDefault(false),
  pregnancy_week: preblank(pydanticInt(1, 42)).optional(),
  is_lactating: boolDefault(false),

  is_on_anticoagulants: boolDefault(false),
  anticoagulant_medication: preblank(str(100)).optional(),
  inr_value: preblank(pydanticFloat(0, 20)).optional(),
  last_inr_date: preblank(pydanticDate()).optional(),

  is_smoker: boolDefault(false),
  smoking_frequency: preblank(str(100)).optional(),
  alcohol_consumption: preblank(str(100)).optional(),

  bruxism: boolDefault(false),

  adverse_reactions_to_anesthesia: boolDefault(false),
  anesthesia_reaction_details: preblank(str(500)).optional(),
});

export type MedicalHistoryUpdateInput = z.infer<typeof medicalHistoryUpdateSchema>;

/** Champs de contexte relevés par `replace_medical_history` (si présents). */
export const MEDICAL_CONTEXT_FIELDS = [
  'is_pregnant',
  'pregnancy_week',
  'is_lactating',
  'is_on_anticoagulants',
  'anticoagulant_medication',
  'inr_value',
  'last_inr_date',
  'is_smoker',
  'smoking_frequency',
  'alcohol_consumption',
  'bruxism',
  'adverse_reactions_to_anesthesia',
  'anesthesia_reaction_details',
] as const;
