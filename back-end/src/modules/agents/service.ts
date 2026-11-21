import {
  Prisma,
  type agent_approval_queue,
  type agent_audit_logs,
  type agent_sessions,
  type agents,
} from '@prisma/client';

import { notFound } from '../../lib/errors';
import { prisma } from '../../lib/prisma';
import type { AgentCreateInput, ApprovalStatus } from './schemas';

/** Miroir de `backend/app/core/agents/service.py` (lecture + décisions). */

export interface AgentDto {
  id: string;
  clinic_id: string;
  name: string;
  type: string;
  mode: string;
  config: Prisma.JsonValue;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AgentSessionDto {
  id: string;
  agent_id: string;
  supervisor_id: string | null;
  status: string;
  created_at: string;
  ended_at: string | null;
}

export interface ApprovalDto {
  id: string;
  agent_id: string;
  session_id: string;
  tool_name: string;
  arguments: Prisma.JsonValue;
  reason: string | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
  error?: string | null;
}

export interface AuditLogDto {
  id: string;
  agent_id: string;
  session_id: string;
  supervisor_id: string | null;
  tool_name: string;
  tool_arguments: Prisma.JsonValue;
  result: Prisma.JsonValue;
  error: string | null;
  status: string;
  execution_time_ms: number;
  created_at: string;
}

export function toAgentDto(row: agents): AgentDto {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    name: row.name,
    type: row.type,
    mode: row.mode,
    config: row.config,
    status: row.status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function toSessionDto(row: agent_sessions): AgentSessionDto {
  return {
    id: row.id,
    agent_id: row.agent_id,
    supervisor_id: row.supervisor_id,
    status: row.status,
    created_at: row.created_at.toISOString(),
    ended_at: row.ended_at?.toISOString() ?? null,
  };
}

export function toApprovalDto(row: agent_approval_queue): ApprovalDto {
  return {
    id: row.id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    tool_name: row.tool_name,
    arguments: row.arguments,
    reason: row.reason,
    status: row.status,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at?.toISOString() ?? null,
    review_notes: row.review_notes,
    created_at: row.created_at.toISOString(),
  };
}

export function toAuditLogDto(row: agent_audit_logs): AuditLogDto {
  return {
    id: row.id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    supervisor_id: row.supervisor_id,
    tool_name: row.tool_name,
    tool_arguments: row.tool_arguments,
    result: row.result,
    error: row.error,
    status: row.status,
    execution_time_ms: row.execution_time_ms,
    created_at: row.created_at.toISOString(),
  };
}

export async function listAgents(clinicId: string): Promise<agents[]> {
  return prisma.agents.findMany({
    where: { clinic_id: clinicId },
    orderBy: { created_at: 'asc' },
  });
}

export async function createAgent(clinicId: string, input: AgentCreateInput): Promise<agents> {
  const now = new Date();
  return prisma.agents.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: clinicId,
      name: input.name,
      type: input.type,
      mode: input.mode,
      config: input.config as Prisma.InputJsonValue,
      created_at: now,
      updated_at: now,
    },
  });
}

export async function listSessions(
  clinicId: string,
  agentId: string,
): Promise<agent_sessions[]> {
  return prisma.agent_sessions.findMany({
    where: { clinic_id: clinicId, agent_id: agentId },
    orderBy: { created_at: 'desc' },
  });
}

export async function listApprovals(
  clinicId: string,
  status: ApprovalStatus,
): Promise<agent_approval_queue[]> {
  return prisma.agent_approval_queue.findMany({
    where: { clinic_id: clinicId, status },
    orderBy: { created_at: 'asc' },
  });
}

async function decide(
  clinicId: string,
  requestId: string,
  status: 'rejected',
  reviewerId: string,
  notes: string | null,
): Promise<agent_approval_queue | null> {
  return prisma.$transaction(async (tx) => {
    const request = await tx.agent_approval_queue.findFirst({
      where: { id: requestId, clinic_id: clinicId },
    });
    if (!request || request.status !== 'pending') return null;
    return tx.agent_approval_queue.update({
      where: { id: requestId },
      data: {
        status,
        reviewed_by: reviewerId,
        reviewed_at: new Date(),
        review_notes: notes,
        updated_at: new Date(),
      },
    });
  });
}

export async function rejectApproval(
  clinicId: string,
  requestId: string,
  reviewerId: string,
  notes: string | null,
): Promise<agent_approval_queue | null> {
  return decide(clinicId, requestId, 'rejected', reviewerId, notes);
}

// ---------------------------------------------------------------------------
// Exécution d'une approbation (#exécution)
// ---------------------------------------------------------------------------

/**
 * Réserve atomiquement une demande `pending` (`approved` = en cours). Deux
 * superviseurs qui cliquent en même temps : un seul gagne, l'autre reçoit
 * `null` (404 côté routeur) et l'outil n'est exécuté qu'une fois.
 */
export async function claimApproval(
  clinicId: string,
  requestId: string,
  reviewerId: string,
  notes: string | null,
): Promise<agent_approval_queue | null> {
  const claimed = await prisma.agent_approval_queue.updateMany({
    where: { id: requestId, clinic_id: clinicId, status: 'pending' },
    data: {
      status: 'approved',
      reviewed_by: reviewerId,
      reviewed_at: new Date(),
      review_notes: notes,
      updated_at: new Date(),
    },
  });
  if (claimed.count === 0) return null;
  return prisma.agent_approval_queue.findFirst({ where: { id: requestId, clinic_id: clinicId } });
}

/** Statut final : `executed`, ou `failed` avec le motif dans `review_notes`. */
export async function finishApproval(
  clinicId: string,
  requestId: string,
  outcome: { ok: boolean; error: string | null },
): Promise<agent_approval_queue | null> {
  const data = outcome.ok
    ? { status: 'executed', updated_at: new Date() }
    : {
        status: 'failed',
        updated_at: new Date(),
        review_notes: outcome.error ? outcome.error.slice(0, 1000) : 'execution failed',
      };
  await prisma.agent_approval_queue.updateMany({
    where: { id: requestId, clinic_id: clinicId, status: 'approved' },
    data,
  });
  return prisma.agent_approval_queue.findFirst({ where: { id: requestId, clinic_id: clinicId } });
}

export interface ApprovalAuditInput {
  clinicId: string;
  agentId: string;
  sessionId: string;
  supervisorId: string;
  toolName: string;
  toolArguments: Prisma.InputJsonValue;
  result: Prisma.InputJsonValue | null;
  error: string | null;
  status: 'success' | 'failed';
  executionTimeMs: number;
}

export async function recordApprovalAudit(input: ApprovalAuditInput): Promise<void> {
  const now = new Date();
  await prisma.agent_audit_logs.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: input.clinicId,
      agent_id: input.agentId,
      session_id: input.sessionId,
      supervisor_id: input.supervisorId,
      tool_name: input.toolName,
      tool_arguments: input.toolArguments,
      result: input.result ?? Prisma.JsonNull,
      error: input.error,
      status: input.status,
      execution_time_ms: input.executionTimeMs,
      created_at: now,
      updated_at: now,
    },
  });
}

export function approvalNotFound(): never {
  throw notFound('Approval request not found or not pending');
}

export async function listAudit(
  clinicId: string,
  agentId: string | undefined,
  limit: number,
): Promise<agent_audit_logs[]> {
  return prisma.agent_audit_logs.findMany({
    where: { clinic_id: clinicId, ...(agentId ? { agent_id: agentId } : {}) },
    orderBy: { created_at: 'desc' },
    take: limit,
  });
}
