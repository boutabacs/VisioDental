/**
 * Couche service du module `budget` — port de
 * `app/modules/budget/{service,workflow}.py`.
 *
 * Tous les montants circulent en centimes entiers (nombres JS) et ne
 * deviennent des `Decimal` Prisma qu'au moment d'écrire en base, comme le
 * `Decimal.quantize` côté Python.
 *
 * Le bus d'événements Python n'a pas d'équivalent ici : les effets croisés
 * connus (plan de traitement lié et re-prix de ses séances) sont appliqués
 * dans la transaction du routeur, les autres (notifications, timeline)
 * restent à porter avec leurs modules.
 */

import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';

import { prisma } from '../../lib/prisma';
import {
  CLEARABLE_BUDGET_FIELDS,
  CLEARABLE_ITEM_FIELDS,
  PUBLIC_AUTH_FAIL_LIMIT_WINDOW,
  PUBLIC_AUTH_FAIL_WINDOW_MS,
  PUBLIC_AUTH_TOTAL_FAIL_LOCKOUT,
  addDays,
  canTransition,
  centsToDecimalString,
  clinicTodayDateString,
  isExpired,
  nextBudgetNumberSequence,
  parseSort,
  phoneDigits,
  serializeForJson,
  type BudgetCreateInput,
  type BudgetItemUpdateInput,
  type BudgetUpdateInput,
  type SignatureCreateInput,
} from './schemas';
import {
  allocateGlobalDiscount,
  computeBudgetTotals,
  computeLineTotals,
  netLineAmount,
  repricePendingSessions,
  type PriceLine,
} from './pricing';
import {
  renderBudgetHtml,
  type PdfBudget,
  type PdfBudgetItem,
  type PdfClinic,
  type PdfSignature,
} from './pdf';

// ---------------------------------------------------------------------------
// Erreurs métier
// ---------------------------------------------------------------------------

/** Devis lié à un plan : ses lignes se gèrent dans le plan (issue #176). */
export class PlanOwnsLinesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanOwnsLinesError';
  }
}

/** Seul un brouillon non lié à un plan peut être supprimé. */
export class BudgetNotDeletableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetNotDeletableError';
  }
}

/** Transition de workflow refusée / validation métier (→ 400). */
export class BudgetWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetWorkflowError';
  }
}

/** `ValueError` générique du service (`Invalid catalog item`,...). */
export class BudgetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetValidationError';
  }
}

/** Clé publique exigée en production (`_public_secret`). */
export class BudgetConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetConfigurationError';
  }
}

// ---------------------------------------------------------------------------
// Helpers numériques / dates
// ---------------------------------------------------------------------------

/** `Decimal` PostgreSQL → centimes entiers. */
export function toCents(value: Prisma.Decimal | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value.toString()) * 100);
}

/** Centimes → `Decimal` Prisma. */
export function cents(value: number): Prisma.Decimal {
  return new Prisma.Decimal(centsToDecimalString(centsValue(value)));
}

function centsValue(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

/** Montant optionnel → `Decimal | null`. */
function centsOrNull(value: number | null | undefined): Prisma.Decimal | null {
  return value === null || value === undefined ? null : cents(value);
}

/** `datetime.combine(day, min.time())` : colonne `date` → minuit UTC. */
export function dateColumnToUtc(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Partie date d'une colonne `Date` → `YYYY-MM-DD`. */
export function dateColumnToString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string');
}

function asRecord(value: unknown): Record<string, string> {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, string>;
}

function jsonNull(): Prisma.NullTypes.JsonNull {
  return Prisma.JsonNull;
}

/** Valeur JSON → `InputJsonValue | JsonNull`. */
function jsonInput(value: Prisma.JsonValue | null | undefined): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull {
  if (value === null || value === undefined) return jsonNull();
  return value as Prisma.InputJsonValue;
}

/**
 * `serialize_for_json` + écriture JSONB : les `Date` deviennent ISO et les
 * centimes passés explicitement en clé monétaire des chaînes `x.yz`.
 */
function historyJson(
  data: Record<string, unknown> | null | undefined,
  decimalKeys: ReadonlySet<string> = new Set(),
): Prisma.InputJsonValue | Prisma.NullTypes.JsonNull {
  const serialized = serializeForJson(data, decimalKeys);
  return jsonInput(serialized as Prisma.JsonValue);
}

// ---------------------------------------------------------------------------
// Sélection / DTOs
// ---------------------------------------------------------------------------

export const budgetItemInclude = {
  treatment_catalog_items: {
    select: { id: true, internal_code: true, names: true, default_price: true },
  },
  vat_types: { select: { id: true, names: true, rate: true } },
} satisfies Prisma.budget_itemsInclude;

const patientBriefSelect = {
  id: true,
  first_name: true,
  last_name: true,
  email: true,
  phone: true,
} satisfies Prisma.patientsSelect;

const userBriefSelect = {
  id: true,
  first_name: true,
  last_name: true,
} satisfies Prisma.usersSelect;

export const budgetInclude = {
  patients: { select: patientBriefSelect },
  users_budgets_created_byTousers: { select: userBriefSelect },
  users_budgets_assigned_professional_idTousers: { select: userBriefSelect },
  budget_items: { include: budgetItemInclude, orderBy: [{ display_order: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.budgetsInclude;

export const budgetDetailInclude = {
  ...budgetInclude,
  budget_signatures: { orderBy: [{ signed_at: 'desc' }, { id: 'asc' }] },
} satisfies Prisma.budgetsInclude;

export type BudgetRow = Prisma.budgetsGetPayload<{ include: typeof budgetInclude }>;
export type BudgetDetailRow = Prisma.budgetsGetPayload<{ include: typeof budgetDetailInclude }>;
export type BudgetItemRow = Prisma.budget_itemsGetPayload<{ include: typeof budgetItemInclude }>;
type SignatureRow = Prisma.budget_signaturesGetPayload<Record<string, never>>;
type BudgetBasicRow = Prisma.budgetsGetPayload<Record<string, never>>;

export interface PatientBriefDto {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
}

export interface UserBriefDto {
  id: string;
  first_name: string;
  last_name: string;
}

export interface CatalogItemBriefDto {
  id: string;
  internal_code: string;
  names: Record<string, string>;
  default_price: number | null;
}

export interface VatTypeBriefDto {
  id: string;
  names: Record<string, string>;
  rate: number;
}

export interface BudgetItemDto {
  id: string;
  budget_id: string;
  catalog_item_id: string;
  unit_price: number;
  quantity: number;
  discount_type: string | null;
  discount_value: number | null;
  vat_type_id: string | null;
  vat_rate: number;
  line_subtotal: number;
  line_discount: number;
  line_tax: number;
  line_total: number;
  global_discount_share: number;
  net_line_total: number;
  tooth_number: number | null;
  surfaces: string[] | null;
  treatment_id: string | null;
  invoiced_quantity: number;
  display_order: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  catalog_item: CatalogItemBriefDto | null;
  vat_type: VatTypeBriefDto | null;
}

export interface SignatureDto {
  id: string;
  budget_id: string;
  signature_type: string;
  signed_items: string[] | null;
  signed_by_name: string;
  signed_by_email: string | null;
  relationship_to_patient: string;
  signature_method: string;
  signature_data: Record<string, unknown> | null;
  ip_address: string | null;
  signed_at: string;
  external_signature_id: string | null;
  external_provider: string | null;
  document_hash: string | null;
  created_at: string;
}

export interface SignatureMetaDto {
  id: string;
  budget_id: string;
  signature_type: string;
  signed_by_name: string;
  signed_by_email: string | null;
  relationship_to_patient: string;
  signature_method: string;
  ip_address: string | null;
  signed_at: string;
  document_hash: string | null;
  created_at: string;
}

export interface TreatmentPlanBriefDto {
  id: string;
  plan_number: string;
  title: string | null;
  status: string;
}

export interface BudgetDto {
  id: string;
  clinic_id: string;
  patient_id: string;
  budget_number: string;
  version: number;
  parent_budget_id: string | null;
  status: string;
  valid_from: string;
  valid_until: string | null;
  created_by: string;
  assigned_professional_id: string | null;
  global_discount_type: string | null;
  global_discount_value: number | null;
  subtotal: number;
  total_discount: number;
  total_tax: number;
  total: number;
  internal_notes: string | null;
  patient_notes: string | null;
  insurance_estimate: number | null;
  public_token: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  patient: PatientBriefDto | null;
  creator: UserBriefDto | null;
  assigned_professional: UserBriefDto | null;
}

export interface BudgetDetailDto extends BudgetDto {
  items: BudgetItemDto[];
  signatures: SignatureDto[];
  treatment_plan: TreatmentPlanBriefDto | null;
}

export interface BudgetListDto {
  id: string;
  budget_number: string;
  version: number;
  status: string;
  valid_from: string;
  valid_until: string | null;
  total: number;
  created_at: string;
  plan_number_snapshot: string | null;
  patient: PatientBriefDto | null;
  creator: UserBriefDto | null;
}

export interface BudgetVersionDto {
  id: string;
  version: number;
  status: string;
  total: number;
  created_at: string;
  is_current: boolean;
}

export interface BudgetVersionListDto {
  budget_number: string;
  versions: BudgetVersionDto[];
  current_version: number;
}

export interface BudgetHistoryDto {
  id: string;
  budget_id: string;
  action: string;
  changed_by: string;
  changed_at: string;
  previous_state: Record<string, unknown> | null;
  new_state: Record<string, unknown> | null;
  notes: string | null;
  user: UserBriefDto | null;
}

function toPatientBrief(row: { id: string; first_name: string; last_name: string; email: string | null; phone: string | null } | null): PatientBriefDto | null {
  if (!row) return null;
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    phone: row.phone,
  };
}

function toUserBrief(
  row: { id: string; first_name: string; last_name: string } | null,
): UserBriefDto | null {
  return row ? { id: row.id, first_name: row.first_name, last_name: row.last_name } : null;
}

/** Ligne Prisma → `PriceLine` (pricing). */
export function priceLineOf(item: {
  line_subtotal: Prisma.Decimal;
  line_discount: Prisma.Decimal;
  line_total: Prisma.Decimal;
  vat_rate: number;
}): PriceLine {
  return {
    lineSubtotalCents: toCents(item.line_subtotal),
    lineDiscountCents: toCents(item.line_discount),
    lineTotalCents: toCents(item.line_total),
    vatRate: item.vat_rate,
  };
}

export function toItemDto(row: BudgetItemRow, shareCents = 0, netTotalCents = 0): BudgetItemDto {
  const catalog = row.treatment_catalog_items;
  return {
    id: row.id,
    budget_id: row.budget_id,
    catalog_item_id: row.catalog_item_id,
    unit_price: toCents(row.unit_price),
    quantity: row.quantity,
    discount_type: row.discount_type,
    discount_value: row.discount_value === null ? null : toCents(row.discount_value),
    vat_type_id: row.vat_type_id,
    vat_rate: row.vat_rate,
    line_subtotal: toCents(row.line_subtotal),
    line_discount: toCents(row.line_discount),
    line_tax: toCents(row.line_tax),
    line_total: toCents(row.line_total),
    global_discount_share: shareCents,
    net_line_total: netTotalCents,
    tooth_number: row.tooth_number,
    surfaces: asStringArray(row.surfaces),
    treatment_id: row.treatment_id,
    invoiced_quantity: row.invoiced_quantity,
    display_order: row.display_order,
    notes: row.notes,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    catalog_item: catalog
      ? {
          id: catalog.id,
          internal_code: catalog.internal_code,
          names: asRecord(catalog.names),
          default_price: catalog.default_price === null ? null : toCents(catalog.default_price),
        }
      : null,
    vat_type: row.vat_types
      ? { id: row.vat_types.id, names: asRecord(row.vat_types.names), rate: row.vat_types.rate }
      : null,
  };
}

export function toSignatureDto(row: SignatureRow): SignatureDto {
  const data = row.signature_data;
  return {
    id: row.id,
    budget_id: row.budget_id,
    signature_type: row.signature_type,
    signed_items: asStringArray(row.signed_items),
    signed_by_name: row.signed_by_name,
    signed_by_email: row.signed_by_email,
    relationship_to_patient: row.relationship_to_patient,
    signature_method: row.signature_method,
    signature_data:
      data !== null && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null,
    ip_address: row.ip_address,
    signed_at: row.signed_at.toISOString(),
    external_signature_id: row.external_signature_id,
    external_provider: row.external_provider,
    document_hash: row.document_hash,
    created_at: row.created_at.toISOString(),
  };
}

export function toSignatureMetaDto(row: SignatureRow): SignatureMetaDto {
  return {
    id: row.id,
    budget_id: row.budget_id,
    signature_type: row.signature_type,
    signed_by_name: row.signed_by_name,
    signed_by_email: row.signed_by_email,
    relationship_to_patient: row.relationship_to_patient,
    signature_method: row.signature_method,
    ip_address: row.ip_address,
    signed_at: row.signed_at.toISOString(),
    document_hash: row.document_hash,
    created_at: row.created_at.toISOString(),
  };
}

export function toBudgetDto(row: BudgetRow): BudgetDto {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    patient_id: row.patient_id,
    budget_number: row.budget_number,
    version: row.version,
    parent_budget_id: row.parent_budget_id,
    status: row.status,
    valid_from: dateColumnToString(row.valid_from),
    valid_until: row.valid_until === null ? null : dateColumnToString(row.valid_until),
    created_by: row.created_by,
    assigned_professional_id: row.assigned_professional_id,
    global_discount_type: row.global_discount_type,
    global_discount_value:
      row.global_discount_value === null ? null : toCents(row.global_discount_value),
    subtotal: toCents(row.subtotal),
    total_discount: toCents(row.total_discount),
    total_tax: toCents(row.total_tax),
    total: toCents(row.total),
    internal_notes: row.internal_notes,
    patient_notes: row.patient_notes,
    insurance_estimate: row.insurance_estimate === null ? null : toCents(row.insurance_estimate),
    public_token: row.public_token,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    deleted_at: row.deleted_at === null ? null : row.deleted_at.toISOString(),
    patient: toPatientBrief(row.patients),
    creator: toUserBrief(row.users_budgets_created_byTousers),
    assigned_professional: toUserBrief(row.users_budgets_assigned_professional_idTousers),
  };
}

/**
 * Détail : les lignes reçoivent la part de remise globale et le TTC net
 * (`BudgetDetailResponse._fill_global_discount_shares`).
 */
export function toBudgetDetailDto(
  row: BudgetDetailRow,
  treatmentPlan: TreatmentPlanBriefDto | null = null,
): BudgetDetailDto {
  const lines = row.budget_items.map(priceLineOf);
  const shares = allocateGlobalDiscount(
    row.global_discount_type,
    row.global_discount_value === null ? null : toCents(row.global_discount_value),
    lines,
  );
  const items = row.budget_items.map((item, index) => {
    const line = lines[index]!;
    const share = shares[index] ?? 0;
    const net = Math.round((line.lineSubtotalCents - line.lineDiscountCents - share) * (1 + line.vatRate / 100));
    return toItemDto(item, share, quantize(net));
  });
  return {
    ...toBudgetDto(row),
    items,
    signatures: row.budget_signatures.map(toSignatureDto),
    treatment_plan: treatmentPlan,
  };
}

/** Arrondi au centime (positif uniquement). */
function quantize(value: number): number {
  return Math.round(value);
}

export function toListDto(row: BudgetRow): BudgetListDto {
  return {
    id: row.id,
    budget_number: row.budget_number,
    version: row.version,
    status: row.status,
    valid_from: dateColumnToString(row.valid_from),
    valid_until: row.valid_until === null ? null : dateColumnToString(row.valid_until),
    total: toCents(row.total),
    created_at: row.created_at.toISOString(),
    plan_number_snapshot: row.plan_number_snapshot,
    patient: toPatientBrief(row.patients),
    creator: toUserBrief(row.users_budgets_created_byTousers),
  };
}

export function toVersionDto(row: BudgetBasicRow, currentId: string): BudgetVersionDto {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    total: toCents(row.total),
    created_at: row.created_at.toISOString(),
    is_current: row.id === currentId,
  };
}

// ---------------------------------------------------------------------------
// Contexte DB (prisma ou client de transaction)
// ---------------------------------------------------------------------------

export type Db = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Plan lié
// ---------------------------------------------------------------------------

/**
 * Plan qui référence ce budget (lecture SQL brute, sans remonter la chaîne
 * `parent_budget_id` : une ancienne version ne doit résoudre aucun plan).
 */
export async function lookupLinkedPlan(
  db: Db,
  clinicId: string,
  budgetId: string,
): Promise<TreatmentPlanBriefDto | null> {
  const rows = await db.$queryRaw<
    Array<{ id: string; plan_number: string; title: string | null; status: string }>
  >`SELECT id, plan_number, title, status FROM treatment_plans
    WHERE budget_id = ${budgetId}::uuid AND clinic_id = ${clinicId}::uuid AND deleted_at IS NULL
    LIMIT 1`;
  const row = rows[0];
  return row
    ? { id: row.id, plan_number: row.plan_number, title: row.title, status: row.status }
    : null;
}

async function lookupPlanId(db: Db, clinicId: string, budgetId: string): Promise<string | null> {
  const plan = await lookupLinkedPlan(db, clinicId, budgetId);
  return plan ? plan.id : null;
}

// ---------------------------------------------------------------------------
// Effets croisés connus (bus Python → effets transactionnels)
// ---------------------------------------------------------------------------

/** `budget.cancelled` / `budget.renegotiated` → plan `pending` repasse `draft`. */
export async function reopenLinkedPlanFromBudget(
  db: Db,
  clinicId: string,
  planId: string,
): Promise<void> {
  await db.treatment_plans.updateMany({
    where: { id: planId, clinic_id: clinicId, deleted_at: null, status: 'pending' },
    data: { status: 'draft', confirmed_at: null, updated_at: new Date() },
  });
}

/** `budget.rejected` → plan `pending` fermé avec `rejected_by_patient`. */
export async function rejectLinkedPlanFromBudget(
  db: Db,
  clinicId: string,
  planId: string,
  note: string | null,
): Promise<void> {
  await db.treatment_plans.updateMany({
    where: { id: planId, clinic_id: clinicId, deleted_at: null, status: 'pending' },
    data: {
      status: 'closed',
      closure_reason: 'rejected_by_patient',
      closure_note: note,
      closed_at: new Date(),
      updated_at: new Date(),
    },
  });
}

interface PlanSessionRow {
  id: string;
  sequence: number;
  amountCents: number;
  status: string;
}

interface PlanLineRow {
  treatmentId: string;
  sessions: PlanSessionRow[];
}

async function loadPlanLines(db: Db, planId: string): Promise<PlanLineRow[]> {
  const items = await db.planned_treatment_items.findMany({
    where: { treatment_plan_id: planId },
    select: {
      treatment_id: true,
      planned_treatment_item_sessions: {
        select: { id: true, sequence: true, amount: true, status: true },
        orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
      },
    },
  });
  return items.map((item) => ({
    treatmentId: item.treatment_id,
    sessions: item.planned_treatment_item_sessions.map((session) => ({
      id: session.id,
      sequence: session.sequence,
      amountCents: toCents(session.amount),
      status: session.status,
    })),
  }));
}

/**
 * `budget.accepted` → plan `pending` (ou `closed` / `rejected_by_patient`)
 * devient `active` et ses séances en attente sont re-prixées (port de
 * `TreatmentPlanService.accept_from_budget` + `_reprice_sessions`).
 */
export async function activateLinkedPlanFromBudget(
  db: Db,
  clinicId: string,
  planId: string,
  lineAmounts: Map<string, number>,
): Promise<void> {
  const plan = await db.treatment_plans.findFirst({
    where: { id: planId, clinic_id: clinicId, deleted_at: null },
    select: { id: true, status: true, closure_reason: true },
  });
  if (!plan) return;
  if (plan.status === 'active') return;

  const revive = plan.status === 'closed' && plan.closure_reason === 'rejected_by_patient';
  if (!revive && plan.status !== 'pending') return;

  const lines = await loadPlanLines(db, planId);

  await db.treatment_plans.update({
    where: { id: planId },
    data: revive
      ? {
          status: 'active',
          closure_reason: null,
          closure_note: null,
          closed_at: null,
          updated_at: new Date(),
        }
      : { status: 'active', updated_at: new Date() },
  });

  for (const line of lines) {
    const target = lineAmounts.get(line.treatmentId);
    if (target === undefined) continue;
    const repriced = repricePendingSessions(line.sessions, target);
    for (const row of repriced) {
      const session = line.sessions.find((s) => s.sequence === row.sequence);
      if (!session) continue;
      await db.planned_treatment_item_sessions.update({
        where: { id: session.id },
        data: { amount: cents(row.amountCents), updated_at: new Date() },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Numérotation (`PRES-YYYY-NNNN`)
// ---------------------------------------------------------------------------

async function resolveClinicTimezone(db: Db, clinicId: string): Promise<string | null> {
  const clinic = await db.clinics.findUnique({
    where: { id: clinicId },
    select: { timezone: true },
  });
  return clinic?.timezone ?? null;
}

/** Jour courant de la clinique (`clinic_today_for`). */
export async function clinicToday(db: Db, clinicId: string): Promise<string> {
  return clinicTodayDateString(await resolveClinicTimezone(db, clinicId));
}

export const BudgetNumberService = {
  /**
   * Prochain numéro de la clinique. Le verrou consultatif
   * `pg_advisory_xact_lock` sérialise l'allocation dans la transaction
   * courante (#770) : deux créations concurrentes ne lisent pas le même
   * maximum.
   */
  async generateNumber(db: Db, clinicId: string, prefix = 'PRES'): Promise<string> {
    const year = (await clinicToday(db, clinicId)).slice(0, 4);
    const yearPrefix = `${prefix}-${year}-`;

    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`budget_number:${clinicId}`}, 0))`;

    const rows = await db.$queryRaw<Array<{ max: string | null }>>`
      SELECT MAX(budget_number) AS max FROM budgets
      WHERE clinic_id = ${clinicId}::uuid AND budget_number LIKE ${`${yearPrefix}%`}`;
    return nextBudgetNumberSequence(yearPrefix, rows[0]?.max ?? null);
  },
};

// ---------------------------------------------------------------------------
// Lignes (`BudgetItemService`)
// ---------------------------------------------------------------------------

/** Données d'une ligne à créer (prix en centimes, catalogue re-snapshoté). */
export interface ItemCreateData {
  catalog_item_id: string;
  quantity?: number;
  unit_price?: number | null;
  discount_type?: string | null;
  discount_value?: number | null;
  tooth_number?: number | null;
  surfaces?: string[] | null;
  treatment_id?: string | null;
  display_order?: number;
  notes?: string | null;
}

export const BudgetItemService = {
  /** Crée une ligne avec snapshot du prix et de la TVA du catalogue. */
  async createItem(
    db: Db,
    clinicId: string,
    budgetId: string,
    data: ItemCreateData,
  ): Promise<BudgetItemRow> {
    const catalog = await db.treatment_catalog_items.findUnique({
      where: { id: data.catalog_item_id },
      select: {
        clinic_id: true,
        default_price: true,
        vat_type_id: true,
        vat_types: { select: { id: true, rate: true } },
      },
    });
    if (!catalog || catalog.clinic_id !== clinicId) {
      throw new BudgetValidationError('Invalid catalog item');
    }

    const unitPriceCents =
      data.unit_price === null || data.unit_price === undefined
        ? toCents(catalog.default_price)
        : data.unit_price;

    let vatTypeId: string | null = null;
    let vatRate = 0;
    if (catalog.vat_type_id && catalog.vat_types) {
      vatTypeId = catalog.vat_types.id;
      vatRate = catalog.vat_types.rate;
    }

    const quantity = data.quantity ?? 1;
    const totals = computeLineTotals({
      unitPriceCents,
      quantity,
      discountType: data.discount_type ?? null,
      discountValueCents: data.discount_value ?? null,
      vatRate,
    });

    const now = new Date();
    const id = crypto.randomUUID();
    await db.budget_items.create({
      data: {
        id,
        clinic_id: clinicId,
        budget_id: budgetId,
        catalog_item_id: data.catalog_item_id,
        unit_price: cents(unitPriceCents),
        quantity,
        discount_type: data.discount_type ?? null,
        discount_value: centsOrNull(data.discount_value ?? null),
        vat_type_id: vatTypeId,
        vat_rate: vatRate,
        line_subtotal: cents(totals.lineSubtotalCents),
        line_discount: cents(totals.lineDiscountCents),
        line_tax: cents(totals.lineTaxCents),
        line_total: cents(totals.lineTotalCents),
        tooth_number: data.tooth_number ?? null,
        surfaces: data.surfaces === null || data.surfaces === undefined
          ? jsonNull()
          : (data.surfaces as Prisma.InputJsonValue),
        treatment_id: data.treatment_id ?? null,
        invoiced_quantity: 0,
        display_order: data.display_order ?? 0,
        notes: data.notes ?? null,
        created_at: now,
        updated_at: now,
      },
    });
    const created = await db.budget_items.findUnique({ where: { id }, include: budgetItemInclude });
    if (!created) throw new BudgetValidationError('Budget item not found');
    return created;
  },

  /**
   * `null` explicite = effacement, honoré seulement sur les colonnes
   * nullement-ables ; `null` sur `quantity`/`unit_price`/`display_order` est
   * ignoré (comme Python) au lieu de casser la contrainte NOT NULL.
   */
  async updateItem(
    db: Db,
    item: BudgetItemRow,
    data: BudgetItemUpdateInput,
  ): Promise<BudgetItemRow> {
    const patch: Prisma.budget_itemsUncheckedUpdateInput = { updated_at: new Date() };

    let quantity = item.quantity;
    let unitPriceCents = toCents(item.unit_price);
    let discountType = item.discount_type;
    let discountValueCents = item.discount_value === null ? null : toCents(item.discount_value);

    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (value === null && !CLEARABLE_ITEM_FIELDS.has(key)) continue;
      switch (key) {
        case 'quantity':
          quantity = value as number;
          patch.quantity = quantity;
          break;
        case 'unit_price':
          unitPriceCents = value as number;
          patch.unit_price = cents(unitPriceCents);
          break;
        case 'discount_type':
          discountType = value as string | null;
          patch.discount_type = discountType;
          break;
        case 'discount_value':
          discountValueCents = value as number | null;
          patch.discount_value = centsOrNull(discountValueCents);
          break;
        case 'tooth_number':
          patch.tooth_number = value as number | null;
          break;
        case 'surfaces': {
          const surfaces = value as string[] | null;
          patch.surfaces =
            surfaces === null ? jsonNull() : (surfaces as Prisma.InputJsonValue);
          break;
        }
        case 'display_order':
          patch.display_order = value as number;
          break;
        case 'notes':
          patch.notes = value as string | null;
          break;
        default:
          break;
      }
    }

    const totals = computeLineTotals({
      unitPriceCents,
      quantity,
      discountType,
      discountValueCents,
      vatRate: item.vat_rate,
    });
    patch.line_subtotal = cents(totals.lineSubtotalCents);
    patch.line_discount = cents(totals.lineDiscountCents);
    patch.line_tax = cents(totals.lineTaxCents);
    patch.line_total = cents(totals.lineTotalCents);

    await db.budget_items.update({ where: { id: item.id }, data: patch });
    const updated = await db.budget_items.findUnique({ where: { id: item.id }, include: budgetItemInclude });
    if (!updated) throw new BudgetValidationError('Budget item not found');
    return updated;
  },

  async deleteItem(db: Db, item: { id: string }): Promise<void> {
    await db.budget_items.delete({ where: { id: item.id } });
  },
};

// ---------------------------------------------------------------------------
// Historique (`BudgetHistoryService`)
// ---------------------------------------------------------------------------

export const BudgetHistoryService = {
  async addEntry(
    db: Db,
    params: {
      clinicId: string;
      budgetId: string;
      action: string;
      changedBy: string;
      previousState?: Record<string, unknown> | null;
      newState?: Record<string, unknown> | null;
      notes?: string | null;
    },
  ): Promise<void> {
    await db.budget_history.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: params.clinicId,
        budget_id: params.budgetId,
        action: params.action,
        changed_by: params.changedBy,
        changed_at: new Date(),
        previous_state: historyJson(params.previousState),
        new_state: historyJson(params.newState),
        notes: params.notes ?? null,
      },
    });
  },

  async getHistory(db: Db, clinicId: string, budgetId: string): Promise<BudgetHistoryDto[]> {
    const rows = await db.budget_history.findMany({
      where: { clinic_id: clinicId, budget_id: budgetId },
      include: { users: { select: userBriefSelect } },
      orderBy: [{ changed_at: 'desc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      budget_id: row.budget_id,
      action: row.action,
      changed_by: row.changed_by,
      changed_at: row.changed_at.toISOString(),
      previous_state:
        row.previous_state !== null &&
        typeof row.previous_state === 'object' &&
        !Array.isArray(row.previous_state)
          ? (row.previous_state as Record<string, unknown>)
          : null,
      new_state:
        row.new_state !== null && typeof row.new_state === 'object' && !Array.isArray(row.new_state)
          ? (row.new_state as Record<string, unknown>)
          : null,
      notes: row.notes,
      user: toUserBrief(row.users),
    }));
  },
};

// ---------------------------------------------------------------------------
// Vérifications de tenancy
// ---------------------------------------------------------------------------

/**
 * `user_id` doit être un membre professionnel de la clinique — sans quoi un
 * identifiant d'une autre clinique serait stocké puis affiché.
 */
export async function assertProfessionalInClinic(
  db: Db,
  clinicId: string,
  userId: string,
): Promise<void> {
  const membership = await db.clinic_memberships.findFirst({
    where: { clinic_id: clinicId, user_id: userId, is_professional: true },
    select: { id: true },
  });
  if (!membership) throw new BudgetValidationError('Invalid professional for this clinic');
}

// ---------------------------------------------------------------------------
// BudgetService
// ---------------------------------------------------------------------------

export interface ListBudgetsFilters {
  page: number;
  pageSize: number;
  patientId?: string | null;
  statuses?: string[] | null;
  createdBy?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  expired?: boolean | null;
  search?: string | null;
  budgetIds?: string[] | null;
  assignedProfessionalId?: string | null;
  validUntilBefore?: string | null;
  validUntilAfter?: string | null;
  sort?: string | null;
}

export const BudgetService = {
  /** Liste filtrée/paginée (`list_budgets`). */
  async listBudgets(
    db: Db,
    clinicId: string,
    filters: ListBudgetsFilters,
  ): Promise<{ rows: BudgetListDto[]; total: number }> {
    const pageSize = Math.min(Math.max(filters.pageSize, 1), 100);
    const page = Math.max(filters.page, 1);
    const offset = (page - 1) * pageSize;

    // Ensemble d'intersection vide → aucune ligne.
    if (filters.budgetIds !== undefined && filters.budgetIds !== null && filters.budgetIds.length === 0) {
      return { rows: [], total: 0 };
    }

    const conditions: Prisma.Sql[] = [
      Prisma.sql`b.clinic_id = ${clinicId}::uuid`,
      Prisma.sql`b.deleted_at IS NULL`,
    ];
    if (filters.budgetIds && filters.budgetIds.length > 0) {
      conditions.push(
        Prisma.sql`b.id IN (${Prisma.join(filters.budgetIds.map((id) => Prisma.sql`${id}::uuid`))})`,
      );
    }
    if (filters.patientId) conditions.push(Prisma.sql`b.patient_id = ${filters.patientId}::uuid`);
    const statuses = (filters.statuses ?? []).filter(Boolean);
    if (statuses.length > 0) {
      conditions.push(
        Prisma.sql`b.status IN (${Prisma.join(statuses.map((s) => Prisma.sql`${s}`))})`,
      );
    }
    if (filters.createdBy) conditions.push(Prisma.sql`b.created_by = ${filters.createdBy}::uuid`);
    if (filters.assignedProfessionalId) {
      conditions.push(
        Prisma.sql`b.assigned_professional_id = ${filters.assignedProfessionalId}::uuid`,
      );
    }
    if (filters.dateFrom) {
      conditions.push(Prisma.sql`b.created_at >= ${dateColumnToUtc(filters.dateFrom)}`);
    }
    if (filters.dateTo) {
      conditions.push(Prisma.sql`b.created_at <= ${new Date(`${filters.dateTo}T23:59:59.999Z`)}`);
    }
    if (filters.validUntilBefore) {
      conditions.push(Prisma.sql`b.valid_until <= ${dateColumnToUtc(filters.validUntilBefore)}`);
    }
    if (filters.validUntilAfter) {
      conditions.push(Prisma.sql`b.valid_until >= ${dateColumnToUtc(filters.validUntilAfter)}`);
    }
    if (filters.expired !== undefined && filters.expired !== null) {
      const today = dateColumnToUtc(await clinicToday(db, clinicId));
      if (filters.expired) {
        conditions.push(Prisma.sql`b.valid_until IS NOT NULL`);
        conditions.push(Prisma.sql`b.valid_until < ${today}`);
      } else {
        conditions.push(Prisma.sql`(b.valid_until IS NULL OR b.valid_until >= ${today})`);
      }
    }
    if (filters.search) {
      const pattern = `%${filters.search}%`;
      conditions.push(
        Prisma.sql`(b.budget_number ILIKE ${pattern} OR b.patient_id IN (
          SELECT p.id FROM patients p
          WHERE p.first_name ILIKE ${pattern}
             OR p.last_name ILIKE ${pattern}
             OR (p.first_name || ' ' || p.last_name) ILIKE ${pattern}
        ))`,
      );
    }

    const whereSql = Prisma.join(conditions, ' AND ');
    const sort = parseSort(filters.sort);
    const column = {
      created_at: 'b.created_at',
      valid_until: 'b.valid_until',
      total: 'b.total',
      status: 'b.status',
      budget_number: 'b.budget_number',
    }[sort.field];
    const direction = sort.direction.toUpperCase();
    const orderSql = Prisma.raw(`${column} ${direction}, b.id ASC`);

    const [countRows, idRows] = await Promise.all([
      db.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM budgets b WHERE ${whereSql}`,
      db.$queryRaw<Array<{ id: string }>>`
        SELECT b.id FROM budgets b WHERE ${whereSql}
        ORDER BY ${orderSql} OFFSET ${offset} LIMIT ${pageSize}`,
    ]);
    const total = Number(countRows[0]?.count ?? 0);
    if (idRows.length === 0) return { rows: [], total };

    const idList = idRows.map((row) => row.id);
    const rows = await db.budgets.findMany({
      where: { id: { in: idList } },
      include: {
        patients: { select: patientBriefSelect },
        users_budgets_created_byTousers: { select: userBriefSelect },
        users_budgets_assigned_professional_idTousers: { select: userBriefSelect },
        budget_items: { include: budgetItemInclude },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = idList
      .map((id) => byId.get(id))
      .filter((row): row is BudgetRow => row !== undefined)
      .map(toListDto);
    return { rows: ordered, total };
  },

  /** Ligne + relations (items, signatures, patient, créateur, professionnel). */
  async getBudgetRow(db: Db, clinicId: string, budgetId: string): Promise<BudgetDetailRow | null> {
    return db.budgets.findFirst({
      where: { id: budgetId, clinic_id: clinicId, deleted_at: null },
      include: budgetDetailInclude,
    });
  },

  /** Budget sans relations (`include_items=False`). */
  async getBudgetBasic(db: Db, clinicId: string, budgetId: string): Promise<BudgetBasicRow | null> {
    return db.budgets.findFirst({
      where: { id: budgetId, clinic_id: clinicId, deleted_at: null },
    });
  },

  /** Détail complet (items + signatures + plan lié). */
  async getBudgetDetail(
    db: Db,
    clinicId: string,
    budgetId: string,
  ): Promise<BudgetDetailDto | null> {
    const row = await BudgetService.getBudgetRow(db, clinicId, budgetId);
    if (!row) return null;
    const plan = await lookupLinkedPlan(db, clinicId, budgetId);
    return toBudgetDetailDto(row, plan);
  },

  /** `get_by_public_token` : le token est le facteur d'accès (ADR 0006). */
  async getByPublicToken(db: Db, token: string): Promise<BudgetBasicRow | null> {
    return db.budgets.findFirst({ where: { public_token: token, deleted_at: null } });
  },

  /**
   * Création : numéro sérialisé par verrou consultatif, professionnel
   * validé, lignes créées, totaux recalculés, historique `created`.
   */
  async createBudget(
    db: Db,
    clinicId: string,
    createdBy: string,
    data: BudgetCreateInput & { budget_number?: string | null },
  ): Promise<string> {
    const { items, ...rest } = data;
    const today = await clinicToday(db, clinicId);
    const budgetNumber =
      data.budget_number || (await BudgetNumberService.generateNumber(db, clinicId));

    if (rest.assigned_professional_id) {
      await assertProfessionalInClinic(db, clinicId, rest.assigned_professional_id);
    }

    const id = crypto.randomUUID();
    const now = new Date();
    // `valid_from` : `date.today()` par défaut — jour de la clinique.
    const validFrom = rest.valid_from ?? today;

    await db.budgets.create({
      data: {
        id,
        clinic_id: clinicId,
        patient_id: rest.patient_id,
        budget_number: budgetNumber,
        version: 1,
        parent_budget_id: null,
        status: 'draft',
        valid_from: dateColumnToUtc(validFrom),
        valid_until: rest.valid_until ? dateColumnToUtc(rest.valid_until) : null,
        created_by: createdBy,
        assigned_professional_id: rest.assigned_professional_id ?? null,
        global_discount_type: rest.global_discount_type ?? null,
        global_discount_value: centsOrNull(rest.global_discount_value ?? null),
        subtotal: new Prisma.Decimal(0),
        total_discount: new Prisma.Decimal(0),
        total_tax: new Prisma.Decimal(0),
        total: new Prisma.Decimal(0),
        internal_notes: rest.internal_notes ?? null,
        patient_notes: rest.patient_notes ?? null,
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
        public_auth_method: await resolvePublicAuthMethod(db, clinicId, rest.patient_id),
        public_auth_secret_hash: null,
        public_locked_at: null,
        plan_number_snapshot: null,
        plan_status_snapshot: null,
      },
    });

    for (const item of items ?? []) {
      await BudgetItemService.createItem(db, clinicId, id, item);
    }

    await BudgetService.recalculateTotals(db, id);

    const totals = await db.budgets.findUnique({ where: { id }, select: { total: true } });
    await BudgetHistoryService.addEntry(db, {
      clinicId,
      budgetId: id,
      action: 'created',
      changedBy: createdBy,
      newState: { status: 'draft', total: totals ? totals.total.toString() : '0.00' },
    });
    return id;
  },

  /**
   * Mise à jour (brouillon uniquement). `null` explicite efface les colonnes
   * nullement-ables ; `undefined` = champ non fourni.
   */
  async updateBudget(
    db: Db,
    budget: BudgetBasicRow,
    data: BudgetUpdateInput,
    updatedBy: string,
  ): Promise<void> {
    if (budget.status !== 'draft') {
      throw new BudgetValidationError('Only draft budgets can be edited');
    }

    const previousState = {
      valid_from: dateColumnToString(budget.valid_from),
      valid_until: budget.valid_until ? dateColumnToString(budget.valid_until) : null,
      global_discount_type: budget.global_discount_type,
      global_discount_value: budget.global_discount_value
        ? budget.global_discount_value.toString()
        : null,
    };

    const newProfessional =
      data.assigned_professional_id !== undefined && data.assigned_professional_id !== null
        ? data.assigned_professional_id
        : null;
    if (newProfessional) {
      await assertProfessionalInClinic(db, budget.clinic_id, newProfessional);
    }

    const patch: Prisma.budgetsUncheckedUpdateInput = { updated_at: new Date() };
    const newState: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (value === null && !CLEARABLE_BUDGET_FIELDS.has(key)) continue;
      switch (key) {
        case 'valid_from':
          // `valid_from` n'est pas effaçable : `null` est ignoré.
          if (value !== null) {
            patch.valid_from = dateColumnToUtc(value as string);
            newState[key] = value;
          }
          break;
        case 'valid_until':
          patch.valid_until = value === null ? null : dateColumnToUtc(value as string);
          newState[key] = value;
          break;
        case 'assigned_professional_id':
          patch.assigned_professional_id = value as string | null;
          newState[key] = value;
          break;
        case 'global_discount_type':
          patch.global_discount_type = value as string | null;
          newState[key] = value;
          break;
        case 'global_discount_value':
          patch.global_discount_value = centsOrNull(value as number | null);
          newState[key] = centsToDecimalString(value as number);
          break;
        case 'internal_notes':
          patch.internal_notes = value as string | null;
          newState[key] = value;
          break;
        case 'patient_notes':
          patch.patient_notes = value as string | null;
          newState[key] = value;
          break;
        default:
          break;
      }
    }

    await db.budgets.update({ where: { id: budget.id }, data: patch });
    await BudgetService.recalculateTotals(db, budget.id);

    await BudgetHistoryService.addEntry(db, {
      clinicId: budget.clinic_id,
      budgetId: budget.id,
      action: 'updated',
      changedBy: updatedBy,
      previousState,
      newState,
    });
  },

  /**
   * Suppression douce d'un brouillon non lié à un plan : un devis sorti du
   * brouillon est un document vu/signé, et un devis lié est celui du plan.
   */
  async deleteBudget(
    db: Db,
    budget: BudgetBasicRow,
    deletedBy: string,
  ): Promise<void> {
    if (budget.status !== 'draft') {
      throw new BudgetNotDeletableError(
        `Only draft budgets can be deleted; this one is '${budget.status}'`,
      );
    }
    const plan = await lookupLinkedPlan(db, budget.clinic_id, budget.id);
    if (plan !== null) {
      throw new BudgetNotDeletableError(
        `This quote belongs to plan ${plan.plan_number}; reopen the plan instead`,
      );
    }
    await db.budgets.update({ where: { id: budget.id }, data: { deleted_at: new Date() } });
    await BudgetHistoryService.addEntry(db, {
      clinicId: budget.clinic_id,
      budgetId: budget.id,
      action: 'deleted',
      changedBy: deletedBy,
    });
  },

  async ensureLinesNotOwnedByPlan(
    db: Db,
    budget: { id: string; clinic_id: string },
  ): Promise<void> {
    const plan = await lookupLinkedPlan(db, budget.clinic_id, budget.id);
    if (plan !== null) {
      throw new PlanOwnsLinesError(
        `Lines of a quote linked to plan ${plan.plan_number} are managed from the plan`,
      );
    }
  },

  async addItem(
    db: Db,
    budget: { id: string; clinic_id: string; status: string },
    itemData: ItemCreateData,
    addedBy: string,
  ): Promise<BudgetItemRow> {
    if (budget.status !== 'draft') {
      throw new BudgetValidationError('Items can only be added to draft budgets');
    }
    await BudgetService.ensureLinesNotOwnedByPlan(db, budget);
    const item = await BudgetItemService.createItem(db, budget.clinic_id, budget.id, itemData);
    await BudgetService.recalculateTotals(db, budget.id);
    await BudgetHistoryService.addEntry(db, {
      clinicId: budget.clinic_id,
      budgetId: budget.id,
      action: 'item_added',
      changedBy: addedBy,
      newState: {
        item_id: item.id,
        catalog_item_id: item.catalog_item_id,
        line_total: item.line_total.toString(),
      },
    });
    return item;
  },

  async removeItem(
    db: Db,
    budget: { id: string; clinic_id: string; status: string },
    item: { id: string },
    removedBy: string,
  ): Promise<void> {
    if (budget.status !== 'draft') {
      throw new BudgetValidationError('Items can only be removed from draft budgets');
    }
    await BudgetService.ensureLinesNotOwnedByPlan(db, budget);
    await BudgetItemService.deleteItem(db, item);
    await BudgetService.recalculateTotals(db, budget.id);
    await BudgetHistoryService.addEntry(db, {
      clinicId: budget.clinic_id,
      budgetId: budget.id,
      action: 'item_removed',
      changedBy: removedBy,
      previousState: { item_id: item.id },
    });
  },

  /** Version suivante = version maximale existante + 1 (jamais + 1 du clone). */
  async nextVersion(db: Db, clinicId: string, budgetNumber: string): Promise<number> {
    const rows = await db.$queryRaw<Array<{ max: number | null }>>`
      SELECT MAX(version) AS max FROM budgets
      WHERE clinic_id = ${clinicId}::uuid AND budget_number = ${budgetNumber}`;
    return (rows[0]?.max ?? 0) + 1;
  },

  /** Nouvelle version brouillon avec copie des lignes et des totaux. */
  async duplicateBudget(
    db: Db,
    source: BudgetDetailRow,
    createdBy: string,
  ): Promise<string> {
    const nextVersion = await BudgetService.nextVersion(db, source.clinic_id, source.budget_number);
    const id = crypto.randomUUID();
    const now = new Date();
    await db.budgets.create({
      data: {
        id,
        clinic_id: source.clinic_id,
        patient_id: source.patient_id,
        budget_number: source.budget_number,
        version: nextVersion,
        parent_budget_id: source.id,
        status: 'draft',
        valid_from: dateColumnToUtc(await clinicToday(db, source.clinic_id)),
        valid_until: source.valid_until,
        created_by: createdBy,
        assigned_professional_id: source.assigned_professional_id,
        global_discount_type: source.global_discount_type,
        global_discount_value: source.global_discount_value,
        // Copiés après l'insertion des lignes, comme Python.
        subtotal: new Prisma.Decimal(0),
        total_discount: new Prisma.Decimal(0),
        total_tax: new Prisma.Decimal(0),
        total: new Prisma.Decimal(0),
        internal_notes: source.internal_notes,
        patient_notes: source.patient_notes,
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
        public_auth_method: await resolvePublicAuthMethod(db, source.clinic_id, source.patient_id),
        public_auth_secret_hash: null,
        public_locked_at: null,
        plan_number_snapshot: null,
        plan_status_snapshot: null,
      },
    });

    for (const item of source.budget_items) {
      await db.budget_items.create({
        data: {
          id: crypto.randomUUID(),
          clinic_id: source.clinic_id,
          budget_id: id,
          catalog_item_id: item.catalog_item_id,
          unit_price: item.unit_price,
          quantity: item.quantity,
          discount_type: item.discount_type,
          discount_value: item.discount_value,
          vat_type_id: item.vat_type_id,
          vat_rate: item.vat_rate,
          line_subtotal: item.line_subtotal,
          line_discount: item.line_discount,
          line_tax: item.line_tax,
          line_total: item.line_total,
          tooth_number: item.tooth_number,
          surfaces: jsonInput(item.surfaces),
          // Ni `treatment_id` ni `invoiced_quantity` ne sont copiés.
          treatment_id: null,
          invoiced_quantity: 0,
          display_order: item.display_order,
          notes: item.notes,
          created_at: now,
          updated_at: now,
        },
      });
    }

    await db.budgets.update({
      where: { id },
      data: {
        subtotal: source.subtotal,
        total_discount: source.total_discount,
        total_tax: source.total_tax,
        total: source.total,
      },
    });

    await BudgetHistoryService.addEntry(db, {
      clinicId: source.clinic_id,
      budgetId: id,
      action: 'duplicated',
      changedBy: createdBy,
      previousState: { source_budget_id: source.id },
      newState: { version: nextVersion },
    });
    return id;
  },

  async getVersions(db: Db, clinicId: string, budgetNumber: string): Promise<BudgetBasicRow[]> {
    return db.budgets.findMany({
      where: { clinic_id: clinicId, budget_number: budgetNumber, deleted_at: null },
      orderBy: [{ version: 'desc' }],
    });
  },

  /**
   * Recalcul des totaux depuis les lignes : remise globale répartie par
   * ligne (formule unique), TVA sur la base remisée, `Σ net_line_total == total`.
   */
  async recalculateTotals(db: Db, budgetId: string): Promise<void> {
    const budget = await db.budgets.findUnique({
      where: { id: budgetId },
      select: { global_discount_type: true, global_discount_value: true },
    });
    if (!budget) return;
    const items = await db.budget_items.findMany({
      where: { budget_id: budgetId },
      select: { line_subtotal: true, line_discount: true, line_total: true, vat_rate: true },
    });
    const totals = computeBudgetTotals(
      budget.global_discount_type,
      budget.global_discount_value === null ? null : toCents(budget.global_discount_value),
      items.map(priceLineOf),
    );
    await db.budgets.update({
      where: { id: budgetId },
      data: {
        subtotal: cents(totals.subtotalCents),
        total_discount: cents(totals.totalDiscountCents),
        total_tax: cents(totals.totalTaxCents),
        total: cents(totals.totalCents),
        updated_at: new Date(),
      },
    });
  },
};

// ---------------------------------------------------------------------------
// Réglages clinique / méthode d'authentification publique
// ---------------------------------------------------------------------------

/** `clinic.settings` JSONB (toggles du lien public). */
export async function resolveClinicSettings(
  db: Db,
  clinicId: string,
): Promise<Record<string, unknown>> {
  const clinic = await db.clinics.findUnique({
    where: { id: clinicId },
    select: { settings: true },
  });
  const settings = clinic?.settings;
  return settings !== null &&
    settings !== undefined &&
    typeof settings === 'object' &&
    !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : {};
}

/**
 * Cascade (ADR 0006) : opt-out clinique → `none` ; téléphone ≥ 4 chiffres →
 * `phone_last4` ; date de naissance → `dob` ; sinon `manual_code`.
 */
export async function resolvePublicAuthMethod(
  db: Db,
  clinicId: string,
  patientId: string,
  clinicSettings?: Record<string, unknown>,
): Promise<string> {
  const settings =
    clinicSettings !== undefined ? clinicSettings : await resolveClinicSettings(db, clinicId);
  if (settings.budget_public_auth_disabled) return 'none';

  const patient = await db.patients.findUnique({
    where: { id: patientId },
    select: { phone: true, date_of_birth: true },
  });
  if (!patient) return 'manual_code';
  if (phoneDigits(patient.phone).length >= 4) return 'phone_last4';
  if (patient.date_of_birth !== null) return 'dob';
  return 'manual_code';
}

// ---------------------------------------------------------------------------
// Lien public : verrouillages / compteurs
// ---------------------------------------------------------------------------

/** Hash SHA-256 de l'IP (confidentialité) ; hash de `""` sans IP. */
export function hashIp(rawIp: string | null | undefined): string {
  return crypto.createHash('sha256').update(rawIp ?? '', 'utf8').digest('hex');
}

function hashPassword(plaintext: string): string {
  return bcrypt.hashSync(plaintext, bcrypt.genSaltSync(10));
}

function verifyPassword(plaintext: string, hashed: string): boolean {
  if (!hashed) return false;
  try {
    return bcrypt.compareSync(plaintext, hashed);
  } catch {
    return false;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/** Budget tel que manipulé par le workflow (`Budget` Python + items). */
export interface WorkflowBudget {
  id: string;
  clinic_id: string;
  patient_id: string;
  budget_number: string;
  version: number;
  status: string;
  created_by: string;
  total: Prisma.Decimal;
  valid_until: Date | null;
  global_discount_type: string | null;
  global_discount_value: Prisma.Decimal | null;
  public_token: string;
  public_auth_method: string;
  public_auth_secret_hash: string | null;
  public_locked_at: Date | null;
  viewed_at: Date | null;
  plan_number_snapshot: string | null;
  plan_status_snapshot: string | null;
  items: BudgetItemRow[];
}

/** Charge un budget (avec ses lignes) pour le workflow. */
export async function loadWorkflowBudget(
  db: Db,
  clinicId: string,
  budgetId: string,
): Promise<WorkflowBudget | null> {
  const row = await db.budgets.findFirst({
    where: { id: budgetId, clinic_id: clinicId, deleted_at: null },
    include: budgetDetailInclude,
  });
  if (!row) return null;
  return toWorkflowBudget(row);
}

export async function loadWorkflowBudgetByToken(
  db: Db,
  token: string,
): Promise<WorkflowBudget | null> {
  const found = await db.budgets.findFirst({
    where: { public_token: token, deleted_at: null },
    select: { id: true, clinic_id: true },
  });
  if (!found) return null;
  return loadWorkflowBudget(db, found.clinic_id, found.id);
}

function toWorkflowBudget(row: BudgetDetailRow): WorkflowBudget {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    patient_id: row.patient_id,
    budget_number: row.budget_number,
    version: row.version,
    status: row.status,
    created_by: row.created_by,
    total: row.total,
    valid_until: row.valid_until,
    global_discount_type: row.global_discount_type,
    global_discount_value: row.global_discount_value,
    public_token: row.public_token,
    public_auth_method: row.public_auth_method,
    public_auth_secret_hash: row.public_auth_secret_hash,
    public_locked_at: row.public_locked_at,
    viewed_at: row.viewed_at,
    plan_number_snapshot: row.plan_number_snapshot,
    plan_status_snapshot: row.plan_status_snapshot,
    items: row.budget_items,
  };
}

/**
 * Verrouille la ligne et relit son statut avant transition : deux clics
 * simultanés ne peuvent pas accepter deux fois (`_lock_status`).
 */
async function lockStatus(db: Db, budgetId: string): Promise<string | null> {
  const rows = await db.$queryRaw<Array<{ status: string }>>`
    SELECT status FROM budgets WHERE id = ${budgetId}::uuid FOR UPDATE`;
  return rows[0]?.status ?? null;
}

/** Signature acceptée (ou rejetée) en base. */
async function createSignature(
  db: Db,
  budget: WorkflowBudget,
  params: {
    signatureType: string;
    signedItems: string[] | null;
    data: SignatureCreateInput;
    ipAddress: string | null;
    userAgent: string | null;
    signedAt: Date;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.budget_signatures.create({
    data: {
      id,
      clinic_id: budget.clinic_id,
      budget_id: budget.id,
      signature_type: params.signatureType,
      signed_items:
        params.signedItems === null ? jsonNull() : (params.signedItems as Prisma.InputJsonValue),
      signed_by_name: params.data.signed_by_name,
      signed_by_email: params.data.signed_by_email ?? null,
      relationship_to_patient: params.data.relationship_to_patient ?? 'patient',
      signature_method:
        (params.data as { signature_method?: string }).signature_method ?? 'click_accept',
      signature_data:
        params.data.signature_data === null || params.data.signature_data === undefined
          ? jsonNull()
          : (params.data.signature_data as Prisma.InputJsonValue),
      ip_address: params.ipAddress,
      user_agent: params.userAgent,
      signed_at: params.signedAt,
      external_signature_id: null,
      external_provider: null,
      // Le PDF signé n'existe pas sur Express (501) : pas de hash, comme le
      // repli Python quand WeasyPrint échoue.
      document_hash: null,
      created_at: params.signedAt,
    },
  });
  return id;
}

export const BudgetWorkflowService = {
  canTransition,

  /** `budget.sent` : brouillon/en cours → `sent`, historique + `sent`. */
  async sendBudget(
    db: Db,
    budget: WorkflowBudget,
    sentBy: string,
    options: { sendMethod?: string; recipientEmail?: string | null } = {},
  ): Promise<void> {
    const sendMethod = options.sendMethod ?? 'manual';
    if (!['manual', 'email', 'whatsapp'].includes(sendMethod)) {
      throw new BudgetWorkflowError(`Invalid send_method '${sendMethod}'`);
    }
    const status = await lockStatus(db, budget.id);
    if (status === null) throw new BudgetWorkflowError('Budget not found');
    if (!canTransition(status, 'sent')) {
      throw new BudgetWorkflowError(`Cannot send budget from status '${status}'`);
    }
    if (budget.items.length === 0) {
      throw new BudgetWorkflowError('Cannot send empty budget');
    }

    await db.budgets.update({
      where: { id: budget.id },
      data: { status: 'sent', updated_at: new Date() },
    });
    await BudgetHistoryService.addEntry(db, {
      clinicId: budget.clinic_id,
      budgetId: budget.id,
      action: 'status_changed',
      changedBy: sentBy,
      previousState: { status },
      newState: { status: 'sent' },
    });
    await BudgetHistoryService.addEntry(db, {
      clinicId: budget.clinic_id,
      budgetId: budget.id,
      action: 'sent',
      changedBy: sentBy,
      newState: {
        sent_at: new Date().toISOString(),
        send_method: sendMethod,
        recipient_email: options.recipientEmail ?? null,
      },
    });

    // `budget.sent` (notifications) n'a pas de consommateur Express : rien à
    // appliquer en base.
  },

  /**
   * `budget.accepted` : statut, signature `full_acceptance`, historique,
   * puis activation du plan lié et re-prix de ses séances.
   */
  async acceptBudget(
    db: Db,
    budget: WorkflowBudget,
    signatureData: SignatureCreateInput,
    acceptedBy: string,
    options: {
      ipAddress?: string | null;
      userAgent?: string | null;
      acceptedVia?: string;
    } = {},
  ): Promise<void> {
    const acceptedVia = options.acceptedVia ?? 'manual';
    const status = await lockStatus(db, budget.id);
    if (status === null) throw new BudgetWorkflowError('Budget not found');
    if (!canTransition(status, 'accepted')) {
      throw new BudgetWorkflowError(`Cannot accept budget from status '${status}'`);
    }
    if (budget.items.length === 0) {
      throw new BudgetWorkflowError('Cannot accept empty budget');
    }

    const now = new Date();
    await db.budgets.update({
      where: { id: budget.id },
      data: { status: 'accepted', accepted_via: acceptedVia, updated_at: now },
    });

    await createSignature(db, budget, {
      signatureType: 'full_acceptance',
      signedItems: budget.items.map((item) => item.id),
      data: signatureData,
      ipAddress: options.ipAddress ?? null,
      userAgent: options.userAgent ?? null,
      signedAt: now,
    });

    await BudgetHistoryService.addEntry(db, {
      clinicId: budget.clinic_id,
      budgetId: budget.id,
      action: 'status_changed',
      changedBy: acceptedBy,
      previousState: { status },
      newState: { status: 'accepted' },
    });
    await BudgetHistoryService.addEntry(db, {
      clinicId: budget.clinic_id,
      budgetId: budget.id,
      action: 'signed',
      changedBy: acceptedBy,
      newState: {
        signature_type: 'full_acceptance',
        signed_by: signatureData.signed_by_name,
      },
    });

    const planId = await lookupPlanId(db, budget.clinic_id, budget.id);
    if (planId) {
      const lines = budget.items.map(priceLineOf);
      const shares = allocateGlobalDiscount(
        budget.global_discount_type,
        budget.global_discount_value === null ? null : toCents(budget.global_discount_value),
        lines,
      );
      const lineAmounts = new Map<string, number>();
      budget.items.forEach((item, index) => {
        if (!item.treatment_id) return;
        lineAmounts.set(item.treatment_id, netLineAmount(lines[index]!, shares[index] ?? 0));
      });
      await activateLinkedPlanFromBudget(db, budget.clinic_id, planId, lineAmounts);
    }
  },

  /** `budget.rejected` : motif/note persistés, signature optionnelle, plan fermé. */
  async rejectBudget(
    db: Db,
    budget: WorkflowBudget,
    rejectedBy: string | null,
    reason: string | null,
    options: {
      note?: string | null;
      signatureData?: SignatureCreateInput | null;
      ipAddress?: string | null;
      userAgent?: string | null;
    } = {},
  ): Promise<void> {
    const status = await lockStatus(db, budget.id);
    if (status === null) throw new BudgetWorkflowError('Budget not found');
    if (!canTransition(status, 'rejected')) {
      throw new BudgetWorkflowError(`Cannot reject budget from status '${status}'`);
    }

    const now = new Date();
    await db.budgets.update({
      where: { id: budget.id },
      data: {
        status: 'rejected',
        ...(reason !== null ? { rejection_reason: reason } : {}),
        ...(options.note !== null && options.note !== undefined
          ? { rejection_note: options.note }
          : {}),
        updated_at: now,
      },
    });

    if (options.signatureData) {
      await createSignature(db, budget, {
        signatureType: 'rejection',
        signedItems: null,
        data: options.signatureData,
        ipAddress: options.ipAddress ?? null,
        userAgent: options.userAgent ?? null,
        signedAt: now,
      });
    }

    await BudgetHistoryService.addEntry(db, {
      clinicId: budget.clinic_id,
      budgetId: budget.id,
      action: 'status_changed',
      changedBy: rejectedBy || budget.created_by,
      previousState: { status },
      newState: { status: 'rejected', reason, note: options.note ?? null },
    });

    const planId = await lookupPlanId(db, budget.clinic_id, budget.id);
    if (planId) {
      await rejectLinkedPlanFromBudget(db, budget.clinic_id, planId, options.note ?? null);
    }
  },

  /**
   * `budget.cancelled` : statut `cancelled` et réouverture du plan lié.
   * `publish_event=false` est réservé aux appelants qui pilotent déjà le plan.
   */
  async cancelBudget(
    db: Db,
    budget: WorkflowBudget,
    cancelledBy: string,
    reason: string | null,
    options: { publishEvent?: boolean } = {},
  ): Promise<void> {
    const status = await lockStatus(db, budget.id);
    if (status === null) throw new BudgetWorkflowError('Budget not found');
    if (!canTransition(status, 'cancelled')) {
      throw new BudgetWorkflowError(`Cannot cancel budget from status '${status}'`);
    }
    await db.budgets.update({
      where: { id: budget.id },
      data: { status: 'cancelled', updated_at: new Date() },
    });
    await BudgetHistoryService.addEntry(db, {
      clinicId: budget.clinic_id,
      budgetId: budget.id,
      action: 'status_changed',
      changedBy: cancelledBy,
      previousState: { status },
      newState: { status: 'cancelled', reason },
    });
    if (options.publishEvent !== false) {
      const planId = await lookupPlanId(db, budget.clinic_id, budget.id);
      if (planId) await reopenLinkedPlanFromBudget(db, budget.clinic_id, planId);
    }
  },

  /** `budget.renegotiated` : annule et rouvre le plan lié en brouillon. */
  async cancelForRenegotiation(
    db: Db,
    budget: WorkflowBudget,
    cancelledBy: string,
  ): Promise<void> {
    const status = await lockStatus(db, budget.id);
    if (status === null) throw new BudgetWorkflowError('Budget not found');
    if (!canTransition(status, 'cancelled')) {
      throw new BudgetWorkflowError(`Cannot renegotiate budget in status '${status}'`);
    }
    await db.budgets.update({
      where: { id: budget.id },
      data: { status: 'cancelled', updated_at: new Date() },
    });
    await BudgetHistoryService.addEntry(db, {
      clinicId: budget.clinic_id,
      budgetId: budget.id,
      action: 'status_changed',
      changedBy: cancelledBy,
      previousState: { status },
      newState: { status: 'cancelled', reason: 'renegotiation' },
    });
    const planId = await lookupPlanId(db, budget.clinic_id, budget.id);
    if (planId) await reopenLinkedPlanFromBudget(db, budget.clinic_id, planId);
  },

  /** Première ouverture du lien public (idempotent). */
  async markViewed(db: Db, budget: WorkflowBudget): Promise<void> {
    if (budget.viewed_at !== null) return;
    await db.budgets.update({ where: { id: budget.id }, data: { viewed_at: new Date() } });
  },

  /** Horodate un rappel manuel (`last_reminder_sent_at`). */
  async sendReminder(db: Db, budget: WorkflowBudget): Promise<void> {
    await db.budgets.update({
      where: { id: budget.id },
      data: { last_reminder_sent_at: new Date(), updated_at: new Date() },
    });
  },

  /** Code manuel haché (bcrypt) — le clair ne vit jamais au repos. */
  async setPublicCode(db: Db, budget: WorkflowBudget, code: string): Promise<void> {
    if (code.length < 4 || code.length > 6 || !/^[0-9]+$/.test(code)) {
      throw new BudgetWorkflowError('Manual code must be 4-6 numeric digits');
    }
    await db.budgets.update({
      where: { id: budget.id },
      data: {
        public_auth_method: 'manual_code',
        public_auth_secret_hash: hashPassword(code),
        updated_at: new Date(),
      },
    });
  },

  /**
   * Supprime le verrou et les tentatives échouées : sans cela le premier
   * mauvais code re-verrouillerait immédiatement.
   */
  async unlockPublic(db: Db, budget: WorkflowBudget): Promise<void> {
    await db.budgets.update({
      where: { id: budget.id },
      data: { public_locked_at: null, updated_at: new Date() },
    });
    await db.budget_access_logs.deleteMany({
      where: { budget_id: budget.id, success: false },
    });
  },

  /**
   * Valide une tentative de vérification publique.
   * Erreurs : `locked` | `expired` | `rate_limited` | `method_mismatch` |
   * `invalid`.
   */
  async verifyPublicAccess(
    db: Db,
    budget: WorkflowBudget,
    method: string,
    value: string,
    ipHash: string,
  ): Promise<{ ok: boolean; error: string | null }> {
    if (budget.public_locked_at !== null) return { ok: false, error: 'locked' };
    if (
      isExpired(
        budget.valid_until ? dateColumnToString(budget.valid_until) : null,
        await clinicToday(db, budget.clinic_id),
      )
    ) {
      return { ok: false, error: 'expired' };
    }
    if (method !== budget.public_auth_method) return { ok: false, error: 'method_mismatch' };

    const now = new Date();
    const windowStart = new Date(now.getTime() - PUBLIC_AUTH_FAIL_WINDOW_MS);
    const recentFailures = await db.budget_access_logs.count({
      where: { budget_id: budget.id, attempted_at: { gte: windowStart }, success: false },
    });
    if (recentFailures >= PUBLIC_AUTH_FAIL_LIMIT_WINDOW) {
      return { ok: false, error: 'rate_limited' };
    }

    const ok = await compareMethodValue(db, budget, method, value);

    await db.budget_access_logs.create({
      data: {
        id: crypto.randomUUID(),
        budget_id: budget.id,
        attempted_at: now,
        ip_hash: ipHash,
        success: ok,
        method_attempted: method,
      },
    });

    if (!ok) {
      // Le verrou permanent reste au niveau du budget : l'URL est un secret
      // que seul le patient détient (#531).
      const totalFailures = await db.budget_access_logs.count({
        where: { budget_id: budget.id, success: false },
      });
      if (totalFailures >= PUBLIC_AUTH_TOTAL_FAIL_LOCKOUT) {
        await db.budgets.update({
          where: { id: budget.id },
          data: { public_locked_at: now, updated_at: now },
        });
        return { ok: false, error: 'locked' };
      }
      return { ok: false, error: 'invalid' };
    }
    return { ok: true, error: null };
  },

  /**
   * Clone d'un budget terminal vers un nouveau brouillon (« Resend ») :
   * lignes, fenêtre de validité, snapshots de plan ; nouveau `public_token`
   * et méthode d'authentification re-résolue.
   */
  async cloneToNewDraft(db: Db, budget: WorkflowBudget, clonedBy: string): Promise<string> {
    const plan = await lookupLinkedPlan(db, budget.clinic_id, budget.id);
    const nextVersion = await BudgetService.nextVersion(
      db,
      budget.clinic_id,
      budget.budget_number,
    );
    const id = crypto.randomUUID();
    const now = new Date();

    await db.budgets.create({
      data: {
        id,
        clinic_id: budget.clinic_id,
        patient_id: budget.patient_id,
        budget_number: budget.budget_number,
        version: nextVersion,
        parent_budget_id: budget.id,
        status: 'draft',
        valid_from: dateColumnToUtc(await clinicToday(db, budget.clinic_id)),
        valid_until: budget.valid_until,
        created_by: clonedBy,
        assigned_professional_id: await assignedProfessionalOf(db, budget.id),
        global_discount_type: budget.global_discount_type,
        global_discount_value: budget.global_discount_value,
        subtotal: new Prisma.Decimal(0),
        total_discount: new Prisma.Decimal(0),
        total_tax: new Prisma.Decimal(0),
        total: new Prisma.Decimal(0),
        internal_notes: null,
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
        public_auth_method: await resolvePublicAuthMethod(
          db,
          budget.clinic_id,
          budget.patient_id,
        ),
        public_auth_secret_hash: null,
        public_locked_at: null,
        plan_number_snapshot: budget.plan_number_snapshot,
        plan_status_snapshot: plan ? plan.status : budget.plan_status_snapshot,
      },
    });

    for (const item of budget.items) {
      await BudgetItemService.createItem(db, budget.clinic_id, id, {
        catalog_item_id: item.catalog_item_id,
        quantity: item.quantity,
        treatment_id: item.treatment_id,
        tooth_number: item.tooth_number,
        surfaces: asStringArray(item.surfaces),
        unit_price: toCents(item.unit_price),
        discount_type: item.discount_type,
        discount_value: item.discount_value === null ? null : toCents(item.discount_value),
        display_order: item.display_order,
        notes: item.notes,
      });
    }
    await BudgetService.recalculateTotals(db, id);

    await BudgetHistoryService.addEntry(db, {
      clinicId: budget.clinic_id,
      budgetId: id,
      action: 'created',
      changedBy: clonedBy,
      previousState: { parent_budget_id: budget.id },
      newState: { status: 'draft', version: nextVersion },
      notes: 'Cloned from budget for resend',
    });
    return id;
  },

  /** `budget.superseded` : le plan suit la nouvelle version (même lien). */
  async supersedePlanLink(db: Db, budget: WorkflowBudget, newBudgetId: string): Promise<void> {
    await db.treatment_plans.updateMany({
      where: { budget_id: budget.id, clinic_id: budget.clinic_id, deleted_at: null },
      data: { budget_id: newBudgetId, updated_at: new Date() },
    });
  },
};

async function assignedProfessionalOf(db: Db, budgetId: string): Promise<string | null> {
  const row = await db.budgets.findUnique({
    where: { id: budgetId },
    select: { assigned_professional_id: true },
  });
  return row?.assigned_professional_id ?? null;
}

/** Comparaison (pseudo) à temps constant de la valeur de vérification. */
async function compareMethodValue(
  db: Db,
  budget: WorkflowBudget,
  method: string,
  value: string,
): Promise<boolean> {
  if (method === 'none') return true;
  if (method === 'manual_code') {
    return verifyPassword(value, budget.public_auth_secret_hash ?? '');
  }
  const patient = await db.patients.findUnique({
    where: { id: budget.patient_id },
    select: { phone: true, date_of_birth: true },
  });
  if (!patient) return false;
  if (method === 'phone_last4') {
    const digits = phoneDigits(patient.phone);
    if (digits.length < 4) return false;
    return constantTimeEqual(digits.slice(-4), phoneDigits(value));
  }
  if (method === 'dob') {
    if (patient.date_of_birth === null) return false;
    return constantTimeEqual(patient.date_of_birth.toISOString().slice(0, 10), value.trim());
  }
  return false;
}

// ---------------------------------------------------------------------------
// Expiration (tâche cron `check_expired_budgets`, sans bus)
// ---------------------------------------------------------------------------

/** Marque expirés les brouillons/envoyés dépassés et journalise chaque passage. */
export async function expireBudgetsForClinic(db: Db, clinicId: string): Promise<number> {
  const today = await clinicToday(db, clinicId);
  const rows = await db.budgets.findMany({
    where: {
      clinic_id: clinicId,
      status: { in: ['draft', 'sent'] },
      valid_until: { not: null, lt: dateColumnToUtc(today) },
      deleted_at: null,
    },
    select: { id: true, status: true, created_by: true },
  });
  for (const row of rows) {
    await db.budgets.update({
      where: { id: row.id },
      data: { status: 'expired', updated_at: new Date() },
    });
    await BudgetHistoryService.addEntry(db, {
      clinicId,
      budgetId: row.id,
      action: 'status_changed',
      changedBy: row.created_by,
      previousState: { status: row.status },
      newState: { status: 'expired', expired_at: today },
      notes: 'Automatically expired due to validity period',
    });
  }
  return rows.length;
}

/**
 * Validity window used when a plan is confirmed (`DEFAULT_BUDGET_VALIDITY_DAYS`
 * ou `clinic.settings.budget_expiry_days`).
 */
export function resolveValidityDays(settings: Record<string, unknown>): number {
  const raw = settings.budget_expiry_days;
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : 30;
}

/** `valid_until` par défaut pour un budget généré depuis un plan. */
export function defaultValidUntil(today: string, settings: Record<string, unknown>): string {
  return addDays(today, resolveValidityDays(settings));
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** Corps exact renvoyé par les endpoints PDF binaires sur Express. */
export const PDF_UNAVAILABLE_DETAIL = 'PDF generation is not available on the Express backend yet';

/**
 * Valeur de remise globale en « centièmes » : un pourcentage est converti
 * (`p * 100`, forme attendue par le pricing) et un montant absolu passe en
 * centimes.
 */
export function globalDiscountValueCents(value: Prisma.Decimal | null): number | null {
  if (value === null) return null;
  return Math.round(Number(value.toString()) * 100);
}

function toPdfBudget(row: BudgetDetailRow): PdfBudget {
  const items: PdfBudgetItem[] = row.budget_items.map((item) => ({
    id: item.id,
    quantity: item.quantity,
    unitPriceCents: toCents(item.unit_price),
    lineSubtotalCents: toCents(item.line_subtotal),
    lineDiscountCents: toCents(item.line_discount),
    lineTotalCents: toCents(item.line_total),
    vatRate: item.vat_rate,
    toothNumber: item.tooth_number,
    surfaces: asStringArray(item.surfaces),
    notes: item.notes,
    catalogItem: item.treatment_catalog_items
      ? { names: asRecord(item.treatment_catalog_items.names) }
      : null,
  }));
  const professional = row.users_budgets_assigned_professional_idTousers;
  return {
    budgetNumber: row.budget_number,
    version: row.version,
    status: row.status,
    createdAt: row.created_at,
    validFrom: dateColumnToString(row.valid_from),
    validUntil: row.valid_until === null ? null : dateColumnToString(row.valid_until),
    globalDiscountType: row.global_discount_type,
    globalDiscountValueCents: globalDiscountValueCents(row.global_discount_value),
    subtotalCents: toCents(row.subtotal),
    totalDiscountCents: toCents(row.total_discount),
    totalTaxCents: toCents(row.total_tax),
    totalCents: toCents(row.total),
    patientNotes: row.patient_notes,
    patient: row.patients
      ? { firstName: row.patients.first_name, lastName: row.patients.last_name }
      : null,
    assignedProfessional: professional
      ? { firstName: professional.first_name, lastName: professional.last_name }
      : null,
    items,
  };
}

function toPdfClinic(
  clinic: {
    name: string;
    address: unknown;
    phone: string | null;
    email: string | null;
    currency: string;
    timezone: string;
  } | null,
): PdfClinic | null {
  if (!clinic) return null;
  return {
    name: clinic.name,
    address:
      clinic.address !== null && typeof clinic.address === 'object' && !Array.isArray(clinic.address)
        ? (clinic.address as Record<string, unknown>)
        : null,
    phone: clinic.phone,
    email: clinic.email,
    currency: clinic.currency,
    timezone: clinic.timezone,
  };
}

function toPdfSignature(row: SignatureRow | null): PdfSignature | null {
  if (!row) return null;
  const data = row.signature_data;
  return {
    signedByName: row.signed_by_name,
    signatureMethod: row.signature_method,
    signatureData:
      data !== null && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null,
    signedAt: row.signed_at,
    documentHash: row.document_hash,
  };
}

const clinicSelect = {
  name: true,
  address: true,
  phone: true,
  email: true,
  currency: true,
  timezone: true,
} satisfies Prisma.clinicsSelect;

/**
 * HTML du PDF (aperçu ou non). Les octets PDF ne sont pas produits côté
 * Express : le routeur renvoie 501, l'aperçu sert ce HTML.
 */
export async function generateBudgetHtml(
  row: BudgetDetailRow,
  options: { isPreview: boolean; locale: string; withSignature?: boolean },
): Promise<string> {
  const clinic = await prisma.clinics.findUnique({
    where: { id: row.clinic_id },
    select: clinicSelect,
  });
  const signature = options.withSignature
    ? (row.budget_signatures.find((sig) => sig.signature_type === 'full_acceptance') ?? null)
    : null;
  return renderBudgetHtml({
    budget: toPdfBudget(row),
    clinic: toPdfClinic(clinic),
    isPreview: options.isPreview,
    locale: options.locale,
    signature: toPdfSignature(signature),
  });
}

/** Signature d'acceptation la plus récente (ordre `signed_at DESC`). */
export async function findLatestAcceptanceSignature(
  db: Db,
  clinicId: string,
  budgetId: string,
): Promise<SignatureRow | null> {
  return db.budget_signatures.findFirst({
    where: { budget_id: budgetId, clinic_id: clinicId, signature_type: 'full_acceptance' },
    orderBy: [{ signed_at: 'desc' }, { id: 'asc' }],
  });
}
