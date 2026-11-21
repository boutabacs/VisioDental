import crypto from 'node:crypto';

import { Prisma, type appointments, type cabinets } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { parseClinicDate, toZonedIso } from '../../lib/time';
import {
  TERMINAL_STATUSES,
  transitionRefusal,
  type CabinetCreateInput,
  type CabinetUpdateInput,
} from './schemas';

const appointmentInclude = {
  patients: {
    select: { id: true, first_name: true, last_name: true, phone: true, email: true },
  },
  users_appointments_professional_idTousers: {
    select: { id: true, first_name: true, last_name: true },
  },
  appointment_treatments: {
    orderBy: { display_order: 'asc' },
    include: {
      treatment_catalog_items: true,
      planned_treatment_items: {
        include: {
          treatment_plans: true,
          treatments: {
            include: {
              treatment_teeth: true,
              treatment_catalog_items: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.appointmentsInclude;

type AppointmentWithRefs = Prisma.appointmentsGetPayload<{ include: typeof appointmentInclude }>;

export interface AppointmentDto {
  id: string;
  clinic_id: string;
  patient_id: string | null;
  professional_id: string;
  cabinet: string | null;
  cabinet_id: string | null;
  cabinet_assigned_at: string | null;
  cabinet_assigned_by: string | null;
  start_time: string;
  end_time: string;
  treatment_type: string | null;
  status: string;
  current_status_since: string;
  color: string | null;
  created_at: string;
  updated_at: string;
  patient: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string | null;
    email: string | null;
  } | null;
  professional: { id: string; first_name: string; last_name: string } | null;
  treatments: AppointmentTreatmentDto[];
  history: AppointmentStatusEventDto[] | null;
  cabinet_history: CabinetEventDto[] | null;
}

export interface AppointmentTreatmentDto {
  id: string;
  planned_item_id: string;
  planned_item_status: string;
  catalog_item_id: string | null;
  internal_code: string;
  names: Record<string, string>;
  default_price: number | null;
  default_duration_minutes: number | null;
  tooth_number: number | null;
  surfaces: string[] | null;
  is_global: boolean;
  plan_id: string | null;
  plan_number: string | null;
  completed_in_appointment: boolean;
}

export interface AppointmentStatusEventDto {
  id: string;
  from_status: string | null;
  to_status: string;
  changed_at: string;
  changed_by: string | null;
  changed_by_name: string | null;
  note: string | null;
}

export interface CabinetEventDto {
  id: string;
  from_cabinet_id: string | null;
  from_cabinet_name: string | null;
  to_cabinet_id: string | null;
  to_cabinet_name: string | null;
  changed_at: string;
  changed_by: string | null;
  changed_by_name: string | null;
  note: string | null;
}

export interface CabinetDto {
  id: string;
  clinic_id: string;
  name: string;
  color: string;
  display_order: number;
  is_active: boolean;
}

export function toCabinetDto(cabinet: cabinets): CabinetDto {
  return {
    id: cabinet.id,
    clinic_id: cabinet.clinic_id,
    name: cabinet.name,
    color: cabinet.color,
    display_order: cabinet.display_order,
    is_active: cabinet.is_active,
  };
}

function toTreatmentDto(
  row: AppointmentWithRefs['appointment_treatments'][number],
): AppointmentTreatmentDto {
  const planned = row.planned_treatment_items;
  const treatment = planned?.treatments ?? null;
  const catalog = row.treatment_catalog_items ?? treatment?.treatment_catalog_items ?? null;
  const teeth = treatment?.treatment_teeth ?? [];
  const primary = teeth[0] ?? null;

  let price: number | null = null;
  if (treatment?.price_snapshot !== null && treatment?.price_snapshot !== undefined) {
    price = Number(treatment.price_snapshot);
  } else if (catalog?.default_price !== null && catalog?.default_price !== undefined) {
    price = Number(catalog.default_price);
  }

  return {
    id: row.id,
    planned_item_id: row.planned_treatment_item_id,
    planned_item_status: planned?.status ?? 'pending',
    catalog_item_id: catalog?.id ?? null,
    internal_code: catalog?.internal_code ?? '',
    names: (catalog?.names as Record<string, string> | null) ?? {},
    default_price: price,
    default_duration_minutes: catalog?.default_duration_minutes ?? null,
    tooth_number: primary?.tooth_number ?? null,
    surfaces: (primary?.surfaces as string[] | null) ?? null,
    is_global: teeth.length === 0,
    plan_id: planned?.treatment_plan_id ?? null,
    plan_number: planned?.treatment_plans?.plan_number ?? null,
    completed_in_appointment: row.completed_in_appointment,
  };
}

export function toAppointmentDto(
  appointment: AppointmentWithRefs,
  timeZone: string,
  history: AppointmentStatusEventDto[] | null = null,
  cabinetHistory: CabinetEventDto[] | null = null,
): AppointmentDto {
  const professional = appointment.users_appointments_professional_idTousers;
  return {
    id: appointment.id,
    clinic_id: appointment.clinic_id,
    patient_id: appointment.patient_id,
    professional_id: appointment.professional_id,
    cabinet: appointment.cabinet,
    cabinet_id: appointment.cabinet_id,
    cabinet_assigned_at: appointment.cabinet_assigned_at?.toISOString() ?? null,
    cabinet_assigned_by: appointment.cabinet_assigned_by,
    start_time: toZonedIso(appointment.start_time, timeZone),
    end_time: toZonedIso(appointment.end_time, timeZone),
    treatment_type: appointment.treatment_type,
    status: appointment.status,
    current_status_since: appointment.current_status_since.toISOString(),
    color: appointment.color,
    created_at: appointment.created_at.toISOString(),
    updated_at: appointment.updated_at.toISOString(),
    patient: appointment.patients
      ? {
          id: appointment.patients.id,
          first_name: appointment.patients.first_name,
          last_name: appointment.patients.last_name,
          phone: appointment.patients.phone,
          email: appointment.patients.email,
        }
      : null,
    professional: professional
      ? {
          id: professional.id,
          first_name: professional.first_name,
          last_name: professional.last_name,
        }
      : null,
    treatments: appointment.appointment_treatments.map(toTreatmentDto),
    history,
    cabinet_history: cabinetHistory,
  };
}

export interface AppointmentListFilters {
  startDate?: string | null;
  endDate?: string | null;
  cabinet?: string | null;
  professionalId?: string | null;
  patientId?: string | null;
  status?: string | null;
  page: number;
  pageSize: number;
  order: 'asc' | 'desc';
}

export async function listAppointments(
  clinicId: string,
  timeZone: string,
  filters: AppointmentListFilters,
): Promise<{ rows: AppointmentDto[]; total: number }> {
  const where: Prisma.appointmentsWhereInput = { clinic_id: clinicId };

  if (filters.startDate) {
    where.start_time = { gte: parseClinicDate(filters.startDate, timeZone) };
  }
  if (filters.endDate) {
    where.start_time = { ...(where.start_time as object), lte: parseClinicDate(filters.endDate, timeZone) };
  }
  if (filters.cabinet) where.cabinet = filters.cabinet;
  if (filters.professionalId) where.professional_id = filters.professionalId;
  if (filters.patientId) where.patient_id = filters.patientId;
  if (filters.status) where.status = filters.status;

  const [rows, total] = await Promise.all([
    prisma.appointments.findMany({
      where,
      include: appointmentInclude,
      orderBy: [{ start_time: filters.order }, { id: 'asc' }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.appointments.count({ where }),
  ]);

  return { rows: rows.map((row) => toAppointmentDto(row, timeZone)), total };
}

export async function getAppointment(
  clinicId: string,
  appointmentId: string,
): Promise<AppointmentWithRefs | null> {
  return prisma.appointments.findFirst({
    where: { id: appointmentId, clinic_id: clinicId },
    include: appointmentInclude,
  });
}

export async function listStatusEvents(
  clinicId: string,
  appointmentId: string,
): Promise<AppointmentStatusEventDto[]> {
  const rows = await prisma.appointment_status_events.findMany({
    where: { appointment_id: appointmentId, clinic_id: clinicId },
    orderBy: { changed_at: 'asc' },
    include: { users: { select: { first_name: true, last_name: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    from_status: row.from_status,
    to_status: row.to_status,
    changed_at: row.changed_at.toISOString(),
    changed_by: row.changed_by,
    changed_by_name: row.users
      ? `${row.users.first_name} ${row.users.last_name}`.trim()
      : null,
    note: row.note,
  }));
}

export async function listCabinetEvents(
  clinicId: string,
  appointmentId: string,
): Promise<CabinetEventDto[]> {
  const rows = await prisma.appointment_cabinet_events.findMany({
    where: { appointment_id: appointmentId, clinic_id: clinicId },
    orderBy: { changed_at: 'asc' },
    include: {
      users: { select: { first_name: true, last_name: true } },
      cabinets_appointment_cabinet_events_from_cabinet_idTocabinets: { select: { name: true } },
      cabinets_appointment_cabinet_events_to_cabinet_idTocabinets: { select: { name: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    from_cabinet_id: row.from_cabinet_id,
    from_cabinet_name:
      row.cabinets_appointment_cabinet_events_from_cabinet_idTocabinets?.name ?? null,
    to_cabinet_id: row.to_cabinet_id,
    to_cabinet_name:
      row.cabinets_appointment_cabinet_events_to_cabinet_idTocabinets?.name ?? null,
    changed_at: row.changed_at.toISOString(),
    changed_by: row.changed_by,
    changed_by_name: row.users
      ? `${row.users.first_name} ${row.users.last_name}`.trim()
      : null,
    note: row.note,
  }));
}

export async function validatePatientAccess(
  clinicId: string,
  patientId: string,
): Promise<boolean> {
  const patient = await prisma.patients.findFirst({
    where: { id: patientId, clinic_id: clinicId, status: { not: 'archived' } },
    select: { id: true },
  });
  return patient !== null;
}

export async function validateProfessionalAccess(
  clinicId: string,
  professionalId: string,
): Promise<boolean> {
  const membership = await prisma.clinic_memberships.findFirst({
    where: {
      user_id: professionalId,
      clinic_id: clinicId,
      is_professional: true,
      users: { is_active: true },
    },
    select: { id: true },
  });
  return membership !== null;
}

async function resolveCabinet(
  clinicId: string,
  cabinetId: string | null | undefined,
  cabinetName: string | null | undefined,
): Promise<cabinets | null> {
  if (cabinetId) {
    const cabinet = await prisma.cabinets.findFirst({
      where: { id: cabinetId, clinic_id: clinicId },
    });
    if (!cabinet) throw badRequest(`Cabinet not found: ${cabinetId}`);
    return cabinet;
  }
  if (cabinetName) {
    const cabinet = await prisma.cabinets.findFirst({
      where: { clinic_id: clinicId, name: cabinetName },
    });
    if (!cabinet) throw badRequest(`Cabinet not found: ${cabinetName}`);
    return cabinet;
  }
  return null;
}

async function assertSlotFree(
  clinicId: string,
  professionalId: string,
  cabinetId: string | null,
  startTime: Date,
  excludeId?: string,
): Promise<void> {
  // Index unique partiel (clinic, cabinet, professionnel, start_time) :
  // NULL de cabinet ne bloque rien, comme PostgreSQL.
  if (!cabinetId) return;
  const clash = await prisma.appointments.findFirst({
    where: {
      clinic_id: clinicId,
      professional_id: professionalId,
      cabinet_id: cabinetId,
      start_time: startTime,
      status: { notIn: TERMINAL_STATUSES },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw conflict('Time slot is already occupied');
}

function parseTime(value: string, timeZone: string, field: string): Date {
  const date = parseClinicDate(value, timeZone);
  if (Number.isNaN(date.getTime())) throw badRequest(`Invalid ${field}`);
  return date;
}

export interface CreateAppointmentOptions {
  patientId?: string | null;
  professionalId: string;
  cabinetId?: string | null;
  cabinet?: string | null;
  startTime: string;
  endTime: string;
  treatmentType?: string | null;
  color?: string | null;
  plannedItemIds?: string[] | null;
}

interface PlannedItemInfo {
  id: string;
  clinicId: string;
  patientId: string;
  planStatus: string;
  status: string;
  catalogItemId: string | null;
}

async function loadPlannedItems(ids: string[]): Promise<Map<string, PlannedItemInfo>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.planned_treatment_items.findMany({
    where: { id: { in: ids } },
    include: {
      treatment_plans: true,
      treatments: { select: { catalog_item_id: true } },
    },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        clinicId: row.clinic_id,
        patientId: row.treatment_plans.patient_id,
        planStatus: row.treatment_plans.status,
        status: row.status,
        catalogItemId: row.treatments?.catalog_item_id ?? null,
      },
    ]),
  );
}

/** Miroir de `validate_bookable_items` (traitement planifié réservable). */
function assertBookable(
  items: Map<string, PlannedItemInfo>,
  clinicId: string,
  patientId: string,
  ids: string[],
): void {
  const errors: string[] = [];
  for (const id of ids) {
    const item = items.get(id);
    if (!item || item.clinicId !== clinicId) {
      errors.push(`Treatment item ${id} not found`);
      continue;
    }
    if (item.patientId !== patientId) {
      errors.push(`Treatment item ${id} does not belong to patient`);
      continue;
    }
    if (!['active', 'draft', 'pending'].includes(item.planStatus)) {
      errors.push(`Treatment item ${id} belongs to ${item.planStatus} plan`);
      continue;
    }
    if (item.status !== 'pending') {
      errors.push(`Treatment item ${id} is already ${item.status}`);
    }
  }
  if (errors.length > 0) throw badRequest(errors.join('; '));
}

export async function createAppointment(
  clinicId: string,
  userId: string,
  timeZone: string,
  input: CreateAppointmentOptions,
): Promise<AppointmentWithRefs> {
  const start = parseTime(input.startTime, timeZone, 'start_time');
  const end = parseTime(input.endTime, timeZone, 'end_time');
  if (end <= start) throw badRequest('end_time must be after start_time');

  const cabinet = await resolveCabinet(clinicId, input.cabinetId, input.cabinet);
  await assertSlotFree(clinicId, input.professionalId, cabinet?.id ?? null, start);

  const plannedIds = input.plannedItemIds ?? [];
  const plannedItems =
    plannedIds.length > 0 && input.patientId
      ? await loadPlannedItems(plannedIds)
      : new Map<string, PlannedItemInfo>();
  if (plannedIds.length > 0 && input.patientId) {
    assertBookable(plannedItems, clinicId, input.patientId, plannedIds);
  }

  const now = new Date();
  const appointmentId = crypto.randomUUID();

  try {
    await prisma.$transaction(async (tx) => {
      await tx.appointments.create({
        data: {
          id: appointmentId,
          clinic_id: clinicId,
          patient_id: input.patientId ?? null,
          professional_id: input.professionalId,
          cabinet: cabinet?.name ?? null,
          cabinet_id: cabinet?.id ?? null,
          start_time: start,
          end_time: end,
          treatment_type: input.treatmentType ?? null,
          status: 'scheduled',
          color: input.color ?? null,
          current_status_since: now,
          cabinet_assigned_at: cabinet ? now : null,
          cabinet_assigned_by: cabinet ? userId : null,
          created_at: now,
          updated_at: now,
        },
      });

      await tx.appointment_status_events.create({
        data: {
          id: crypto.randomUUID(),
          clinic_id: clinicId,
          appointment_id: appointmentId,
          from_status: null,
          to_status: 'scheduled',
          changed_at: now,
          changed_by: userId,
        },
      });

      if (cabinet) {
        await tx.appointment_cabinet_events.create({
          data: {
            id: crypto.randomUUID(),
            clinic_id: clinicId,
            appointment_id: appointmentId,
            from_cabinet_id: null,
            to_cabinet_id: cabinet.id,
            changed_at: now,
            changed_by: userId,
          },
        });
      }

      for (const [order, plannedItemId] of plannedIds.entries()) {
        await tx.appointment_treatments.create({
          data: {
            id: crypto.randomUUID(),
            appointment_id: appointmentId,
            planned_treatment_item_id: plannedItemId,
            catalog_item_id: plannedItems.get(plannedItemId)?.catalogItemId ?? null,
            display_order: order,
            completed_in_appointment: false,
            created_at: now,
          },
        });
      }
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && (error.code === 'P2002' || error.message.includes('idx_appointment_slot'))
    ) {
      throw conflict('Time slot is already occupied');
    }
    throw error;
  }

  const created = await getAppointment(clinicId, appointmentId);
  if (!created) throw notFound('Appointment not found');
  return created;
}

export interface UpdateAppointmentOptions {
  patientId?: string | null;
  professionalId?: string | null;
  cabinetId?: string | null;
  cabinet?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  treatmentType?: string | null;
  status?: string | null;
  color?: string | null;
  plannedItemIds?: string[] | null;
  cabinetTouched: boolean;
}

export async function updateAppointment(
  appointment: AppointmentWithRefs,
  timeZone: string,
  userId: string,
  input: UpdateAppointmentOptions,
): Promise<AppointmentWithRefs> {
  const data: Prisma.appointmentsUncheckedUpdateInput = { updated_at: new Date() };
  let cabinetChange: cabinets | null | undefined;

  if (input.patientId) data.patient_id = input.patientId;
  if (input.professionalId) data.professional_id = input.professionalId;
  if (input.startTime) data.start_time = parseTime(input.startTime, timeZone, 'start_time');
  if (input.endTime) data.end_time = parseTime(input.endTime, timeZone, 'end_time');
  if (input.treatmentType) data.treatment_type = input.treatmentType;
  if (input.color) data.color = input.color;

  if (input.cabinetTouched) {
    cabinetChange = await resolveCabinet(
      appointment.clinic_id,
      input.cabinetId,
      input.cabinet,
    );
    data.cabinet = cabinetChange?.name ?? null;
    data.cabinet_id = cabinetChange?.id ?? null;
    if (cabinetChange) {
      data.cabinet_assigned_at = new Date();
      data.cabinet_assigned_by = userId;
    }
  }

  const nextStart = (data.start_time as Date | undefined) ?? appointment.start_time;
  const nextEnd = (data.end_time as Date | undefined) ?? appointment.end_time;
  if (nextEnd <= nextStart) throw badRequest('end_time must be after start_time');

  const nextProfessional =
    input.professionalId ?? appointment.professional_id;
  const nextCabinetId =
    input.cabinetTouched
      ? cabinetChange?.id ?? null
      : appointment.cabinet_id;
  await assertSlotFree(
    appointment.clinic_id,
    nextProfessional,
    nextCabinetId,
    nextStart,
    appointment.id,
  );

  const plannedIds = Array.isArray(input.plannedItemIds) ? input.plannedItemIds : null;
  let plannedItems = new Map<string, PlannedItemInfo>();
  if (plannedIds && plannedIds.length > 0) {
    const patientId = input.patientId ?? appointment.patient_id;
    if (patientId) {
      plannedItems = await loadPlannedItems(plannedIds);
      assertBookable(plannedItems, appointment.clinic_id, patientId, plannedIds);
    }
  }

  const cabinetChanged =
    input.cabinetTouched && (cabinetChange?.id ?? null) !== appointment.cabinet_id;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.appointments.update({ where: { id: appointment.id }, data });

      if (cabinetChanged) {
        await tx.appointment_cabinet_events.create({
          data: {
            id: crypto.randomUUID(),
            clinic_id: appointment.clinic_id,
            appointment_id: appointment.id,
            from_cabinet_id: appointment.cabinet_id,
            to_cabinet_id: cabinetChange?.id ?? null,
            changed_at: new Date(),
            changed_by: userId,
          },
        });
      }

      if (plannedIds) {
        await tx.appointment_treatments.deleteMany({
          where: { appointment_id: appointment.id },
        });
        for (const [order, plannedItemId] of plannedIds.entries()) {
          await tx.appointment_treatments.create({
            data: {
              id: crypto.randomUUID(),
              appointment_id: appointment.id,
              planned_treatment_item_id: plannedItemId,
              catalog_item_id: plannedItems.get(plannedItemId)?.catalogItemId ?? null,
              display_order: order,
              completed_in_appointment: false,
            },
          });
        }
      }
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError
      && (error.code === 'P2002' || error.message.includes('idx_appointment_slot'))
    ) {
      throw conflict('Time slot is already occupied');
    }
    throw error;
  }

  let result = await getAppointment(appointment.clinic_id, appointment.id);
  if (!result) throw notFound('Appointment not found');

  if (input.status && input.status !== result.status) {
    result = await transitionAppointment(result, input.status, userId);
  }

  return result;
}

export async function transitionAppointment(
  appointment: AppointmentWithRefs,
  toStatus: string,
  userId: string | null,
  note?: string | null,
): Promise<AppointmentWithRefs> {
  const fromStatus = appointment.status;
  const refusal = transitionRefusal(fromStatus, toStatus, Boolean(appointment.cabinet_id));
  if (refusal) throw badRequest(refusal);

  const now = new Date();
  await prisma.$transaction([
    prisma.appointments.update({
      where: { id: appointment.id },
      data: { status: toStatus, current_status_since: now, updated_at: now },
    }),
    prisma.appointment_status_events.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: appointment.clinic_id,
        appointment_id: appointment.id,
        from_status: fromStatus,
        to_status: toStatus,
        changed_at: now,
        changed_by: userId,
        note: note ?? null,
      },
    }),
  ]);

  const result = await getAppointment(appointment.clinic_id, appointment.id);
  if (!result) throw notFound('Appointment not found');
  return result;
}

export async function cancelAppointment(
  appointment: AppointmentWithRefs,
  userId: string,
): Promise<void> {
  if (appointment.status === 'cancelled') return;
  await transitionAppointment(appointment, 'cancelled', userId);
}

export async function assignCabinet(
  appointment: AppointmentWithRefs,
  clinicId: string,
  userId: string,
  cabinetId: string | null,
  note?: string | null,
): Promise<AppointmentWithRefs> {
  const cabinet = cabinetId
    ? await prisma.cabinets.findFirst({ where: { id: cabinetId, clinic_id: clinicId } })
    : null;
  if (cabinetId && !cabinet) throw badRequest(`Cabinet not found: ${cabinetId}`);
  if ((cabinet?.id ?? null) === appointment.cabinet_id) return appointment;

  const now = new Date();
  await prisma.$transaction([
    prisma.appointments.update({
      where: { id: appointment.id },
      data: {
        cabinet: cabinet?.name ?? null,
        cabinet_id: cabinet?.id ?? null,
        cabinet_assigned_at: cabinet ? now : null,
        cabinet_assigned_by: cabinet ? userId : null,
        updated_at: now,
      },
    }),
    prisma.appointment_cabinet_events.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: appointment.clinic_id,
        appointment_id: appointment.id,
        from_cabinet_id: appointment.cabinet_id,
        to_cabinet_id: cabinet?.id ?? null,
        changed_at: now,
        changed_by: userId,
        note: note ?? null,
      },
    }),
  ]);

  const result = await getAppointment(clinicId, appointment.id);
  if (!result) throw notFound('Appointment not found');
  return result;
}

// ---------------------------------------------------------------------------
// Cabinets
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Note clinique au niveau de la visite (AppointmentTreatment.notes)
// ---------------------------------------------------------------------------

export interface AppointmentTreatmentNoteDto {
  id: string;
  appointment_id: string;
  planned_treatment_item_id: string | null;
  catalog_item_id: string | null;
  display_order: number;
  completed_in_appointment: boolean;
  notes: string | null;
  created_at: string;
}

/**
 * Met à jour la note clinique liée à une visite.
 *
 * La ligne appartient au module `treatment_plan` côté Python ; on y
 * accède directement ici (même table) après vérification du tenant.
 * Renvoie `null` si la ligne n'existe pas dans cette clinique.
 */
export async function updateAppointmentTreatmentNote(
  clinicId: string,
  appointmentTreatmentId: string,
  input: { notes?: string | null; completed_in_appointment?: boolean | null },
): Promise<AppointmentTreatmentNoteDto | null> {
  const row = await prisma.appointment_treatments.findFirst({
    where: {
      id: appointmentTreatmentId,
      appointments: { clinic_id: clinicId },
    },
  });
  if (!row) return null;

  const data: Prisma.appointment_treatmentsUpdateInput = {};
  // Python ignore explicitement `null` (= pas de changement) pour ces
  // deux champs : on reproduit ce comportement.
  if (input.notes !== undefined && input.notes !== null) data.notes = input.notes;
  if (input.completed_in_appointment !== undefined && input.completed_in_appointment !== null) {
    data.completed_in_appointment = input.completed_in_appointment;
  }

  const updated =
    Object.keys(data).length > 0
      ? await prisma.appointment_treatments.update({
          where: { id: row.id },
          data,
        })
      : row;

  return {
    id: updated.id,
    appointment_id: updated.appointment_id,
    planned_treatment_item_id: updated.planned_treatment_item_id,
    catalog_item_id: updated.catalog_item_id,
    display_order: updated.display_order,
    completed_in_appointment: updated.completed_in_appointment,
    notes: updated.notes,
    created_at: updated.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Check-in public (QR, ADR 0037)
// ---------------------------------------------------------------------------

export const CHECKIN_WINDOW_BEFORE_MINUTES = 120;
export const CHECKIN_WINDOW_AFTER_MINUTES = 60;

/** Fenêtre de check-in dépassée (code `too_early` / `window_closed`). */
export class CheckinWindowError extends Error {
  constructor(
    public readonly code: 'too_early' | 'window_closed',
    public readonly localStart: string,
  ) {
    super(code);
    this.name = 'CheckinWindowError';
  }
}

/**
 * Consomme un jeton de check-in : résout, vérifie la fenêtre, transitionne.
 *
 * - rendez-vous déjà `checked_in` → idempotent (pas d'erreur) ;
 * - inconnu dans la clinique → `KeyError`-équivalent via `null` ?
 *   On lève `CheckinAppointmentNotFound` pour laisser le routeur répondre 404 ;
 * - hors fenêtre → `CheckinWindowError` ;
 * - transition refusée → l'erreur remonte (le routeur la traduit en 422).
 */
export class CheckinAppointmentNotFound extends Error {
  constructor() {
    super('Appointment not found');
    this.name = 'CheckinAppointmentNotFound';
  }
}

export async function publicCheckin(
  appointmentId: string,
  clinicId: string,
): Promise<{ id: string; status: string }> {
  const row = await prisma.appointments.findFirst({
    where: { id: appointmentId, clinic_id: clinicId },
  });
  if (!row) throw new CheckinAppointmentNotFound();

  const clinic = await prisma.clinics.findUnique({
    where: { id: clinicId },
    select: { timezone: true },
  });
  const timeZone = clinic?.timezone ?? 'UTC';

  const now = new Date();
  const opensAt = new Date(row.start_time.getTime() - CHECKIN_WINDOW_BEFORE_MINUTES * 60_000);
  const closesAt = new Date(row.end_time.getTime() + CHECKIN_WINDOW_AFTER_MINUTES * 60_000);
  if (now < opensAt || now > closesAt) {
    const localStart = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(row.start_time);
    throw new CheckinWindowError(now < opensAt ? 'too_early' : 'window_closed', localStart);
  }

  if (row.status !== 'checked_in') {
    const current = await getAppointment(clinicId, appointmentId);
    if (!current) throw new CheckinAppointmentNotFound();
    try {
      await transitionAppointment(current, 'checked_in', null, 'kiosk-checkin');
    } catch (error) {
      // Re-scan d'un rendez-vous déjà enregistré : idempotent.
      if (
        error instanceof Error &&
        error.message.includes("already in status 'checked_in'")
      ) {
        return { id: row.id, status: 'checked_in' };
      }
      throw error;
    }
    return { id: row.id, status: 'checked_in' };
  }
  return { id: row.id, status: row.status };
}

export async function listCabinets(clinicId: string): Promise<cabinets[]> {
  return prisma.cabinets.findMany({
    where: { clinic_id: clinicId },
    orderBy: [{ display_order: 'asc' }, { name: 'asc' }],
  });
}

export async function getCabinet(
  clinicId: string,
  cabinetId: string,
): Promise<cabinets | null> {
  return prisma.cabinets.findFirst({ where: { id: cabinetId, clinic_id: clinicId } });
}

export async function createCabinet(
  clinicId: string,
  input: CabinetCreateInput,
): Promise<cabinets> {
  const existing = await prisma.cabinets.findFirst({
    where: { clinic_id: clinicId, name: input.name },
    select: { id: true },
  });
  if (existing) throw conflict('Cabinet name already exists');

  let displayOrder = input.display_order ?? null;
  if (displayOrder === null) {
    const max = await prisma.cabinets.aggregate({
      where: { clinic_id: clinicId },
      _max: { display_order: true },
    });
    displayOrder = (max._max.display_order ?? -1) + 1;
  }

  const now = new Date();
  return prisma.cabinets.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: clinicId,
      name: input.name,
      color: input.color,
      display_order: displayOrder,
      is_active: input.is_active ?? true,
      created_at: now,
      updated_at: now,
    },
  });
}

export async function updateCabinet(
  cabinet: cabinets,
  input: CabinetUpdateInput,
): Promise<cabinets> {
  if (input.name && input.name !== cabinet.name) {
    const clash = await prisma.cabinets.findFirst({
      where: { clinic_id: cabinet.clinic_id, name: input.name, id: { not: cabinet.id } },
      select: { id: true },
    });
    if (clash) throw conflict('Cabinet name already exists');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.cabinets.update({
      where: { id: cabinet.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.display_order !== undefined && input.display_order !== null
          ? { display_order: input.display_order }
          : {}),
        ...(input.is_active !== undefined && input.is_active !== null
          ? { is_active: input.is_active }
          : {}),
        updated_at: new Date(),
      },
    });

    if (input.name && input.name !== cabinet.name) {
      // Garde le nom dénormalisé des rendez-vous synchronisé.
      await tx.appointments.updateMany({
        where: { clinic_id: cabinet.clinic_id, cabinet_id: cabinet.id },
        data: { cabinet: result.name },
      });
    }
    return result;
  });

  return updated;
}

export async function deleteCabinet(cabinet: cabinets): Promise<void> {
  const inUse = await prisma.appointments.count({
    where: { cabinet_id: cabinet.id, status: { not: 'cancelled' } },
  });
  if (inUse > 0) throw conflict(`Cabinet has ${inUse} active appointments`);

  const hasEvents = await prisma.appointment_cabinet_events.findFirst({
    where: {
      OR: [
        { from_cabinet_id: cabinet.id },
        { to_cabinet_id: cabinet.id },
      ],
    },
    select: { id: true },
  });
  if (hasEvents) throw conflict('Cabinet has appointment history; deactivate it instead');

  await prisma.cabinets.delete({ where: { id: cabinet.id } });
}

// Type utilitaire pour les tests éventuels.
export type { AppointmentWithRefs };
