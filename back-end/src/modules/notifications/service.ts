import { Prisma } from '@prisma/client';

import { config } from '../../config';
import { prisma } from '../../lib/prisma';
import {
  SmtpError,
  buildMimeMessage,
  sendViaConsole,
  sendViaSmtp,
  type EmailMessage,
  type EmailResult,
  type SmtpConfig,
} from './email-providers';
import {
  approvedProviderTemplate,
  backoffSeconds,
  defaultTypePreferences,
  isChannelName,
  localeOf,
  sanitizeContext,
  sessionWindowOpen,
  type ChannelName,
} from './helpers';
import { decryptPassword, encryptPassword } from './crypto-fern';
import { sendPushToSubscriptions, buildPushPayload, vapidSettingsFromEnv, vapidPublicKey } from './push';
import { renderNotificationEmail } from './templates';
import { escapeHtml } from './template-engine';

/**
 * Logique métier du module notifications — port de `service.py`, `gateway.py`,
 * `push.py` et du service email de `app/core/email/`.
 *
 * Le gateway (`enqueue`) ne touche jamais le réseau : il persiste une ligne
 * `communication_messages` `queued` (ou `skipped` avec la raison), et
 * `dispatchOutbox` (appelé par le planificateur, jamais par le router) envoie
 * avec réessais. C'est le même contrat qu'en Python.
 */

export const DEFAULT_COMMUNICATION_LOCALE = 'es';

export const DEFAULT_TYPE_SETTINGS: Record<string, Record<string, unknown>> = {
  appointment_confirmation: { auto_send: true, enabled: true },
  appointment_cancelled: { auto_send: true, enabled: true },
  appointment_reminder: { auto_send: true, enabled: true, hours_before: 24 },
  budget_sent: { auto_send: false, enabled: true },
  budget_accepted: { auto_send: true, enabled: true },
  welcome: { auto_send: false, enabled: true },
  invoice_sent: { auto_send: false, enabled: true },
  budget_reminder: { auto_send: true, enabled: true },
  recall_reminder: { auto_send: true, enabled: true },
};

export const DEFAULT_MANUAL_CHANNELS = ['email'];

const DISPATCH_BATCH = 50;

// ---------------------------------------------------------------------------
// JSON helpers (Postgres JSONB ↔ objets JS)
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Locale par défaut des communications : `clinics.settings.communication_language`. */
export async function resolveClinicCommunicationLocale(clinicId: string): Promise<string> {
  const clinic = await prisma.clinics.findUnique({
    where: { id: clinicId },
    select: { settings: true },
  });
  if (!clinic) return DEFAULT_COMMUNICATION_LOCALE;
  const settings = asRecord(clinic.settings);
  const lang = settings.communication_language;
  return typeof lang === 'string' && lang ? lang : DEFAULT_COMMUNICATION_LOCALE;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface EmailTemplateDto {
  id: string;
  clinic_id: string | null;
  template_key: string;
  channel: string;
  locale: string;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  provider_template_name: string | null;
  variables: unknown;
  description: string | null;
  is_active: boolean;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

type TemplateRow = {
  id: string;
  clinic_id: string | null;
  template_key: string;
  channel: string;
  locale: string;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  provider_template_name: string | null;
  variables: unknown;
  description: string | null;
  is_active: boolean;
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
};

export function toEmailTemplateDto(row: TemplateRow): EmailTemplateDto {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    template_key: row.template_key,
    channel: row.channel,
    locale: row.locale,
    subject: row.subject,
    body_html: row.body_html,
    body_text: row.body_text,
    provider_template_name: row.provider_template_name,
    variables: row.variables ?? null,
    description: row.description,
    is_active: row.is_active,
    is_system: row.is_system,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export interface NotificationPreferenceDto {
  id: string;
  clinic_id: string;
  patient_id: string | null;
  user_id: string | null;
  email_enabled: boolean;
  whatsapp_enabled: boolean;
  sms_enabled: boolean;
  push_enabled: boolean;
  preferences: Record<string, unknown>;
  preferred_locale: string;
  created_at: string;
  updated_at: string;
}

type PreferenceRow = {
  id: string;
  clinic_id: string;
  patient_id: string | null;
  user_id: string | null;
  email_enabled: boolean;
  whatsapp_enabled: boolean;
  sms_enabled: boolean;
  push_enabled: boolean;
  preferences: unknown;
  preferred_locale: string;
  created_at: Date;
  updated_at: Date;
};

export function toNotificationPreferenceDto(row: PreferenceRow): NotificationPreferenceDto {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    patient_id: row.patient_id,
    user_id: row.user_id,
    email_enabled: row.email_enabled,
    whatsapp_enabled: row.whatsapp_enabled,
    sms_enabled: row.sms_enabled,
    push_enabled: row.push_enabled,
    preferences: asRecord(row.preferences),
    preferred_locale: row.preferred_locale,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

type CommunicationRow = {
  id: string;
  clinic_id: string;
  channel: string;
  direction: string;
  to_address: string;
  patient_id: string | null;
  template_key: string;
  message_kind: string;
  subject: string | null;
  body_text: string | null;
  status: string;
  attempts: number;
  provider: string | null;
  provider_message_id: string | null;
  error_message: string | null;
  created_at: Date;
  sent_at: Date | null;
  delivered_at: Date | null;
  read_at: Date | null;
  triggered_by_event: string | null;
  context_data: unknown;
};

export interface EmailLogDto {
  id: string;
  clinic_id: string;
  channel: string;
  to_address: string;
  patient_id: string | null;
  template_key: string;
  subject: string | null;
  status: string;
  attempts: number;
  provider: string | null;
  provider_message_id: string | null;
  error_message: string | null;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  triggered_by_event: string | null;
}

export function toEmailLogDto(row: CommunicationRow): EmailLogDto {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    channel: row.channel,
    to_address: row.to_address,
    patient_id: row.patient_id,
    template_key: row.template_key,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    provider: row.provider,
    provider_message_id: row.provider_message_id,
    error_message: row.error_message,
    created_at: row.created_at.toISOString(),
    sent_at: row.sent_at ? row.sent_at.toISOString() : null,
    delivered_at: row.delivered_at ? row.delivered_at.toISOString() : null,
    triggered_by_event: row.triggered_by_event,
  };
}

export interface ConversationMessageDto {
  id: string;
  channel: string;
  direction: string;
  message_kind: string;
  status: string;
  subject: string | null;
  body_text: string | null;
  template_key: string;
  error_message: string | null;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  /** Hors contrat Python : le fil affiche le correspondant de chaque message. */
  to_address: string;
  patient_id: string | null;
  triggered_by_event: string | null;
}

export function toConversationMessageDto(row: CommunicationRow): ConversationMessageDto {
  return {
    id: row.id,
    channel: row.channel,
    direction: row.direction,
    message_kind: row.message_kind,
    status: row.status,
    subject: row.subject,
    body_text: row.body_text,
    template_key: row.template_key,
    error_message: row.error_message,
    created_at: row.created_at.toISOString(),
    sent_at: row.sent_at ? row.sent_at.toISOString() : null,
    delivered_at: row.delivered_at ? row.delivered_at.toISOString() : null,
    read_at: row.read_at ? row.read_at.toISOString() : null,
    to_address: row.to_address,
    patient_id: row.patient_id,
    triggered_by_event: row.triggered_by_event,
  };
}

export interface PushSubscriptionDto {
  id: string;
  clinic_id: string;
  patient_id: string;
  endpoint: string;
  created_at: string;
  updated_at: string;
}

export function toPushSubscriptionDto(row: {
  id: string;
  clinic_id: string;
  patient_id: string;
  endpoint: string;
  created_at: Date;
  updated_at: Date;
}): PushSubscriptionDto {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    patient_id: row.patient_id,
    endpoint: row.endpoint,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** `ValueError` de `update_template` / `delete_template` (→ 400). */
export class TemplateModificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateModificationError';
  }
}

export async function listTemplates(
  clinicId: string,
  options: { page: number; pageSize: number; locale?: string | null; includeSystem: boolean },
): Promise<{ rows: TemplateRow[]; total: number }> {
  const where: Prisma.notification_templatesWhereInput = options.includeSystem
    ? { OR: [{ clinic_id: clinicId }, { clinic_id: null }] }
    : { clinic_id: clinicId };
  if (options.locale) where.locale = options.locale;
  const [rows, total] = await Promise.all([
    prisma.notification_templates.findMany({
      where,
      orderBy: [{ template_key: 'asc' }, { locale: 'asc' }, { id: 'asc' }],
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    prisma.notification_templates.count({ where }),
  ]);
  return { rows, total };
}

/**
 * `get_template` : template du cabinet actif prioritaire, puis template
 * système (`clinic_id IS NULL`). L'ordre des deux requêtes compte — un
 * template système inactif ne masque pas celui du cabinet.
 */
export async function getTemplate(
  clinicId: string,
  templateKey: string,
  locale = 'es',
  channel = 'email',
) {
  const clinicTemplate = await prisma.notification_templates.findFirst({
    where: {
      clinic_id: clinicId,
      template_key: templateKey,
      locale,
      channel,
      is_active: true,
    },
  });
  if (clinicTemplate) return clinicTemplate;
  return prisma.notification_templates.findFirst({
    where: { clinic_id: null, template_key: templateKey, locale, channel, is_active: true },
  });
}

export async function getTemplateById(clinicId: string, templateId: string) {
  return prisma.notification_templates.findFirst({
    where: { id: templateId, OR: [{ clinic_id: clinicId }, { clinic_id: null }] },
  });
}

export async function createTemplate(
  clinicId: string,
  data: {
    template_key: string;
    channel: string;
    locale: string;
    subject: string | null;
    body_html: string | null;
    body_text: string | null;
    provider_template_name: string | null;
    variables: Record<string, unknown> | null;
    description: string | null;
    is_active: boolean;
  },
) {
  const now = new Date();
  return prisma.notification_templates.create({
    data: {
      id: crypto.randomUUID(),
      created_at: now,
      updated_at: now,
      clinic_id: clinicId,
      is_system: false,
      template_key: data.template_key,
      channel: data.channel,
      locale: data.locale,
      subject: data.subject,
      body_html: data.body_html,
      body_text: data.body_text,
      provider_template_name: data.provider_template_name,
      variables: data.variables === null ? Prisma.JsonNull : jsonInput(data.variables),
      description: data.description,
      is_active: data.is_active,
    },
  });
}

export async function updateTemplate(
  template: { id: string; is_system: boolean },
  data: Partial<{
    subject: string | null;
    body_html: string | null;
    body_text: string | null;
    variables: Record<string, unknown> | null;
    description: string | null;
    is_active: boolean | null;
  }>,
) {
  if (template.is_system) throw new TemplateModificationError('Cannot modify system templates');
  const update: Prisma.notification_templatesUpdateInput = {};
  if (data.subject !== undefined && data.subject !== null) update.subject = data.subject;
  if (data.body_html !== undefined && data.body_html !== null) update.body_html = data.body_html;
  if (data.body_text !== undefined && data.body_text !== null) update.body_text = data.body_text;
  if (data.variables !== undefined && data.variables !== null) update.variables = jsonInput(data.variables);
  if (data.description !== undefined && data.description !== null) update.description = data.description;
  if (data.is_active !== undefined && data.is_active !== null) update.is_active = data.is_active;
  return prisma.notification_templates.update({ where: { id: template.id }, data: update });
}

export async function deleteTemplate(template: { id: string; is_system: boolean }): Promise<void> {
  if (template.is_system) throw new TemplateModificationError('Cannot delete system templates');
  await prisma.notification_templates.delete({ where: { id: template.id } });
}

/**
 * `upsert_provider_template` : seam public pour un module vendeur (WhatsApp
 * HSM). Idempotent par (clinic, key, locale, channel).
 */
export async function upsertProviderTemplate(
  clinicId: string,
  input: {
    templateKey: string;
    locale: string;
    providerTemplateName: string;
    providerTemplateStatus: string;
    channel?: string;
  },
) {
  const channel = input.channel ?? 'whatsapp';
  const existing = await prisma.notification_templates.findFirst({
    where: {
      clinic_id: clinicId,
      template_key: input.templateKey,
      locale: input.locale,
      channel,
    },
  });
  if (existing) {
    return prisma.notification_templates.update({
      where: { id: existing.id },
      data: {
        provider_template_name: input.providerTemplateName,
        provider_template_status: input.providerTemplateStatus,
        is_active: true,
      },
    });
  }
  const now = new Date();
  return prisma.notification_templates.create({
    data: {
      id: crypto.randomUUID(),
      created_at: now,
      updated_at: now,
      clinic_id: clinicId,
      template_key: input.templateKey,
      locale: input.locale,
      channel,
      is_system: false,
      is_active: true,
      provider_template_name: input.providerTemplateName,
      provider_template_status: input.providerTemplateStatus,
    },
  });
}

// ---------------------------------------------------------------------------
// Patient preferences
// ---------------------------------------------------------------------------

export async function getPatientPreferences(clinicId: string, patientId: string) {
  return prisma.notification_preferences.findFirst({
    where: { clinic_id: clinicId, patient_id: patientId },
  });
}

/**
 * `get_or_create_patient_preferences` : deux premières lectures concurrentes
 * courent sur `uq_notification_pref_clinic_patient` ; le perdant relit la
 * ligne du gagnant (même rattrapage qu'en Python).
 */
export async function getOrCreatePatientPreferences(clinicId: string, patientId: string) {
  const existing = await getPatientPreferences(clinicId, patientId);
  if (existing) return existing;
  const now = new Date();
  try {
    return await prisma.notification_preferences.create({
      data: {
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        clinic_id: clinicId,
        patient_id: patientId,
        email_enabled: true,
        whatsapp_enabled: true,
        sms_enabled: true,
        push_enabled: true,
        preferences: jsonInput(defaultTypePreferences()),
        preferred_locale: 'es',
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await getPatientPreferences(clinicId, patientId);
      if (winner) return winner;
    }
    throw error;
  }
}

export async function updatePatientPreferences(
  clinicId: string,
  patientId: string,
  data: {
    email_enabled?: boolean | null;
    whatsapp_enabled?: boolean | null;
    sms_enabled?: boolean | null;
    push_enabled?: boolean | null;
    preferences?: Record<string, boolean> | null;
    preferred_locale?: string | null;
  },
) {
  const current = await getOrCreatePatientPreferences(clinicId, patientId);
  const update: Prisma.notification_preferencesUpdateInput = {};
  if (data.email_enabled !== undefined && data.email_enabled !== null) update.email_enabled = data.email_enabled;
  if (data.whatsapp_enabled !== undefined && data.whatsapp_enabled !== null) {
    update.whatsapp_enabled = data.whatsapp_enabled;
  }
  if (data.sms_enabled !== undefined && data.sms_enabled !== null) update.sms_enabled = data.sms_enabled;
  if (data.push_enabled !== undefined && data.push_enabled !== null) update.push_enabled = data.push_enabled;
  if (data.preferred_locale !== undefined && data.preferred_locale !== null) {
    update.preferred_locale = data.preferred_locale;
  }
  if (data.preferences !== undefined && data.preferences !== null) {
    // Fusion, jamais remplacement : enregistrer un opt-out d'un type ne doit
    // pas effacer les autres choix enregistrés (#683).
    update.preferences = jsonInput({ ...asRecord(current.preferences), ...data.preferences });
  }
  return prisma.notification_preferences.update({ where: { id: current.id }, data: update });
}

// ---------------------------------------------------------------------------
// Clinic settings
// ---------------------------------------------------------------------------

export async function getClinicSettings(clinicId: string) {
  return prisma.clinic_notification_settings.findFirst({ where: { clinic_id: clinicId } });
}

export async function getOrCreateClinicSettings(clinicId: string) {
  const existing = await getClinicSettings(clinicId);
  if (existing) return existing;
  const now = new Date();
  try {
    return await prisma.clinic_notification_settings.create({
      data: {
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        clinic_id: clinicId,
        preferred_channel: 'email',
        fallback_enabled: true,
        sms_daily_limit: 100,
        manual_channels: jsonInput(DEFAULT_MANUAL_CHANNELS),
        settings: jsonInput(DEFAULT_TYPE_SETTINGS),
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await getClinicSettings(clinicId);
      if (winner) return winner;
    }
    throw error;
  }
}

/**
 * `available_channels` : canal disponible = un adaptateur est installé ET
 * configuré pour la clinique (`adapter.supports`).
 *
 * - `email` : toujours disponible (le fournisseur global existe même sans
 *   SMTP par clinique).
 * - `sms` : un adaptateur SMS (module `sms_gateway`) n'existe pas encore côté
 *   Express → indisponible.
 * - `whatsapp` : un adaptateur existe si `clinic_channel_settings` déclare
 *   l'adaptateur et qu'il est activé + vérifié pour la clinique.
 * - `push` : la dérivation de la clé publique VAPID réussit.
 */
export async function availableChannels(clinicId: string): Promise<string[]> {
  return (await channelSupport(clinicId))
    .filter((entry) => entry.supported)
    .map((entry) => entry.channel);
}

export interface ChannelSupport {
  channel: ChannelName;
  adapterName: string;
  supported: boolean;
}

export async function channelSupport(clinicId: string): Promise<ChannelSupport[]> {
  const result: ChannelSupport[] = [{ channel: 'email', adapterName: 'email', supported: true }];
  const settings = await prisma.clinic_channel_settings.findMany({ where: { clinic_id: clinicId } });
  const smsSetting = settings.find((row) => row.channel === 'sms');
  result.push({
    channel: 'sms',
    adapterName: smsSetting?.adapter_name ?? 'sms',
    supported: Boolean(smsSetting && smsSetting.is_enabled && smsSetting.is_verified),
  });
  for (const row of settings) {
    if (row.channel !== 'whatsapp' && row.channel !== 'push') continue;
    if (!isChannelName(row.channel)) continue;
    result.push({
      channel: row.channel,
      adapterName: row.adapter_name,
      supported: row.is_enabled && row.is_verified,
    });
  }
  result.push({
    channel: 'push',
    adapterName: 'webpush',
    supported: vapidPublicKey(vapidSettingsFromEnv()) !== null,
  });
  return result;
}

/** L'adaptateur qui traite ce canal pour cette clinique (ou `null`). */
export async function supportingAdapter(
  clinicId: string,
  channel: string,
): Promise<{ adapterName: string; requiresProviderTemplate: boolean } | null> {
  if (!isChannelName(channel)) return null;
  if (channel === 'email') return { adapterName: 'email', requiresProviderTemplate: false };
  if (channel === 'push') {
    return vapidPublicKey(vapidSettingsFromEnv()) !== null
      ? { adapterName: 'webpush', requiresProviderTemplate: true }
      : null;
  }
  const row = await prisma.clinic_channel_settings.findFirst({
    where: { clinic_id: clinicId, channel },
  });
  if (!row || !row.is_enabled || !row.is_verified) return null;
  // Les adaptateurs WhatsApp exigent un template approuvé par défaut ;
  // `config.requires_provider_template === false` est le seul cas contraire.
  const adapterConfig = asRecord(row.config);
  return {
    adapterName: row.adapter_name,
    requiresProviderTemplate: adapterConfig.requires_provider_template !== false,
  };
}

export async function updateClinicSettings(
  clinicId: string,
  data: {
    preferred_channel?: string | null;
    fallback_enabled?: boolean | null;
    manual_channels?: string[] | null;
    sms_daily_limit?: number | null;
    settings?: Record<string, unknown> | null;
  },
) {
  const current = await getOrCreateClinicSettings(clinicId);
  const update: Prisma.clinic_notification_settingsUpdateInput = {};
  if (data.preferred_channel !== undefined && data.preferred_channel !== null) {
    update.preferred_channel = data.preferred_channel;
  }
  if (data.fallback_enabled !== undefined && data.fallback_enabled !== null) {
    update.fallback_enabled = data.fallback_enabled;
  }
  if (data.manual_channels !== undefined && data.manual_channels !== null) {
    update.manual_channels = jsonInput(data.manual_channels);
  }
  if (data.sms_daily_limit !== undefined && data.sms_daily_limit !== null) {
    update.sms_daily_limit = data.sms_daily_limit;
  }
  if (data.settings !== undefined && data.settings !== null) {
    // Fusion par type : un PATCH partiel conserve les autres clés.
    const merged = { ...asRecord(current.settings) };
    for (const [key, value] of Object.entries(data.settings)) {
      if (key in merged && value && typeof value === 'object' && !Array.isArray(value)) {
        merged[key] = { ...asRecord(merged[key]), ...(value as Record<string, unknown>) };
      } else {
        merged[key] = value;
      }
    }
    update.settings = jsonInput(merged);
  }
  return prisma.clinic_notification_settings.update({ where: { id: current.id }, data: update });
}

// ---------------------------------------------------------------------------
// SMTP settings
// ---------------------------------------------------------------------------

export async function getSmtpSettings(clinicId: string) {
  return prisma.clinic_smtp_settings.findFirst({ where: { clinic_id: clinicId } });
}

export async function getOrCreateSmtpSettings(clinicId: string) {
  const existing = await getSmtpSettings(clinicId);
  if (existing) return existing;
  const now = new Date();
  try {
    return await prisma.clinic_smtp_settings.create({
      data: {
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        clinic_id: clinicId,
        provider: 'disabled',
        host: null,
        port: 587,
        username: null,
        password_encrypted: null,
        use_tls: true,
        use_ssl: false,
        from_email: null,
        from_name: null,
        is_active: true,
        is_verified: false,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await getSmtpSettings(clinicId);
      if (winner) return winner;
    }
    throw error;
  }
}

export async function updateSmtpSettings(
  clinicId: string,
  data: {
    provider?: string;
    host?: string | null;
    port?: number;
    username?: string | null;
    password?: string | null;
    use_tls?: boolean;
    use_ssl?: boolean;
    from_email?: string | null;
    from_name?: string | null;
  },
) {
  const settings = await getOrCreateSmtpSettings(clinicId);
  const update: Prisma.clinic_smtp_settingsUpdateInput = {};

  // Le mot de passe est chiffré avant stockage ; une valeur absente ou vide
  // conserve le mot de passe existant.
  if (data.password) update.password_encrypted = encryptPassword(data.password, config.secretKey);

  const connectionFields: Array<keyof typeof data> = ['host', 'port', 'username', 'use_tls', 'use_ssl'];
  if (connectionFields.some((field) => Object.prototype.hasOwnProperty.call(data, field))) {
    update.is_verified = false;
    update.last_verified_at = null;
  }

  if (data.provider !== undefined) update.provider = data.provider;
  if (data.host !== undefined && data.host !== null) update.host = data.host;
  if (data.port !== undefined) update.port = data.port;
  if (data.username !== undefined && data.username !== null) update.username = data.username;
  if (data.use_tls !== undefined) update.use_tls = data.use_tls;
  if (data.use_ssl !== undefined) update.use_ssl = data.use_ssl;
  if (data.from_email !== undefined && data.from_email !== null) update.from_email = data.from_email;
  if (data.from_name !== undefined && data.from_name !== null) update.from_name = data.from_name;

  return prisma.clinic_smtp_settings.update({
    where: { id: settings.id },
    data: { ...update, updated_at: new Date() },
  });
}

/** `test_smtp_settings` : SMTP temporaire, marque vérifié en cas de succès. */
export async function testSmtpSettings(
  clinicId: string,
  input: {
    host: string;
    port: number;
    username: string | null;
    password: string | null;
    use_tls: boolean;
    use_ssl: boolean;
    from_email: string;
    to_email: string;
  },
): Promise<EmailResult> {
  let actualPassword = input.password;
  if (!actualPassword) {
    const settings = await getSmtpSettings(clinicId);
    if (settings?.password_encrypted) {
      actualPassword = decryptPassword(settings.password_encrypted, config.secretKey);
    }
  }
  const result = await sendViaSmtp(
    {
      host: input.host,
      port: input.port,
      username: input.username,
      password: actualPassword,
      use_tls: input.use_tls,
      use_ssl: input.use_ssl,
      default_from_email: input.from_email,
      default_from_name: 'VisioDental',
    },
    {
      to_email: input.to_email,
      subject: 'VisioDental - Test de conexión SMTP',
      body_html: SMTP_TEST_BODY_HTML,
      body_text: 'Conexión SMTP exitosa. La configuración está funcionando correctamente.',
      from_email: input.from_email,
    },
  );
  if (result.status === 'success') {
    const settings = await getOrCreateSmtpSettings(clinicId);
    await prisma.clinic_smtp_settings.update({
      where: { id: settings.id },
      data: { is_verified: true, last_verified_at: new Date() },
    });
  }
  return result;
}

const SMTP_TEST_BODY_HTML = `
            <html>
            <body style="font-family: sans-serif; padding: 20px;">
                <h2>Conexión SMTP exitosa</h2>
                <p>Este es un email de prueba de la configuración SMTP de tu clínica.</p>
                <p>Si has recibido este mensaje, la configuración está funcionando correctamente.</p>
                <hr>
                <p style="color: #666; font-size: 12px;">
                    Enviado desde VisioDental
                </p>
            </body>
            </html>
            `;

const TEST_EMAIL_BODY_HTML = `
            <html>
            <body style="font-family: sans-serif; padding: 20px;">
                <h2>¡Conexión exitosa!</h2>
                <p>Este es un email de prueba de VisioDental.</p>
                <p>Si has recibido este mensaje, la configuración de email está funcionando correctamente.</p>
                <hr>
                <p style="color: #666; font-size: 12px;">
                    Enviado desde VisioDental
                </p>
            </body>
            </html>
            `;

/** `test_email_connection` : email de prueba via la configuration globale. */
export async function testEmailConnection(toEmail: string): Promise<EmailResult> {
  return sendEmail(
    {
      to_email: toEmail,
      subject: 'VisioDental - Test de conexión de email',
      body_html: TEST_EMAIL_BODY_HTML,
      body_text: '¡Conexión exitosa! Este es un email de prueba de VisioDental.',
    },
    null,
    null,
  );
}

// ---------------------------------------------------------------------------
// Email transport (EmailService.send)
// ---------------------------------------------------------------------------

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function emailEnabled(): boolean {
  return envFlag(process.env.EMAIL_ENABLED, true);
}

function globalSmtpConfig(): SmtpConfig {
  return {
    host: process.env.EMAIL_SMTP_HOST ?? '',
    port: Number.parseInt(process.env.EMAIL_SMTP_PORT ?? '587', 10) || 587,
    username: process.env.EMAIL_SMTP_USER || null,
    password: process.env.EMAIL_SMTP_PASSWORD || null,
    use_tls: envFlag(process.env.EMAIL_SMTP_TLS, true),
    use_ssl: false,
    default_from_email: process.env.EMAIL_FROM_ADDRESS ?? 'noreply@visiodental.com',
    default_from_name: process.env.EMAIL_FROM_NAME ?? 'VisioDental',
  };
}

/**
 * Fournisseur global : `EMAIL_PROVIDER` (`console` par défaut, comme
 * `Settings.EMAIL_PROVIDER`). Un `smtp` sans hôte retombe sur `console`.
 */
export function globalEmailProviderName(): 'console' | 'smtp' {
  const provider = (process.env.EMAIL_PROVIDER ?? 'console').trim().toLowerCase();
  if (provider !== 'console' && provider !== 'smtp') {
    if (config.isProduction) {
      console.error(
        `[notifications] Unknown email provider '${provider}': no email will be delivered.`,
      );
    } else {
      console.warn(`[notifications] Unknown email provider '${provider}', falling back to console`);
    }
    return 'console';
  }
  if (provider === 'smtp' && !process.env.EMAIL_SMTP_HOST && config.isProduction) {
    console.error('[notifications] EMAIL_PROVIDER=smtp without EMAIL_SMTP_HOST');
  }
  return provider;
}

type ClinicEmailTarget = { kind: 'console' } | { kind: 'smtp'; config: SmtpConfig };

/** `create_provider_for_clinic` : `null` = utiliser le fournisseur global. */
async function clinicEmailTarget(clinicId: string): Promise<ClinicEmailTarget | null> {
  const settings = await prisma.clinic_smtp_settings.findFirst({ where: { clinic_id: clinicId } });
  if (!settings || !settings.is_active) return null;
  if (settings.provider === 'disabled') {
    console.info(`[notifications] Email disabled for clinic ${clinicId}`);
    return null;
  }
  if (settings.provider === 'console') return { kind: 'console' };
  if (settings.provider === 'smtp' && settings.host) {
    return {
      kind: 'smtp',
      config: {
        host: settings.host,
        port: settings.port,
        username: settings.username,
        password: settings.password_encrypted
          ? decryptPassword(settings.password_encrypted, config.secretKey)
          : null,
        use_tls: settings.use_tls,
        use_ssl: settings.use_ssl,
        default_from_email: settings.from_email ?? '',
        default_from_name: settings.from_name ?? 'VisioDental',
      },
    };
  }
  return null;
}

function consoleSend(message: EmailMessage): Promise<EmailResult> {
  return Promise.resolve(
    sendViaConsole(message, { production: config.isProduction, testing: config.isTest }),
  );
}

/**
 * Envoi d'un email (équivalent `EmailService.send`) : désactivation globale
 * → `skipped` ; SMTP du cabinet s'il est configuré ; sinon fournisseur global.
 */
export async function sendEmail(
  message: EmailMessage,
  clinicId: string | null,
  forcedProvider: 'console' | 'smtp' | null,
): Promise<EmailResult> {
  if (!emailEnabled()) {
    return {
      status: 'skipped',
      provider: 'disabled',
      message_id: null,
      error_message: 'Email is disabled (EMAIL_ENABLED=false)',
      sent_at: null,
    };
  }
  const finalMessage: EmailMessage = {
    ...message,
    from_email: message.from_email || process.env.EMAIL_FROM_ADDRESS || 'noreply@visiodental.com',
    from_name: message.from_name || process.env.EMAIL_FROM_NAME || 'VisioDental',
  };

  if (forcedProvider === 'smtp') return sendViaSmtp(globalSmtpConfig(), finalMessage);
  if (forcedProvider === 'console') return consoleSend(finalMessage);

  const clinicTarget = clinicId ? await clinicEmailTarget(clinicId) : null;
  if (clinicTarget?.kind === 'smtp') return sendViaSmtp(clinicTarget.config, finalMessage);
  if (clinicTarget?.kind === 'console') return consoleSend(finalMessage);

  if (globalEmailProviderName() === 'smtp') return sendViaSmtp(globalSmtpConfig(), finalMessage);
  return consoleSend(finalMessage);
}

// ---------------------------------------------------------------------------
// Logs & conversation
// ---------------------------------------------------------------------------

export async function listLogs(
  clinicId: string,
  options: {
    page: number;
    pageSize: number;
    patientId?: string | null;
    status?: string | null;
    templateKey?: string | null;
  },
): Promise<{ rows: CommunicationRow[]; total: number }> {
  const where: Prisma.communication_messagesWhereInput = { clinic_id: clinicId };
  if (options.patientId) where.patient_id = options.patientId;
  if (options.status) where.status = options.status;
  if (options.templateKey) where.template_key = options.templateKey;
  const [rows, total] = await Promise.all([
    prisma.communication_messages.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      skip: (options.page - 1) * options.pageSize,
      take: options.pageSize,
    }),
    prisma.communication_messages.count({ where }),
  ]);
  return { rows, total };
}

export async function listConversation(
  clinicId: string,
  patientId: string,
  channel?: string | null,
  limit = 200,
): Promise<CommunicationRow[]> {
  const where: Prisma.communication_messagesWhereInput = {
    clinic_id: clinicId,
    patient_id: patientId,
  };
  if (channel) where.channel = channel;
  return prisma.communication_messages.findMany({
    where,
    orderBy: { created_at: 'asc' },
    take: limit,
  });
}

// ---------------------------------------------------------------------------
// Consent gate
// ---------------------------------------------------------------------------

/** `should_send_notification` → `[shouldSend, reason]`. */
export async function shouldSendNotification(
  clinicId: string,
  notificationType: string,
  patientId: string | null,
  checkAutoSend = true,
): Promise<[boolean, string]> {
  const clinicSettings = await getClinicSettings(clinicId);
  if (clinicSettings) {
    const typeSettings = asRecord(asRecord(clinicSettings.settings)[notificationType]);
    if (!(typeSettings.enabled ?? true)) return [false, 'disabled_at_clinic_level'];
    if (checkAutoSend && !(typeSettings.auto_send ?? true)) return [false, 'manual_send_required'];
  }
  if (patientId) {
    const prefs = await getPatientPreferences(clinicId, patientId);
    if (prefs && !(asRecord(prefs.preferences)[notificationType] ?? true)) {
      return [false, `patient_opted_out_of_${notificationType}`];
    }
  }
  return [true, 'ok'];
}

// ---------------------------------------------------------------------------
// Gateway: enqueue
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  clinicId: string;
  notificationType: string;
  context: Record<string, unknown>;
  patientId?: string | null;
  toAddress?: string | null;
  channels?: string[] | null;
  forceSend?: boolean;
  messageKind?: string | null;
  bodyText?: string | null;
  /** Sujet explicite (messages libres / digest) ; sinon celui du template. */
  subject?: string | null;
  triggeredByEvent?: string | null;
  triggeredByUserId?: string | null;
  dedupKey?: string | null;
}

type PatientRow = { id: string; clinic_id: string; email: string | null; phone: string | null; do_not_contact: boolean };
type PrefsRow = {
  email_enabled: boolean;
  whatsapp_enabled: boolean;
  sms_enabled: boolean;
  push_enabled: boolean;
  last_inbound_at: Date | null;
  preferred_locale: string;
  preferences: unknown;
} | null;

/**
 * `NotificationGateway.enqueue` : file d'attente + porte de consentement.
 * Renvoie la ligne créée (`queued` ou `skipped`), ou `null` quand une ligne
 * porte déjà le même `dedup_key` (no-op idempotent).
 */
export async function enqueue(input: EnqueueInput): Promise<CommunicationRow | null> {
  const clinicId = input.clinicId;
  const notificationType = input.notificationType;

  if (input.dedupKey) {
    const existing = await prisma.communication_messages.findFirst({
      where: { clinic_id: clinicId, dedup_key: input.dedupKey },
      select: { id: true },
    });
    if (existing) return null;
  }

  const patient = input.patientId ? await loadPatient(clinicId, input.patientId) : null;
  const fallbackAddress = input.toAddress || patient?.email || '';
  const skip = (reason: string, address?: string) =>
    writeSkip({
      clinicId,
      notificationType,
      patientId: input.patientId ?? null,
      toAddress: address ?? fallbackAddress,
      reason,
      triggeredByEvent: input.triggeredByEvent ?? null,
      triggeredByUserId: input.triggeredByUserId ?? null,
    });

  // `do_not_contact` bloque dur sur tous les canaux, même en force_send.
  if (patient?.do_not_contact) return skip('do_not_contact');

  const prefs: PrefsRow = input.patientId
    ? await prisma.notification_preferences.findFirst({
        where: { clinic_id: clinicId, patient_id: input.patientId },
        select: {
          email_enabled: true,
          whatsapp_enabled: true,
          sms_enabled: true,
          push_enabled: true,
          last_inbound_at: true,
          preferred_locale: true,
          preferences: true,
        },
      })
    : null;

  // Un opt-out par type est l'enregistrement du patient : il tient même
  // sous force_send (le cron et les envois manuels le passent).
  if (prefs && !(asRecord(prefs.preferences)[notificationType] ?? true)) {
    return skip(`patient_opted_out_of_${notificationType}`);
  }

  if (!input.forceSend) {
    const [should, reason] = await shouldSendNotification(
      clinicId,
      notificationType,
      input.patientId ?? null,
    );
    if (!should) return skip(reason);
  }

  // Locale : défaut du cabinet → préférence du patient.
  let locale = await resolveClinicCommunicationLocale(clinicId);
  if (prefs?.preferred_locale) locale = prefs.preferred_locale;

  const requested = input.channels ?? (await clinicChannels(clinicId));
  let resolved = await resolveChannel(
    clinicId,
    notificationType,
    patient,
    prefs,
    locale,
    requested,
    input.toAddress ?? null,
    input.messageKind ?? null,
  );
  if (resolved === null) return skip('no_viable_channel');

  // Garde-coût SMS du cabinet (les autres transports sont forfaitaires).
  if (resolved.channel === 'sms' && !(await smsWithinLimit(clinicId))) {
    const index = requested.indexOf('sms');
    const rest = index >= 0 ? requested.slice(index + 1) : [];
    const next = rest.length
      ? await resolveChannel(
          clinicId,
          notificationType,
          patient,
          prefs,
          locale,
          rest,
          input.toAddress ?? null,
          input.messageKind ?? null,
        )
      : null;
    if (next === null) return skip('sms_rate_limited', resolved.address);
    resolved = next;
  }

  // Sujet résolu maintenant (email) pour la vue des logs ; le corps est
  // (re)rendu au dispatch. Les envois « session » portent le texte brut.
  let subject: string | null = input.subject ?? null;
  if (resolved.kind === 'template') {
    const template = await getTemplate(clinicId, notificationType, locale, resolved.channel);
    subject = input.subject ?? template?.subject ?? null;
  }

  const now = new Date();
  return prisma.communication_messages.create({
    data: {
      id: crypto.randomUUID(),
      created_at: now,
      updated_at: now,
      clinic_id: clinicId,
      channel: resolved.channel,
      direction: 'outbound',
      to_address: resolved.address,
      patient_id: input.patientId ?? null,
      template_key: notificationType,
      message_kind: resolved.kind,
      subject,
      body_text: input.bodyText ?? null,
      status: 'queued',
      attempts: 0,
      max_attempts: 5,
      next_attempt_at: now,
      context_data: jsonInput(sanitizeContext({ ...input.context, locale })),
      triggered_by_event: input.triggeredByEvent ?? null,
      triggered_by_user_id: input.triggeredByUserId ?? null,
      dedup_key: input.dedupKey ?? null,
      provider: null,
      provider_message_id: null,
      error_message: null,
    },
  });
}

async function loadPatient(clinicId: string, patientId: string): Promise<PatientRow | null> {
  return prisma.patients.findFirst({
    where: { clinic_id: clinicId, id: patientId },
    select: { id: true, clinic_id: true, email: true, phone: true, do_not_contact: true },
  });
}

/** `_clinic_channels` : `preferred_channel` puis, si fallback, les autres canaux installés. */
export async function clinicChannels(clinicId: string): Promise<string[]> {
  const settings = await getClinicSettings(clinicId);
  if (settings === null) return ['email'];
  const preferred = settings.preferred_channel || 'email';
  const order = [preferred];
  if (settings.fallback_enabled) {
    for (const channel of ['whatsapp', 'sms', 'push'] as const) {
      if (channel === preferred) continue;
      if ((await supportingAdapter(clinicId, channel)) !== null) order.push(channel);
    }
  }
  return order;
}

interface ResolvedChannel {
  channel: ChannelName;
  address: string;
  kind: 'template' | 'session';
}

/** `_resolve_channel` : premier canal viable de la liste ordonnée. */
export async function resolveChannel(
  clinicId: string,
  notificationType: string,
  patient: PatientRow | null,
  prefs: PrefsRow,
  locale: string,
  requested: string[],
  toAddress: string | null,
  requestedKind: string | null,
): Promise<ResolvedChannel | null> {
  for (const name of requested) {
    if (!isChannelName(name)) continue;
    if ((await supportingAdapter(clinicId, name)) === null) continue;

    if (name === 'email') {
      const address = patient?.email || toAddress;
      if (!address) continue;
      if (prefs && !prefs.email_enabled) continue;
      return { channel: 'email', address, kind: 'template' };
    }

    if (name === 'whatsapp') {
      const address = patient?.phone;
      if (!address) continue;
      // Réponse libre : seulement dans la fenêtre de 24 h ouverte par le
      // dernier message entrant du patient (pas de template requis).
      if (requestedKind === 'session') {
        if (sessionWindowOpen(prefs?.last_inbound_at)) {
          return { channel: 'whatsapp', address, kind: 'session' };
        }
        continue;
      }
      if (prefs && !prefs.whatsapp_enabled) continue;
      const adapter = await supportingAdapter(clinicId, 'whatsapp');
      if (!adapter?.requiresProviderTemplate) {
        return { channel: 'whatsapp', address, kind: 'template' };
      }
      const template = await getTemplate(clinicId, notificationType, locale, 'whatsapp');
      if (!approvedProviderTemplate(template)) continue;
      return { channel: 'whatsapp', address, kind: 'template' };
    }

    if (name === 'sms') {
      // SMS passe par patients.phone (pas de colonne dédiée en v1).
      const address = patient?.phone;
      if (!address) continue;
      if (prefs && !prefs.sms_enabled) continue;
      return { channel: 'sms', address, kind: requestedKind === 'session' ? 'session' : 'template' };
    }

    // push : viable si le patient a au moins un abonnement navigateur.
    if (name === 'push') {
      if (!patient) continue;
      const subscriptions = await prisma.notification_push_subscriptions.count({
        where: { clinic_id: clinicId, patient_id: patient.id },
      });
      if (subscriptions === 0) continue;
      if (prefs && !prefs.push_enabled) continue;
      return { channel: 'push', address: `push:${subscriptions}`, kind: 'template' };
    }
  }
  return null;
}

/** `_sms_within_limit` : plafond journalier (jour UTC, les skips ne comptent pas). */
async function smsWithinLimit(clinicId: string): Promise<boolean> {
  const settings = await getClinicSettings(clinicId);
  const limit = settings && settings.sms_daily_limit !== null ? settings.sms_daily_limit : 100;
  if (limit <= 0) return false;
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const used = await prisma.communication_messages.count({
    where: {
      clinic_id: clinicId,
      channel: 'sms',
      direction: 'outbound',
      status: { not: 'skipped' },
      created_at: { gte: dayStart },
    },
  });
  return used < limit;
}

async function writeSkip(input: {
  clinicId: string;
  notificationType: string;
  patientId: string | null;
  toAddress: string;
  reason: string;
  triggeredByEvent: string | null;
  triggeredByUserId: string | null;
}): Promise<CommunicationRow> {
  console.info(`[notifications] skip notification ${input.notificationType}: ${input.reason}`);
  // Le canal d'une ligne ignorée est le canal préféré du cabinet — jamais un
  // « email » codé en dur quand la tentative aurait été WhatsApp.
  const settings = await getClinicSettings(input.clinicId);
  const channel = settings?.preferred_channel || 'none';
  const now = new Date();
  return prisma.communication_messages.create({
    data: {
      id: crypto.randomUUID(),
      created_at: now,
      updated_at: now,
      clinic_id: input.clinicId,
      channel,
      direction: 'outbound',
      to_address: input.toAddress || '',
      patient_id: input.patientId,
      template_key: input.notificationType,
      message_kind: 'template',
      status: 'skipped',
      attempts: 0,
      max_attempts: 5,
      error_message: input.reason,
      triggered_by_event: input.triggeredByEvent,
      triggered_by_user_id: input.triggeredByUserId,
    },
  });
}

// ---------------------------------------------------------------------------
// Gateway: dispatch
// ---------------------------------------------------------------------------

/**
 * `dispatch_outbox` : envoie un lot de lignes `queued`/`failed` dues.
 * Chaque ligne est verrouillée `FOR UPDATE SKIP LOCKED` (deux ticks
 * concurrents ne prennent jamais la même), et une ligne empoisonnée n'arrête
 * pas le lot.
 */
export async function dispatchOutbox(limit: number = DISPATCH_BATCH): Promise<number> {
  const now = new Date();
  const rows = await prisma.$queryRaw<CommunicationRow[]>`
    SELECT * FROM communication_messages
    WHERE status IN ('queued', 'failed')
      AND attempts < max_attempts
      AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
    ORDER BY created_at ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `;
  let attempted = 0;
  for (const row of rows) {
    attempted += 1;
    try {
      await dispatchOne(row);
    } catch (error) {
      console.error(`[notifications] dispatch failed for message ${row.id}:`, error);
      await markFailed(row.id, (error as Error)?.message ?? 'dispatch failed');
    }
  }
  return attempted;
}

/** Corps texte d'un message « session » → HTML minimal, échappé. */
function plainTextToHtml(text: string): string {
  const body = escapeHtml(text).replace(/\r?\n/g, '<br>');
  return '<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;'
    + `font-size:14px;line-height:1.5;color:#222">${body}</body></html>`;
}

async function dispatchOne(row: CommunicationRow): Promise<void> {
  const adapter = await supportingAdapter(row.clinic_id, row.channel);
  if (adapter === null) {
    await markFailed(row.id, `no adapter for channel ${row.channel}`);
    return;
  }

  const locale = localeOf(row.context_data);
  const template =
    row.message_kind === 'template'
      ? await getTemplate(row.clinic_id, row.template_key, locale, row.channel)
      : null;

  // Re-vérifie l'approbation : la sélection d'adaptateur ou l'approbation du
  // template peuvent changer pendant qu'un message est en file.
  if (
    row.channel === 'whatsapp' &&
    row.message_kind === 'template' &&
    adapter.requiresProviderTemplate &&
    !approvedProviderTemplate(template)
  ) {
    await markFailed(row.id, 'no approved WhatsApp template');
    return;
  }

  await prisma.communication_messages.updateMany({
    where: { id: row.id, status: { in: ['queued', 'failed'] } },
    data: {
      status: 'sending',
      attempts: { increment: 1 },
      updated_at: new Date(),
    },
  });

  const context = asRecord(row.context_data);
  const toName = typeof context.patient_name === 'string' ? context.patient_name : null;

  if (row.channel === 'email') {
    // Session (message libre) : le corps texte est le message ; les flux
    // « template » gardent le rendu fichier/DB avec variables.
    const plain = row.message_kind === 'session' ? (row.body_text ?? '').trim() : '';
    const rendered = plain
      ? { html: plainTextToHtml(plain), text: plain }
      : renderNotificationEmail(
          row.template_key,
          locale,
          context,
          template?.body_html ?? null,
          template?.body_text ?? null,
        );
    if (!rendered.html) {
      await markFailed(row.id, `Template not found: ${row.template_key}`);
      return;
    }
    const result = await sendEmail(
      {
        to_email: row.to_address,
        to_name: toName,
        subject: row.subject ?? template?.subject ?? `Notificación: ${row.template_key}`,
        body_html: rendered.html,
        body_text: rendered.text,
      },
      row.clinic_id,
      null,
    );
    await applyEmailResult(row.id, result);
    return;
  }

  if (row.channel === 'push') {
    await deliverPush(row, template);
    return;
  }

  // WhatsApp / SMS : aucun adaptateur réseau n'est fourni par le module
  // notifications (les modules vendeurs s'enregistrent en Python). On aboutit
  // au même état que l'outbox Python quand aucun adaptateur ne peut livrer :
  // la ligne est `failed` avec le motif, réessayée avec backoff.
  await markFailed(row.id, `no adapter for channel ${row.channel}`);
}

async function deliverPush(
  row: CommunicationRow,
  template: { subject: string | null } | null,
): Promise<void> {
  // `template` ne sert qu'au titre ; un push sans texte reste `skipped`.
  // Session (réponse libre) : texte brut ; template : corps rendu au dispatch
  // par l'adaptateur (le payload push n'embarque que le texte du message).
  const body = (row.body_text ?? '').trim();
  if (!body) {
    // Un push sans corps n'a rien à pousser : `skipped`, comme en Python.
    await prisma.communication_messages.update({
      where: { id: row.id },
      data: {
      updated_at: new Date(),
        status: 'skipped',
        provider: 'webpush',
        error_message: 'empty body — nothing to push',
        next_attempt_at: null,
      },
    });
    return;
  }
  const vapid = vapidSettingsFromEnv();
  if (!vapid.privateKeyPem) {
    await markFailed(row.id, 'WebPush is not configured (DENTALPIN_VAPID_PRIVATE_KEY)');
    return;
  }
  if (!row.patient_id) {
    await markFailed(row.id, 'push needs a patient with subscriptions');
    return;
  }
  const subscriptions = await prisma.notification_push_subscriptions.findMany({
    where: { clinic_id: row.clinic_id, patient_id: row.patient_id },
  });
  if (subscriptions.length === 0) {
    await markFailed(row.id, 'patient has no push subscriptions');
    return;
  }
  const title = template?.subject || row.subject || row.template_key;
  const payload = buildPushPayload(title, body);
  const outcome = await sendPushToSubscriptions(subscriptions, payload, vapid);
  if (outcome.pruned.length > 0) {
    await prisma.notification_push_subscriptions.deleteMany({
      where: { id: { in: outcome.pruned } },
    });
  }
  if (outcome.sent > 0) {
    await prisma.communication_messages.update({
      where: { id: row.id },
      data: {
        status: 'sent',
        sent_at: new Date(),
        provider: 'webpush',
        error_message: null,
        updated_at: new Date(),
      },
    });
    return;
  }
  if (outcome.pruned.length > 0) {
    await markFailed(row.id, 'all subscriptions expired and were pruned');
    return;
  }
  await markFailed(row.id, 'push send failed');
}

async function applyEmailResult(messageId: string, result: EmailResult): Promise<void> {
  if (result.status === 'success') {
    await prisma.communication_messages.update({
      where: { id: messageId },
      data: {
      updated_at: new Date(),
        status: 'sent',
        sent_at: result.sent_at ?? new Date(),
        provider: result.provider,
        provider_message_id: result.message_id,
        error_message: null,
      },
    });
    return;
  }
  if (result.status === 'skipped') {
    // L'adaptateur a répondu mais n'avait rien à faire (email désactivé) :
    // c'est attendu, pas un échec à réessayer.
    await prisma.communication_messages.update({
      where: { id: messageId },
      data: {
      updated_at: new Date(),
        status: 'skipped',
        provider: result.provider,
        error_message: result.error_message ? result.error_message.slice(0, 2000) : null,
        next_attempt_at: null,
      },
    });
    return;
  }
  await markFailed(messageId, result.error_message ?? 'send failed');
}

async function markFailed(messageId: string, error: string): Promise<void> {
  const row = await prisma.communication_messages.findUnique({ where: { id: messageId } });
  if (!row) return;
  const attempts = row.attempts;
  await prisma.communication_messages.update({
    where: { id: messageId },
    data: {
      updated_at: new Date(),
      status: 'failed',
      error_message: error.slice(0, 2000),
      next_attempt_at:
        attempts < row.max_attempts
          ? new Date(Date.now() + backoffSeconds(attempts) * 1000)
          : row.next_attempt_at,
    },
  });
}

/** `record_delivery_status` : accusé de livraison/lecture d'un webhook vendeur. */
export async function recordDeliveryStatus(
  clinicId: string,
  providerMessageId: string,
  status: 'delivered' | 'read' | 'failed',
) {
  const row = await prisma.communication_messages.findFirst({
    where: { clinic_id: clinicId, provider_message_id: providerMessageId },
  });
  if (!row) return null;
  const now = new Date();
  if (status === 'delivered' && row.status !== 'read') {
    return prisma.communication_messages.update({
      where: { id: row.id },
      data: { status: 'delivered', delivered_at: now, updated_at: new Date() },
    });
  }
  if (status === 'read') {
    return prisma.communication_messages.update({
      where: { id: row.id },
      data: {
        status: 'read',
        read_at: now,
        delivered_at: row.delivered_at ?? now,
        updated_at: new Date(),
      },
    });
  }
  if (status === 'failed') {
    return prisma.communication_messages.update({
      where: { id: row.id },
      data: { status: 'failed', updated_at: new Date() },
    });
  }
  return row;
}

/** `record_inbound_reply` : message entrant, ouvre la fenêtre de 24 h. */
export async function recordInboundReply(input: {
  clinicId: string;
  channel: string;
  fromAddress: string;
  body: string;
  patientId?: string | null;
  providerMessageId?: string | null;
  occurredAt?: Date | null;
}) {
  if (input.providerMessageId) {
    const duplicate = await prisma.communication_messages.findFirst({
      where: { clinic_id: input.clinicId, dedup_key: input.providerMessageId },
      select: { id: true },
    });
    if (duplicate) return null;
  }
  const occurred = input.occurredAt ?? new Date();
  const row = await prisma.communication_messages.create({
    data: {
      id: crypto.randomUUID(),
      created_at: occurred,
      updated_at: occurred,
      clinic_id: input.clinicId,
      channel: input.channel,
      direction: 'inbound',
      to_address: input.fromAddress,
      patient_id: input.patientId ?? null,
      template_key: 'inbound',
      message_kind: 'session',
      status: 'received',
      body_text: input.body,
      provider: input.channel,
      provider_message_id: input.providerMessageId ?? null,
      dedup_key: input.providerMessageId ?? null,
      sent_at: occurred,
      attempts: 0,
      max_attempts: 5,
    },
  });
  if (input.patientId) {
    const prefs = await getOrCreatePatientPreferences(input.clinicId, input.patientId);
    await prisma.notification_preferences.update({
      where: { id: prefs.id },
      data: { last_inbound_at: occurred },
    });
  }
  return row;
}

/**
 * `resolve_patient_by_phone` : correspondance exacte, puis sur les 9 derniers
 * chiffres (ignorant la mise en forme). Portée au cabinet.
 */
export async function resolvePatientByPhone(clinicId: string, phone: string) {
  const exact = await prisma.patients.findFirst({ where: { clinic_id: clinicId, phone } });
  if (exact) return exact;
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 6) return null;
  const suffix = digits.slice(-9);
  const rows = await prisma.patients.findMany({
    where: { clinic_id: clinicId, phone: { not: null } },
    select: { id: true, phone: true },
  });
  const match = rows.find((row) => (row.phone ?? '').replace(/\D/g, '').endsWith(suffix));
  return match ? prisma.patients.findUnique({ where: { id: match.id } }) : null;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}

export { SmtpError, buildMimeMessage };
