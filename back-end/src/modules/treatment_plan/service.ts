/**
 * Couche service du module `treatment_plan` — port de
 * `app/modules/treatment_plan/service.py`.
 *
 * Les DTO reproduisent les schémas Pydantic (`TreatmentPlanResponse`,
 * `TreatmentPlanDetailResponse`, `PlannedTreatmentItemResponse`,
 * `PipelineRow`…) : décimales sérialisées en nombres (floats Python),
 * JSON renvoyé tel quel, horodatages en ISO 8601 UTC (format FastAPI).
 */

import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { toClinicDateString } from '../../lib/time';
import {
  TERMINAL_BUDGET_STATUSES,
  VALID_CLOSURE_REASONS,
  VALID_PLAN_TRANSITIONS,
  type PlannedItemCreateInput,
  type PlannedItemUpdateInput,
  type SessionInput,
  type TreatmentPlanCreateInput,
  type TreatmentPlanUpdateInput,
  type UpdateSessionInput,
} from './schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Décimal PostgreSQL → float, comme la sérialisation `float` de Pydantic. */
function dec(value: Prisma.Decimal | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value.toString());
}

function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

function asRecord(value: unknown): Record<string, string> {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, string>;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string');
}

/** Montant décimal en centimes entiers (arithmétique exacte). */
function toCents(value: Prisma.Decimal | string | number): number {
  return Math.round(Number(value.toString()) * 100);
}

function centsToDecimal(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).dividedBy(100);
}

function round2(centsRaw: number): number {
  return Math.round(centsRaw);
}

/** Ordre d'affichage des noms catalogue (port de `catalog_name`). */
const CATALOG_NAME_PRIORITY = [
  'es',
  'en',
  'fr',
  'pt',
  'ta',
  'te',
  'hi',
  'de',
  'hu',
  'it',
  'pl',
  'ar',
];

function catalogName(names: Record<string, string> | null | undefined): string | null {
  if (!names) return null;
  const usable = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;
  for (const lang of CATALOG_NAME_PRIORITY) {
    const value = names[lang];
    if (usable(value)) return value;
  }
  const fallback = Object.values(names).find(usable);
  return fallback ?? null;
}

/** Erreur « plan verrouillé par un budget actif » (→ 409). */
export class PlanLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanLockedError';
  }
}

/** Erreur « item réservé dans un rendez-vous » (→ 409). */
export class PlanItemBookedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanItemBookedError';
  }
}

// ---------------------------------------------------------------------------
// Includes
// ---------------------------------------------------------------------------

const catalogItemSelect = {
  id: true,
  internal_code: true,
  names: true,
  default_price: true,
  default_duration_minutes: true,
} satisfies Prisma.treatment_catalog_itemsSelect;

const treatmentInclude = {
  treatment_teeth: { orderBy: [{ tooth_number: 'asc' }, { id: 'asc' }] },
  treatment_catalog_items: { select: catalogItemSelect },
} satisfies Prisma.treatmentsInclude;

const sessionOrderBy = [{ sequence: 'asc' }, { id: 'asc' }] as const;

const planItemInclude = {
  treatments: { include: treatmentInclude },
  planned_treatment_item_sessions: { orderBy: [...sessionOrderBy] },
} satisfies Prisma.planned_treatment_itemsInclude;

const planInclude = {
  patients: { select: { id: true, first_name: true, last_name: true } },
  budgets: { select: { id: true, budget_number: true, status: true, total: true } },
  planned_treatment_items: {
    orderBy: [{ sequence_order: 'asc' }, { id: 'asc' }],
    include: planItemInclude,
  },
} satisfies Prisma.treatment_plansInclude;

type PlanRow = Prisma.treatment_plansGetPayload<{ include: typeof planInclude }>;
type PlanItemRow = Prisma.planned_treatment_itemsGetPayload<{ include: typeof planItemInclude }>;
type SessionRow = Prisma.planned_treatment_item_sessionsGetPayload<Record<string, never>>;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface PatientBriefDto {
  id: string;
  first_name: string;
  last_name: string;
}

export interface BudgetBriefDto {
  id: string;
  budget_number: string;
  status: string;
  total: number;
}

export interface TreatmentToothBriefDto {
  tooth_number: number;
  role: string | null;
  surfaces: string[] | null;
}

export interface CatalogItemBriefDto {
  id: string;
  internal_code: string;
  names: Record<string, string>;
  default_price: number | null;
  default_duration_minutes: number | null;
}

export interface TreatmentBriefDto {
  id: string;
  clinical_type: string;
  scope: string;
  arch: string | null;
  status: string;
  catalog_item_id: string | null;
  catalog_item: CatalogItemBriefDto | null;
  price_snapshot: number | null;
  notes: string | null;
  teeth: TreatmentToothBriefDto[];
}

export interface PlannedItemSessionDto {
  id: string;
  sequence: number;
  label: string | null;
  amount: number;
  status: string;
  completed_at: string | null;
  completed_by: string | null;
  notes: string | null;
}

export interface PlannedItemDto {
  id: string;
  clinic_id: string;
  treatment_plan_id: string;
  treatment_id: string;
  sequence_order: number;
  status: string;
  completed_without_appointment: boolean;
  completed_at: string | null;
  completed_by: string | null;
  assigned_professional_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  treatment: TreatmentBriefDto | null;
  catalog_item: CatalogItemBriefDto | null;
  sessions: PlannedItemSessionDto[];
}

export interface TreatmentPlanDto {
  id: string;
  clinic_id: string;
  patient_id: string;
  plan_number: string;
  title: string | null;
  status: string;
  budget_id: string | null;
  assigned_professional_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  item_count: number;
  completed_count: number;
  total: number;
  closure_reason: string | null;
  closure_note: string | null;
  closed_at: string | null;
  patient: PatientBriefDto | null;
  budget: BudgetBriefDto | null;
}

export interface TreatmentPlanDetailDto extends TreatmentPlanDto {
  diagnosis_notes: string | null;
  internal_notes: string | null;
  items: PlannedItemDto[];
}

export interface PipelineRowDto {
  plan_id: string;
  plan_number: string;
  plan_title: string | null;
  plan_status: string;
  days_in_status: number;
  closure_reason: string | null;
  items_total: number;
  items_completed: number;
  patient: PatientBriefDto;
  budget: {
    id: string;
    status: string;
    total: number | null;
    valid_until: string | null;
    last_reminder_sent_at: string | null;
    viewed_at: string | null;
  } | null;
  next_appointment: {
    id: string;
    start_at: string;
    cabinet_id: string | null;
    professional_id: string | null;
  } | null;
}

function toCatalogItemBrief(
  row: PlanItemRow['treatments'] extends infer T
    ? T extends { treatment_catalog_items: infer C } ? C : never
    : never,
): CatalogItemBriefDto | null {
  if (!row) return null;
  return {
    id: row.id,
    internal_code: row.internal_code,
    names: asRecord(row.names),
    default_price: dec(row.default_price),
    default_duration_minutes: row.default_duration_minutes,
  };
}

function toTreatmentBrief(row: PlanItemRow['treatments'] | null): TreatmentBriefDto | null {
  if (!row) return null;
  return {
    id: row.id,
    clinical_type: row.clinical_type,
    scope: row.scope,
    arch: row.arch,
    status: row.status,
    catalog_item_id: row.catalog_item_id,
    catalog_item: toCatalogItemBrief(row.treatment_catalog_items),
    price_snapshot: dec(row.price_snapshot),
    notes: row.notes,
    teeth: row.treatment_teeth.map((tooth) => ({
      tooth_number: tooth.tooth_number,
      role: tooth.role,
      surfaces: asStringArray(tooth.surfaces),
    })),
  };
}

function toSessionDto(row: SessionRow): PlannedItemSessionDto {
  return {
    id: row.id,
    sequence: row.sequence,
    label: row.label,
    amount: dec(row.amount) ?? 0,
    status: row.status,
    completed_at: iso(row.completed_at),
    completed_by: row.completed_by,
    notes: row.notes,
  };
}

export function toPlannedItemDto(row: PlanItemRow): PlannedItemDto {
  const treatment = toTreatmentBrief(row.treatments);
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    treatment_plan_id: row.treatment_plan_id,
    treatment_id: row.treatment_id,
    sequence_order: row.sequence_order,
    status: row.status,
    completed_without_appointment: row.completed_without_appointment,
    completed_at: iso(row.completed_at),
    completed_by: row.completed_by,
    assigned_professional_id: row.assigned_professional_id,
    notes: row.notes,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    treatment,
    catalog_item: treatment?.catalog_item ?? null,
    sessions: row.planned_treatment_item_sessions.map(toSessionDto),
  };
}

function planTotals(plan: PlanRow): { itemCount: number; completedCount: number; total: number } {
  const items = plan.planned_treatment_items;
  return {
    itemCount: items.length,
    completedCount: items.filter((item) => item.status === 'completed').length,
    total: items.reduce((sum, item) => sum + (dec(item.treatments?.price_snapshot) ?? 0), 0),
  };
}

export function toTreatmentPlanDto(plan: PlanRow): TreatmentPlanDto {
  const totals = planTotals(plan);
  return {
    id: plan.id,
    clinic_id: plan.clinic_id,
    patient_id: plan.patient_id,
    plan_number: plan.plan_number,
    title: plan.title,
    status: plan.status,
    budget_id: plan.budget_id,
    assigned_professional_id: plan.assigned_professional_id,
    created_by: plan.created_by,
    created_at: plan.created_at.toISOString(),
    updated_at: plan.updated_at.toISOString(),
    item_count: totals.itemCount,
    completed_count: totals.completedCount,
    total: totals.total,
    closure_reason: plan.closure_reason,
    closure_note: plan.closure_note,
    closed_at: iso(plan.closed_at),
    patient: plan.patients
      ? {
          id: plan.patients.id,
          first_name: plan.patients.first_name,
          last_name: plan.patients.last_name,
        }
      : null,
    budget: plan.budgets
      ? {
          id: plan.budgets.id,
          budget_number: plan.budgets.budget_number,
          status: plan.budgets.status,
          total: dec(plan.budgets.total) ?? 0,
        }
      : null,
  };
}

export function toTreatmentPlanDetailDto(plan: PlanRow): TreatmentPlanDetailDto {
  return {
    ...toTreatmentPlanDto(plan),
    diagnosis_notes: plan.diagnosis_notes,
    internal_notes: plan.internal_notes,
    items: plan.planned_treatment_items.map(toPlannedItemDto),
  };
}

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------

/**
 * Vérifie que `userId` est un membre dentiste/hygiéniste de la clinique.
 * Port de `_validate_professional_in_clinic` (→ 400).
 */
async function assertProfessionalInClinic(clinicId: string, userId: string): Promise<void> {
  const membership = await prisma.clinic_memberships.findFirst({
    where: { clinic_id: clinicId, user_id: userId, is_professional: true },
    select: { id: true },
  });
  if (!membership) throw badRequest('Invalid professional for this clinic');
}

async function clinicTimezone(clinicId: string): Promise<string> {
  const clinic = await prisma.clinics.findUnique({
    where: { id: clinicId },
    select: { timezone: true },
  });
  return clinic?.timezone ?? 'UTC';
}

/** Aujourd'hui dans le fuseau de la clinique → `YYYY-MM-DD`. */
async function clinicToday(clinicId: string): Promise<string> {
  const timezone = await clinicTimezone(clinicId);
  return toClinicDateString(new Date(), timezone) ?? new Date().toISOString().slice(0, 10);
}

/**
 * Un plan est verrouillé dès que son budget a été envoyé au patient
 * (status `sent` ou `accepted`). Port de `_is_plan_locked`.
 */
function isPlanLocked(plan: { budget_id: string | null; budgets: { status: string } | null }): boolean {
  if (!plan.budget_id || !plan.budgets) return false;
  return plan.budgets.status === 'sent' || plan.budgets.status === 'accepted';
}

// ---------------------------------------------------------------------------
// Plan number
// ---------------------------------------------------------------------------

/** `PLAN-{année}-{compteur sur 4 chiffres}` (port de `generate_plan_number`). */
export async function generatePlanNumber(clinicId: string): Promise<string> {
  const year = (await clinicToday(clinicId)).slice(0, 4);
  const prefix = `PLAN-${year}-`;
  const count = await prisma.treatment_plans.count({
    where: { clinic_id: clinicId, plan_number: { startsWith: prefix } },
  });
  return `${prefix}${String(count + 1).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function getPlanRow(clinicId: string, planId: string): Promise<PlanRow | null> {
  return prisma.treatment_plans.findFirst({
    where: { id: planId, clinic_id: clinicId, deleted_at: null },
    include: planInclude,
  });
}

export interface PlanListFilters {
  patientId?: string | null;
  statuses?: string[] | null;
  page: number;
  pageSize: number;
}

export async function listPlans(
  clinicId: string,
  filters: PlanListFilters,
): Promise<{ rows: TreatmentPlanDto[]; total: number }> {
  const pageSize = Math.min(Math.max(filters.pageSize, 1), 100);
  const page = Math.max(filters.page, 1);

  const where: Prisma.treatment_plansWhereInput = { clinic_id: clinicId, deleted_at: null };
  if (filters.patientId) where.patient_id = filters.patientId;
  const statuses = (filters.statuses ?? []).filter(Boolean);
  if (statuses.length === 1) where.status = statuses[0];
  else if (statuses.length > 1) where.status = { in: statuses };

  const [rows, total] = await Promise.all([
    prisma.treatment_plans.findMany({
      where,
      include: planInclude,
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.treatment_plans.count({ where }),
  ]);

  return { rows: rows.map(toTreatmentPlanDto), total };
}

export async function getPlanDetail(
  clinicId: string,
  planId: string,
): Promise<TreatmentPlanDetailDto | null> {
  const plan = await getPlanRow(clinicId, planId);
  return plan ? toTreatmentPlanDetailDto(plan) : null;
}

export async function getPlan(
  clinicId: string,
  planId: string,
): Promise<TreatmentPlanDto | null> {
  const plan = await getPlanRow(clinicId, planId);
  return plan ? toTreatmentPlanDto(plan) : null;
}

// ---------------------------------------------------------------------------
// Plan CRUD
// ---------------------------------------------------------------------------

export async function createPlan(
  clinicId: string,
  userId: string,
  input: TreatmentPlanCreateInput,
): Promise<TreatmentPlanDto> {
  const patient = await prisma.patients.findUnique({
    where: { id: input.patient_id },
    select: { id: true, clinic_id: true },
  });
  if (!patient || patient.clinic_id !== clinicId) throw badRequest('Invalid patient');

  if (input.assigned_professional_id) {
    await assertProfessionalInClinic(clinicId, input.assigned_professional_id);
  }

  const planNumber = await generatePlanNumber(clinicId);
  const now = new Date();
  const planId = crypto.randomUUID();

  await prisma.treatment_plans.create({
    data: {
      id: planId,
      clinic_id: clinicId,
      patient_id: input.patient_id,
      plan_number: planNumber,
      title: input.title ?? null,
      status: 'draft',
      budget_id: null,
      assigned_professional_id: input.assigned_professional_id ?? null,
      created_by: userId,
      diagnosis_notes: input.diagnosis_notes ?? null,
      internal_notes: input.internal_notes ?? null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
      closure_reason: null,
      closure_note: null,
      closed_at: null,
      confirmed_at: null,
    },
  });

  const created = await getPlanRow(clinicId, planId);
  if (!created) throw notFound('Treatment plan not found');
  return toTreatmentPlanDto(created);
}

export async function updatePlan(
  clinicId: string,
  planId: string,
  input: TreatmentPlanUpdateInput,
): Promise<TreatmentPlanDto | null> {
  const plan = await getPlanRow(clinicId, planId);
  if (!plan) return null;

  const reassignPending = Boolean(input.reassign_pending_items);
  const oldProfessionalId = plan.assigned_professional_id;
  const newProfessionalId =
    input.assigned_professional_id !== undefined
      ? input.assigned_professional_id
      : oldProfessionalId;

  if (newProfessionalId !== null && newProfessionalId !== oldProfessionalId) {
    await assertProfessionalInClinic(clinicId, newProfessionalId);
  }

  // `null` = « ne pas toucher » (port du `if value is not None` Python).
  const data: Prisma.treatment_plansUncheckedUpdateInput = { updated_at: new Date() };
  if (input.title !== undefined && input.title !== null) data.title = input.title;
  if (input.assigned_professional_id !== undefined && input.assigned_professional_id !== null) {
    data.assigned_professional_id = input.assigned_professional_id;
  }
  if (input.diagnosis_notes !== undefined && input.diagnosis_notes !== null) {
    data.diagnosis_notes = input.diagnosis_notes;
  }
  if (input.internal_notes !== undefined && input.internal_notes !== null) {
    data.internal_notes = input.internal_notes;
  }

  const cascade =
    reassignPending
    && oldProfessionalId !== null
    && newProfessionalId !== null
    && oldProfessionalId !== newProfessionalId;

  await prisma.$transaction(async (tx) => {
    await tx.treatment_plans.update({ where: { id: planId }, data });
    if (cascade) {
      await tx.planned_treatment_items.updateMany({
        where: {
          treatment_plan_id: planId,
          clinic_id: clinicId,
          status: 'pending',
          assigned_professional_id: oldProfessionalId,
        },
        data: { assigned_professional_id: newProfessionalId, updated_at: new Date() },
      });
    }
  });

  const updated = await getPlanRow(clinicId, planId);
  return updated ? toTreatmentPlanDto(updated) : null;
}

/** Plan `draft` avec au moins un item → 400 `Cannot confirm plan without treatments`. */
function assertHasItems(plan: PlanRow, message: string): void {
  if (plan.planned_treatment_items.length === 0) throw badRequest(message);
}

export async function updatePlanStatus(
  clinicId: string,
  planId: string,
  newStatus: string,
  _userId: string,
): Promise<TreatmentPlanDto | null> {
  const plan = await getPlanRow(clinicId, planId);
  if (!plan) return null;

  const oldStatus = plan.status;
  if (oldStatus === newStatus) return toTreatmentPlanDto(plan);

  if (!(VALID_PLAN_TRANSITIONS[oldStatus] ?? []).includes(newStatus)) {
    throw badRequest(`Invalid status transition from ${oldStatus} to ${newStatus}`);
  }
  if (newStatus === 'active') assertHasItems(plan, 'Cannot activate plan without treatments');

  await prisma.$transaction(async (tx) => {
    await tx.treatment_plans.update({
      where: { id: planId },
      data: { status: newStatus, updated_at: new Date() },
    });
    if (newStatus === 'closed' || newStatus === 'archived') {
      await cleanupOrphanPlannedTreatments(tx, clinicId, planId);
    }
  });

  const updated = await getPlanRow(clinicId, planId);
  return updated ? toTreatmentPlanDto(updated) : null;
}

export async function deletePlan(
  clinicId: string,
  planId: string,
  _userId: string,
): Promise<boolean> {
  const plan = await getPlanRow(clinicId, planId);
  if (!plan) return false;

  await prisma.$transaction(async (tx) => {
    await cleanupOrphanPlannedTreatments(tx, clinicId, planId);
    const now = new Date();
    await tx.treatment_plans.update({
      where: { id: planId },
      data: { deleted_at: now, updated_at: now },
    });
  });
  return true;
}

/**
 * Soft-delete des traitements devenus orphelins quand le plan devient
 * terminal (port de `_cleanup_orphan_planned_treatments`). Les traitements
 * `performed` sont conservés (historique clinique).
 */
async function cleanupOrphanPlannedTreatments(
  tx: Prisma.TransactionClient,
  clinicId: string,
  planId: string,
): Promise<void> {
  const items = await tx.planned_treatment_items.findMany({
    where: { treatment_plan_id: planId },
    select: { treatment_id: true },
  });
  const treatmentIds = [...new Set(items.map((item) => item.treatment_id))];
  if (treatmentIds.length === 0) return;

  for (const treatmentId of treatmentIds) {
    const otherRefs = await tx.planned_treatment_items.count({
      where: {
        treatment_id: treatmentId,
        clinic_id: clinicId,
        treatment_plan_id: { not: planId },
        treatment_plans: {
          deleted_at: null,
          status: { notIn: ['archived', 'cancelled'] },
        },
      },
    });
    if (otherRefs > 0) continue;

    const treatment = await tx.treatments.findUnique({
      where: { id: treatmentId },
      select: { id: true, deleted_at: true, status: true },
    });
    if (treatment && treatment.deleted_at === null && treatment.status === 'planned') {
      const now = new Date();
      await tx.treatments.update({
        where: { id: treatmentId },
        data: { deleted_at: now, updated_at: now },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Sessions snapshot
// ---------------------------------------------------------------------------

function pickLabel(labels: unknown): string | null {
  const record = asRecord(labels);
  return record.es || record.en || Object.values(record)[0] || null;
}

/**
 * Patron de séances d'un nouvel item (port de `_snapshot_sessions_from_catalog`).
 * Renvoie des `{ sequence, label, amountCents }`.
 */
function snapshotSessions(
  treatmentTotal: number,
  catalogSessions: Array<{ labels: unknown; default_price: Prisma.Decimal }>,
): Array<{ sequence: number; label: string | null; amountCents: number }> {
  if (catalogSessions.length === 0) {
    return [{ sequence: 1, label: null, amountCents: treatmentTotal }];
  }
  const catalogAmounts = catalogSessions.map((session) => toCents(session.default_price));
  const catalogTotal = catalogAmounts.reduce((sum, cents) => sum + cents, 0);

  let amounts: number[];
  if (catalogTotal > 0 && treatmentTotal > 0 && catalogTotal !== treatmentTotal) {
    amounts = catalogAmounts.map((cents) => round2((cents / catalogTotal) * treatmentTotal));
    const drift = treatmentTotal - amounts.reduce((sum, cents) => sum + cents, 0);
    amounts[amounts.length - 1] = (amounts[amounts.length - 1] ?? 0) + drift;
  } else {
    amounts = catalogAmounts;
  }

  return catalogSessions.map((session, index) => ({
    sequence: index + 1,
    label: pickLabel(session.labels),
    amountCents: amounts[index] ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Item operations
// ---------------------------------------------------------------------------

const lockedMessage = 'Plan is locked by an active budget';

async function loadItemRow(
  clinicId: string,
  planId: string,
  itemId: string,
): Promise<PlanItemRow | null> {
  return prisma.planned_treatment_items.findFirst({
    where: {
      id: itemId,
      treatment_plan_id: planId,
      clinic_id: clinicId,
      treatment_plans: { clinic_id: clinicId, deleted_at: null },
    },
    include: planItemInclude,
  });
}

function assertUnlocked(plan: PlanRow | { budget_id: string | null; budgets: { status: string } | null }): void {
  if (isPlanLocked(plan)) throw new PlanLockedError(lockedMessage);
}

export async function addItem(
  clinicId: string,
  planId: string,
  input: PlannedItemCreateInput,
): Promise<PlannedItemDto> {
  const plan = await getPlanRow(clinicId, planId);
  if (!plan) throw badRequest('Treatment plan not found');

  if (!['draft', 'pending', 'active'].includes(plan.status)) {
    throw badRequest('Cannot add items to a completed/closed plan');
  }
  assertUnlocked(plan);

  const treatment = await prisma.treatments.findUnique({
    where: { id: input.treatment_id },
  });
  if (
    !treatment
    || treatment.clinic_id !== clinicId
    || treatment.patient_id !== plan.patient_id
    || treatment.deleted_at !== null
  ) {
    throw badRequest('Invalid treatment for this plan');
  }

  let sequenceOrder = input.sequence_order ?? null;
  if (sequenceOrder === null) {
    const max = await prisma.planned_treatment_items.aggregate({
      where: { treatment_plan_id: planId },
      _max: { sequence_order: true },
    });
    sequenceOrder = (max._max.sequence_order ?? 0) + 1;
  }

  let assignedProfessionalId = input.assigned_professional_id ?? null;
  if (assignedProfessionalId === null) assignedProfessionalId = plan.assigned_professional_id;
  if (assignedProfessionalId !== null) {
    await assertProfessionalInClinic(clinicId, assignedProfessionalId);
  }

  const catalogSessions = treatment.catalog_item_id
    ? await prisma.catalog_item_sessions.findMany({
        where: { catalog_item_id: treatment.catalog_item_id },
        orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
        select: { labels: true, default_price: true },
      })
    : [];

  const treatmentTotal = toCents(treatment.price_snapshot ?? 0);
  const sessions = snapshotSessions(treatmentTotal, catalogSessions);

  const itemId = crypto.randomUUID();
  const now = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      await tx.planned_treatment_items.create({
        data: {
          id: itemId,
          clinic_id: clinicId,
          treatment_plan_id: planId,
          treatment_id: input.treatment_id,
          sequence_order: sequenceOrder as number,
          status: 'pending',
          completed_without_appointment: false,
          completed_at: null,
          completed_by: null,
          notes: input.notes ?? null,
          created_at: now,
          updated_at: now,
          assigned_professional_id: assignedProfessionalId,
        },
      });
      for (const session of sessions) {
        await tx.planned_treatment_item_sessions.create({
          data: {
            id: crypto.randomUUID(),
            plan_item_id: itemId,
            sequence: session.sequence,
            label: session.label,
            amount: centsToDecimal(session.amountCents),
            status: 'pending',
            completed_at: null,
            completed_by: null,
            notes: null,
            created_at: now,
            updated_at: now,
          },
        });
      }
    });
  } catch (error) {
    // `uq_planned_item_treatment` : un traitement ne peut être planifié deux fois.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw conflict('Planned item already exists for this treatment');
    }
    throw error;
  }

  const created = await loadItemRow(clinicId, planId, itemId);
  if (!created) throw notFound('Treatment item not found');
  return toPlannedItemDto(created);
}

export async function updateItem(
  clinicId: string,
  planId: string,
  itemId: string,
  input: PlannedItemUpdateInput,
): Promise<PlannedItemDto | null> {
  const plan = await getPlanRow(clinicId, planId);
  if (!plan) return null;

  // Réassigner le docteur ne change pas le contrat patient → pas de verrou.
  const nonDoctorKeys = Object.keys(input).filter((key) => key !== 'assigned_professional_id');
  if (nonDoctorKeys.length > 0) assertUnlocked(plan);

  const item = await loadItemRow(clinicId, planId, itemId);
  if (!item) return null;

  const hasDoctor = Object.prototype.hasOwnProperty.call(input, 'assigned_professional_id');
  if (hasDoctor && item.status !== 'pending') {
    throw badRequest('Cannot change the assigned doctor on a non-pending item');
  }

  const data: Prisma.planned_treatment_itemsUncheckedUpdateInput = { updated_at: new Date() };

  if (hasDoctor) {
    const newProfessionalId = input.assigned_professional_id ?? null;
    if (newProfessionalId !== null) {
      await assertProfessionalInClinic(clinicId, newProfessionalId);
    }
    data.assigned_professional_id = newProfessionalId;
  }
  if (input.sequence_order !== undefined && input.sequence_order !== null) {
    data.sequence_order = input.sequence_order;
  }
  if (input.notes !== undefined && input.notes !== null) {
    data.notes = input.notes;
  }

  await prisma.planned_treatment_items.update({ where: { id: itemId }, data });
  const updated = await loadItemRow(clinicId, planId, itemId);
  return updated ? toPlannedItemDto(updated) : null;
}

/**
 * Réordonne tous les items (`sequence_order` = position dans `item_ids`).
 * Renvoie `false` si le plan n'existe pas.
 */
export async function reorderItems(
  clinicId: string,
  planId: string,
  itemIds: string[],
): Promise<boolean> {
  const plan = await prisma.treatment_plans.findFirst({
    where: { id: planId, clinic_id: clinicId, deleted_at: null },
    include: { budgets: { select: { status: true } } },
  });
  if (!plan) return false;
  assertUnlocked(plan);

  const current = await prisma.planned_treatment_items.findMany({
    where: { treatment_plan_id: planId, clinic_id: clinicId },
    select: { id: true },
  });
  const currentIds = new Set(current.map((item) => item.id));

  if (new Set(itemIds).size !== itemIds.length) {
    throw badRequest('Duplicate item ids not allowed');
  }
  const sameSet =
    currentIds.size === itemIds.length && itemIds.every((id) => currentIds.has(id));
  if (!sameSet) {
    throw badRequest("item_ids must cover exactly the plan's current items");
  }

  const now = new Date();
  await prisma.$transaction(
    itemIds.map((id, index) =>
      prisma.planned_treatment_items.update({
        where: { id },
        data: { sequence_order: index, updated_at: now },
      }),
    ),
  );
  return true;
}

export async function removeItem(
  clinicId: string,
  planId: string,
  itemId: string,
): Promise<boolean> {
  const plan = await getPlanRow(clinicId, planId);
  if (!plan) return false;
  assertUnlocked(plan);

  const item = await prisma.planned_treatment_items.findFirst({
    where: { id: itemId, treatment_plan_id: planId, clinic_id: clinicId },
  });
  if (!item) return false;

  const links = await prisma.appointment_treatments.findMany({
    where: {
      planned_treatment_item_id: item.id,
      appointments: { clinic_id: clinicId },
    },
    select: { id: true, appointments: { select: { status: true } } },
  });
  if (links.some((link) => link.appointments.status !== 'cancelled')) {
    throw new PlanItemBookedError('Treatment is booked in an appointment; unlink it there first');
  }

  await prisma.$transaction(async (tx) => {
    if (links.length > 0) {
      await tx.appointment_treatments.deleteMany({
        where: { id: { in: links.map((link) => link.id) } },
      });
    }
    await tx.planned_treatment_items.delete({ where: { id: item.id } });

    // Règle orphelin : le traitement `planned` n'est plus référencé → soft-delete.
    const remaining = await tx.planned_treatment_items.count({
      where: { treatment_id: item.treatment_id, clinic_id: clinicId },
    });
    if (remaining === 0) {
      const treatment = await tx.treatments.findUnique({
        where: { id: item.treatment_id },
        select: { id: true, deleted_at: true, status: true },
      });
      if (treatment && treatment.deleted_at === null && treatment.status === 'planned') {
        const now = new Date();
        await tx.treatments.update({
          where: { id: item.treatment_id },
          data: { deleted_at: now, updated_at: now },
        });
      }
    }
  });
  return true;
}

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

async function ensureUnlocked(clinicId: string, planId: string): Promise<void> {
  const plan = await prisma.treatment_plans.findFirst({
    where: { id: planId, clinic_id: clinicId, deleted_at: null },
    select: { budget_id: true, budgets: { select: { status: true } } },
  });
  if (plan) assertUnlocked(plan);
}

async function planStatusForCompletion(
  clinicId: string,
  planId: string,
): Promise<string> {
  const plan = await prisma.treatment_plans.findFirst({
    where: { id: planId, clinic_id: clinicId },
    select: { status: true },
  });
  return plan?.status ?? '';
}

/** Finalise l'item (statut `completed`, traitement performed, plan auto-complet). */
async function finalizeItem(
  clinicId: string,
  planId: string,
  itemId: string,
  userId: string,
  completedWithoutAppointment: boolean,
  notes: string | null,
): Promise<void> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const item = await tx.planned_treatment_items.findUnique({ where: { id: itemId } });
    if (!item) return;

    await tx.planned_treatment_items.update({
      where: { id: itemId },
      data: {
        status: 'completed',
        completed_at: now,
        completed_by: userId,
        completed_without_appointment: completedWithoutAppointment,
        ...(notes && !item.notes ? { notes } : {}),
        updated_at: now,
      },
    });

    // Performs the Treatment (port de `TreatmentService.perform(publish_price=False)`).
    const treatment = await tx.treatments.findUnique({ where: { id: item.treatment_id } });
    if (treatment) {
      await tx.treatments.update({
        where: { id: item.treatment_id },
        data: {
          status: 'performed',
          performed_at: now,
          performed_by: userId,
          ...(notes ? { notes } : {}),
          updated_at: now,
        },
      });
    }
  });

  await checkAndCompletePlan(clinicId, planId);
}

/** Auto-complète le plan `active` quand tous ses items sont terminés. */
async function checkAndCompletePlan(clinicId: string, planId: string): Promise<void> {
  const plan = await prisma.treatment_plans.findFirst({
    where: { id: planId, clinic_id: clinicId, deleted_at: null },
    select: { id: true, status: true, planned_treatment_items: { select: { status: true } } },
  });
  if (!plan || plan.status !== 'active') return;
  if (plan.planned_treatment_items.some((item) => item.status !== 'completed')) return;

  await prisma.treatment_plans.update({
    where: { id: planId },
    data: { status: 'completed', updated_at: new Date() },
  });
}

async function finalizeIfTerminal(
  item: PlanItemRow,
  clinicId: string,
  planId: string,
  userId: string,
  completedWithoutAppointment: boolean,
  notes: string | null,
): Promise<void> {
  const sessions = await prisma.planned_treatment_item_sessions.findMany({
    where: { plan_item_id: item.id },
    select: { status: true },
  });
  const allTerminal = sessions.every(
    (session) => session.status === 'completed' || session.status === 'cancelled',
  );
  const anyCompleted = sessions.some((session) => session.status === 'completed');
  if (allTerminal && anyCompleted && item.status !== 'completed') {
    await finalizeItem(clinicId, planId, item.id, userId, completedWithoutAppointment, notes);
  }
}

export async function completeItem(
  clinicId: string,
  planId: string,
  itemId: string,
  userId: string,
  completedWithoutAppointment: boolean,
  notes: string | null,
): Promise<PlannedItemDto | null> {
  const item = await loadItemRow(clinicId, planId, itemId);
  if (!item) return null;
  if (item.status === 'completed') return toPlannedItemDto(item);

  const sorted = [...item.planned_treatment_item_sessions].sort(
    (a, b) => a.sequence - b.sequence,
  );
  const nextSession = sorted.find((session) => session.status === 'pending');
  if (!nextSession) throw badRequest('No pending sessions to complete');

  return completeSession(
    clinicId,
    planId,
    itemId,
    nextSession.id,
    userId,
    completedWithoutAppointment,
    notes,
  );
}

export async function completeSession(
  clinicId: string,
  planId: string,
  itemId: string,
  sessionId: string,
  userId: string,
  completedWithoutAppointment: boolean,
  notes: string | null,
): Promise<PlannedItemDto | null> {
  const item = await loadItemRow(clinicId, planId, itemId);
  if (!item) return null;

  const status = await planStatusForCompletion(clinicId, planId);
  if (status !== 'active') throw badRequest('Plan must be active to complete treatments');

  const session = item.planned_treatment_item_sessions.find((row) => row.id === sessionId);
  if (!session) throw badRequest('Session not found');
  if (session.status !== 'pending') throw badRequest('Session is not pending');

  const now = new Date();
  await prisma.planned_treatment_item_sessions.update({
    where: { id: session.id },
    data: {
      status: 'completed',
      completed_at: now,
      completed_by: userId,
      ...(notes ? { notes } : {}),
      updated_at: now,
    },
  });

  await finalizeIfTerminal(item, clinicId, planId, userId, completedWithoutAppointment, notes);

  const updated = await loadItemRow(clinicId, planId, itemId);
  return updated ? toPlannedItemDto(updated) : null;
}

export async function cancelSession(
  clinicId: string,
  planId: string,
  itemId: string,
  sessionId: string,
  userId: string,
  notes: string | null,
): Promise<PlannedItemDto | null> {
  const item = await loadItemRow(clinicId, planId, itemId);
  if (!item) return null;

  const session = item.planned_treatment_item_sessions.find((row) => row.id === sessionId);
  if (!session) throw badRequest('Session not found');
  if (session.status !== 'pending') throw badRequest('Only pending sessions can be cancelled');

  const now = new Date();
  await prisma.planned_treatment_item_sessions.update({
    where: { id: session.id },
    data: {
      status: 'cancelled',
      completed_at: now,
      completed_by: userId,
      ...(notes ? { notes } : {}),
      updated_at: now,
    },
  });

  await finalizeIfTerminal(item, clinicId, planId, userId, false, null);

  const updated = await loadItemRow(clinicId, planId, itemId);
  return updated ? toPlannedItemDto(updated) : null;
}

export async function updateSession(
  clinicId: string,
  planId: string,
  itemId: string,
  sessionId: string,
  input: UpdateSessionInput,
): Promise<PlannedItemDto | null> {
  const item = await loadItemRow(clinicId, planId, itemId);
  if (!item) return null;

  const session = item.planned_treatment_item_sessions.find((row) => row.id === sessionId);
  if (!session) throw badRequest('Session not found');
  if (session.status !== 'pending') throw badRequest('Cannot edit a non-pending session');
  await ensureUnlocked(clinicId, planId);

  const data: Prisma.planned_treatment_item_sessionsUncheckedUpdateInput = { updated_at: new Date() };
  if (Object.prototype.hasOwnProperty.call(input, 'label')) data.label = input.label ?? null;
  if (input.amount !== undefined && input.amount !== null) {
    data.amount = new Prisma.Decimal(String(input.amount));
  }
  if (Object.prototype.hasOwnProperty.call(input, 'notes')) data.notes = input.notes ?? null;

  await prisma.planned_treatment_item_sessions.update({ where: { id: session.id }, data });
  const updated = await loadItemRow(clinicId, planId, itemId);
  return updated ? toPlannedItemDto(updated) : null;
}

export async function addSessionManual(
  clinicId: string,
  planId: string,
  itemId: string,
  input: SessionInput,
): Promise<PlannedItemDto | null> {
  const item = await loadItemRow(clinicId, planId, itemId);
  if (!item) return null;
  await ensureUnlocked(clinicId, planId);

  const nextSeq =
    item.planned_treatment_item_sessions.reduce(
      (max, session) => Math.max(max, session.sequence),
      0,
    ) + 1;

  const now = new Date();
  await prisma.planned_treatment_item_sessions.create({
    data: {
      id: crypto.randomUUID(),
      plan_item_id: item.id,
      sequence: nextSeq,
      label: input.label ?? null,
      amount: new Prisma.Decimal(String(input.amount)),
      status: 'pending',
      completed_at: null,
      completed_by: null,
      notes: null,
      created_at: now,
      updated_at: now,
    },
  });

  const updated = await loadItemRow(clinicId, planId, itemId);
  return updated ? toPlannedItemDto(updated) : null;
}

export async function deleteSession(
  clinicId: string,
  planId: string,
  itemId: string,
  sessionId: string,
): Promise<PlannedItemDto | null> {
  const item = await loadItemRow(clinicId, planId, itemId);
  if (!item) return null;

  const session = item.planned_treatment_item_sessions.find((row) => row.id === sessionId);
  if (!session) throw badRequest('Session not found');
  if (session.status !== 'pending') throw badRequest('Cannot delete a non-pending session');
  await ensureUnlocked(clinicId, planId);

  const pendingCount = item.planned_treatment_item_sessions.filter(
    (row) => row.status === 'pending',
  ).length;
  if (pendingCount <= 1 && item.planned_treatment_item_sessions.length === 1) {
    throw badRequest('Cannot delete the only session of an item');
  }

  await prisma.planned_treatment_item_sessions.delete({ where: { id: session.id } });
  const updated = await loadItemRow(clinicId, planId, itemId);
  return updated ? toPlannedItemDto(updated) : null;
}

// ---------------------------------------------------------------------------
// Workflow transitions
// ---------------------------------------------------------------------------

function assertStatus(plan: PlanRow, expected: string, message: string): void {
  if (plan.status !== expected) throw badRequest(message);
}

export async function confirmPlan(
  clinicId: string,
  planId: string,
  userId: string,
): Promise<TreatmentPlanDto> {
  const plan = await getPlanRow(clinicId, planId);
  if (!plan) throw badRequest('Plan not found');
  assertStatus(plan, 'draft', `Cannot confirm plan in status '${plan.status}'`);
  assertHasItems(plan, 'Cannot confirm plan without treatments');

  const now = new Date();
  const budgetId = await generateBudgetFromPlan(clinicId, userId, plan);

  await prisma.treatment_plans.update({
    where: { id: planId },
    data: {
      status: 'pending',
      confirmed_at: now,
      budget_id: budgetId,
      updated_at: now,
    },
  });

  const updated = await getPlanRow(clinicId, planId);
  if (!updated) throw notFound('Treatment plan not found');
  return toTreatmentPlanDto(updated);
}

export async function reopenPlan(
  clinicId: string,
  planId: string,
  _userId: string,
): Promise<TreatmentPlanDto> {
  const plan = await getPlanRow(clinicId, planId);
  if (!plan) throw badRequest('Plan not found');
  assertStatus(plan, 'pending', `Cannot reopen plan in status '${plan.status}'`);

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // Annule le budget lié s'il peut encore l'être (les statuts terminaux sont laissés).
    if (plan.budget_id && plan.budgets) {
      const cancellable = !['cancelled', 'rejected', 'expired', 'accepted'].includes(
        plan.budgets.status,
      );
      if (cancellable) {
        await tx.budgets.update({
          where: { id: plan.budget_id },
          data: { status: 'cancelled', updated_at: now },
        });
      }
    }
    await tx.treatment_plans.update({
      where: { id: planId },
      data: { status: 'draft', confirmed_at: null, updated_at: now },
    });
  });

  const updated = await getPlanRow(clinicId, planId);
  if (!updated) throw notFound('Treatment plan not found');
  return toTreatmentPlanDto(updated);
}

export async function closePlan(
  clinicId: string,
  planId: string,
  userId: string,
  closureReason: string,
  closureNote: string | null,
): Promise<TreatmentPlanDto> {
  if (!(VALID_CLOSURE_REASONS as readonly string[]).includes(closureReason)) {
    throw badRequest(`Unknown closure_reason '${closureReason}'`);
  }

  const plan = await getPlanRow(clinicId, planId);
  if (!plan) throw badRequest('Plan not found');
  if (!(VALID_PLAN_TRANSITIONS[plan.status] ?? []).includes('closed')) {
    throw badRequest(`Cannot close plan in status '${plan.status}'`);
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.treatment_plans.update({
      where: { id: planId },
      data: {
        status: 'closed',
        closure_reason: closureReason,
        closure_note: closureNote,
        closed_at: now,
        updated_at: now,
      },
    });
    await cleanupOrphanPlannedTreatments(tx, clinicId, planId);
  });

  const updated = await getPlanRow(clinicId, planId);
  if (!updated) throw notFound('Treatment plan not found');
  return toTreatmentPlanDto(updated);
}

export async function reactivatePlan(
  clinicId: string,
  planId: string,
  _userId: string,
): Promise<TreatmentPlanDto> {
  const plan = await getPlanRow(clinicId, planId);
  if (!plan) throw badRequest('Plan not found');
  assertStatus(plan, 'closed', `Cannot reactivate plan in status '${plan.status}'`);

  await prisma.treatment_plans.update({
    where: { id: planId },
    data: {
      status: 'draft',
      closure_reason: null,
      closure_note: null,
      closed_at: null,
      confirmed_at: null,
      updated_at: new Date(),
    },
  });

  const updated = await getPlanRow(clinicId, planId);
  if (!updated) throw notFound('Treatment plan not found');
  return toTreatmentPlanDto(updated);
}

/** Ajoute une ligne d'horodatage dans `internal_notes` (touchpoint réception). */
export async function logContact(
  clinicId: string,
  planId: string,
  userId: string,
  channel: string,
  note: string | null,
): Promise<boolean> {
  const plan = await prisma.treatment_plans.findFirst({
    where: { id: planId, clinic_id: clinicId, deleted_at: null },
    select: { id: true, internal_notes: true },
  });
  if (!plan) return false;

  let line = `[${new Date().toISOString()}] ${channel} by ${userId}`;
  if (note) line += ` — ${note.trim()}`;
  const internalNotes = plan.internal_notes ? `${plan.internal_notes}\n${line}`.trim() : line;

  await prisma.treatment_plans.update({
    where: { id: planId },
    data: { internal_notes: internalNotes, updated_at: new Date() },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Budget integration
// ---------------------------------------------------------------------------

export async function linkBudget(
  clinicId: string,
  planId: string,
  budgetId: string,
): Promise<TreatmentPlanDto | null> {
  const plan = await getPlanRow(clinicId, planId);
  if (!plan) return null;

  const budget = await prisma.budgets.findUnique({ where: { id: budgetId } });
  if (!budget || budget.clinic_id !== clinicId) throw badRequest('Invalid budget');
  if (budget.patient_id !== plan.patient_id) {
    throw badRequest('Budget belongs to different patient');
  }
  if ((TERMINAL_BUDGET_STATUSES as readonly string[]).includes(budget.status)) {
    throw badRequest('Cannot link a cancelled, rejected or expired budget');
  }

  if (plan.budget_id && plan.budget_id !== budgetId) {
    const current = await prisma.budgets.findUnique({
      where: { id: plan.budget_id },
      select: { status: true },
    });
    if (current && !(TERMINAL_BUDGET_STATUSES as readonly string[]).includes(current.status)) {
      throw badRequest('Plan already has a live budget');
    }
  }

  // `treatment_plans.budget_id` est unique → erreur propre plutôt qu'un 500.
  const other = await prisma.treatment_plans.findFirst({
    where: { budget_id: budgetId, id: { not: planId } },
    select: { id: true },
  });
  if (other) throw badRequest('Budget is already linked to another plan');

  await prisma.treatment_plans.update({
    where: { id: planId },
    data: { budget_id: budgetId, updated_at: new Date() },
  });

  const updated = await getPlanRow(clinicId, planId);
  return updated ? toTreatmentPlanDto(updated) : null;
}

/**
 * Synchronisation plan → budget. Le bus d'événements Python n'a pas
 * d'équivalent ici : l'état renvoyé (`{synced: true}`) et les contrôles
 * sont identiques, seule la propagation croisée des modules est omise.
 */
export async function requestBudgetSync(clinicId: string, planId: string): Promise<boolean> {
  const plan = await prisma.treatment_plans.findFirst({
    where: { id: planId, clinic_id: clinicId, deleted_at: null },
    select: { budget_id: true },
  });
  if (!plan || !plan.budget_id) return false;
  return true;
}

/** Génère un budget draft à partir des items du plan (port de `BudgetService.create_budget`). */
export async function generateBudgetFromPlan(
  clinicId: string,
  userId: string,
  plan: PlanRow,
): Promise<string> {
  if (plan.budget_id) {
    const existing = await prisma.budgets.findUnique({
      where: { id: plan.budget_id },
      select: { status: true },
    });
    if (existing && existing.status === 'cancelled') {
      // Budget annulé → on le détache pour en créer un nouveau.
      await prisma.treatment_plans.update({
        where: { id: plan.id },
        data: { budget_id: null, updated_at: new Date() },
      });
    } else {
      throw badRequest('Plan already has a budget linked');
    }
  }

  if (plan.planned_treatment_items.length === 0) {
    throw badRequest('Plan has no items to create budget from');
  }

  const lines: Array<{
    catalogItemId: string;
    treatmentId: string;
    unitPrice: number;
    toothNumber: number | null;
    surfaces: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  }> = [];

  for (const item of plan.planned_treatment_items) {
    const treatment = item.treatments;
    if (!treatment || !treatment.catalog_item_id) continue;
    const primary = treatment.treatment_teeth[0] ?? null;
    const surfaces = asStringArray(primary?.surfaces ?? null);
    lines.push({
      catalogItemId: treatment.catalog_item_id,
      treatmentId: treatment.id,
      // Centimes entiers du prix snapshot (aucun prix → 0.00).
      unitPrice: toCents(treatment.price_snapshot ?? 0),
      toothNumber: primary?.tooth_number ?? null,
      surfaces: surfaces
        ? (surfaces as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    });
  }

  if (lines.length === 0) throw badRequest('No catalog items found in plan to create budget');

  const year = (await clinicToday(clinicId)).slice(0, 4);
  const prefix = `PRES-${year}-`;

  return prisma.$transaction(async (tx) => {
    // Verrou consultatif par clinique (comme Python) pour sérialiser les numéros.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`budget_number:${clinicId}`}, 0))`;

    const last = await tx.budgets.findFirst({
      where: { clinic_id: clinicId, budget_number: { startsWith: prefix } },
      orderBy: { budget_number: 'desc' },
      select: { budget_number: true },
    });
    let sequence = 1;
    if (last) {
      const parsed = Number.parseInt(last.budget_number.split('-').pop() ?? '', 10);
      sequence = Number.isFinite(parsed) ? parsed + 1 : 1;
    }
    const budgetNumber = `${prefix}${String(sequence).padStart(4, '0')}`;

    const now = new Date();
    const budgetId = crypto.randomUUID();

    const vatByCatalog = new Map<string, { vatTypeId: string | null; rate: number }>();
    for (const line of lines) {
      if (vatByCatalog.has(line.catalogItemId)) continue;
      const catalog = await tx.treatment_catalog_items.findUnique({
        where: { id: line.catalogItemId },
        select: {
          clinic_id: true,
          vat_type_id: true,
          vat_types: { select: { rate: true } },
        },
      });
      if (!catalog || catalog.clinic_id !== clinicId) throw badRequest('Invalid catalog item');
      vatByCatalog.set(line.catalogItemId, {
        vatTypeId: catalog.vat_type_id,
        rate: catalog.vat_types ? Number(catalog.vat_types.rate) : 0,
      });
    }

    let subtotalCents = 0;
    let taxCents = 0;
    const itemRows = lines.map((line, index) => {
      const unitCents = line.unitPrice;
      const subtotal = unitCents;
      const rate = vatByCatalog.get(line.catalogItemId)?.rate ?? 0;
      const tax = Math.round(subtotal * (rate / 100));
      subtotalCents += subtotal;
      taxCents += tax;
      return {
        id: crypto.randomUUID(),
        clinic_id: clinicId,
        budget_id: budgetId,
        catalog_item_id: line.catalogItemId,
        unit_price: centsToDecimal(unitCents),
        quantity: 1,
        discount_type: null,
        discount_value: null,
        vat_type_id: vatByCatalog.get(line.catalogItemId)?.vatTypeId ?? null,
        vat_rate: rate,
        line_subtotal: centsToDecimal(subtotal),
        line_discount: centsToDecimal(0),
        line_tax: centsToDecimal(tax),
        line_total: centsToDecimal(subtotal + tax),
        tooth_number: line.toothNumber,
        surfaces: line.surfaces,
        treatment_id: line.treatmentId,
        invoiced_quantity: 0,
        display_order: index,
        notes: null,
        created_at: now,
        updated_at: now,
      };
    });

    const validFrom = new Date(`${await clinicToday(clinicId)}T00:00:00.000Z`);

    await tx.budgets.create({
      data: {
        id: budgetId,
        clinic_id: clinicId,
        patient_id: plan.patient_id,
        budget_number: budgetNumber,
        version: 1,
        parent_budget_id: null,
        status: 'draft',
        valid_from: validFrom,
        valid_until: null,
        created_by: userId,
        assigned_professional_id: null,
        global_discount_type: null,
        global_discount_value: null,
        subtotal: centsToDecimal(subtotalCents),
        total_discount: centsToDecimal(0),
        total_tax: centsToDecimal(taxCents),
        total: centsToDecimal(subtotalCents + taxCents),
        internal_notes: `Generated from treatment plan ${plan.plan_number}`,
        patient_notes: null,
        insurance_estimate: null,
        deleted_at: null,
        created_at: now,
        updated_at: now,
        accepted_via: null,
        rejection_reason: null,
        rejection_note: null,
        public_token: crypto.randomUUID(),
        viewed_at: null,
        last_reminder_sent_at: null,
        public_auth_method: 'none',
        public_auth_secret_hash: null,
        public_locked_at: null,
        plan_number_snapshot: null,
        plan_status_snapshot: null,
      },
    });

    if (itemRows.length > 0) {
      await tx.budget_items.createMany({ data: itemRows });
    }

    await tx.budget_history.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: clinicId,
        budget_id: budgetId,
        action: 'created',
        changed_by: userId,
        changed_at: now,
        previous_state: Prisma.JsonNull,
        new_state: { status: 'draft', total: centsToDecimal(subtotalCents + taxCents).toString() },
        notes: null,
      },
    });

    return budgetId;
  });
}

export async function generateBudget(
  clinicId: string,
  planId: string,
  userId: string,
): Promise<{ budget_id: string; budget_number: string } | null> {
  const plan = await getPlanRow(clinicId, planId);
  if (!plan) return null;

  // Même chemin que la confirmation : réutilise une éventuelle création
  // concurrente (second clic) au lieu d'en générer une autre (#770).
  const budgetId = await generateBudgetFromPlan(clinicId, userId, plan);
  const budget = await prisma.budgets.findUnique({
    where: { id: budgetId },
    select: { budget_number: true },
  });

  await prisma.treatment_plans.update({
    where: { id: planId },
    data: { budget_id: budgetId, updated_at: new Date() },
  });

  return { budget_id: budgetId, budget_number: budget?.budget_number ?? '' };
}

// ---------------------------------------------------------------------------
// Bandeja de planes (pipeline)
// ---------------------------------------------------------------------------

interface PipelineRowRaw {
  plan_id: string;
  plan_number: string;
  plan_title: string | null;
  plan_status: string;
  closure_reason: string | null;
  confirmed_at: Date | null;
  closed_at: Date | null;
  updated_at: Date;
  patient_id: string;
  first_name: string;
  last_name: string;
  items_total: bigint | number;
  items_completed: bigint | number;
  budget_id: string | null;
  budget_status: string | null;
  budget_total: Prisma.Decimal | null;
  valid_until: Date | null;
  last_reminder_sent_at: Date | null;
  viewed_at: Date | null;
  next_appt_id: string | null;
  next_appt_start_at: Date | null;
  next_appt_cabinet: string | null;
  next_appt_professional: string | null;
}

const PIPELINE_TAB_SQL: Record<string, { where: string; orderBy: string }> = {
  por_presupuestar: {
    where: "p.status = 'pending' AND b.status = 'draft'",
    orderBy: 'COALESCE(p.confirmed_at, p.created_at) DESC',
  },
  esperando_paciente: {
    where: "p.status = 'pending' AND b.status IN ('sent', 'expired')",
    orderBy: 'COALESCE(p.confirmed_at, p.created_at) ASC',
  },
  sin_cita: {
    where:
      "p.status = 'active' AND COALESCE(appt.future_count, 0) = 0 AND COALESCE(appt.past_count, 0) = 0",
    orderBy: 'p.updated_at DESC',
  },
  sin_proxima_cita: {
    where:
      "p.status = 'active' AND COALESCE(appt.future_count, 0) = 0 "
      + 'AND COALESCE(appt.past_count, 0) > 0 AND COALESCE(items.pending_count, 0) > 0',
    orderBy: 'appt.last_past_at DESC NULLS LAST',
  },
  cerrados: {
    where: "p.status = 'closed' AND p.closed_at >= (NOW() - INTERVAL '90 days')",
    orderBy: 'p.closed_at DESC',
  },
};

const PIPELINE_BASE_SQL = `
    WITH item_counts AS (
        SELECT
            treatment_plan_id AS plan_id,
            COUNT(*) AS total_count,
            COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
            COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
        FROM planned_treatment_items
        WHERE clinic_id = $1::uuid
        GROUP BY treatment_plan_id
    ),
    plan_appts AS (
        SELECT
            pti.treatment_plan_id AS plan_id,
            COUNT(*) FILTER (
                WHERE a.start_time >= NOW()
                  AND a.status NOT IN ('cancelled', 'no_show')
            ) AS future_count,
            COUNT(*) FILTER (
                WHERE a.start_time < NOW()
                  AND a.status NOT IN ('cancelled', 'no_show')
            ) AS past_count,
            MAX(a.start_time) FILTER (
                WHERE a.start_time < NOW()
                  AND a.status NOT IN ('cancelled', 'no_show')
            ) AS last_past_at,
            MIN(a.start_time) FILTER (
                WHERE a.start_time >= NOW()
                  AND a.status NOT IN ('cancelled', 'no_show')
            ) AS next_future_at
        FROM planned_treatment_items pti
        JOIN appointment_treatments at ON at.planned_treatment_item_id = pti.id
        JOIN appointments a ON a.id = at.appointment_id
        WHERE pti.clinic_id = $1::uuid
        GROUP BY pti.treatment_plan_id
    ),
    next_appt AS (
        SELECT DISTINCT ON (pti.treatment_plan_id)
            pti.treatment_plan_id AS plan_id,
            a.id AS id,
            a.start_time AS start_at,
            a.cabinet_id AS cabinet_id,
            a.professional_id AS professional_id
        FROM planned_treatment_items pti
        JOIN appointment_treatments at ON at.planned_treatment_item_id = pti.id
        JOIN appointments a ON a.id = at.appointment_id
        WHERE pti.clinic_id = $1::uuid
          AND a.start_time >= NOW()
          AND a.status NOT IN ('cancelled', 'no_show')
        ORDER BY pti.treatment_plan_id, a.start_time ASC
    )
    SELECT
        p.id AS plan_id,
        p.plan_number,
        p.title AS plan_title,
        p.status AS plan_status,
        p.closure_reason,
        p.confirmed_at,
        p.closed_at,
        p.updated_at,
        pat.id AS patient_id,
        pat.first_name,
        pat.last_name,
        COALESCE(items.total_count, 0) AS items_total,
        COALESCE(items.completed_count, 0) AS items_completed,
        b.id AS budget_id,
        b.status AS budget_status,
        b.total AS budget_total,
        b.valid_until,
        b.last_reminder_sent_at,
        b.viewed_at,
        na.id AS next_appt_id,
        na.start_at AS next_appt_start_at,
        na.cabinet_id AS next_appt_cabinet,
        na.professional_id AS next_appt_professional
    FROM treatment_plans p
    JOIN patients pat ON pat.id = p.patient_id
    LEFT JOIN budgets b ON b.id = p.budget_id
    LEFT JOIN item_counts items ON items.plan_id = p.id
    LEFT JOIN plan_appts appt ON appt.plan_id = p.id
    LEFT JOIN next_appt na ON na.plan_id = p.id
    WHERE p.clinic_id = $1::uuid
      AND p.deleted_at IS NULL
      AND ({tab_where})
      {extra_where}
`;

function dateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

export async function listPipeline(
  clinicId: string,
  tab: string,
  page: number,
  pageSize: number,
  doctorId: string | null,
  search: string | null,
): Promise<{ rows: PipelineRowDto[]; total: number }> {
  const tabSql = PIPELINE_TAB_SQL[tab];
  if (!tabSql) throw badRequest(`Unknown pipeline tab '${tab}'`);

  const params: unknown[] = [clinicId];
  let extraWhere = '';
  if (doctorId) {
    params.push(doctorId);
    extraWhere += ` AND p.assigned_professional_id = $${params.length}::uuid`;
  }
  if (search) {
    params.push(`%${search}%`);
    extraWhere += ` AND (p.plan_number ILIKE $${params.length} OR pat.first_name ILIKE $${params.length} OR pat.last_name ILIKE $${params.length})`;
  }

  const baseSql = PIPELINE_BASE_SQL.replace('{tab_where}', tabSql.where).replace(
    '{extra_where}',
    extraWhere,
  );
  // COUNT et page doivent partager la même sous-requête (déjà triée) :
  // PostgreSQL conserve l'ordre des CTE imbriquées, comme le FastAPI.
  const countSql = `SELECT COUNT(*) AS total FROM (${baseSql}) sub`;
  const safePageSize = Math.min(Math.max(pageSize, 1), 100);
  const safePage = Math.max(page, 1);

  const countRows = await prisma.$queryRawUnsafe<Array<{ total: bigint }>>(countSql, ...params);
  const total = Number(countRows[0]?.total ?? 0);

  const pageParams = [...params, safePageSize, (safePage - 1) * safePageSize];
  const rows = await prisma.$queryRawUnsafe<PipelineRowRaw[]>(
    `${baseSql} ORDER BY ${tabSql.orderBy} LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
    ...pageParams,
  );

  const now = Date.now();
  const out: PipelineRowDto[] = rows.map((row) => {
    const anchor = row.confirmed_at ?? row.closed_at ?? row.updated_at;
    const days = anchor ? Math.floor((now - anchor.getTime()) / 86_400_000) : 0;
    return {
      plan_id: row.plan_id,
      plan_number: row.plan_number,
      plan_title: row.plan_title,
      plan_status: row.plan_status,
      days_in_status: Math.max(days, 0),
      closure_reason: row.closure_reason,
      items_total: Number(row.items_total),
      items_completed: Number(row.items_completed),
      patient: {
        id: row.patient_id,
        first_name: row.first_name,
        last_name: row.last_name,
      },
      budget: row.budget_id
        ? {
            id: row.budget_id,
            status: row.budget_status ?? '',
            total: dec(row.budget_total),
            valid_until: dateOnly(row.valid_until),
            last_reminder_sent_at: iso(row.last_reminder_sent_at),
            viewed_at: iso(row.viewed_at),
          }
        : null,
      next_appointment: row.next_appt_id
        ? {
            id: row.next_appt_id,
            start_at: (row.next_appt_start_at ?? new Date(0)).toISOString(),
            cabinet_id: row.next_appt_cabinet,
            professional_id: row.next_appt_professional,
          }
        : null,
    };
  });

  return { rows: out, total };
}

/** Nom d'affichage d'un item catalogue (rouvert par les consommateurs d'événements). */
export { catalogName };
