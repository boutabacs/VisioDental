import { z } from 'zod';

/** Miroir de `backend/app/core/auth/router_roles.py`. */

export const ROLE_NAME_MAX_LENGTH = 20;

/** Rôles système (ordre d'affichage de l'UI), voir `app/core/auth/permissions.py`. */
export const SYSTEM_ROLES = ['admin', 'dentist', 'hygienist', 'assistant', 'receptionist'] as const;

export const CORE_PERMISSIONS = [
  'admin.users.read',
  'admin.users.write',
  'admin.clinic.read',
  'admin.clinic.write',
  'admin.roles.read',
  'admin.roles.write',
  'agents.view',
  'agents.supervise',
  'agents.configure',
  'agents.manage',
] as const;

const roleName = z.string().min(1).max(ROLE_NAME_MAX_LENGTH);
const permissionCode = z.string().min(1);

export const roleCreateSchema = z.object({
  name: roleName,
  description: z.string().nullish(),
  permissions: z.array(permissionCode).default([]),
});

export const roleUpdateSchema = z.object({
  name: roleName.optional(),
  description: z.string().nullish(),
  permissions: z.array(permissionCode).optional(),
});

export const roleOverrideSchema = z.object({
  granted: z.array(permissionCode).default([]),
  revoked: z.array(permissionCode).default([]),
});

export type RoleCreateInput = z.infer<typeof roleCreateSchema>;
export type RoleUpdateInput = z.infer<typeof roleUpdateSchema>;
export type RoleOverrideInput = z.infer<typeof roleOverrideSchema>;

export interface RoleDto {
  id: string;
  clinic_id: string | null;
  name: string;
  is_system: boolean;
  description: string | null;
  permissions: string[];
  effective_permissions: string[];
}

export interface PermissionDto {
  module: string;
  code: string;
}

export interface RoleOverrideDto {
  granted: string[];
  revoked: string[];
}
