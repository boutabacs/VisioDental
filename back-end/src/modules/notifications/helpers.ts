/**
 * Pure helpers shared by the notifications module (no DB, no network):
 * phone normalisation, retry backoff, 24 h session window, payload shaping,
 * clinic/global template fallback paths and the notification-type vocabulary.
 *
 * Each function mirrors a specific piece of the FastAPI module; see the
 * Python reference in the doc comment.
 */

/** `models.NotificationType` — the closed vocabulary every opt-out is keyed on. */
export const NOTIFICATION_TYPES = [
  'appointment_confirmation',
  'appointment_reminder',
  'appointment_cancelled',
  'budget_sent',
  'budget_accepted',
  'budget_reminder',
  'invoice_sent',
  'recall_reminder',
  'welcome',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** `models.default_type_preferences()` : every type opted in. */
export function defaultTypePreferences(): Record<NotificationType, boolean> {
  const prefs = {} as Record<NotificationType, boolean>;
  for (const type of NOTIFICATION_TYPES) prefs[type] = true;
  return prefs;
}

/** `channels.Channel` */
export const CHANNELS = ['email', 'whatsapp', 'sms', 'push'] as const;
export type ChannelName = (typeof CHANNELS)[number];

export function isChannelName(value: string): value is ChannelName {
  return (CHANNELS as readonly string[]).includes(value);
}

/** `notification_preferences` row subset the routing needs. */
export interface ChannelToggles {
  email_enabled: boolean;
  whatsapp_enabled: boolean;
  sms_enabled: boolean;
  push_enabled: boolean;
}

/**
 * `NotificationService.opted_out_of_type` : an absent key means consent, an
 * explicit `false` is the only opt-out.
 */
export function optedOutOfType(
  preferences: Record<string, unknown> | null | undefined,
  notificationType: string,
): boolean {
  if (!preferences) return false;
  return !(preferences[notificationType] ?? true);
}

/** `gateway._backoff_seconds` : 1m, 2m, 4m, … capped at 1 h. */
export function backoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);
}

export const SESSION_WINDOW_MS = 24 * 3600 * 1000;

/**
 * `gateway._session_window_open` : true when the patient wrote to us less
 * than 24 h ago (free-form replies allowed).
 */
export function sessionWindowOpen(lastInboundAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < SESSION_WINDOW_MS;
}

/** `gateway._sanitize` : never persist credential-ish context keys. */
export function sanitizeContext(context: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (key === 'password' || key === 'token') continue;
    clean[key] = value;
  }
  return clean;
}

/** `gateway._approved_provider_template` */
export function approvedProviderTemplate(
  template: { provider_template_status: string | null; provider_template_name: string | null } | null | undefined,
): string | null {
  if (template && template.provider_template_status === 'approved') {
    return template.provider_template_name || null;
  }
  return null;
}

/** `gateway._locale_of` : locale stashed on the outbox row at enqueue time. */
export function localeOf(contextData: unknown): string {
  if (contextData && typeof contextData === 'object' && !Array.isArray(contextData)) {
    const locale = (contextData as Record<string, unknown>).locale;
    if (typeof locale === 'string' && locale.length > 0) return locale;
  }
  return 'es';
}

/**
 * `PushSubscriptionService` endpoint guard: the worker POSTs wherever it is
 * pointed, so only https URLs are accepted.
 */
export function requireHttpsEndpoint(endpoint: string | null | undefined): void {
  if (!endpoint || !endpoint.startsWith('https://')) {
    throw new Error('subscription endpoint must be an https:// URL');
  }
}

export function validateSubscriptionKeys(keys: unknown): { p256dh: string; auth: string } {
  if (
    !keys ||
    typeof keys !== 'object' ||
    Array.isArray(keys) ||
    typeof (keys as Record<string, unknown>).p256dh !== 'string' ||
    typeof (keys as Record<string, unknown>).auth !== 'string'
  ) {
    throw new Error('subscription needs endpoint + keys.p256dh + keys.auth');
  }
  const record = keys as Record<string, unknown>;
  return { p256dh: record.p256dh as string, auth: record.auth as string };
}

/** `push_adapter._fit_payload` cap (wire-format limit is 4 KB). */
export const PUSH_MAX_BYTES = 3990;

/** `push_adapter._fit_payload` : truncate the body so the JSON fits the cap. */
export function fitPushPayload(payload: string, maxBytes: number = PUSH_MAX_BYTES): string {
  const raw = Buffer.from(payload, 'utf8');
  if (raw.length <= maxBytes) return payload;
  const data = JSON.parse(payload) as { title?: string; body?: string };
  const overflow = raw.length - maxBytes;
  const body = data.body ?? '';
  const bodyBytes = Buffer.from(body, 'utf8');
  const cut = Math.max(0, bodyBytes.length - overflow - 3);
  data.body = `${truncateUtf8(body, cut)}...`;
  return JSON.stringify(data);
}

/** Cut a UTF-8 string to at most `maxBytes` bytes without splitting a char. */
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * `gateway.resolve_patient_by_phone` suffix rule: a phone matches when the
 * last 9 digits of its digit-only form match. Returns the suffix, or null
 * when the input has fewer than 6 digits (never a blind match).
 */
export function phoneMatchSuffix(phone: string): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 6) return null;
  return digits.slice(-9);
}

/** Digits-only form of a stored phone, for the suffix comparison. */
export function digitsOnly(phone: string): string {
  return (phone ?? '').replace(/\D/g, '');
}

/**
 * `email_service._render_template` fallback order. The Express app does not
 * ship the Jinja files, so `default` / `<key>` never resolve — the list is
 * kept complete so the lookup order (and any future file) stays explicit.
 */
export function emailTemplateFallbackPaths(locale: string, templateKey: string, extension: string): string[] {
  const paths = [`${locale}/${templateKey}.${extension}`];
  if (locale === 'pt-BR') paths.push(`pt/${templateKey}.${extension}`);
  paths.push(`en/${templateKey}.${extension}`, `default/${templateKey}.${extension}`, `${templateKey}.${extension}`);
  return paths;
}

/** `dd/mm/YYYY` — Python `strftime("%d/%m/%Y")`, UTC like the FastAPI values. */
export function formatDayMonthYear(date: Date | null | undefined): string | null {
  if (!date) return null;
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

/** `HH:MM` — Python `strftime("%H:%M")`, UTC like the FastAPI values. */
export function formatHourMinute(date: Date | null | undefined): string | null {
  if (!date) return null;
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

/** Whole days between two `date` columns (Python `(a - b).days`). */
export function daysBetween(later: Date, earlier: Date): number {
  const dayMs = 24 * 3600 * 1000;
  return Math.round((later.getTime() - earlier.getTime()) / dayMs);
}
