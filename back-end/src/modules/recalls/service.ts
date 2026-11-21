/**
 * Couche service du module recalls — port de `app/modules/recalls/service.py`.
 *
 * Multi-tenant obligatoire : chaque requête filtre sur `clinic_id` (et, pour
 * les listes, sur celui du patient joint — défense en profondeur comme le
 * service Python). Les dates renvoyées suivent Pydantic : colonnes `date` en
 * `YYYY-MM-DD`, instants en ISO UTC (`toISOString`).
 */

import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { RecallClosedError, RecallReferenceError } from '../../lib/errors';
import { enqueue } from '../notifications/service';
import {
  ACTIVE_STATUSES,
  DEFAULT_CATEGORY_TO_REASON,
  DEFAULT_REASON_INTERVALS,
  TERMINAL_STATUSES,
  addMonths,
  cancelNote,
  clinicToday,
  dateOnly,
  formatDateOnly,
  nextStatusAfterLink,
  nextStatusAfterOutcome,
  normalizeDueMonth,
  snoozeNote,
  type AttemptCreateInput,
  type RecallCreateInput,
  type RecallSettingsUpdateInput,
  type RecallUpdateInput,
} from './schemas';

// ---------------------------------------------------------------------------
// DTOs (miroir des schémas Pydantic)
// ---------------------------------------------------------------------------

export interface PatientBriefForRecall {
  id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  do_not_contact: boolean;
  status: string;
}

export interface RecallDto {
  id: string;
  clinic_id: string;
  patient_id: string;
  due_month: string;
  due_date: string | null;
  reason: string;
  reason_note: string | null;
  priority: string;
  status: string;
  recommended_by: string | null;
  assigned_professional_id: string | null;
  last_contact_attempt_at: string | null;
  contact_attempt_count: number;
  linked_appointment_id: string | null;
  linked_treatment_id: string | null;
  linked_treatment_category_key: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  patient: PatientBriefForRecall | null;
}

export interface AttemptDto {
  id: string;
  recall_id: string;
  attempted_at: string;
  attempted_by: string;
  channel: string;
  outcome: string;
  note: string | null;
}

export interface RecallDetailDto extends RecallDto {
  attempts: AttemptDto[];
}

export interface RecallSuggestionDto {
  patient_id: string;
  reason: string;
  due_month: string;
  interval_months: number;
  treatment_category_key: string | null;
  treatment_id: string | null;
  matched_setting: boolean;
}

export interface RecallSettingsDto {
  clinic_id: string;
  reason_intervals: Record<string, number>;
  category_to_reason: Record<string, string>;
  auto_suggest_on_treatment_completed: boolean;
  auto_link_on_appointment_scheduled: boolean;
  updated_at: string;
}

export interface RecallDashboardStats {
  due_this_week: number;
  due_this_month: number;
  overdue: number;
  scheduled_this_month: number;
  completed_this_month: number;
  conversion_rate: number;
}

const patientBriefSelect = {
  id: true,
  first_name: true,
  last_name: true,
  phone: true,
  email: true,
  do_not_contact: true,
  status: true,
} satisfies Prisma.patientsSelect;

type PatientBriefRow = Prisma.patientsGetPayload<{ select: typeof patientBriefSelect }>;
export type RecallRow = Prisma.recallsGetPayload<object>;
export type AttemptRow = Prisma.recall_contact_attemptsGetPayload<object>;

export function toPatientBrief(row: PatientBriefRow): PatientBriefForRecall {
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    phone: row.phone,
    email: row.email,
    do_not_contact: row.do_not_contact,
    status: row.status,
  };
}

export function toAttemptDto(row: AttemptRow): AttemptDto {
  return {
    id: row.id,
    recall_id: row.recall_id,
    attempted_at: row.attempted_at.toISOString(),
    attempted_by: row.attempted_by,
    channel: row.channel,
    outcome: row.outcome,
    note: row.note,
  };
}

export function toRecallDto(
  row: RecallRow,
  patient: PatientBriefRow | null = null,
): RecallDto {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    patient_id: row.patient_id,
    due_month: formatDateOnly(row.due_month),
    due_date: row.due_date ? formatDateOnly(row.due_date) : null,
    reason: row.reason,
    reason_note: row.reason_note,
    priority: row.priority,
    status: row.status,
    recommended_by: row.recommended_by,
    assigned_professional_id: row.assigned_professional_id,
    last_contact_attempt_at: row.last_contact_attempt_at
      ? row.last_contact_attempt_at.toISOString()
      : null,
    contact_attempt_count: row.contact_attempt_count,
    linked_appointment_id: row.linked_appointment_id,
    linked_treatment_id: row.linked_treatment_id,
    linked_treatment_category_key: row.linked_treatment_category_key,
    completed_at: row.completed_at ? row.completed_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    patient: patient ? toPatientBrief(patient) : null,
  };
}

export function toRecallDetailDto(
  row: RecallRow,
  attempts: AttemptRow[],
  patient: PatientBriefRow | null = null,
): RecallDetailDto {
  return { ...toRecallDto(row, patient), attempts: attempts.map(toAttemptDto) };
}

// ---------------------------------------------------------------------------
// Filtres
// ---------------------------------------------------------------------------

export interface RecallFilters {
  /** Toute date du mois visé (date seule) ; normalisée en interne. */
  month?: Date | null;
  reason?: string | null;
  professionalId?: string | null;
  status?: string | null;
  priority?: string | null;
  overdue?: boolean;
  patientId?: string | null;
  includeArchivedPatients?: boolean;
  includeDoNotContact?: boolean;
}

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonNumberMap(value: Prisma.JsonValue | null): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(jsonObject(value))) {
    if (typeof item === 'number') result[key] = item;
    else if (typeof item === 'string' && item.trim() !== '' && !Number.isNaN(Number(item))) {
      result[key] = Number(item);
    }
  }
  return result;
}

function jsonStringMap(value: Prisma.JsonValue | null): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(jsonObject(value))) {
    if (typeof item === 'string') result[key] = item;
  }
  return result;
}

function toSettingsDto(row: {
  clinic_id: string;
  reason_intervals: Prisma.JsonValue;
  category_to_reason: Prisma.JsonValue;
  auto_suggest_on_treatment_completed: boolean;
  auto_link_on_appointment_scheduled: boolean;
  updated_at: Date;
}): RecallSettingsDto {
  return {
    clinic_id: row.clinic_id,
    reason_intervals: jsonNumberMap(row.reason_intervals),
    category_to_reason: jsonStringMap(row.category_to_reason),
    auto_suggest_on_treatment_completed: row.auto_suggest_on_treatment_completed,
    auto_link_on_appointment_scheduled: row.auto_link_on_appointment_scheduled,
    updated_at: row.updated_at.toISOString(),
  };
}

export async function clinicTimezone(clinicId: string): Promise<string> {
  const clinic = await prisma.clinics.findUnique({
    where: { id: clinicId },
    select: { timezone: true },
  });
  return clinic?.timezone || 'UTC';
}

async function buildWhere(
  clinicId: string,
  filters: RecallFilters,
): Promise<Prisma.recallsWhereInput> {
  // Les deux prédicats comptent : le clinic_id du rappel borne les lignes et
  // celui du patient empêche la jointure de faire remonter le nom/téléphone
  // d'un patient d'une autre clinique.
  const and: Prisma.recallsWhereInput[] = [
    { clinic_id: clinicId },
    { patients: { clinic_id: clinicId } },
  ];

  if (!filters.includeArchivedPatients) {
    and.push({ patients: { status: { not: 'archived' } } });
  }
  if (!filters.includeDoNotContact) {
    and.push({ patients: { do_not_contact: false } });
  }
  if (filters.month) {
    and.push({ due_month: normalizeDueMonth(filters.month) });
  }
  if (filters.reason) and.push({ reason: filters.reason });
  if (filters.priority) and.push({ priority: filters.priority });
  if (filters.professionalId) and.push({ assigned_professional_id: filters.professionalId });
  if (filters.patientId) and.push({ patient_id: filters.patientId });
  if (filters.status) and.push({ status: filters.status });
  if (filters.overdue) {
    const currentMonth = normalizeDueMonth(clinicToday(await clinicTimezone(clinicId)));
    and.push({ due_month: { lt: currentMonth }, status: { in: [...ACTIVE_STATUSES] } });
  }

  return { AND: and };
}

/**
 * Ordre du service Python : priorité (high, normal, low, autre) puis échéance,
 * création, id. Prisma trie `priority` alphabétiquement (`high` < `low` <
 * `normal`), donc l'ordre utile est demandé en base et re-trisé en mémoire
 * sur la page récupérée — la clé secondaire `id` garantit des pages disjointes.
 */
const priorityRank = (priority: string): number =>
  priority === 'high' ? 0 : priority === 'normal' ? 1 : priority === 'low' ? 2 : 3;

export interface RecallWithPatient {
  recall: RecallRow;
  patient: PatientBriefRow | null;
}

export async function listRecalls(
  clinicId: string,
  filters: RecallFilters,
  page = 1,
  pageSize = 50,
): Promise<{ rows: RecallWithPatient[]; total: number }> {
  const where = await buildWhere(clinicId, filters);
  const [total, rows] = await Promise.all([
    prisma.recalls.count({ where }),
    prisma.recalls.findMany({
      where,
      include: { patients: { select: patientBriefSelect } },
      orderBy: [{ due_month: 'asc' }, { created_at: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const sorted = [...rows].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  return { rows: sorted.map((row) => ({ recall: row, patient: row.patients })), total };
}

export async function getRecall(clinicId: string, recallId: string): Promise<RecallRow | null> {
  return prisma.recalls.findFirst({ where: { id: recallId, clinic_id: clinicId } });
}

export async function getWithAttempts(
  clinicId: string,
  recallId: string,
): Promise<{ recall: RecallRow | null; attempts: AttemptRow[] }> {
  const recall = await getRecall(clinicId, recallId);
  if (!recall) return { recall: null, attempts: [] };
  const attempts = await prisma.recall_contact_attempts.findMany({
    where: { recall_id: recall.id },
    orderBy: [{ attempted_at: 'desc' }, { id: 'asc' }],
  });
  return { recall, attempts };
}

export async function listAttempts(clinicId: string, recallId: string): Promise<AttemptRow[]> {
  return prisma.recall_contact_attempts.findMany({
    where: { clinic_id: clinicId, recall_id: recallId },
    orderBy: [{ attempted_at: 'desc' }, { id: 'asc' }],
  });
}

export async function listForPatient(
  clinicId: string,
  patientId: string,
  limit = 50,
): Promise<RecallRow[]> {
  return prisma.recalls.findMany({
    where: { clinic_id: clinicId, patient_id: patientId },
    orderBy: [{ due_month: 'desc' }, { created_at: 'desc' }, { id: 'asc' }],
    take: limit,
  });
}

/** Garde anti-doublon : un rappel actif du même motif pour ce patient. */
export async function findPendingFor(
  clinicId: string,
  patientId: string,
  reason: string,
): Promise<RecallRow | null> {
  return prisma.recalls.findFirst({
    where: {
      clinic_id: clinicId,
      patient_id: patientId,
      reason,
      status: { in: [...ACTIVE_STATUSES] },
    },
    orderBy: { created_at: 'asc' },
  });
}

// ---------------------------------------------------------------------------
// Références cross-module (400 quand ils ne sont pas de la clinique)
// ---------------------------------------------------------------------------

type Db = Prisma.TransactionClient;

async function checkProfessional(
  db: Db,
  clinicId: string,
  userId: string | null | undefined,
): Promise<void> {
  if (!userId) return;
  const member = await db.clinic_memberships.findFirst({
    where: { clinic_id: clinicId, user_id: userId, is_professional: true },
    select: { id: true },
  });
  if (!member) throw new RecallReferenceError('Invalid professional for this clinic');
}

async function checkAppointment(
  db: Db,
  clinicId: string,
  patientId: string,
  appointmentId: string | null | undefined,
): Promise<void> {
  if (!appointmentId) return;
  const found = await db.appointments.findFirst({
    where: { id: appointmentId, clinic_id: clinicId, patient_id: patientId },
    select: { id: true },
  });
  if (!found) throw new RecallReferenceError('Appointment not found for this patient');
}

/**
 * Verrouille la ligne puis relit son statut : un second appel concurrent
 * attend puis voit le statut posé par le premier (#804). Un rappel
 * `done`/`cancelled` lève `RecallClosedError`.
 */
async function getOpen(db: Db, clinicId: string, recallId: string): Promise<RecallRow | null> {
  // Le statut n'est comparé qu'à `done`/`cancelled` (jamais écrit ici) : l'expression
  // RAW garde le verrou et la relecture dans la même transaction, comme le
  // `with_for_update` de SQLAlchemy (#804).
  const locked = await db.$queryRaw<{ id: string; status: string }[]>`
    SELECT id, status FROM recalls
    WHERE id = ${recallId}::uuid AND clinic_id = ${clinicId}::uuid
    FOR UPDATE`;
  const row = locked[0];
  if (!row) return null;
  if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
    throw new RecallClosedError(row.status);
  }
  const recall = await db.recalls.findFirst({ where: { id: recallId, clinic_id: clinicId } });
  if (!recall) return null;
  return recall;
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

/** Patient d'une autre clinique sur `create` → le routeur répond 404. */
export class RecallPatientNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecallPatientNotFoundError';
  }
}

export interface CreateRecallResult {
  recall: RecallRow;
  created: boolean;
}

/**
 * Crée le rappel ou met à jour la ligne active existante du même motif.
 * `created` vaut false quand la garde anti-doublon a recyclé une ligne.
 */
export async function createRecall(
  clinicId: string,
  data: RecallCreateInput,
  recommendedBy: string | null,
): Promise<CreateRecallResult> {
  const result = await prisma.$transaction(async (tx) => {
    const patient = await tx.patients.findFirst({
      where: { id: data.patient_id, clinic_id: clinicId },
      select: { id: true },
    });
    if (!patient) throw new RecallPatientNotFoundError('Patient not found in this clinic');

    const assignedProfessionalId = data.assigned_professional_id ?? null;
    await checkProfessional(tx, clinicId, assignedProfessionalId);

    const existing = await tx.recalls.findFirst({
      where: {
        clinic_id: clinicId,
        patient_id: data.patient_id,
        reason: data.reason,
        status: { in: [...ACTIVE_STATUSES] },
      },
      orderBy: { created_at: 'asc' },
    });
    const dueMonth = normalizeDueMonth(dateOnly(data.due_month));
    const dueDate = data.due_date ? dateOnly(data.due_date) : null;
    const now = new Date();

    if (existing) {
      const recall = await tx.recalls.update({
        where: { id: existing.id },
        data: {
          due_month: dueMonth,
          due_date: dueDate,
          priority: data.priority ?? existing.priority,
          reason_note: data.reason_note ?? null,
          assigned_professional_id: assignedProfessionalId,
          linked_treatment_id: data.linked_treatment_id ?? null,
          linked_treatment_category_key: data.linked_treatment_category_key ?? null,
          updated_at: now,
        },
      });
      return { recall, created: false };
    }

    const recall = await tx.recalls.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: clinicId,
        patient_id: data.patient_id,
        due_month: dueMonth,
        due_date: dueDate,
        reason: data.reason,
        reason_note: data.reason_note ?? null,
        priority: data.priority ?? 'normal',
        status: 'pending',
        recommended_by: recommendedBy,
        assigned_professional_id: assignedProfessionalId,
        contact_attempt_count: 0,
        linked_treatment_id: data.linked_treatment_id ?? null,
        linked_treatment_category_key: data.linked_treatment_category_key ?? null,
        created_at: now,
        updated_at: now,
      },
    });
    return { recall, created: true };
  });

  // `recall_reminders` (handler Python de `recall.created`) : file le rappel
  // via le gateway notifications. Le port n'ayant pas de session partagée avec
  // `enqueue`, on publie après commit et on ne casse jamais la création si la
  // file échoue (la ligne recall existe déjà).
  if (result.created) {
    await enqueueRecallReminder(clinicId, result.recall).catch((error) => {
      console.error('[recalls] Failed to enqueue recall reminder:', error);
    });
  }
  return result;
}

/** `_humanize_due_month` : `YYYY-MM-DD` → `Month YYYY` (locale C anglaise). */
function humanizeDueMonth(dueMonth: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(dueMonth);
}

async function enqueueRecallReminder(clinicId: string, recall: RecallRow): Promise<void> {
  const [patient, clinic] = await Promise.all([
    prisma.patients.findFirst({
      where: { id: recall.patient_id, clinic_id: clinicId },
      select: { id: true, first_name: true, last_name: true },
    }),
    prisma.clinics.findUnique({ where: { id: clinicId }, select: { name: true } }),
  ]);
  if (!patient) {
    console.error(`[recalls] Patient not found for recall reminder: ${recall.patient_id}`);
    return;
  }
  await enqueue({
    clinicId,
    notificationType: 'recall_reminder',
    context: {
      patient_name: `${patient.first_name} ${patient.last_name}`,
      clinic_name: clinic?.name ?? 'VisioDental',
      reason: recall.reason,
      due_month: humanizeDueMonth(recall.due_month),
    },
    patientId: recall.patient_id,
    triggeredByEvent: 'recall.created',
    dedupKey: `recall_reminder:${recall.id}`,
  });
}

export async function updateRecall(
  clinicId: string,
  recallId: string,
  data: RecallUpdateInput,
): Promise<RecallRow | null> {
  const recall = await getRecall(clinicId, recallId);
  if (!recall) return null;

  // `updated_at` comme SQLAlchemy (`onupdate`) : toujours réécrit.
  const patch: Prisma.recallsUncheckedUpdateInput = { updated_at: new Date() };
  if (data.due_month) patch.due_month = normalizeDueMonth(dateOnly(data.due_month));
  if (data.due_date !== undefined) {
    patch.due_date = data.due_date ? dateOnly(data.due_date) : null;
  }
  if (data.reason) patch.reason = data.reason;
  if (data.reason_note !== undefined) patch.reason_note = data.reason_note;
  if (data.priority) patch.priority = data.priority;
  if (data.assigned_professional_id !== undefined) {
    await checkProfessional(prisma, clinicId, data.assigned_professional_id ?? null);
    patch.assigned_professional_id = data.assigned_professional_id ?? null;
  }

  return prisma.recalls.update({ where: { id: recall.id }, data: patch });
}

export async function snoozeRecall(
  clinicId: string,
  recallId: string,
  timeZone: string,
  months: number,
  reasonNote: string | null | undefined,
  byUser: string | null,
): Promise<RecallRow | null> {
  return prisma.$transaction(async (tx) => {
    const recall = await getOpen(tx, clinicId, recallId);
    if (!recall) return null;
    return tx.recalls.update({
      where: { id: recall.id },
      data: {
        due_month: addMonths(recall.due_month, months),
        reason_note: snoozeNote(
          recall.reason_note,
          months,
          reasonNote,
          byUser,
          clinicToday(timeZone || 'UTC'),
        ),
        status: 'pending',
        updated_at: new Date(),
      },
    });
  });
}

export async function cancelRecall(
  clinicId: string,
  recallId: string,
  note: string | null | undefined,
  _byUser: string | null,
): Promise<RecallRow | null> {
  return prisma.$transaction(async (tx) => {
    const recall = await getOpen(tx, clinicId, recallId);
    if (!recall) return null;
    return tx.recalls.update({
      where: { id: recall.id },
      data: {
        status: 'cancelled',
        reason_note: cancelNote(recall.reason_note, note),
        updated_at: new Date(),
      },
    });
  });
}

export async function markDone(
  clinicId: string,
  recallId: string,
  _byUser: string | null,
  tx?: Db,
): Promise<RecallRow | null> {
  const run = async (db: Db) => {
    const recall = await getOpen(db, clinicId, recallId);
    if (!recall) return null;
    const now = new Date();
    return db.recalls.update({
      where: { id: recall.id },
      data: { status: 'done', completed_at: now, updated_at: now },
    });
  };
  return tx ? run(tx) : prisma.$transaction(run);
}

export interface LogAttemptResult {
  recall: RecallRow;
  attempt: AttemptRow;
}

export async function logAttempt(
  clinicId: string,
  recallId: string,
  attemptData: AttemptCreateInput,
  byUser: string,
): Promise<LogAttemptResult | null> {
  return prisma.$transaction(async (tx) => {
    const recall = await getOpen(tx, clinicId, recallId);
    if (!recall) return null;

    const linked = attemptData.linked_appointment_id ?? null;
    await checkAppointment(tx, clinicId, recall.patient_id, linked);

    const now = new Date();
    const attempt = await tx.recall_contact_attempts.create({
      data: {
        id: crypto.randomUUID(),
        recall_id: recall.id,
        clinic_id: clinicId,
        attempted_at: now,
        attempted_by: byUser,
        channel: attemptData.channel,
        outcome: attemptData.outcome,
        note: attemptData.note ?? null,
      },
    });

    const updated = await tx.recalls.update({
      where: { id: recall.id },
      data: {
        contact_attempt_count: (recall.contact_attempt_count ?? 0) + 1,
        last_contact_attempt_at: now,
        status: nextStatusAfterOutcome(recall.status, attemptData.outcome),
        ...(attemptData.outcome === 'scheduled' && linked
          ? { linked_appointment_id: linked }
          : {}),
        updated_at: now,
      },
    });

    return { recall: updated, attempt };
  });
}

export async function linkAppointment(
  clinicId: string,
  recallId: string,
  appointmentId: string,
): Promise<RecallRow | null> {
  return prisma.$transaction(async (tx) => {
    const recall = await tx.recalls.findFirst({ where: { id: recallId, clinic_id: clinicId } });
    if (!recall) return null;
    await checkAppointment(tx, clinicId, recall.patient_id, appointmentId);
    return tx.recalls.update({
      where: { id: recall.id },
      data: {
        linked_appointment_id: appointmentId,
        status: nextStatusAfterLink(recall.status),
        updated_at: new Date(),
      },
    });
  });
}

/**
 * Appelé quand une cita est planifiée. Politique prudente : ne lie que si le
 * patient a exactement un rappel actif dont l'échéance est au plus le mois de
 * la cita. Zéro ou deux candidats → aucune écriture (liaison manuelle).
 */
export async function autoLinkForAppointment(
  clinicId: string,
  patientId: string,
  appointmentId: string,
  appointmentDate: Date,
  db: Db = prisma,
): Promise<RecallRow | null> {
  const candidates = await db.recalls.findMany({
    where: {
      clinic_id: clinicId,
      patient_id: patientId,
      status: { in: ['pending', 'contacted_no_answer'] },
      due_month: { lte: normalizeDueMonth(appointmentDate) },
      linked_appointment_id: null,
    },
    take: 2,
  });
  if (candidates.length !== 1) return null;
  return db.recalls.update({
    where: { id: candidates[0]!.id },
    data: {
      linked_appointment_id: appointmentId,
      status: 'contacted_scheduled',
      updated_at: new Date(),
    },
  });
}

function startOfMonthTimezone(day: Date, timeZone: string): Date {
  const wall = Date.parse(`${formatDateOnly(day)}T00:00:00Z`);
  const offsetAt = (ms: number): number => {
    const probe = new Date(ms);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(probe);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value ?? '0');
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - ms;
  };
  const candidates = [wall - offsetAt(wall - 86_400_000), wall - offsetAt(wall + 86_400_000)];
  const matching = candidates.filter((candidate) => candidate + offsetAt(candidate) === wall);
  return new Date(matching.length > 0 ? Math.min(...matching) : candidates[0]!);
}

/** Suggestion non contraignante : `null` si patient exclu ou sans mapping. */
export async function suggestNextForTreatment(
  clinicId: string,
  patientId: string,
  treatmentCategoryKey: string | null,
  treatmentId: string | null,
  timeZone: string,
): Promise<RecallSuggestionDto | null> {
  const patient = await prisma.patients.findFirst({
    where: { id: patientId, clinic_id: clinicId },
    select: { status: true, do_not_contact: true },
  });
  if (!patient) return null;
  if (patient.status === 'archived' || patient.do_not_contact) return null;

  const settings = await getOrCreateSettings(clinicId);
  const reason = treatmentCategoryKey
    ? (settings.category_to_reason[treatmentCategoryKey] ?? null)
    : null;
  if (!reason) return null;
  const interval = settings.reason_intervals[reason];
  if (!interval) return null;

  const months = Math.trunc(interval);
  return {
    patient_id: patientId,
    reason,
    due_month: formatDateOnly(addMonths(clinicToday(timeZone || 'UTC'), months)),
    interval_months: months,
    treatment_category_key: treatmentCategoryKey,
    treatment_id: treatmentId,
    matched_setting: true,
  };
}

// ---------------------------------------------------------------------------
// Stats / export
// ---------------------------------------------------------------------------

export async function dashboardStats(
  clinicId: string,
  timeZone: string,
  today?: Date,
): Promise<RecallDashboardStats> {
  const zone = timeZone || 'UTC';
  const day = today ?? clinicToday(zone);
  const monthStart = normalizeDueMonth(day);
  const monthEnd = addMonths(monthStart, 1);
  const weekEnd = new Date(day.getTime() + 7 * 86_400_000);
  // Bornes « ce mois » à minuit dans le fuseau de la clinique (#684).
  const monthStartAt = startOfMonthTimezone(monthStart, zone);
  const monthEndAt = startOfMonthTimezone(monthEnd, zone);

  const base: Prisma.recallsWhereInput = {
    clinic_id: clinicId,
    patients: { status: { not: 'archived' }, do_not_contact: false },
  };
  const countWhere = (extra: Prisma.recallsWhereInput) =>
    prisma.recalls.count({ where: { AND: [base, extra] } });

  const [dueThisWeek, dueThisMonth, overdue, scheduledThisMonth, completedThisMonth, cancelledThisMonth] =
    await Promise.all([
      countWhere({
        status: { in: [...ACTIVE_STATUSES] },
        due_month: { lte: weekEnd, gte: monthStart },
      }),
      countWhere({ status: { in: [...ACTIVE_STATUSES] }, due_month: monthStart }),
      countWhere({ status: { in: [...ACTIVE_STATUSES] }, due_month: { lt: monthStart } }),
      countWhere({
        status: 'contacted_scheduled',
        due_month: { gte: monthStart, lt: monthEnd },
      }),
      countWhere({ status: 'done', completed_at: { gte: monthStartAt, lt: monthEndAt } }),
      countWhere({ status: 'cancelled', updated_at: { gte: monthStartAt, lt: monthEndAt } }),
    ]);

  const denominator = completedThisMonth + cancelledThisMonth;
  const conversion = denominator ? completedThisMonth / denominator : 0;

  return {
    due_this_week: dueThisWeek,
    due_this_month: dueThisMonth,
    overdue,
    scheduled_this_month: scheduledThisMonth,
    completed_this_month: completedThisMonth,
    conversion_rate: Math.round(conversion * 10_000) / 10_000,
  };
}

/** Lignes de l'export CSV — mêmes filtres que `listRecalls` (plafond 10 000). */
export async function exportRows(
  clinicId: string,
  filters: RecallFilters,
): Promise<RecallWithPatient[]> {
  const { rows } = await listRecalls(clinicId, filters, 1, 10_000);
  return rows;
}

// ---------------------------------------------------------------------------
// Réglages par clinique
// ---------------------------------------------------------------------------

export async function getOrCreateSettings(clinicId: string): Promise<RecallSettingsDto> {
  const existing = await prisma.recall_settings.findUnique({ where: { clinic_id: clinicId } });
  if (existing) return toSettingsDto(existing);
  try {
    const created = await prisma.recall_settings.create({
      data: {
        clinic_id: clinicId,
        reason_intervals: { ...DEFAULT_REASON_INTERVALS },
        category_to_reason: { ...DEFAULT_CATEGORY_TO_REASON },
        auto_suggest_on_treatment_completed: true,
        auto_link_on_appointment_scheduled: true,
        updated_at: new Date(),
      },
    });
    return toSettingsDto(created);
  } catch (error) {
    // Deux lectures concurrentes : la perdante relit la ligne gagnante.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await prisma.recall_settings.findUnique({ where: { clinic_id: clinicId } });
      if (raced) return toSettingsDto(raced);
    }
    throw error;
  }
}

export async function updateSettings(
  clinicId: string,
  data: RecallSettingsUpdateInput,
): Promise<RecallSettingsDto> {
  await getOrCreateSettings(clinicId);
  const patch: Prisma.recall_settingsUpdateInput = { updated_at: new Date() };
  if (data.reason_intervals !== undefined && data.reason_intervals !== null) {
    patch.reason_intervals = data.reason_intervals as Prisma.InputJsonValue;
  }
  if (data.category_to_reason !== undefined && data.category_to_reason !== null) {
    patch.category_to_reason = data.category_to_reason as Prisma.InputJsonValue;
  }
  if (
    data.auto_suggest_on_treatment_completed !== undefined
    && data.auto_suggest_on_treatment_completed !== null
  ) {
    patch.auto_suggest_on_treatment_completed = data.auto_suggest_on_treatment_completed;
  }
  if (
    data.auto_link_on_appointment_scheduled !== undefined
    && data.auto_link_on_appointment_scheduled !== null
  ) {
    patch.auto_link_on_appointment_scheduled = data.auto_link_on_appointment_scheduled;
  }
  const updated = await prisma.recall_settings.update({
    where: { clinic_id: clinicId },
    data: patch,
  });
  return toSettingsDto(updated);
}

export async function deleteRecall(clinicId: string, recallId: string): Promise<boolean> {
  const recall = await getRecall(clinicId, recallId);
  if (!recall) return false;
  await prisma.recalls.delete({ where: { id: recall.id } });
  return true;
}

// ---------------------------------------------------------------------------
// Événements agenda (mêmes règles que `events.py`), appelables en transaction.
// ---------------------------------------------------------------------------

/** `appointment.completed` : ferme le rappel lié à la cita terminée. */
export async function onAppointmentCompleted(
  clinicId: string,
  appointmentId: string,
  db: Db = prisma,
): Promise<void> {
  const rows = await db.recalls.findMany({
    where: {
      clinic_id: clinicId,
      linked_appointment_id: appointmentId,
      status: { in: ['contacted_scheduled', 'pending'] },
    },
    select: { id: true },
  });
  for (const row of rows) {
    try {
      await markDone(clinicId, row.id, null, db);
    } catch (error) {
      if (error instanceof RecallClosedError) continue;
      throw error;
    }
  }
}

/** `appointment.cancelled` : détache la cita et remet le rappel en attente. */
export async function onAppointmentCancelled(
  clinicId: string,
  appointmentId: string,
  db: Db = prisma,
): Promise<void> {
  const rows = await db.recalls.findMany({
    where: { clinic_id: clinicId, linked_appointment_id: appointmentId },
  });
  const now = new Date();
  for (const recall of rows) {
    if ((TERMINAL_STATUSES as readonly string[]).includes(recall.status)) continue;
    await db.recalls.update({
      where: { id: recall.id },
      data: {
        linked_appointment_id: null,
        status: recall.status === 'contacted_scheduled' ? 'pending' : recall.status,
        updated_at: now,
      },
    });
  }
}

/** `patient.archived` : les rappels actifs passent en `needs_review`. */
export async function onPatientArchived(
  clinicId: string | null,
  patientId: string,
  db: Db = prisma,
): Promise<void> {
  const rows = await db.recalls.findMany({
    where: {
      patient_id: patientId,
      status: { in: [...ACTIVE_STATUSES] },
      ...(clinicId ? { clinic_id: clinicId } : {}),
    },
    select: { id: true },
  });
  const now = new Date();
  for (const row of rows) {
    await db.recalls.update({
      where: { id: row.id },
      data: { status: 'needs_review', updated_at: now },
    });
  }
}
