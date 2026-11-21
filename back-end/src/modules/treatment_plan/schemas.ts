/**
 * Schémas de validation du module `treatment_plan` — port de
 * `app/modules/treatment_plan/schemas.py` (corps des requêtes Pydantic).
 */

import { z } from 'zod';

import { toDecimalString } from '../catalog/schemas';

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export const PLAN_STATUSES = [
  'draft',
  'pending',
  'active',
  'completed',
  'archived',
  'closed',
] as const;

/** Transitions autorisées (`VALID_PLAN_TRANSITIONS`, ADR 0006). */
export const VALID_PLAN_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ['pending', 'closed'],
  pending: ['active', 'draft', 'closed'],
  active: ['completed', 'closed'],
  completed: ['archived'],
  closed: ['draft'],
  archived: [],
};

export const VALID_CLOSURE_REASONS = [
  'rejected_by_patient',
  'expired',
  'cancelled_by_clinic',
  'patient_abandoned',
  'other',
] as const;

/** Statuts de budget considérés comme du « papier mort ». */
export const TERMINAL_BUDGET_STATUSES = ['cancelled', 'rejected', 'expired'] as const;

export const PIPELINE_TABS = [
  'por_presupuestar',
  'esperando_paciente',
  'sin_cita',
  'sin_proxima_cita',
  'cerrados',
] as const;

const uuid = z.string().uuid();

/** Décimal accepté en nombre ou chaîne (Pydantic `Decimal`). */
const decimal = z.union([z.number().finite(), z.string()]).refine(
  (value) => toDecimalString(value) !== null,
  'Input should be a valid decimal',
);

export const treatmentPlanCreateSchema = z.object({
  patient_id: uuid,
  title: z.string().max(200).nullable().optional(),
  assigned_professional_id: uuid.nullable().optional(),
  diagnosis_notes: z.string().nullable().optional(),
  internal_notes: z.string().nullable().optional(),
});

export const treatmentPlanUpdateSchema = z.object({
  title: z.string().max(200).nullable().optional(),
  assigned_professional_id: uuid.nullable().optional(),
  diagnosis_notes: z.string().nullable().optional(),
  internal_notes: z.string().nullable().optional(),
  /** Directive en écriture seule : réassigne les items pending de l'ancien docteur. */
  reassign_pending_items: z.boolean().default(false),
});

export const treatmentPlanStatusUpdateSchema = z.object({
  status: z.enum(PLAN_STATUSES),
});

export const closePlanSchema = z.object({
  closure_reason: z.enum(VALID_CLOSURE_REASONS),
  closure_note: z.string().max(2000).nullable().optional(),
});

export const contactLogSchema = z.object({
  channel: z.enum(['call', 'whatsapp', 'email', 'in_person', 'other']),
  note: z.string().max(1000).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const plannedItemCreateSchema = z.object({
  treatment_id: uuid,
  sequence_order: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  assigned_professional_id: uuid.nullable().optional(),
});

export const plannedItemUpdateSchema = z.object({
  sequence_order: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  // `null` explicite efface l'assignation ; clé absente = inchangé.
  assigned_professional_id: uuid.nullable().optional(),
});

export const reorderItemsSchema = z.object({
  item_ids: z.array(uuid),
});

export const completeItemSchema = z.object({
  completed_without_appointment: z.boolean().default(true),
  notes: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const sessionInputSchema = z.object({
  sequence: z.number().int().min(1).nullable().optional(),
  label: z.string().max(120).nullable().optional(),
  amount: decimal.refine((value) => Number(toDecimalString(value)) >= 0, 'Input should be greater than or equal to 0'),
});

export const completeSessionSchema = z.object({
  completed_without_appointment: z.boolean().default(false),
  notes: z.string().nullable().optional(),
});

export const updateSessionSchema = z.object({
  label: z.string().max(120).nullable().optional(),
  amount: decimal
    .refine(
      (value) => Number(toDecimalString(value)) >= 0,
      'Input should be greater than or equal to 0',
    )
    .nullable()
    .optional(),
  notes: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export const linkBudgetSchema = z.object({
  budget_id: uuid,
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export const pipelineQuerySchema = z.object({
  tab: z.enum(PIPELINE_TABS),
  page: z.number().int().min(1).default(1),
  page_size: z.number().int().min(1).max(100).default(20),
  doctor_id: uuid.optional(),
  q: z.string().optional(),
});

export type TreatmentPlanCreateInput = z.infer<typeof treatmentPlanCreateSchema>;
export type TreatmentPlanUpdateInput = z.infer<typeof treatmentPlanUpdateSchema>;
export type PlannedItemCreateInput = z.infer<typeof plannedItemCreateSchema>;
export type PlannedItemUpdateInput = z.infer<typeof plannedItemUpdateSchema>;
export type SessionInput = z.infer<typeof sessionInputSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;
export type PipelineQuery = z.infer<typeof pipelineQuerySchema>;
