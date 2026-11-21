/**
 * Couche service du module `odontogram` — port de
 * `app/modules/odontogram/service.py`.
 *
 * - Multi-tenant : chaque lecture/écriture filtre sur `clinic_id`; les lignes
 *   d'un autre cabinet sont indistinguables d'une absence (404 côté router).
 * - DTO : les `Decimal` sortent en nombres (sérialisation Pydantic), les
 *   instants en ISO 8601 UTC (`toISOString`), les colonnes JSON telles quelles.
 * - Les dates naïves (paramètre `date` de l'odontogramme historique) sont
 *   interprétées dans le fuseau de la clinique (`req.clinic!.timezone`), comme
 *   côté agenda. Les écritures utilisent `now()` UTC (`datetime.now(UTC)`).
 */

import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../lib/errors';
import { parseClinicDate } from '../../lib/time';
import {
  ATOMIC_MULTI_TOOTH_TYPES,
  CONDITION_COLORS,
  SURFACES,
  TOOTH_CONDITIONS,
  assignRoles,
  buildTeethInputs,
  computeDurationSnapshot,
  computePriceSnapshot,
  defaultSurfaces,
  getToothType,
  priceDecimal,
  reconstructTeethAtDate,
  resolveClinicalType,
  type HistoricalToothState,
  type PricingTooth,
  type ToothInput,
} from './schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dec(value: Prisma.Decimal | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value.toString());
}

function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/** JSONB surfaces (clé → condition) en `Record<string, string>`. */
function asSurfaceMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, condition] of Object.entries(asRecord(value))) {
    if (typeof condition === 'string') result[key] = condition;
  }
  return result;
}

/** JSONB `treatment_teeth.surfaces` (liste) en `string[] | null`. */
export function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string');
}

// ---------------------------------------------------------------------------
// Includes
// ---------------------------------------------------------------------------

const treatmentInclude = {
  // `Treatment.teeth` : `order_by="TreatmentTooth.tooth_number"`.
  treatment_teeth: { orderBy: [{ tooth_number: 'asc' }, { id: 'asc' }] },
  // Ligne catalogue complète (le DTO n'expose que le brief, mais les écritures
  // revoient le prix depuis la stratégie de l'item).
  treatment_catalog_items: true,
  users: { select: { first_name: true, last_name: true } },
} satisfies Prisma.treatmentsInclude;

type TreatmentRow = Prisma.treatmentsGetPayload<{ include: typeof treatmentInclude }>;

// ---------------------------------------------------------------------------
// DTOs (miroir des schémas Pydantic)
// ---------------------------------------------------------------------------

export interface ToothRecordDto {
  id: string;
  patient_id: string;
  tooth_number: number;
  tooth_type: string;
  general_condition: string;
  surfaces: Record<string, string>;
  notes: string | null;
  is_displaced: boolean;
  is_rotated: boolean;
  displacement_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CatalogItemBriefDto {
  id: string;
  internal_code: string;
  names: Record<string, unknown>;
  default_price: number | null;
}

export interface TreatmentToothDto {
  id: string;
  tooth_record_id: string;
  tooth_number: number;
  role: string | null;
  surfaces: string[] | null;
}

export interface TreatmentDto {
  id: string;
  patient_id: string;
  clinical_type: string;
  scope: string;
  arch: string | null;
  status: string;
  catalog_item_id: string | null;
  catalog_item: CatalogItemBriefDto | null;
  teeth: TreatmentToothDto[];
  recorded_at: string;
  performed_at: string | null;
  performed_by: string | null;
  performed_by_name: string | null;
  price_snapshot: number | null;
  duration_snapshot: number | null;
  vat_rate_snapshot: number | null;
  budget_item_id: string | null;
  notes: string | null;
  source_module: string;
  created_at: string;
  updated_at: string;
}

export interface HistoryEntryDto {
  id: string;
  tooth_number: number;
  change_type: string;
  surface: string | null;
  old_condition: string | null;
  new_condition: string | null;
  notes: string | null;
  changed_by: string;
  changed_at: string;
  changed_by_name: string | null;
}

export interface TimelineDateEntry {
  date: string;
  change_count: number;
}

export interface OdontogramDto {
  patient_id: string;
  teeth: ToothRecordDto[];
  treatments: TreatmentDto[];
  condition_colors: Record<string, string>;
  available_conditions: string[];
  surfaces: string[];
}

export interface HistoricalTreatmentDto {
  id: string;
  clinical_type: string;
  scope: string;
  arch: string | null;
  status: string;
  catalog_item_id: string | null;
  teeth: TreatmentToothDto[];
  recorded_at: string;
  performed_at: string | null;
  performed_by: string | null;
  performed_by_name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface HistoricalOdontogramDto {
  patient_id: string;
  teeth: HistoricalToothState[];
  treatments: HistoricalTreatmentDto[];
  condition_colors: Record<string, string>;
  available_conditions: string[];
  surfaces: string[];
}

export interface ToothRecordWithTreatmentsDto extends ToothRecordDto {
  treatments: TreatmentDto[];
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toToothRecordDto(row: {
  id: string;
  patient_id: string;
  tooth_number: number;
  tooth_type: string;
  general_condition: string;
  surfaces: unknown;
  notes: string | null;
  is_displaced: boolean;
  is_rotated: boolean;
  displacement_notes: string | null;
  created_at: Date;
  updated_at: Date;
}): ToothRecordDto {
  return {
    id: row.id,
    patient_id: row.patient_id,
    tooth_number: row.tooth_number,
    tooth_type: row.tooth_type,
    general_condition: row.general_condition,
    surfaces: asSurfaceMap(row.surfaces),
    notes: row.notes,
    is_displaced: row.is_displaced,
    is_rotated: row.is_rotated,
    displacement_notes: row.displacement_notes,
    created_at: iso(row.created_at)!,
    updated_at: iso(row.updated_at)!,
  };
}

/** `build_treatment_response` + `TreatmentResponse.model_validate`. */
export function toTreatmentDto(row: TreatmentRow | null): TreatmentDto | null {
  if (!row) return null;
  const catalog = row.treatment_catalog_items;
  const performer = row.users;
  return {
    id: row.id,
    patient_id: row.patient_id,
    clinical_type: row.clinical_type,
    scope: row.scope,
    arch: row.arch,
    status: row.status,
    catalog_item_id: row.catalog_item_id,
    catalog_item: catalog
      ? {
          id: catalog.id,
          internal_code: catalog.internal_code,
          names: asRecord(catalog.names),
          default_price: dec(catalog.default_price),
        }
      : null,
    teeth: row.treatment_teeth.map((tooth) => ({
      id: tooth.id,
      tooth_record_id: tooth.tooth_record_id,
      tooth_number: tooth.tooth_number,
      role: tooth.role,
      surfaces: asStringArray(tooth.surfaces),
    })),
    recorded_at: row.recorded_at.toISOString(),
    performed_at: iso(row.performed_at),
    performed_by: row.performed_by,
    performed_by_name:
      row.performed_by !== null && performer !== null
        ? `${performer.first_name} ${performer.last_name}`
        : null,
    price_snapshot: dec(row.price_snapshot),
    duration_snapshot: row.duration_snapshot,
    vat_rate_snapshot: dec(row.vat_rate_snapshot),
    budget_item_id: row.budget_item_id,
    notes: row.notes,
    source_module: row.source_module,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function toHistoricalTreatmentDto(row: TreatmentRow): HistoricalTreatmentDto {
  const performer = row.users;
  return {
    id: row.id,
    clinical_type: row.clinical_type,
    scope: row.scope,
    arch: row.arch,
    status: row.status,
    catalog_item_id: row.catalog_item_id,
    teeth: row.treatment_teeth.map((tooth) => ({
      id: tooth.id,
      tooth_record_id: tooth.tooth_record_id,
      tooth_number: tooth.tooth_number,
      role: tooth.role,
      surfaces: asStringArray(tooth.surfaces),
    })),
    recorded_at: row.recorded_at.toISOString(),
    performed_at: iso(row.performed_at),
    performed_by: row.performed_by,
    performed_by_name:
      row.performed_by !== null && performer !== null
        ? `${performer.first_name} ${performer.last_name}`
        : null,
    notes: row.notes,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Patient access (port de `router.validate_patient_access`)
// ---------------------------------------------------------------------------

/** Patient du cabinet, non archivé — sinon 404 `Patient not found`. */
export async function validatePatientAccess(
  clinicId: string,
  patientId: string,
): Promise<void> {
  const patient = await prisma.patients.findFirst({
    where: { id: patientId, clinic_id: clinicId, status: { not: 'archived' } },
    select: { id: true },
  });
  if (!patient) throw notFound('Patient not found');
}

// ---------------------------------------------------------------------------
// Événements (port des payloads `event_bus.publish`)
// ---------------------------------------------------------------------------

export interface OdontogramEvent {
  type:
    | 'odontogram.surface.updated'
    | 'odontogram.tooth.updated'
    | 'odontogram.condition.changed'
    | 'odontogram.treatment.added'
    | 'odontogram.treatment.status_changed'
    | 'odontogram.treatment.performed'
    | 'odontogram.treatment.deleted';
  payload: Record<string, unknown>;
}

/**
 * Crochet d'émission. Le backend Express n'a pas encore de bus d'événements
 * (la propagation plan → traitement est faite en direct par
 * `treatment_plan`), les payloads sont donc conservés à l'identique et
 * collectés ici pour pouvoir être branchés sans retoucher le service.
 */
export type EventSink = (event: OdontogramEvent) => void;

let eventSink: EventSink | null = null;

export function setOdontogramEventSink(sink: EventSink | null): void {
  eventSink = sink;
}

function publish(type: OdontogramEvent['type'], payload: Record<string, unknown>): void {
  eventSink?.({ type, payload });
}

// ---------------------------------------------------------------------------
// Tooth records
// ---------------------------------------------------------------------------

function toJson(value: Record<string, string> | readonly string[]): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export interface SurfaceUpdateInput {
  surface: string;
  condition: string;
}

export interface ToothUpdateOptions {
  generalCondition?: string | null;
  surfaceUpdates?: readonly SurfaceUpdateInput[] | null;
  notes?: string | null;
  isDisplaced?: boolean | null;
  isRotated?: boolean | null;
  displacementNotes?: string | null;
}

type Tx = Prisma.TransactionClient;

async function getToothRecordRow(
  db: Tx | typeof prisma,
  clinicId: string,
  patientId: string,
  toothNumber: number,
) {
  return db.tooth_records.findFirst({
    where: { clinic_id: clinicId, patient_id: patientId, tooth_number: toothNumber },
  });
}

function historyRow(params: {
  clinicId: string;
  patientId: string;
  toothNumber: number;
  changeType: string;
  surface?: string | null;
  oldCondition?: string | null;
  newCondition?: string | null;
  notes?: string | null;
  userId: string;
  now: Date;
}): Prisma.odontogram_historyCreateManyInput {
  return {
    id: crypto.randomUUID(),
    clinic_id: params.clinicId,
    patient_id: params.patientId,
    tooth_number: params.toothNumber,
    change_type: params.changeType,
    surface: params.surface ?? null,
    old_condition: params.oldCondition ?? null,
    new_condition: params.newCondition ?? null,
    notes: params.notes ?? null,
    changed_by: params.userId,
    changed_at: params.now,
  };
}

/**
 * `OdontogramService.create_or_update_tooth` : crée ou met à jour la dent en
 * journalisant chaque changement (condition générale, surfaces, note).
 */
async function createOrUpdateTooth(
  db: Tx,
  clinicId: string,
  patientId: string,
  toothNumber: number,
  userId: string,
  options: ToothUpdateOptions = {},
) {
  const {
    generalCondition = null,
    surfaceUpdates = null,
    notes = null,
    isDisplaced = null,
    isRotated = null,
    displacementNotes = null,
  } = options;

  const existing = await getToothRecordRow(db, clinicId, patientId, toothNumber);
  const toothType = getToothType(toothNumber);
  const now = new Date();
  const history: Prisma.odontogram_historyCreateManyInput[] = [];
  const addHistory = (
    changeType: string,
    extra: {
      surface?: string | null;
      oldCondition?: string | null;
      newCondition?: string | null;
      notes?: string | null;
    } = {},
  ): void => {
    history.push(
      historyRow({ clinicId, patientId, toothNumber, changeType, userId, now, ...extra }),
    );
  };

  if (existing) {
    const data: Prisma.tooth_recordsUncheckedUpdateInput = {};

    if (generalCondition !== null && generalCondition !== existing.general_condition) {
      addHistory('general_condition', {
        oldCondition: existing.general_condition,
        newCondition: generalCondition,
      });
      publish('odontogram.condition.changed', {
        clinic_id: clinicId,
        patient_id: patientId,
        tooth_number: toothNumber,
        surface: null,
        old_condition: existing.general_condition,
        new_condition: generalCondition,
        changed_by: userId,
      });
      data.general_condition = generalCondition;
    }

    if (surfaceUpdates && surfaceUpdates.length > 0) {
      const current = asSurfaceMap(existing.surfaces);
      for (const update of surfaceUpdates) {
        const oldCondition = current[update.surface] ?? 'healthy';
        if (update.condition !== oldCondition) {
          current[update.surface] = update.condition;
          addHistory('surface_update', {
            surface: update.surface,
            oldCondition,
            newCondition: update.condition,
          });
          publish('odontogram.surface.updated', {
            clinic_id: clinicId,
            patient_id: patientId,
            tooth_number: toothNumber,
            surface: update.surface,
            old_condition: oldCondition,
            new_condition: update.condition,
            changed_by: userId,
          });
        }
      }
      data.surfaces = toJson(current);
    }

    if (notes !== null && notes !== existing.notes) {
      addHistory('note', { notes });
      data.notes = notes;
    }

    if (isDisplaced !== null) data.is_displaced = isDisplaced;
    if (isRotated !== null) data.is_rotated = isRotated;
    if (displacementNotes !== null) data.displacement_notes = displacementNotes;
    data.updated_at = now;

    await db.tooth_records.update({ where: { id: existing.id }, data });
    if (history.length > 0) {
      await db.odontogram_history.createMany({ data: history });
    }
    return (await db.tooth_records.findUnique({ where: { id: existing.id } }))!;
  }

  return createToothRecord(db, clinicId, patientId, toothNumber, userId);
}

/**
 * Création d'un enregistrement de dent — branche `else` de
 * `create_or_update_tooth` : surfaces par défaut (+ mises à jour demandées),
 * `general_condition or 'healthy'`, marqueurs orthodontiques à `false`.
 * Le bulk ne transmet ni `is_displaced` ni `is_rotated`.
 */
async function createToothRecord(
  db: Tx,
  clinicId: string,
  patientId: string,
  toothNumber: number,
  userId: string,
  options: ToothUpdateOptions = {},
) {
  const { generalCondition = null, surfaceUpdates = null, notes = null } = options;
  const toothType = getToothType(toothNumber);
  const now = new Date();

  const surfaces = defaultSurfaces();
  for (const update of surfaceUpdates ?? []) {
    surfaces[update.surface] = update.condition;
  }
  const generalConditionValue = generalCondition ?? 'healthy';
  const id = crypto.randomUUID();

  await db.tooth_records.create({
    data: {
      id,
      clinic_id: clinicId,
      patient_id: patientId,
      tooth_number: toothNumber,
      tooth_type: toothType,
      general_condition: generalConditionValue,
      surfaces: toJson(surfaces),
      notes,
      is_displaced: options.isDisplaced ?? false,
      is_rotated: options.isRotated ?? false,
      displacement_notes: options.displacementNotes ?? null,
      created_at: now,
      updated_at: now,
    },
  });
  await db.odontogram_history.createMany({
    data: [
      historyRow({
        clinicId,
        patientId,
        toothNumber,
        changeType: 'created',
        newCondition: generalConditionValue,
        userId,
        now,
      }),
    ],
  });
  publish('odontogram.tooth.updated', {
    clinic_id: clinicId,
    patient_id: patientId,
    tooth_number: toothNumber,
    changed_by: userId,
  });
  return (await db.tooth_records.findUnique({ where: { id } }))!;
}

async function getOrCreateToothRecord(
  db: Tx,
  clinicId: string,
  patientId: string,
  toothNumber: number,
  userId: string,
) {
  const existing = await getToothRecordRow(db, clinicId, patientId, toothNumber);
  if (existing) return existing;
  return createToothRecord(db, clinicId, patientId, toothNumber, userId);
}

export async function getPatientOdontogram(clinicId: string, patientId: string) {
  return prisma.tooth_records.findMany({
    where: { clinic_id: clinicId, patient_id: patientId },
    orderBy: [{ tooth_number: 'asc' }, { id: 'asc' }],
  });
}

export async function getToothRecord(
  clinicId: string,
  patientId: string,
  toothNumber: number,
) {
  return getToothRecordRow(prisma, clinicId, patientId, toothNumber);
}

/** PUT/PATCH `/patients/:id/teeth/:n` — écriture transactionnelle. */
export async function upsertTooth(
  clinicId: string,
  patientId: string,
  toothNumber: number,
  userId: string,
  input: ToothUpdateOptions,
): Promise<ToothRecordDto> {
  const row = await prisma.$transaction((tx) =>
    createOrUpdateTooth(tx, clinicId, patientId, toothNumber, userId, input),
  );
  return toToothRecordDto(row);
}

export async function bulkUpdateTeeth(
  clinicId: string,
  patientId: string,
  userId: string,
  updates: readonly (ToothUpdateOptions & { toothNumber: number })[],
): Promise<ToothRecordDto[]> {
  const rows = await prisma.$transaction(async (tx) => {
    const result = [];
    for (const update of updates) {
      result.push(
        await createOrUpdateTooth(tx, clinicId, patientId, update.toothNumber, userId, {
          generalCondition: update.generalCondition,
          surfaceUpdates: update.surfaceUpdates,
          notes: update.notes,
        }),
      );
    }
    return result;
  });
  return rows.map(toToothRecordDto);
}

async function toHistoryDto(
  row: Prisma.odontogram_historyGetPayload<{ include: { users: true } }>,
): Promise<HistoryEntryDto> {
  return {
    id: row.id,
    tooth_number: row.tooth_number,
    change_type: row.change_type,
    surface: row.surface,
    old_condition: row.old_condition,
    new_condition: row.new_condition,
    notes: row.notes,
    changed_by: row.changed_by,
    changed_at: row.changed_at.toISOString(),
    changed_by_name: row.users
      ? `${row.users.first_name} ${row.users.last_name}`
      : null,
  };
}

const historyInclude = { users: true } satisfies Prisma.odontogram_historyInclude;

export async function getToothHistory(
  clinicId: string,
  patientId: string,
  toothNumber: number,
  page: number,
  pageSize: number,
): Promise<{ items: HistoryEntryDto[]; total: number }> {
  const where: Prisma.odontogram_historyWhereInput = {
    clinic_id: clinicId,
    patient_id: patientId,
    tooth_number: toothNumber,
  };
  const [rows, total] = await Promise.all([
    prisma.odontogram_history.findMany({
      where,
      include: historyInclude,
      orderBy: [{ changed_at: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.odontogram_history.count({ where }),
  ]);
  return { items: await Promise.all(rows.map(toHistoryDto)), total };
}

export async function getPatientHistory(
  clinicId: string,
  patientId: string,
  page: number,
  pageSize: number,
): Promise<{ items: HistoryEntryDto[]; total: number }> {
  const where: Prisma.odontogram_historyWhereInput = {
    clinic_id: clinicId,
    patient_id: patientId,
  };
  const [rows, total] = await Promise.all([
    prisma.odontogram_history.findMany({
      where,
      include: historyInclude,
      orderBy: [{ changed_at: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.odontogram_history.count({ where }),
  ]);
  return { items: await Promise.all(rows.map(toHistoryDto)), total };
}

export async function getTimelineDates(
  clinicId: string,
  patientId: string,
  timeZone: string,
): Promise<TimelineDateEntry[]> {
  // `func.date()` SQLAlchemy = `(col)::date` sur un `timestamptz`, c'est-à-dire
  // la date dans le fuseau du serveur. Le calendrier du frontend est celui du
  // cabinet : on agrège dans le fuseau de la clinique (même convention que
  // `reports`).
  const historyRows = await prisma.$queryRaw<Array<{ day: string; n: bigint }>>`
    SELECT to_char(changed_at AT TIME ZONE ${timeZone}::text, 'YYYY-MM-DD') AS day,
           COUNT(*)::bigint AS n
    FROM public.odontogram_history
    WHERE clinic_id = ${clinicId}::uuid
      AND patient_id = ${patientId}::uuid
    GROUP BY day
  `;
  const treatmentRows = await prisma.$queryRaw<Array<{ day: string; n: bigint }>>`
    SELECT to_char(recorded_at AT TIME ZONE ${timeZone}::text, 'YYYY-MM-DD') AS day,
           COUNT(*)::bigint AS n
    FROM public.treatments
    WHERE clinic_id = ${clinicId}::uuid
      AND patient_id = ${patientId}::uuid
    GROUP BY day
  `;

  const counts = new Map<string, number>();
  for (const row of [...historyRows, ...treatmentRows]) {
    counts.set(row.day, (counts.get(row.day) ?? 0) + Number(row.n));
  }

  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, changeCount]) => ({ date, change_count: changeCount }));
}

/**
 * `get_odontogram_at_date` : état des dents + traitements au soir de
 * `targetDate` (date locale du cabinet, donc `time.max` local).
 */
export async function getOdontogramAtDate(
  clinicId: string,
  patientId: string,
  targetDate: Date,
  timeZone: string,
): Promise<HistoricalOdontogramDto> {
  // `target_date` est une date locale du cabinet ; l'état demandé est celui
  // du soir de ce jour-là → borne exclusive = minuit local du lendemain
  // (`datetime.combine(target_date, time.max)`).
  const cutoff = parseClinicDate(
    new Date(
      Date.UTC(
        targetDate.getUTCFullYear(),
        targetDate.getUTCMonth(),
        targetDate.getUTCDate() + 1,
      ),
    )
      .toISOString()
      .slice(0, 10),
    timeZone,
  );

  const [entries, treatments] = await Promise.all([
    prisma.odontogram_history.findMany({
      where: {
        clinic_id: clinicId,
        patient_id: patientId,
        changed_at: { lt: cutoff },
      },
      orderBy: [{ changed_at: 'asc' }, { id: 'asc' }],
    }),
    prisma.treatments.findMany({
      where: {
        clinic_id: clinicId,
        patient_id: patientId,
        recorded_at: { lt: cutoff },
        OR: [{ deleted_at: null }, { deleted_at: { gte: cutoff } }],
      },
      include: treatmentInclude,
      orderBy: [{ recorded_at: 'asc' }, { id: 'asc' }],
    }),
  ]);

  return {
    patient_id: patientId,
    teeth: reconstructTeethAtDate(entries),
    treatments: treatments.map(toHistoricalTreatmentDto),
    condition_colors: CONDITION_COLORS,
    available_conditions: [...TOOTH_CONDITIONS],
    surfaces: [...SURFACES],
  };
}

export interface ToothWithTreatments {
  tooth: ToothRecordDto;
  treatments: TreatmentDto[];
}

export async function getToothWithTreatments(
  clinicId: string,
  patientId: string,
  toothNumber: number,
): Promise<ToothWithTreatments | null> {
  const record = await getToothRecordRow(prisma, clinicId, patientId, toothNumber);
  if (!record) return null;
  // Python joint `TreatmentTooth` sans `DISTINCT` sur les colonnes : une même
  // dent ne peut apparaître qu'une fois par traitement (contrainte unique).
  const rows = await prisma.treatments.findMany({
    where: {
      clinic_id: clinicId,
      patient_id: patientId,
      deleted_at: null,
      treatment_teeth: { some: { tooth_number: toothNumber } },
    },
    include: treatmentInclude,
  });
  return {
    tooth: toToothRecordDto(record),
    treatments: rows.map((row) => toTreatmentDto(row)!),
  };
}

// ---------------------------------------------------------------------------
// Treatments
// ---------------------------------------------------------------------------

export async function getTreatment(
  clinicId: string,
  treatmentId: string,
  includeDeleted = false,
): Promise<TreatmentDto | null> {
  const row = await prisma.treatments.findFirst({
    where: {
      clinic_id: clinicId,
      id: treatmentId,
      ...(includeDeleted ? {} : { deleted_at: null }),
    },
    include: treatmentInclude,
  });
  return toTreatmentDto(row);
}

export interface TreatmentListFilters {
  status?: string | null;
  clinicalType?: string | null;
  toothNumber?: number | null;
  catalogItemId?: string | null;
  page: number;
  pageSize: number;
  includeDeleted?: boolean;
}

export async function listPatientTreatments(
  clinicId: string,
  patientId: string,
  filters: TreatmentListFilters,
): Promise<{ rows: TreatmentDto[]; total: number }> {
  const where: Prisma.treatmentsWhereInput = { clinic_id: clinicId, patient_id: patientId };
  if (!filters.includeDeleted) where.deleted_at = null;
  if (filters.status) where.status = filters.status;
  if (filters.clinicalType) where.clinical_type = filters.clinicalType;
  if (filters.catalogItemId) where.catalog_item_id = filters.catalogItemId;
  if (filters.toothNumber !== null && filters.toothNumber !== undefined) {
    where.treatment_teeth = { some: { tooth_number: filters.toothNumber } };
  }

  const [rows, total] = await Promise.all([
    prisma.treatments.findMany({
      where,
      include: treatmentInclude,
      orderBy: [{ recorded_at: 'desc' }, { id: 'asc' }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.treatments.count({ where }),
  ]);
  return { rows: rows.map((row) => toTreatmentDto(row)!), total };
}

type CatalogItemWithRefs = Prisma.treatment_catalog_itemsGetPayload<{
  include: { treatment_odontogram_mappings: true; vat_types: true };
}>;

async function loadCatalogItem(
  clinicId: string,
  catalogItemId: string,
): Promise<CatalogItemWithRefs> {
  const item = await prisma.treatment_catalog_items.findFirst({
    where: { clinic_id: clinicId, id: catalogItemId, deleted_at: null },
    include: { treatment_odontogram_mappings: true, vat_types: true },
  });
  if (!item) throw badRequest('Catalog item not found');
  return item;
}

function pricingTeeth(teeth: readonly ToothInput[]): PricingTooth[] {
  return teeth.map((tooth) => ({ role: tooth.role ?? null, surfaces: tooth.surfaces ?? null }));
}

export interface TreatmentCreateParams {
  catalogItemId: string | null;
  clinicalType: string | null;
  toothNumbers: readonly number[];
  teeth: readonly ToothInput[] | null;
  commonSurfaces: readonly string[] | null;
  status: string;
  notes: string | null;
  budgetItemId: string | null;
  sourceModule: string;
  scope: string;
  arch: string | null;
}

export async function createTreatment(
  clinicId: string,
  patientId: string,
  userId: string,
  params: TreatmentCreateParams,
): Promise<TreatmentDto> {
  const now = new Date();

  // 1. Catalogue + type clinique (ValueError Python → 400).
  let catalogItem: CatalogItemWithRefs | null = null;
  if (params.catalogItemId !== null && params.catalogItemId !== undefined) {
    catalogItem = await loadCatalogItem(clinicId, params.catalogItemId);
  }
  const mapping = catalogItem?.treatment_odontogram_mappings
    ? { odontogram_treatment_type: catalogItem.treatment_odontogram_mappings.odontogram_treatment_type }
    : null;
  const clinicalType = resolveClinicalType(params.clinicalType, mapping, params.scope);

  // 2. Normalisation + rôles des bridges.
  let teethInputs = buildTeethInputs(params.toothNumbers, params.teeth, params.commonSurfaces);
  teethInputs = assignRoles(teethInputs, clinicalType);

  // 3. Minimums des traitements atomiques (scopes « dent »).
  if (
    (params.scope === 'tooth' || params.scope === 'multi_tooth')
    && ATOMIC_MULTI_TOOTH_TYPES.has(clinicalType)
    && teethInputs.length < 2
  ) {
    throw badRequest(`clinical_type=${clinicalType} requires at least 2 teeth`);
  }

  // 4. Snapshots de prix / durée / TVA.
  let priceSnapshot: Prisma.Decimal | null = null;
  let durationSnapshot: number | null = null;
  let vatRateSnapshot: number | null = null;
  if (catalogItem !== null) {
    const price = computePriceSnapshot(
      {
        default_price: catalogItem.default_price,
        pricing_strategy: catalogItem.pricing_strategy,
        surface_prices: catalogItem.surface_prices,
        pricing_config: catalogItem.pricing_config,
      },
      pricingTeeth(teethInputs),
    );
    priceSnapshot = priceDecimal(price);
    durationSnapshot = computeDurationSnapshot(
      {
        default_duration_minutes: catalogItem.default_duration_minutes,
        pricing_strategy: catalogItem.pricing_strategy,
      },
      teethInputs.length,
    );
    if (catalogItem.vat_types !== null) vatRateSnapshot = catalogItem.vat_types.rate;
  }

  const isPerformed = params.status === 'performed';
  const treatmentId = crypto.randomUUID();

  await prisma.$transaction(async (tx) => {
    await tx.treatments.create({
      data: {
        id: treatmentId,
        clinic_id: clinicId,
        patient_id: patientId,
        clinical_type: clinicalType,
        scope: params.scope,
        arch: params.arch,
        catalog_item_id: catalogItem?.id ?? null,
        status: params.status,
        recorded_at: now,
        performed_at: isPerformed ? now : null,
        performed_by: isPerformed ? userId : null,
        price_snapshot: priceSnapshot,
        duration_snapshot: durationSnapshot,
        vat_rate_snapshot: vatRateSnapshot,
        budget_item_id: params.budgetItemId,
        notes: params.notes,
        source_module: params.sourceModule,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      },
    });

    for (const tooth of teethInputs) {
      const record = await getOrCreateToothRecord(
        tx,
        clinicId,
        patientId,
        tooth.tooth_number,
        userId,
      );
      await tx.treatment_teeth.create({
        data: {
          id: crypto.randomUUID(),
          treatment_id: treatmentId,
          tooth_record_id: record.id,
          tooth_number: tooth.tooth_number,
          role: tooth.role ?? null,
          surfaces: tooth.surfaces ? toJson(tooth.surfaces) : Prisma.DbNull,
          created_at: now,
          updated_at: now,
        },
      });
    }
  });

  publish('odontogram.treatment.added', {
    clinic_id: clinicId,
    patient_id: patientId,
    treatment_id: treatmentId,
    clinical_type: clinicalType,
    catalog_item_id: catalogItem?.id ?? null,
    status: params.status,
    tooth_numbers: teethInputs.map((tooth) => tooth.tooth_number),
    budget_item_id: params.budgetItemId,
    source_module: params.sourceModule,
    created_by: userId,
    created_at: now.toISOString(),
  });

  const created = await getTreatment(clinicId, treatmentId);
  if (!created) throw notFound('Treatment not found');
  return created;
}

export interface TreatmentUpdateParams {
  status?: string | null;
  notes?: string | null;
  surfaces?: readonly string[] | null;
}

export async function updateTreatment(
  clinicId: string,
  treatmentId: string,
  userId: string,
  params: TreatmentUpdateParams,
): Promise<TreatmentDto | null> {
  const current = await prisma.treatments.findFirst({
    where: { clinic_id: clinicId, id: treatmentId, deleted_at: null },
    include: treatmentInclude,
  });
  if (!current) return null;

  const now = new Date();
  const data: Prisma.treatmentsUncheckedUpdateInput = { updated_at: now };

  if (params.status !== null && params.status !== undefined && params.status !== current.status) {
    data.status = params.status;
    if (params.status === 'performed') {
      data.performed_at = now;
      data.performed_by = userId;
    }
    publish('odontogram.treatment.status_changed', {
      clinic_id: clinicId,
      patient_id: current.patient_id,
      treatment_id: treatmentId,
      clinical_type: current.clinical_type,
      old_status: current.status,
      new_status: params.status,
      budget_item_id: current.budget_item_id,
      changed_by: userId,
    });
  }

  if (params.notes !== null && params.notes !== undefined) data.notes = params.notes;

  const surfaces = params.surfaces ?? null;
  if (surfaces !== null) {
    const catalog = current.treatment_catalog_items;
    const teeth = current.treatment_teeth.map((tooth) => ({
      role: tooth.role,
      tooth_number: tooth.tooth_number,
      surfaces: [...surfaces],
    }));
    if (catalog !== null) {
      const price = computePriceSnapshot(
        {
          default_price: catalog.default_price,
          pricing_strategy: catalog.pricing_strategy,
          surface_prices: catalog.surface_prices,
          pricing_config: catalog.pricing_config,
        },
        pricingTeeth(teeth),
      );
      data.price_snapshot = priceDecimal(price);
      data.duration_snapshot = computeDurationSnapshot(
        {
          default_duration_minutes: catalog.default_duration_minutes,
          pricing_strategy: catalog.pricing_strategy,
        },
        teeth.length,
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.treatments.update({ where: { id: treatmentId }, data });
    if (surfaces !== null) {
      await tx.treatment_teeth.updateMany({
        where: { treatment_id: treatmentId },
        data: { surfaces: toJson(surfaces), updated_at: now },
      });
    }
  });

  return getTreatment(clinicId, treatmentId);
}

export async function performTreatment(
  clinicId: string,
  treatmentId: string,
  userId: string,
  notes: string | null,
  publishPrice = true,
): Promise<TreatmentDto | null> {
  const current = await prisma.treatments.findFirst({
    where: { clinic_id: clinicId, id: treatmentId, deleted_at: null },
    include: treatmentInclude,
  });
  if (!current) return null;

  const now = new Date();
  const data: Prisma.treatmentsUncheckedUpdateInput = {
    status: 'performed',
    performed_at: now,
    performed_by: userId,
    updated_at: now,
  };
  if (notes) data.notes = notes;

  await prisma.treatments.update({ where: { id: treatmentId }, data });

  const names = asRecord(current.treatment_catalog_items?.names);
  const preferred = names.es ?? names.en;
  const treatmentName = current.treatment_catalog_items
    ? (typeof preferred === 'string' ? preferred : null)
    : null;
  const unitPrice =
    publishPrice && current.price_snapshot !== null
      ? new Prisma.Decimal(current.price_snapshot)
          .mul(current.treatment_teeth.length || 1)
          .toString()
      : null;

  publish('odontogram.treatment.performed', {
    clinic_id: clinicId,
    patient_id: current.patient_id,
    treatment_id: treatmentId,
    clinical_type: current.clinical_type,
    treatment_name: treatmentName,
    catalog_item_id: current.catalog_item_id,
    tooth_numbers: current.treatment_teeth.map((tooth) => tooth.tooth_number),
    budget_item_id: current.budget_item_id,
    performed_by: userId,
    performed_at: now.toISOString(),
    previous_status: current.status,
    unit_price: unitPrice,
  });

  return getTreatment(clinicId, treatmentId);
}

export async function deleteTreatment(
  clinicId: string,
  treatmentId: string,
  userId: string,
): Promise<boolean> {
  const current = await prisma.treatments.findFirst({
    where: { clinic_id: clinicId, id: treatmentId, deleted_at: null },
    include: treatmentInclude,
  });
  if (!current) return false;

  const now = new Date();
  await prisma.treatments.update({
    where: { id: treatmentId },
    data: { deleted_at: now, updated_at: now },
  });

  publish('odontogram.treatment.deleted', {
    clinic_id: clinicId,
    patient_id: current.patient_id,
    treatment_id: treatmentId,
    clinical_type: current.clinical_type,
    catalog_item_id: current.catalog_item_id,
    tooth_numbers: current.treatment_teeth.map((tooth) => tooth.tooth_number),
    budget_item_id: current.budget_item_id,
    deleted_by: userId,
  });
  return true;
}

/** Odontogramme complet (`GET /patients/:id/odontogram`). */
export async function getOdontogram(
  clinicId: string,
  patientId: string,
): Promise<OdontogramDto> {
  const teeth = await getPatientOdontogram(clinicId, patientId);
  const { rows } = await listPatientTreatments(clinicId, patientId, {
    page: 1,
    pageSize: 500,
  });
  return {
    patient_id: patientId,
    teeth: teeth.map(toToothRecordDto),
    treatments: rows,
    condition_colors: CONDITION_COLORS,
    available_conditions: [...TOOTH_CONDITIONS],
    surfaces: [...SURFACES],
  };
}
