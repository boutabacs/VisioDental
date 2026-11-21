/**
 * Couche service du module copilot — port de
 * `app/modules/copilot/{service,serde,models}.py`.
 *
 * Multi-tenant : toutes les lectures sont bornées par `clinicId` ; une
 * conversation d'une autre clinique (ou d'un autre utilisateur quand le
 * filtre s'applique) est traitée comme inexistante → 404 côté routeur.
 * Les dates stockées sont des instants (`Timestamptz`) sérialisés en ISO
 * UTC, comme Pydantic.
 */

import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';

import { config } from '../../config';
import { prisma } from '../../lib/prisma';
import { getProviderSpec, LLMConfigError } from './provider';
import type {
  ConversationDto,
  MessageDto,
  MetricsDto,
  NudgeDto,
  SettingsDto,
  SettingsUpdateInput,
} from './schemas';
import { copilotToolRegistry, permissionMatches, type AgentToolContext } from './tools';

// ---------------------------------------------------------------------------
// Contenu des messages (serde.py)
// ---------------------------------------------------------------------------

export type ContentBlockJson =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      provider_meta?: Record<string, unknown>;
    }
  | { type: 'tool_result'; tool_call_id: string; content: unknown; is_error: boolean };

export interface ProviderMessageLike {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ContentBlockJson[];
}

/** `content_to_json` : les blocs sont déjà au format JSON neutre. */
export function contentToJson(blocks: ContentBlockJson[]): ContentBlockJson[] {
  return blocks.map((block) => ({ ...block }));
}

/** `message_from_row` : relit un message stocké en espace réel. */
export function messageFromRow(role: string, content: Prisma.JsonValue): ProviderMessageLike {
  const blocks = Array.isArray(content) ? (content as unknown[]) : [];
  return {
    role: role as ProviderMessageLike['role'],
    content: blocks.map((block) => ({ ...(block as ContentBlockJson) })),
  };
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

type ConversationRow = Prisma.copilot_conversationsGetPayload<Record<string, never>>;
type NudgeRow = Prisma.copilot_nudgesGetPayload<Record<string, never>>;
type MessageRow = Prisma.copilot_messagesGetPayload<Record<string, never>>;

export function toConversationDto(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    provider: row.provider,
    model: row.model,
    total_input_tokens: row.total_input_tokens,
    total_output_tokens: row.total_output_tokens,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function toMessageDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    role: row.role,
    content: Array.isArray(row.content) ? (row.content as unknown[]) : [],
    created_at: row.created_at.toISOString(),
  };
}

export function toNudgeDto(row: NudgeRow): NudgeDto {
  return {
    id: row.id,
    kind: row.kind,
    payload:
      row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {},
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
  };
}

/** `digest_recipient_user_ids` est une colonne JSONB (liste de strings). */
export function recipientIds(row: { digest_recipient_user_ids: Prisma.JsonValue }): string[] {
  const value = row.digest_recipient_user_ids;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function toSettingsDto(row: {
  provider: string;
  model: string;
  redaction_enabled: boolean;
  monthly_token_limit: number | null;
  monthly_cost_limit_cents: number | null;
  digest_enabled: boolean;
  digest_hour: number;
  digest_recipient_user_ids: Prisma.JsonValue;
  period_input_tokens: number;
  period_output_tokens: number;
}): SettingsDto {
  return {
    provider: row.provider,
    model: row.model,
    redaction_enabled: row.redaction_enabled,
    monthly_token_limit: row.monthly_token_limit,
    monthly_cost_limit_cents: row.monthly_cost_limit_cents,
    digest_enabled: row.digest_enabled,
    digest_hour: row.digest_hour,
    digest_recipient_user_ids: recipientIds(row),
    period_input_tokens: row.period_input_tokens,
    period_output_tokens: row.period_output_tokens,
  };
}

// ---------------------------------------------------------------------------
// Dates : mois calendaire UTC (period_start) et durée de fenêtre
// ---------------------------------------------------------------------------

/** Premier jour du mois UTC courant — `datetime.now(UTC).date().replace(day=1)`. */
export function currentPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Même jour calendaire UTC que la colonne `date` renvoyée par Prisma. */
export function sameUtcDate(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/** `window_days` borné 1..365 (miroir du clamp du service Python). */
export function clampWindowDays(days: number): number {
  return Math.min(Math.max(days, 1), 365);
}

/** `(used / limit)` si `limit` non nul, sinon `null` (`token_usage_pct`). */
export function tokenUsagePct(used: number, limit: number | null): number | null {
  return limit ? used / limit : null;
}

/** `error_rate` : `failed / total`, `0.0` quand il n'y a aucun appel. */
export function errorRate(failed: number, total: number): number {
  return total ? failed / total : 0;
}

// ---------------------------------------------------------------------------
// Agents (core agents.service — le copilot réutilise la session par clinique)
// ---------------------------------------------------------------------------

export async function getOrCreateCopilotAgent(clinicId: string) {
  const existing = await prisma.agents.findFirst({
    where: { clinic_id: clinicId, type: 'copilot' },
    orderBy: { created_at: 'asc' },
  });
  if (existing) return existing;
  const now = new Date();
  return prisma.agents.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: clinicId,
      name: 'Copilot',
      type: 'copilot',
      mode: 'autonomous',
      config: {},
      created_at: now,
      updated_at: now,
    },
  });
}

export async function startAgentSession(
  agentId: string,
  clinicId: string,
  supervisorId: string | null,
  metadata: Record<string, unknown>,
) {
  const now = new Date();
  return prisma.agent_sessions.create({
    data: {
      id: crypto.randomUUID(),
      agent_id: agentId,
      clinic_id: clinicId,
      supervisor_id: supervisorId,
      session_metadata: metadata as Prisma.InputJsonValue,
      created_at: now,
      updated_at: now,
    },
  });
}

// ---------------------------------------------------------------------------
// Réglages (CopilotSettingsService)
// ---------------------------------------------------------------------------

export type SettingsRow = Prisma.copilot_settingsGetPayload<Record<string, never>>;

export interface SettingsLoad {
  row: SettingsRow;
  /** `true` quand `_roll_period` a remis les compteurs à zéro (à persister). */
  rolled: boolean;
  /** `true` quand la ligne vient d'être insérée. */
  created: boolean;
}

export class CopilotSettingsService {
  /**
   * Réglages de la clinique, créés à la première lecture. Les compteurs
   * mensuels sont remis à zéro quand le mois UTC a changé ; la remise à zéro
   * n'est persistée que lorsque l'appelant écrit (comme l'`onupdate` +
   * commit SQLAlchemy).
   */
  static async getOrCreate(clinicId: string, now: Date = new Date()): Promise<SettingsLoad> {
    const existing = await prisma.copilot_settings.findUnique({ where: { clinic_id: clinicId } });
    if (existing) {
      const firstOfMonth = currentPeriodStart(now);
      if (sameUtcDate(existing.period_start, firstOfMonth)) {
        return { row: existing, rolled: false, created: false };
      }
      return {
        row: {
          ...existing,
          period_start: firstOfMonth,
          period_input_tokens: 0,
          period_output_tokens: 0,
          period_cost_cents: 0,
        },
        rolled: true,
        created: false,
      };
    }
    const defaultSpec = getProviderSpec(config.copilotProviderDefault);
    const row = await prisma.copilot_settings.create({
      data: {
        clinic_id: clinicId,
        provider: defaultSpec.name,
        model: defaultSpec.defaultModel,
        redaction_enabled: config.copilotRedactionDefault,
        digest_enabled: false,
        digest_hour: 8,
        digest_recipient_user_ids: [],
        period_start: currentPeriodStart(now),
        period_input_tokens: 0,
        period_output_tokens: 0,
        period_cost_cents: 0,
        updated_at: new Date(),
      },
    });
    return { row, rolled: false, created: true };
  }

  /** Variante persistante : la remise à zéro éventuelle est écrite en base. */
  static async getOrCreatePersisted(clinicId: string, now: Date = new Date()): Promise<SettingsRow> {
    const { row, rolled, created } = await CopilotSettingsService.getOrCreate(clinicId, now);
    if (created || !rolled) return row;
    return prisma.copilot_settings.update({
      where: { clinic_id: clinicId },
      data: {
        period_start: row.period_start,
        period_input_tokens: 0,
        period_output_tokens: 0,
        period_cost_cents: 0,
        updated_at: new Date(),
      },
    });
  }

  /**
   * PATCH partiel. `data` ne contient que les clés envoyées. Lève une
   * `Error` (message identique à Python) traduite en 400 par le routeur.
   */
  static async update(
    clinicId: string,
    data: SettingsUpdateInput,
    actingUserId?: string | null,
    now: Date = new Date(),
  ): Promise<SettingsRow> {
    const row = await CopilotSettingsService.getOrCreatePersisted(clinicId, now);
    const changes: Prisma.copilot_settingsUncheckedUpdateInput = { updated_at: new Date() };

    const providerName = data.provider ?? null;
    if (providerName !== null) {
      let spec;
      try {
        spec = getProviderSpec(providerName);
      } catch (error) {
        if (error instanceof LLMConfigError) throw new Error(error.message);
        throw error;
      }
      if (spec.needsApiKey && !process.env[spec.apiKeySetting ?? '']) {
        throw new Error(
          `${spec.label} provider selected but ${spec.apiKeySetting} is not configured`,
        );
      }
      // Changer de fournisseur sans modèle laisserait l'identifiant de
      // l'autre fournisseur : on prend le défaut du fournisseur choisi.
      if (providerName !== row.provider && !data.model) {
        changes.model = spec.defaultModel;
      }
    }

    // Les limites sont nullables et `null` = « pas de plafond » : ici une
    // valeur explicite `null` est bien une valeur.
    for (const field of ['monthly_token_limit', 'monthly_cost_limit_cents'] as const) {
      if (field in data) changes[field] = data[field] ?? null;
    }
    for (const field of [
      'provider',
      'model',
      'redaction_enabled',
      'digest_enabled',
      'digest_hour',
    ] as const) {
      const value = data[field];
      if (value !== undefined && value !== null) {
        (changes as Record<string, unknown>)[field] = value;
      }
    }

    let recipients = recipientIds(row);
    if (data.digest_recipient_user_ids !== undefined && data.digest_recipient_user_ids !== null) {
      const ids = data.digest_recipient_user_ids;
      await assertClinicMembers(clinicId, ids);
      recipients = ids;
      changes.digest_recipient_user_ids = ids;
    }
    // Activer le digest sans destinataire → l'utilisateur qui bascule le
    // bouton devient le destinataire.
    const nextDigestEnabled = (changes.digest_enabled as boolean | undefined) ?? row.digest_enabled;
    if (nextDigestEnabled && recipients.length === 0 && actingUserId) {
      recipients = [actingUserId];
      changes.digest_recipient_user_ids = recipients;
    }

    return prisma.copilot_settings.update({ where: { clinic_id: clinicId }, data: changes });
  }
}

export function rollPeriod(row: SettingsRow, now: Date = new Date()): SettingsRow {
  const firstOfMonth = currentPeriodStart(now);
  if (sameUtcDate(row.period_start, firstOfMonth)) return row;
  return {
    ...row,
    period_start: firstOfMonth,
    period_input_tokens: 0,
    period_output_tokens: 0,
    period_cost_cents: 0,
  };
}

/** `_assert_clinic_members` → message `Not clinic members: id, id`. */
export async function assertClinicMembers(clinicId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const memberships = await prisma.clinic_memberships.findMany({
    where: { clinic_id: clinicId, user_id: { in: userIds } },
    select: { user_id: true },
  });
  const members = new Set(memberships.map((membership) => membership.user_id));
  const missing = userIds.filter((userId) => !members.has(userId));
  if (missing.length > 0) {
    throw new Error(`Not clinic members: ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Conversations (ConversationService)
// ---------------------------------------------------------------------------

export class ConversationService {
  static async create(options: {
    clinicId: string;
    userId: string;
    provider: string;
    model: string;
    context?: Record<string, unknown> | null;
    sessionId?: string | null;
  }): Promise<ConversationRow> {
    const now = new Date();
    return prisma.copilot_conversations.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: options.clinicId,
        user_id: options.userId,
        session_id: options.sessionId ?? null,
        context: (options.context ?? {}) as Prisma.InputJsonValue,
        provider: options.provider,
        model: options.model,
        status: 'active',
        total_input_tokens: 0,
        total_output_tokens: 0,
        cost_cents: 0,
        created_at: now,
        updated_at: now,
      },
    });
  }

  /**
   * `get(...)`: `userId` non nul restreint la lecture à son propriétaire ;
   * toute autre clinique (ou un autre propriétaire) → `null` → 404.
   */
  static async get(
    clinicId: string,
    conversationId: string,
    userId?: string | null,
  ): Promise<ConversationRow | null> {
    const row = await prisma.copilot_conversations.findUnique({
      where: { id: conversationId },
    });
    if (!row || row.clinic_id !== clinicId) return null;
    if (userId !== undefined && userId !== null && row.user_id !== userId) return null;
    return row;
  }

  static async list(
    clinicId: string,
    options: { userId?: string | null; page: number; pageSize: number },
  ): Promise<{ rows: ConversationRow[]; total: number }> {
    const pageSize = Math.min(Math.max(options.pageSize, 1), 100);
    const page = Math.max(options.page, 1);
    const where: Prisma.copilot_conversationsWhereInput = { clinic_id: clinicId };
    if (options.userId !== undefined && options.userId !== null) {
      where.user_id = options.userId;
    }
    const [total, rows] = await Promise.all([
      prisma.copilot_conversations.count({ where }),
      prisma.copilot_conversations.findMany({
        where,
        orderBy: [{ updated_at: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { rows, total };
  }

  static async listMessages(conversationId: string): Promise<MessageRow[]> {
    return prisma.copilot_messages.findMany({
      where: { conversation_id: conversationId },
      orderBy: [{ seq: 'asc' }, { created_at: 'asc' }, { id: 'asc' }],
    });
  }

  /** `max(seq) + 1` — ordinal monotone par conversation. */
  static async nextSeq(conversationId: string): Promise<number> {
    const aggregate = await prisma.copilot_messages.aggregate({
      where: { conversation_id: conversationId },
      _max: { seq: true },
    });
    return (aggregate._max.seq ?? 0) + 1;
  }

  static async appendMessage(
    conversation: { id: string; clinic_id: string },
    options: {
      role: 'system' | 'user' | 'assistant' | 'tool';
      blocks: ContentBlockJson[];
      inputTokens?: number;
      outputTokens?: number;
    },
  ): Promise<MessageRow> {
    return prisma.copilot_messages.create({
      data: {
        id: crypto.randomUUID(),
        conversation_id: conversation.id,
        clinic_id: conversation.clinic_id,
        seq: await ConversationService.nextSeq(conversation.id),
        role: options.role,
        content: contentToJson(options.blocks) as Prisma.InputJsonValue,
        input_tokens: options.inputTokens ?? 0,
        output_tokens: options.outputTokens ?? 0,
        created_at: new Date(),
      },
    });
  }

  /** `status = "ended"` + `updated_at` (onupdate SQLAlchemy). */
  static async end(conversationId: string): Promise<ConversationRow> {
    return prisma.copilot_conversations.update({
      where: { id: conversationId },
      data: { status: 'ended', updated_at: new Date() },
    });
  }
}

// ---------------------------------------------------------------------------
// Garde de budget (ClinicBudgetGuard)
// ---------------------------------------------------------------------------

export class ClinicBudgetGuard {
  public thresholdCrossed = false;

  constructor(
    private readonly settings: {
      monthly_token_limit: number | null;
      period_input_tokens: number;
      period_output_tokens: number;
    },
    private readonly conversation: {
      total_input_tokens: number;
      total_output_tokens: number;
    },
  ) {}

  check(): boolean {
    const limit = this.settings.monthly_token_limit;
    if (limit === null) return true;
    return this.settings.period_input_tokens + this.settings.period_output_tokens < limit;
  }

  record(inputTokens: number, outputTokens: number): void {
    this.settings.period_input_tokens += inputTokens;
    this.settings.period_output_tokens += outputTokens;
    this.conversation.total_input_tokens += inputTokens;
    this.conversation.total_output_tokens += outputTokens;
    const limit = this.settings.monthly_token_limit;
    if (limit) {
      const used = this.settings.period_input_tokens + this.settings.period_output_tokens;
      if (used >= Math.trunc(limit * 0.8)) this.thresholdCrossed = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Nudges (NudgeService)
// ---------------------------------------------------------------------------

export class NudgeService {
  /** Insertion idempotente sur `dedupe_key` → `null` si déjà présente. */
  static async create(options: {
    clinicId: string;
    kind: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
    expiresAt: Date;
    requiredPermission?: string | null;
  }): Promise<NudgeRow | null> {
    const existing = await prisma.copilot_nudges.findFirst({
      where: { clinic_id: options.clinicId, dedupe_key: options.dedupeKey },
      select: { id: true },
    });
    if (existing) return null;
    return prisma.copilot_nudges.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: options.clinicId,
        kind: options.kind,
        dedupe_key: options.dedupeKey,
        payload: options.payload as Prisma.InputJsonValue,
        required_permission: options.requiredPermission ?? null,
        status: 'pending',
        created_at: new Date(),
        expires_at: options.expiresAt,
      },
    });
  }

  /**
   * Nudges `pending` non expirés, du plus récent au plus ancien (max 20),
   * filtrés sur les permissions effectives du rôle appelant.
   */
  static async listActive(
    clinicId: string,
    granted: string[],
    now: Date = new Date(),
  ): Promise<NudgeRow[]> {
    const rows = await prisma.copilot_nudges.findMany({
      where: { clinic_id: clinicId, status: 'pending', expires_at: { gt: now } },
      orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
      take: 20,
    });
    return rows.filter(
      (row) =>
        row.required_permission === null ||
        granted.some((grant) => permissionMatches(row.required_permission!, grant)),
    );
  }

  /** `false` si le nudge n'existe pas ou appartient à une autre clinique. */
  static async dismiss(clinicId: string, nudgeId: string): Promise<boolean> {
    const nudge = await prisma.copilot_nudges.findUnique({ where: { id: nudgeId } });
    if (!nudge || nudge.clinic_id !== clinicId) return false;
    await prisma.copilot_nudges.update({
      where: { id: nudgeId },
      data: { status: 'dismissed' },
    });
    return true;
  }
}

// ---------------------------------------------------------------------------
// Pendientes (PendingService) — registry, lecture seule
// ---------------------------------------------------------------------------

/**
 * Session « pending » unique par clinique : une ouverture du tiroir ne crée
 * pas de ligne `agent_sessions` à chaque fois.
 */
export async function getOrCreatePendingSession(agentId: string, clinicId: string, userId: string) {
  const existing = await prisma.agent_sessions.findFirst({
    where: {
      agent_id: agentId,
      session_metadata: { path: ['surface'], equals: 'copilot_pending' },
    },
    orderBy: { created_at: 'asc' },
  });
  if (existing) return existing;
  return startAgentSession(agentId, clinicId, userId, { surface: 'copilot_pending' });
}

export class PendingService {
  static async get(context: AgentToolContext): Promise<
    Array<{
      kind: 'recall' | 'budget';
      id: string;
      patient_id: string | null;
      title: string | null;
      link: string;
      reason?: string | null;
      priority?: string | null;
      number?: string | null;
      amount?: number | null;
    }>
  > {
    const call = async (name: string, args: Record<string, unknown>) => {
      if (!copilotToolRegistry.list().includes(name)) return null;
      const result = await copilotToolRegistry.call(context, name, args);
      return result.ok ? (result.data as Record<string, unknown>) : null;
    };

    const items: Array<{
      kind: 'recall' | 'budget';
      id: string;
      patient_id: string | null;
      title: string | null;
      link: string;
      reason?: string | null;
      priority?: string | null;
      number?: string | null;
      amount?: number | null;
    }> = [];

    const recalls = await call('recalls.list_due_recalls', { overdue: true });
    for (const recall of (recalls?.recalls as Array<Record<string, unknown>> | undefined) ?? []) {
      items.push({
        kind: 'recall',
        id: String(recall.id),
        patient_id: recall.patient_id ? String(recall.patient_id) : null,
        title: (recall.patient_name as string | null | undefined) ?? null,
        reason: (recall.reason as string | null | undefined) ?? null,
        priority: (recall.priority as string | null | undefined) ?? null,
        link: '/recalls',
      });
    }

    const budgets = await call('budget.list_budgets', { status: ['sent'] });
    for (const budget of (budgets?.budgets as Array<Record<string, unknown>> | undefined) ?? []) {
      items.push({
        kind: 'budget',
        id: String(budget.id),
        patient_id: budget.patient_id ? String(budget.patient_id) : null,
        title: (budget.patient_name as string | null | undefined) ?? null,
        number: (budget.number as string | null | undefined) ?? null,
        amount: typeof budget.total === 'number' ? budget.total : null,
        link: `/budgets/${budget.id}`,
      });
    }

    return items;
  }
}

// ---------------------------------------------------------------------------
// Métriques (CopilotMetricsService)
// ---------------------------------------------------------------------------

const FAILED_STATUSES = ['FAILED', 'BLOCKED'];

export class CopilotMetricsService {
  static async get(
    clinicId: string,
    windowDays: number,
    now: Date = new Date(),
  ): Promise<MetricsDto> {
    const days = clampWindowDays(windowDays);
    const cutoff = new Date(now.getTime() - days * 24 * 3600 * 1000);

    // `agent_audit_logs` joint à `agents` filtré sur `type = "copilot"`.
    const scope = {
      clinic_id: clinicId,
      created_at: { gte: cutoff },
      agents: { clinic_id: clinicId, type: 'copilot' },
    } satisfies Prisma.agent_audit_logsWhereInput;

    const [totals, failed, avg, grouped, conversations, settingsRow] = await Promise.all([
      prisma.agent_audit_logs.count({ where: scope }),
      prisma.agent_audit_logs.count({ where: { ...scope, status: { in: FAILED_STATUSES } } }),
      prisma.agent_audit_logs.aggregate({
        where: scope,
        _avg: { execution_time_ms: true },
      }),
      prisma.agent_audit_logs.groupBy({
        by: ['tool_name'],
        where: scope,
        _count: { _all: true },
      }),
      prisma.copilot_conversations.count({
        where: { clinic_id: clinicId, created_at: { gte: cutoff } },
      }),
      CopilotSettingsService.getOrCreatePersisted(clinicId, now),
    ]);

    // Deuxième passage : erreurs par outil (le groupBy ne filtre pas par
    // status en même temps que le total).
    const failedByTool = await prisma.agent_audit_logs.groupBy({
      by: ['tool_name'],
      where: { ...scope, status: { in: FAILED_STATUSES } },
      _count: { _all: true },
    });
    const errorsByTool = new Map(failedByTool.map((row) => [row.tool_name, row._count._all]));

    const topTools = grouped
      .map((row) => ({
        tool_name: row.tool_name,
        calls: row._count._all,
        errors: errorsByTool.get(row.tool_name) ?? 0,
      }))
      .sort((a, b) => b.calls - a.calls || a.tool_name.localeCompare(b.tool_name))
      .slice(0, 10);

    const used = settingsRow.period_input_tokens + settingsRow.period_output_tokens;
    return {
      window_days: days,
      total_tool_calls: totals,
      failed_tool_calls: failed,
      error_rate: errorRate(failed, totals),
      avg_execution_ms: Math.trunc(avg._avg.execution_time_ms ?? 0),
      conversations,
      top_tools: topTools,
      period_input_tokens: settingsRow.period_input_tokens,
      period_output_tokens: settingsRow.period_output_tokens,
      monthly_token_limit: settingsRow.monthly_token_limit,
      token_usage_pct: tokenUsagePct(used, settingsRow.monthly_token_limit),
    };
  }
}
