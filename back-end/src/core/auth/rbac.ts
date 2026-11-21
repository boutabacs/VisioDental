import { prisma } from '../../lib/prisma';

/**
 * Résolution RBAC adossée à la base (`roles`, `permissions`,
 * `role_permissions`, `clinic_role_overrides`), comme `app/core/auth/rbac.py`.
 * Les wildcards (`*`, `module.*`) sont conservés et résolus à la vérification.
 */

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  expiresAt: number;
  grants: Set<string>;
}

const cache = new Map<string, CacheEntry>();

export function invalidateRbacCache(): void {
  cache.clear();
}

function wildcardMatches(required: string, granted: string): boolean {
  if (granted === '*') return true;
  if (granted.endsWith('.*')) {
    return required.startsWith(granted.slice(0, -1));
  }
  return required === granted;
}

export function permits(granted: Iterable<string>, required: string): boolean {
  for (const grant of granted) {
    if (wildcardMatches(required, grant)) return true;
  }
  return false;
}

/** Role système (clinic_id NULL), avec priorité au role personnalisé du cabinet. */
async function resolveRole(clinicId: string | null, roleName: string) {
  const roles = await prisma.roles.findMany({
    where: {
      name: roleName,
      OR: [{ clinic_id: null }, ...(clinicId ? [{ clinic_id: clinicId }] : [])],
    },
  });
  if (!roles.length) return null;
  const custom = roles.find((role) => role.clinic_id === clinicId && clinicId !== null);
  return custom ?? roles.find((role) => role.clinic_id === null) ?? roles[0] ?? null;
}

export async function resolveGrantedPermissions(
  clinicId: string | null,
  roleName: string,
): Promise<Set<string>> {
  const key = `${clinicId ?? 'system'}:${roleName}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return new Set(cached.grants);

  const role = await resolveRole(clinicId, roleName);
  if (!role) return new Set();

  const rows = await prisma.role_permissions.findMany({
    where: { role_id: role.id },
    include: { permissions: { select: { code: true } } },
  });
  const grants = new Set(rows.map((row) => row.permissions.code));

  if (clinicId) {
    const overrides = await prisma.clinic_role_overrides.findMany({
      where: { clinic_id: clinicId, role_id: role.id },
      include: { permissions: { select: { code: true } } },
    });
    for (const override of overrides) {
      if (override.granted) grants.add(override.permissions.code);
      else grants.delete(override.permissions.code);
    }
  }

  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, grants });
  return grants;
}

export async function hasPermission(
  clinicId: string | null,
  roleName: string,
  required: string,
): Promise<boolean> {
  const grants = await resolveGrantedPermissions(clinicId, roleName);
  return permits(grants, required);
}

/** Liste concrète pour `/me` : les wildcards sont expansés. */
export async function expandPermissions(grants: Set<string>): Promise<string[]> {
  if (grants.has('*')) {
    const all = await prisma.permissions.findMany({ select: { code: true } });
    return [...new Set(all.map((permission) => permission.code))].sort();
  }
  const all = await prisma.permissions.findMany({ select: { code: true } });
  const allCodes = all.map((permission) => permission.code);
  const expanded = new Set<string>();
  for (const grant of grants) {
    if (grant.endsWith('.*')) {
      const prefix = grant.slice(0, -1);
      for (const code of allCodes) {
        if (code.startsWith(prefix)) expanded.add(code);
      }
    } else {
      expanded.add(grant);
    }
  }
  return [...expanded].sort();
}
