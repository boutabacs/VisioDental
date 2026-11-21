import { Prisma } from '@prisma/client';
import { Router, type Request } from 'express';
import { z } from 'zod';

import { resolveGrantedPermissions } from '../../core/auth/rbac';
import { prisma } from '../../lib/prisma';
import { ok, paginated } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import { copilotToolRegistry, createToolContext } from '../copilot/tools';
import {
  APPROVAL_STATUSES,
  agentCreateSchema,
  approvalDecisionSchema,
  type ApprovalStatus,
} from './schemas';
import {
  approvalNotFound,
  claimApproval,
  createAgent,
  finishApproval,
  listAgents,
  listApprovals,
  listAudit,
  listSessions,
  recordApprovalAudit,
  rejectApproval,
  toAgentDto,
  toApprovalDto,
  toAuditLogDto,
  toSessionDto,
} from './service';

export const agentsRouter = Router();

const uuid = z.string().uuid();

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

agentsRouter.get(
  '',
  authenticate,
  requireClinic,
  requirePermission('agents.view'),
  async (req, res) => {
    const rows = await listAgents(req.clinicId!);
    res.json(paginated(rows.map(toAgentDto), rows.length, 1, rows.length || 1));
  },
);

agentsRouter.post(
  '',
  authenticate,
  requireClinic,
  requirePermission('agents.manage'),
  async (req, res) => {
    const input = agentCreateSchema.parse(req.body);
    const agent = await createAgent(req.clinicId!, input);
    res.status(201).json(ok(toAgentDto(agent)));
  },
);

agentsRouter.get(
  '/approvals',
  authenticate,
  requireClinic,
  requirePermission('agents.supervise'),
  async (req, res) => {
    const raw = queryString(req, 'status') ?? 'pending';
    if (!(APPROVAL_STATUSES as readonly string[]).includes(raw)) {
      res.status(422).json({
        detail: 'status: Input should be a valid enum value',
      });
      return;
    }
    const rows = await listApprovals(req.clinicId!, raw as ApprovalStatus);
    res.json(paginated(rows.map(toApprovalDto), rows.length, 1, rows.length || 1));
  },
);

agentsRouter.post(
  '/approvals/:requestId/approve',
  authenticate,
  requireClinic,
  requirePermission('agents.supervise'),
  async (req, res) => {
    const requestId = uuid.parse(req.params.requestId);
    const input = approvalDecisionSchema.parse(req.body ?? {});
    const clinicId = req.clinicId!;
    const reviewerId = req.user!.id;

    // `approved` = réservation atomique : une demande en cours ne peut pas
    // être exécutée deux fois par deux superviseurs.
    const request = await claimApproval(clinicId, requestId, reviewerId, input.notes ?? null);
    if (!request) approvalNotFound();

    const clinic = await prisma.clinics.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    const grants = await resolveGrantedPermissions(clinicId, req.role!);
    const context = createToolContext({
      clinicId,
      timeZone: clinic?.timezone || 'UTC',
      userId: reviewerId,
      role: req.role ?? '',
      permissions: [...grants],
    });
    const args =
      request.arguments !== null
      && typeof request.arguments === 'object'
      && !Array.isArray(request.arguments)
        ? (request.arguments as Record<string, unknown>)
        : {};

    const startedAt = Date.now();
    const outcome = await copilotToolRegistry.call(context, request.tool_name, args);
    const executionTimeMs = Date.now() - startedAt;
    const error = outcome.ok ? null : outcome.error ?? 'execution failed';

    await recordApprovalAudit({
      clinicId,
      agentId: request.agent_id,
      sessionId: request.session_id,
      supervisorId: reviewerId,
      toolName: request.tool_name,
      toolArguments: request.arguments as Prisma.InputJsonValue,
      result: outcome.ok ? ((outcome.data ?? null) as Prisma.InputJsonValue) : null,
      error,
      status: outcome.ok ? 'success' : 'failed',
      executionTimeMs,
    });

    const finished = (await finishApproval(clinicId, requestId, { ok: outcome.ok, error })) ?? request;
    res.json(ok({ ...toApprovalDto(finished), ok: outcome.ok, error }));
  },
);

agentsRouter.post(
  '/approvals/:requestId/reject',
  authenticate,
  requireClinic,
  requirePermission('agents.supervise'),
  async (req, res) => {
    const requestId = uuid.parse(req.params.requestId);
    const input = approvalDecisionSchema.parse(req.body ?? {});
    const request = await rejectApproval(
      req.clinicId!,
      requestId,
      req.user!.id,
      input.notes ?? null,
    );
    if (!request) approvalNotFound();
    res.json(ok(toApprovalDto(request)));
  },
);

agentsRouter.get(
  '/audit',
  authenticate,
  requireClinic,
  requirePermission('agents.view'),
  async (req, res) => {
    const agentIdRaw = queryString(req, 'agent_id');
    const agentId = agentIdRaw === undefined ? undefined : uuid.parse(agentIdRaw);
    const limit = Math.min(Math.max(Number.parseInt(queryString(req, 'limit') ?? '', 10) || 100, 1), 500);
    const rows = await listAudit(req.clinicId!, agentId, limit);
    res.json(paginated(rows.map(toAuditLogDto), rows.length, 1, rows.length || 1));
  },
);

agentsRouter.get(
  '/:agentId/sessions',
  authenticate,
  requireClinic,
  requirePermission('agents.view'),
  async (req, res) => {
    const agentId = uuid.parse(req.params.agentId);
    const rows = await listSessions(req.clinicId!, agentId);
    res.json(paginated(rows.map(toSessionDto), rows.length, 1, rows.length || 1));
  },
);
