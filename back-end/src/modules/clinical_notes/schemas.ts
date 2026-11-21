import { z } from 'zod';

/** Types de note — miroir de `clinical_notes.models.NOTE_TYPES`. */
export const NOTE_TYPE_ADMINISTRATIVE = 'administrative';
export const NOTE_TYPE_DIAGNOSIS = 'diagnosis';
export const NOTE_TYPE_TREATMENT = 'treatment';
export const NOTE_TYPE_TREATMENT_PLAN = 'treatment_plan';
export const NOTE_TYPE_APPOINTMENT_CLINICAL = 'appointment_clinical';
export const NOTE_TYPE_APPOINTMENT_ADMINISTRATIVE = 'appointment_administrative';

export const NOTE_TYPES = [
  NOTE_TYPE_ADMINISTRATIVE,
  NOTE_TYPE_DIAGNOSIS,
  NOTE_TYPE_TREATMENT,
  NOTE_TYPE_TREATMENT_PLAN,
  NOTE_TYPE_APPOINTMENT_CLINICAL,
  NOTE_TYPE_APPOINTMENT_ADMINISTRATIVE,
] as const;

/** Types de propriétaire référencés par `owner_id` — `NOTE_OWNER_TYPES`. */
export const NOTE_OWNER_PATIENT = 'patient';
export const NOTE_OWNER_TREATMENT = 'treatment';
export const NOTE_OWNER_PLAN = 'plan';
export const NOTE_OWNER_APPOINTMENT = 'appointment';

export const NOTE_OWNER_TYPES = [
  NOTE_OWNER_PATIENT,
  NOTE_OWNER_TREATMENT,
  NOTE_OWNER_PLAN,
  NOTE_OWNER_APPOINTMENT,
] as const;

/** `NOTE_OWNER_PATTERN` côté FastAPI (query `owner_type` de `/notes`). */
export const NOTE_OWNER_PATTERN = /^(patient|treatment|plan|appointment)$/;

/** `ATTACHMENT_OWNER_PATTERN` (query `owner_type` de `/attachments`). */
export const ATTACHMENT_OWNER_PATTERN = /^(patient|treatment|plan|appointment|clinical_note)$/;

/** `_VALID_ATTACHMENT_OWNER_TYPES` du service Python. */
export const VALID_ATTACHMENT_OWNER_TYPES: readonly string[] = [
  ...NOTE_OWNER_TYPES,
  'clinical_note',
];

/** Matrice `note_type` → `owner_type` (contrainte CHECK de la table). */
export const NOTE_TYPE_OWNER_MATRIX: Record<string, string> = {
  [NOTE_TYPE_ADMINISTRATIVE]: NOTE_OWNER_PATIENT,
  [NOTE_TYPE_DIAGNOSIS]: NOTE_OWNER_PATIENT,
  [NOTE_TYPE_TREATMENT]: NOTE_OWNER_TREATMENT,
  [NOTE_TYPE_TREATMENT_PLAN]: NOTE_OWNER_PLAN,
  [NOTE_TYPE_APPOINTMENT_CLINICAL]: NOTE_OWNER_APPOINTMENT,
  [NOTE_TYPE_APPOINTMENT_ADMINISTRATIVE]: NOTE_OWNER_APPOINTMENT,
};

function isNoteType(value: string): boolean {
  return (NOTE_TYPES as readonly string[]).includes(value);
}

/** Miroir du `model_validator` de `ClinicalNoteCreate`. */
function checkTypeOwnerMatrix(
  data: { note_type: string; owner_type: string; tooth_number?: number | null },
  ctx: z.RefinementCtx,
): void {
  const expectedOwner = NOTE_TYPE_OWNER_MATRIX[data.note_type];
  if (expectedOwner && data.owner_type !== expectedOwner) {
    // Message Python : repr() d'une str utilise des guillemets simples.
    ctx.addIssue({
      code: 'custom',
      path: ['owner_type'],
      message: `note_type='${data.note_type}' requires owner_type='${expectedOwner}'`,
    });
  }
  if (data.tooth_number !== undefined && data.tooth_number !== null
    && data.note_type !== NOTE_TYPE_DIAGNOSIS) {
    ctx.addIssue({
      code: 'custom',
      path: ['tooth_number'],
      message: "tooth_number is only allowed for note_type='diagnosis'",
    });
  }
}

const uuid = z.string().uuid();

export const clinicalNoteCreateSchema = z
  .object({
    note_type: z.string().refine(isNoteType, 'Invalid note_type'),
    owner_type: z.enum(NOTE_OWNER_TYPES),
    owner_id: uuid,
    tooth_number: z.number().int().min(11).max(85).nullable().optional(),
    body: z.string().min(1),
    attachment_document_ids: z.array(uuid).optional().default([]),
  })
  .superRefine(checkTypeOwnerMatrix);

export const clinicalNoteUpdateSchema = z.object({
  body: z.string().min(1),
});

export type ClinicalNoteCreateInput = z.infer<typeof clinicalNoteCreateSchema>;
export type ClinicalNoteUpdateInput = z.infer<typeof clinicalNoteUpdateSchema>;
