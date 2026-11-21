import crypto from 'node:crypto';

import { Prisma, type patients } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { unprocessable } from '../../lib/errors';
import type {
  PatientCreateInput,
  PatientExtendedUpdateInput,
  PatientUpdateInput,
} from './schemas';

export interface PatientDto {
  id: string;
  clinic_id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  date_of_birth: string | null;
  notes: string | null;
  status: string;
  do_not_contact: boolean;
  billing_name: string | null;
  billing_tax_id: string | null;
  billing_address: unknown;
  billing_email: string | null;
  has_complete_billing_info: boolean;
  created_at: string;
  updated_at: string;
}

export interface PatientExtendedDto extends PatientDto {
  gender: string | null;
  national_id: string | null;
  national_id_type: string | null;
  profession: string | null;
  workplace: string | null;
  preferred_language: string;
  address: unknown;
  photo_url: string | null;
}

export interface PatientListFilters {
  search?: string | null;
  page: number;
  pageSize: number;
  patientIds?: string[] | null;
  city?: string | null;
  doNotContact?: boolean | null;
  includeArchived: boolean;
  statuses: string[];
  sort?: string | null;
}

function effectiveBillingTaxId(patient: patients): string | null {
  if (patient.billing_tax_id) return patient.billing_tax_id;
  if (patient.national_id && patient.national_id_type !== 'passport') {
    return patient.national_id;
  }
  return null;
}

export function toPatientDto(patient: patients): PatientDto {
  return {
    id: patient.id,
    clinic_id: patient.clinic_id,
    first_name: patient.first_name,
    last_name: patient.last_name,
    phone: patient.phone,
    email: patient.email,
    date_of_birth: patient.date_of_birth
      ? patient.date_of_birth.toISOString().slice(0, 10)
      : null,
    notes: patient.notes,
    status: patient.status,
    do_not_contact: patient.do_not_contact,
    billing_name: patient.billing_name,
    billing_tax_id: patient.billing_tax_id,
    billing_address: patient.billing_address,
    billing_email: patient.billing_email,
    has_complete_billing_info: Boolean(effectiveBillingTaxId(patient)),
    created_at: patient.created_at.toISOString(),
    updated_at: patient.updated_at.toISOString(),
  };
}

export function toPatientExtendedDto(patient: patients): PatientExtendedDto {
  return {
    ...toPatientDto(patient),
    gender: patient.gender,
    national_id: patient.national_id,
    national_id_type: patient.national_id_type,
    profession: patient.profession,
    workplace: patient.workplace,
    preferred_language: patient.preferred_language,
    address: patient.address,
    photo_url: patient.photo_url,
  };
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function buildSearchConditions(search: string): Prisma.patientsWhereInput[] {
  return search
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => ({
      OR: [
        { first_name: { contains: term, mode: 'insensitive' } },
        { last_name: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
        { national_id: { contains: term, mode: 'insensitive' } },
      ],
    }));
}

function buildWhere(clinicId: string, filters: PatientListFilters): Prisma.patientsWhereInput {
  const and: Prisma.patientsWhereInput[] = [{ clinic_id: clinicId }];

  const statuses = filters.statuses.filter(Boolean);
  if (statuses.length > 0) {
    and.push({ status: { in: statuses } });
  } else if (!filters.includeArchived) {
    and.push({ status: { not: 'archived' } });
  }

  if (filters.patientIds && filters.patientIds.length === 0) {
    // Ensemble d'intersection vide → aucun résultat.
    and.push({ id: { in: [] } });
  } else if (filters.patientIds && filters.patientIds.length > 0) {
    and.push({ id: { in: filters.patientIds } });
  }

  if (filters.city) {
    and.push({
      address: { path: ['city'], string_contains: filters.city },
    });
  }

  if (filters.doNotContact !== null && filters.doNotContact !== undefined) {
    and.push({ do_not_contact: filters.doNotContact });
  }

  if (filters.search) {
    and.push(...buildSearchConditions(filters.search));
  }

  return { AND: and };
}

const SORT_FIELDS = new Set(['last_name', 'first_name', 'created_at', 'updated_at']);

function parseSort(raw: string | null | undefined): { field: string; direction: 'asc' | 'desc' } {
  const value = (raw ?? 'last_visit:desc').trim();
  const [fieldRaw, directionRaw] = value.split(':');
  const field = (fieldRaw ?? '').trim();
  const direction = ((directionRaw ?? 'asc').trim().toLowerCase() || 'asc') as 'asc' | 'desc';

  if (field !== 'last_visit' && !SORT_FIELDS.has(field)) {
    throw unprocessable(
      `Invalid sort field '${field}'. Allowed: ['created_at', 'first_name', 'last_name', 'updated_at']`,
    );
  }
  if (direction !== 'asc' && direction !== 'desc') {
    throw unprocessable(`Invalid sort direction '${direction}'. Use 'asc' or 'desc'.`);
  }
  return { field, direction };
}

async function lastVisitByPatient(
  clinicId: string,
  patientIds: string[],
): Promise<Map<string, number>> {
  if (patientIds.length === 0) return new Map();
  const rows = await prisma.appointments.groupBy({
    by: ['patient_id'],
    where: {
      clinic_id: clinicId,
      patient_id: { in: patientIds, not: null },
      status: 'completed',
    },
    _max: { start_time: true },
  });
  const result = new Map<string, number>();
  for (const row of rows) {
    if (row.patient_id && row._max.start_time) {
      result.set(row.patient_id, row._max.start_time.getTime());
    }
  }
  return result;
}

export async function getRecentPatients(clinicId: string, limit: number): Promise<patients[]> {
  const visits = await prisma.appointments.groupBy({
    by: ['patient_id'],
    where: { clinic_id: clinicId, patient_id: { not: null }, status: 'completed' },
    _max: { start_time: true },
    orderBy: { _max: { start_time: 'desc' } },
    take: limit,
  });

  const orderedIds = visits
    .map((row) => row.patient_id)
    .filter((id): id is string => Boolean(id));

  if (orderedIds.length === 0) {
    return prisma.patients.findMany({
      where: { clinic_id: clinicId, status: { not: 'archived' } },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  const rows = await prisma.patients.findMany({
    where: {
      clinic_id: clinicId,
      id: { in: orderedIds },
      status: { not: 'archived' },
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return orderedIds.flatMap((id) => {
    const patient = byId.get(id);
    return patient ? [patient] : [];
  });
}

export async function listPatients(
  clinicId: string,
  filters: PatientListFilters,
): Promise<{ rows: patients[]; total: number }> {
  const where = buildWhere(clinicId, filters);
  const total = await prisma.patients.count({ where });
  const { field, direction } = parseSort(filters.sort);

  if (field === 'last_visit') {
    // MAX(start_time) d'un rendez-vous terminé : tri en mémoire, comme le
    // LEFT JOIN + NULLS LAST du backend Python.
    const all = await prisma.patients.findMany({ where });
    const visits = await lastVisitByPatient(
      clinicId,
      all.map((patient) => patient.id),
    );
    const dir = direction === 'desc' ? -1 : 1;
    all.sort((a, b) => {
      const visitA = visits.get(a.id) ?? null;
      const visitB = visits.get(b.id) ?? null;
      if (visitA === null && visitB === null) return 0;
      // NULLS LAST dans les deux directions (comportement PostgreSQL).
      if (visitA === null) return 1;
      if (visitB === null) return -1;
      if (visitA !== visitB) return (visitA - visitB) * dir;
      return (
        a.last_name.localeCompare(b.last_name) ||
        a.first_name.localeCompare(b.first_name) ||
        a.id.localeCompare(b.id)
      );
    });
    const offset = (filters.page - 1) * filters.pageSize;
    return { rows: all.slice(offset, offset + filters.pageSize), total };
  }

  const orderBy: Prisma.patientsOrderByWithRelationInput[] = [
    { [field]: direction },
    { first_name: 'asc' },
    { id: 'asc' },
  ];

  const rows = await prisma.patients.findMany({
    where,
    orderBy,
    skip: (filters.page - 1) * filters.pageSize,
    take: filters.pageSize,
  });
  return { rows, total };
}

export async function getPatient(
  clinicId: string,
  patientId: string,
): Promise<patients | null> {
  return prisma.patients.findFirst({ where: { id: patientId, clinic_id: clinicId } });
}

export async function createPatient(
  clinicId: string,
  input: PatientCreateInput,
): Promise<patients> {
  const now = new Date();
  return prisma.patients.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: clinicId,
      first_name: input.first_name,
      last_name: input.last_name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      date_of_birth: input.date_of_birth ? parseDateOnly(input.date_of_birth) : null,
      notes: input.notes ?? null,
      status: 'active',
      gender: null,
      national_id: input.national_id ?? null,
      national_id_type: input.national_id_type ?? null,
      profession: null,
      workplace: null,
      preferred_language: 'es',
      address: Prisma.JsonNull,
      photo_url: null,
      billing_name: input.billing_name ?? null,
      billing_tax_id: input.billing_tax_id ?? null,
      billing_address: input.billing_address
        ? (input.billing_address as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      billing_email: input.billing_email ?? null,
      do_not_contact: input.do_not_contact,
      created_at: now,
      updated_at: now,
    },
  });
}

function updateData(
  input: PatientUpdateInput | PatientExtendedUpdateInput,
): Prisma.patientsUpdateInput {
  const data: Prisma.patientsUpdateInput = { updated_at: new Date() };

  if ('first_name' in input && input.first_name !== undefined) data.first_name = input.first_name;
  if ('last_name' in input && input.last_name !== undefined) data.last_name = input.last_name;
  if ('phone' in input && input.phone !== undefined) data.phone = input.phone;
  if ('email' in input && input.email !== undefined) data.email = input.email;
  if ('notes' in input && input.notes !== undefined) data.notes = input.notes;
  if ('do_not_contact' in input && input.do_not_contact !== undefined) {
    data.do_not_contact = input.do_not_contact;
  }
  if ('date_of_birth' in input && input.date_of_birth !== undefined) {
    data.date_of_birth = input.date_of_birth ? parseDateOnly(input.date_of_birth) : null;
  }
  if ('billing_name' in input && input.billing_name !== undefined) {
    data.billing_name = input.billing_name;
  }
  if ('billing_tax_id' in input && input.billing_tax_id !== undefined) {
    data.billing_tax_id = input.billing_tax_id;
  }
  if ('billing_email' in input && input.billing_email !== undefined) {
    data.billing_email = input.billing_email;
  }
  if ('billing_address' in input && input.billing_address !== undefined) {
    data.billing_address = input.billing_address
      ? (input.billing_address as Prisma.InputJsonValue)
      : Prisma.DbNull;
  }

  if ('gender' in input && input.gender !== undefined) data.gender = input.gender;
  if ('national_id' in input && input.national_id !== undefined) {
    data.national_id = input.national_id;
  }
  if ('national_id_type' in input && input.national_id_type !== undefined) {
    data.national_id_type = input.national_id_type;
  }
  if ('profession' in input && input.profession !== undefined) data.profession = input.profession;
  if ('workplace' in input && input.workplace !== undefined) data.workplace = input.workplace;
  if ('preferred_language' in input && input.preferred_language) {
    data.preferred_language = input.preferred_language;
  }
  if ('photo_url' in input && input.photo_url !== undefined) data.photo_url = input.photo_url;
  if ('address' in input && input.address !== undefined) {
    data.address = input.address
      ? (input.address as Prisma.InputJsonValue)
      : Prisma.DbNull;
  }

  return data;
}

export async function updatePatient(
  patient: patients,
  input: PatientUpdateInput | PatientExtendedUpdateInput,
): Promise<patients> {
  const data = updateData(input);
  const newStatus = 'status' in input ? input.status : undefined;

  if (newStatus && newStatus !== patient.status) {
    // `status` n'est pas nullable en base : null ne change rien.
    data.status = newStatus === 'archived' && patient.status !== 'archived'
      ? 'archived'
      : 'active';
  }

  return prisma.patients.update({ where: { id: patient.id }, data });
}

export async function archivePatient(patient: patients): Promise<patients> {
  return prisma.patients.update({
    where: { id: patient.id },
    data: { status: 'archived', updated_at: new Date() },
  });
}

export async function restorePatient(patient: patients): Promise<patients> {
  if (patient.status !== 'archived') return patient;
  return prisma.patients.update({
    where: { id: patient.id },
    data: { status: 'active', updated_at: new Date() },
  });
}
