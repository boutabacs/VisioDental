import jwt from 'jsonwebtoken';

import { config } from '../../config';
import { toZonedIso } from '../../lib/time';
import { formatDayMonthYear, formatHourMinute } from './helpers';
import { enqueue } from './service';
import { prisma } from '../../lib/prisma';

/**
 * Tâches périodiques du module notifications — port de `tasks.py`.
 *
 * Rien n'est démarré ici : `notificationsRouter` n'enregistre aucun timer.
 * Les fonctions ci-dessous sont les points d'entrée à appeler depuis le
 * planificateur du serveur (là où `src/app.ts` est assemblé), par exemple :
 *
 * ```ts
 * // toutes les 45 s — envoi de la file d'attente (I/O réseau hors requête)
 * setInterval(() => { void dispatchOutboxTick(); }, 45_000);
 * // toutes les 5 min — rappels de rendez-vous
 * setInterval(() => { void processAppointmentReminders(); }, 5 * 60_000);
 * ```
 *
 * ou, en process séparé, depuis un cron (`node -e "require('./dist/...').dispatchOutboxTick()"`).
 * Chaque fonction ouvre son propre cycle Prisma et n'échoue jamais bruyamment
 * (erreur loguée, tick suivant).
 */

const DEFAULT_TIMEZONE = 'Europe/Madrid';

/** Équivalent `dispatch_outbox` (job) : un lot de messages dus. */
export async function dispatchOutboxTick(): Promise<number> {
  const { dispatchOutbox } = await import('./service');
  try {
    const attempted = await dispatchOutbox();
    if (attempted > 0) {
      console.debug(`[notifications] outbox dispatch tick processed ${attempted} message(s)`);
    }
    return attempted;
  } catch (error) {
    console.error('[notifications] outbox dispatch tick failed:', error);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Check-in link (ADR 0037)
// ---------------------------------------------------------------------------

function checkinSecret(): string {
  const key = (process.env.AGENDA_PUBLIC_SECRET_KEY ?? '').trim();
  if (key) return key;
  if (config.isProduction) {
    throw new Error(
      'AGENDA_PUBLIC_SECRET_KEY is required in production: refusing to sign QR check-in tokens with the staff-JWT key.',
    );
  }
  return config.secretKey;
}

/** `build_checkin_url` : première origine autorisée (app patient). */
export function buildCheckinUrl(token: string): string {
  const origin = config.allowedOrigins[0];
  if (!origin) throw new Error('Set ALLOWED_ORIGINS to render check-in QR codes');
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('ALLOWED_ORIGINS must hold http(s) origins');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.host) {
    throw new Error('ALLOWED_ORIGINS must hold http(s) origins');
  }
  return `${parsed.protocol}//${parsed.host}/p/check-in/${token}`;
}

/** `mint_checkin_token(source="reminder")` → URL patient, ou `null`. */
function reminderCheckinUrl(
  appointment: { id: string; clinic_id: string; start_time: Date },
  timeZone: string,
): string | null {
  try {
    const now = new Date();
    const dayEnd = new Date(appointment.start_time);
    // Fin de journée locale de la clinique (23:59:59) en instant UTC.
    const localDay = toZonedIso(dayEnd, timeZone);
    const dayEndLocal = new Date(
      `${localDay.slice(0, 10)}T23:59:59${localDay.slice(19)}`,
    );
    const ttlMinutes = Math.max(
      60,
      Math.floor((dayEndLocal.getTime() - now.getTime()) / 60000),
    );
    const token = jwt.sign(
      {
        type: 'checkin',
        appointment_id: appointment.id,
        clinic_id: appointment.clinic_id,
        source: 'reminder',
        exp: Math.floor(now.getTime() / 1000) + ttlMinutes * 60,
      },
      checkinSecret(),
      { algorithm: 'HS256' },
    );
    return buildCheckinUrl(token);
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    if (message.startsWith('Set ALLOWED_ORIGINS') || message.startsWith('ALLOWED_ORIGINS')) {
      console.warn('[notifications] Reminder check-in link skipped: no public origin configured');
    } else {
      console.error(`[notifications] Reminder check-in link skipped by unexpected error: ${message}`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Appointment reminders
// ---------------------------------------------------------------------------

type ReminderContext = Record<string, unknown>;

async function appointmentReminderContext(
  appointment: {
    id: string;
    clinic_id: string;
    patient_id: string | null;
    professional_id: string | null;
    start_time: Date;
  },
  patient: { id: string; first_name: string; last_name: string } | null,
  clinic: {
    name: string;
    phone: string | null;
    address: unknown;
    timezone: string | null;
  } | null,
): Promise<ReminderContext> {
  let professionalName: string | null = null;
  if (appointment.professional_id) {
    const professional = await prisma.users.findUnique({
      where: { id: appointment.professional_id },
      select: { first_name: true, last_name: true },
    });
    if (professional) professionalName = `${professional.first_name} ${professional.last_name}`;
  }
  const timeZone = clinic?.timezone || DEFAULT_TIMEZONE;
  return {
    patient_name: patient ? `${patient.first_name} ${patient.last_name}` : null,
    appointment_date: formatDayMonthYear(appointment.start_time),
    appointment_time: formatHourMinute(appointment.start_time),
    professional_name: professionalName,
    clinic_name: clinic?.name ?? 'VisioDental',
    clinic_phone: clinic?.phone ?? null,
    clinic_address: clinic?.address ?? null,
    appointment_id: appointment.id,
    checkin_url: reminderCheckinUrl(appointment, timeZone),
  };
}

/**
 * `process_appointment_reminders` : cabinet avec `appointment_reminder`
 * activé + `auto_send`, rendez-vous `scheduled` dans `(now, now + hours_before]`,
 * dédoublonné par `dedup_key = appointment_reminder:<id>`.
 */
export async function processAppointmentReminders(): Promise<{
  sent: number;
  skipped: number;
}> {
  let sent = 0;
  let skipped = 0;
  try {
    const allSettings = await prisma.clinic_notification_settings.findMany();
    for (const clinicSettings of allSettings) {
      const reminderConfig = (clinicSettings.settings ?? {}) as Record<string, unknown>;
      const typeConfig = (reminderConfig.appointment_reminder ?? {}) as Record<string, unknown>;
      if (!(typeConfig.enabled ?? true)) continue;
      if (!(typeConfig.auto_send ?? true)) continue;
      const hoursRaw = typeConfig.hours_before;
      const hoursBefore = typeof hoursRaw === 'number' ? hoursRaw : 24;

      const clinicId = clinicSettings.clinic_id;
      const now = new Date();
      const windowEnd = new Date(now.getTime() + hoursBefore * 3600_000);
      const appointments = await prisma.appointments.findMany({
        where: {
          clinic_id: clinicId,
          status: 'scheduled',
          start_time: { gt: now, lte: windowEnd },
        },
      });
      if (appointments.length === 0) continue;

      const clinic = await prisma.clinics.findUnique({ where: { id: clinicId } });

      for (const appointment of appointments) {
        const patient = appointment.patient_id
          ? await prisma.patients.findFirst({
              where: { id: appointment.patient_id, clinic_id: clinicId },
            })
          : null;
        // Seuls les patients sans aucun contact sont écartés : le gateway
        // choisit email ou téléphone selon le canal préféré du cabinet.
        if (!patient || (!patient.email && !patient.phone)) {
          skipped += 1;
          continue;
        }
        const context = await appointmentReminderContext(appointment, patient, clinic);
        const message = await enqueue({
          clinicId,
          notificationType: 'appointment_reminder',
          context,
          patientId: patient.id,
          triggeredByEvent: 'scheduler.appointment_reminder',
          forceSend: true,
          dedupKey: `appointment_reminder:${appointment.id}`,
        });
        if (message === null || message.status === 'skipped') {
          skipped += 1;
        } else {
          sent += 1;
          console.info(
            `[notifications] Queued reminder for appointment ${appointment.id} via ${message.channel}`,
          );
        }
      }
    }
    if (sent > 0 || skipped > 0) {
      console.info(`[notifications] Reminder job complete: ${sent} sent, ${skipped} skipped`);
    }
  } catch (error) {
    console.error('[notifications] Error processing appointment reminders:', error);
  }
  return { sent, skipped };
}

/** `send_single_reminder` : rappel manuel d'un rendez-vous (sans auto_send). */
export async function sendSingleReminder(
  appointmentId: string,
  clinicId: string,
): Promise<boolean> {
  try {
    const appointment = await prisma.appointments.findFirst({
      where: { id: appointmentId, clinic_id: clinicId },
    });
    if (!appointment) {
      console.error(`[notifications] Appointment not found: ${appointmentId}`);
      return false;
    }
    const patient = appointment.patient_id
      ? await prisma.patients.findFirst({
          where: { id: appointment.patient_id, clinic_id: clinicId },
        })
      : null;
    if (!patient || (!patient.email && !patient.phone)) {
      console.warn(`[notifications] Patient has no email or phone for appointment: ${appointmentId}`);
      return false;
    }
    const clinic = await prisma.clinics.findUnique({ where: { id: clinicId } });
    const context = await appointmentReminderContext(appointment, patient, clinic);
    const message = await enqueue({
      clinicId,
      notificationType: 'appointment_reminder',
      context,
      patientId: patient.id,
      triggeredByEvent: 'manual.appointment_reminder',
      forceSend: true,
      dedupKey: `appointment_reminder:${appointment.id}`,
    });
    return message !== null && message.status !== 'skipped';
  } catch (error) {
    console.error('[notifications] Error sending single reminder:', error);
    return false;
  }
}
