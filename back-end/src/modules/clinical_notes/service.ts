import crypto from 'node:crypto';

import { Prisma, type clinical_notes } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { forbidden } from '../../lib/errors';
import {
  NOTE_OWNER_APPOINTMENT,
  NOTE_OWNER_PATIENT,
  NOTE_OWNER_PLAN,
  NOTE_OWNER_TREATMENT,
  NOTE_OWNER_TYPES,
  NOTE_TYPE_DIAGNOSIS,
  VALID_ATTACHMENT_OWNER_TYPES,
  type ClinicalNoteCreateInput,
} from './schemas';

/** `NoteOwnerError` : propriétaire introuvable dans la clinique. */
export class NoteOwnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteOwnerError';
  }
}

/** `AttachmentPatientMismatchError` : document d'un autre patient. */
export class AttachmentPatientMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentPatientMismatchError';
  }
}

// ---------------------------------------------------------------------------
// DTOs — noms de champs identiques aux schémas Pydantic
// ---------------------------------------------------------------------------

export interface AuthorBriefDto {
  id: string;
  full_name: string | null;
  email: string | null;
}

export interface NoteAttachmentDto {
  id: string;
  document_id: string;
  owner_type: string;
  owner_id: string;
  display_order: number;
  created_at: string;
  title: string | null;
  mime_type: string | null;
  media_kind: string | null;
  thumb_url: string | null;
  medium_url: string | null;
  full_url: string | null;
}

export interface ClinicalNoteDto {
  id: string;
  clinic_id: string;
  note_type: string;
  owner_type: string;
  owner_id: string;
  tooth_number: number | null;
  body: string;
  author_id: string;
  author: AuthorBriefDto | null;
  created_at: string;
  updated_at: string;
  attachments: NoteAttachmentDto[];
}

export interface LinkedEntityBriefDto {
  kind: string;
  id: string | null;
  label: string | null;
  tooth_number: number | null;
}

export interface RecentNoteEntryDto {
  id: string;
  note_type: string;
  owner_type: string;
  owner_id: string;
  tooth_number: number | null;
  body: string;
  created_at: string;
  updated_at: string;
  author: AuthorBriefDto;
  linked: LinkedEntityBriefDto;
  attachments: NoteAttachmentDto[];
}

export interface ClinicalNoteEntryDto {
  source: string;
  note_id: string | null;
  owner_id: string;
  plan_item_id: string | null;
  body: string;
  author_id: string | null;
  author: AuthorBriefDto | null;
  created_at: string;
  updated_at: string | null;
  attachments: NoteAttachmentDto[];
}

export interface PlanSummaryDto {
  id: string;
  plan_number: string;
  title: string | null;
  status: string;
  created_at: string;
}

export interface PlanItemSummaryDto {
  id: string;
  treatment_id: string;
  sequence_order: number;
  status: string;
  label: string | null;
  teeth: number[];
}

export interface PlanItemNotesGroupDto {
  plan_item: PlanItemSummaryDto;
  notes: ClinicalNoteEntryDto[];
}

export interface PlanNotesGroupDto {
  plan: PlanSummaryDto;
  plan_notes: ClinicalNoteEntryDto[];
  treatments: PlanItemNotesGroupDto[];
}

export interface NoteTemplateDto {
  id: string;
  category: string;
  i18n_key: string;
  body_i18n_key: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AuthorRow = { id: string; first_name: string; last_name: string; email: string };

type NoteWithAuthor = clinical_notes & { users: AuthorRow | null };

const noteAuthorSelect = {
  users: { select: { id: true, first_name: true, last_name: true, email: true } },
} satisfies Prisma.clinical_notesInclude;

/**
 * Miroir de `_author_brief` : `full_name` (property Python) retombe sur
 * `first_name + last_name`.
 */
export function toAuthorBrief(author: AuthorRow | null | undefined): AuthorBriefDto | null {
  if (!author) return null;
  const fullName =
    [author.first_name, author.last_name]
      .filter((part) => part !== null && part !== undefined && part !== '')
      .join(' ')
      .trim() || null;
  return { id: author.id, full_name: fullName, email: author.email ?? null };
}

const THUMBNAILABLE = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
]);

type AttachmentWithDocument = {
  id: string;
  document_id: string;
  owner_type: string;
  owner_id: string;
  display_order: number;
  created_at: Date;
  documents: { id: string; title: string; mime_type: string; media_kind: string } | null;
};

/** Miroir de `_decorate_attachment` (brief document + URLs de téléchargement). */
export function toAttachmentDto(attachment: AttachmentWithDocument): NoteAttachmentDto {
  const doc = attachment.documents;
  const dto: NoteAttachmentDto = {
    id: attachment.id,
    document_id: attachment.document_id,
    owner_type: attachment.owner_type,
    owner_id: attachment.owner_id,
    display_order: attachment.display_order,
    created_at: attachment.created_at.toISOString(),
    title: null,
    mime_type: null,
    media_kind: null,
    thumb_url: null,
    medium_url: null,
    full_url: null,
  };
  if (doc) {
    dto.title = doc.title;
    dto.mime_type = doc.mime_type;
    dto.media_kind = doc.media_kind;
    const base = `/api/v1/media/documents/${doc.id}/download`;
    dto.full_url = base;
    if (THUMBNAILABLE.has(doc.mime_type) && (doc.media_kind === 'photo' || doc.media_kind === 'xray')) {
      dto.thumb_url = `${base}?variant=thumb`;
      dto.medium_url = `${base}?variant=medium`;
    }
  }
  return dto;
}

const attachmentInclude = {
  documents: { select: { id: true, title: true, mime_type: true, media_kind: true } },
} satisfies Prisma.media_attachmentsInclude;

/** `AttachmentService.list_by_owner` : ordre display_order puis created_at. */
async function listAttachmentsForOwner(
  clinicId: string,
  ownerType: string,
  ownerId: string,
): Promise<NoteAttachmentDto[]> {
  const rows = await prisma.media_attachments.findMany({
    where: { clinic_id: clinicId, owner_type: ownerType, owner_id: ownerId },
    include: attachmentInclude,
    orderBy: [{ display_order: 'asc' }, { created_at: 'asc' }],
  });
  return rows.map(toAttachmentDto);
}

async function listAttachmentsForNote(
  clinicId: string,
  noteId: string,
): Promise<NoteAttachmentDto[]> {
  return listAttachmentsForOwner(clinicId, 'clinical_note', noteId);
}

/** Miroir de `catalog_name` (priorité es → en → … → première traduction). */
const CATALOG_NAME_PRIORITY = [
  'es', 'en', 'fr', 'pt', 'ta', 'te', 'hi', 'de', 'hu', 'it', 'pl', 'ar',
];

export function catalogName(names: unknown): string | null {
  if (!names || typeof names !== 'object' || Array.isArray(names)) return null;
  const record = names as Record<string, unknown>;
  const usable = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;
  for (const lang of CATALOG_NAME_PRIORITY) {
    const value = record[lang];
    if (usable(value)) return value;
  }
  for (const value of Object.values(record)) {
    if (usable(value)) return value;
  }
  return null;
}

async function toNoteDto(clinicId: string, note: NoteWithAuthor): Promise<ClinicalNoteDto> {
  return {
    id: note.id,
    clinic_id: note.clinic_id,
    note_type: note.note_type,
    owner_type: note.owner_type,
    owner_id: note.owner_id,
    tooth_number: note.tooth_number,
    body: note.body,
    author_id: note.author_id,
    author: toAuthorBrief(note.users),
    created_at: note.created_at.toISOString(),
    updated_at: note.updated_at.toISOString(),
    attachments: await listAttachmentsForNote(clinicId, note.id),
  };
}

// ---------------------------------------------------------------------------
// Résolution du propriétaire
// ---------------------------------------------------------------------------

async function resolvePatientOwner(clinicId: string, patientId: string): Promise<string> {
  const row = await prisma.patients.findFirst({
    where: { id: patientId, clinic_id: clinicId },
    select: { id: true },
  });
  if (!row) throw new NoteOwnerError(`patient ${patientId} not found`);
  return row.id;
}

async function resolveTreatmentOwner(
  clinicId: string,
  treatmentId: string,
): Promise<string> {
  const row = await prisma.treatments.findFirst({
    where: { id: treatmentId, clinic_id: clinicId, deleted_at: null },
    select: { id: true, patient_id: true },
  });
  if (!row) throw new NoteOwnerError(`treatment ${treatmentId} not found`);
  return row.patient_id;
}

async function resolvePlanOwner(clinicId: string, planId: string): Promise<string> {
  const row = await prisma.treatment_plans.findFirst({
    where: { id: planId, clinic_id: clinicId, deleted_at: null },
    select: { id: true, patient_id: true },
  });
  if (!row) throw new NoteOwnerError(`treatment_plan ${planId} not found`);
  return row.patient_id;
}

async function resolveAppointmentOwner(
  clinicId: string,
  appointmentId: string,
): Promise<string> {
  const row = await prisma.appointments.findFirst({
    where: { id: appointmentId, clinic_id: clinicId },
    select: { id: true, patient_id: true },
  });
  if (!row) throw new NoteOwnerError(`appointment ${appointmentId} not found`);
  if (row.patient_id === null) {
    throw new NoteOwnerError(
      `appointment ${appointmentId} has no patient — notes require a patient binding`,
    );
  }
  return row.patient_id;
}

/** Miroir de `resolve_owner_patient` : patient_id joignable depuis l'owner. */
export async function resolveOwnerPatient(
  clinicId: string,
  ownerType: string,
  ownerId: string,
): Promise<string> {
  if (ownerType === NOTE_OWNER_PATIENT) return resolvePatientOwner(clinicId, ownerId);
  if (ownerType === NOTE_OWNER_TREATMENT) return resolveTreatmentOwner(clinicId, ownerId);
  if (ownerType === NOTE_OWNER_PLAN) return resolvePlanOwner(clinicId, ownerId);
  if (ownerType === NOTE_OWNER_APPOINTMENT) return resolveAppointmentOwner(clinicId, ownerId);
  throw new NoteOwnerError(`unsupported owner_type '${ownerType}'`);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listNotesForOwner(
  clinicId: string,
  ownerType: string,
  ownerId: string,
): Promise<ClinicalNoteDto[]> {
  if (!(NOTE_OWNER_TYPES as readonly string[]).includes(ownerType)) {
    throw new NoteOwnerError(`unsupported note owner_type '${ownerType}'`);
  }
  const notes = await prisma.clinical_notes.findMany({
    where: {
      clinic_id: clinicId,
      owner_type: ownerType,
      owner_id: ownerId,
      deleted_at: null,
    },
    include: noteAuthorSelect,
    orderBy: { created_at: 'desc' },
  });
  return Promise.all(notes.map((note) => toNoteDto(clinicId, note)));
}

async function loadDocuments(
  clinicId: string,
  documentIds: string[],
): Promise<Map<string, { id: string; patient_id: string }>> {
  if (documentIds.length === 0) return new Map();
  const rows = await prisma.documents.findMany({
    where: { id: { in: documentIds }, clinic_id: clinicId },
    select: { id: true, patient_id: true },
  });
  return new Map(rows.map((row) => [row.id, row]));
}

/** Miroir de `_link_documents_to_note` (lien owner + lien clinical_note). */
async function linkDocumentsToNote(
  tx: Prisma.TransactionClient,
  clinicId: string,
  documentIds: string[],
  note: clinical_notes,
  expectedPatientId: string,
): Promise<void> {
  const byId = await loadDocuments(clinicId, documentIds);
  // Miroir de Python : `documents not found: ['<uuid>', ...]`.
  const missing = documentIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new NoteOwnerError(`documents not found: [${missing.map((id) => `'${id}'`).join(', ')}]`);
  }
  for (const doc of byId.values()) {
    if (doc.patient_id !== expectedPatientId) {
      throw new AttachmentPatientMismatchError("Document does not belong to the owner's patient");
    }
  }

  const now = new Date();
  for (const [order, documentId] of documentIds.entries()) {
    for (const [ownerType, ownerId] of [
      [note.owner_type, note.owner_id],
      ['clinical_note', note.id],
    ] as const) {
      // Idempotent comme `AttachmentService.link`.
      const existing = await tx.media_attachments.findFirst({
        where: {
          clinic_id: clinicId,
          document_id: documentId,
          owner_type: ownerType,
          owner_id: ownerId,
        },
        select: { id: true },
      });
      if (existing) continue;
      await tx.media_attachments.create({
        data: {
          id: crypto.randomUUID(),
          clinic_id: clinicId,
          document_id: documentId,
          owner_type: ownerType,
          owner_id: ownerId,
          display_order: order,
          created_at: now,
          updated_at: now,
        },
      });
    }
  }
}

export async function createNote(
  clinicId: string,
  userId: string,
  input: ClinicalNoteCreateInput,
): Promise<ClinicalNoteDto> {
  const patientId = await resolveOwnerPatient(clinicId, input.owner_type, input.owner_id);
  const now = new Date();

  const created = await prisma.$transaction(async (tx) => {
    const note = await tx.clinical_notes.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: clinicId,
        note_type: input.note_type,
        owner_type: input.owner_type,
        owner_id: input.owner_id,
        tooth_number: input.note_type === NOTE_TYPE_DIAGNOSIS ? (input.tooth_number ?? null) : null,
        body: input.body,
        author_id: userId,
        created_at: now,
        updated_at: now,
      },
      include: noteAuthorSelect,
    });

    if (input.attachment_document_ids.length > 0) {
      await linkDocumentsToNote(tx, clinicId, input.attachment_document_ids, note, patientId);
    }
    return note;
  });

  return toNoteDto(clinicId, created);
}

/**
 * Édition du corps. Auteur ou admin uniquement.
 * Retourne `null` si la note n'existe pas (→ 404).
 */
export async function updateNote(
  clinicId: string,
  noteId: string,
  body: string,
  userId: string,
  isAdmin: boolean,
): Promise<ClinicalNoteDto | null> {
  const note = await prisma.clinical_notes.findFirst({
    where: { id: noteId, clinic_id: clinicId, deleted_at: null },
    include: noteAuthorSelect,
  });
  if (!note) return null;
  if (note.author_id !== userId && !isAdmin) {
    throw forbidden('Only the author or an admin can edit this note');
  }
  const updated = await prisma.clinical_notes.update({
    where: { id: note.id },
    data: { body, updated_at: new Date() },
    include: noteAuthorSelect,
  });
  return toNoteDto(clinicId, updated);
}

/** Suppression douce. Auteur ou admin uniquement. */
export async function softDeleteNote(
  clinicId: string,
  noteId: string,
  userId: string,
  isAdmin: boolean,
): Promise<boolean> {
  const note = await prisma.clinical_notes.findFirst({
    where: { id: noteId, clinic_id: clinicId, deleted_at: null },
    select: { id: true, author_id: true },
  });
  if (!note) return false;
  if (note.author_id !== userId && !isAdmin) {
    throw forbidden('Only the author or an admin can delete this note');
  }
  await prisma.clinical_notes.update({
    where: { id: note.id },
    data: { deleted_at: new Date() },
  });
  return true;
}

/** Comptage groupé des notes vivantes par owner (owners à 0 omis). */
export async function countNotesForOwners(
  clinicId: string,
  ownerType: string,
  ownerIds: string[],
): Promise<Record<string, number>> {
  if (!(NOTE_OWNER_TYPES as readonly string[]).includes(ownerType)) {
    throw new NoteOwnerError(`unsupported note owner_type '${ownerType}'`);
  }
  if (ownerIds.length === 0) return {};
  const rows = await prisma.clinical_notes.groupBy({
    by: ['owner_id'],
    where: {
      clinic_id: clinicId,
      owner_type: ownerType,
      owner_id: { in: ownerIds },
      deleted_at: null,
    },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.owner_id] = row._count._all;
  return counts;
}

/** Proxy lecture seule des pièces jointes media (tous owner_types). */
export async function listAttachmentsForOwnerPublic(
  clinicId: string,
  ownerType: string,
  ownerId: string,
): Promise<NoteAttachmentDto[]> {
  if (!VALID_ATTACHMENT_OWNER_TYPES.includes(ownerType)) {
    throw new NoteOwnerError(`unsupported attachment owner_type '${ownerType}'`);
  }
  return listAttachmentsForOwner(clinicId, ownerType, ownerId);
}

// ---------------------------------------------------------------------------
// Flux agrégés
// ---------------------------------------------------------------------------

async function resolveTreatmentsForPatient(
  clinicId: string,
  patientId: string,
): Promise<Map<string, {
  clinical_type: string;
  catalogNames: unknown;
  teeth: number[];
}>> {
  const rows = await prisma.treatments.findMany({
    where: { clinic_id: clinicId, patient_id: patientId, deleted_at: null },
    include: {
      treatment_teeth: { select: { tooth_number: true } },
      treatment_catalog_items: { select: { names: true } },
    },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        clinical_type: row.clinical_type,
        catalogNames: row.treatment_catalog_items?.names ?? null,
        teeth: row.treatment_teeth.map((tooth) => tooth.tooth_number),
      },
    ]),
  );
}

function buildLinked(
  note: clinical_notes,
  plansById: Map<string, { id: string; plan_number: string; title: string | null }>,
  treatmentsById: Map<string, { clinical_type: string; catalogNames: unknown; teeth: number[] }>,
  patientId: string,
): LinkedEntityBriefDto {
  if (note.owner_type === NOTE_OWNER_PATIENT) {
    return { kind: 'patient', id: patientId, label: null, tooth_number: note.tooth_number };
  }
  if (note.owner_type === NOTE_OWNER_TREATMENT) {
    const treatment = treatmentsById.get(note.owner_id);
    const teeth = treatment?.teeth ?? [];
    const label = (catalogName(treatment?.catalogNames) ?? treatment?.clinical_type ?? null);
    return {
      kind: 'treatment',
      id: note.owner_id,
      label,
      tooth_number: teeth[0] ?? null,
    };
  }
  if (note.owner_type === NOTE_OWNER_PLAN) {
    const plan = plansById.get(note.owner_id);
    // Python : `plan.title or plan.plan_number` (chaîne vide → plan_number).
    const label = plan ? (plan.title || plan.plan_number) : null;
    return { kind: 'plan', id: note.owner_id, label, tooth_number: null };
  }
  if (note.owner_type === NOTE_OWNER_APPOINTMENT) {
    return { kind: 'appointment', id: note.owner_id, label: null, tooth_number: null };
  }
  return { kind: note.owner_type, id: note.owner_id, label: null, tooth_number: null };
}

export interface RecentNotesOptions {
  noteTypes: string[] | null;
  limit: number;
  before: Date | null;
}

/** Flux "notes récentes" d'un patient, tous owner_types confondus. */
export async function listRecentForPatient(
  clinicId: string,
  patientId: string,
  options: RecentNotesOptions,
): Promise<RecentNoteEntryDto[]> {
  await resolvePatientOwner(clinicId, patientId);

  const treatmentsById = await resolveTreatmentsForPatient(clinicId, patientId);
  const treatmentIds = [...treatmentsById.keys()];

  const plans = await prisma.treatment_plans.findMany({
    where: { clinic_id: clinicId, patient_id: patientId, deleted_at: null },
    select: { id: true, plan_number: true, title: true },
  });
  const planIds = plans.map((plan) => plan.id);
  const plansById = new Map(plans.map((plan) => [plan.id, plan]));

  // Périmètre patient : plans + traitements de ce patient (sous-requête).
  const appointments = await prisma.appointments.findMany({
    where: { clinic_id: clinicId, patient_id: patientId },
    select: { id: true },
  });
  const appointmentIdSet = new Set(appointments.map((row) => row.id));
  const treatmentIdSet = new Set(treatmentIds);

  const where: Prisma.clinical_notesWhereInput = {
    clinic_id: clinicId,
    deleted_at: null,
    OR: [
      { owner_type: NOTE_OWNER_PATIENT, owner_id: patientId },
      ...(treatmentIds.length > 0
        ? [{ owner_type: NOTE_OWNER_TREATMENT, owner_id: { in: treatmentIds } }]
        : []),
      ...(planIds.length > 0
        ? [{ owner_type: NOTE_OWNER_PLAN, owner_id: { in: planIds } }]
        : []),
      ...(appointmentIdSet.size > 0
        ? [{ owner_type: NOTE_OWNER_APPOINTMENT, owner_id: { in: [...appointmentIdSet] } }]
        : []),
    ],
  };
  if (options.noteTypes && options.noteTypes.length > 0) {
    where.note_type = { in: options.noteTypes };
  }
  if (options.before) {
    where.created_at = { lt: options.before };
  }

  const notes = await prisma.clinical_notes.findMany({
    where,
    include: noteAuthorSelect,
    orderBy: { created_at: 'desc' },
    take: options.limit,
  });

  const entries: RecentNoteEntryDto[] = [];
  for (const note of notes) {
    // Filtrage polymorphe identique au `owner_filter` SQL de Python.
    if (note.owner_type === NOTE_OWNER_TREATMENT && !treatmentIdSet.has(note.owner_id)) continue;
    if (note.owner_type === NOTE_OWNER_PLAN && !plansById.has(note.owner_id)) continue;
    if (note.owner_type === NOTE_OWNER_APPOINTMENT && !appointmentIdSet.has(note.owner_id)) {
      continue;
    }
    const author = toAuthorBrief(note.users) ?? { id: note.author_id, full_name: null, email: null };
    entries.push({
      id: note.id,
      note_type: note.note_type,
      owner_type: note.owner_type,
      owner_id: note.owner_id,
      tooth_number: note.tooth_number,
      body: note.body,
      created_at: note.created_at.toISOString(),
      updated_at: note.updated_at.toISOString(),
      author,
      linked: buildLinked(note, plansById, treatmentsById, patientId),
      attachments: await listAttachmentsForNote(clinicId, note.id),
    });
  }
  return entries;
}

/** Notes plan + traitement + visites d'un plan, plus récentes d'abord. */
export async function listMergedForPlan(
  clinicId: string,
  planId: string,
): Promise<ClinicalNoteEntryDto[]> {
  const plan = await prisma.treatment_plans.findFirst({
    where: { id: planId, clinic_id: clinicId, deleted_at: null },
    select: { id: true },
  });
  if (!plan) return [];

  const itemRows = await prisma.planned_treatment_items.findMany({
    where: { treatment_plan_id: planId, clinic_id: clinicId },
    select: { id: true, treatment_id: true },
  });
  const treatmentIds = itemRows.map((row) => row.treatment_id);
  const planItemIdForTreatment = new Map(itemRows.map((row) => [row.treatment_id, row.id]));

  const where: Prisma.clinical_notesWhereInput = {
    clinic_id: clinicId,
    deleted_at: null,
    OR: [
      { owner_type: NOTE_OWNER_PLAN, owner_id: planId },
      ...(treatmentIds.length > 0
        ? [{ owner_type: NOTE_OWNER_TREATMENT, owner_id: { in: treatmentIds } }]
        : []),
    ],
  };
  const notes = await prisma.clinical_notes.findMany({
    where,
    include: noteAuthorSelect,
    orderBy: { created_at: 'desc' },
  });

  const treatmentIdSet = new Set(treatmentIds);
  const entries: ClinicalNoteEntryDto[] = [];
  for (const note of notes) {
    const isTreatment = note.owner_type === NOTE_OWNER_TREATMENT;
    if (isTreatment && !treatmentIdSet.has(note.owner_id)) continue;
    entries.push({
      source: isTreatment ? 'treatment' : 'plan',
      note_id: note.id,
      owner_id: note.owner_id,
      plan_item_id: isTreatment ? (planItemIdForTreatment.get(note.owner_id) ?? null) : null,
      body: note.body,
      author_id: note.author_id,
      author: toAuthorBrief(note.users),
      created_at: note.created_at.toISOString(),
      updated_at: note.updated_at.toISOString(),
      attachments: await listAttachmentsForNote(clinicId, note.id),
    });
  }

  if (itemRows.length > 0) {
    const itemIds = itemRows.map((row) => row.id);
    const visits = await prisma.appointment_treatments.findMany({
      where: {
        planned_treatment_item_id: { in: itemIds },
        notes: { not: null, notIn: [''] },
        appointments: { clinic_id: clinicId },
      },
      include: {
        appointments: {
          select: {
            id: true,
            professional_id: true,
            created_at: true,
            users_appointments_professional_idTousers: {
              select: { id: true, first_name: true, last_name: true, email: true },
            },
          },
        },
      },
    });
    for (const visit of visits) {
      const appointment = visit.appointments;
      const professional = appointment?.users_appointments_professional_idTousers ?? null;
      entries.push({
        source: 'visit',
        note_id: null,
        owner_id: visit.id,
        plan_item_id: visit.planned_treatment_item_id,
        body: visit.notes ?? '',
        author_id: appointment?.professional_id ?? null,
        author: toAuthorBrief(professional),
        created_at: (visit.created_at ?? appointment?.created_at ?? new Date()).toISOString(),
        updated_at: null,
        attachments: [],
      });
    }
  }

  // Tri stable décroissant sur created_at (comme le `sort(reverse=True)` Python).
  entries.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return entries;
}

/** Notes regroupées plan → traitement pour un patient (plans récents d'abord). */
export async function listGroupedForPatient(
  clinicId: string,
  patientId: string,
): Promise<PlanNotesGroupDto[]> {
  const plans = await prisma.treatment_plans.findMany({
    where: { patient_id: patientId, clinic_id: clinicId, deleted_at: null },
    orderBy: { created_at: 'desc' },
  });
  if (plans.length === 0) return [];

  const treatmentsById = await resolveTreatmentsForPatient(clinicId, patientId);

  const groups: PlanNotesGroupDto[] = [];
  for (const plan of plans) {
    const items = await prisma.planned_treatment_items.findMany({
      where: { treatment_plan_id: plan.id, clinic_id: clinicId },
      orderBy: { sequence_order: 'asc' },
    });

    const entries = await listMergedForPlan(clinicId, plan.id);
    const planNotes = entries.filter((entry) => entry.source === 'plan');
    const byItem = new Map<string, ClinicalNoteEntryDto[]>();
    for (const entry of entries) {
      if (entry.source === 'plan') continue;
      if (entry.plan_item_id === null) continue;
      const bucket = byItem.get(entry.plan_item_id) ?? [];
      bucket.push(entry);
      byItem.set(entry.plan_item_id, bucket);
    }

    const treatmentGroups: PlanItemNotesGroupDto[] = items.map((item) => {
      const treatment = treatmentsById.get(item.treatment_id);
      const label = treatment
        ? (catalogName(treatment.catalogNames) ?? treatment.clinical_type ?? null)
        : null;
      const teeth = treatment?.teeth ?? [];
      return {
        plan_item: {
          id: item.id,
          treatment_id: item.treatment_id,
          sequence_order: item.sequence_order,
          status: item.status,
          label,
          teeth,
        },
        notes: byItem.get(item.id) ?? [],
      };
    });

    groups.push({
      plan: {
        id: plan.id,
        plan_number: plan.plan_number,
        title: plan.title,
        status: plan.status,
        created_at: plan.created_at.toISOString(),
      },
      plan_notes: planNotes,
      treatments: treatmentGroups,
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Gabarits statiques (aucune DB) — miroir de note_templates.py
// ---------------------------------------------------------------------------

interface RawTemplate {
  id: string;
  i18n_key: string;
  body_i18n_key: string;
  body: string;
}

export const NOTE_TEMPLATES: Record<string, RawTemplate[]> = {
  endodontics: [
    {
      id: 'endo_single_visit',
      i18n_key: 'clinicalNotes.templates.endo.singleVisit',
      body_i18n_key: 'clinicalNotes.templateBodies.endo_single_visit',
      body:
        'Diagnóstico: \n'
        + 'Anestesia: \n'
        + 'Conductos localizados: \n'
        + 'Longitud de trabajo: \n'
        + 'Obturación: \n'
        + 'Post-op: ',
    },
    {
      id: 'endo_multi_visit',
      i18n_key: 'clinicalNotes.templates.endo.multiVisit',
      body_i18n_key: 'clinicalNotes.templateBodies.endo_multi_visit',
      body: 'Sesión: \nConductos trabajados: \nMedicación intraconducto: \nPróxima cita: ',
    },
  ],
  periodontics: [
    {
      id: 'perio_scaling',
      i18n_key: 'clinicalNotes.templates.perio.scaling',
      body_i18n_key: 'clinicalNotes.templateBodies.perio_scaling',
      body:
        'Cuadrantes tratados: \n'
        + 'Profundidad de sondaje: \n'
        + 'Sangrado al sondaje: \n'
        + 'Indicaciones higiene: ',
    },
  ],
  implantology: [
    {
      id: 'implant_placement',
      i18n_key: 'clinicalNotes.templates.implant.placement',
      body_i18n_key: 'clinicalNotes.templateBodies.implant_placement',
      body:
        'Implante (marca / diámetro / longitud): \n'
        + 'Torque final (Ncm): \n'
        + 'Estabilidad primaria: \n'
        + 'Injerto: \n'
        + 'Post-op: ',
    },
  ],
  diagnosis: [
    {
      id: 'diagnosis_caries',
      i18n_key: 'clinicalNotes.templates.diagnosis.caries',
      body_i18n_key: 'clinicalNotes.templateBodies.diagnosis_caries',
      body:
        'Hallazgo: caries \nProfundidad: \nSíntomas: \nPrueba de vitalidad: \n'
        + 'Tratamiento sugerido: ',
    },
    {
      id: 'diagnosis_periapical',
      i18n_key: 'clinicalNotes.templates.diagnosis.periapical',
      body_i18n_key: 'clinicalNotes.templateBodies.diagnosis_periapical',
      body:
        'Lesión periapical \nDiente: \nRadiografía: \n'
        + 'Pruebas (percusión, palpación): \nDiagnóstico: ',
    },
  ],
  administrative: [
    {
      id: 'admin_phone_call',
      i18n_key: 'clinicalNotes.templates.admin.phoneCall',
      body_i18n_key: 'clinicalNotes.templateBodies.admin_phone_call',
      body: 'Llamada del paciente: \nMotivo: \nAcción tomada: \nSeguimiento: ',
    },
    {
      id: 'admin_reschedule',
      i18n_key: 'clinicalNotes.templates.admin.reschedule',
      body_i18n_key: 'clinicalNotes.templateBodies.admin_reschedule',
      body: 'Solicita cambio de cita: \nFecha actual: \nNueva propuesta: ',
    },
  ],
  general: [
    {
      id: 'general_follow_up',
      i18n_key: 'clinicalNotes.templates.general.followUp',
      body_i18n_key: 'clinicalNotes.templateBodies.general_follow_up',
      body: 'Hallazgos: \nProcedimiento realizado: \nIndicaciones al paciente: ',
    },
  ],
};

/** Liste des gabarits, éventuellement filtrés par catégorie. */
export function listNoteTemplates(category?: string | null): NoteTemplateDto[] {
  const dto = (tpl: RawTemplate, cat: string): NoteTemplateDto => ({
    id: tpl.id,
    category: cat,
    i18n_key: tpl.i18n_key,
    body_i18n_key: tpl.body_i18n_key,
    body: tpl.body,
  });
  if (category) {
    return (NOTE_TEMPLATES[category] ?? []).map((tpl) => dto(tpl, category));
  }
  const out: NoteTemplateDto[] = [];
  for (const [cat, bucket] of Object.entries(NOTE_TEMPLATES)) {
    for (const tpl of bucket) out.push(dto(tpl, cat));
  }
  return out;
}
