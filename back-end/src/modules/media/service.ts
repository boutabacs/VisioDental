import crypto from 'node:crypto';

import { Prisma, type documents, type media_attachments } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { badRequest, notFound, unprocessable } from '../../lib/errors';
import { addTimelineEntry } from '../patient_timeline/service';
import { getStorageBackend } from './storage';
import { isThumbnailable, storeThumbnails, extractCapturedAt } from './media-helpers';
import {
  MEDIA_KIND_PHOTO,
  MEDIA_KIND_XRAY,
  attachmentRegistry,
  generateStoragePath,
  validateMediaClassification,
} from './schemas';

/**
 * Logique métier du module media — port de
 * `backend/app/modules/media/service.py` (`DocumentService`, `PhotoService`,
 * `AttachmentService`).
 *
 * `event_bus.publish(...)` est remplacé par les écritures directes de la
 * timeline que faisait le handler `patient_timeline` (seul abonné aux
 * événements `document.*` / `media.*` enregistrés) : `document.uploaded`,
 * `media.photo_uploaded` et `media.pair_created` produisent une ligne
 * `patient_timeline`, les erreurs d'écriture sont avalées (la timeline est
 * un journal, elle ne doit jamais faire échouer l'action loggée).
 */

const uploaderInclude = {
  users: { select: { id: true, first_name: true, last_name: true } },
} satisfies Prisma.documentsInclude;

export type DocumentWithUploader = Prisma.documentsGetPayload<{ include: typeof uploaderInclude }>;

const attachmentInclude = { documents: true } satisfies Prisma.media_attachmentsInclude;

export type AttachmentWithDocument = Prisma.media_attachmentsGetPayload<{
  include: typeof attachmentInclude;
}>;

/** Champs pouvant être vidés par un `null` explicite (miroir `_CLEARABLE_DOCUMENT_FIELDS`). */
const CLEARABLE_DOCUMENT_FIELDS = new Set(['description']);

// ---------------------------------------------------------------------------
// DTOs (miroir de schemas.py `model_validate` + URLs du routeur)
// ---------------------------------------------------------------------------

function downloadUrl(documentId: string, suffix?: string): string {
  if (suffix) {
    return `/api/v1/media/documents/${documentId}/download?variant=${suffix}`;
  }
  return `/api/v1/media/documents/${documentId}/download`;
}

export interface UploaderBriefDto {
  id: string;
  first_name: string;
  last_name: string;
}

export interface DocumentDto {
  id: string;
  patient_id: string;
  document_type: string;
  title: string;
  description: string | null;
  original_filename: string;
  mime_type: string;
  file_size: number;
  status: string;
  media_kind: string;
  media_category: string | null;
  media_subtype: string | null;
  captured_at: string | null;
  paired_document_id: string | null;
  tags: string[];
  uploaded_by: string;
  uploader: UploaderBriefDto | null;
  created_at: string;
  updated_at: string;
  thumb_url: string | null;
  medium_url: string | null;
  full_url: string | null;
  /**
   * Chemins dérivés `tags` / `storage_path` : Pydantic sert `tags` depuis la
   * colonne JSONB et n'expose jamais `storage_path`. `full_url` pointe sur
   * l'endpoint de téléchargement, donc les deux champs ne servent qu'aux
   * appels internes ; ils restent hors du DTO.
   */
}

export interface DocumentBriefDto {
  id: string;
  document_type: string;
  title: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  media_kind: string;
  media_category: string | null;
  media_subtype: string | null;
  created_at: string;
}

export interface AttachmentDto {
  id: string;
  document_id: string;
  owner_type: string;
  owner_id: string;
  display_order: number;
  created_at: string;
  document: DocumentBriefDto | null;
  thumb_url: string | null;
}

export function documentTags(document: { tags: Prisma.JsonValue }): string[] {
  return Array.isArray(document.tags) ? (document.tags as string[]) : [];
}

/** Port de `_decorate` : URLs dérivées dans le routeur. */
export function toDocumentDto(document: DocumentWithUploader): DocumentDto {
  const uploader = document.users;
  return {
    id: document.id,
    patient_id: document.patient_id,
    document_type: document.document_type,
    title: document.title,
    description: document.description,
    original_filename: document.original_filename,
    mime_type: document.mime_type,
    file_size: document.file_size,
    status: document.status,
    media_kind: document.media_kind,
    media_category: document.media_category,
    media_subtype: document.media_subtype,
    captured_at: document.captured_at?.toISOString() ?? null,
    paired_document_id: document.paired_document_id,
    tags: documentTags(document),
    uploaded_by: document.uploaded_by,
    uploader: uploader
      ? { id: uploader.id, first_name: uploader.first_name, last_name: uploader.last_name }
      : null,
    created_at: document.created_at.toISOString(),
    updated_at: document.updated_at.toISOString(),
    ...decoratedUrls(document),
  };
}

function decoratedUrls(document: documents): Pick<DocumentDto, 'thumb_url' | 'medium_url' | 'full_url'> {
  const urls: Pick<DocumentDto, 'thumb_url' | 'medium_url' | 'full_url'> = {
    thumb_url: null,
    medium_url: null,
    full_url: downloadUrl(document.id),
  };
  if (isThumbnailable(document.mime_type) && (document.media_kind === 'photo' || document.media_kind === 'xray')) {
    urls.thumb_url = downloadUrl(document.id, 'thumb');
    urls.medium_url = downloadUrl(document.id, 'medium');
  }
  return urls;
}

export function toDocumentBriefDto(document: documents): DocumentBriefDto {
  return {
    id: document.id,
    document_type: document.document_type,
    title: document.title,
    original_filename: document.original_filename,
    mime_type: document.mime_type,
    file_size: document.file_size,
    media_kind: document.media_kind,
    media_category: document.media_category,
    media_subtype: document.media_subtype,
    created_at: document.created_at.toISOString(),
  };
}

export function toAttachmentDto(attachment: AttachmentWithDocument): AttachmentDto {
  const document = attachment.documents ?? null;
  return {
    id: attachment.id,
    document_id: attachment.document_id,
    owner_type: attachment.owner_type,
    owner_id: attachment.owner_id,
    display_order: attachment.display_order,
    created_at: attachment.created_at.toISOString(),
    document: document ? toDocumentBriefDto(document) : null,
    thumb_url: document && isThumbnailable(document.mime_type)
      ? downloadUrl(document.id, 'thumb')
      : null,
  };
}

// ---------------------------------------------------------------------------
// Timeline (ancien abonné `patient_timeline.events`)
// ---------------------------------------------------------------------------

function parseTimelineDate(value: string | null): Date {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

async function recordTimeline(input: Parameters<typeof addTimelineEntry>[2] & { clinicId: string; patientId: string }) {
  try {
    await addTimelineEntry(input.clinicId, input.patientId, {
      eventType: input.eventType,
      eventCategory: input.eventCategory,
      sourceTable: input.sourceTable,
      sourceId: input.sourceId,
      title: input.title,
      description: input.description ?? null,
      eventData: input.eventData ?? null,
      occurredAt: input.occurredAt ?? null,
      createdBy: input.createdBy ?? null,
    });
  } catch (error) {
    // Comme `_record` : on journalise et on continue.
    console.error('[media] timeline record failed:', error);
  }
}

interface DocumentUploadedPayload {
  documentId: string;
  clinicId: string;
  patientId: string;
  title: string;
  documentType: string;
  mediaKind: string;
  mediaCategory: string | null;
  mediaSubtype: string | null;
  capturedAt: Date | null;
}

async function publishUpload(payload: DocumentUploadedPayload): Promise<void> {
  const base = {
    clinicId: payload.clinicId,
    patientId: payload.patientId,
    sourceId: payload.documentId,
  };

  // `on_document_uploaded` — les photos / radios ont leur propre carte.
  if (payload.mediaKind !== MEDIA_KIND_PHOTO && payload.mediaKind !== MEDIA_KIND_XRAY) {
    await recordTimeline({
      ...base,
      eventType: 'document.uploaded',
      eventCategory: 'document',
      sourceTable: 'documents',
      title: `Documento: ${payload.title || 'Documento'}`,
      eventData: { document_type: payload.documentType },
    });
  }

  if (payload.mediaKind === MEDIA_KIND_PHOTO || payload.mediaKind === MEDIA_KIND_XRAY) {
    const labelKind = payload.mediaKind === MEDIA_KIND_XRAY ? 'Radiografía' : 'Foto clínica';
    const chipParts = [labelKind];
    if (payload.mediaSubtype) chipParts.push(payload.mediaSubtype);
    else if (payload.mediaCategory) chipParts.push(payload.mediaCategory);

    await recordTimeline({
      ...base,
      eventType: 'media.photo_uploaded',
      eventCategory: 'document',
      sourceTable: 'documents',
      title: `${labelKind}: ${payload.title || 'Foto'}`,
      eventData: {
        media_kind: payload.mediaKind,
        media_category: payload.mediaCategory,
        media_subtype: payload.mediaSubtype,
        captured_at: payload.capturedAt ? payload.capturedAt.toISOString() : null,
        chip: chipParts.join(' · '),
      },
      occurredAt: parseTimelineDate(payload.capturedAt ? payload.capturedAt.toISOString() : null),
    });
  }
}

// ---------------------------------------------------------------------------
// DocumentService
// ---------------------------------------------------------------------------

export async function getDocument(
  clinicId: string,
  documentId: string,
): Promise<DocumentWithUploader | null> {
  return prisma.documents.findFirst({
    where: { id: documentId, clinic_id: clinicId },
    include: uploaderInclude,
  });
}

export async function reloadDocument(documentId: string): Promise<DocumentWithUploader | null> {
  return prisma.documents.findUnique({ where: { id: documentId }, include: uploaderInclude });
}

export interface ListDocumentsFilters {
  documentType?: string | null;
  mediaKind?: string | null;
  page: number;
  pageSize: number;
}

export async function listDocuments(
  clinicId: string,
  patientId: string,
  filters: ListDocumentsFilters,
): Promise<{ rows: DocumentWithUploader[]; total: number }> {
  const pageSize = Math.min(Math.max(filters.pageSize, 1), 100);
  const page = Math.max(filters.page, 1);

  const where: Prisma.documentsWhereInput = {
    clinic_id: clinicId,
    patient_id: patientId,
    status: 'active',
    ...(filters.documentType ? { document_type: filters.documentType } : {}),
    ...(filters.mediaKind ? { media_kind: filters.mediaKind } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.documents.findMany({
      where,
      include: uploaderInclude,
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.documents.count({ where }),
  ]);

  return { rows, total };
}

export interface CreateDocumentInput {
  clinicId: string;
  patientId: string;
  userId: string;
  fileData: Buffer;
  originalFilename: string;
  mimeType: string;
  documentType: string;
  title: string;
  description?: string | null;
  mediaKind?: string;
  mediaCategory?: string | null;
  mediaSubtype?: string | null;
  capturedAt?: Date | null;
  tags?: string[] | null;
  pairedDocumentId?: string | null;
}

/**
 * Port de `DocumentService.create_document` : stocke le fichier, tente les
 * dérivés (no-op sans décodeur d'images) puis crée la ligne.
 */
export async function createDocument(input: CreateDocumentInput): Promise<DocumentWithUploader> {
  const mediaKind = input.mediaKind ?? 'document';
  const mediaCategory = input.mediaCategory ?? null;
  const mediaSubtype = input.mediaSubtype ?? null;

  validateMediaClassification(mediaKind, mediaCategory, mediaSubtype);

  if (input.pairedDocumentId) {
    await validatePairTarget(input.clinicId, input.patientId, input.pairedDocumentId);
  }

  const storage = getStorageBackend();
  const storagePath = generateStoragePath(
    input.clinicId,
    input.patientId,
    input.originalFilename,
    crypto.randomUUID(),
  );
  await storage.store(input.fileData, storagePath);

  const isImageKind = mediaKind === MEDIA_KIND_PHOTO || mediaKind === MEDIA_KIND_XRAY;
  let capturedAt = input.capturedAt ?? null;
  if (isImageKind && capturedAt === null) {
    capturedAt = extractCapturedAt(input.fileData);
  }
  if (isImageKind && isThumbnailable(input.mimeType)) {
    await storeThumbnails(storagePath, input.fileData, input.mimeType);
  }

  const now = new Date();
  const documentId = crypto.randomUUID();

  await prisma.$transaction(async (tx) => {
    await tx.documents.create({
      data: {
        id: documentId,
        clinic_id: input.clinicId,
        patient_id: input.patientId,
        document_type: input.documentType,
        title: input.title,
        description: input.description ?? null,
        original_filename: input.originalFilename,
        storage_path: storagePath,
        mime_type: input.mimeType,
        file_size: input.fileData.length,
        extra_data: Prisma.JsonNull,
        media_kind: mediaKind,
        media_category: mediaCategory,
        media_subtype: mediaSubtype,
        captured_at: capturedAt,
        paired_document_id: input.pairedDocumentId ?? null,
        tags: (input.tags ?? []) as Prisma.InputJsonValue,
        uploaded_by: input.userId,
        status: 'active',
        created_at: now,
        updated_at: now,
      },
    });

    // Miroir de l'appariement une fois l'id connu.
    if (input.pairedDocumentId) {
      await tx.documents.updateMany({
        where: { id: input.pairedDocumentId, clinic_id: input.clinicId },
        data: { paired_document_id: documentId, updated_at: now },
      });
    }
  });

  await publishUpload({
    documentId,
    clinicId: input.clinicId,
    patientId: input.patientId,
    title: input.title,
    documentType: input.documentType,
    mediaKind,
    mediaCategory,
    mediaSubtype,
    capturedAt,
  });

  const created = await reloadDocument(documentId);
  if (!created) throw notFound('Document not found');
  return created;
}

export interface UpdateDocumentInput {
  document_type?: string | null;
  title?: string | null;
  description?: string | null;
}

/** Port de `update_document` : `null` = « non envoyé », sauf `description`. */
export async function updateDocument(
  document: DocumentWithUploader,
  input: UpdateDocumentInput,
): Promise<DocumentWithUploader> {
  const data: Prisma.documentsUpdateInput = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && value !== undefined) {
      (data as Record<string, unknown>)[key] = value;
    } else if (CLEARABLE_DOCUMENT_FIELDS.has(key) && value === null) {
      (data as Record<string, unknown>)[key] = null;
    }
  }

  if (Object.keys(data).length > 0) {
    await prisma.documents.update({
      where: { id: document.id },
      data: { ...data, updated_at: new Date() },
    });
  }

  const updated = await reloadDocument(document.id);
  if (!updated) throw notFound('Document not found');
  return updated;
}

/** Port de `delete_document` : archivage logique (`status = archived`). */
export async function deleteDocument(document: DocumentWithUploader): Promise<void> {
  await prisma.documents.update({
    where: { id: document.id },
    data: { status: 'archived', updated_at: new Date() },
  });
}

export async function downloadDocument(document: documents): Promise<Buffer | null> {
  return getStorageBackend().retrieve(document.storage_path);
}

// ---------------------------------------------------------------------------
// PhotoService
// ---------------------------------------------------------------------------

export interface ListPhotosFilters {
  mediaKind?: string | null;
  mediaCategory?: string | null;
  mediaSubtype?: string | null;
  capturedFrom?: Date | null;
  capturedTo?: Date | null;
  pairStatus: 'all' | 'paired' | 'unpaired';
  page: number;
  pageSize: number;
}

export async function listPhotos(
  clinicId: string,
  patientId: string,
  filters: ListPhotosFilters,
): Promise<{ rows: DocumentWithUploader[]; total: number }> {
  const pageSize = Math.min(Math.max(filters.pageSize, 1), 200);
  const page = Math.max(filters.page, 1);

  const conditions: Prisma.documentsWhereInput[] = [
    {
      clinic_id: clinicId,
      patient_id: patientId,
      status: 'active',
      media_kind: filters.mediaKind
        ? filters.mediaKind
        : { in: [MEDIA_KIND_PHOTO, MEDIA_KIND_XRAY] },
    },
  ];
  if (filters.mediaCategory) conditions.push({ media_category: filters.mediaCategory });
  if (filters.mediaSubtype) conditions.push({ media_subtype: filters.mediaSubtype });
  if (filters.capturedFrom) {
    const from = filters.capturedFrom;
    conditions.push({
      OR: [{ captured_at: { gte: from } }, { captured_at: null, created_at: { gte: from } }],
    });
  }
  if (filters.capturedTo) {
    const to = filters.capturedTo;
    conditions.push({
      OR: [{ captured_at: { lte: to } }, { captured_at: null, created_at: { lte: to } }],
    });
  }
  if (filters.pairStatus === 'paired') conditions.push({ paired_document_id: { not: null } });
  else if (filters.pairStatus === 'unpaired') conditions.push({ paired_document_id: null });

  const where: Prisma.documentsWhereInput = { AND: conditions };

  // `coalesce(captured_at, created_at) DESC` puis `created_at DESC` puis id.
  const [rows, total] = await Promise.all([
    prisma.$queryRaw<documents[]>(Prisma.sql`
      SELECT *
      FROM documents
      WHERE clinic_id = ${clinicId}::uuid
        AND patient_id = ${patientId}::uuid
        AND status = 'active'
        ${filters.mediaKind
          ? Prisma.sql`AND media_kind = ${filters.mediaKind}`
          : Prisma.sql`AND media_kind IN (${MEDIA_KIND_PHOTO}, ${MEDIA_KIND_XRAY})`}
        ${filters.mediaCategory ? Prisma.sql`AND media_category = ${filters.mediaCategory}` : Prisma.empty}
        ${filters.mediaSubtype ? Prisma.sql`AND media_subtype = ${filters.mediaSubtype}` : Prisma.empty}
        ${filters.capturedFrom
          ? Prisma.sql`AND (captured_at >= ${filters.capturedFrom} OR (captured_at IS NULL AND created_at >= ${filters.capturedFrom}))`
          : Prisma.empty}
        ${filters.capturedTo
          ? Prisma.sql`AND (captured_at <= ${filters.capturedTo} OR (captured_at IS NULL AND created_at <= ${filters.capturedTo}))`
          : Prisma.empty}
        ${filters.pairStatus === 'paired' ? Prisma.sql`AND paired_document_id IS NOT NULL` : Prisma.empty}
        ${filters.pairStatus === 'unpaired' ? Prisma.sql`AND paired_document_id IS NULL` : Prisma.empty}
      ORDER BY COALESCE(captured_at, created_at) DESC, created_at DESC, id ASC
      OFFSET ${(page - 1) * pageSize} LIMIT ${pageSize}
    `),
    prisma.documents.count({ where }),
  ]);

  const hydrated = await hydrateUploaders(rows);
  return { rows: hydrated, total };
}

/** Recharge les `uploader` des lignes brutes (une seule requête). */
async function hydrateUploaders(rows: documents[]): Promise<DocumentWithUploader[]> {
  if (rows.length === 0) return [];
  const uploaders = await prisma.users.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.uploaded_by))] } },
    select: { id: true, first_name: true, last_name: true },
  });
  const byId = new Map(uploaders.map((user) => [user.id, user]));
  return rows.map((row) => ({
    ...row,
    users: byId.get(row.uploaded_by) ?? null,
  })) as unknown as DocumentWithUploader[];
}

export interface PhotoMetadataPatch {
  mediaCategory?: string | null;
  mediaSubtype?: string | null;
  capturedAt?: Date | null;
  tags?: string[] | null;
  pairedDocumentId?: string | null;
}

/** Port de `PhotoService.update_metadata` (les `null` signifient « inchangé »). */
export async function updatePhotoMetadata(
  document: DocumentWithUploader,
  patch: PhotoMetadataPatch,
): Promise<DocumentWithUploader> {
  const newCategory = patch.mediaCategory ?? document.media_category;
  const newSubtype = patch.mediaSubtype ?? document.media_subtype;
  validateMediaClassification(document.media_kind, newCategory, newSubtype);

  const data: Prisma.documentsUncheckedUpdateInput = {
    media_category: newCategory,
    media_subtype: newSubtype,
    updated_at: new Date(),
  };
  if (patch.capturedAt) data.captured_at = patch.capturedAt;
  if (patch.tags) data.tags = patch.tags as Prisma.InputJsonValue;
  if (patch.pairedDocumentId) {
    await validatePairTarget(document.clinic_id, document.patient_id, patch.pairedDocumentId);
    data.paired_document_id = patch.pairedDocumentId;
  }

  await prisma.$transaction(async (tx) => {
    await tx.documents.update({ where: { id: document.id }, data });
    if (patch.pairedDocumentId) {
      await tx.documents.updateMany({
        where: { id: patch.pairedDocumentId, clinic_id: document.clinic_id },
        data: { paired_document_id: document.id, updated_at: new Date() },
      });
    }
  });

  const updated = await reloadDocument(document.id);
  if (!updated) throw notFound('Document not found');
  return updated;
}

/** Port de `PhotoService.pair`. */
export async function pairDocuments(
  clinicId: string,
  documentAId: string,
  documentBId: string,
): Promise<DocumentWithUploader> {
  if (documentAId === documentBId) {
    throw badRequest('Cannot pair a document with itself');
  }
  const [a, b] = await Promise.all([
    getDocument(clinicId, documentAId),
    getDocument(clinicId, documentBId),
  ]);
  if (!a || !b) throw notFound('One or both documents not found');
  if (a.patient_id !== b.patient_id) {
    throw unprocessable('Documents must belong to the same patient');
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.documents.update({
      where: { id: a.id },
      data: { paired_document_id: b.id, updated_at: now },
    }),
    prisma.documents.update({
      where: { id: b.id },
      data: { paired_document_id: a.id, updated_at: now },
    }),
  ]);

  await recordTimeline({
    clinicId,
    patientId: a.patient_id,
    eventType: 'media.pair_created',
    eventCategory: 'document',
    sourceTable: 'documents',
    sourceId: a.id,
    title: 'Comparativa antes/después creada',
    eventData: { document_a_id: a.id, document_b_id: b.id },
  });

  const refreshed = await reloadDocument(a.id);
  if (!refreshed) throw notFound('Document not found');
  return refreshed;
}

/** Port de `PhotoService.unpair`. */
export async function unpairDocument(
  clinicId: string,
  documentId: string,
): Promise<DocumentWithUploader> {
  const document = await getDocument(clinicId, documentId);
  if (!document) throw notFound('Document not found');

  const partnerId = document.paired_document_id;
  const now = new Date();
  await prisma.documents.update({
    where: { id: document.id },
    data: { paired_document_id: null, updated_at: now },
  });
  if (partnerId) {
    const partner = await getDocument(clinicId, partnerId);
    if (partner && partner.paired_document_id === document.id) {
      await prisma.documents.update({
        where: { id: partner.id },
        data: { paired_document_id: null, updated_at: now },
      });
    }
  }

  const refreshed = await reloadDocument(document.id);
  if (!refreshed) throw notFound('Document not found');
  return refreshed;
}

async function validatePairTarget(
  clinicId: string,
  patientId: string,
  targetId: string,
): Promise<void> {
  const target = await getDocument(clinicId, targetId);
  if (!target) throw notFound('Pair target document not found');
  if (target.patient_id !== patientId) {
    throw unprocessable('Pair target must belong to the same patient');
  }
}

// ---------------------------------------------------------------------------
// AttachmentService
// ---------------------------------------------------------------------------

/** Port de `AttachmentService.link` (idempotent). */
export async function linkAttachment(input: {
  clinicId: string;
  documentId: string;
  ownerType: string;
  ownerId: string;
  displayOrder?: number;
}): Promise<AttachmentWithDocument> {
  if (!attachmentRegistry.has(input.ownerType)) {
    throw badRequest(
      `Unknown owner_type '${input.ownerType}'. Known: ${attachmentRegistry.knownTypes().join(', ')}`,
    );
  }

  const document = await getDocument(input.clinicId, input.documentId);
  if (!document) throw notFound('Document not found');

  const ownerPatientId = await attachmentRegistry.resolvePatientId(
    input.clinicId,
    input.ownerType,
    input.ownerId,
  );
  if (ownerPatientId === null) {
    throw notFound(`Owner (${input.ownerType}, ${input.ownerId}) not found in this clinic`);
  }
  if (ownerPatientId !== document.patient_id) {
    throw unprocessable('Document and owner belong to different patients');
  }

  const existing = await prisma.media_attachments.findFirst({
    where: {
      clinic_id: input.clinicId,
      document_id: input.documentId,
      owner_type: input.ownerType,
      owner_id: input.ownerId,
    },
    include: attachmentInclude,
  });
  if (existing) return existing;

  const now = new Date();
  return prisma.media_attachments.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: input.clinicId,
      document_id: input.documentId,
      owner_type: input.ownerType,
      owner_id: input.ownerId,
      display_order: input.displayOrder ?? 0,
      created_at: now,
      updated_at: now,
    },
    include: attachmentInclude,
  });
}

/** Port de `AttachmentService.unlink`. */
export async function unlinkAttachment(
  clinicId: string,
  attachmentId: string,
): Promise<void> {
  const attachment = await prisma.media_attachments.findFirst({
    where: { id: attachmentId, clinic_id: clinicId },
    select: { id: true },
  });
  if (!attachment) throw notFound('Attachment not found');
  await prisma.media_attachments.delete({ where: { id: attachment.id } });
}

/** Port de `AttachmentService.list_by_owner`. */
export async function listAttachmentsByOwner(
  clinicId: string,
  ownerType: string,
  ownerId: string,
): Promise<AttachmentWithDocument[]> {
  return prisma.media_attachments.findMany({
    where: { clinic_id: clinicId, owner_type: ownerType, owner_id: ownerId },
    include: attachmentInclude,
    orderBy: [{ display_order: 'asc' }, { created_at: 'asc' }],
  });
}

/** Port de `AttachmentService.unlink_all_for_owner` (helpers des modules owners). */
export async function unlinkAllForOwner(
  clinicId: string,
  ownerType: string,
  ownerId: string,
): Promise<number> {
  const result = await prisma.media_attachments.deleteMany({
    where: { clinic_id: clinicId, owner_type: ownerType, owner_id: ownerId },
  });
  return result.count;
}

/** `media_attachments` brut, pour les appels internes. */
export type MediaAttachmentRow = media_attachments;
