/**
 * Noyau agentique côté Express — port de `app/core/llm/{spec,factory}.py` et
 * de `app/core/agents/orchestrator.py` (`run_turn`), limité à ce dont le
 * copilot a besoin pour rester fidèle au contrat HTTP.
 *
 * Ce fichier ne contient **aucune** logique de base : il décrit les
 * fournisseurs LLM (spécifications, résolution des clés depuis l'env), les
 * blocs de message neutres, et la boucle `run_turn` provider-agnostique.
 * Les adaptateurs HTTP (appel + analyse SSE) vivent dans `providers.ts`.
 * L'exécution des outils passe par `tools.ts` (registre des outils).
 *
 * Les clés sont lues via `config.ts` (mêmes noms de variables d'env que
 * FastAPI) et ne sont jamais journalisées ni renvoyées au client.
 */

import crypto from 'node:crypto';

import { config } from '../../config';

import { createAdapterFor } from './providers';

// ---------------------------------------------------------------------------
// Erreur de configuration (miroir de `LLMConfigError`)
// ---------------------------------------------------------------------------

export class LLMConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMConfigError';
  }
}

// ---------------------------------------------------------------------------
// Spécifications des fournisseurs (`app/core/llm/spec.py`)
// ---------------------------------------------------------------------------

export type ToolDialect = 'openai' | 'anthropic';

export interface ProviderSpec {
  name: string;
  label: string;
  defaultModel: string;
  toolDialect: ToolDialect;
  needsApiKey: boolean;
  /** Nom de la variable d'env portant la clé (`OPENAI_API_KEY`, …). */
  apiKeySetting: string | null;
  /** Variable d'env de l'endpoint auto-hébergé (Ollama) ; `null` sinon. */
  baseUrlSetting: string | null;
}

export function buildProviderSpecs(overrides: {
  openai: string;
  anthropic: string;
  gemini: string;
  openrouter: string;
  groq: string;
  ollama: string;
}): ProviderSpec[] {
  return [
    {
      name: 'openai',
      label: 'OpenAI',
      defaultModel: overrides.openai,
      toolDialect: 'openai',
      needsApiKey: true,
      apiKeySetting: 'OPENAI_API_KEY',
      baseUrlSetting: null,
    },
    {
      name: 'anthropic',
      label: 'Anthropic',
      defaultModel: overrides.anthropic,
      toolDialect: 'anthropic',
      needsApiKey: true,
      apiKeySetting: 'ANTHROPIC_API_KEY',
      baseUrlSetting: null,
    },
    {
      name: 'gemini',
      label: 'Gemini',
      defaultModel: overrides.gemini,
      toolDialect: 'openai',
      needsApiKey: true,
      apiKeySetting: 'GEMINI_API_KEY',
      baseUrlSetting: null,
    },
    {
      name: 'openrouter',
      label: 'OpenRouter',
      defaultModel: overrides.openrouter,
      toolDialect: 'openai',
      needsApiKey: true,
      apiKeySetting: 'OPENROUTER_API_KEY',
      baseUrlSetting: null,
    },
    {
      name: 'groq',
      label: 'Groq',
      defaultModel: overrides.groq,
      toolDialect: 'openai',
      needsApiKey: true,
      apiKeySetting: 'GROQ_API_KEY',
      baseUrlSetting: null,
    },
    {
      name: 'ollama',
      label: 'Ollama',
      defaultModel: overrides.ollama,
      toolDialect: 'openai',
      needsApiKey: false,
      apiKeySetting: null,
      baseUrlSetting: 'OLLAMA_BASE_URL',
    },
  ];
}

/**
 * Ordre d'enregistrement de `CopilotModule.on_activate` (Python). Cet ordre
 * apparaît dans le message d'erreur `Unsupported LLM provider` et dans les
 * défauts des nouveaux `copilot_settings`.
 */
export function providerSpecs(): ProviderSpec[] {
  return buildProviderSpecs({
    openai: config.copilotModelChatOpenai,
    anthropic: config.copilotModelChatAnthropic,
    gemini: config.copilotModelChatGemini,
    openrouter: config.copilotModelChatOpenrouter,
    groq: config.copilotModelChatGroq,
    ollama: config.copilotModelChatOllama,
  });
}

/** Miroir de `get_provider_spec` (lève `LLMConfigError` si inconnu). */
export function getProviderSpec(name: string): ProviderSpec {
  const specs = providerSpecs();
  const spec = specs.find((item) => item.name === name);
  if (!spec) {
    const supported = specs.map((item) => item.name).join(', ') || 'none';
    throw new LLMConfigError(`Unsupported LLM provider: '${name}' (supported: ${supported})`);
  }
  return spec;
}

/** Miroir de `get_configured_api_key` (jamais loggé, jamais renvoyé). */
export function getConfiguredApiKey(spec: ProviderSpec): string | null {
  if (spec.apiKeySetting === null) return null;
  const value = process.env[spec.apiKeySetting];
  return value === undefined || value === '' ? '' : value;
}

/** Miroir de `get_configured_base_url` (vide/absent → `null`). */
export function getConfiguredBaseUrl(spec: ProviderSpec): string | null {
  if (spec.baseUrlSetting === null) return null;
  const value = (process.env[spec.baseUrlSetting] ?? '').trim();
  return value === '' ? null : value;
}

/**
 * `ProviderSpec` enregistrées, dans l'ordre du manifeste — utilisé par le
 * message d'erreur de `PATCH /settings` quand le provider est inconnu.
 */
export function providerNamesCsv(): string {
  return providerSpecs()
    .map((spec) => spec.name)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Blocs de message neutres (`app/core/llm/base.py`)
// ---------------------------------------------------------------------------

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Données opaques propres au fournisseur (ex. `thoughtSignature` Gemini). */
  provider_meta?: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_call_id: string;
  content: unknown;
  is_error: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ProviderMessage {
  role: Role;
  content: ContentBlock[];
}

export function textBlock(text: string): TextBlock {
  return { type: 'text', text };
}

export function toolUseBlock(
  id: string,
  name: string,
  input: Record<string, unknown>,
  providerMeta?: Record<string, unknown>,
): ToolUseBlock {
  const block: ToolUseBlock = { type: 'tool_use', id, name, input };
  if (providerMeta && Object.keys(providerMeta).length > 0) block.provider_meta = providerMeta;
  return block;
}

export function toolResultBlock(
  toolCallId: string,
  content: unknown,
  isError = false,
): ToolResultBlock {
  return { type: 'tool_result', tool_call_id: toolCallId, content, is_error: isError };
}

// ---------------------------------------------------------------------------
// Événements d'un tour (`orchestrator.py` — TurnEvent)
// ---------------------------------------------------------------------------

export type TurnEvent =
  | { kind: 'token'; text: string }
  | { kind: 'tool_call_started'; call_id: string; name: string; arguments: unknown }
  | { kind: 'tool_call_finished'; call_id: string; name: string; ok: boolean; result: unknown }
  | { kind: 'confirmation_required'; call_id: string; name: string; arguments: unknown }
  | { kind: 'usage'; input_tokens: number; output_tokens: number }
  | { kind: 'final'; stop_reason: string }
  | { kind: 'budget_exceeded' };

/** Plafond dur de tours fournisseur par message (#536). */
export const MAX_TURN_ITERATIONS = 25;

// ---------------------------------------------------------------------------
// Garde de budget (`service.ClinicBudgetGuard`)
// ---------------------------------------------------------------------------

export interface BudgetGuard {
  check(): boolean;
  record(inputTokens: number, outputTokens: number): void;
}

// ---------------------------------------------------------------------------
// Redactor — tokenisation réversible des données identifiantes (PHI)
// ---------------------------------------------------------------------------

/**
 * Quand `redaction_enabled` est actif, tout ce qui part vers le fournisseur
 * LLM passe par une table de symboles : e-mails, IBAN, DNI/NIE, cartes,
 * téléphones et noms de patients connus de la clinique sont remplacés par
 * un jeton opaque, et les jetons présents dans la réponse modèle sont
 * réhydratés avant d'être montrés ou persistés.
 *
 * Les jetons sont dérivés d'un HMAC salé par conversation
 * (`copilot_conversations.redaction_salt`) : le même patient garde le même
 * jeton d'un tour à l'autre, mais deux conversations ne partagent pas leur
 * table. La table (jeton → valeur) est persistée dans `conversation.context`
 * par `bridge.ts` ; sans elle, la réhydratation ne peut pas fonctionner.
 */
export interface Redactor {
  enabled: boolean;
  redactOutgoing(messages: ProviderMessage[]): ProviderMessage[];
  rehydrate(text: string): string;
  /** Table jeton → valeur d'origine, à persister par l'appelant. */
  exportAliases?(): Record<string, string>;
}

export interface RedactorOptions {
  /** Sel de conversation (`redaction_salt`). */
  salt?: string;
  /** Table déjà persistée (jeton → valeur). */
  aliases?: Record<string, string>;
  /** Valeurs connues à masquer même hors motif (noms de patients…). */
  directory?: readonly string[];
}

const PHI_PATTERNS: { category: string; pattern: RegExp }[] = [
  { category: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu },
  { category: 'iban', pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g },
  { category: 'id', pattern: /\b(?:\d{8}[A-Za-z]|[XYZ]\d{7}[A-Za-z])\b/gu },
];

/** Suites de chiffres avec séparateurs : téléphone (9-15) ou carte (13-19). */
const DIGIT_RUN = /(?<![\p{L}\p{N}])\+?\d[\d ().-]{6,}\d(?![\p{L}\p{N}])/gu;

function digitsOf(value: string): number {
  return value.replace(/\D/g, '').length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createRedactor(enabled: boolean, options: RedactorOptions = {}): Redactor {
  if (!enabled) {
    return {
      enabled: false,
      redactOutgoing: (messages) => messages,
      rehydrate: (text) => text,
      exportAliases: () => ({}),
    };
  }

  const salt = options.salt ?? '';
  const aliases: Record<string, string> = { ...(options.aliases ?? {}) };
  const byValue = new Map<string, string>();
  for (const [token, value] of Object.entries(aliases)) {
    byValue.set(`${value.toLowerCase()}`, token);
  }

  const directory = [...new Set((options.directory ?? []).filter((value) => value.trim().length >= 3))]
    .sort((a, b) => b.length - a.length)
    .map((value) => ({
      value,
      pattern: new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRegExp(value)}(?![\\p{L}\\p{N}])`,
        'giu',
      ),
    }));

  function tokenFor(category: string, value: string): string {
    const key = value.toLowerCase();
    const existing = byValue.get(key);
    if (existing) return existing;
    const digest = crypto
      .createHmac('sha256', salt)
      .update(`${category}\u0000${key}`)
      .digest('hex')
      .slice(0, 12);
    const token = `[PHI_${category.toUpperCase()}_${digest}]`;
    byValue.set(key, token);
    aliases[token] = value;
    return token;
  }

  function redactText(text: string): string {
    let out = text;
    for (const { category, pattern } of PHI_PATTERNS) {
      out = out.replace(pattern, (match) => tokenFor(category, match));
    }
    // Les jetons sont opaques et ne contiennent que de l'ASCII : aucune
    // collision possible avec les motifs suivants.
    out = out.replace(DIGIT_RUN, (match) => {
      const digits = digitsOf(match);
      if (digits >= 13 && digits <= 19) return tokenFor('card', match);
      if (digits >= 9 && digits <= 15) return tokenFor('phone', match);
      return match;
    });
    for (const entry of directory) {
      out = out.replace(entry.pattern, () => tokenFor('name', entry.value));
    }
    return out;
  }

  function redactValue(value: unknown): unknown {
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (isRecord(value)) {
      const copy: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) copy[key] = redactValue(item);
      return copy;
    }
    return value;
  }

  return {
    enabled: true,
    redactOutgoing(messages) {
      return messages.map((message) => ({
        role: message.role,
        content: message.content.map((block) => {
          if (block.type === 'text') return { ...block, text: redactText(block.text) };
          if (block.type === 'tool_use') {
            return { ...block, input: redactValue(block.input) as Record<string, unknown> };
          }
          return { ...block, content: redactValue(block.content) };
        }),
      }));
    },
    rehydrate(text) {
      let out = text;
      for (const [token, value] of Object.entries(aliases)) {
        if (out.includes(token)) out = out.split(token).join(value);
      }
      return out;
    },
    exportAliases: () => ({ ...aliases }),
  };
}

// ---------------------------------------------------------------------------
// Fournisseur (contrat structurel de `app/core/llm/base.py::Provider`)
// ---------------------------------------------------------------------------

export type ProviderEvent =
  | { kind: 'text_delta'; text: string }
  | {
      kind: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      provider_meta?: Record<string, unknown>;
    }
  | { kind: 'usage'; input_tokens: number; output_tokens: number }
  | { kind: 'done'; stop_reason: string };

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface Provider {
  complete(options: {
    system: string;
    messages: ProviderMessage[];
    tools: ToolSchema[];
    model: string;
    maxTokens: number;
  }): AsyncIterable<ProviderEvent>;
}

/**
 * Résout le fournisseur d'une conversation et renvoie son adaptateur HTTP
 * (`providers.ts`). La clé manquante conserve le message d'erreur Python ;
 * le nom inconnu lève depuis `getProviderSpec`. Le nom est comparé
 * littéralement (comme `factory.get_provider` côté FastAPI).
 */
export function getProvider(name: string, apiKey?: string | null): Provider {
  const spec = getProviderSpec(name);
  const resolved = apiKey || getConfiguredApiKey(spec);
  if (spec.needsApiKey && !resolved) {
    throw new LLMConfigError(
      `${spec.label} provider selected but ${spec.apiKeySetting} is not configured`,
    );
  }
  if (spec.name !== name) {
    const supported = providerSpecs()
      .map((item) => item.name)
      .join(', ');
    throw new LLMConfigError(`Unsupported LLM provider: '${name}' (supported: ${supported})`);
  }
  return createAdapterFor(spec.name, resolved ?? null, getConfiguredBaseUrl(spec));
}

// ---------------------------------------------------------------------------
// run_turn (`orchestrator.py::run_turn`)
// ---------------------------------------------------------------------------

/**
 * Exécution d'un outil par le registre. `ok=false` ⇒ `error` renseigné ;
 * l'orchestrateur empaquette alors `{"error": error}` comme résultat.
 */
export interface ToolCallOutcome {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolRegistryLike {
  /** Noms des outils enregistrés, dans l'ordre d'enregistrement. */
  list(): string[];
  /** Catégorie d'un outil (`read` = exécuté, `write`/`destructive` = confirmé). */
  category(name: string): 'read' | 'write' | 'destructive' | null;
  /** Schéma JSON exposé au modèle ; `null` si l'outil n'est pas décrit. */
  schemaFor(name: string): ToolSchema | null;
  /** Outil dont la prose ne peut pas être tokenisée (`exposes_free_text`). */
  exposesFreeText?(name: string): boolean;
  call(ctx: unknown, name: string, args: Record<string, unknown>): Promise<ToolCallOutcome>;
}

export interface RunTurnOptions {
  provider: Provider;
  system: string;
  history: ProviderMessage[];
  toolNames: string[];
  redactor: Redactor;
  model: string;
  maxTokens: number;
  budget?: BudgetGuard | null;
  dialect?: ToolDialect;
  /** Schémas d'outils par nom (l'assemblage RBAC est fait en amont). */
  tools: ToolRegistryLike;
  /** Contexte passé au registre (session, clinique, permissions…). */
  toolContext: unknown;
  maxIterations?: number;
}

/**
 * Boucle générique : diffuse le modèle, exécute les outils READ, suspend le
 * tour (`confirmation_required`) sur un outil WRITE/DESTRUCTIVE. L'historique
 * est muté sur place, comme en Python.
 */
export async function* runTurn(options: RunTurnOptions): AsyncGenerator<TurnEvent> {
  const iterations = options.maxIterations ?? MAX_TURN_ITERATIONS;

  for (let step = 0; step < iterations; step += 1) {
    if (options.budget && !options.budget.check()) {
      yield { kind: 'budget_exceeded' };
      return;
    }

    const effective = options.toolNames.filter((name) => {
      if (!options.redactor.enabled) return true;
      // Rédaction active : sans table de symboles portée, seuls les outils
      // sans texte libre sont offerts (`include_free_text=False`).
      return options.tools.exposesFreeText?.(name) !== true;
    });
    const schemas: ToolSchema[] = effective
      .map((name) => options.tools.schemaFor(name))
      .filter((schema): schema is ToolSchema => schema !== null);
    const outgoing = options.redactor.redactOutgoing(options.history);

    const acc = {
      textParts: [] as string[],
      toolUses: [] as {
        id: string;
        name: string;
        input: Record<string, unknown>;
        provider_meta?: Record<string, unknown>;
      }[],
      usage: null as { input_tokens: number; output_tokens: number } | null,
      stopReason: 'stop',
    };
    let buffer = '';

    for await (const event of options.provider.complete({
      system: options.system,
      messages: outgoing,
      tools: schemas,
      model: options.model,
      maxTokens: options.maxTokens,
    })) {
      if (event.kind === 'text_delta') {
        acc.textParts.push(event.text);
        buffer += event.text;
        const cut = Math.max(buffer.lastIndexOf(' '), buffer.lastIndexOf('\n'));
        if (cut >= 0) {
          const segment = buffer.slice(0, cut + 1);
          buffer = buffer.slice(cut + 1);
          yield { kind: 'token', text: options.redactor.rehydrate(segment) };
        }
      } else if (event.kind === 'tool_use') {
        acc.toolUses.push({
          id: event.id,
          name: event.name,
          input: event.input,
          provider_meta: event.provider_meta,
        });
      } else if (event.kind === 'usage') {
        acc.usage = { input_tokens: event.input_tokens, output_tokens: event.output_tokens };
      } else if (event.kind === 'done') {
        acc.stopReason = event.stop_reason;
      }
    }
    if (buffer) {
      yield { kind: 'token', text: options.redactor.rehydrate(buffer) };
    }

    if (acc.usage) {
      options.budget?.record(acc.usage.input_tokens, acc.usage.output_tokens);
      yield { kind: 'usage', ...acc.usage };
    }

    const assistantBlocks: ContentBlock[] = [];
    if (acc.textParts.length > 0) {
      assistantBlocks.push(textBlock(options.redactor.rehydrate(acc.textParts.join(''))));
    }
    for (const use of acc.toolUses) {
      assistantBlocks.push(toolUseBlock(use.id, use.name, use.input, use.provider_meta));
    }
    options.history.push({ role: 'assistant', content: assistantBlocks });

    if (acc.toolUses.length === 0) {
      yield { kind: 'final', stop_reason: acc.stopReason };
      return;
    }

    // Gemini 3 peut renvoyer plusieurs appels d'outils dans une même
    // réponse. On exécute toutes les lectures, puis on suspend sur la
    // première écriture ; chaque appel non exécuté reçoit un résultat
    // explicite pour garder l'équilibre functionCall/functionResponse.
    const toolResults: ContentBlock[] = [];
    let paused = false;

    for (const use of acc.toolUses) {
      if (paused) {
        toolResults.push(
          toolResultBlock(use.id, { status: 'not_executed', reason: 'parallel_call' }, false),
        );
        continue;
      }

      const category = options.tools.category(use.name);
      if (category === null) {
        toolResults.push(toolResultBlock(use.id, { error: `unknown tool: ${use.name}` }, true));
        continue;
      }

      if (category === 'read') {
        yield {
          kind: 'tool_call_started',
          call_id: use.id,
          name: use.name,
          arguments: use.input,
        };
        const outcome = await options.tools.call(options.toolContext, use.name, use.input);
        const payload = outcome.ok ? outcome.data : { error: outcome.error };
        toolResults.push(toolResultBlock(use.id, payload, !outcome.ok));
        yield {
          kind: 'tool_call_finished',
          call_id: use.id,
          name: use.name,
          ok: outcome.ok,
          result: payload,
        };
        continue;
      }

      // WRITE / DESTRUCTIVE : jamais exécuté ici, pause pour confirmation.
      paused = true;
      yield {
        kind: 'confirmation_required',
        call_id: use.id,
        name: use.name,
        arguments: use.input,
      };
    }

    if (toolResults.length > 0) {
      options.history.push({ role: 'tool', content: toolResults });
    }
    if (paused) return;
  }

  yield { kind: 'budget_exceeded' };
}
