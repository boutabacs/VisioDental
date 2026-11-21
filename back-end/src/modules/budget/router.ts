/**
 * Routeur du module `budget` — port de `app/modules/budget/{router,public_router}.py`.
 *
 * Deux surfaces :
 * - `/budgets...` : authentifié (`authenticate` + `requireClinic` +
 *   `requirePermission('budget.*')`), monté sous `/api/v1/budget` ;
 * - `/public/budgets/:token...` : aucun middleware d'auth staff, le token
 *   est le facteur d'accès et la vérification (ADR 0006) pose un cookie
 *   HS256 par token.
 *
 * Les endpoints PDF binaires rendent le HTML du module via Chromium
 * (`src/lib/pdf-renderer.ts`), comme WeasyPrint côté FastAPI. Un 501
 * explicite reste renvoyé si aucun navigateur n'est disponible.
 */

import crypto from 'node:crypto';

import type { Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { config } from '../../config';
import { Prisma } from '@prisma/client';

import { ApiError, badRequest, conflict, notFound, unauthorized, unprocessable } from '../../lib/errors';
import { ok, paginated } from '../../lib/http';
import { prisma } from '../../lib/prisma';
import { PdfEngineUnavailableError, renderPdf } from '../../lib/pdf-renderer';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import { limiter } from '../../middleware/rate-limit';
import {
  BudgetConfigurationError,
  BudgetHistoryService,
  BudgetItemService,
  BudgetNotDeletableError,
  BudgetService,
  BudgetWorkflowError,
  BudgetWorkflowService,
  PlanOwnsLinesError,
  clinicToday,
  dateColumnToString,
  findLatestAcceptanceSignature,
  generateBudgetHtml,
  hashIp,
  loadWorkflowBudget,
  loadWorkflowBudgetByToken,
  lookupLinkedPlan,
  toBudgetDetailDto,
  toBudgetDto,
  toItemDto,
  toSignatureMetaDto,
  toVersionDto,
  type Db,
} from './service';
import {
  PUBLIC_AUTH_METHODS,
  PUBLIC_REJECTION_REASONS,
  PUBLIC_SESSION_TTL_SECONDS,
  acceptInClinicSchema,
  budgetAcceptRequestSchema,
  budgetCancelRequestSchema,
  budgetCreateSchema,
  budgetItemCreateSchema,
  budgetItemUpdateSchema,
  budgetRejectRequestSchema,
  budgetSendRequestSchema,
  budgetUpdateSchema,
  publicAcceptSchema,
  publicRejectSchema,
  isExpired,
  publicVerifySchema,
  resolveSendMethod,
  sendReminderSchema,
  setPublicCodeSchema,
} from './schemas';

export const budgetRouter = Router();

// ---------------------------------------------------------------------------
// Helpers de route
// ---------------------------------------------------------------------------

const uuid = z.string().uuid();

/** Id de chemin (UUID) — un id malformé est un 422 (comme Pydantic). */
function pathId(value: string | string[] | undefined): string {
  return uuid.parse(Array.isArray(value) ? value[0] : value);
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** `?status=a&status=b` / `?status=a,b` → liste. */
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

/** Entier de requête (`ge`/`le` → 422 comme `Query(...)`). */
function queryInt(
  req: Request,
  key: string,
  options: { default: number; ge?: number; le?: number },
): number {
  const raw = queryString(req, key);
  if (raw === undefined || raw === '') return options.default;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw unprocessable(`${key}: Input should be a valid integer`);
  }
  if (options.ge !== undefined && parsed < options.ge) {
    throw unprocessable(`${key}: Input should be greater than or equal to ${options.ge}`);
  }
  if (options.le !== undefined && parsed > options.le) {
    throw unprocessable(`${key}: Input should be less than or equal to ${options.le}`);
  }
  return parsed;
}

/** `YYYY-MM-DD` de requête, ou 422. */
function queryDate(req: Request, key: string): string | null {
  const raw = queryString(req, key);
  if (raw === undefined || raw === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw unprocessable(`${key}: Input should be a valid date`);
  }
  return raw;
}

/** Booléen de requête (`true/false/1/0/yes/no...`), sinon 422. */
function queryBool(req: Request, key: string): boolean | null {
  const raw = queryString(req, key);
  if (raw === undefined || raw === '') return null;
  const value = raw.toLowerCase();
  if (['true', '1', 'yes', 'on', 't', 'y'].includes(value)) return true;
  if (['false', '0', 'no', 'off', 'f', 'n'].includes(value)) return false;
  throw unprocessable(`${key}: Input should be a valid boolean`);
}

/** Paramètre texte de requête avec longueur max (`Query(max_length=...)`). */
function queryText(req: Request, key: string, maxLength: number): string | null {
  const raw = queryString(req, key);
  if (raw === undefined) return null;
  if (raw.length > maxLength) {
    throw unprocessable(`${key}: String should have at most ${maxLength} characters`);
  }
  return raw;
}

/** UUID de requête, sinon 422. */
function queryUuid(req: Request, key: string): string | null {
  const raw = queryString(req, key);
  if (raw === undefined || raw === '') return null;
  const parsed = uuid.safeParse(raw);
  if (!parsed.success) throw unprocessable(`${key}: Input should be a valid UUID`);
  return parsed.data;
}

function queryIds(req: Request, key: string): string[] | null {
  const raw = queryList(req, key);
  if (raw.length === 0) return null;
  return raw.map((value) => {
    const parsed = uuid.safeParse(value);
    if (!parsed.success) throw unprocessable(`${key}: Input should be a valid UUID`);
    return parsed.data;
  });
}

/** Locale PDF (`PDF_LOCALE_PATTERN`), sinon 422. */
function queryLocale(req: Request): string {
  const raw = queryString(req, 'locale');
  if (raw === undefined) return 'es';
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(raw)) {
    throw unprocessable(
      "locale: String should match pattern '^(es|en|ta|te|hi|fr|pt|de|hu|pl|it|ar)$'",
    );
  }
  return raw;
}

/** Corps JSON → objet (Express met `{}` quand le corps est absent). */
function body(req: Request): Record<string, unknown> {
  const raw = req.body as unknown;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw unprocessable('body: Input should be a valid dictionary');
  }
  return raw as Record<string, unknown>;
}

function parse<S extends z.ZodTypeAny>(schema: S, payload: unknown): z.output<S> {
  return schema.parse(payload);
}

/** Erreurs métier → statuts FastAPI. */
async function mapErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PlanOwnsLinesError || error instanceof BudgetNotDeletableError) {
      throw conflict(error.message);
    }
    if (error instanceof BudgetWorkflowError) {
      throw badRequest(error.message);
    }
    throw error;
  }
}

/** Transaction + traduction P2002 (numéro/version) en 409 honnête. */
async function inTransaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(work);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw conflict(
        'Another version of this budget was created concurrently; retry',
      );
    }
    throw error;
  }
}

function clientIp(req: Request): string | null {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

function userAgent(req: Request): string | null {
  const header = req.headers['user-agent'];
  return Array.isArray(header) ? (header[0] ?? null) : (header ?? null);
}

/** Rend le HTML du budget en PDF et l'envoie (501 si Chromium manque). */
async function sendBudgetPdf(
  res: Response,
  row: Parameters<typeof generateBudgetHtml>[0],
  options: {
    isPreview: boolean;
    locale: string;
    withSignature: boolean;
    filename?: string;
    disposition: 'attachment' | 'inline';
    noStore?: boolean;
  },
): Promise<void> {
  const html = await generateBudgetHtml(row, {
    isPreview: options.isPreview,
    locale: options.locale,
    withSignature: options.withSignature,
  });
  let pdf: Buffer;
  try {
    pdf = await renderPdf(html);
  } catch (error) {
    if (error instanceof PdfEngineUnavailableError) {
      throw new ApiError(501, 'PDF generation is not available on the Express backend yet');
    }
    throw error;
  }
  res.setHeader(
    'Content-Disposition',
    options.filename
      ? `${options.disposition}; filename="${options.filename}"`
      : options.disposition,
  );
  if (options.noStore) res.setHeader('Cache-Control', 'private, no-store');
  res.type('application/pdf').send(pdf);
}

// ---------------------------------------------------------------------------
// Garde d'auth réutilisé par toutes les routes staff
// ---------------------------------------------------------------------------

const staffGuard: RequestHandler[] = [
  authenticate,
  requireClinic,
];

// ============================================================================
// Budgets — CRUD
// ============================================================================

budgetRouter.get(
  '/budgets',
  ...staffGuard,
  requirePermission('budget.read'),
  async (req, res) => {
    const page = queryInt(req, 'page', { default: 1, ge: 1 });
    const pageSize = queryInt(req, 'page_size', { default: 20, ge: 1, le: 100 });

    const { rows, total } = await BudgetService.listBudgets(prisma, req.clinic!.id, {
      page,
      pageSize,
      patientId: queryUuid(req, 'patient_id'),
      statuses: queryList(req, 'status'),
      createdBy: queryUuid(req, 'created_by'),
      dateFrom: queryDate(req, 'date_from'),
      dateTo: queryDate(req, 'date_to'),
      expired: queryBool(req, 'expired'),
      search: queryText(req, 'search', 100),
      budgetIds: queryIds(req, 'budget_ids'),
      assignedProfessionalId: queryUuid(req, 'assigned_professional_id'),
      validUntilBefore: queryDate(req, 'valid_until_before'),
      validUntilAfter: queryDate(req, 'valid_until_after'),
      sort: queryText(req, 'sort', 50),
    });
    // `Query(default=1)` / `Query(default=20)` : l'enveloppe renvoie les
    // valeurs reçues (borner la page_size à 100 reste une erreur 422).
    res.json(paginated(rows, total, page, pageSize));
  },
);

budgetRouter.get(
  '/budgets/:budgetId',
  ...staffGuard,
  requirePermission('budget.read'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const detail = await BudgetService.getBudgetDetail(prisma, req.clinic!.id, budgetId);
    if (!detail) throw notFound('Budget not found');
    res.json(ok(detail));
  },
);

budgetRouter.post(
  '/budgets',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const data = parse(budgetCreateSchema, body(req));

    const patient = await prisma.patients.findUnique({
      where: { id: data.patient_id },
      select: { clinic_id: true },
    });
    if (!patient || patient.clinic_id !== req.clinic!.id) {
      throw badRequest('Patient not found');
    }

    const budgetId = await inTransaction((tx) =>
      mapErrors(() =>
        BudgetService.createBudget(tx, req.clinic!.id, req.user!.id, data),
      ),
    );

    const detail = await BudgetService.getBudgetDetail(prisma, req.clinic!.id, budgetId);
    if (!detail) throw notFound('Budget not found');
    res.status(201).json(ok(detail));
  },
);

budgetRouter.put(
  '/budgets/:budgetId',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const data = parse(budgetUpdateSchema, body(req));

    const existing = await BudgetService.getBudgetBasic(prisma, req.clinic!.id, budgetId);
    if (!existing) throw notFound('Budget not found');

    await inTransaction((tx) =>
      mapErrors(() => BudgetService.updateBudget(tx, existing, data, req.user!.id)),
    );

    const detail = await BudgetService.getBudgetDetail(prisma, req.clinic!.id, budgetId);
    if (!detail) throw notFound('Budget not found');
    res.json(ok(detail));
  },
);

budgetRouter.delete(
  '/budgets/:budgetId',
  ...staffGuard,
  requirePermission('budget.admin'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const existing = await BudgetService.getBudgetBasic(prisma, req.clinic!.id, budgetId);
    if (!existing) throw notFound('Budget not found');

    await inTransaction((tx) =>
      mapErrors(() => BudgetService.deleteBudget(tx, existing, req.user!.id)),
    );
    res.status(204).end();
  },
);

// ============================================================================
// Lignes
// ============================================================================

budgetRouter.post(
  '/budgets/:budgetId/items',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const data = parse(budgetItemCreateSchema, body(req));

    const existing = await BudgetService.getBudgetBasic(prisma, req.clinic!.id, budgetId);
    if (!existing) throw notFound('Budget not found');

    const item = await inTransaction((tx) =>
      mapErrors(() => BudgetService.addItem(tx, existing, data, req.user!.id)),
    );
    res.status(201).json(ok(toItemDto(item)));
  },
);

budgetRouter.put(
  '/budgets/:budgetId/items/:itemId',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const itemId = pathId(req.params.itemId);
    const data = parse(budgetItemUpdateSchema, body(req));

    const existing = await BudgetService.getBudgetRow(prisma, req.clinic!.id, budgetId);
    if (!existing) throw notFound('Budget not found');
    if (existing.status !== 'draft') {
      throw badRequest('Items can only be updated in draft budgets');
    }
    const current = existing.budget_items.find((item) => item.id === itemId);
    if (!current) throw notFound('Budget item not found');

    const updated = await inTransaction(async (tx) => {
      const item = await BudgetItemService.updateItem(tx, current, data);
      await BudgetService.recalculateTotals(tx, budgetId);
      return item;
    });
    res.json(ok(toItemDto(updated)));
  },
);

budgetRouter.delete(
  '/budgets/:budgetId/items/:itemId',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const itemId = pathId(req.params.itemId);

    const existing = await BudgetService.getBudgetRow(prisma, req.clinic!.id, budgetId);
    if (!existing) throw notFound('Budget not found');
    const current = existing.budget_items.find((item) => item.id === itemId);
    if (!current) throw notFound('Budget item not found');

    await inTransaction((tx) =>
      mapErrors(() => BudgetService.removeItem(tx, existing, current, req.user!.id)),
    );
    res.status(204).end();
  },
);

// ============================================================================
// Workflow
// ============================================================================

async function reloadBudgetDto(clinicId: string, budgetId: string) {
  const row = await BudgetService.getBudgetRow(prisma, clinicId, budgetId);
  if (!row) throw notFound('Budget not found');
  return toBudgetDto(row);
}

budgetRouter.post(
  '/budgets/:budgetId/send',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const data = parse(budgetSendRequestSchema, body(req));
    const clinicId = req.clinic!.id;

    await inTransaction(async (tx) => {
      const budget = await loadWorkflowBudget(tx, clinicId, budgetId);
      if (!budget) throw notFound('Budget not found');

      const sendMethod = resolveSendMethod(data);
      let recipientEmail: string | null = null;
      if (sendMethod === 'email' || sendMethod === 'whatsapp') {
        const patient = await tx.patients.findUnique({
          where: { id: budget.patient_id },
          select: { email: true, phone: true },
        });
        if (sendMethod === 'email') {
          if (!patient || !patient.email) {
            throw badRequest('Patient has no email address');
          }
          recipientEmail = patient.email;
        } else if (!patient || !patient.phone) {
          throw badRequest('Patient has no phone number');
        }
      }

      await mapErrors(() =>
        BudgetWorkflowService.sendBudget(tx, budget, req.user!.id, {
          sendMethod,
          recipientEmail,
        }),
      );
    });

    res.json(ok(await reloadBudgetDto(clinicId, budgetId)));
  },
);

budgetRouter.post(
  '/budgets/:budgetId/accept',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const data = parse(budgetAcceptRequestSchema, body(req));
    const clinicId = req.clinic!.id;

    await inTransaction(async (tx) => {
      const budget = await loadWorkflowBudget(tx, clinicId, budgetId);
      if (!budget) throw notFound('Budget not found');
      await mapErrors(() =>
        BudgetWorkflowService.acceptBudget(tx, budget, data.signature, req.user!.id, {
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        }),
      );
    });

    res.json(ok(await reloadBudgetDto(clinicId, budgetId)));
  },
);

budgetRouter.post(
  '/budgets/:budgetId/reject',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const data = parse(budgetRejectRequestSchema, body(req));
    const clinicId = req.clinic!.id;

    await inTransaction(async (tx) => {
      const budget = await loadWorkflowBudget(tx, clinicId, budgetId);
      if (!budget) throw notFound('Budget not found');
      await mapErrors(() =>
        BudgetWorkflowService.rejectBudget(tx, budget, req.user!.id, data.reason ?? null, {
          signatureData: data.signature ?? null,
          ipAddress: clientIp(req),
          userAgent: userAgent(req),
        }),
      );
    });

    res.json(ok(await reloadBudgetDto(clinicId, budgetId)));
  },
);

budgetRouter.post(
  '/budgets/:budgetId/cancel',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const data = parse(budgetCancelRequestSchema, body(req));
    const clinicId = req.clinic!.id;

    await inTransaction(async (tx) => {
      const budget = await loadWorkflowBudget(tx, clinicId, budgetId);
      if (!budget) throw notFound('Budget not found');
      await mapErrors(() =>
        BudgetWorkflowService.cancelBudget(tx, budget, req.user!.id, data.reason ?? null),
      );
    });

    res.json(ok(await reloadBudgetDto(clinicId, budgetId)));
  },
);

budgetRouter.post(
  '/budgets/:budgetId/renegotiate',
  ...staffGuard,
  requirePermission('budget.renegotiate'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const clinicId = req.clinic!.id;

    await inTransaction(async (tx) => {
      const budget = await loadWorkflowBudget(tx, clinicId, budgetId);
      if (!budget) throw notFound('Budget not found');
      await mapErrors(() =>
        BudgetWorkflowService.cancelForRenegotiation(tx, budget, req.user!.id),
      );
    });

    res.json(ok(await reloadBudgetDto(clinicId, budgetId)));
  },
);

budgetRouter.post(
  '/budgets/:budgetId/accept-in-clinic',
  ...staffGuard,
  requirePermission('budget.accept_in_clinic'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const data = parse(acceptInClinicSchema, body(req));
    const clinicId = req.clinic!.id;

    await inTransaction(async (tx) => {
      const budget = await loadWorkflowBudget(tx, clinicId, budgetId);
      if (!budget) throw notFound('Budget not found');
      await mapErrors(() =>
        BudgetWorkflowService.acceptBudget(
          tx,
          budget,
          {
            signed_by_name: data.signer_name,
            relationship_to_patient: 'patient',
            signature_method: data.signature_data ? 'drawn' : 'click_accept',
            signature_data: data.signature_data ?? null,
          },
          req.user!.id,
          {
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
            acceptedVia: 'in_clinic',
          },
        ),
      );
    });

    res.json(ok(await reloadBudgetDto(clinicId, budgetId)));
  },
);

budgetRouter.post(
  '/budgets/:budgetId/resend',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const clinicId = req.clinic!.id;

    const newBudgetId = await inTransaction(async (tx) => {
      const budget = await loadWorkflowBudget(tx, clinicId, budgetId);
      if (!budget) throw notFound('Budget not found');
      if (!['rejected', 'expired', 'cancelled'].includes(budget.status)) {
        throw badRequest('Only rejected, expired or cancelled budgets can be resent');
      }
      const created = await BudgetWorkflowService.cloneToNewDraft(tx, budget, req.user!.id);
      // `budget.superseded` : le plan suit la nouvelle version.
      await BudgetWorkflowService.supersedePlanLink(tx, budget, created);
      return created;
    });

    res.json(ok(await reloadBudgetDto(clinicId, newBudgetId)));
  },
);

budgetRouter.post(
  '/budgets/:budgetId/send-reminder',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const data = parse(sendReminderSchema, body(req));
    const clinicId = req.clinic!.id;

    await inTransaction(async (tx) => {
      const budget = await loadWorkflowBudget(tx, clinicId, budgetId);
      if (!budget) throw notFound('Budget not found');
      if (budget.status !== 'sent') {
        throw badRequest('Reminders only apply to sent budgets');
      }
      await BudgetWorkflowService.sendReminder(tx, budget);
    });

    res.json(ok(await reloadBudgetDto(clinicId, budgetId)));
  },
);

budgetRouter.post(
  '/budgets/:budgetId/set-public-code',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const data = parse(setPublicCodeSchema, body(req));
    const clinicId = req.clinic!.id;

    await inTransaction(async (tx) => {
      const budget = await loadWorkflowBudget(tx, clinicId, budgetId);
      if (!budget) throw notFound('Budget not found');
      await mapErrors(() => BudgetWorkflowService.setPublicCode(tx, budget, data.code));
    });

    res.json(ok(await reloadBudgetDto(clinicId, budgetId)));
  },
);

budgetRouter.post(
  '/budgets/:budgetId/unlock-public',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const clinicId = req.clinic!.id;

    await inTransaction(async (tx) => {
      const budget = await loadWorkflowBudget(tx, clinicId, budgetId);
      if (!budget) throw notFound('Budget not found');
      const wasLocked = budget.public_locked_at !== null;
      await BudgetWorkflowService.unlockPublic(tx, budget);
      await BudgetHistoryService.addEntry(tx, {
        clinicId,
        budgetId: budget.id,
        action: 'public_lock_cleared',
        changedBy: req.user!.id,
        previousState: { locked: wasLocked },
        newState: { locked: false },
        notes: 'Cleared failed public verification attempts while clearing the link lock.',
      });
    });

    res.json(ok(await reloadBudgetDto(clinicId, budgetId)));
  },
);

budgetRouter.post(
  '/budgets/:budgetId/duplicate',
  ...staffGuard,
  requirePermission('budget.write'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const clinicId = req.clinic!.id;

    const newBudgetId = await inTransaction(async (tx) => {
      const source = await BudgetService.getBudgetRow(tx, clinicId, budgetId);
      if (!source) throw notFound('Budget not found');
      return BudgetService.duplicateBudget(tx, source, req.user!.id);
    });

    const detail = await BudgetService.getBudgetDetail(prisma, clinicId, newBudgetId);
    if (!detail) throw notFound('Budget not found');
    res.status(201).json(ok(detail));
  },
);

// ============================================================================
// Versions / historique
// ============================================================================

budgetRouter.get(
  '/budgets/:budgetId/versions',
  ...staffGuard,
  requirePermission('budget.read'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const budget = await BudgetService.getBudgetBasic(prisma, req.clinic!.id, budgetId);
    if (!budget) throw notFound('Budget not found');

    const versions = await BudgetService.getVersions(
      prisma,
      req.clinic!.id,
      budget.budget_number,
    );
    res.json(
      ok({
        budget_number: budget.budget_number,
        versions: versions.map((row) => toVersionDto(row, budgetId)),
        current_version: budget.version,
      }),
    );
  },
);

budgetRouter.get(
  '/budgets/:budgetId/history',
  ...staffGuard,
  requirePermission('budget.read'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const budget = await BudgetService.getBudgetBasic(prisma, req.clinic!.id, budgetId);
    if (!budget) throw notFound('Budget not found');

    const history = await BudgetHistoryService.getHistory(prisma, req.clinic!.id, budgetId);
    res.json(ok(history));
  },
);

// ============================================================================
// PDF / signature (staff)
// ============================================================================

budgetRouter.get(
  '/budgets/:budgetId/pdf',
  ...staffGuard,
  requirePermission('budget.read'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const locale = queryLocale(req);
    const row = await BudgetService.getBudgetRow(prisma, req.clinic!.id, budgetId);
    if (!row) throw notFound('Budget not found');
    await sendBudgetPdf(res, row, {
      isPreview: false,
      locale,
      withSignature: false,
      filename: `presupuesto_${row.budget_number}_v${row.version}.pdf`,
      disposition: 'attachment',
    });
  },
);

budgetRouter.get(
  '/budgets/:budgetId/pdf/signed',
  ...staffGuard,
  requirePermission('budget.read'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const locale = queryLocale(req);
    const row = await BudgetService.getBudgetRow(prisma, req.clinic!.id, budgetId);
    if (!row) throw notFound('Budget not found');
    const signature = row.budget_signatures.find(
      (sig) => sig.signature_type === 'full_acceptance',
    );
    if (!signature) throw notFound('Budget has not been signed');
    await sendBudgetPdf(res, row, {
      isPreview: false,
      locale,
      withSignature: true,
      filename: `presupuesto_${row.budget_number}_v${row.version}_firmado.pdf`,
      disposition: 'attachment',
      noStore: true,
    });
  },
);

budgetRouter.get(
  '/budgets/:budgetId/pdf/preview',
  ...staffGuard,
  requirePermission('budget.read'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const locale = queryLocale(req);
    const row = await BudgetService.getBudgetRow(prisma, req.clinic!.id, budgetId);
    if (!row) throw notFound('Budget not found');
    await sendBudgetPdf(res, row, {
      isPreview: true,
      locale,
      withSignature: false,
      disposition: 'inline',
    });
  },
);

budgetRouter.get(
  '/budgets/:budgetId/signature',
  ...staffGuard,
  requirePermission('budget.read'),
  async (req, res) => {
    const budgetId = pathId(req.params.budgetId);
    const budget = await BudgetService.getBudgetBasic(prisma, req.clinic!.id, budgetId);
    if (!budget) throw notFound('Budget not found');

    const signature = await findLatestAcceptanceSignature(prisma, req.clinic!.id, budgetId);
    if (!signature) throw notFound('Budget has not been signed');
    res.json(ok(toSignatureMetaDto(signature)));
  },
);

// ============================================================================
// Lien public (aucune authentification staff)
// ============================================================================

/**
 * Secret des cookies de session publique : `BUDGET_PUBLIC_SECRET_KEY`
 * (variable lue comme côté FastAPI), repli sur `SECRET_KEY` hors production.
 * Une valeur vide est traitée comme absente.
 */
function publicSecret(): string {
  const key = (process.env.BUDGET_PUBLIC_SECRET_KEY ?? '').trim();
  if (key) return key;
  if (config.isProduction) {
    throw new BudgetConfigurationError(
      'BUDGET_PUBLIC_SECRET_KEY is required in production: refusing to ' +
        'sign public budget sessions with the staff-JWT key.',
    );
  }
  return config.secretKey;
}

/** Cookie propre au token : un cookie volé ne déverrouille pas un autre devis. */
function cookieName(token: string): string {
  return `bdg_session_${token}`;
}

function cookiePath(token: string): string {
  return `/api/v1/budget/public/budgets/${token}`;
}

function issueSessionCookie(res: Response, budgetId: string, token: string): void {
  const expiresAt = Math.floor(Date.now() / 1000) + PUBLIC_SESSION_TTL_SECONDS;
  const encoded = jwt.sign({ sub: budgetId, tok: token, exp: expiresAt }, publicSecret(), {
    algorithm: 'HS256',
  });
  res.cookie(cookieName(token), encoded, {
    maxAge: PUBLIC_SESSION_TTL_SECONDS * 1000,
    path: cookiePath(token),
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
  });
}

function verifySessionCookie(token: string, raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const payload = jwt.verify(raw, publicSecret(), { algorithms: ['HS256'] }) as {
      sub?: unknown;
      tok?: unknown;
    };
    if (payload.tok !== token) return null;
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

function publicCookie(req: Request, token: string): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[cookieName(token)];
}

/**
 * `_require_session` : budgé par token, cookie exigé sauf `method=none`.
 * Renvoie le budget chargé (avec lignes) pour la suite de la route.
 */
async function requirePublicSession(req: Request, token: string) {
  const budget = await loadWorkflowBudgetByToken(prisma, token);
  if (!budget) throw notFound('Budget link not found');
  if (budget.public_auth_method !== 'none') {
    const sub = verifySessionCookie(token, publicCookie(req, token));
    if (sub === null || sub !== budget.id) {
      throw unauthorized('verification_required');
    }
  }
  return budget;
}

function publicMeta(overrides: Record<string, unknown>) {
  return {
    requires_verification: false,
    locked: false,
    expired: false,
    already_decided: false,
    decided_status: null,
    clinic_name: null,
    clinic_phone: null,
    clinic_email: null,
    clinic_address_line: null,
    clinic_language: null,
    clinic_currency: null,
    ...overrides,
  };
}

async function logPublicAccess(
  budgetId: string,
  ip: string | null,
  method: string,
  success = true,
): Promise<void> {
  await prisma.budget_access_logs.create({
    data: {
      id: crypto.randomUUID(),
      budget_id: budgetId,
      attempted_at: new Date(),
      ip_hash: hashIp(ip ?? ''),
      success,
      method_attempted: method,
    },
  });
}

budgetRouter.get(
  '/public/budgets/:token/meta',
  limiter({ limit: 60, windowMs: 60_000 }),
  async (req, res) => {
    const token = pathId(req.params.token);
    const budget = await prisma.budgets.findFirst({
      where: { public_token: token, deleted_at: null },
      select: {
        id: true,
        clinic_id: true,
        status: true,
        valid_until: true,
        public_locked_at: true,
        public_auth_method: true,
      },
    });
    if (!budget) throw notFound('Budget link not found');

    const clinic = await prisma.clinics.findUnique({
      where: { id: budget.clinic_id },
      select: {
        name: true,
        phone: true,
        email: true,
        address: true,
        settings: true,
        currency: true,
        timezone: true,
      },
    });
    const today = await clinicToday(prisma, budget.clinic_id);
    const validUntil =
      budget.valid_until === null ? null : dateColumnToString(budget.valid_until);
    const alreadyDecided = budget.status === 'accepted' || budget.status === 'rejected';

    const address =
      clinic?.address !== null && typeof clinic?.address === 'object' && !Array.isArray(clinic.address)
        ? (clinic.address as Record<string, unknown>)
        : {};
    const parts = [address.street, address.city, address.postal_code].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    const settings =
      clinic?.settings !== null &&
      typeof clinic?.settings === 'object' &&
      !Array.isArray(clinic.settings)
        ? (clinic.settings as Record<string, unknown>)
        : {};
    const language = settings.communication_language;

    res.json(
      ok(
        publicMeta({
          requires_verification:
            budget.public_auth_method !== 'none' && !alreadyDecided,
          method: budget.public_auth_method,
          locked: budget.public_locked_at !== null,
          expired: isExpired(validUntil, today),
          already_decided: alreadyDecided,
          decided_status: alreadyDecided ? budget.status : null,
          clinic_name: clinic?.name ?? null,
          clinic_phone: clinic?.phone ?? null,
          clinic_email: clinic?.email ?? null,
          clinic_address_line: parts.length > 0 ? parts.join(', ') : null,
          clinic_language: typeof language === 'string' && language ? language : 'es',
          clinic_currency: clinic?.currency ?? null,
        }),
      ),
    );
  },
);

budgetRouter.post(
  '/public/budgets/:token/verify',
  limiter({ limit: 5, windowMs: 15 * 60 * 1000 }),
  limiter({ limit: 20, windowMs: 60 * 60 * 1000 }),
  async (req, res) => {
    const token = pathId(req.params.token);
    const data = parse(publicVerifySchema, body(req));
    if (!(PUBLIC_AUTH_METHODS as readonly string[]).includes(data.method)) {
      throw badRequest('Invalid method');
    }

    const budget = await loadWorkflowBudgetByToken(prisma, token);
    if (!budget) throw notFound('Budget link not found');
    if (budget.status === 'accepted' || budget.status === 'rejected') {
      throw conflict('Budget already decided');
    }

    const result = await prisma.$transaction((tx) =>
      BudgetWorkflowService.verifyPublicAccess(
        tx,
        budget,
        data.method,
        data.value,
        hashIp(clientIp(req) ?? ''),
      ),
    );

    if (!result.ok) {
      if (result.error === 'locked') {
        res.status(423).json({ detail: 'locked' });
        return;
      }
      if (result.error === 'expired') {
        res.status(410).json({ detail: 'expired' });
        return;
      }
      if (result.error === 'rate_limited') {
        res.status(429).json({ detail: 'rate_limited' });
        return;
      }
      // `method_mismatch` / `invalid` : 401 pour la SPA.
      res.status(401).json({ detail: result.error ?? 'invalid' });
      return;
    }

    issueSessionCookie(res, budget.id, token);
    res.status(204).end();
  },
);

budgetRouter.get('/public/budgets/:token', limiter({ limit: 30, windowMs: 60_000 }), async (req, res) => {
  const token = pathId(req.params.token);
  const budget = await requirePublicSession(req, token);

  const today = await clinicToday(prisma, budget.clinic_id);
  const validUntil = budget.valid_until === null ? null : dateColumnToString(budget.valid_until);
  if (isExpired(validUntil, today)) {
    res.status(410).json({ detail: 'expired' });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await BudgetWorkflowService.markViewed(tx, budget);
  });

  const row = await BudgetService.getBudgetRow(prisma, budget.clinic_id, budget.id);
  if (!row) throw notFound('Budget link not found');
  const plan = await lookupLinkedPlan(prisma, budget.clinic_id, budget.id);
  res.json(ok(toBudgetDetailDto(row, plan)));
});

budgetRouter.post(
  '/public/budgets/:token/accept',
  limiter({ limit: 10, windowMs: 60_000 }),
  async (req, res) => {
    const token = pathId(req.params.token);
    const data = parse(publicAcceptSchema, body(req));
    const budget = await requirePublicSession(req, token);
    if (budget.status === 'accepted' || budget.status === 'rejected') {
      throw conflict('Budget already decided');
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Statut relu sous verrou (`_lock_status`) : 400 si déjà décidé.
        const reloaded = await loadWorkflowBudget(tx, budget.clinic_id, budget.id);
        if (!reloaded) throw notFound('Budget link not found');
        await BudgetWorkflowService.acceptBudget(
          tx,
          reloaded,
          {
            signed_by_name: data.signer_name,
            relationship_to_patient: 'patient',
            signature_method: data.signature_data ? 'drawn' : 'click_accept',
            signature_data: data.signature_data ?? null,
          },
          reloaded.created_by,
          {
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
            acceptedVia: 'remote_link',
          },
        );
        await logPublicAccess(budget.id, clientIp(req), 'accept');
      });
    } catch (error) {
      if (error instanceof BudgetWorkflowError) throw badRequest(error.message);
      throw error;
    }

    res.json(
      ok(
        publicMeta({
          requires_verification: false,
          method: budget.public_auth_method,
          already_decided: true,
          decided_status: 'accepted',
        }),
      ),
    );
  },
);

budgetRouter.get(
  '/public/budgets/:token/pdf/signed',
  limiter({ limit: 10, windowMs: 60_000 }),
  async (req, res) => {
    const token = pathId(req.params.token);
    const budget = await requirePublicSession(req, token);
    if (budget.status !== 'accepted') {
      throw notFound('Budget has not been accepted');
    }
    const full = await BudgetService.getBudgetRow(prisma, budget.clinic_id, budget.id);
    if (!full) throw notFound('Budget not found');
    const signature = full.budget_signatures.find(
      (sig) => sig.signature_type === 'full_acceptance',
    );
    if (!signature) throw notFound('Budget has not been signed');

    const clinic = await prisma.clinics.findUnique({
      where: { id: budget.clinic_id },
      select: { settings: true },
    });
    const settings =
      clinic?.settings && typeof clinic.settings === 'object' && !Array.isArray(clinic.settings)
        ? (clinic.settings as Record<string, unknown>)
        : {};
    const locale = String(settings.communication_language ?? 'es');

    await logPublicAccess(budget.id, clientIp(req), 'download_signed_pdf', true);
    await sendBudgetPdf(res, full, {
      isPreview: false,
      locale,
      withSignature: true,
      filename: `presupuesto_${full.budget_number}_v${full.version}_firmado.pdf`,
      disposition: 'attachment',
      noStore: true,
    });
  },
);

budgetRouter.post(
  '/public/budgets/:token/reject',
  limiter({ limit: 10, windowMs: 60_000 }),
  async (req, res) => {
    const token = pathId(req.params.token);
    const data = parse(publicRejectSchema, body(req));
    const budget = await requirePublicSession(req, token);
    if (budget.status === 'accepted' || budget.status === 'rejected') {
      throw conflict('Budget already decided');
    }
    if (!(PUBLIC_REJECTION_REASONS as readonly string[]).includes(data.reason)) {
      throw badRequest('Invalid reason');
    }

    try {
      await prisma.$transaction(async (tx) => {
        const reloaded = await loadWorkflowBudget(tx, budget.clinic_id, budget.id);
        if (!reloaded) throw notFound('Budget link not found');
        await BudgetWorkflowService.rejectBudget(
          tx,
          reloaded,
          reloaded.created_by,
          data.reason,
          {
            note: data.note ?? null,
            ipAddress: clientIp(req),
            userAgent: userAgent(req),
          },
        );
        await logPublicAccess(budget.id, clientIp(req), 'reject');
      });
    } catch (error) {
      if (error instanceof BudgetWorkflowError) throw badRequest(error.message);
      throw error;
    }

    res.json(
      ok(
        publicMeta({
          requires_verification: false,
          method: budget.public_auth_method,
          already_decided: true,
          decided_status: 'rejected',
        }),
      ),
    );
  },
);
