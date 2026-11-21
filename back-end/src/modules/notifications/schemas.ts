import { z } from 'zod';

import { NOTIFICATION_TYPES } from './helpers';

/**
 * Schémas de requête du module notifications — miroir des modèles Pydantic de
 * `backend/app/modules/notifications/schemas.py` (bornes, valeurs par défaut,
 * champs optionnels et les deux validations de liste de canaux).
 */

const uuid = z.string().uuid();

/** `_validate_manual_channels` : absent → absent ; vide ou doublons → 422. */
export const channelListSchema = z
  .array(z.string())
  .nullable()
  .transform((value) => value)
  .refine((value) => value === null || value.length > 0, {
    message: 'channel list must not be empty',
  })
  .refine((value) => value === null || new Set(value).size === value.length, {
    message: 'channel list must not contain duplicates',
  });

/** `EmailTemplateCreate` (EmailTemplateBase). */
export const emailTemplateCreateSchema = z.object({
  template_key: z.string().max(100),
  channel: z.string().max(20).default('email'),
  locale: z.string().max(5).default('es'),
  subject: z.string().max(255).nullable().default(null),
  body_html: z.string().nullable().default(null),
  body_text: z.string().nullable().default(null),
  provider_template_name: z.string().max(200).nullable().default(null),
  variables: z.record(z.string(), z.unknown()).nullable().default(null),
  description: z.string().max(500).nullable().default(null),
  is_active: z.boolean().default(true),
});

/** `EmailTemplateUpdate` — all fields optional (PATCH semantics via PUT). */
export const emailTemplateUpdateSchema = z.object({
  subject: z.string().max(255).nullable().optional(),
  body_html: z.string().nullable().optional(),
  body_text: z.string().nullable().optional(),
  variables: z.record(z.string(), z.unknown()).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  is_active: z.boolean().nullable().optional(),
});

/** `NotificationPreferenceUpdate` — `preferences` keyed by the closed vocabulary. */
export const notificationPreferenceUpdateSchema = z.object({
  email_enabled: z.boolean().nullable().optional(),
  whatsapp_enabled: z.boolean().nullable().optional(),
  sms_enabled: z.boolean().nullable().optional(),
  push_enabled: z.boolean().nullable().optional(),
  preferences: z.record(z.enum(NOTIFICATION_TYPES), z.boolean()).nullable().optional(),
  preferred_locale: z.string().max(5).nullable().optional(),
});

/** `ClinicNotificationSettingsUpdate`. */
export const clinicNotificationSettingsUpdateSchema = z.object({
  settings: z.record(z.string(), z.unknown()).nullable().optional(),
  preferred_channel: z
    .string()
    .regex(/^(email|whatsapp|sms)$/, 'String should match pattern \'^(email|whatsapp|sms)$\'')
    .nullable()
    .optional(),
  fallback_enabled: z.boolean().nullable().optional(),
  sms_daily_limit: z.number().int().min(0).nullable().optional(),
  manual_channels: channelListSchema.optional(),
});

/**
 * `ClinicNotificationSettingsUpdate` manual_channels (the Pydantic validator is
 * attached to the field itself, so an *absent* field stays absent while `null`
 * is allowed through by `list[str] | None`).
 */

/** `ManualSendRequest`. */
export const manualSendSchema = z.object({
  notification_type: z.enum(NOTIFICATION_TYPES),
  patient_id: uuid.nullable().default(null),
  appointment_id: uuid.nullable().default(null),
  budget_id: uuid.nullable().default(null),
  custom_context: z.record(z.string(), z.unknown()).nullable().default(null),
  channels: channelListSchema.optional().default(null),
});

/** `ConversationReplyRequest`. */
export const conversationReplySchema = z.object({
  channel: z.string().max(20).default('whatsapp'),
  body: z.string().min(1).max(4096),
});

/** `TestEmailRequest`. */
export const testEmailSchema = z.object({
  to_email: z.string(),
});

/** `SmtpSettingsUpdate`. */
export const smtpSettingsUpdateSchema = z.object({
  provider: z
    .string()
    .regex(/^(smtp|console|disabled)$/, "String should match pattern '^(smtp|console|disabled)$'")
    .default('smtp'),
  host: z.string().max(255).nullable().default(null),
  port: z.number().int().min(1).max(65535).default(587),
  username: z.string().max(255).nullable().default(null),
  password: z.string().nullable().default(null),
  use_tls: z.boolean().default(true),
  use_ssl: z.boolean().default(false),
  from_email: z.string().max(255).nullable().default(null),
  from_name: z.string().max(255).nullable().default(null),
});

/** `SmtpTestRequest`. */
export const smtpTestSchema = z.object({
  host: z.string().max(255),
  port: z.number().int().min(1).max(65535).default(587),
  username: z.string().max(255).nullable().default(null),
  password: z.string().nullable().default(null),
  use_tls: z.boolean().default(true),
  use_ssl: z.boolean().default(false),
  from_email: z.string().max(255),
  to_email: z.string().max(255),
});

/** `PushSubscriptionKeys`. */
export const pushSubscriptionKeysSchema = z.object({
  p256dh: z.string().max(200),
  auth: z.string().max(100),
});

const httpsEndpoint = z
  .string()
  .max(500)
  .refine((value) => value.startsWith('https://'), {
    message: 'subscription endpoint must be an https:// URL',
  });

/** `PushSubscriptionCreate`. */
export const pushSubscriptionCreateSchema = z.object({
  patient_id: uuid,
  endpoint: httpsEndpoint,
  keys: pushSubscriptionKeysSchema,
  user_agent: z.string().max(500).nullable().default(null),
});

/** `PushSubscribeTokenCreate`. */
export const pushSubscribeTokenCreateSchema = z.object({
  patient_id: uuid,
});

/** `PushPatientRedeem`. */
export const pushPatientRedeemSchema = z.object({
  endpoint: httpsEndpoint,
  keys: pushSubscriptionKeysSchema,
  user_agent: z.string().max(500).nullable().default(null),
});

export type EmailTemplateCreateInput = z.infer<typeof emailTemplateCreateSchema>;
export type EmailTemplateUpdateInput = z.infer<typeof emailTemplateUpdateSchema>;
export type NotificationPreferenceUpdateInput = z.infer<typeof notificationPreferenceUpdateSchema>;
export type ClinicNotificationSettingsUpdateInput = z.infer<
  typeof clinicNotificationSettingsUpdateSchema
>;
export type ManualSendInput = z.infer<typeof manualSendSchema>;
export type ConversationReplyInput = z.infer<typeof conversationReplySchema>;
export type SmtpSettingsUpdateInput = z.infer<typeof smtpSettingsUpdateSchema>;
export type SmtpTestInput = z.infer<typeof smtpTestSchema>;
export type PushSubscriptionCreateInput = z.infer<typeof pushSubscriptionCreateSchema>;
export type PushPatientRedeemInput = z.infer<typeof pushPatientRedeemSchema>;
export type PushSubscriptionKeysInput = z.infer<typeof pushSubscriptionKeysSchema>;
