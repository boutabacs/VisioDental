/**
 * Couche service `patients_clinical` — port de
 * `backend/app/modules/patients_clinical/service.py`.
 *
 * Sept tables (`patients_clinical_*`), deux vues dérivées :
 * - `buildMedicalHistory` : agrégat à la forme de l'ancien JSONB ;
 * - `computeAlerts` : ancienne propriété `Patient.active_alerts`.
 *
 * Toutes les écritures sont des soft-deletes (`status = "archived"`), jamais
 * de suppression physique — règle maison du backend Python.
 */

import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { toClinicDateString, toZonedIso } from '../../lib/time';
import type {
  AllergyCreateInput,
  AllergyUpdateInput,
  EmergencyContactUpsertInput,
  LegalGuardianUpsertInput,
  MedicalContextUpdateInput,
  MedicationCreateInput,
  MedicationUpdateInput,
  SurgicalHistoryCreateInput,
  SurgicalHistoryUpdateInput,
  SystemicDiseaseCreateInput,
  SystemicDiseaseUpdateInput,
} from './schemas';
import { MEDICAL_CONTEXT_FIELDS } from './schemas';

// ---------------------------------------------------------------------------
// DTOs — mêmes noms de champs que les schémas Pydantic (`*Response`)
// ---------------------------------------------------------------------------

export interface MedicalContextDto {
  is_pregnant: boolean;
  pregnancy_week: number | null;
  is_lactating: boolean;
  is_on_anticoagulants: boolean;
  anticoagulant_medication: string | null;
  inr_value: number | null;
  last_inr_date: string | null;
  is_smoker: boolean;
  smoking_frequency: string | null;
  alcohol_consumption: string | null;
  bruxism: boolean;
  adverse_reactions_to_anesthesia: boolean;
  anesthesia_reaction_details: string | null;
  last_updated_at: string | null;
  last_updated_by: string | null;
}

export interface AllergyDto {
  id: string;
  name: string;
  type: string | null;
  severity: string;
  reaction: string | null;
  notes: string | null;
  reference_id: string | null;
  status: string;
}

export interface MedicationDto {
  id: string;
  name: string;
  dosage: string | null;
  frequency: string | null;
  start_date: string | null;
  notes: string | null;
  reference_id: string | null;
  status: string;
}

export interface SystemicDiseaseDto {
  id: string;
  name: string;
  type: string | null;
  diagnosis_date: string | null;
  is_controlled: boolean;
  is_critical: boolean;
  medications: string | null;
  notes: string | null;
  reference_id: string | null;
  status: string;
}

export interface SurgicalHistoryDto {
  id: string;
  procedure: string;
  surgery_date: string | null;
  complications: string | null;
  notes: string | null;
  reference_id: string | null;
  status: string;
}

export interface EmergencyContactDto {
  name: string;
  relationship: string | null;
  phone: string;
  email: string | null;
  is_legal_guardian: boolean;
  status: string;
}

export interface LegalGuardianDto {
  name: string;
  relationship: string;
  dni: string | null;
  phone: string;
  email: string | null;
  address: string | null;
  notes: string | null;
  status: string;
}

export interface PatientAlertDto {
  type: string;
  severity: string;
  title: string;
  details: string | null;
}

export interface MedicalHistoryDto {
  allergies: AllergyDto[];
  medications: MedicationDto[];
  systemic_diseases: SystemicDiseaseDto[];
  surgical_history: SurgicalHistoryDto[];
  is_pregnant: boolean;
  pregnancy_week: number | null;
  is_lactating: boolean;
  is_on_anticoagulants: boolean;
  anticoagulant_medication: string | null;
  inr_value: number | null;
  last_inr_date: string | null;
  is_smoker: boolean;
  smoking_frequency: string | null;
  alcohol_consumption: string | null;
  bruxism: boolean;
  adverse_reactions_to_anesthesia: boolean;
  anesthesia_reaction_details: string | null;
  last_updated_at: string | null;
  last_updated_by: string | null;
}

// ---------------------------------------------------------------------------
// Helpers de sérialisation
// ---------------------------------------------------------------------------

/** Colonne `date` → `YYYY-MM-DD` (fuseau clinique, comme `date.isoformat()`). */
function dateToIso(value: Date | null | undefined, timeZone: string): string | null {
  return toClinicDateString(value ?? null, timeZone);
}

/** `date` Pydantic (`YYYY-MM-DD`) → `Date` à minuit UTC pour une colonne `date`. */
export function dateStringToDbDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  return new Date(`${value}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// Patient (multi-tenant)
// ---------------------------------------------------------------------------

/** Miroir de `PatientService.get_patient` : patient de la clinique courante. */
export async function findClinicPatient(
  clinicId: string,
  patientId: string,
): Promise<{ id: string } | null> {
  return prisma.patients.findFirst({
    where: { id: patientId, clinic_id: clinicId },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// Contexte médical (1:1)
// ---------------------------------------------------------------------------

export function toMedicalContextDto(row: {
  is_pregnant: boolean;
  pregnancy_week: number | null;
  is_lactating: boolean;
  is_on_anticoagulants: boolean;
  anticoagulant_medication: string | null;
  inr_value: number | null;
  last_inr_date: Date | null;
  is_smoker: boolean;
  smoking_frequency: string | null;
  alcohol_consumption: string | null;
  bruxism: boolean;
  adverse_reactions_to_anesthesia: boolean;
  anesthesia_reaction_details: string | null;
  last_updated_at: Date | null;
  last_updated_by: string | null;
} | null, timeZone: string): MedicalContextDto {
  // `MedicalContextResponse()` sans ligne : tous les booléens à false.
  return {
    is_pregnant: row?.is_pregnant ?? false,
    pregnancy_week: row?.pregnancy_week ?? null,
    is_lactating: row?.is_lactating ?? false,
    is_on_anticoagulants: row?.is_on_anticoagulants ?? false,
    anticoagulant_medication: row?.anticoagulant_medication ?? null,
    inr_value: row?.inr_value ?? null,
    last_inr_date: dateToIso(row?.last_inr_date, timeZone),
    is_smoker: row?.is_smoker ?? false,
    smoking_frequency: row?.smoking_frequency ?? null,
    alcohol_consumption: row?.alcohol_consumption ?? null,
    bruxism: row?.bruxism ?? false,
    adverse_reactions_to_anesthesia: row?.adverse_reactions_to_anesthesia ?? false,
    anesthesia_reaction_details: row?.anesthesia_reaction_details ?? null,
    last_updated_at: row?.last_updated_at ? toZonedIso(row.last_updated_at, timeZone) : null,
    last_updated_by: row?.last_updated_by ?? null,
  };
}

export async function getMedicalContext(clinicId: string, patientId: string) {
  return prisma.patients_clinical_medical_context.findFirst({
    where: { clinic_id: clinicId, patient_id: patientId },
  });
}

type MedicalContextData = Omit<MedicalContextUpdateInput, 'last_inr_date'> & {
  last_inr_date?: string | null;
};

function medicalContextColumns(
  data: Partial<MedicalContextData>,
): Prisma.patients_clinical_medical_contextUpdateInput {
  const columns: Prisma.patients_clinical_medical_contextUpdateInput = {};
  for (const key of MEDICAL_CONTEXT_FIELDS) {
    const value = (data as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'last_inr_date') {
      columns.last_inr_date = dateStringToDbDate(value as string | null);
    } else {
      (columns as Record<string, unknown>)[key] = value;
    }
  }
  return columns;
}

/**
 * `upsert_medical_context` : crée ou met à jour la ligne 1:1 et rafraîchit
 * `last_updated_at` / `last_updated_by`.
 */
export async function upsertMedicalContext(
  clinicId: string,
  patientId: string,
  data: Partial<MedicalContextData>,
  userId: string | null,
) {
  const existing = await getMedicalContext(clinicId, patientId);
  const columns = medicalContextColumns(data);
  const now = new Date();

  if (!existing) {
    const base: Prisma.patients_clinical_medical_contextUncheckedCreateInput = {
      patient_id: patientId,
      clinic_id: clinicId,
      is_pregnant: false,
      is_lactating: false,
      is_on_anticoagulants: false,
      is_smoker: false,
      bruxism: false,
      adverse_reactions_to_anesthesia: false,
      created_at: now,
      updated_at: now,
    };
    // Les colonnes booléennes NOT NULL sans défaut SQL reçoivent leur défaut
    // Pydantic (`False`) quand la clé est absente du payload.
    const withDefaults: Record<string, unknown> = { ...columns };
    for (const key of [
      'is_pregnant',
      'is_lactating',
      'is_on_anticoagulants',
      'is_smoker',
      'bruxism',
      'adverse_reactions_to_anesthesia',
    ]) {
      if (withDefaults[key] === undefined) withDefaults[key] = false;
    }
    return prisma.patients_clinical_medical_context.create({
      data: {
        ...base,
        ...(withDefaults as Partial<Prisma.patients_clinical_medical_contextUncheckedCreateInput>),
        last_updated_at: now,
        last_updated_by: userId,
      },
    });
  }

  return prisma.patients_clinical_medical_context.update({
    where: { patient_id: existing.patient_id },
    data: {
      ...columns,
      last_updated_at: now,
      last_updated_by: userId,
      updated_at: now,
    },
  });
}

// ---------------------------------------------------------------------------
// Allergies
// ---------------------------------------------------------------------------

export function toAllergyDto(row: {
  id: string;
  name: string;
  type: string | null;
  severity: string;
  reaction: string | null;
  notes: string | null;
  reference_id: string | null;
  status: string;
}): AllergyDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    severity: row.severity,
    reaction: row.reaction,
    notes: row.notes,
    reference_id: row.reference_id,
    status: row.status,
  };
}

export async function listAllergies(clinicId: string, patientId: string) {
  return prisma.patients_clinical_allergy.findMany({
    where: { clinic_id: clinicId, patient_id: patientId, status: 'active' },
    orderBy: { created_at: 'asc' },
  });
}

export async function createAllergy(
  clinicId: string,
  patientId: string,
  input: AllergyCreateInput,
) {
  const now = new Date();
  return prisma.patients_clinical_allergy.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: clinicId,
      patient_id: patientId,
      name: input.name,
      type: input.type ?? null,
      severity: input.severity ?? 'medium',
      reaction: input.reaction ?? null,
      notes: input.notes ?? null,
      reference_id: input.reference_id ?? null,
      status: 'active',
      created_at: now,
      updated_at: now,
    },
  });
}

export async function getAllergy(clinicId: string, allergyId: string) {
  return prisma.patients_clinical_allergy.findFirst({
    where: { clinic_id: clinicId, id: allergyId },
  });
}

export async function updateAllergy(
  row: { id: string },
  input: AllergyUpdateInput,
) {
  return prisma.patients_clinical_allergy.update({
    where: { id: row.id },
    data: {
      ...(input.name != null ? { name: input.name } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.severity != null ? { severity: input.severity } : {}),
      ...(input.reaction !== undefined ? { reaction: input.reaction } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.reference_id !== undefined ? { reference_id: input.reference_id } : {}),
      updated_at: new Date(),
    },
  });
}

/** Soft-delete : la ligne reste pour l'historique, les listes l'excluent. */
export async function archiveAllergy(row: { id: string }) {
  return prisma.patients_clinical_allergy.update({
    where: { id: row.id },
    data: { status: 'archived', updated_at: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Médicaments
// ---------------------------------------------------------------------------

export function toMedicationDto(
  row: {
    id: string;
    name: string;
    dosage: string | null;
    frequency: string | null;
    start_date: Date | null;
    notes: string | null;
    reference_id: string | null;
    status: string;
  },
  timeZone: string,
): MedicationDto {
  return {
    id: row.id,
    name: row.name,
    dosage: row.dosage,
    frequency: row.frequency,
    start_date: dateToIso(row.start_date, timeZone),
    notes: row.notes,
    reference_id: row.reference_id,
    status: row.status,
  };
}

export async function listMedications(clinicId: string, patientId: string) {
  return prisma.patients_clinical_medication.findMany({
    where: { clinic_id: clinicId, patient_id: patientId, status: 'active' },
    orderBy: { created_at: 'asc' },
  });
}

export async function createMedication(
  clinicId: string,
  patientId: string,
  input: MedicationCreateInput,
) {
  const now = new Date();
  return prisma.patients_clinical_medication.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: clinicId,
      patient_id: patientId,
      name: input.name,
      dosage: input.dosage ?? null,
      frequency: input.frequency ?? null,
      start_date: dateStringToDbDate(input.start_date),
      notes: input.notes ?? null,
      reference_id: input.reference_id ?? null,
      status: 'active',
      created_at: now,
      updated_at: now,
    },
  });
}

export async function getMedication(clinicId: string, medicationId: string) {
  return prisma.patients_clinical_medication.findFirst({
    where: { clinic_id: clinicId, id: medicationId },
  });
}

export async function updateMedication(
  row: { id: string },
  input: MedicationUpdateInput,
) {
  return prisma.patients_clinical_medication.update({
    where: { id: row.id },
    data: {
      ...(input.name != null ? { name: input.name } : {}),
      ...(input.dosage !== undefined ? { dosage: input.dosage } : {}),
      ...(input.frequency !== undefined ? { frequency: input.frequency } : {}),
      ...(input.start_date !== undefined
        ? { start_date: dateStringToDbDate(input.start_date) }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.reference_id !== undefined ? { reference_id: input.reference_id } : {}),
      updated_at: new Date(),
    },
  });
}

export async function archiveMedication(row: { id: string }) {
  return prisma.patients_clinical_medication.update({
    where: { id: row.id },
    data: { status: 'archived', updated_at: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Maladies systémiques
// ---------------------------------------------------------------------------

export function toSystemicDiseaseDto(
  row: {
    id: string;
    name: string;
    type: string | null;
    diagnosis_date: Date | null;
    is_controlled: boolean;
    is_critical: boolean;
    medications: string | null;
    notes: string | null;
    reference_id: string | null;
    status: string;
  },
  timeZone: string,
): SystemicDiseaseDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    diagnosis_date: dateToIso(row.diagnosis_date, timeZone),
    is_controlled: row.is_controlled,
    is_critical: row.is_critical,
    medications: row.medications,
    notes: row.notes,
    reference_id: row.reference_id,
    status: row.status,
  };
}

export async function listSystemicDiseases(clinicId: string, patientId: string) {
  return prisma.patients_clinical_systemic_disease.findMany({
    where: { clinic_id: clinicId, patient_id: patientId, status: 'active' },
    orderBy: { created_at: 'asc' },
  });
}

export async function createSystemicDisease(
  clinicId: string,
  patientId: string,
  input: SystemicDiseaseCreateInput,
) {
  const now = new Date();
  return prisma.patients_clinical_systemic_disease.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: clinicId,
      patient_id: patientId,
      name: input.name,
      type: input.type ?? null,
      diagnosis_date: dateStringToDbDate(input.diagnosis_date),
      is_controlled: input.is_controlled ?? true,
      is_critical: input.is_critical ?? false,
      medications: input.medications ?? null,
      notes: input.notes ?? null,
      reference_id: input.reference_id ?? null,
      status: 'active',
      created_at: now,
      updated_at: now,
    },
  });
}

export async function getSystemicDisease(clinicId: string, diseaseId: string) {
  return prisma.patients_clinical_systemic_disease.findFirst({
    where: { clinic_id: clinicId, id: diseaseId },
  });
}

export async function updateSystemicDisease(
  row: { id: string },
  input: SystemicDiseaseUpdateInput,
) {
  return prisma.patients_clinical_systemic_disease.update({
    where: { id: row.id },
    data: {
      ...(input.name != null ? { name: input.name } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.diagnosis_date !== undefined
        ? { diagnosis_date: dateStringToDbDate(input.diagnosis_date) }
        : {}),
      ...(input.is_controlled !== undefined ? { is_controlled: input.is_controlled } : {}),
      ...(input.is_critical !== undefined ? { is_critical: input.is_critical } : {}),
      ...(input.medications !== undefined ? { medications: input.medications } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.reference_id !== undefined ? { reference_id: input.reference_id } : {}),
      updated_at: new Date(),
    },
  });
}

export async function archiveSystemicDisease(row: { id: string }) {
  return prisma.patients_clinical_systemic_disease.update({
    where: { id: row.id },
    data: { status: 'archived', updated_at: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Antécédents chirurgicaux
// ---------------------------------------------------------------------------

export function toSurgicalHistoryDto(
  row: {
    id: string;
    procedure: string;
    surgery_date: Date | null;
    complications: string | null;
    notes: string | null;
    reference_id: string | null;
    status: string;
  },
  timeZone: string,
): SurgicalHistoryDto {
  return {
    id: row.id,
    procedure: row.procedure,
    surgery_date: dateToIso(row.surgery_date, timeZone),
    complications: row.complications,
    notes: row.notes,
    reference_id: row.reference_id,
    status: row.status,
  };
}

export async function listSurgicalHistory(clinicId: string, patientId: string) {
  return prisma.patients_clinical_surgical_history.findMany({
    where: { clinic_id: clinicId, patient_id: patientId, status: 'active' },
    orderBy: { created_at: 'asc' },
  });
}

export async function createSurgicalHistory(
  clinicId: string,
  patientId: string,
  input: SurgicalHistoryCreateInput,
) {
  const now = new Date();
  return prisma.patients_clinical_surgical_history.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: clinicId,
      patient_id: patientId,
      procedure: input.procedure,
      surgery_date: dateStringToDbDate(input.surgery_date),
      complications: input.complications ?? null,
      notes: input.notes ?? null,
      reference_id: input.reference_id ?? null,
      status: 'active',
      created_at: now,
      updated_at: now,
    },
  });
}

export async function getSurgicalHistory(clinicId: string, surgeryId: string) {
  return prisma.patients_clinical_surgical_history.findFirst({
    where: { clinic_id: clinicId, id: surgeryId },
  });
}

export async function updateSurgicalHistory(
  row: { id: string },
  input: SurgicalHistoryUpdateInput,
) {
  return prisma.patients_clinical_surgical_history.update({
    where: { id: row.id },
    data: {
      ...(input.procedure != null ? { procedure: input.procedure } : {}),
      ...(input.surgery_date !== undefined
        ? { surgery_date: dateStringToDbDate(input.surgery_date) }
        : {}),
      ...(input.complications !== undefined ? { complications: input.complications } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.reference_id !== undefined ? { reference_id: input.reference_id } : {}),
      updated_at: new Date(),
    },
  });
}

export async function archiveSurgicalHistory(row: { id: string }) {
  return prisma.patients_clinical_surgical_history.update({
    where: { id: row.id },
    data: { status: 'archived', updated_at: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Contact d'urgence (1:1)
// ---------------------------------------------------------------------------

export function toEmergencyContactDto(row: {
  name: string;
  relationship: string | null;
  phone: string;
  email: string | null;
  is_legal_guardian: boolean;
  status: string;
}): EmergencyContactDto {
  return {
    name: row.name,
    relationship: row.relationship,
    phone: row.phone,
    email: row.email,
    is_legal_guardian: row.is_legal_guardian,
    status: row.status,
  };
}

export async function getEmergencyContact(clinicId: string, patientId: string) {
  return prisma.patients_clinical_emergency_contact.findFirst({
    where: { clinic_id: clinicId, patient_id: patientId },
  });
}

/**
 * `upsert_emergency_contact` : la PK est `patient_id`, donc une ligne
 * archivée est réutilisée et réactivée.
 */
export async function upsertEmergencyContact(
  clinicId: string,
  patientId: string,
  input: EmergencyContactUpsertInput,
) {
  const existing = await getEmergencyContact(clinicId, patientId);
  const now = new Date();
  const values = {
    name: input.name,
    relationship: input.relationship ?? null,
    phone: input.phone,
    email: input.email ?? null,
    is_legal_guardian: input.is_legal_guardian ?? false,
  };
  if (!existing) {
    return prisma.patients_clinical_emergency_contact.create({
      data: {
        patient_id: patientId,
        clinic_id: clinicId,
        ...values,
        status: 'active',
        created_at: now,
        updated_at: now,
      },
    });
  }
  return prisma.patients_clinical_emergency_contact.update({
    where: { patient_id: existing.patient_id },
    data: { ...values, status: 'active', updated_at: now },
  });
}

export async function archiveEmergencyContact(row: { patient_id: string }) {
  return prisma.patients_clinical_emergency_contact.update({
    where: { patient_id: row.patient_id },
    data: { status: 'archived', updated_at: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Tuteur légal (1:1)
// ---------------------------------------------------------------------------

export function toLegalGuardianDto(row: {
  name: string;
  relationship: string;
  dni: string | null;
  phone: string;
  email: string | null;
  address: string | null;
  notes: string | null;
  status: string;
}): LegalGuardianDto {
  return {
    name: row.name,
    relationship: row.relationship,
    dni: row.dni,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    status: row.status,
  };
}

export async function getLegalGuardian(clinicId: string, patientId: string) {
  return prisma.patients_clinical_legal_guardian.findFirst({
    where: { clinic_id: clinicId, patient_id: patientId },
  });
}

/** `upsert_legal_guardian` : même logique de réutilisation que le contact d'urgence. */
export async function upsertLegalGuardian(
  clinicId: string,
  patientId: string,
  input: LegalGuardianUpsertInput,
) {
  const existing = await getLegalGuardian(clinicId, patientId);
  const now = new Date();
  const values = {
    name: input.name,
    relationship: input.relationship,
    dni: input.dni ?? null,
    phone: input.phone,
    email: input.email ?? null,
    address: input.address ?? null,
    notes: input.notes ?? null,
  };
  if (!existing) {
    return prisma.patients_clinical_legal_guardian.create({
      data: {
        patient_id: patientId,
        clinic_id: clinicId,
        ...values,
        status: 'active',
        created_at: now,
        updated_at: now,
      },
    });
  }
  return prisma.patients_clinical_legal_guardian.update({
    where: { patient_id: existing.patient_id },
    data: { ...values, status: 'active', updated_at: now },
  });
}

export async function archiveLegalGuardian(row: { patient_id: string }) {
  return prisma.patients_clinical_legal_guardian.update({
    where: { patient_id: row.patient_id },
    data: { status: 'archived', updated_at: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Vues agrégées
// ---------------------------------------------------------------------------

/**
 * `build_medical_history` : l'agrégat à l'ancienne forme JSONB. Les lignes
 * ne comprennent PAS `created_at`/`updated_at` (le schéma Pydantic les
 * ignore) et `status` est toujours présent.
 */
export async function buildMedicalHistory(
  clinicId: string,
  patientId: string,
  timeZone: string,
): Promise<MedicalHistoryDto> {
  const [context, allergies, medications, diseases, surgeries] = await Promise.all([
    getMedicalContext(clinicId, patientId),
    listAllergies(clinicId, patientId),
    listMedications(clinicId, patientId),
    listSystemicDiseases(clinicId, patientId),
    listSurgicalHistory(clinicId, patientId),
  ]);

  const dto: MedicalHistoryDto = {
    allergies: allergies.map(toAllergyDto),
    medications: medications.map((row) => toMedicationDto(row, timeZone)),
    systemic_diseases: diseases.map((row) => toSystemicDiseaseDto(row, timeZone)),
    surgical_history: surgeries.map((row) => toSurgicalHistoryDto(row, timeZone)),
    is_pregnant: false,
    pregnancy_week: null,
    is_lactating: false,
    is_on_anticoagulants: false,
    anticoagulant_medication: null,
    inr_value: null,
    last_inr_date: null,
    is_smoker: false,
    smoking_frequency: null,
    alcohol_consumption: null,
    bruxism: false,
    adverse_reactions_to_anesthesia: false,
    anesthesia_reaction_details: null,
    last_updated_at: null,
    last_updated_by: null,
  };

  if (context) {
    dto.is_pregnant = context.is_pregnant;
    dto.pregnancy_week = context.pregnancy_week;
    dto.is_lactating = context.is_lactating;
    dto.is_on_anticoagulants = context.is_on_anticoagulants;
    dto.anticoagulant_medication = context.anticoagulant_medication;
    dto.inr_value = context.inr_value;
    dto.last_inr_date = dateToIso(context.last_inr_date, timeZone);
    dto.is_smoker = context.is_smoker;
    dto.smoking_frequency = context.smoking_frequency;
    dto.alcohol_consumption = context.alcohol_consumption;
    dto.bruxism = context.bruxism;
    dto.adverse_reactions_to_anesthesia = context.adverse_reactions_to_anesthesia;
    dto.anesthesia_reaction_details = context.anesthesia_reaction_details;
    dto.last_updated_at = context.last_updated_at
      ? toZonedIso(context.last_updated_at, timeZone)
      : null;
    dto.last_updated_by = context.last_updated_by;
  }

  return dto;
}

/** Source minimale de `compute_alerts` (testable sans Prisma). */
export interface AlertsInput {
  context: {
    is_pregnant: boolean;
    pregnancy_week: number | null;
    is_lactating: boolean;
    is_on_anticoagulants: boolean;
    anticoagulant_medication: string | null;
    inr_value: number | null;
    adverse_reactions_to_anesthesia: boolean;
    anesthesia_reaction_details: string | null;
  } | null;
  allergies: Array<{ name: string; severity: string; reaction: string | null }>;
  diseases: Array<{ name: string; is_critical: boolean; notes: string | null }>;
}

/**
 * `compute_alerts` — miroir exact de l'ordre et des textes Python.
 * Attention aux règles de véracité Python : `week`, `med` et `inr` sont
 * testés par truthiness (`0` → pas de suffixe).
 */
export function computeAlertsFrom(input: AlertsInput): PatientAlertDto[] {
  const alerts: PatientAlertDto[] = [];

  for (const allergy of input.allergies) {
    if (allergy.severity === 'high' || allergy.severity === 'critical') {
      alerts.push({
        type: 'allergy',
        severity: allergy.severity,
        title: `Alergia: ${allergy.name}`,
        details: allergy.reaction,
      });
    }
  }

  const context = input.context;
  if (context === null) return alerts;

  if (context.is_pregnant) {
    const week = context.pregnancy_week;
    alerts.push({
      type: 'pregnancy',
      severity: 'high',
      title: `Embarazada${week ? ` (${week} semanas)` : ''}`,
      details: null,
    });
  }

  if (context.is_lactating) {
    alerts.push({
      type: 'lactating',
      severity: 'medium',
      title: 'En período de lactancia',
      details: null,
    });
  }

  if (context.is_on_anticoagulants) {
    const med = context.anticoagulant_medication;
    const inr = context.inr_value;
    alerts.push({
      type: 'anticoagulant',
      severity: 'critical',
      title: `Anticoagulantes${med ? `: ${med}` : ''}`,
      details: inr ? `INR: ${inr}` : null,
    });
  }

  if (context.adverse_reactions_to_anesthesia) {
    alerts.push({
      type: 'anesthesia_reaction',
      severity: 'critical',
      title: 'Reacción adversa a anestesia',
      details: context.anesthesia_reaction_details,
    });
  }

  for (const disease of input.diseases) {
    if (disease.is_critical) {
      alerts.push({
        type: 'systemic_disease',
        severity: 'high',
        title: disease.name,
        details: disease.notes,
      });
    }
  }

  return alerts;
}

export async function computeAlerts(
  clinicId: string,
  patientId: string,
): Promise<PatientAlertDto[]> {
  const [context, allergies, diseases] = await Promise.all([
    getMedicalContext(clinicId, patientId),
    listAllergies(clinicId, patientId),
    listSystemicDiseases(clinicId, patientId),
  ]);
  return computeAlertsFrom({ context, allergies, diseases });
}

// ---------------------------------------------------------------------------
// Remplacement global de l'historique médical
// ---------------------------------------------------------------------------

/** Sous-ensemble du payload `MedicalHistoryUpdate` utilisé par le remplacement. */
export interface MedicalHistoryPayload {
  allergies?: AllergyCreateInput[];
  medications?: MedicationCreateInput[];
  systemic_diseases?: SystemicDiseaseCreateInput[];
  surgical_history?: SurgicalHistoryCreateInput[];
  [key: string]: unknown;
}

export interface ReplaceMedicalHistoryOptions {
  /** Horodatage unique pour créer contexte + lignes (défaut : maintenant). */
  now?: Date;
  /** Générateur d'identifiants (injectable pour les tests). */
  newId?: () => string;
}

/**
 * `replace_medical_history` : archive TOUTES les lignes existantes (actives
 * ou déjà archivées), insère le jeu soumis puis met à jour le contexte.
 * `medications` est passé tel quel en base (pas de tri ni de dédoublonnage).
 */
export async function replaceMedicalHistory(
  clinicId: string,
  patientId: string,
  payload: MedicalHistoryPayload,
  userId: string | null,
  options: ReplaceMedicalHistoryOptions = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const newId = options.newId ?? (() => crypto.randomUUID());

  await prisma.$transaction(async (tx) => {
    const archiveFilter = { clinic_id: clinicId, patient_id: patientId };
    await tx.patients_clinical_allergy.updateMany({
      where: archiveFilter,
      data: { status: 'archived', updated_at: now },
    });
    await tx.patients_clinical_medication.updateMany({
      where: archiveFilter,
      data: { status: 'archived', updated_at: now },
    });
    await tx.patients_clinical_systemic_disease.updateMany({
      where: archiveFilter,
      data: { status: 'archived', updated_at: now },
    });
    await tx.patients_clinical_surgical_history.updateMany({
      where: archiveFilter,
      data: { status: 'archived', updated_at: now },
    });

    const stamp = { status: 'active', created_at: now, updated_at: now };

    for (const row of payload.allergies ?? []) {
      await tx.patients_clinical_allergy.create({
        data: {
          id: newId(),
          clinic_id: clinicId,
          patient_id: patientId,
          name: row.name,
          type: row.type ?? null,
          severity: row.severity ?? 'medium',
          reaction: row.reaction ?? null,
          notes: row.notes ?? null,
          reference_id: row.reference_id ?? null,
          ...stamp,
        },
      });
    }
    for (const row of payload.medications ?? []) {
      await tx.patients_clinical_medication.create({
        data: {
          id: newId(),
          clinic_id: clinicId,
          patient_id: patientId,
          name: row.name,
          dosage: row.dosage ?? null,
          frequency: row.frequency ?? null,
          start_date: dateStringToDbDate(row.start_date),
          notes: row.notes ?? null,
          reference_id: row.reference_id ?? null,
          ...stamp,
        },
      });
    }
    for (const row of payload.systemic_diseases ?? []) {
      await tx.patients_clinical_systemic_disease.create({
        data: {
          id: newId(),
          clinic_id: clinicId,
          patient_id: patientId,
          name: row.name,
          type: row.type ?? null,
          diagnosis_date: dateStringToDbDate(row.diagnosis_date),
          is_controlled: row.is_controlled ?? true,
          is_critical: row.is_critical ?? false,
          medications: row.medications ?? null,
          notes: row.notes ?? null,
          reference_id: row.reference_id ?? null,
          ...stamp,
        },
      });
    }
    for (const row of payload.surgical_history ?? []) {
      await tx.patients_clinical_surgical_history.create({
        data: {
          id: newId(),
          clinic_id: clinicId,
          patient_id: patientId,
          procedure: row.procedure,
          surgery_date: dateStringToDbDate(row.surgery_date),
          complications: row.complications ?? null,
          notes: row.notes ?? null,
          reference_id: row.reference_id ?? null,
          ...stamp,
        },
      });
    }

    // `context_fields` : seules les clés présentes dans le payload.
    const contextFields: Record<string, unknown> = {};
    for (const key of MEDICAL_CONTEXT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        contextFields[key] = payload[key];
      }
    }
    const columns = medicalContextColumns(contextFields as Partial<MedicalContextData>);

    const existing = await tx.patients_clinical_medical_context.findFirst({
      where: { clinic_id: clinicId, patient_id: patientId },
    });
    if (!existing) {
      const defaults = {
        is_pregnant: false,
        is_lactating: false,
        is_on_anticoagulants: false,
        is_smoker: false,
        bruxism: false,
        adverse_reactions_to_anesthesia: false,
      };
      const values = { ...defaults, ...columns };
      await tx.patients_clinical_medical_context.create({
        data: {
          patient_id: patientId,
          clinic_id: clinicId,
          is_pregnant: (values.is_pregnant as boolean | undefined) ?? false,
          pregnancy_week: (values.pregnancy_week as number | null | undefined) ?? null,
          is_lactating: (values.is_lactating as boolean | undefined) ?? false,
          is_on_anticoagulants: (values.is_on_anticoagulants as boolean | undefined) ?? false,
          anticoagulant_medication:
            (values.anticoagulant_medication as string | null | undefined) ?? null,
          inr_value: (values.inr_value as number | null | undefined) ?? null,
          last_inr_date: (values.last_inr_date as Date | null | undefined) ?? null,
          is_smoker: (values.is_smoker as boolean | undefined) ?? false,
          smoking_frequency: (values.smoking_frequency as string | null | undefined) ?? null,
          alcohol_consumption: (values.alcohol_consumption as string | null | undefined) ?? null,
          bruxism: (values.bruxism as boolean | undefined) ?? false,
          adverse_reactions_to_anesthesia:
            (values.adverse_reactions_to_anesthesia as boolean | undefined) ?? false,
          anesthesia_reaction_details:
            (values.anesthesia_reaction_details as string | null | undefined) ?? null,
          created_at: now,
          updated_at: now,
          last_updated_at: now,
          last_updated_by: userId,
        },
      });
    } else {
      await tx.patients_clinical_medical_context.update({
        where: { patient_id: existing.patient_id },
        data: {
          ...columns,
          updated_at: now,
          last_updated_at: now,
          last_updated_by: userId,
        },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Événement `patient.medical_updated` → patient_timeline
// ---------------------------------------------------------------------------

export interface MedicalUpdatedEvent {
  patientId: string;
  clinicId: string;
  userId: string | null;
  section: 'context' | 'history';
  summary: string;
}

/**
 * Miroir de `on_medical_updated` (patient_timeline/events.py) : une ligne
 * `patient_timeline`, `source_id = patient_id`, session indépendante, et
 * une erreur d'insertion est journalisée sans faire échouer la requête
 * (le contrat « le journal n'échoue jamais » du backend Python).
 */
export async function recordMedicalUpdatedTimeline(event: MedicalUpdatedEvent): Promise<void> {
  try {
    await prisma.patient_timeline.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: event.clinicId,
        patient_id: event.patientId,
        event_type: 'patient.medical_updated',
        event_category: 'medical',
        source_table: 'patients',
        source_id: event.patientId,
        title: event.summary || 'Historia clínica actualizada',
        description: null,
        event_data: { section: event.section },
        occurred_at: new Date(),
        created_by: event.userId,
      },
    });
  } catch (error) {
    console.error('[patients_clinical] failed to record patient.medical_updated', error);
  }
}
