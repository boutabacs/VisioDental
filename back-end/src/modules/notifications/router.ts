import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { prisma } from '../../lib/prisma';
import { ok, paginated } from '../../lib/http';
import {
  ApiError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from '../../lib/errors';
import { parseClinicDate } from '../../lib/time';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import { config } from '../../config';
import {
  clinicNotificationSettingsUpdateSchema,
  conversationReplySchema,
  emailTemplateCreateSchema,
  emailTemplateUpdateSchema,
  manualSendSchema,
  notificationPreferenceUpdateSchema,
  pushPatientRedeemSchema,
  pushSubscribeTokenCreateSchema,
  pushSubscriptionCreateSchema,
  smtpSettingsUpdateSchema,
  smtpTestSchema,
  testEmailSchema,
} from './schemas';
import {
  asRecord,
  asStringArray,
  availableChannels,
  createTemplate,
  deleteTemplate,
  enqueue,
  getOrCreateClinicSettings,
  getOrCreatePatientPreferences,
  getOrCreateSmtpSettings,
  getPatientPreferences,
  getSmtpSettings,
  getTemplate,
  getTemplateById,
  listConversation,
  listLogs,
  listTemplates,
  testEmailConnection,
  testSmtpSettings,
  toConversationMessageDto,
  toEmailLogDto,
  toEmailTemplateDto,
  toNotificationPreferenceDto,
  toPushSubscriptionDto,
  updateClinicSettings,
  updatePatientPreferences,
  updateSmtpSettings,
  updateTemplate,
} from './service';
import { budgetTreatmentsContext } from './budget-context';
import { TemplateModificationError } from './service';
import { vapidPublicKey, vapidSettingsFromEnv } from './push';
import {
  LookupErrorLike,
  ValueErrorLike,
  listPushSubscriptions,
  mintSubscribeToken,
  redeemSubscribeToken,
  subscribe,
  unsubscribe,
  validateSubscribeToken,
} from './push-service';

/**
 * Routes du module notifications — port de `router.py` + `public_router.py`.
 *
 * Le module Python monte les deux routeurs sous `/api/v1/notifications` ; on
 * reproduit donc les routes publiques sous `/public/push/...` dans le même
 * routeur, sans middleware d'authentification (le jeton est l'authentifiant).
 */
export const notificationsRouter = Router();

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

// ---------------------------------------------------------------------------
// Helpers de requête (parité avec les types Query/Path de FastAPI)
// ---------------------------------------------------------------------------

/** Erreur de paramètre comme FastAPI : 400 pour un UUID mal formé. */
export class InvalidParameterError extends Error {
  public readonly status: number;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidParameterError';
    this.status = 400;
  }
}

function single(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** `page: int = Query(1, ge=1)` — une valeur invalide renvoie 422. */
function intQuery(req: Request, name: string, fallback: number): number {
  const raw = single(req.query[name]);
  if (raw === undefined || raw === '') return fallback;
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    throw unprocessable(`Input should be a valid integer, unable to parse string as an integer`);
  }
  return Number.parseInt(raw, 10);
}

/** `str | None = Query(None, max_length=n)`. */
function strQuery(req: Request, name: string, maxLength: number): string | null {
  const raw = single(req.query[name]);
  if (raw === undefined) return null;
  if (raw.length > maxLength) {
    throw unprocessable(
      `String should have at most ${maxLength} characters`,
    );
  }
  return raw;
}

/** `bool = Query(default)` — FastAPI accepte true/false/1/0/yes/no/on/off. */
function boolQuery(req: Request, name: string, fallback: boolean): boolean {
  const raw = single(req.query[name]);
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 't', 'y'].includes(value)) return true;
  if (['false', '0', 'no', 'off', 'f', 'n'].includes(value)) return false;
  throw unprocessable('Input should be a valid boolean, unable to interpret input');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Paramètre de route `UUID` de FastAPI : format invalide → 400. */
function uuidParam(req: Request, name: string): string {
  const raw = single(req.params[name]);
  if (!raw || !UUID_RE.test(raw)) {
    throw new InvalidParameterError(`Invalid ${name.replace(/_id$/, '')} identifier`);
  }
  return raw.toLowerCase();
}

/** Valide le corps avec un schéma zod (échec → 422 `{detail}`). */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  try {
    return schema.parse(body ?? {});
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      throw unprocessable(issue ? issue.message : 'Invalid request body');
    }
    throw error;
  }
}

function clinicIdOf(req: Request): string {
  return req.clinicId!;
}

/** 404 sauf si le patient appartient à la clinique courante. */
async function ensureClinicPatient(clinicId: string, patientId: string): Promise<void> {
  const found = await prisma.patients.findFirst({
    where: { id: patientId, clinic_id: clinicId },
    select: { id: true },
  });
  if (!found) throw notFound('Patient not found');
}

interface SettingsRow {
  id: string;
  clinic_id: string;
  preferred_channel: string;
  fallback_enabled: boolean;
  sms_daily_limit: number;
  manual_channels: unknown;
  settings: unknown;
  created_at: Date;
  updated_at: Date;
}

function settingsResponse(settings: SettingsRow, available: string[]) {
  return {
    id: settings.id,
    clinic_id: settings.clinic_id,
    preferred_channel: settings.preferred_channel,
    fallback_enabled: settings.fallback_enabled,
    sms_daily_limit: settings.sms_daily_limit,
    manual_channels: asStringArray(settings.manual_channels),
    settings: asRecord(settings.settings),
    available_channels: available,
    created_at: settings.created_at.toISOString(),
    updated_at: settings.updated_at.toISOString(),
  };
}

interface SmtpRow {
  provider: string;
  host: string | null;
  port: number;
  username: string | null;
  password_encrypted: string | null;
  use_tls: boolean;
  use_ssl: boolean;
  from_email: string | null;
  from_name: string | null;
  is_active: boolean;
  is_verified: boolean;
  last_verified_at: Date | null;
}

/** Le mot de passe ne sort jamais : seulement `has_password`. */
function smtpResponse(settings: SmtpRow) {
  return {
    provider: settings.provider,
    host: settings.host,
    port: settings.port,
    username: settings.username,
    has_password: Boolean(settings.password_encrypted),
    use_tls: settings.use_tls,
    use_ssl: settings.use_ssl,
    from_email: settings.from_email,
    from_name: settings.from_name,
    is_active: settings.is_active,
    is_verified: settings.is_verified,
    last_verified_at: settings.last_verified_at ? settings.last_verified_at.toISOString() : null,
  };
}

/**
 * Encapsule un handler async : erreurs converties au format FastAPI.
 * - `InvalidParameterError` (paramètre `UUID` mal formé) → 400 `{detail}` ;
 * - `TemplateModificationError` (`ValueError` côté Python) → 400 `{detail}` ;
 * - le reste part au gestionnaire global (`ApiError`, Prisma, 500).
 */
function route(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch((error) => {
      if (error instanceof InvalidParameterError) {
        res.status(error.status).json({ detail: error.message });
        return;
      }
      if (error instanceof TemplateModificationError) {
        res.status(400).json({ detail: error.message });
        return;
      }
      next(error);
    });
  };
}

// ---------------------------------------------------------------------------
// Authentification commune
// ---------------------------------------------------------------------------

const staff = [authenticate, requireClinic];

// ===========================================================================
// Templates email
// ===========================================================================

notificationsRouter.get(
  '/templates',
  ...staff,
  requirePermission('notifications.templates.read'),
  route(async (req, res) => {
    const page = intQuery(req, 'page', 1);
    if (page < 1) throw unprocessable('Input should be greater than or equal to 1');
    const pageSize = intQuery(req, 'page_size', PAGE_SIZE_DEFAULT);
    if (pageSize < 1) throw unprocessable('Input should be greater than or equal to 1');
    if (pageSize > PAGE_SIZE_MAX) {
      throw unprocessable('Input should be less than or equal to 100');
    }
    const locale = strQuery(req, 'locale', 5);
    const includeSystem = boolQuery(req, 'include_system', true);
    const { rows, total } = await listTemplates(clinicIdOf(req), {
      page,
      pageSize,
      locale,
      includeSystem,
    });
    res.json(paginated(rows.map(toEmailTemplateDto), total, page, pageSize));
  }),
);

notificationsRouter.get(
  '/templates/:template_id',
  ...staff,
  requirePermission('notifications.templates.read'),
  route(async (req, res) => {
    const template = await getTemplateById(clinicIdOf(req), uuidParam(req, 'template_id'));
    if (!template) throw notFound('Template not found');
    res.json(ok(toEmailTemplateDto(template)));
  }),
);

notificationsRouter.post(
  '/templates',
  ...staff,
  requirePermission('notifications.templates.write'),
  route(async (req, res) => {
    const data = parseBody(emailTemplateCreateSchema, req.body);
    const clinicId = clinicIdOf(req);
    const existing = await getTemplate(clinicId, data.template_key, data.locale, data.channel);
    if (existing && existing.clinic_id === clinicId) {
      throw conflict(
        `Template '${data.template_key}' for locale '${data.locale}' already exists`,
      );
    }
    const template = await createTemplate(clinicId, data);
    res.status(201).json(ok(toEmailTemplateDto(template)));
  }),
);

notificationsRouter.put(
  '/templates/:template_id',
  ...staff,
  requirePermission('notifications.templates.write'),
  route(async (req, res) => {
    const data = parseBody(emailTemplateUpdateSchema, req.body);
    const clinicId = clinicIdOf(req);
    const template = await getTemplateById(clinicId, uuidParam(req, 'template_id'));
    if (!template) throw notFound('Template not found');
    if (template.is_system) throw forbidden('Cannot modify system templates');
    if (template.clinic_id !== clinicId) {
      throw forbidden('Cannot modify templates from other clinics');
    }
    const updated = await updateTemplate(template, data);
    res.json(ok(toEmailTemplateDto(updated)));
  }),
);

notificationsRouter.delete(
  '/templates/:template_id',
  ...staff,
  requirePermission('notifications.templates.write'),
  route(async (req, res) => {
    const clinicId = clinicIdOf(req);
    const template = await getTemplateById(clinicId, uuidParam(req, 'template_id'));
    if (!template) throw notFound('Template not found');
    if (template.is_system) throw forbidden('Cannot delete system templates');
    if (template.clinic_id !== clinicId) {
      throw forbidden('Cannot delete templates from other clinics');
    }
    await deleteTemplate(template);
    res.status(204).end();
  }),
);

// ===========================================================================
// Préférences patient
// ===========================================================================

notificationsRouter.get(
  '/preferences/patient/:patient_id',
  ...staff,
  requirePermission('notifications.preferences.read'),
  route(async (req, res) => {
    const clinicId = clinicIdOf(req);
    const patientId = uuidParam(req, 'patient_id');
    await ensureClinicPatient(clinicId, patientId);
    const prefs = await getOrCreatePatientPreferences(clinicId, patientId);
    res.json(ok(toNotificationPreferenceDto(prefs)));
  }),
);

notificationsRouter.put(
  '/preferences/patient/:patient_id',
  ...staff,
  requirePermission('notifications.preferences.write'),
  route(async (req, res) => {
    const data = parseBody(notificationPreferenceUpdateSchema, req.body);
    const clinicId = clinicIdOf(req);
    const patientId = uuidParam(req, 'patient_id');
    await ensureClinicPatient(clinicId, patientId);
    const prefs = await updatePatientPreferences(clinicId, patientId, data);
    res.json(ok(toNotificationPreferenceDto(prefs)));
  }),
);

// ===========================================================================
// Réglages du cabinet
// ===========================================================================

notificationsRouter.get(
  '/settings',
  ...staff,
  requirePermission('notifications.settings.read'),
  route(async (req, res) => {
    const clinicId = clinicIdOf(req);
    const settings = await getOrCreateClinicSettings(clinicId);
    const available = await availableChannels(clinicId);
    res.json(ok(settingsResponse(settings, available)));
  }),
);

notificationsRouter.put(
  '/settings',
  ...staff,
  requirePermission('notifications.settings.write'),
  route(async (req, res) => {
    const data = parseBody(clinicNotificationSettingsUpdateSchema, req.body);
    const clinicId = clinicIdOf(req);
    const current = await getOrCreateClinicSettings(clinicId);
    const available = await availableChannels(clinicId);

    if (data.preferred_channel != null && !available.includes(data.preferred_channel)) {
      throw unprocessable(
        `preferred_channel '${data.preferred_channel}' is not available ` +
          `for this clinic (available: ${JSON.stringify(available)})`,
      );
    }

    const manual = data.manual_channels;
    if (manual != null) {
      const unavailable = manual.filter((channel) => !available.includes(channel));
      if (unavailable.length > 0) {
        throw unprocessable(
          `manual_channels ${JSON.stringify(unavailable)} are not available ` +
            `for this clinic (available: ${JSON.stringify(available)})`,
        );
      }
    }

    // Invariant : le canal préféré est toujours un canal manuel, pour que le
    // personnel puisse renvoyer sur le même rail. Ajouté s'il manque.
    const preferred = data.preferred_channel ?? current.preferred_channel;
    const effectiveManual = manual != null ? [...manual] : asStringArray(current.manual_channels);
    const patch = { ...data };
    if (!effectiveManual.includes(preferred)) {
      patch.manual_channels = [preferred, ...effectiveManual];
    }

    const settings = await updateClinicSettings(clinicId, patch);
    res.json(ok(settingsResponse(settings, available)));
  }),
);

// ===========================================================================
// Journal des communications
// ===========================================================================

notificationsRouter.get(
  '/logs',
  ...staff,
  requirePermission('notifications.logs.read'),
  route(async (req, res) => {
    const page = intQuery(req, 'page', 1);
    if (page < 1) throw unprocessable('Input should be greater than or equal to 1');
    const pageSize = intQuery(req, 'page_size', PAGE_SIZE_DEFAULT);
    if (pageSize < 1) throw unprocessable('Input should be greater than or equal to 1');
    if (pageSize > PAGE_SIZE_MAX) {
      throw unprocessable('Input should be less than or equal to 100');
    }
    const patientIdRaw = single(req.query.patient_id);
    let patientId: string | null = null;
    if (patientIdRaw !== undefined && patientIdRaw !== '') {
      if (!UUID_RE.test(patientIdRaw)) {
        throw unprocessable('Input should be a valid UUID');
      }
      patientId = patientIdRaw.toLowerCase();
    }
    const status = strQuery(req, 'status', 20);
    const templateKey = strQuery(req, 'template_key', 100);
    const { rows, total } = await listLogs(clinicIdOf(req), {
      page,
      pageSize,
      patientId,
      status,
      templateKey,
    });
    res.json(paginated(rows.map(toEmailLogDto), total, page, pageSize));
  }),
);

// ===========================================================================
// Envoi manuel
// ===========================================================================

const APPOINTMENT_TYPES = new Set([
  'appointment_confirmation',
  'appointment_reminder',
  'appointment_cancelled',
]);
const BUDGET_TYPES = new Set(['budget_sent', 'budget_accepted']);

notificationsRouter.post(
  '/send',
  ...staff,
  requirePermission('notifications.send'),
  route(async (req, res) => {
    const data = parseBody(manualSendSchema, req.body);
    const clinicId = clinicIdOf(req);

    let patient: {
      id: string;
      first_name: string;
      last_name: string;
      email: string | null;
      phone: string | null;
    } | null = null;
    let patientEmail: string | null = null;

    if (data.patient_id) {
      patient = await prisma.patients.findFirst({
        where: { id: data.patient_id, clinic_id: clinicId },
        select: { id: true, first_name: true, last_name: true, email: true, phone: true },
      });
      if (!patient) throw notFound('Patient not found');
      // Voie historique (sans `channels`) : l'email est le seul rail, donc un
      // email manquant est un 400. Avec des canaux explicites, le
      // destinataire est validé par canal ci-dessous.
      if (!data.channels && !patient.email) {
        throw badRequest('Patient has no email address');
      }
      patientEmail = patient.email;
    }

    const context: Record<string, unknown> = { ...(data.custom_context ?? {}) };
    if (patient) context.patient_name = `${patient.first_name} ${patient.last_name}`;

    const clinic = await prisma.clinics.findUnique({
      where: { id: clinicId },
      select: { name: true, phone: true, address: true, timezone: true },
    });
    if (clinic) {
      context.clinic_name = clinic.name;
      context.clinic_phone = clinic.phone;
      context.clinic_address = clinic.address;
    }
    const timeZone = clinic?.timezone ?? 'Europe/Madrid';

    if (APPOINTMENT_TYPES.has(data.notification_type)) {
      if (!data.appointment_id) {
        throw badRequest('appointment_id is required for appointment notifications');
      }
      const appointment = await prisma.appointments.findFirst({
        where: { id: data.appointment_id, clinic_id: clinicId },
      });
      if (!appointment) throw notFound('Appointment not found');

      const start = parseClinicDate(appointment.start_time, timeZone);
      context.appointment_date = start.toISOString().slice(0, 10).split('-').reverse().join('/');
      context.appointment_time = start.toISOString().slice(11, 16);

      if (appointment.professional_id) {
        const professional = await prisma.users.findUnique({
          where: { id: appointment.professional_id },
          select: { first_name: true, last_name: true },
        });
        if (professional) {
          context.professional_name = `${professional.first_name} ${professional.last_name}`;
        }
      }

      if (!patient && appointment.patient_id) {
        patient = await prisma.patients.findFirst({
          where: { id: appointment.patient_id, clinic_id: clinicId },
          select: { id: true, first_name: true, last_name: true, email: true, phone: true },
        });
        if (patient) {
          context.patient_name = `${patient.first_name} ${patient.last_name}`;
          patientEmail = patient.email;
        }
      }
    }

    if (BUDGET_TYPES.has(data.notification_type)) {
      if (!data.budget_id) {
        throw badRequest('budget_id is required for budget notifications');
      }
      const budget = await prisma.budgets.findFirst({
        where: { id: data.budget_id, clinic_id: clinicId },
      });
      if (!budget) throw notFound('Budget not found');

      const money = (value: { toString(): string } | null) =>
        value === null ? null : Number(value.toString());
      context.budget_number = budget.budget_number;
      context.budget_date = budget.valid_from
        ? parseClinicDate(budget.valid_from, timeZone).toISOString().slice(0, 10).split('-').reverse().join('/')
        : null;
      context.total = money(budget.total);
      context.subtotal = money(budget.subtotal);
      context.discount_amount = money(budget.total_discount);
      context.notes = budget.patient_notes;
      if (budget.valid_until && budget.valid_from) {
        const days = Math.floor(
          (parseClinicDate(budget.valid_until, timeZone).getTime() -
            parseClinicDate(budget.valid_from, timeZone).getTime()) /
            86_400_000,
        );
        context.validity_days = days;
      }
      if (data.notification_type === 'budget_accepted') {
        context.accepted_date = budget.updated_at
          ? parseClinicDate(budget.updated_at, timeZone)
              .toISOString()
              .slice(0, 10)
              .split('-')
              .reverse()
              .join('/')
          : null;
      }
      if (data.notification_type === 'budget_sent') {
        context.treatments = await budgetTreatmentsContext(clinicId, budget.id);
      }

      if (!patient && budget.patient_id) {
        patient = await prisma.patients.findFirst({
          where: { id: budget.patient_id, clinic_id: clinicId },
          select: { id: true, first_name: true, last_name: true, email: true, phone: true },
        });
        if (patient) {
          context.patient_name = `${patient.first_name} ${patient.last_name}`;
          patientEmail = patient.email;
        }
      }
    }

    if (data.channels) {
      // Destinataire par canal demandé : téléphone pour WhatsApp/SMS, email
      // pour email, le patient lui-même pour push (le gateway vérifie les
      // abonnements).
      const hasRecipient = data.channels.some(
        (channel) =>
          ((channel === 'whatsapp' || channel === 'sms') && patient !== null && patient.phone) ||
          (channel === 'email' && Boolean(patientEmail)) ||
          (channel === 'push' && patient !== null),
      );
      if (!hasRecipient) {
        throw badRequest('Patient has no contact address for the requested channels');
      }
    } else if (!patientEmail) {
      throw badRequest('Could not determine recipient email address');
    }

    // force_send : contourne auto_send (l'envoi est explicite). La livraison
    // se fait de manière asynchrone via la file (dispatchOutbox).
    const message = await enqueue({
      clinicId,
      notificationType: data.notification_type,
      context,
      patientId: patient ? patient.id : null,
      toAddress: patientEmail,
      channels: data.channels,
      triggeredByUserId: req.user?.id ?? null,
      forceSend: true,
    });

    if (message !== null && message.status === 'queued') {
      res.json(
        ok({ success: true, message: 'Notificación encolada para envío', log_id: message.id }),
      );
      return;
    }
    const reason = message?.error_message ?? 'no se pudo encolar';
    res.json(
      ok({
        success: false,
        message: `No se pudo enviar: ${reason}`,
        log_id: message ? message.id : null,
      }),
    );
  }),
);

// ===========================================================================
// Conversation patient
// ===========================================================================

notificationsRouter.get(
  '/channels',
  ...staff,
  requirePermission('notifications.logs.read'),
  route(async (req, res) => {
    res.json(ok({ available: await availableChannels(clinicIdOf(req)) }));
  }),
);

notificationsRouter.get(
  '/conversations/:patient_id',
  ...staff,
  requirePermission('notifications.logs.read'),
  route(async (req, res) => {
    const patientId = uuidParam(req, 'patient_id');
    const channel = strQuery(req, 'channel', 20);
    const rows = await listConversation(clinicIdOf(req), patientId, channel);
    res.json(ok(rows.map(toConversationMessageDto)));
  }),
);

notificationsRouter.post(
  '/conversations/:patient_id/reply',
  ...staff,
  requirePermission('notifications.send'),
  route(async (req, res) => {
    const data = parseBody(conversationReplySchema, req.body);
    const clinicId = clinicIdOf(req);
    const patientId = uuidParam(req, 'patient_id');
    await ensureClinicPatient(clinicId, patientId);
    const message = await enqueue({
      clinicId,
      notificationType: 'reply',
      context: {},
      patientId,
      channels: [data.channel],
      messageKind: 'session',
      bodyText: data.body,
      forceSend: true,
      triggeredByUserId: req.user?.id ?? null,
    });
    if (message === null || message.status === 'skipped') {
      const reason = message?.error_message ?? 'no se pudo enviar';
      // Le cas courant : la fenêtre de 24 h est fermée → il faut un template.
      throw conflict(
        'No se puede responder en texto libre: la ventana de 24h está ' +
          `cerrada o el canal no está disponible (${reason}).`,
      );
    }
    res.status(201).json(ok(toConversationMessageDto(message)));
  }),
);

// ===========================================================================
// SMTP
// ===========================================================================

notificationsRouter.get(
  '/smtp-settings',
  ...staff,
  requirePermission('notifications.settings.read'),
  route(async (req, res) => {
    const settings = await getOrCreateSmtpSettings(clinicIdOf(req));
    res.json(ok(smtpResponse(settings)));
  }),
);

notificationsRouter.put(
  '/smtp-settings',
  ...staff,
  requirePermission('notifications.settings.write'),
  route(async (req, res) => {
    const data = parseBody(smtpSettingsUpdateSchema, req.body);
    const settings = await updateSmtpSettings(clinicIdOf(req), data);
    res.json(ok(smtpResponse(settings)));
  }),
);

notificationsRouter.post(
  '/smtp-settings/test',
  ...staff,
  requirePermission('notifications.settings.write'),
  route(async (req, res) => {
    const data = parseBody(smtpTestSchema, req.body);
    const result = await testSmtpSettings(clinicIdOf(req), data);
    const success = result.status === 'success';
    res.json(
      ok({
        success,
        message: success
          ? 'Conexión SMTP exitosa. Email de prueba enviado.'
          : `Error: ${result.error_message}`,
        provider: 'smtp',
      }),
    );
  }),
);

notificationsRouter.post(
  '/test',
  ...staff,
  requirePermission('notifications.settings.write'),
  route(async (req, res) => {
    const data = parseBody(testEmailSchema, req.body);
    const result = await testEmailConnection(data.to_email);
    const success = result.status === 'success';
    res.json(
      ok({
        success,
        message: success ? 'Test email enviado correctamente' : `Error: ${result.error_message}`,
        provider: result.provider,
      }),
    );
  }),
);

// ===========================================================================
// WebPush
// ===========================================================================

notificationsRouter.post(
  '/push/subscriptions',
  ...staff,
  requirePermission('notifications.push.write'),
  route(async (req, res) => {
    const data = parseBody(pushSubscriptionCreateSchema, req.body);
    try {
      const row = await subscribe(
        clinicIdOf(req),
        data.patient_id,
        data.endpoint,
        data.keys,
        data.user_agent,
      );
      res.status(201).json(ok(toPushSubscriptionDto(row)));
    } catch (error) {
      if (error instanceof LookupErrorLike) throw notFound('Patient not found');
      if (error instanceof ValueErrorLike) throw unprocessable(error.message);
      throw error;
    }
  }),
);

notificationsRouter.get(
  '/push/subscriptions',
  ...staff,
  requirePermission('notifications.push.read'),
  route(async (req, res) => {
    const raw = single(req.query.patient_id);
    // Paramètre obligatoire (sans défaut) : absent → 422.
    if (!raw) throw unprocessable('Field required');
    if (!UUID_RE.test(raw)) throw unprocessable('Input should be a valid UUID');
    const rows = await listPushSubscriptions(clinicIdOf(req), raw.toLowerCase());
    res.json(ok(rows.map(toPushSubscriptionDto)));
  }),
);

notificationsRouter.delete(
  '/push/subscriptions/:subscription_id',
  ...staff,
  requirePermission('notifications.push.write'),
  route(async (req, res) => {
    const removed = await unsubscribe(clinicIdOf(req), uuidParam(req, 'subscription_id'));
    if (!removed) throw notFound('Subscription not found');
    res.status(204).end();
  }),
);

notificationsRouter.get(
  '/push/vapid-public-key',
  ...staff,
  requirePermission('notifications.push.read'),
  route(async (_req, res) => {
    const publicKey = vapidPublicKey(vapidSettingsFromEnv());
    if (!publicKey) {
      throw new ApiError(503, 'WebPush is not configured (DENTALPIN_VAPID_PRIVATE_KEY)');
    }
    res.json(ok({ public_key: publicKey }));
  }),
);

notificationsRouter.post(
  '/push/subscribe-tokens',
  ...staff,
  requirePermission('notifications.push.write'),
  route(async (req, res) => {
    const data = parseBody(pushSubscribeTokenCreateSchema, req.body);
    try {
      const row = await mintSubscribeToken(clinicIdOf(req), data.patient_id);
      res.status(201).json(
        ok({
          token: row.token,
          patient_id: row.patient_id,
          expires_at: row.expires_at.toISOString(),
        }),
      );
    } catch (error) {
      if (error instanceof LookupErrorLike) throw notFound('Patient not found');
      throw error;
    }
  }),
);

// ===========================================================================
// Routes publiques (`public_router.py`) : le jeton est l'authentifiant
// ===========================================================================

/**
 * Limiteur `slowapi` pour les routes publiques. En test il est désactivé
 * (comme `limiter` de `middleware/rate-limit.ts`) pour ne pas coupler les
 * tests au compteur en mémoire ; en production, un store partagé (Redis)
 * reste nécessaire si l'API tourne sur plusieurs instances.
 */
function notificationLimiter(options: {
  limit: number;
  windowMs: number;
  key?: (req: Request) => string;
}) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    if (config.isTest) {
      next();
      return;
    }
    const now = Date.now();
    const key = options.key ? options.key(req) : `ip:${req.ip ?? ''}`;
    const current = hits.get(key);
    if (!current || current.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    current.count += 1;
    if (current.count > options.limit) {
      const retryAfter = Math.ceil((current.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        detail: `Rate limit exceeded: ${options.limit} per ${Math.round(options.windowMs / 60000)} minute(s)`,
      });
      return;
    }
    next();
  };
}

const publicValidateLimiter = notificationLimiter({ limit: 60, windowMs: 60_000 });
const publicRedeemTokenLimiter = notificationLimiter({
  limit: 5,
  windowMs: 15 * 60_000,
  key: (req) => `token:${appendPathParam(req, 'token')}`,
});
const publicRedeemIpLimiter = notificationLimiter({ limit: 20, windowMs: 3600_000 });

/** `request.path_params["token"]` : dernier segment du chemin. */
function appendPathParam(req: Request, name: string): string {
  const value = single(req.params[name]);
  return value ?? req.path.split('/').pop() ?? '';
}

notificationsRouter.get(
  '/public/push/subscribe/:token',
  publicValidateLimiter,
  route(async (req, res) => {
    const raw = single(req.params.token);
    // `token: UUID` : un jeton mal formé est simplement invalide ici.
    const info = raw && UUID_RE.test(raw) ? await validateSubscribeToken(raw.toLowerCase()) : null;
    if (!info) throw notFound('Invalid or expired subscribe token');
    const publicKey = vapidPublicKey(vapidSettingsFromEnv());
    if (!publicKey) {
      throw new ApiError(503, 'WebPush is not configured (DENTALPIN_VAPID_PRIVATE_KEY)');
    }
    res.json(
      ok({
        valid: true,
        clinic_name: info.clinic_name,
        expires_at: info.expires_at.toISOString(),
        public_key: publicKey,
      }),
    );
  }),
);

notificationsRouter.post(
  '/public/push/subscribe/:token',
  publicRedeemTokenLimiter,
  publicRedeemIpLimiter,
  route(async (req, res) => {
    const data = parseBody(pushPatientRedeemSchema, req.body);
    const raw = single(req.params.token);
    if (!raw || !UUID_RE.test(raw)) throw notFound('Invalid or expired subscribe token');
    try {
      await redeemSubscribeToken(raw.toLowerCase(), data.endpoint, data.keys, data.user_agent);
    } catch (error) {
      if (error instanceof LookupErrorLike) {
        throw notFound('Invalid or expired subscribe token');
      }
      if (error instanceof ValueErrorLike) throw unprocessable(error.message);
      throw error;
    }
    res.status(201).json(ok({ subscribed: true }));
  }),
);

export default notificationsRouter;
