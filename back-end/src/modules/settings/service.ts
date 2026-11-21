import { Prisma } from '@prisma/client';

import { hasPermission } from '../../core/auth/rbac';
import { notFound, unprocessable } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import {
  effectiveWritePermission,
  MODULE_SETTINGS,
  type ModuleSettingsDto,
  type SettingDeclarationDto,
  type SettingSpec,
  SettingValueError,
  validateValue,
} from './spec';

/** Miroir de `backend/app/core/settings/service.py`. */

export class UnknownSettingsModuleError extends Error {
  constructor(moduleName: string) {
    super(moduleName);
    this.name = 'UnknownSettingsModuleError';
  }
}
export class UnknownSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownSettingError';
  }
}
export class SettingsClinicNotFoundError extends Error {
  constructor(clinicId: string) {
    super(clinicId);
    this.name = 'SettingsClinicNotFoundError';
  }
}

function declarations(moduleName: string, installed: boolean): readonly SettingSpec[] {
  const specs = MODULE_SETTINGS[moduleName];
  // Python exige un module découvert + actif ET au moins une déclaration.
  if (!installed || !specs || specs.length === 0) {
    throw new UnknownSettingsModuleError(moduleName);
  }
  return specs;
}

async function isInstalled(moduleName: string): Promise<boolean> {
  const row = await prisma.core_module.findUnique({
    where: { name: moduleName },
    select: { state: true },
  });
  return row?.state === 'installed';
}

/** Déclarations du module (lève 404 métier si module inconnu/inactif). */
export async function moduleSpecs(moduleName: string): Promise<readonly SettingSpec[]> {
  return declarations(moduleName, await isInstalled(moduleName));
}

/** Valeurs effectives : valeur stockée valide, sinon défaut. */
function effectiveValues(
  specs: readonly SettingSpec[],
  stored: Record<string, unknown>,
  moduleName: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const spec of specs) {
    if (Object.prototype.hasOwnProperty.call(stored, spec.key)) {
      try {
        values[spec.key] = validateValue(spec, stored[spec.key]);
        continue;
      } catch (error) {
        if (!(error instanceof SettingValueError)) throw error;
        console.warn(
          `[settings] fallback: module ${moduleName} key ${spec.key} ${error.message}`,
        );
      }
    }
    values[spec.key] = spec.default;
  }
  return values;
}

function namespaceOf(settings: Prisma.JsonValue, moduleName: string): Record<string, unknown> {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
  const namespace = (settings as Record<string, unknown>)[moduleName];
  if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) {
    if (namespace !== undefined && namespace !== null) {
      console.warn(
        `[settings] fallback: module ${moduleName} stores a non-dict namespace; using defaults`,
      );
    }
    return {};
  }
  return namespace as Record<string, unknown>;
}

export async function getValues(clinicId: string, moduleName: string): Promise<Record<string, unknown>> {
  const specs = declarations(moduleName, await isInstalled(moduleName));
  const clinic = await prisma.clinics.findUnique({
    where: { id: clinicId },
    select: { settings: true },
  });
  if (!clinic) throw new SettingsClinicNotFoundError(clinicId);
  return effectiveValues(specs, namespaceOf(clinic.settings, moduleName), moduleName);
}

export async function updateValues(
  clinicId: string,
  moduleName: string,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const specs = declarations(moduleName, await isInstalled(moduleName));
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  const unknown = Object.keys(values)
    .filter((key) => !byKey.has(key))
    .sort();
  if (unknown.length > 0) {
    throw new UnknownSettingError(
      `Unknown setting(s) for '${moduleName}': ${unknown.join(', ')}`,
    );
  }

  const validated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    validated[key] = validateValue(byKey.get(key)!, value);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const clinic = await tx.clinics.findUnique({
      where: { id: clinicId },
      select: { settings: true },
    });
    if (!clinic) throw new SettingsClinicNotFoundError(clinicId);

    const settings =
      clinic.settings && typeof clinic.settings === 'object' && !Array.isArray(clinic.settings)
        ? { ...(clinic.settings as Record<string, unknown>) }
        : {};
    const namespace = { ...namespaceOf(clinic.settings, moduleName), ...validated };
    settings[moduleName] = namespace;

    return tx.clinics.update({
      where: { id: clinicId },
      data: { settings: settings as Prisma.InputJsonValue, updated_at: new Date() },
    });
  });

  return effectiveValues(specs, namespaceOf(updated.settings, moduleName), moduleName);
}

/** Déclarations visibles/filtres selon les permissions de l'appelant. */
export async function visibleSettings(
  clinicId: string,
  role: string,
  moduleName: string,
  values: Record<string, unknown>,
): Promise<ModuleSettingsDto> {
  const specs = declarations(moduleName, await isInstalled(moduleName));
  const settings: SettingDeclarationDto[] = [];
  const visible: Record<string, unknown> = {};

  for (const spec of specs) {
    if (!(await hasPermission(clinicId, role, spec.permission))) continue;
    settings.push({
      key: spec.key,
      type: spec.type,
      default: spec.default,
      writable: await hasPermission(clinicId, role, effectiveWritePermission(spec)),
      label_key: spec.labelKey,
      description_key: spec.descriptionKey ?? null,
      choices: [...(spec.choices ?? [])],
      min_value: spec.minValue ?? null,
      max_value: spec.maxValue ?? null,
      max_length: spec.maxLength ?? null,
      multiline: spec.multiline ?? false,
      nullable: spec.nullable ?? false,
    });
    visible[spec.key] = values[spec.key];
  }

  return { module: moduleName, settings, values: visible };
}

export function settingsModuleNotFound(moduleName: string) {
  return notFound(`No settings declared for module '${moduleName}'`);
}

export function unknownSettingError(error: unknown) {
  return unprocessable((error as Error).message);
}
