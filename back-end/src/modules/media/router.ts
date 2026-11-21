import { Router, type Request } from 'express';
import { z } from 'zod';

import { badRequest, notFound, unprocessable } from '../../lib/errors';
import { ok, paginated } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import { getPatient } from '../patients/service';
import { getStorageBackend } from './storage';
import { MEDIUM_SUFFIX, THUMB_SUFFIX, isThumbnailable, maxUploadBytes } from './media-helpers';
import { boundaryOf, parseMultipart, readRawBody, type MultipartForm } from './multipart';
import {
  DOCUMENT_TYPES,
  MediaValidationError,
  attachmentCreateSchema,
  documentUpdateSchema,
  parseMediaDatetime,
  photoMetadataUpdateSchema,
  safeFilename,
  validateDocumentType,
  validateFileSize,
  validateMimeType,
} from './schemas';
import {
  createDocument,
  deleteDocument,
  getDocument,
  linkAttachment,
  listAttachmentsByOwner,
  listDocuments,
  listPhotos,
  pairDocuments,
  toAttachmentDto,
  toDocumentDto,
  unlinkAttachment,
  unpairDocument,
  updateDocument,
  updatePhotoMetadata,
} from './service';

/**
 * Routeur du module media — port de
 * `backend/app/modules/media/router.py` (14 routes, monté sous
 * `/api/v1/media` dans `app.ts`).
 */

export const mediaRouter = Router();

const uuid = z.string().uuid();

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** `?page=` et `?page_size=` : erreurs pydantic (`ge`, `le`) → 422. */
function queryInt(req: Request, key: string, fallback: number, min: number, max: number): number {
  const raw = queryString(req, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!/^[+-]?\d+$/.test(raw.trim()) || !Number.isFinite(parsed)) {
    throw unprocessable(`${key}: Input should be a valid integer`);
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (value < min) {
    throw unprocessable(`${key}: Input should be greater than or equal to ${min}`);
  }
  if (value > max) {
    throw unprocessable(`${key}: Input should be less than or equal to ${max}`);
  }
  return value;
}

function queryDatetime(req: Request, key: string): Date | null {
  const raw = queryString(req, key);
  if (raw === undefined) return null;
  const parsed = parseMediaDatetime(raw);
  if (!parsed) throw unprocessable(`${key}: Input should be a valid datetime`);
  return parsed;
}

/** Les helpers purs renvoient des 400 : on les convertit sans changer le message. */
function guardValidation<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof MediaValidationError) throw badRequest(error.message);
    throw error;
  }
}

async function requirePatient(clinicId: string, patientId: string): Promise<void> {
  const patient = await getPatient(clinicId, patientId);
  if (!patient) throw notFound('Patient not found');
}

async function requireDocument(clinicId: string, documentId: string) {
  const document = await getDocument(clinicId, documentId);
  if (!document) throw notFound('Document not found');
  return document;
}

// ---------------------------------------------------------------------------
// Upload multipart (équivalent de `UploadFile` + `Form(...)`)
// ---------------------------------------------------------------------------

const MULTIPART_HEADROOM = 2 * 1024 * 1024;

/**
 * Corps multipart : `app.ts` monte `express.raw()` sur ces deux chemins, donc
 * `req.body` est déjà un `Buffer` ; on retombe sur la lecture du flux si le
 * routeur est monté sans ce middleware (tests isolés).
 */
async function multipartBody(req: Request, maxBody: number): Promise<Buffer> {
  const body: unknown = req.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'binary');
  return readRawBody(req, maxBody);
}

async function readUploadForm(req: Request): Promise<MultipartForm> {
  const declared = Number(req.headers['content-length'] ?? '');
  const max = maxUploadBytes();
  const overLimit = Number.isFinite(declared) && declared > max;
  // Enveloppe multipart : marge au-delà de la limite fichier (frontières et
  // champs texte) ; l'erreur réelle reste `File size exceeds limit of …`.
  const body = await multipartBody(req, max + MULTIPART_HEADROOM);

  const boundary = boundaryOf(req.headers['content-type']);
  if (!boundary) {
    throw unprocessable('Content-Type must be multipart/form-data with a boundary');
  }

  // Comme FastAPI : en-tête `Content-Length` au-delà de la limite → 400
  // avant d'examiner le fichier.
  guardValidation(() => validateFileSize(overLimit ? declared : 0, max));
  return parseMultipart(body, boundary);
}

/** Champ texte obligatoire : 422 si absent (comme un `Form(...)` requis). */
function requiredFormField(form: MultipartForm, name: string): string {
  const value = form.fields.get(name);
  if (value === undefined) {
    throw unprocessable(`${name}: Field required`);
  }
  return value;
}

function cappedFormField(form: MultipartForm, name: string, max: number): string {
  const value = requiredFormField(form, name);
  if (value.length > max) {
    throw unprocessable(`${name}: String should have at most ${max} characters`);
  }
  return value;
}

function optionalFormField(form: MultipartForm, name: string): string | null {
  const value = form.fields.get(name);
  if (value === undefined || value === '') return null;
  return value;
}

function requiredFile(form: MultipartForm): { filename: string; contentType: string | null; data: Buffer } {
  if (!form.file) throw unprocessable('file: Field required');
  return form.file;
}

function validateUploadFile(file: { filename: string; contentType: string | null; data: Buffer }): string {
  const max = maxUploadBytes();
  guardValidation(() => validateFileSize(file.data.length, max));
  return guardValidation(() => validateMimeType(file.contentType, file.filename));
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

mediaRouter.post(
  '/patients/:patientId/documents',
  authenticate,
  requireClinic,
  requirePermission('media.documents.write'),
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await requirePatient(req.clinicId!, patientId);

    const form = await readUploadForm(req);
    const documentType = requiredFormField(form, 'document_type');
    const title = cappedFormField(form, 'title', 255);

    guardValidation(() => validateDocumentType(documentType));
    const file = requiredFile(form);
    const mimeType = validateUploadFile(file);

    const document = await createDocument({
      clinicId: req.clinicId!,
      patientId,
      userId: req.user!.id,
      fileData: file.data,
      originalFilename: file.filename || 'document',
      mimeType,
      documentType,
      title,
      description: optionalFormField(form, 'description'),
    });

    res.status(201).json(ok(toDocumentDto(document)));
  },
);

mediaRouter.get(
  '/patients/:patientId/documents',
  authenticate,
  requireClinic,
  requirePermission('media.documents.read'),
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await requirePatient(req.clinicId!, patientId);

    const documentType = queryString(req, 'document_type') ?? null;
    if (documentType && !(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
      throw badRequest(`Invalid document type. Allowed: ${DOCUMENT_TYPES.join(', ')}`);
    }

    const page = queryInt(req, 'page', 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = queryInt(req, 'page_size', 20, 1, 100);

    const result = await listDocuments(req.clinicId!, patientId, {
      documentType,
      mediaKind: queryString(req, 'media_kind') ?? null,
      page,
      pageSize,
    });

    res.json(paginated(result.rows.map(toDocumentDto), result.total, page, pageSize));
  },
);

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

mediaRouter.post(
  '/patients/:patientId/photos',
  authenticate,
  requireClinic,
  requirePermission('media.documents.write'),
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await requirePatient(req.clinicId!, patientId);

    const form = await readUploadForm(req);
    const title = cappedFormField(form, 'title', 255);
    const mediaKind = optionalFormField(form, 'media_kind') ?? 'photo';

    const file = requiredFile(form);
    const mimeType = validateUploadFile(file);

    const capturedRaw = optionalFormField(form, 'captured_at');
    const capturedAt = capturedRaw === null ? null : parseMediaDatetime(capturedRaw);
    if (capturedRaw !== null && !capturedAt) {
      throw unprocessable('captured_at: Input should be a valid datetime');
    }

    const pairRaw = optionalFormField(form, 'paired_document_id');
    const pairedDocumentId = pairRaw === null ? null : uuid.parse(pairRaw);

    const document = await createDocument({
      clinicId: req.clinicId!,
      patientId,
      userId: req.user!.id,
      fileData: file.data,
      originalFilename: file.filename || 'photo',
      mimeType,
      documentType: 'other',
      title,
      description: optionalFormField(form, 'description'),
      mediaKind,
      mediaCategory: optionalFormField(form, 'media_category'),
      mediaSubtype: optionalFormField(form, 'media_subtype'),
      capturedAt,
      pairedDocumentId,
    });

    res.status(201).json(ok(toDocumentDto(document)));
  },
);

mediaRouter.get(
  '/patients/:patientId/photos',
  authenticate,
  requireClinic,
  requirePermission('media.documents.read'),
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await requirePatient(req.clinicId!, patientId);

    const pairStatus = queryString(req, 'pair_status') ?? 'all';
    if (!['all', 'paired', 'unpaired'].includes(pairStatus)) {
      throw unprocessable(
        "pair_status: Input should be 'all', 'paired' or 'unpaired'",
      );
    }

    const page = queryInt(req, 'page', 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = queryInt(req, 'page_size', 40, 1, 200);

    const result = await listPhotos(req.clinicId!, patientId, {
      mediaKind: queryString(req, 'media_kind') ?? null,
      mediaCategory: queryString(req, 'media_category') ?? null,
      mediaSubtype: queryString(req, 'media_subtype') ?? null,
      capturedFrom: queryDatetime(req, 'captured_from'),
      capturedTo: queryDatetime(req, 'captured_to'),
      pairStatus: pairStatus as 'all' | 'paired' | 'unpaired',
      page,
      pageSize,
    });

    res.json(paginated(result.rows.map(toDocumentDto), result.total, page, pageSize));
  },
);

// ---------------------------------------------------------------------------
// Document detail / download / update / delete
// ---------------------------------------------------------------------------

mediaRouter.get(
  '/documents/:documentId',
  authenticate,
  requireClinic,
  requirePermission('media.documents.read'),
  async (req, res) => {
    const documentId = uuid.parse(req.params.documentId);
    const document = await requireDocument(req.clinicId!, documentId);
    res.json(ok(toDocumentDto(document)));
  },
);

mediaRouter.get(
  '/documents/:documentId/download',
  authenticate,
  requireClinic,
  requirePermission('media.documents.read'),
  async (req, res) => {
    const documentId = uuid.parse(req.params.documentId);
    const document = await requireDocument(req.clinicId!, documentId);

    const variant = queryString(req, 'variant') ?? 'full';
    if (!['thumb', 'medium', 'full'].includes(variant)) {
      throw unprocessable("variant: Input should be 'thumb', 'medium' or 'full'");
    }

    const storage = getStorageBackend();
    const basePath = document.storage_path;

    let storagePath = basePath;
    let mediaType = document.mime_type;
    if (variant === 'thumb' && isThumbnailable(document.mime_type)) {
      storagePath = `${basePath}${THUMB_SUFFIX}`;
      mediaType = 'image/jpeg';
    } else if (variant === 'medium' && isThumbnailable(document.mime_type)) {
      storagePath = `${basePath}${MEDIUM_SUFFIX}`;
      mediaType = 'image/jpeg';
    }

    // Variante non générée (documents existants, ou pas de `sharp` côté
    // Express) : repli sur l'original, comme le `except FileNotFoundError`.
    let content = await storage.retrieve(storagePath);
    if (content === null && storagePath !== basePath) {
      storagePath = basePath;
      mediaType = document.mime_type;
      content = await storage.retrieve(basePath);
    }
    if (content === null) {
      throw notFound('File not found in storage');
    }

    res.setHeader('Content-Type', mediaType);
    res.setHeader('Content-Length', String(content.length));
    if (variant === 'full') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeFilename(document.original_filename)}"`,
      );
    }
    res.status(200).end(content);
  },
);

mediaRouter.put(
  '/documents/:documentId',
  authenticate,
  requireClinic,
  requirePermission('media.documents.write'),
  async (req, res) => {
    const documentId = uuid.parse(req.params.documentId);
    const document = await requireDocument(req.clinicId!, documentId);
    const input = documentUpdateSchema.parse(req.body);
    const updated = await updateDocument(document, input);
    res.json(ok(toDocumentDto(updated)));
  },
);

mediaRouter.patch(
  '/documents/:documentId/photo-metadata',
  authenticate,
  requireClinic,
  requirePermission('media.documents.write'),
  async (req, res) => {
    const documentId = uuid.parse(req.params.documentId);
    const document = await requireDocument(req.clinicId!, documentId);
    const input = photoMetadataUpdateSchema.parse(req.body);

    let capturedAt: Date | null = null;
    if (input.captured_at !== undefined && input.captured_at !== null) {
      capturedAt = parseMediaDatetime(input.captured_at);
      if (!capturedAt) throw unprocessable('captured_at: Input should be a valid datetime');
    }

    const updated = await updatePhotoMetadata(document, {
      mediaCategory: input.media_category ?? null,
      mediaSubtype: input.media_subtype ?? null,
      capturedAt,
      tags: input.tags ?? null,
      pairedDocumentId: input.paired_document_id ?? null,
    });
    res.json(ok(toDocumentDto(updated)));
  },
);

mediaRouter.delete(
  '/documents/:documentId',
  authenticate,
  requireClinic,
  requirePermission('media.documents.write'),
  async (req, res) => {
    const documentId = uuid.parse(req.params.documentId);
    const document = await requireDocument(req.clinicId!, documentId);
    await deleteDocument(document);
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Before / after pairing
// ---------------------------------------------------------------------------

mediaRouter.post(
  '/documents/:documentId/pair/:otherId',
  authenticate,
  requireClinic,
  requirePermission('media.documents.write'),
  async (req, res) => {
    const documentId = uuid.parse(req.params.documentId);
    const otherId = uuid.parse(req.params.otherId);
    const paired = await pairDocuments(req.clinicId!, documentId, otherId);
    res.json(ok(toDocumentDto(paired)));
  },
);

mediaRouter.delete(
  '/documents/:documentId/pair',
  authenticate,
  requireClinic,
  requirePermission('media.documents.write'),
  async (req, res) => {
    const documentId = uuid.parse(req.params.documentId);
    const unpaired = await unpairDocument(req.clinicId!, documentId);
    res.json(ok(toDocumentDto(unpaired)));
  },
);

// ---------------------------------------------------------------------------
// Polymorphic attachments
// ---------------------------------------------------------------------------

mediaRouter.post(
  '/attachments',
  authenticate,
  requireClinic,
  requirePermission('media.attachments.write'),
  async (req, res) => {
    const input = attachmentCreateSchema.parse(req.body);
    const attachment = await linkAttachment({
      clinicId: req.clinicId!,
      documentId: input.document_id,
      ownerType: input.owner_type,
      ownerId: input.owner_id,
      displayOrder: input.display_order,
    });
    res.status(201).json(ok(toAttachmentDto(attachment)));
  },
);

mediaRouter.delete(
  '/attachments/:attachmentId',
  authenticate,
  requireClinic,
  requirePermission('media.attachments.write'),
  async (req, res) => {
    const attachmentId = uuid.parse(req.params.attachmentId);
    await unlinkAttachment(req.clinicId!, attachmentId);
    res.status(204).end();
  },
);

mediaRouter.get(
  '/attachments',
  authenticate,
  requireClinic,
  requirePermission('media.attachments.read'),
  async (req, res) => {
    const ownerTypeRaw = queryString(req, 'owner_type');
    if (ownerTypeRaw === undefined) {
      throw unprocessable('owner_type: Field required');
    }
    const ownerIdRaw = queryString(req, 'owner_id');
    if (ownerIdRaw === undefined) {
      throw unprocessable('owner_id: Field required');
    }
    const ownerId = uuid.parse(ownerIdRaw);

    const attachments = await listAttachmentsByOwner(req.clinicId!, ownerTypeRaw, ownerId);
    res.json(ok(attachments.map(toAttachmentDto)));
  },
);

export default mediaRouter;
