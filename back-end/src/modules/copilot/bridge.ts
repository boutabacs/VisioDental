/**
 * Bridge du copilot — port de `app/modules/copilot/bridge.py` et du cadrage
 * SSE de `router.py` (`_sse`, `_frame`).
 *
 * Il assemble un tour (`run_turn`), persiste les messages produits et émet
 * les événements que le routeur cadre en SSE. Le fournisseur LLM et le
 * registre d'outils sont injectables (tests) et, en production, résolus par
 * `provider.ts` / `tools.ts`.
 *
 * Écarts assumés par rapport à Python (aucun adaptateur fournisseur ni
 * outil d'écriture embarqué côté Express) :
 *
 * - aucun adaptateur HTTP fournisseur n'est porté : `getProvider` lève une
 *   `LLMConfigError` (message explicite, même texte que Python quand la clé
 *   manque) au premier appel, diffusée en SSE `event: error`.
 * - l'outil utilisateur est **déjà persisté** avant l'appel fournisseur,
 *   comme Python (le commit du tour le conserve même si le tour échoue).
 * - la rédaction tokenise e-mails, IBAN, pièces d'identité, téléphones,
 *   cartes et noms de patients connus de la clinique ; la table jeton →
 *   valeur est salée par `redaction_salt` et persistée avec la conversation.
 */

import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';

import { config } from '../../config';
import { prisma } from '../../lib/prisma';
import {
  LLMConfigError,
  createRedactor,
  getProvider,
  runTurn,
  textBlock,
  toolResultBlock,
  type ContentBlock,
  type Provider,
  type ProviderMessage,
  type Redactor,
  type TurnEvent,
} from './provider';
import {
  ClinicBudgetGuard,
  ConversationService,
  messageFromRow,
  type ContentBlockJson,
} from './service';
import {
  copilotToolRegistry,
  createToolContext,
  toolNamesFor,
  type AgentToolContext,
} from './tools';

type ConversationRow = Prisma.copilot_conversationsGetPayload<Record<string, never>>;
type SettingsRow = Prisma.copilot_settingsGetPayload<Record<string, never>>;
type MessageRow = Prisma.copilot_messagesGetPayload<Record<string, never>>;

export const SYSTEM_PROMPT =
  'Eres el copiloto de VisioDental, asistente de una clínica dental. ' +
  'Respondes en español, con concisión y precisión. Usa las herramientas ' +
  'disponibles para consultar y actuar sobre los datos de la clínica; no ' +
  'inventes información que no provenga de una herramienta. Para acciones ' +
  'que modifican datos (crear, reservar, cancelar) llama a la herramienta ' +
  'correspondiente: el sistema pedirá confirmación al usuario antes de ' +
  'ejecutarla. Nunca asumas permisos que no tengas. ' +
  'Lo facturado y lo cobrado son ejes contables separados: NUNCA ' +
  'calcules, restes ni muestres la diferencia entre ellos (deuda, ' +
  'pendiente, morosidad). Informa cada eje por separado si te lo piden.' +
  '\n\nGuiones habituales (encadena las herramientas tú mismo; si te ' +
  'falta una herramienta para un paso, dilo y continúa con el resto):\n' +
  '- Briefing del día: get_day_overview(hoy) → list_due_recalls(overdue=true) → ' +
  "list_budgets(status=['sent']). Resume en tres bloques: citas, llamadas " +
  'pendientes, presupuestos sin respuesta.\n' +
  '- Preparar visita de un paciente: get_patient → su cita (get_appointment ' +
  'o get_day_overview) → list_due_recalls(patient_id) → ' +
  "list_budgets(patient_id, status=['sent','accepted']) → " +
  'patient_payment_history. Devuelve un resumen de una pantalla. No hay ' +
  'herramientas clínicas (odontograma, historia médica): dilo si te lo piden.\n' +
  '- Cubrir un hueco por cancelación: tras cancel_appointment (o si el ' +
  'usuario menciona un hueco) → list_due_recalls(overdue=true), prioriza ' +
  'priority=high → propón 2-3 candidatos con su teléfono → si el usuario ' +
  'elige uno y confirma: book_appointment → log_contact_attempt(' +
  "outcome='scheduled', linked_appointment_id=la cita creada).";

/** Guardrails du copilot : écritures confirmées inline, pas de file d'approbation. */
export const COPILOT_GUARDRAILS = {
  maxActionsPerMinute: 10,
  maxActionsPerSession: 100,
  requireApprovalFor: [] as string[],
  autoRequireApprovalForDestructive: false,
  blockedTools: [] as string[],
};

// ---------------------------------------------------------------------------
// SSE (`router._sse` / `router._frame`)
// ---------------------------------------------------------------------------

/** `f"event: {event}\ndata: {json}\n\n"` — `null` explicite comme `default=str`. */
export function sseFrame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

export function frameFor(event: TurnEvent): string | null {
  switch (event.kind) {
    case 'token':
      return sseFrame('token', { text: event.text });
    case 'tool_call_started':
      return sseFrame('tool_call', {
        call_id: event.call_id,
        name: event.name,
        arguments: event.arguments,
      });
    case 'tool_call_finished':
      return sseFrame('tool_result', {
        call_id: event.call_id,
        name: event.name,
        ok: event.ok,
        result: event.result,
      });
    case 'confirmation_required':
      return sseFrame('confirmation_required', {
        call_id: event.call_id,
        name: event.name,
        arguments: event.arguments,
      });
    case 'usage':
      return sseFrame('usage', {
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
      });
    case 'final':
      return sseFrame('done', { stop_reason: event.stop_reason });
    case 'budget_exceeded':
      return sseFrame('budget_exceeded', {});
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Contexte et helpers
// ---------------------------------------------------------------------------

/** Codes effectifs du rôle (wildcards compris), comme `granted_permissions_for`. */
export type GrantedPermissions = string[];function toProviderMessages(rows: MessageRow[]): ProviderMessage[] {
  return rows.map((row) => {
    const message = messageFromRow(row.role, row.content);
    return { role: message.role, content: message.content as ContentBlock[] };
  });
}

function toJsonBlocks(blocks: ContentBlock[]): ContentBlockJson[] {
  return blocks as ContentBlockJson[];
}

function toolContext(
  conv: ConversationRow,
  clinicTimezone: string,
  permissions: string[],
  userId: string,
): AgentToolContext {
  return createToolContext({
    clinicId: conv.clinic_id,
    timeZone: clinicTimezone,
    role: '',
    permissions,
    userId,
  });
}

/** `_ensure_redaction_salt` — généré une fois, jamais tourné, jamais émis. */
async function ensureRedactionSalt(conv: ConversationRow): Promise<string> {
  if (conv.redaction_salt) return conv.redaction_salt;
  const salt = crypto.randomBytes(16).toString('hex');
  await prisma.copilot_conversations.update({
    where: { id: conv.id },
    data: { redaction_salt: salt },
  });
  conv.redaction_salt = salt;
  return salt;
}

function redactorFor(settings: SettingsRow, salt: string, aliases: Record<string, string>, directory: readonly string[]): Redactor {
  return createRedactor(settings.redaction_enabled, { salt, aliases, directory });
}

// ---------------------------------------------------------------------------
// Table de symboles (rédaction PHI)
// ---------------------------------------------------------------------------

interface DirectoryEntry {
  at: number;
  values: string[];
}

const DIRECTORY_TTL_MS = 5 * 60_000;
const directoryCache = new Map<string, DirectoryEntry>();

/**
 * Noms de patients de la clinique, utilisés comme dictionnaire de rédaction
 * (un nom seul n'est pas détectable par motif). Cache court : le coût est
 * une requête par clinique toutes les 5 minutes, pas une par message.
 */
async function clinicPhiDirectory(clinicId: string): Promise<string[]> {
  const cached = directoryCache.get(clinicId);
  if (cached && Date.now() - cached.at < DIRECTORY_TTL_MS) return cached.values;
  const patients = await prisma.patients.findMany({
    where: { clinic_id: clinicId },
    select: { first_name: true, last_name: true },
    take: 5000,
  });
  const values = new Set<string>();
  for (const patient of patients) {
    const first = (patient.first_name ?? '').trim();
    const last = (patient.last_name ?? '').trim();
    if (first.length >= 3) values.add(first);
    if (last.length >= 3) values.add(last);
    if (first && last) values.add(`${first} ${last}`);
  }
  const list = [...values];
  directoryCache.set(clinicId, { at: Date.now(), values: list });
  return list;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function storedAliases(conv: ConversationRow): Record<string, string> {
  if (!isRecord(conv.context)) return {};
  const raw = conv.context.redaction_aliases;
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [token, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[token] = value;
  }
  return out;
}

/** Persiste les jetons créés pendant le tour (sans toucher aux autres clés). */
async function persistRedactionAliases(conv: ConversationRow, redactor: Redactor): Promise<void> {
  const exported = redactor.exportAliases?.() ?? {};
  const stored = storedAliases(conv);
  const tokens = Object.keys(exported);
  if (tokens.length === 0) return;
  if (tokens.every((token) => stored[token] === exported[token])) return;
  const context: Record<string, unknown> = isRecord(conv.context) ? { ...conv.context } : {};
  context.redaction_aliases = exported;
  await prisma.copilot_conversations.update({
    where: { id: conv.id },
    data: { context: context as Prisma.InputJsonValue },
  });
  conv.context = context as Prisma.JsonValue;
}

async function redactorForConversation(
  conv: ConversationRow,
  settings: SettingsRow,
): Promise<Redactor> {
  if (!settings.redaction_enabled) return createRedactor(false);
  const salt = await ensureRedactionSalt(conv);
  const aliases = storedAliases(conv);
  const directory = await clinicPhiDirectory(conv.clinic_id).catch(() => [] as string[]);
  return redactorFor(settings, salt, aliases, directory);
}

/** Persiste les messages ajoutés à l'historique depuis `start`. */
async function persistTail(
  conv: ConversationRow,
  history: ProviderMessage[],
  start: number,
): Promise<void> {
  for (const message of history.slice(start)) {
    await ConversationService.appendMessage(conv, {
      role: message.role,
      blocks: toJsonBlocks(message.content),
    });
  }
}

function findPending(
  history: ProviderMessage[],
  callId: string,
): { name: string; input: Record<string, unknown> } | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id === callId) {
        return { name: block.name, input: block.input };
      }
    }
  }
  return null;
}

function findResult(
  history: ProviderMessage[],
  callId: string,
): { content: unknown; is_error: boolean } | null {
  // Du plus ancien au plus récent : un rejet ajoute un marqueur « cancelled »
  // sous le même identifiant, et une approbation ultérieure doit rejouer le
  // résultat d'exécution, pas le marqueur.
  for (const message of history) {
    if (message.role !== 'tool') continue;
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.tool_call_id === callId) {
        return { content: block.content, is_error: block.is_error };
      }
    }
  }
  return null;
}

export interface TurnOptions {
  conv: ConversationRow;
  settingsRow: SettingsRow;
  /** Permissions effectives du rôle appelant (`granted_permissions_for`). */
  permissions: GrantedPermissions;
  userId: string;
  agentId: string;
  sessionId: string | null;
  /** Fuseau de la clinique (requête). */
  timeZone: string;
  /** Fournisseur injecté (tests) ; sinon résolu par `getProvider`. */
  provider?: Provider | null;
}

async function buildRun(options: TurnOptions, conv: ConversationRow) {
  const redactor = await redactorForConversation(conv, options.settingsRow);
  const budget = new ClinicBudgetGuard(
    {
      monthly_token_limit: options.settingsRow.monthly_token_limit,
      period_input_tokens: options.settingsRow.period_input_tokens,
      period_output_tokens: options.settingsRow.period_output_tokens,
    },
    conv,
  );
  const provider = options.provider ?? getProvider(conv.provider);
  const context = toolContext(conv, options.timeZone, options.permissions, options.userId);
  return {
    provider,
    redactor,
    budget,
    context,
    toolNames: toolNamesFor(options.permissions, !redactor.enabled),
  };
}

// ---------------------------------------------------------------------------
// drive_turn / resume_turn
// ---------------------------------------------------------------------------

/** Ajoute le message utilisateur, joue un tour, persiste et émet les événements. */
export async function* driveTurn(options: TurnOptions, userText: string): AsyncGenerator<TurnEvent> {
  const history = toProviderMessages(await ConversationService.listMessages(options.conv.id));
  const userBlocks: ContentBlock[] = [textBlock(userText)];
  await ConversationService.appendMessage(options.conv, {
    role: 'user',
    blocks: toJsonBlocks(userBlocks),
  });
  history.push({ role: 'user', content: userBlocks });

  const plan = await buildRun(options, options.conv);
  const start = history.length;

  try {
    yield* runTurn({
      provider: plan.provider,
      system: SYSTEM_PROMPT,
      history,
      toolNames: plan.toolNames,
      redactor: plan.redactor,
      model: options.conv.model,
      maxTokens: config.copilotMaxTokens,
      budget: plan.budget,
      tools: copilotToolRegistry,
      toolContext: plan.context,
    });
  } finally {
    await persistRedactionAliases(options.conv, plan.redactor);
  }

  await persistTail(options.conv, history, start);
}

/** Exécute (ou ignore) l'outil en attente puis reprend le tour. */
export async function* resumeTurn(
  options: TurnOptions,
  callId: string,
  approve: boolean,
): AsyncGenerator<TurnEvent> {
  const history = toProviderMessages(await ConversationService.listMessages(options.conv.id));
  const pending = findPending(history, callId);
  if (!pending) return;
  const already = findResult(history, callId);

  const plan = await buildRun(options, options.conv);
  // Python capture `start = len(history)` APRÈS avoir ajouté le résultat de
  // l'outil (persisté séparément) : `_persist_tail` n'ajoute que les messages
  // du tour repris.
  let start = history.length;

  if (approve) {
    if (already) {
      // Re-confirmation idempotente (#532) : on rejoue le résultat déjà
      // stocké sans ré-exécuter l'écriture ni rien ajouter à l'historique.
      yield {
        kind: 'tool_call_finished',
        call_id: callId,
        name: pending.name,
        ok: !already.is_error,
        result: already.content,
      };
    } else {
      const outcome = await copilotToolRegistry.call(plan.context, pending.name, pending.input);
      const payload = outcome.ok ? outcome.data : { error: outcome.error };
      yield {
        kind: 'tool_call_finished',
        call_id: callId,
        name: pending.name,
        ok: outcome.ok,
        result: payload,
      };
      const toolBlocks: ContentBlock[] = [toolResultBlock(callId, payload, !outcome.ok)];
      history.push({ role: 'tool', content: toolBlocks });
      await ConversationService.appendMessage(options.conv, {
        role: 'tool',
        blocks: toJsonBlocks(toolBlocks),
      });
      start = history.length;
    }
  } else {
    const toolBlocks: ContentBlock[] = [
      toolResultBlock(callId, { status: 'cancelled_by_user' }, false),
    ];
    history.push({ role: 'tool', content: toolBlocks });
    await ConversationService.appendMessage(options.conv, {
      role: 'tool',
      blocks: toJsonBlocks(toolBlocks),
    });
    start = history.length;
  }

  try {
    yield* runTurn({
      provider: plan.provider,
      system: SYSTEM_PROMPT,
      history,
      toolNames: plan.toolNames,
      redactor: plan.redactor,
      model: options.conv.model,
      maxTokens: config.copilotMaxTokens,
      budget: plan.budget,
      tools: copilotToolRegistry,
      toolContext: plan.context,
    });
  } finally {
    await persistRedactionAliases(options.conv, plan.redactor);
  }

  await persistTail(options.conv, history, start);
}
