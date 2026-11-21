/**
 * Schémas du module recalls — port de `app/modules/recalls/schemas.py`.
 *
 * Les littéraux reprennent les tuples de `models.py` (`REASONS`,
 * `PRIORITIES`, `STATUSES`, `CHANNELS`, `OUTCOMES`) ; les helpers purs
 * (`normalizeDueMonth`, `addMonths`, `snoozeNote`, `cancelNote`,
 * `nextStatusAfterOutcome`, `csvCell`, `csvFileName`) sont testables sans DB.
 */

import { z } from 'zod';

// --- Enum literals (mirrors ``models.REASONS`` etc.) ----------------------

export const REASONS = [
  'hygiene',
  'checkup',
  'ortho_review',
  'implant_review',
  'post_op',
  'treatment_followup',
  'other',
] as const;

export const PRIORITIES = ['low', 'normal', 'high'] as const;

export const RECALL_STATUSES = [
  'pending',
  'contacted_no_answer',
  'contacted_scheduled',
  'contacted_declined',
  'done',
  'cancelled',
  'needs_review',
] as const;

export const CHANNELS = ['phone', 'whatsapp', 'sms', 'email'] as const;

export const OUTCOMES = ['no_answer', 'voicemail', 'scheduled', 'declined', 'wrong_number'] as const;

// Status sets used in multiple queries (service.py).
export const ACTIVE_STATUSES = ['pending', 'contacted_no_answer', 'contacted_scheduled'] as const;
export const OPEN_STATUSES = [...ACTIVE_STATUSES, 'needs_review'] as const;
export const TERMINAL_STATUSES = ['done', 'cancelled'] as const;

// Defaults seeded into ``recall_settings`` on first read (models.py).
export const DEFAULT_REASON_INTERVALS: Readonly<Record<string, number>> = {
  hygiene: 6,
  checkup: 12,
  ortho_review: 1,
  implant_review: 6,
  post_op: 1,
  treatment_followup: 3,
  other: 3,
};

export const DEFAULT_CATEGORY_TO_REASON: Readonly<Record<string, string>> = {
  preventivo: 'hygiene',
  ortodoncia: 'ortho_review',
  cirugia: 'post_op',
  implantes: 'implant_review',
};

// --- Request bodies -------------------------------------------------------

const uuid = z.string().uuid();

/**
 * `YYYY-MM-DD` (levé d'un `date` Pydantic). Une date seule est interprétée
 * comme minuit local par `parseClinicDate` ; on ne garde ici que la partie
 * calendaire, un datetime complet étant ramené à sa date UTC.
 */
export const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}/, { message: 'Invalid date' })
  .refine((value) => !Number.isNaN(Date.parse(value.slice(0, 10))), {
    message: 'Invalid date',
  });

export const recallCreateSchema = z.object({
  patient_id: uuid,
  due_month: isoDateSchema,
  due_date: isoDateSchema.nullable().optional(),
  reason: z.enum(REASONS),
  reason_note: z.string().nullable().optional(),
  priority: z.enum(PRIORITIES).default('normal'),
  assigned_professional_id: uuid.nullable().optional(),
  linked_treatment_id: uuid.nullable().optional(),
  linked_treatment_category_key: z.string().max(80).nullable().optional(),
});

export const recallUpdateSchema = z.object({
  due_month: isoDateSchema.nullable().optional(),
  due_date: isoDateSchema.nullable().optional(),
  reason: z.enum(REASONS).nullable().optional(),
  reason_note: z.string().nullable().optional(),
  priority: z.enum(PRIORITIES).nullable().optional(),
  assigned_professional_id: uuid.nullable().optional(),
});

export const recallSnoozeSchema = z.object({
  months: z.number().int().min(1).max(24),
  reason_note: z.string().nullable().optional(),
});

export const recallCancelSchema = z.object({
  note: z.string().nullable().optional(),
});

export const recallLinkAppointmentSchema = z.object({
  appointment_id: uuid,
});

export const attemptCreateSchema = z.object({
  channel: z.enum(CHANNELS),
  outcome: z.enum(OUTCOMES),
  note: z.string().nullable().optional(),
  linked_appointment_id: uuid.nullable().optional(),
});

const intervalMap = z.record(z.string(), z.number().int());

export const recallSettingsUpdateSchema = z.object({
  reason_intervals: intervalMap.nullable().optional(),
  category_to_reason: z.record(z.string(), z.string()).nullable().optional(),
  auto_suggest_on_treatment_completed: z.boolean().nullable().optional(),
  auto_link_on_appointment_scheduled: z.boolean().nullable().optional(),
});

export type RecallCreateInput = z.infer<typeof recallCreateSchema>;
export type RecallUpdateInput = z.infer<typeof recallUpdateSchema>;
export type RecallSnoozeInput = z.infer<typeof recallSnoozeSchema>;
export type RecallCancelInput = z.infer<typeof recallCancelSchema>;
export type AttemptCreateInput = z.infer<typeof attemptCreateSchema>;
export type RecallSettingsUpdateInput = z.infer<typeof recallSettingsUpdateSchema>;

// --- Pure helpers ---------------------------------------------------------

/** `YYYY-MM-DD` → `Date` à minuit UTC (colonnes `date` de Prisma). */
export function dateOnly(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

/** `Date` d'une colonne `date` → `YYYY-MM-DD` (partie UTC, comme Python). */
export function formatDateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/**
 * Toujours le jour 1 du mois — garde l'index sélectif. Le jour est celui
 * de la valeur calendaire : un instant reçu (minuit local d'une date seule)
 * est ramené à sa date UTC, exactement comme `date.today()` côté Python
 * alimente `_normalize_due_month`.
 */
export function normalizeDueMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

/** Ajoute N mois calendaires à une date (jour 1 si c'en est une). */
export function addMonths(value: Date, months: number): Date {
  const base = value.getUTCDate() === 1 ? value : normalizeDueMonth(value);
  const total = base.getUTCFullYear() * 12 + base.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  return new Date(Date.UTC(year, month, 1));
}

/** Date calendaire de la clinique à l'instant `now`. */
export function clinicToday(timeZone: string, now: Date = new Date()): Date {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}

/** Note de report ajoutée en tête (`snooze`) — miroir de `RecallService.snooze`. */
export function snoozeNote(
  currentNote: string | null,
  months: number,
  reasonNote: string | null | undefined,
  byUser: string | null,
  today: Date,
): string | null {
  if (!reasonNote) return currentNote;
  const stamp = `${formatDateOnly(today)} (${byUser ?? 'system'}): `;
  return (
    (currentNote ? `${currentNote}\n` : '') + stamp + `snoozed +${months}mo · ${reasonNote}`
  );
}

/** Note d'annulation — miroir de `RecallService.cancel`. */
export function cancelNote(currentNote: string | null, note: string | null | undefined): string | null {
  if (!note) return currentNote;
  return (currentNote ? `${currentNote}\n` : '') + `cancelled: ${note}`;
}

/**
 * Statut suivant après journalisation d'un contact — miroir de
 * `RecallService.log_attempt`. `scheduled` peut aussi poser la cita.
 */
export function nextStatusAfterOutcome(currentStatus: string, outcome: string): string {
  if (outcome === 'scheduled') return 'contacted_scheduled';
  if (outcome === 'declined') return 'contacted_declined';
  if (outcome === 'no_answer' || outcome === 'voicemail' || outcome === 'wrong_number') {
    if (currentStatus === 'pending') return 'contacted_no_answer';
  }
  return currentStatus;
}

/** Statut suivant après liaison manuelle d'une cita (link-appointment). */
export function nextStatusAfterLink(currentStatus: string): string {
  return currentStatus === 'pending' || currentStatus === 'contacted_no_answer'
    ? 'contacted_scheduled'
    : currentStatus;
}

const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Neutralisation d'une formule tableur (#611) : seules les chaînes bougent. */
export function csvCell(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 0 && FORMULA_LEADERS.has(value[0]!)) {
    return `'${value}`;
  }
  return value;
}

/** Échappement d'un champ CSV (RFC 4180, comme `csv.writer`). */
export function csvField(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'boolean'
        ? value
          ? 'True'
          : 'False'
        : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Ligne CSV complète (`\r\n` comme `csv.writer`). */
export function csvLine(row: readonly unknown[]): string {
  return row.map(csvCell).map(csvField).join(',') + '\r\n';
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** En-tête `Content-Disposition` avec les deux formes (ASCII + RFC 5987). */
export function csvFileName(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const header = `attachment; filename="${ascii}"`;
  return ascii === filename ? header : `${header}; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

/** Nom localisé du CSV (« recalls.csv », « recalls - <clinique>.csv »). */
export function recallCsvName(clinicName: string | null | undefined): string {
  const prefix = 'recalls';
  const name = (clinicName ?? '').trim();
  return name ? `${prefix} - ${name}.csv` : `${prefix}.csv`;
}

