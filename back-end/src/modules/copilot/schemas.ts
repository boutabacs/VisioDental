/**
 * Schémas Zod du module copilot — port de `app/modules/copilot/schemas.py`.
 *
 * Les corps de requête reproduisent les contraintes Pydantic (`max_length`,
 * `ge`, `le`, `Literal`). Les DTO de réponse (`ConversationResponse`,
 * `MessageResponse`, …) sont des interfaces : leur sérialisation est faite
 * par `service.ts`.
 */

import { z } from 'zod';

const uuid = z.string().uuid();

// ---------------------------------------------------------------------------
// Corps de requête
// ---------------------------------------------------------------------------

/**
 * `SessionCreate` (Pydantic) n'a que `context: dict = {}`. Un corps absent
 * (`None`) est refusé : le paramètre est obligatoire côté FastAPI.
 */
export const sessionCreateSchema = z.object({
  // `dict[str, Any]` — tout objet JSON, `null` refusé.
  context: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** `MessageCreate` — `content` 1..8000. */
export const messageCreateSchema = z.object({
  content: z.string().min(1).max(8000),
});

/** `ConfirmRequest` — `Literal["confirm", "reject"]`. */
export const DECISIONS = ['confirm', 'reject'] as const;
export const confirmRequestSchema = z.object({
  decision: z.enum(DECISIONS),
});

/**
 * `SettingsUpdate` — `exclude_unset` côté Python : seule l'absence de la clé
 * signifie « ne pas toucher » ; un `null` explicite efface la limite.
 * `provider`/`model` vides (``""``) sont refusés par `max_length` uniquement
 * côté Pydantic, donc acceptés tels quels ici (même comportement).
 */
export const settingsUpdateSchema = z.object({
  provider: z.string().max(20).nullable().optional(),
  model: z.string().max(100).nullable().optional(),
  redaction_enabled: z.boolean().nullable().optional(),
  monthly_token_limit: z.number().int().min(0).nullable().optional(),
  monthly_cost_limit_cents: z.number().int().min(0).nullable().optional(),
  digest_enabled: z.boolean().nullable().optional(),
  digest_hour: z.number().int().min(0).max(23).nullable().optional(),
  digest_recipient_user_ids: z.array(uuid).nullable().optional(),
});

export type SessionCreateInput = z.infer<typeof sessionCreateSchema>;
export type MessageCreateInput = z.infer<typeof messageCreateSchema>;
export type ConfirmRequestInput = z.infer<typeof confirmRequestSchema>;
export type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;

// ---------------------------------------------------------------------------
// DTO de réponse (miroir des Response/BaseModel de schemas.py)
// ---------------------------------------------------------------------------

export interface ConversationDto {
  id: string;
  title: string | null;
  status: string;
  provider: string;
  model: string;
  total_input_tokens: number;
  total_output_tokens: number;
  created_at: string;
  updated_at: string;
}

export interface MessageDto {
  id: string;
  role: string;
  content: unknown[];
  created_at: string;
}

export interface SettingsDto {
  provider: string;
  model: string;
  redaction_enabled: boolean;
  monthly_token_limit: number | null;
  monthly_cost_limit_cents: number | null;
  digest_enabled: boolean;
  digest_hour: number;
  digest_recipient_user_ids: string[];
  period_input_tokens: number;
  period_output_tokens: number;
}

export type PendingItemDto =
  | {
      kind: 'recall';
      id: string;
      patient_id: string | null;
      title: string | null;
      link: string;
      reason: string | null;
      priority: string | null;
      number?: undefined;
      amount?: undefined;
    }
  | {
      kind: 'budget';
      id: string;
      patient_id: string | null;
      title: string | null;
      link: string;
      number: string | null;
      amount: number | null;
      reason?: undefined;
      priority?: undefined;
    };

export interface NudgeDto {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
  expires_at: string;
}

export interface ToolStatDto {
  tool_name: string;
  calls: number;
  errors: number;
}

export interface MetricsDto {
  window_days: number;
  total_tool_calls: number;
  failed_tool_calls: number;
  error_rate: number;
  avg_execution_ms: number;
  conversations: number;
  top_tools: ToolStatDto[];
  period_input_tokens: number;
  period_output_tokens: number;
  monthly_token_limit: number | null;
  token_usage_pct: number | null;
}

// ---------------------------------------------------------------------------
// Validation des paramètres de requête (Query(...))
// ---------------------------------------------------------------------------

/** Miroir des bornes de `Query(default=…, ge=…, le=…)` (422 hors bornes). */
export function boundedIntQuery(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number | { error: string } {
  if (raw === undefined) return fallback;
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    return { error: `${name}: Input should be a valid integer` };
  }
  const value = Number.parseInt(raw, 10);
  if (value < min) return { error: `${name}: Input should be greater than or equal to ${min}` };
  if (value > max) return { error: `${name}: Input should be less than or equal to ${max}` };
  return value;
}
