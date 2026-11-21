import { Router } from 'express';
import { z } from 'zod';

import { ok } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import {
  roleCreateSchema,
  roleOverrideSchema,
  roleUpdateSchema,
} from './schemas';
import {
  createRole,
  deleteRole,
  listRoles,
  permissionCatalog,
  setRoleOverrides,
  updateRole,
} from './service';

export const rolesRouter = Router();

const roleIdSchema = z.string().uuid();

rolesRouter.get(
  '',
  authenticate,
  requireClinic,
  requirePermission('admin.roles.read'),
  async (req, res) => {
    res.json(ok(await listRoles(req.clinicId!)));
  },
);

rolesRouter.get(
  '/catalog',
  authenticate,
  requireClinic,
  requirePermission('admin.roles.read'),
  async (_req, res) => {
    res.json(ok(await permissionCatalog()));
  },
);

rolesRouter.post(
  '',
  authenticate,
  requireClinic,
  requirePermission('admin.roles.write'),
  async (req, res) => {
    const input = roleCreateSchema.parse(req.body);
    const role = await createRole(req.clinicId!, input);
    res.status(201).json(ok(role));
  },
);

rolesRouter.put(
  '/:roleId/overrides',
  authenticate,
  requireClinic,
  requirePermission('admin.roles.write'),
  async (req, res) => {
    const roleId = roleIdSchema.parse(req.params.roleId);
    const input = roleOverrideSchema.parse(req.body);
    res.json(ok(await setRoleOverrides(req.clinicId!, roleId, input)));
  },
);

rolesRouter.put(
  '/:roleId',
  authenticate,
  requireClinic,
  requirePermission('admin.roles.write'),
  async (req, res) => {
    const roleId = roleIdSchema.parse(req.params.roleId);
    const input = roleUpdateSchema.parse(req.body);
    res.json(ok(await updateRole(req.clinicId!, roleId, input)));
  },
);

rolesRouter.delete(
  '/:roleId',
  authenticate,
  requireClinic,
  requirePermission('admin.roles.write'),
  async (req, res) => {
    const roleId = roleIdSchema.parse(req.params.roleId);
    await deleteRole(req.clinicId!, roleId);
    res.status(204).end();
  },
);
