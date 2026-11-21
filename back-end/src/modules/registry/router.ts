import { Router, type Request } from 'express';

import { ApiError } from '../../lib/errors';
import { ok } from '../../lib/http';
import { permits, resolveGrantedPermissions } from '../../core/auth/rbac';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import {
  activeModules,
  getModule,
  listModules,
  moduleDoctor,
  moduleOperations,
  moduleStatus,
} from './service';

export const registryRouter = Router();

function queryInt(req: Request, key: string, fallback: number): number {
  const raw = req.query[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number.parseInt(typeof value === 'string' ? value : '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function param(req: Request, key: string): string {
  const value = req.params[key];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

// --- Lecture -----------------------------------------------------------

registryRouter.get(
  '',
  authenticate,
  requireClinic,
  requirePermission('admin.clinic.read'),
  async (_req, res) => {
    res.json(ok(await listModules()));
  },
);

registryRouter.get(
  '/-/status',
  authenticate,
  requireClinic,
  requirePermission('admin.clinic.read'),
  async (_req, res) => {
    res.json(ok(await moduleStatus()));
  },
);

registryRouter.get(
  '/-/doctor',
  authenticate,
  requireClinic,
  requirePermission('admin.clinic.read'),
  async (_req, res) => {
    res.json(ok(await moduleDoctor()));
  },
);

registryRouter.get('/-/active', authenticate, requireClinic, async (req, res) => {
  const granted = await resolveGrantedPermissions(req.clinicId!, req.role!);
  res.json(
    ok(await activeModules((permission) => permits(granted, permission))),
  );
});

registryRouter.get(
  '/:name/-/operations',
  authenticate,
  requireClinic,
  requirePermission('admin.clinic.read'),
  async (req, res) => {
    const limit = Math.min(Math.max(queryInt(req, 'limit', 20), 1), 100);
    res.json(ok(await moduleOperations(param(req, 'name'), limit)));
  },
);

registryRouter.get(
  '/:name',
  authenticate,
  requireClinic,
  requirePermission('admin.clinic.read'),
  async (req, res) => {
    res.json(ok(await getModule(param(req, 'name'))));
  },
);

// --- Mutations ---------------------------------------------------------
// Le cycle de vie (pip install, migrations Alembic, montage de routeurs)
// est spécifique au backend Python. Ces opérations seront repensées pour
// Express dans une vague ultérieure ; on répond explicitement 501 plutôt
// que de simuler un succès.

for (const action of ['install', 'uninstall', 'upgrade'] as const) {
  registryRouter.post(
    `/:name/${action}`,
    authenticate,
    requireClinic,
    requirePermission('admin.clinic.write'),
    async (req) => {
      void req;
      throw new ApiError(
        501,
        `Module ${action} is not available on the Express backend yet`,
      );
    },
  );
}

registryRouter.post(
  '/-/restart',
  authenticate,
  requireClinic,
  requirePermission('admin.clinic.write'),
  async () => {
    throw new ApiError(501, 'Module restart is not available on the Express backend yet');
  },
);
