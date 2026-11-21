import { z } from 'zod';

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'confirmed',
  'checked_in',
  'in_treatment',
  'completed',
  'cancelled',
  'no_show',
] as const;

export const VALID_TRANSITIONS: Record<string, readonly string[]> = {
  scheduled: ['confirmed', 'checked_in', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['in_treatment', 'cancelled'],
  in_treatment: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
};

/** Statuts qui n'occupent plus le créneau (index partiel de la base). */
export const TERMINAL_STATUSES = ['cancelled', 'completed', 'no_show'];

/**
 * Raison de refus d'une transition de statut, ou `null` si elle est
 * autorisée. Miroir pur de la logique du backend FastAPI, testable sans DB.
 */
export function transitionRefusal(
  fromStatus: string,
  toStatus: string,
  hasCabinet: boolean,
): string | null {
  if (toStatus === fromStatus) {
    return `Appointment is already in status '${toStatus}'`;
  }
  const allowed = VALID_TRANSITIONS[fromStatus] ?? [];
  if (!allowed.includes(toStatus)) {
    return `Cannot transition from '${fromStatus}' to '${toStatus}'`;
  }
  if (toStatus === 'in_treatment' && !hasCabinet) {
    return "A cabinet must be assigned before moving to 'in_treatment'";
  }
  return null;
}

const uuid = z.string().uuid();

export const appointmentCreateSchema = z.object({
  patient_id: uuid.nullable().optional(),
  professional_id: uuid,
  cabinet_id: uuid.nullable().optional(),
  cabinet: z.string().min(1).max(50).nullable().optional(),
  start_time: z.string().min(1),
  end_time: z.string().min(1),
  treatment_type: z.string().max(100).nullable().optional(),
  planned_item_ids: z.array(uuid).nullable().optional(),
  color: z.string().max(7).nullable().optional(),
});

export const appointmentUpdateSchema = z.object({
  patient_id: uuid.nullable().optional(),
  professional_id: uuid.nullable().optional(),
  cabinet_id: uuid.nullable().optional(),
  cabinet: z.string().min(1).max(50).nullable().optional(),
  start_time: z.string().min(1).nullable().optional(),
  end_time: z.string().min(1).nullable().optional(),
  treatment_type: z.string().max(100).nullable().optional(),
  planned_item_ids: z.array(uuid).nullable().optional(),
  status: z.string().max(20).nullable().optional(),
  color: z.string().max(7).nullable().optional(),
});

export const appointmentTransitionSchema = z.object({
  to_status: z.enum(APPOINTMENT_STATUSES),
  note: z.string().max(500).nullable().optional(),
});

export const cabinetAssignmentSchema = z.object({
  cabinet_id: uuid.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

const hexColor = z
  .string()
  .min(4)
  .max(7)
  .regex(/^#[0-9A-Fa-f]{3,6}$/, 'Couleur hexadécimale attendue');

export const cabinetCreateSchema = z.object({
  name: z.string().min(1).max(50),
  color: hexColor,
  display_order: z.number().int().nullable().optional(),
  is_active: z.boolean().nullable().optional(),
});

export const cabinetUpdateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: hexColor.optional(),
  display_order: z.number().int().nullable().optional(),
  is_active: z.boolean().nullable().optional(),
});

/** PATCH corps pour la note clinique d'une visite. */
export const appointmentTreatmentNoteSchema = z.object({
  notes: z.string().nullable().optional(),
  completed_in_appointment: z.boolean().nullable().optional(),
});

/** Sources acceptées pour un jeton de check-in (ADR 0037). */
export const CHECKIN_SOURCES = ['counter', 'reminder', 'kiosk'] as const;
export const checkinSourceSchema = z.enum(CHECKIN_SOURCES);

/** Date ISO `YYYY-MM-DD` pour le snapshot kanban. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date ISO attendue (YYYY-MM-DD)')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Date invalide');

export type AppointmentCreateInput = z.infer<typeof appointmentCreateSchema>;
export type AppointmentUpdateInput = z.infer<typeof appointmentUpdateSchema>;
export type CabinetCreateInput = z.infer<typeof cabinetCreateSchema>;
export type CabinetUpdateInput = z.infer<typeof cabinetUpdateSchema>;
export type AppointmentTreatmentNoteInput = z.infer<typeof appointmentTreatmentNoteSchema>;
