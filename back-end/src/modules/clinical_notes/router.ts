import { Router, type Request } from 'express';
import { z } from 'zod';

import { badRequest, notFound, unprocessable } from '../../lib/errors';
import { ok } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import {
  ATTACHMENT_OWNER_PATTERN,
  NOTE_OWNER_PATTERN,
  NOTE_TYPES,
  clinicalNoteCreateSchema,
  clinicalNoteUpdateSchema,
} from './schemas';
import {
  AttachmentPatientMismatchError,
  NoteOwnerError,
  countNotesForOwners,
  createNote,
  listAttachmentsForOwnerPublic,
  listGroupedForPatient,
  listMergedForPlan,
  listNoteTemplates,
  listNotesForOwner,
  listRecentForPatient,
  resolveOwnerPatient,
  softDeleteNote,
  updateNote,
} from './service';

export const clinicalNotesRouter = Router();

const uuid = z.string().uuid();

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** Multi-valeur `?key=a&key=b` (liste) ; `undefined` si absent. */
function queryList(req: Request, key: string): string[] | undefined {
  const value = req.query[key];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return undefined;
}

/**
 * `owner_type` de requête validé contre un pattern FastAPI (`Query(pattern=…)`).
 * Un `owner_type` absent est une 422 (paramètre requis).
 */
function requiredOwnerType(req: Request, pattern: RegExp): string {
  const value = queryString(req, 'owner_type');
  if (value === undefined) throw unprocessable('owner_type: Field required');
  if (!pattern.test(value)) {
    throw unprocessable(`owner_type: String should match pattern '${pattern.source}'`);
  }
  return value;
}

/** Remonte les erreurs métier vers les statuts HTTP attendus. */
function mapServiceError(error: unknown): never {
  if (error instanceof NoteOwnerError) throw notFound(error.message);
  if (error instanceof AttachmentPatientMismatchError) throw badRequest(error.message);
  throw error;
}

/** `_is_admin_role(ctx)` : le rôle de l'appartenance est `admin`. */
function isAdmin(req: Request): boolean {
  return req.role === 'admin';
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

clinicalNotesRouter.get(
  '/notes',
  authenticate,
  requireClinic,
  requirePermission('clinical_notes.notes.read'),
  async (req, res) => {
    const ownerType = requiredOwnerType(req, NOTE_OWNER_PATTERN);
    const ownerId = uuid.parse(queryString(req, 'owner_id'));
    try {
      await resolveOwnerPatient(req.clinicId!, ownerType, ownerId);
      const notes = await listNotesForOwner(req.clinicId!, ownerType, ownerId);
      res.json(ok(notes));
    } catch (error) {
      mapServiceError(error);
    }
  },
);

clinicalNotesRouter.post(
  '/notes',
  authenticate,
  requireClinic,
  requirePermission('clinical_notes.notes.write'),
  async (req, res) => {
    const input = clinicalNoteCreateSchema.parse(req.body);
    try {
      const note = await createNote(req.clinicId!, req.user!.id, input);
      res.status(201).json(ok(note));
    } catch (error) {
      mapServiceError(error);
    }
  },
);

clinicalNotesRouter.patch(
  '/notes/:noteId',
  authenticate,
  requireClinic,
  requirePermission('clinical_notes.notes.write'),
  async (req, res) => {
    const noteId = uuid.parse(req.params.noteId);
    const input = clinicalNoteUpdateSchema.parse(req.body);
    const note = await updateNote(req.clinicId!, noteId, input.body, req.user!.id, isAdmin(req));
    if (!note) throw notFound('Note not found');
    res.json(ok(note));
  },
);

clinicalNotesRouter.delete(
  '/notes/:noteId',
  authenticate,
  requireClinic,
  requirePermission('clinical_notes.notes.write'),
  async (req, res) => {
    const noteId = uuid.parse(req.params.noteId);
    const deleted = await softDeleteNote(req.clinicId!, noteId, req.user!.id, isAdmin(req));
    if (!deleted) throw notFound('Note not found');
    res.status(204).end();
  },
);

clinicalNotesRouter.get(
  '/notes/counts',
  authenticate,
  requireClinic,
  requirePermission('clinical_notes.notes.read'),
  async (req, res) => {
    const ownerType = requiredOwnerType(req, NOTE_OWNER_PATTERN);
    const ownerIdsRaw = queryList(req, 'owner_ids');
    if (ownerIdsRaw === undefined) throw unprocessable('owner_ids: Field required');
    if (ownerIdsRaw.length < 1) {
      throw unprocessable('owner_ids: List should have at least 1 item after validation');
    }
    if (ownerIdsRaw.length > 500) {
      throw unprocessable('owner_ids: List should have at most 500 items after validation');
    }
    const ownerIds = ownerIdsRaw.map((value) => uuid.parse(value));
    try {
      const counts = await countNotesForOwners(req.clinicId!, ownerType, ownerIds);
      res.json(ok(counts));
    } catch (error) {
      mapServiceError(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Pièces jointes — proxy lecture seule vers media (transition UI)
// ---------------------------------------------------------------------------

clinicalNotesRouter.get(
  '/attachments',
  authenticate,
  requireClinic,
  requirePermission('clinical_notes.notes.read'),
  async (req, res) => {
    const ownerType = requiredOwnerType(req, ATTACHMENT_OWNER_PATTERN);
    const ownerId = uuid.parse(queryString(req, 'owner_id'));
    try {
      const attachments = await listAttachmentsForOwnerPublic(req.clinicId!, ownerType, ownerId);
      res.json(ok(attachments));
    } catch (error) {
      // Ce endpoint renvoie 400 (et non 404) pour un owner_type inconnu.
      if (error instanceof NoteOwnerError) throw badRequest(error.message);
      throw error;
    }
  },
);

// ---------------------------------------------------------------------------
// Flux agrégés
// ---------------------------------------------------------------------------

clinicalNotesRouter.get(
  '/patients/:patientId/recent',
  authenticate,
  requireClinic,
  requirePermission('clinical_notes.notes.read'),
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);

    const types = queryList(req, 'types') ?? null;
    if (types !== null) {
      const invalid = types.filter((type) => !(NOTE_TYPES as readonly string[]).includes(type));
      if (invalid.length > 0) {
        // Miroir du `HTTPException(422)` Python (repr de la liste).
        throw unprocessable(`Unknown note_type values: [${invalid.map((t) => `'${t}'`).join(', ')}]`);
      }
    }

    const limitRaw = queryString(req, 'limit');
    let limit = 20;
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw);
      if (!/^[+-]?\d+$/.test(limitRaw) || !Number.isInteger(parsed)) {
        throw unprocessable('limit: Input should be a valid integer');
      }
      if (parsed < 1) throw unprocessable('limit: Input should be greater than or equal to 1');
      if (parsed > 100) throw unprocessable('limit: Input should be less than or equal to 100');
      limit = parsed;
    }

    const beforeRaw = queryString(req, 'before');
    let before: Date | null = null;
    if (beforeRaw !== undefined) {
      const parsed = new Date(beforeRaw);
      if (Number.isNaN(parsed.getTime())) {
        throw unprocessable('before: Input should be a valid datetime or date');
      }
      before = parsed;
    }

    try {
      const entries = await listRecentForPatient(req.clinicId!, patientId, {
        noteTypes: types !== null && types.length > 0 ? types : null,
        limit,
        before,
      });
      res.json(ok(entries));
    } catch (error) {
      mapServiceError(error);
    }
  },
);

clinicalNotesRouter.get(
  '/patients/:patientId/by-plan',
  authenticate,
  requireClinic,
  requirePermission('clinical_notes.notes.read'),
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    const groups = await listGroupedForPatient(req.clinicId!, patientId);
    res.json(ok(groups));
  },
);

clinicalNotesRouter.get(
  '/treatment-plans/:planId/merged',
  authenticate,
  requireClinic,
  requirePermission('clinical_notes.notes.read'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const entries = await listMergedForPlan(req.clinicId!, planId);
    res.json(ok(entries));
  },
);

// ---------------------------------------------------------------------------
// Gabarits
// ---------------------------------------------------------------------------

clinicalNotesRouter.get(
  '/note-templates',
  authenticate,
  requireClinic,
  requirePermission('clinical_notes.notes.read'),
  async (req, res) => {
    const category = queryString(req, 'category') ?? null;
    res.json(ok(listNoteTemplates(category)));
  },
);
