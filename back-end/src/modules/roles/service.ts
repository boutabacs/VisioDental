import { Prisma, type roles } from '@prisma/client';

import { invalidateRbacCache, resolveGrantedPermissions } from '../../core/auth/rbac';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import {
  CORE_PERMISSIONS,
  SYSTEM_ROLES,
  type PermissionDto,
  type RoleCreateInput,
  type RoleDto,
  type RoleOverrideDto,
  type RoleOverrideInput,
  type RoleUpdateInput,
} from './schemas';

/** Miroir de `router_roles.py` (RBAC multi-tenant, ADR/issue #46). */

async function availablePermissionCodes(): Promise<string[]> {
  const rows = await prisma.permissions.findMany({ select: { code: true } });
  return [...new Set([...rows.map((row) => row.code), ...CORE_PERMISSIONS])].sort();
}

async function rolePermissionCodes(roleId: string): Promise<string[]> {
  const rows = await prisma.role_permissions.findMany({
    where: { role_id: roleId },
    include: { permissions: { select: { code: true } } },
  });
  return rows.map((row) => row.permissions.code).sort();
}

async function permissionIdByCode(
  tx: Prisma.TransactionClient,
  code: string,
): Promise<string> {
  const perm = await tx.permissions.findUnique({ where: { code }, select: { id: true } });
  if (!perm) {
    // Validé en amont, mais un code connu du registre peut ne pas encore
    // avoir de ligne : échouer bruyamment, ne jamais avaler le grant.
    throw unprocessable(`Unknown permission code(s): ${code}`);
  }
  return perm.id;
}

async function setRolePermissions(
  tx: Prisma.TransactionClient,
  roleId: string,
  codes: string[],
): Promise<void> {
  const valid = new Set(await availablePermissionCodes());
  const unknown = codes.filter((code) => !valid.has(code));
  if (unknown.length > 0) {
    throw unprocessable(`Unknown permission code(s): ${unknown.join(', ')}`);
  }

  const now = new Date();
  await tx.role_permissions.deleteMany({ where: { role_id: roleId } });
  for (const code of codes) {
    const permissionId = await permissionIdByCode(tx, code);
    await tx.role_permissions.create({
      data: {
        id: crypto.randomUUID(),
        role_id: roleId,
        permission_id: permissionId,
        created_at: now,
        updated_at: now,
      },
    });
  }
}

async function roleResponse(
  role: roles,
  clinicId: string,
  permissions?: string[],
): Promise<RoleDto> {
  const owned = permissions ?? (await rolePermissionCodes(role.id));
  const effective = await resolveGrantedPermissions(clinicId, role.name);
  return {
    id: role.id,
    clinic_id: role.clinic_id,
    name: role.name,
    is_system: role.is_system,
    description: role.description,
    permissions: owned,
    effective_permissions: [...effective].sort(),
  };
}

async function roleOr404(
  tx: Prisma.TransactionClient | typeof prisma,
  roleId: string,
  clinicId: string,
): Promise<roles> {
  const role = await tx.roles.findFirst({
    where: {
      id: roleId,
      // Les rôles système sont visibles pour tous les cabinets, les rôles
      // personnalisés seulement pour leur cabinet propriétaire.
      OR: [{ clinic_id: clinicId }, { clinic_id: null }],
    },
  });
  if (!role) throw notFound('Role not found');
  return role;
}

async function customRoleOr404(
  tx: Prisma.TransactionClient | typeof prisma,
  roleId: string,
  clinicId: string,
): Promise<roles> {
  const role = await tx.roles.findFirst({
    where: { id: roleId, clinic_id: clinicId },
  });
  if (!role || role.is_system) {
    throw notFound('Custom role not found (or not owned by this clinic)');
  }
  return role;
}

async function assertNameAvailable(
  tx: Prisma.TransactionClient,
  clinicId: string,
  name: string,
  exceptRoleId?: string,
): Promise<void> {
  if ((SYSTEM_ROLES as readonly string[]).includes(name)) {
    throw conflict(`'${name}' is a system role name; choose another`);
  }
  const clash = await tx.roles.findFirst({
    where: {
      clinic_id: clinicId,
      name,
      ...(exceptRoleId ? { id: { not: exceptRoleId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw conflict(`Role '${name}' already exists in this clinic`);
}

export async function listRoles(clinicId: string): Promise<RoleDto[]> {
  const rows = await prisma.roles.findMany({
    where: { OR: [{ clinic_id: clinicId }, { clinic_id: null }] },
  });
  const order = new Map<string, number>(SYSTEM_ROLES.map((name, index) => [name, index]));
  rows.sort((a, b) => (order.get(a.name) ?? 99) - (order.get(b.name) ?? 99) || a.name.localeCompare(b.name));
  return Promise.all(rows.map((role) => roleResponse(role, clinicId)));
}

export async function permissionCatalog(): Promise<PermissionDto[]> {
  const codes = await availablePermissionCodes();
  return codes.map((code) => ({
    module: code.includes('.') ? code.split('.', 1)[0]! : 'core',
    code,
  }));
}

export async function createRole(clinicId: string, input: RoleCreateInput): Promise<RoleDto> {
  const role = await prisma.$transaction(async (tx) => {
    await assertNameAvailable(tx, clinicId, input.name);
    const now = new Date();
    const created = await tx.roles.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: clinicId,
        name: input.name,
        is_system: false,
        description: input.description ?? null,
        created_at: now,
        updated_at: now,
      },
    });
    if (input.permissions.length > 0) {
      await setRolePermissions(tx, created.id, input.permissions);
    }
    return created;
  });
  invalidateRbacCache();
  return roleResponse(role, clinicId);
}

export async function updateRole(
  clinicId: string,
  roleId: string,
  input: RoleUpdateInput,
): Promise<RoleDto> {
  const role = await prisma.$transaction(async (tx) => {
    const current = await customRoleOr404(tx, roleId, clinicId);
    const data: Prisma.rolesUpdateInput = { updated_at: new Date() };

    if (input.name !== undefined && input.name !== current.name) {
      await assertNameAvailable(tx, clinicId, input.name, roleId);
      // Les memberships référencent le rôle par nom dans cette version : le
      // renommage doit suivre, sinon les détenteurs se retrouvent avec un
      // rôle qui ne résout plus rien.
      await tx.clinic_memberships.updateMany({
        where: {
          clinic_id: clinicId,
          OR: [{ role: current.name }, { role_id: roleId }],
        },
        data: { role: input.name },
      });
      data.name = input.name;
    }
    if (input.description !== undefined && input.description !== null) {
      data.description = input.description;
    }
    const updated = await tx.roles.update({ where: { id: roleId }, data });
    if (input.permissions !== undefined) {
      await setRolePermissions(tx, roleId, input.permissions);
    }
    return updated;
  });
  invalidateRbacCache();
  return roleResponse(role, clinicId);
}

export async function deleteRole(clinicId: string, roleId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const role = await customRoleOr404(tx, roleId, clinicId);
    const assigned = await tx.clinic_memberships.findFirst({
      where: {
        clinic_id: clinicId,
        OR: [{ role: role.name }, { role_id: role.id }],
      },
      select: { id: true },
    });
    if (assigned) {
      throw conflict(`Role '${role.name}' is assigned to users; reassign them first`);
    }
    await tx.roles.delete({ where: { id: role.id } });
  });
  invalidateRbacCache();
}

export async function setRoleOverrides(
  clinicId: string,
  roleId: string,
  input: RoleOverrideInput,
): Promise<RoleOverrideDto> {
  await prisma.$transaction(async (tx) => {
    const role = await roleOr404(tx, roleId, clinicId);
    if (!role.is_system) {
      throw unprocessable(
        "Overrides apply to system roles only; edit the custom role's permissions",
      );
    }
    if (role.name === 'admin' && input.revoked.length > 0) {
      // Révoquer `*` de l'admin verrouillerait le cabinet hors de cette API.
      throw unprocessable('The admin role cannot lose grants');
    }

    const valid = new Set(await availablePermissionCodes());
    const unknown = [...input.granted, ...input.revoked].filter((code) => !valid.has(code));
    if (unknown.length > 0) {
      throw unprocessable(`Unknown permission code(s): ${unknown.join(', ')}`);
    }

    const now = new Date();
    // Remplacement complet : on efface les overrides antérieurs du couple.
    await tx.clinic_role_overrides.deleteMany({
      where: { clinic_id: clinicId, role_id: role.id },
    });
    for (const code of input.granted) {
      const permissionId = await permissionIdByCode(tx, code);
      await tx.clinic_role_overrides.create({
        data: {
          id: crypto.randomUUID(),
          clinic_id: clinicId,
          role_id: role.id,
          permission_id: permissionId,
          granted: true,
          created_at: now,
          updated_at: now,
        },
      });
    }
    for (const code of input.revoked) {
      const permissionId = await permissionIdByCode(tx, code);
      await tx.clinic_role_overrides.create({
        data: {
          id: crypto.randomUUID(),
          clinic_id: clinicId,
          role_id: role.id,
          permission_id: permissionId,
          granted: false,
          created_at: now,
          updated_at: now,
        },
      });
    }
  });
  invalidateRbacCache();
  return { granted: input.granted, revoked: input.revoked };
}
