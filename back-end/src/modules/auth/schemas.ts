import { z } from 'zod';

export const SYSTEM_ROLES = ['admin', 'dentist', 'hygienist', 'assistant', 'receptionist'] as const;
export const PROFESSIONAL_ROLES = new Set(['dentist', 'hygienist']);

const email = z
  .string()
  .trim()
  .email('Adresse e-mail invalide')
  .transform((value) => value.toLowerCase());

const optionalNullableString = (max: number) =>
  z.string().max(max).nullable().optional();

// Le login suit le formulaire OAuth2 de FastAPI : `username` = e-mail.
export const loginFormSchema = z.object({
  username: z.string().trim().min(1, 'E-mail requis'),
  password: z.string().min(1, 'Mot de passe requis'),
});

export const refreshBodySchema = z
  .object({
    refresh_token: z.string().min(1).optional(),
  })
  .partial();

export const setPasswordSchema = z.object({
  token: z.string().min(1, 'Jeton requis'),
  password: z.string().min(12, 'Le mot de passe doit faire au moins 12 caractères'),
});

export const setupSchema = z.object({
  admin_first_name: z.string().min(1).max(100),
  admin_last_name: z.string().min(1).max(100),
  admin_email: email,
  admin_password: z.string().min(12),
  admin_is_professional: z.boolean().default(false),
  clinic_name: z.string().min(1).max(200),
  clinic_tax_id: z.string().min(1).max(20),
  clinic_street: z.string().max(200).optional().nullable(),
  clinic_city: z.string().max(100).optional().nullable(),
  clinic_postal_code: z.string().max(20).optional().nullable(),
  timezone: z
    .string()
    .max(64)
    .optional()
    .nullable()
    .refine(
      (value) => {
        if (!value) return true;
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Fuseau horaire IANA invalide' },
    ),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional()
    .nullable(),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .nullable(),
  language: z
    .enum(['es', 'en', 'fr', 'pt', 'pt-BR', 'ta', 'te', 'hi', 'de', 'hu', 'pl', 'it', 'ar'])
    .optional()
    .nullable(),
});

export type SetupInput = z.infer<typeof setupSchema>;

export const userCreateSchema = z.object({
  email,
  password: z.string().min(12, 'Le mot de passe doit faire au moins 12 caractères').optional().nullable(),
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  role: z.string().min(1).max(50),
  clinic_id: z.string().uuid().optional().nullable(),
  is_professional: z.boolean().optional().nullable(),
});

export const userUpdateSchema = z.object({
  email: email.optional(),
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
  role: z.string().min(1).max(50).optional(),
  is_active: z.boolean().optional(),
  is_professional: z.boolean().optional().nullable(),
});

export const clinicAddressSchema = z.object({
  street: optionalNullableString(200),
  city: optionalNullableString(100),
  postal_code: optionalNullableString(20),
  country: optionalNullableString(100),
});

export const clinicUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  tax_id: z.string().max(20).optional(),
  legal_name: z.string().max(200).optional().nullable(),
  address: clinicAddressSchema.optional().nullable(),
  phone: z.string().max(20).optional().nullable(),
  email: z.string().email().optional().nullable(),
  timezone: z
    .string()
    .max(64)
    .optional()
    .refine(
      (value) => {
        if (!value) return true;
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Fuseau horaire IANA invalide' },
    ),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Code devise ISO 4217 attendu')
    .optional(),
});

export type UserCreateInput = z.infer<typeof userCreateSchema>;
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;
export type ClinicUpdateInput = z.infer<typeof clinicUpdateSchema>;

/** PATCH `clinic.settings.onboarding` — seuls les marqueurs sont stockés. */
export const onboardingPatchSchema = z.object({
  dismissed: z.boolean().optional().nullable(),
  completed: z.boolean().optional().nullable(),
  skip: z.array(z.string().min(1).max(100)).max(50).optional(),
  unskip: z.array(z.string().min(1).max(100)).max(50).optional(),
  reset: z.boolean().optional().default(false),
});

export type OnboardingPatchInput = z.infer<typeof onboardingPatchSchema>;

/** PATCH `clinic.settings.budget` — clés de premier niveau de `clinics.settings`. */
export const budgetSettingsPatchSchema = z.object({
  budget_expiry_days: z.number().int().min(7).max(180).optional().nullable(),
  plan_auto_close_days_after_expiry: z.number().int().min(7).max(180).optional().nullable(),
  budget_reminders_enabled: z.boolean().optional().nullable(),
  budget_public_auth_disabled: z.boolean().optional().nullable(),
});

export type BudgetSettingsPatchInput = z.infer<typeof budgetSettingsPatchSchema>;

/** PATCH `clinic.settings.communications` — langue des pages patient. */
export const communicationsSettingsPatchSchema = z.object({
  language: z
    .string()
    .regex(/^(es|en|fr|pt|pt-BR|ta|te|hi|de|hu|pl|it|ar)$/)
    .optional()
    .nullable(),
});

export type CommunicationsSettingsPatchInput = z.infer<
  typeof communicationsSettingsPatchSchema
>;
