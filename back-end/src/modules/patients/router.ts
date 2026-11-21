import { Router, type Request } from 'express';
import { z } from 'zod';

import { notFound, unprocessable } from '../../lib/errors';
import { ok, paginated } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import { boundaryOf, parseMultipart, readRawBody } from '../media/multipart';
import {
  CsvImportError,
  MAX_CSV_BYTES,
  findDuplicateLines,
  importPatients,
  validatePatientCsv,
} from './csv';
import {
  patientCreateSchema,
  patientExtendedUpdateSchema,
  patientUpdateSchema,
} from './schemas';
import {
  archivePatient,
  createPatient,
  getPatient,
  getRecentPatients,
  listPatients,
  restorePatient,
  toPatientDto,
  toPatientExtendedDto,
  updatePatient,
} from './service';

export const patientsRouter = Router();

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function queryList(req: Request, key: string): string[] {
  const value = req.query[key];
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .flatMap((item) => item.split(','))
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function queryBool(req: Request, key: string, fallback = false): boolean {
  const value = queryString(req, key);
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

function queryInt(req: Request, key: string, fallback: number): number {
  const parsed = Number.parseInt(queryString(req, key) ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const patientIdSchema = z.string().uuid();

patientsRouter.get(
  '/recent',
  authenticate,
  requireClinic,
  requirePermission('patients.read'),
  async (req, res) => {
    const limit = Math.min(Math.max(queryInt(req, 'limit', 8), 1), 20);
    const rows = await getRecentPatients(req.clinicId!, limit);
    res.json(ok(rows.map(toPatientDto)));
  },
);

patientsRouter.get(
  '',
  authenticate,
  requireClinic,
  requirePermission('patients.read'),
  async (req, res) => {
    const page = Math.max(queryInt(req, 'page', 1), 1);
    const pageSize = Math.min(Math.max(queryInt(req, 'page_size', 20), 1), 100);
    const doNotContactRaw = queryString(req, 'do_not_contact');

    const result = await listPatients(req.clinicId!, {
      search: queryString(req, 'search') ?? null,
      page,
      pageSize,
      patientIds:
        queryString(req, 'patient_ids') === undefined
          ? null
          : queryList(req, 'patient_ids'),
      city: queryString(req, 'city') ?? null,
      doNotContact:
        doNotContactRaw === undefined
          ? null
          : doNotContactRaw === 'true' || doNotContactRaw === '1',
      includeArchived: queryBool(req, 'include_archived'),
      statuses: queryList(req, 'status'),
      sort: queryString(req, 'sort') ?? null,
    });

    res.json(paginated(result.rows.map(toPatientDto), result.total, page, pageSize));
  },
);

patientsRouter.post(
  '',
  authenticate,
  requireClinic,
  requirePermission('patients.write'),
  async (req, res) => {
    const input = patientCreateSchema.parse(req.body);
    const patient = await createPatient(req.clinicId!, input);
    res.status(201).json(ok(toPatientDto(patient)));
  },
);

patientsRouter.post(
  '/import.csv',
  authenticate,
  requireClinic,
  requirePermission('patients.write'),
  async (req, res) => {
    const dryRun = queryString(req, 'dry_run') !== 'false';
    const allowDuplicates = queryString(req, 'allow_duplicates') === 'true';

    const boundary = boundaryOf(req.get('content-type'));
    if (!boundary) throw unprocessable('file: Field required');
    const body = Buffer.isBuffer(req.body)
      ? req.body
      : await readRawBody(req, MAX_CSV_BYTES + 1024 * 1024);
    const form = parseMultipart(body, boundary);
    if (!form.file) throw unprocessable('file: Field required');

    try {
      const validation = validatePatientCsv(form.file.data);
      const duplicates = await findDuplicateLines(
        req.clinicId!,
        validation.valid,
        validation.lines,
      );
      const duplicateLines = new Set(duplicates.map((row) => row.row));
      let created = 0;
      let skipped = 0;
      if (!dryRun && validation.valid.length > 0) {
        const toCreate = validation.valid.filter(
          (_row, index) =>
            allowDuplicates || !duplicateLines.has(validation.lines[index]!),
        );
        skipped = validation.valid.length - toCreate.length;
        created = await importPatients(req.clinicId!, toCreate);
      }
      res.json(
        ok({
          total: validation.total,
          valid: validation.valid.length,
          created,
          skipped,
          errors: validation.errors,
          duplicates,
        }),
      );
    } catch (error) {
      if (error instanceof CsvImportError) throw unprocessable(error.message);
      throw error;
    }
  },
);

patientsRouter.get(
  '/:patientId/extended',
  authenticate,
  requireClinic,
  requirePermission('patients.read'),
  async (req, res) => {
    const patientId = patientIdSchema.parse(req.params.patientId);
    const patient = await getPatient(req.clinicId!, patientId);
    if (!patient) throw notFound('Patient not found');
    res.json(ok(toPatientExtendedDto(patient)));
  },
);

patientsRouter.put(
  '/:patientId/extended',
  authenticate,
  requireClinic,
  requirePermission('patients.write'),
  async (req, res) => {
    const patientId = patientIdSchema.parse(req.params.patientId);
    const current = await getPatient(req.clinicId!, patientId);
    if (!current) throw notFound('Patient not found');
    const input = patientExtendedUpdateSchema.parse(req.body);
    const patient = await updatePatient(current, input);
    res.json(ok(toPatientExtendedDto(patient)));
  },
);

patientsRouter.get(
  '/:patientId',
  authenticate,
  requireClinic,
  requirePermission('patients.read'),
  async (req, res) => {
    const patientId = patientIdSchema.parse(req.params.patientId);
    const patient = await getPatient(req.clinicId!, patientId);
    if (!patient) throw notFound('Patient not found');
    res.json(ok(toPatientDto(patient)));
  },
);

patientsRouter.put(
  '/:patientId',
  authenticate,
  requireClinic,
  requirePermission('patients.write'),
  async (req, res) => {
    const patientId = patientIdSchema.parse(req.params.patientId);
    const current = await getPatient(req.clinicId!, patientId);
    if (!current) throw notFound('Patient not found');
    const input = patientUpdateSchema.parse(req.body);
    const patient = await updatePatient(current, input);
    res.json(ok(toPatientDto(patient)));
  },
);

patientsRouter.delete(
  '/:patientId',
  authenticate,
  requireClinic,
  requirePermission('patients.write'),
  async (req, res) => {
    const patientId = patientIdSchema.parse(req.params.patientId);
    const current = await getPatient(req.clinicId!, patientId);
    if (!current) throw notFound('Patient not found');
    await archivePatient(current);
    res.status(204).end();
  },
);

patientsRouter.post(
  '/:patientId/restore',
  authenticate,
  requireClinic,
  requirePermission('patients.write'),
  async (req, res) => {
    const patientId = patientIdSchema.parse(req.params.patientId);
    const current = await getPatient(req.clinicId!, patientId);
    if (!current) throw notFound('Patient not found');
    const patient = await restorePatient(current);
    res.json(ok(toPatientDto(patient)));
  },
);
