import { Router, type Request } from 'express';
import { z } from 'zod';

import { notFound } from '../../lib/errors';
import { ok } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import { getPatient } from '../patients/service';
import type { TimelineResponseDto } from './schemas';
import { getTimeline } from './service';

export const patientTimelineRouter = Router();

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function queryInt(req: Request, key: string, fallback: number): number {
  const raw = queryString(req, key);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const patientIdSchema = z.string().uuid();

patientTimelineRouter.get(
  '/patients/:patientId',
  authenticate,
  requireClinic,
  requirePermission('patient_timeline.read'),
  async (req, res) => {
    const patientId = patientIdSchema.parse(req.params.patientId);
    const category = queryString(req, 'category') ?? null;
    if (category !== null && category.length > 30) {
      res.status(422).json({
        detail: [
          {
            type: 'string_too_long',
            loc: ['query', 'category'],
            msg: 'String should have at most 30 characters',
          },
        ],
      });
      return;
    }
    const page = Math.max(queryInt(req, 'page', 1), 1);
    const pageSize = Math.min(Math.max(queryInt(req, 'page_size', 20), 1), 100);

    const patient = await getPatient(req.clinicId!, patientId);
    if (!patient) throw notFound('Patient not found');

    const result = await getTimeline(req.clinicId!, patientId, category, page, pageSize);
    const body: TimelineResponseDto = {
      entries: result.entries,
      total: result.total,
      page,
      page_size: pageSize,
      has_more: page * pageSize < result.total,
    };
    res.json(ok(body));
  },
);
