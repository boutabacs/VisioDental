import { z } from 'zod';

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ')
  .nullable()
  .optional();

const billingAddressSchema = z.object({
  street: z.string().max(300).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  postal_code: z.string().max(20).optional().nullable(),
  province: z.string().max(100).optional().nullable(),
  country: z.string().max(100).default('ES'),
});

const patientAddressSchema = z.object({
  street: z.string().max(300).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  postal_code: z.string().max(20).optional().nullable(),
  province: z.string().max(100).optional().nullable(),
  country: z.string().max(100).default('ES'),
});

export const patientCreateSchema = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  phone: z.string().max(20).nullable().optional(),
  email: z.string().email().nullable().optional(),
  date_of_birth: dateOnly,
  notes: z.string().nullable().optional(),
  do_not_contact: z.boolean().default(false),
  national_id: z.string().max(50).nullable().optional(),
  national_id_type: z.string().max(20).nullable().optional(),
  billing_name: z.string().max(200).nullable().optional(),
  billing_tax_id: z.string().max(50).nullable().optional(),
  billing_address: billingAddressSchema.nullable().optional(),
  billing_email: z.string().email().nullable().optional(),
});

export const patientUpdateSchema = z.object({
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
  phone: z.string().max(20).nullable().optional(),
  email: z.string().email().nullable().optional(),
  date_of_birth: dateOnly,
  notes: z.string().nullable().optional(),
  status: z.enum(['active', 'archived']).nullable().optional(),
  do_not_contact: z.boolean().optional(),
  billing_name: z.string().max(200).nullable().optional(),
  billing_tax_id: z.string().max(50).nullable().optional(),
  billing_address: billingAddressSchema.nullable().optional(),
  billing_email: z.string().email().nullable().optional(),
});

export const patientExtendedUpdateSchema = patientUpdateSchema.extend({
  gender: z.string().max(20).nullable().optional(),
  national_id: z.string().max(50).nullable().optional(),
  national_id_type: z.string().max(20).nullable().optional(),
  profession: z.string().max(100).nullable().optional(),
  workplace: z.string().max(200).nullable().optional(),
  preferred_language: z.string().max(10).nullable().optional(),
  address: patientAddressSchema.nullable().optional(),
  photo_url: z.string().max(500).nullable().optional(),
});

export type PatientCreateInput = z.infer<typeof patientCreateSchema>;
export type PatientUpdateInput = z.infer<typeof patientUpdateSchema>;
export type PatientExtendedUpdateInput = z.infer<typeof patientExtendedUpdateSchema>;
