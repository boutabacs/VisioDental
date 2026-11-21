import { Router, type Request } from 'express';

import { hasPermission } from '../../core/auth/rbac';
import { forbidden, notFound, unprocessable } from '../../lib/errors';
import { ok } from '../../lib/http';
import { authenticate, requireClinic } from '../../middleware/auth';
import { effectiveWritePermission, SettingValueError, validateValue } from './spec';
import {
  getValues,
  moduleSpecs,
  SettingsClinicNotFoundError,
  UnknownSettingError,
  UnknownSettingsModuleError,
  updateValues,
  visibleSettings,
} from './service';

export const settingsRouter = Router();

const moduleNotFound = (moduleName: string) =>
  notFound(`No settings declared for module '${moduleName}'`);

function param(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== 'string' || value === '') {
    throw notFound('Not found');
  }
  return value;
}

/** Copie compatible FastAPI : `ModuleSettingsUpdate` = `{ values: {...} }`. */
function parseValues(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw unprocessable('body: Input should be a valid dictionary or object');
  }
  const values = (body as Record<string, unknown>).values;
  if (values === undefined) {
    throw unprocessable('values: Field required');
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw unprocessable('values: Input should be a valid dictionary');
  }
  return values as Record<string, unknown>;
}

settingsRouter.get(
  '/:module',
  authenticate,
  requireClinic,
  async (req, res) => {
    const moduleName = param(req, 'module');
    try {
      const values = await getValues(req.clinicId!, moduleName);
      res.json(ok(await visibleSettings(req.clinicId!, req.role!, moduleName, values)));
    } catch (error) {
      if (error instanceof UnknownSettingsModuleError) throw moduleNotFound(moduleName);
      if (error instanceof SettingsClinicNotFoundError) throw notFound('Clinic not found');
      throw error;
    }
  },
);

settingsRouter.patch(
  '/:module',
  authenticate,
  requireClinic,
  async (req, res) => {
    const moduleName = param(req, 'module');
    const values = parseValues(req.body);

    try {
      // 404 module inconnu avant toute autre validation, comme Python.
      const specs = await moduleSpecs(moduleName);

      if (Object.keys(values).length === 0) {
        const current = await getValues(req.clinicId!, moduleName);
        res.json(ok(await visibleSettings(req.clinicId!, req.role!, moduleName, current)));
        return;
      }

      const byKey = new Map(specs.map((spec) => [spec.key, spec]));
      for (const [key, value] of Object.entries(values)) {
        const spec = byKey.get(key);
        if (!spec) throw unprocessable(`Unknown setting for '${moduleName}': ${key}`);
        if (!(await hasPermission(req.clinicId!, req.role!, spec.permission))) {
          throw forbidden(`Permission denied: ${spec.permission}`);
        }
        const writePerm = effectiveWritePermission(spec);
        if (!(await hasPermission(req.clinicId!, req.role!, writePerm))) {
          throw forbidden(`Permission denied: ${writePerm}`);
        }
        validateValue(spec, value);
      }

      const updated = await updateValues(req.clinicId!, moduleName, values);
      res.json(ok(await visibleSettings(req.clinicId!, req.role!, moduleName, updated)));
    } catch (error) {
      if (error instanceof UnknownSettingsModuleError) throw moduleNotFound(moduleName);
      if (error instanceof SettingsClinicNotFoundError) throw notFound('Clinic not found');
      if (error instanceof UnknownSettingError) throw unprocessable(error.message);
      if (error instanceof SettingValueError) throw unprocessable(error.message);
      throw error;
    }
  },
);
