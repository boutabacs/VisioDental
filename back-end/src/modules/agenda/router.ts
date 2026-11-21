import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { notFound, unauthorized, unprocessable } from '../../lib/errors';
import { ok, paginated } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import {
  appointmentCreateSchema,
  appointmentTransitionSchema,
  appointmentTreatmentNoteSchema,
  appointmentUpdateSchema,
  cabinetAssignmentSchema,
  cabinetCreateSchema,
  cabinetUpdateSchema,
  checkinSourceSchema,
  isoDateSchema,
} from './schemas';
import {
  assignCabinet,
  cancelAppointment,
  CheckinAppointmentNotFound,
  CheckinWindowError,
  createCabinet,
  createAppointment,
  deleteCabinet,
  getAppointment,
  getCabinet,
  listAppointments,
  listCabinetEvents,
  listCabinets,
  listStatusEvents,
  publicCheckin,
  toAppointmentDto,
  toCabinetDto,
  transitionAppointment,
  updateAppointment,
  updateAppointmentTreatmentNote,
  updateCabinet,
  validatePatientAccess,
  validateProfessionalAccess,
} from './service';
import {
  buildCheckinUrl,
  CheckinConfigError,
  CheckinTokenError,
  mintCheckinToken,
  renderCheckinQr,
  verifyCheckinToken,
} from './checkin';
import { buildAppointmentIcs } from './ics';
import { kanbanDaySnapshot } from './kanban';

export const agendaRouter = Router();

const uuid = z.string().uuid();

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function queryInt(req: Request, key: string, fallback: number): number {
  const parsed = Number.parseInt(queryString(req, key) ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Rendez-vous
// ---------------------------------------------------------------------------

agendaRouter.get(
  '/appointments',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.read'),
  async (req, res) => {
    const order = queryString(req, 'order') ?? 'asc';
    if (order !== 'asc' && order !== 'desc') {
      throw unprocessable("Invalid order. Use 'asc' or 'desc'.");
    }

    const page = Math.max(queryInt(req, 'page', 1), 1);
    const pageSize = Math.min(Math.max(queryInt(req, 'page_size', 100), 1), 500);

    const professionalId = queryString(req, 'professional_id');
    const patientId = queryString(req, 'patient_id');
    if (professionalId) uuid.parse(professionalId);
    if (patientId) uuid.parse(patientId);

    const result = await listAppointments(req.clinicId!, req.clinic!.timezone, {
      startDate: queryString(req, 'start_date') ?? null,
      endDate: queryString(req, 'end_date') ?? null,
      cabinet: queryString(req, 'cabinet') ?? null,
      professionalId: professionalId ?? null,
      patientId: patientId ?? null,
      status: queryString(req, 'status') ?? null,
      page,
      pageSize,
      order,
    });

    res.json(paginated(result.rows, result.total, page, pageSize));
  },
);

agendaRouter.post(
  '/appointments',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.write'),
  async (req, res) => {
    const input = appointmentCreateSchema.parse(req.body);

    if (input.patient_id && !(await validatePatientAccess(req.clinicId!, input.patient_id))) {
      throw notFound('Patient not found');
    }
    if (!(await validateProfessionalAccess(req.clinicId!, input.professional_id))) {
      throw unprocessable(
        'Invalid professional: must be a dentist or hygienist in this clinic',
      );
    }

    const appointment = await createAppointment(req.clinicId!, req.user!.id, req.clinic!.timezone, {
      patientId: input.patient_id,
      professionalId: input.professional_id,
      cabinetId: input.cabinet_id,
      cabinet: input.cabinet,
      startTime: input.start_time,
      endTime: input.end_time,
      treatmentType: input.treatment_type,
      color: input.color,
      plannedItemIds: input.planned_item_ids,
    });

    res.status(201).json(ok(toAppointmentDto(appointment, req.clinic!.timezone)));
  },
);

// Export iCalendar — déclaré AVANT `/appointments/:appointmentId` :
// Express ferait sinon correspondre « <uuid>.ics » au paramètre.
agendaRouter.get(
  '/appointments/:appointmentId.ics',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.read'),
  async (req, res) => {
    const appointmentId = uuid.parse(req.params.appointmentId);
    const appointment = await getAppointment(req.clinicId!, appointmentId);
    if (!appointment) throw notFound('Appointment not found');
    const ics = buildAppointmentIcs(appointment, req.clinic!);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="appointment-${appointment.id}.ics"`,
    );
    res.type('text/calendar; charset=utf-8').send(ics);
  },
);

agendaRouter.get(
  '/appointments/:appointmentId',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.read'),
  async (req, res) => {
    const appointmentId = uuid.parse(req.params.appointmentId);
    const appointment = await getAppointment(req.clinicId!, appointmentId);
    if (!appointment) throw notFound('Appointment not found');
    const history = await listStatusEvents(req.clinicId!, appointmentId);
    res.json(ok(toAppointmentDto(appointment, req.clinic!.timezone, history)));
  },
);

agendaRouter.put(
  '/appointments/:appointmentId',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.write'),
  async (req, res) => {
    const appointmentId = uuid.parse(req.params.appointmentId);
    const current = await getAppointment(req.clinicId!, appointmentId);
    if (!current) throw notFound('Appointment not found');

    const input = appointmentUpdateSchema.parse(req.body);

    if (input.patient_id && !(await validatePatientAccess(req.clinicId!, input.patient_id))) {
      throw notFound('Patient not found');
    }
    if (
      input.professional_id
      && !(await validateProfessionalAccess(req.clinicId!, input.professional_id))
    ) {
      throw unprocessable('Invalid professional: must be a dentist or hygienist in this clinic');
    }

    const updated = await updateAppointment(current, req.clinic!.timezone, req.user!.id, {
      patientId: input.patient_id,
      professionalId: input.professional_id,
      cabinetId: input.cabinet_id,
      cabinet: input.cabinet,
      startTime: input.start_time,
      endTime: input.end_time,
      treatmentType: input.treatment_type,
      status: input.status,
      color: input.color,
      plannedItemIds: input.planned_item_ids,
      cabinetTouched:
        Object.prototype.hasOwnProperty.call(input, 'cabinet_id')
        || Object.prototype.hasOwnProperty.call(input, 'cabinet'),
    });

    res.json(ok(toAppointmentDto(updated, req.clinic!.timezone)));
  },
);

agendaRouter.delete(
  '/appointments/:appointmentId',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.write'),
  async (req, res) => {
    const appointmentId = uuid.parse(req.params.appointmentId);
    const appointment = await getAppointment(req.clinicId!, appointmentId);
    if (!appointment) throw notFound('Appointment not found');
    await cancelAppointment(appointment, req.user!.id);
    res.status(204).end();
  },
);

agendaRouter.post(
  '/appointments/:appointmentId/transitions',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.write'),
  async (req, res) => {
    const appointmentId = uuid.parse(req.params.appointmentId);
    const current = await getAppointment(req.clinicId!, appointmentId);
    if (!current) throw notFound('Appointment not found');

    const input = appointmentTransitionSchema.parse(req.body);
    const updated = await transitionAppointment(
      current,
      input.to_status,
      req.user!.id,
      input.note,
    );
    const history = await listStatusEvents(req.clinicId!, appointmentId);
    res.json(ok(toAppointmentDto(updated, req.clinic!.timezone, history)));
  },
);

agendaRouter.get(
  '/appointments/:appointmentId/transitions',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.read'),
  async (req, res) => {
    const appointmentId = uuid.parse(req.params.appointmentId);
    const events = await listStatusEvents(req.clinicId!, appointmentId);
    res.json(ok(events));
  },
);

agendaRouter.get(
  '/appointments/:appointmentId/cabinet-history',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.read'),
  async (req, res) => {
    const appointmentId = uuid.parse(req.params.appointmentId);
    const events = await listCabinetEvents(req.clinicId!, appointmentId);
    res.json(ok(events));
  },
);

agendaRouter.patch(
  '/appointments/:appointmentId/cabinet',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.write'),
  async (req, res) => {
    const appointmentId = uuid.parse(req.params.appointmentId);
    const current = await getAppointment(req.clinicId!, appointmentId);
    if (!current) throw notFound('Appointment not found');

    const input = cabinetAssignmentSchema.parse(req.body);
    const updated = await assignCabinet(
      current,
      req.clinicId!,
      req.user!.id,
      input.cabinet_id ?? null,
      input.note,
    );
    res.json(ok(toAppointmentDto(updated, req.clinic!.timezone)));
  },
);

// ---------------------------------------------------------------------------
// Kanban — snapshot opérationnel de la journée (issue #51)
// ---------------------------------------------------------------------------

agendaRouter.get(
  '/kanban/day',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.read'),
  async (req, res) => {
    const rawDate = queryString(req, 'date');
    const target = rawDate === undefined ? undefined : isoDateSchema.parse(rawDate);
    res.json(
      ok(await kanbanDaySnapshot(req.clinicId!, req.clinic!.timezone, target)),
    );
  },
);

// ---------------------------------------------------------------------------
// Note clinique au niveau de la visite
// ---------------------------------------------------------------------------

agendaRouter.patch(
  '/appointment-treatments/:appointmentTreatmentId',
  authenticate,
  requireClinic,
  requirePermission('clinical_notes.notes.write'),
  async (req, res) => {
    const appointmentTreatmentId = uuid.parse(req.params.appointmentTreatmentId);
    const input = appointmentTreatmentNoteSchema.parse(req.body);
    const updated = await updateAppointmentTreatmentNote(
      req.clinicId!,
      appointmentTreatmentId,
      input,
    );
    if (!updated) throw notFound('Appointment treatment not found');
    res.json(ok(updated));
  },
);

// ---------------------------------------------------------------------------
// QR check-in (ADR 0037) — émission réservée au staff, consommation publique
// ---------------------------------------------------------------------------

agendaRouter.post(
  '/appointments/:appointmentId/check-in-token',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.write'),
  async (req, res) => {
    const appointmentId = uuid.parse(req.params.appointmentId);
    const appointment = await getAppointment(req.clinicId!, appointmentId);
    if (!appointment) throw notFound('Appointment not found');

    const source = checkinSourceSchema.parse(queryString(req, 'source') ?? 'counter');
    const { token, expiresAt } = mintCheckinToken(appointment.id, req.clinicId!, source);
    let url: string;
    try {
      url = buildCheckinUrl(token);
    } catch (error) {
      if (error instanceof CheckinConfigError) throw unprocessable(error.message);
      throw error;
    }
    res.json(ok({ token, expires_at: expiresAt.toISOString(), url }));
  },
);

agendaRouter.get(
  '/appointments/:appointmentId/check-in-qr',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.write'),
  async (req, res) => {
    const appointmentId = uuid.parse(req.params.appointmentId);
    const appointment = await getAppointment(req.clinicId!, appointmentId);
    if (!appointment) throw notFound('Appointment not found');

    const { token } = mintCheckinToken(appointment.id, req.clinicId!, 'counter');
    let png: Buffer;
    try {
      png = await renderCheckinQr(buildCheckinUrl(token));
    } catch (error) {
      if (error instanceof CheckinConfigError) throw unprocessable(error.message);
      throw error;
    }
    res.type('image/png').send(png);
  },
);

const checkinIpLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: false,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ detail: 'Too many requests' });
  },
});

const checkinTokenLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => `checkin:${req.params.token ?? ''}`,
  handler: (_req, res) => {
    res.status(429).json({ detail: 'Too many requests' });
  },
});

agendaRouter.post(
  '/public/check-in/:token',
  checkinIpLimiter,
  checkinTokenLimiter,
  async (req, res) => {
    let appointmentId: string;
    let clinicId: string;
    try {
      [appointmentId, clinicId] = verifyCheckinToken(String(req.params.token));
    } catch (error) {
      if (error instanceof CheckinTokenError) throw unauthorized(error.message);
      throw error;
    }

    let result: { id: string; status: string };
    try {
      result = await publicCheckin(appointmentId, clinicId);
    } catch (error) {
      if (error instanceof CheckinAppointmentNotFound) {
        throw notFound('Appointment not found');
      }
      if (error instanceof CheckinWindowError) {
        const detail =
          error.code === 'window_closed'
            ? 'window_closed'
            : `${error.code}:${error.localStart}`;
        throw unprocessable(detail);
      }
      throw error;
    }
    res.json(ok({ appointment_id: result.id, status: result.status }));
  },
);

// ---------------------------------------------------------------------------
// Cabinets
// ---------------------------------------------------------------------------

agendaRouter.get(
  '/cabinets',
  authenticate,
  requireClinic,
  requirePermission('agenda.cabinets.read'),
  async (req, res) => {
    const rows = await listCabinets(req.clinicId!);
    res.json(ok(rows.map(toCabinetDto)));
  },
);

agendaRouter.post(
  '/cabinets',
  authenticate,
  requireClinic,
  requirePermission('agenda.cabinets.write'),
  async (req, res) => {
    const input = cabinetCreateSchema.parse(req.body);
    const cabinet = await createCabinet(req.clinicId!, input);
    res.status(201).json(ok(toCabinetDto(cabinet)));
  },
);

agendaRouter.put(
  '/cabinets/:cabinetId',
  authenticate,
  requireClinic,
  requirePermission('agenda.cabinets.write'),
  async (req, res) => {
    const cabinetId = uuid.parse(req.params.cabinetId);
    const cabinet = await getCabinet(req.clinicId!, cabinetId);
    if (!cabinet) throw notFound('Cabinet not found');
    const input = cabinetUpdateSchema.parse(req.body);
    const updated = await updateCabinet(cabinet, input);
    res.json(ok(toCabinetDto(updated)));
  },
);

agendaRouter.delete(
  '/cabinets/:cabinetId',
  authenticate,
  requireClinic,
  requirePermission('agenda.cabinets.write'),
  async (req, res) => {
    const cabinetId = uuid.parse(req.params.cabinetId);
    const cabinet = await getCabinet(req.clinicId!, cabinetId);
    if (!cabinet) throw notFound('Cabinet not found');
    await deleteCabinet(cabinet);
    res.status(204).end();
  },
);
