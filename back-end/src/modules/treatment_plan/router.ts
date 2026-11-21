import { Router, type Request } from 'express';
import { z } from 'zod';

import { badRequest, conflict, notFound } from '../../lib/errors';
import { ok, paginated } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import {
  closePlanSchema,
  completeItemSchema,
  completeSessionSchema,
  contactLogSchema,
  linkBudgetSchema,
  pipelineQuerySchema,
  plannedItemCreateSchema,
  plannedItemUpdateSchema,
  reorderItemsSchema,
  sessionInputSchema,
  treatmentPlanCreateSchema,
  treatmentPlanStatusUpdateSchema,
  treatmentPlanUpdateSchema,
  updateSessionSchema,
} from './schemas';
import {
  PlanItemBookedError,
  PlanLockedError,
  addItem,
  addSessionManual,
  cancelSession,
  closePlan,
  completeItem,
  completeSession,
  confirmPlan,
  createPlan,
  deletePlan,
  deleteSession,
  generateBudget,
  getPlanDetail,
  linkBudget,
  listPipeline,
  listPlans,
  logContact,
  reactivatePlan,
  removeItem,
  reopenPlan,
  reorderItems,
  requestBudgetSync,
  updateItem,
  updatePlan,
  updatePlanStatus,
  updateSession,
} from './service';

export const treatmentPlanRouter = Router();

const uuid = z.string().uuid();

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function queryInt(req: Request, key: string, fallback: number): number {
  const raw = queryString(req, key);
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `?status=a&status=b` ou `?status=a,b` → liste (filtre multi-statuts). */
function queryList(req: Request, key: string): string[] {
  const value = req.query[key];
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
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

/** Erreurs métier du service → codes HTTP FastAPI (409 / 400). */
async function withPlanErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PlanLockedError || error instanceof PlanItemBookedError) {
      throw conflict(error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Bandeja de planes (pipeline) — déclarée AVANT `/:planId`.
// ---------------------------------------------------------------------------

treatmentPlanRouter.get(
  '/treatment-plans/pipeline',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.read'),
  async (req, res) => {
    const page = Math.max(queryInt(req, 'page', 1), 1);
    const pageSize = Math.min(Math.max(queryInt(req, 'page_size', 20), 1), 100);

    const parsed = pipelineQuerySchema.safeParse({
      tab: queryString(req, 'tab'),
      page,
      page_size: pageSize,
      doctor_id: queryString(req, 'doctor_id'),
      q: queryString(req, 'q'),
    });
    if (!parsed.success) {
      const tab = queryString(req, 'tab');
      if (tab !== undefined && parsed.error.issues.some((issue) => issue.path[0] === 'tab')) {
        throw badRequest(`Unknown tab '${tab}'`);
      }
      throw parsed.error;
    }

    const result = await listPipeline(
      req.clinicId!,
      parsed.data.tab,
      parsed.data.page,
      parsed.data.page_size,
      parsed.data.doctor_id ?? null,
      parsed.data.q ?? null,
    );
    res.json(paginated(result.rows, result.total, parsed.data.page, parsed.data.page_size));
  },
);

// ---------------------------------------------------------------------------
// Plans CRUD
// ---------------------------------------------------------------------------

treatmentPlanRouter.get(
  '/treatment-plans',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.read'),
  async (req, res) => {
    const page = Math.max(queryInt(req, 'page', 1), 1);
    const pageSize = Math.min(Math.max(queryInt(req, 'page_size', 20), 1), 100);
    const patientId = queryString(req, 'patient_id');
    if (patientId) uuid.parse(patientId);

    const result = await listPlans(req.clinicId!, {
      patientId: patientId ?? null,
      statuses: queryList(req, 'status'),
      page,
      pageSize,
    });
    res.json(paginated(result.rows, result.total, page, pageSize));
  },
);

treatmentPlanRouter.get(
  '/treatment-plans/patient/:patientId',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.read'),
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    const page = Math.max(queryInt(req, 'page', 1), 1);
    const pageSize = Math.min(Math.max(queryInt(req, 'page_size', 20), 1), 100);

    const result = await listPlans(req.clinicId!, {
      patientId,
      statuses: [],
      page,
      pageSize,
    });
    res.json(paginated(result.rows, result.total, page, pageSize));
  },
);

treatmentPlanRouter.get(
  '/treatment-plans/:planId',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.read'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const plan = await getPlanDetail(req.clinicId!, planId);
    if (!plan) throw notFound('Treatment plan not found');
    res.json(ok(plan));
  },
);

treatmentPlanRouter.post(
  '/treatment-plans',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const input = treatmentPlanCreateSchema.parse(req.body);
    const plan = await createPlan(req.clinicId!, req.user!.id, input);
    res.status(201).json(ok(plan));
  },
);

treatmentPlanRouter.put(
  '/treatment-plans/:planId',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const input = treatmentPlanUpdateSchema.parse(req.body);
    const plan = await updatePlan(req.clinicId!, planId, input);
    if (!plan) throw notFound('Treatment plan not found');
    res.json(ok(plan));
  },
);

treatmentPlanRouter.patch(
  '/treatment-plans/:planId/status',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const input = treatmentPlanStatusUpdateSchema.parse(req.body);
    const plan = await updatePlanStatus(req.clinicId!, planId, input.status, req.user!.id);
    if (!plan) throw notFound('Treatment plan not found');
    res.json(ok(plan));
  },
);

// ---------------------------------------------------------------------------
// Workflow (confirm / reopen / close / reactivate / contact-log)
// ---------------------------------------------------------------------------

treatmentPlanRouter.post(
  '/treatment-plans/:planId/confirm',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.confirm'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const plan = await confirmPlan(req.clinicId!, planId, req.user!.id);
    res.json(ok(plan));
  },
);

treatmentPlanRouter.post(
  '/treatment-plans/:planId/reopen',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const plan = await reopenPlan(req.clinicId!, planId, req.user!.id);
    res.json(ok(plan));
  },
);

treatmentPlanRouter.post(
  '/treatment-plans/:planId/close',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.close'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const input = closePlanSchema.parse(req.body);
    const plan = await closePlan(
      req.clinicId!,
      planId,
      req.user!.id,
      input.closure_reason,
      input.closure_note ?? null,
    );
    res.json(ok(plan));
  },
);

treatmentPlanRouter.post(
  '/treatment-plans/:planId/reactivate',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.reactivate'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const plan = await reactivatePlan(req.clinicId!, planId, req.user!.id);
    res.json(ok(plan));
  },
);

treatmentPlanRouter.post(
  '/treatment-plans/:planId/contact-log',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const input = contactLogSchema.parse(req.body);
    const logged = await logContact(
      req.clinicId!,
      planId,
      req.user!.id,
      input.channel,
      input.note ?? null,
    );
    if (!logged) throw notFound('Treatment plan not found');
    res.status(204).end();
  },
);

treatmentPlanRouter.delete(
  '/treatment-plans/:planId',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const deleted = await deletePlan(req.clinicId!, planId, req.user!.id);
    if (!deleted) throw notFound('Treatment plan not found');
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Plan items
// ---------------------------------------------------------------------------

treatmentPlanRouter.post(
  '/treatment-plans/:planId/items',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const input = plannedItemCreateSchema.parse(req.body);
    const item = await withPlanErrors(() => addItem(req.clinicId!, planId, input));
    res.status(201).json(ok(item));
  },
);

// Déclarées avant `/:itemId` pour laisser passer les chemins littéraux.
treatmentPlanRouter.patch(
  '/treatment-plans/:planId/items/reorder',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const input = reorderItemsSchema.parse(req.body);
    const reordered = await withPlanErrors(() =>
      reorderItems(req.clinicId!, planId, input.item_ids),
    );
    if (!reordered) throw notFound('Treatment plan not found');
    const plan = await getPlanDetail(req.clinicId!, planId);
    if (!plan) throw notFound('Treatment plan not found');
    res.json(ok(plan));
  },
);

treatmentPlanRouter.put(
  '/treatment-plans/:planId/items/:itemId',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const itemId = uuid.parse(req.params.itemId);
    const input = plannedItemUpdateSchema.parse(req.body);
    const item = await withPlanErrors(() =>
      updateItem(req.clinicId!, planId, itemId, input),
    );
    if (!item) throw notFound('Treatment item not found');
    res.json(ok(item));
  },
);

treatmentPlanRouter.delete(
  '/treatment-plans/:planId/items/:itemId',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const itemId = uuid.parse(req.params.itemId);
    const removed = await withPlanErrors(() =>
      removeItem(req.clinicId!, planId, itemId),
    );
    if (!removed) throw notFound('Treatment item not found');
    res.status(204).end();
  },
);

treatmentPlanRouter.patch(
  '/treatment-plans/:planId/items/:itemId/complete',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const itemId = uuid.parse(req.params.itemId);
    const input = completeItemSchema.parse(req.body);
    const item = await completeItem(
      req.clinicId!,
      planId,
      itemId,
      req.user!.id,
      input.completed_without_appointment,
      input.notes ?? null,
    );
    if (!item) throw notFound('Treatment item not found');
    res.json(ok(item));
  },
);

// ---------------------------------------------------------------------------
// Plan item sessions
// ---------------------------------------------------------------------------

treatmentPlanRouter.patch(
  '/treatment-plans/:planId/items/:itemId/sessions/:sessionId/complete',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const itemId = uuid.parse(req.params.itemId);
    const sessionId = uuid.parse(req.params.sessionId);
    const input = completeSessionSchema.parse(req.body);
    const item = await completeSession(
      req.clinicId!,
      planId,
      itemId,
      sessionId,
      req.user!.id,
      input.completed_without_appointment,
      input.notes ?? null,
    );
    if (!item) throw notFound('Treatment item not found');
    res.json(ok(item));
  },
);

treatmentPlanRouter.patch(
  '/treatment-plans/:planId/items/:itemId/sessions/:sessionId/cancel',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const itemId = uuid.parse(req.params.itemId);
    const sessionId = uuid.parse(req.params.sessionId);
    const input = completeSessionSchema.parse(req.body);
    const item = await cancelSession(
      req.clinicId!,
      planId,
      itemId,
      sessionId,
      req.user!.id,
      input.notes ?? null,
    );
    if (!item) throw notFound('Treatment item not found');
    res.json(ok(item));
  },
);

treatmentPlanRouter.put(
  '/treatment-plans/:planId/items/:itemId/sessions/:sessionId',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const itemId = uuid.parse(req.params.itemId);
    const sessionId = uuid.parse(req.params.sessionId);
    const input = updateSessionSchema.parse(req.body);
    const item = await withPlanErrors(() =>
      updateSession(req.clinicId!, planId, itemId, sessionId, input),
    );
    if (!item) throw notFound('Treatment item not found');
    res.json(ok(item));
  },
);

treatmentPlanRouter.post(
  '/treatment-plans/:planId/items/:itemId/sessions',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const itemId = uuid.parse(req.params.itemId);
    const input = sessionInputSchema.parse(req.body);
    const item = await withPlanErrors(() =>
      addSessionManual(req.clinicId!, planId, itemId, input),
    );
    if (!item) throw notFound('Treatment item not found');
    res.status(201).json(ok(item));
  },
);

treatmentPlanRouter.delete(
  '/treatment-plans/:planId/items/:itemId/sessions/:sessionId',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const itemId = uuid.parse(req.params.itemId);
    const sessionId = uuid.parse(req.params.sessionId);
    const item = await withPlanErrors(() =>
      deleteSession(req.clinicId!, planId, itemId, sessionId),
    );
    if (!item) throw notFound('Treatment item not found');
    res.json(ok(item));
  },
);

// ---------------------------------------------------------------------------
// Budget integration
// ---------------------------------------------------------------------------

treatmentPlanRouter.post(
  '/treatment-plans/:planId/link-budget',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const input = linkBudgetSchema.parse(req.body);
    const plan = await linkBudget(req.clinicId!, planId, input.budget_id);
    if (!plan) throw notFound('Treatment plan not found');
    res.json(ok(plan));
  },
);

treatmentPlanRouter.post(
  '/treatment-plans/:planId/sync-budget',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const success = await requestBudgetSync(req.clinicId!, planId);
    if (!success) throw badRequest('Cannot sync: plan not found or no budget linked');
    res.json(ok({ synced: true }));
  },
);

treatmentPlanRouter.post(
  '/treatment-plans/:planId/generate-budget',
  authenticate,
  requireClinic,
  requirePermission('treatment_plan.plans.write'),
  async (req, res) => {
    const planId = uuid.parse(req.params.planId);
    const result = await generateBudget(req.clinicId!, planId, req.user!.id);
    if (!result) throw notFound('Treatment plan not found');
    res.status(201).json(ok(result));
  },
);
