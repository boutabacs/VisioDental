import { Prisma, type core_module } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { notFound } from '../../lib/errors';

/**
 * Registre des modules alimenté par `core_module.manifest_snapshot`
 * (déjà écrit par le backend FastAPI). L'express lit le snapshot en base
 * plutôt que d'importer des classes Python : c'est la source de vérité
 * pendant la migration.
 */

export interface ModuleInfoDto {
  name: string;
  version: string;
  installed_version: string | null;
  state: string;
  category: string;
  removable: boolean;
  auto_install: boolean;
  installed_at: string | null;
  last_state_change: string;
  base_revision: string | null;
  applied_revision: string | null;
  error_message: string | null;
  error_at: string | null;
  summary: string;
  depends: string[];
  in_disk: boolean;
  installable: boolean;
  upgrade_available: boolean;
}

interface ManifestSnapshot {
  name?: string;
  version?: string;
  summary?: string;
  category?: string;
  depends?: string[];
  installable?: boolean;
  frontend?: {
    navigation?: Array<Record<string, unknown>>;
  };
}

function snapshot(row: core_module): ManifestSnapshot {
  return (row.manifest_snapshot as ManifestSnapshot | null) ?? {};
}

export function toModuleInfo(row: core_module): ModuleInfoDto {
  const manifest = snapshot(row);
  return {
    name: row.name,
    version: manifest.version ?? row.version,
    installed_version: row.state === 'installed' ? row.version : null,
    state: row.state,
    category: manifest.category ?? row.category,
    removable: row.removable,
    auto_install: row.auto_install,
    installed_at: row.installed_at?.toISOString() ?? null,
    last_state_change: row.last_state_change.toISOString(),
    base_revision: row.base_revision,
    applied_revision: row.applied_revision,
    error_message: row.error_message,
    error_at: row.error_at?.toISOString() ?? null,
    summary: manifest.summary ?? '',
    depends: manifest.depends ?? [],
    in_disk: true,
    installable: manifest.installable ?? true,
    upgrade_available: false,
  };
}

export async function listModules(): Promise<ModuleInfoDto[]> {
  const rows = await prisma.core_module.findMany({ orderBy: { name: 'asc' } });
  return rows.map(toModuleInfo);
}

export async function getModule(name: string): Promise<ModuleInfoDto> {
  const row = await prisma.core_module.findUnique({ where: { name } });
  if (!row) throw notFound(`Module not found: ${name}`);
  return toModuleInfo(row);
}

export async function moduleStatus(): Promise<{
  by_state: Record<string, number>;
  pending: string[];
  errored: string[];
  total: number;
}> {
  const rows = await prisma.core_module.findMany({
    select: { name: true, state: true, error_message: true },
  });
  const byState: Record<string, number> = {};
  const pending: string[] = [];
  const errored: string[] = [];
  for (const row of rows) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
    if (['to_install', 'to_upgrade', 'to_remove'].includes(row.state)) {
      pending.push(row.name);
    }
    if (row.error_message && row.state !== 'installed') {
      errored.push(row.name);
    }
  }
  return { by_state: byState, pending, errored, total: rows.length };
}

export async function moduleDoctor(): Promise<{
  ok: boolean;
  orphans: string[];
  missing_dependencies: Array<{ module: string; missing: string }>;
  manifest_errors: Array<{ module: string; error: string }>;
  errored_modules: Array<{ module: string; error: string }>;
}> {
  const rows = await prisma.core_module.findMany({ orderBy: { name: 'asc' } });
  const installed = new Set(rows.filter((row) => row.state === 'installed').map((r) => r.name));
  const missingDependencies: Array<{ module: string; missing: string }> = [];
  const erroredModules: Array<{ module: string; error: string }> = [];

  for (const row of rows) {
    if (row.state === 'installed') {
      for (const dep of snapshot(row).depends ?? []) {
        if (!installed.has(dep)) missingDependencies.push({ module: row.name, missing: dep });
      }
    } else if (row.error_message) {
      erroredModules.push({ module: row.name, error: row.error_message });
    }
  }

  return {
    ok: missingDependencies.length === 0 && erroredModules.length === 0,
    orphans: [],
    missing_dependencies: missingDependencies,
    manifest_errors: [],
    errored_modules: erroredModules,
  };
}

export interface ActiveModuleDto {
  name: string;
  version: string;
  category: string;
  summary: string;
  navigation: Array<Record<string, unknown>>;
  permissions: string[];
}

/** Modules `installed` avec la navigation filtrée pour l'utilisateur. */
export async function activeModules(
  hasPermission: (permission: string) => boolean,
): Promise<ActiveModuleDto[]> {
  const rows = await prisma.core_module.findMany({
    where: { state: 'installed' },
    orderBy: { name: 'asc' },
  });
  if (rows.length === 0) return [];

  const permissionRows = await prisma.permissions.findMany({
    where: { module: { in: rows.map((row) => row.name) } },
    select: { module: true, code: true },
  });
  const permissionsByModule = new Map<string, string[]>();
  for (const permission of permissionRows) {
    if (!permission.module) continue;
    const bucket = permissionsByModule.get(permission.module) ?? [];
    bucket.push(permission.code);
    permissionsByModule.set(permission.module, bucket);
  }

  return rows.map((row) => {
    const manifest = snapshot(row);
    const navigation = (manifest.frontend?.navigation ?? []).filter((item) => {
      const permission = item.permission;
      if (typeof permission !== 'string' || permission.length === 0) return true;
      return hasPermission(permission);
    });
    return {
      name: row.name,
      version: manifest.version ?? row.version,
      category: manifest.category ?? row.category,
      summary: manifest.summary ?? '',
      navigation,
      permissions: (permissionsByModule.get(row.name) ?? []).sort(),
    };
  });
}

export async function moduleOperations(
  name: string,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const module = await prisma.core_module.findUnique({ where: { name }, select: { name: true } });
  if (!module) throw notFound(`Module not found: ${name}`);
  const rows = await prisma.core_module_operation_log.findMany({
    where: { module_name: name },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: limit,
  });
  return rows.map((row) => ({
    id: Number(row.id),
    module_name: row.module_name,
    operation: row.operation,
    step: row.step,
    status: row.status,
    details: row.details,
    created_at: row.created_at.toISOString(),
  }));
}

// Utilisé plus tard par les opérations d'installation : le type est
// exporté pour éviter un import `Prisma` inutilisé dans le routeur.
export type ModuleUpdate = Prisma.core_moduleUpdateInput;
