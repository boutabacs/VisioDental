import { z } from 'zod';

/** Miroir de `backend/app/core/agents/schemas.py`. */

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'executed',
  'failed',
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const agentCreateSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.string().min(1).max(100),
  mode: z.enum(['autonomous', 'supervised']),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const approvalDecisionSchema = z.object({
  notes: z.string().max(1000).nullish(),
});

export const auditQuerySchema = z.object({
  agent_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type AgentCreateInput = z.infer<typeof agentCreateSchema>;
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;
