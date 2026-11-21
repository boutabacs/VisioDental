/**
 * Surface HTTP `patients_clinical` — port de
 * `backend/app/modules/patients_clinical/router.py` (27 routes).
 *
 * Monté sous `/api/v1/patients_clinical/*`. Chaque route est scopée par
 * `patient_id` et vérifie d'abord que le patient appartient à la clinique
 * appelante (`404 "Patient not found"`), comme `_ensure_patient` côté FastAPI.
 */

import { Router } from 'express';
import { z } from 'zod';

import { notFound } from '../../lib/errors';
import { ok } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import {
  allergyCreateSchema,
  allergyUpdateSchema,
  emergencyContactUpsertSchema,
  legalGuardianUpsertSchema,
  medicalContextUpdateSchema,
  medicalHistoryUpdateSchema,
  medicationCreateSchema,
  medicationUpdateSchema,
  surgicalHistoryCreateSchema,
  surgicalHistoryUpdateSchema,
  systemicDiseaseCreateSchema,
  systemicDiseaseUpdateSchema,
} from './schemas';
import {
  archiveAllergy,
  archiveEmergencyContact,
  archiveLegalGuardian,
  archiveMedication,
  archiveSystemicDisease,
  archiveSurgicalHistory,
  buildMedicalHistory,
  computeAlerts,
  createAllergy,
  createMedication,
  createSurgicalHistory,
  createSystemicDisease,
  findClinicPatient,
  getAllergy,
  getEmergencyContact,
  getLegalGuardian,
  getMedicalContext,
  getMedication,
  getSurgicalHistory,
  getSystemicDisease,
  listAllergies,
  listMedications,
  listSurgicalHistory,
  listSystemicDiseases,
  recordMedicalUpdatedTimeline,
  replaceMedicalHistory,
  toAllergyDto,
  toEmergencyContactDto,
  toLegalGuardianDto,
  toMedicalContextDto,
  toMedicationDto,
  toSurgicalHistoryDto,
  toSystemicDiseaseDto,
  updateAllergy,
  updateMedication,
  updateSurgicalHistory,
  updateSystemicDisease,
  upsertEmergencyContact,
  upsertLegalGuardian,
  upsertMedicalContext,
} from './service';

export const patientsClinicalRouter = Router();

const uuid = z.string().uuid();

/** `_ensure_patient` : 404 si le patient n'existe pas DANS la clinique. */
async function ensurePatient(clinicId: string, patientId: string): Promise<void> {
  const patient = await findClinicPatient(clinicId, patientId);
  if (!patient) throw notFound('Patient not found');
}

const medicalRead = [authenticate, requireClinic, requirePermission('patients_clinical.medical.read')];
const medicalWrite = [authenticate, requireClinic, requirePermission('patients_clinical.medical.write')];
const emergencyRead = [
  authenticate,
  requireClinic,
  requirePermission('patients_clinical.emergency.read'),
];
const emergencyWrite = [
  authenticate,
  requireClinic,
  requirePermission('patients_clinical.emergency.write'),
];

// ---------------------------------------------------------------------------
// Contexte médical (1:1)
// ---------------------------------------------------------------------------

patientsClinicalRouter.get(
  '/patients/:patientId/medical-context',
  ...medicalRead,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const row = await getMedicalContext(req.clinicId!, patientId);
    res.json(ok(toMedicalContextDto(row, req.clinic!.timezone)));
  },
);

patientsClinicalRouter.put(
  '/patients/:patientId/medical-context',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const input = medicalContextUpdateSchema.parse(req.body);
    const row = await upsertMedicalContext(
      req.clinicId!,
      patientId,
      input,
      req.user!.id,
    );
    await recordMedicalUpdatedTimeline({
      patientId,
      clinicId: req.clinicId!,
      userId: req.user!.id,
      section: 'context',
      summary: 'Contexto médico actualizado',
    });
    res.json(ok(toMedicalContextDto(row, req.clinic!.timezone)));
  },
);

// ---------------------------------------------------------------------------
// Allergies
// ---------------------------------------------------------------------------

patientsClinicalRouter.get(
  '/patients/:patientId/allergies',
  ...medicalRead,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const rows = await listAllergies(req.clinicId!, patientId);
    res.json(ok(rows.map(toAllergyDto)));
  },
);

patientsClinicalRouter.post(
  '/patients/:patientId/allergies',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const input = allergyCreateSchema.parse(req.body);
    const row = await createAllergy(req.clinicId!, patientId, input);
    res.status(201).json(ok(toAllergyDto(row)));
  },
);

patientsClinicalRouter.put(
  '/patients/:patientId/allergies/:allergyId',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    const allergyId = uuid.parse(req.params.allergyId);
    await ensurePatient(req.clinicId!, patientId);
    const current = await getAllergy(req.clinicId!, allergyId);
    if (!current || current.patient_id !== patientId) throw notFound('Allergy not found');
    const input = allergyUpdateSchema.parse(req.body);
    const row = await updateAllergy(current, input);
    res.json(ok(toAllergyDto(row)));
  },
);

patientsClinicalRouter.delete(
  '/patients/:patientId/allergies/:allergyId',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    const allergyId = uuid.parse(req.params.allergyId);
    await ensurePatient(req.clinicId!, patientId);
    const current = await getAllergy(req.clinicId!, allergyId);
    if (!current || current.patient_id !== patientId) throw notFound('Allergy not found');
    await archiveAllergy(current);
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Médicaments
// ---------------------------------------------------------------------------

patientsClinicalRouter.get(
  '/patients/:patientId/medications',
  ...medicalRead,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const rows = await listMedications(req.clinicId!, patientId);
    res.json(ok(rows.map((row) => toMedicationDto(row, req.clinic!.timezone))));
  },
);

patientsClinicalRouter.post(
  '/patients/:patientId/medications',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const input = medicationCreateSchema.parse(req.body);
    const row = await createMedication(req.clinicId!, patientId, input);
    res.status(201).json(ok(toMedicationDto(row, req.clinic!.timezone)));
  },
);

patientsClinicalRouter.put(
  '/patients/:patientId/medications/:medicationId',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    const medicationId = uuid.parse(req.params.medicationId);
    await ensurePatient(req.clinicId!, patientId);
    const current = await getMedication(req.clinicId!, medicationId);
    if (!current || current.patient_id !== patientId) throw notFound('Medication not found');
    const input = medicationUpdateSchema.parse(req.body);
    const row = await updateMedication(current, input);
    res.json(ok(toMedicationDto(row, req.clinic!.timezone)));
  },
);

patientsClinicalRouter.delete(
  '/patients/:patientId/medications/:medicationId',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    const medicationId = uuid.parse(req.params.medicationId);
    await ensurePatient(req.clinicId!, patientId);
    const current = await getMedication(req.clinicId!, medicationId);
    if (!current || current.patient_id !== patientId) throw notFound('Medication not found');
    await archiveMedication(current);
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Maladies systémiques
// ---------------------------------------------------------------------------

patientsClinicalRouter.get(
  '/patients/:patientId/systemic-diseases',
  ...medicalRead,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const rows = await listSystemicDiseases(req.clinicId!, patientId);
    res.json(ok(rows.map((row) => toSystemicDiseaseDto(row, req.clinic!.timezone))));
  },
);

patientsClinicalRouter.post(
  '/patients/:patientId/systemic-diseases',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const input = systemicDiseaseCreateSchema.parse(req.body);
    const row = await createSystemicDisease(req.clinicId!, patientId, input);
    res.status(201).json(ok(toSystemicDiseaseDto(row, req.clinic!.timezone)));
  },
);

patientsClinicalRouter.put(
  '/patients/:patientId/systemic-diseases/:diseaseId',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    const diseaseId = uuid.parse(req.params.diseaseId);
    await ensurePatient(req.clinicId!, patientId);
    const current = await getSystemicDisease(req.clinicId!, diseaseId);
    if (!current || current.patient_id !== patientId) throw notFound('Disease not found');
    const input = systemicDiseaseUpdateSchema.parse(req.body);
    const row = await updateSystemicDisease(current, input);
    res.json(ok(toSystemicDiseaseDto(row, req.clinic!.timezone)));
  },
);

patientsClinicalRouter.delete(
  '/patients/:patientId/systemic-diseases/:diseaseId',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    const diseaseId = uuid.parse(req.params.diseaseId);
    await ensurePatient(req.clinicId!, patientId);
    const current = await getSystemicDisease(req.clinicId!, diseaseId);
    if (!current || current.patient_id !== patientId) throw notFound('Disease not found');
    await archiveSystemicDisease(current);
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Antécédents chirurgicaux
// ---------------------------------------------------------------------------

patientsClinicalRouter.get(
  '/patients/:patientId/surgical-history',
  ...medicalRead,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const rows = await listSurgicalHistory(req.clinicId!, patientId);
    res.json(ok(rows.map((row) => toSurgicalHistoryDto(row, req.clinic!.timezone))));
  },
);

patientsClinicalRouter.post(
  '/patients/:patientId/surgical-history',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const input = surgicalHistoryCreateSchema.parse(req.body);
    const row = await createSurgicalHistory(req.clinicId!, patientId, input);
    res.status(201).json(ok(toSurgicalHistoryDto(row, req.clinic!.timezone)));
  },
);

patientsClinicalRouter.put(
  '/patients/:patientId/surgical-history/:surgeryId',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    const surgeryId = uuid.parse(req.params.surgeryId);
    await ensurePatient(req.clinicId!, patientId);
    const current = await getSurgicalHistory(req.clinicId!, surgeryId);
    if (!current || current.patient_id !== patientId) throw notFound('Surgery not found');
    const input = surgicalHistoryUpdateSchema.parse(req.body);
    const row = await updateSurgicalHistory(current, input);
    res.json(ok(toSurgicalHistoryDto(row, req.clinic!.timezone)));
  },
);

patientsClinicalRouter.delete(
  '/patients/:patientId/surgical-history/:surgeryId',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    const surgeryId = uuid.parse(req.params.surgeryId);
    await ensurePatient(req.clinicId!, patientId);
    const current = await getSurgicalHistory(req.clinicId!, surgeryId);
    if (!current || current.patient_id !== patientId) throw notFound('Surgery not found');
    await archiveSurgicalHistory(current);
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Contact d'urgence (1:1)
// ---------------------------------------------------------------------------

patientsClinicalRouter.get(
  '/patients/:patientId/emergency-contact',
  ...emergencyRead,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const row = await getEmergencyContact(req.clinicId!, patientId);
    // Les lignes archivées restent en base mais se lisent comme « aucun contact ».
    if (!row || row.status !== 'active') {
      res.json(ok(null));
      return;
    }
    res.json(ok(toEmergencyContactDto(row)));
  },
);

patientsClinicalRouter.put(
  '/patients/:patientId/emergency-contact',
  ...emergencyWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const input = emergencyContactUpsertSchema.parse(req.body);
    const row = await upsertEmergencyContact(req.clinicId!, patientId, input);
    res.json(ok(toEmergencyContactDto(row)));
  },
);

patientsClinicalRouter.delete(
  '/patients/:patientId/emergency-contact',
  ...emergencyWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const current = await getEmergencyContact(req.clinicId!, patientId);
    if (!current) throw notFound('Emergency contact not found');
    await archiveEmergencyContact(current);
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Tuteur légal (1:1)
// ---------------------------------------------------------------------------

patientsClinicalRouter.get(
  '/patients/:patientId/legal-guardian',
  ...emergencyRead,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const row = await getLegalGuardian(req.clinicId!, patientId);
    // Les lignes archivées restent en base mais se lisent comme « aucun tuteur ».
    if (!row || row.status !== 'active') {
      res.json(ok(null));
      return;
    }
    res.json(ok(toLegalGuardianDto(row)));
  },
);

patientsClinicalRouter.put(
  '/patients/:patientId/legal-guardian',
  ...emergencyWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const input = legalGuardianUpsertSchema.parse(req.body);
    const row = await upsertLegalGuardian(req.clinicId!, patientId, input);
    res.json(ok(toLegalGuardianDto(row)));
  },
);

patientsClinicalRouter.delete(
  '/patients/:patientId/legal-guardian',
  ...emergencyWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const current = await getLegalGuardian(req.clinicId!, patientId);
    if (!current) throw notFound('Legal guardian not found');
    await archiveLegalGuardian(current);
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Historique médical agrégé + alertes
// ---------------------------------------------------------------------------

patientsClinicalRouter.get(
  '/patients/:patientId/medical-history',
  ...medicalRead,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const data = await buildMedicalHistory(req.clinicId!, patientId, req.clinic!.timezone);
    res.json(ok(data));
  },
);

patientsClinicalRouter.put(
  '/patients/:patientId/medical-history',
  ...medicalWrite,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const input = medicalHistoryUpdateSchema.parse(req.body);
    await replaceMedicalHistory(req.clinicId!, patientId, input, req.user!.id);
    await recordMedicalUpdatedTimeline({
      patientId,
      clinicId: req.clinicId!,
      userId: req.user!.id,
      section: 'history',
      summary: 'Historial médico actualizado',
    });
    const refreshed = await buildMedicalHistory(req.clinicId!, patientId, req.clinic!.timezone);
    res.json(ok(refreshed));
  },
);

patientsClinicalRouter.get(
  '/patients/:patientId/alerts',
  ...medicalRead,
  async (req, res) => {
    const patientId = uuid.parse(req.params.patientId);
    await ensurePatient(req.clinicId!, patientId);
    const alerts = await computeAlerts(req.clinicId!, patientId);
    res.json(ok({ alerts }));
  },
);
