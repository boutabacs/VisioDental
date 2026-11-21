/**
 * Adaptateurs HTTP des fournisseurs LLM — port de `app/core/llm/*_provider.py`.
 *
 * Chaque adaptateur convertit les messages neutres de `provider.ts` vers le
 * format filaire du vendeur, appelle l'API en *streaming* avec le `fetch`
 * global (Node ≥ 18), analyse le flux SSE et émet les événements neutres
 * (`text_delta`, `tool_use`, `usage`, `done`) dans le même ordre que les
 * générateurs Python.
 *
 * Familles :
 * - **OpenAI-compatible** (`POST {base}/chat/completions`) : `openai`,
 *   `openrouter`, `groq`, `ollama` et `gemini` (endpoint OpenAI de Google),
 *   comme `OpenAIProvider` et ses sous-classes Python.
 * - **Anthropic Messages** (`POST /v1/messages`) : blocs `tool_use` /
 *   `tool_result`, flux `content_block_delta`.
 * - **Gemini natif** (`POST /v1beta/models/{model}:streamGenerateContent`) :
 *   `contents` / `parts`, `functionDeclarations`, `functionResponse`.
 *
 * Les noms d'outils sont qualifiés (`patients.search_patients`) alors
 * qu'OpenAI et Anthropic n'acceptent que `^[a-zA-Z0-9_-]+$` : le `.`
 * devient `-` sur le fil et l'inverse à la réception, bijection sans perte
 * (même astuce que Python). Gemini utiliserait aussi `-`, mais la
 * description de chaque outil rappelle le nom réel.
 *
 * Aucune clé n'est jamais journalisée ni renvoyée : les erreurs HTTP ne
 * citent que le statut et le message renvoyé par le vendeur.
 */

import { config } from '../../config';
import {
  LLMConfigError,
  getConfiguredApiKey,
  getConfiguredBaseUrl,
  getProviderSpec,
  providerSpecs,
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type ToolSchema,
} from './provider';

// ---------------------------------------------------------------------------
// Constantes et erreurs
// ---------------------------------------------------------------------------

/** Base URL de l'API Chat Completions d'OpenAI. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
/** Endpoint OpenAI-compatible d'OpenRouter. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** Endpoint OpenAI-compatible de Groq. */
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
/** Endpoint OpenAI-compatible de Gemini (Google AI Studio). */
export const GEMINI_OPENAI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai';
/** API Messages d'Anthropic. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
/** API Gemini native (SSE). */
export const GEMINI_NATIVE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** Racine par défaut d'un serveur Ollama (l'API compatible vit sous `/v1`). */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';
/** Ollama ignore la valeur, mais `Authorization` doit rester non vide. */
export const OLLAMA_PLACEHOLDER_API_KEY = 'ollama';
/** Version d'API Anthropic exigée par `x-api-version`. */
export const ANTHROPIC_VERSION = '2023-06-01';
/** Timeout d'une requête fournisseur (ms). */
export const PROVIDER_TIMEOUT_MS = 120_000;

/** Erreur d'un appel fournisseur (réponse non-2xx, flux interrompu…). */
export class LLMProviderError extends Error {
  public readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'LLMProviderError';
    this.status = status;
  }
}

export interface CompletionOptions {
  system: string;
  messages: ProviderMessage[];
  tools: ToolSchema[];
  model: string;
  maxTokens: number;
}

export type AdapterKind = 'openai' | 'anthropic' | 'gemini';

// ---------------------------------------------------------------------------
// Helpers neutres (miroir des helpers de `openai_provider.py`)
// ---------------------------------------------------------------------------

/** `joined = "".join(b.text for b in msg.content if isinstance(b, TextBlock))`. */
function joinText(message: ProviderMessage): string {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/** `json.dumps(content, ensure_ascii=False, default=str)` réduit à l'essentiel. */
function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content ?? null);
}

/** Outil qualifié → nom acceptable par le vendeur (`patients.search_patients`). */
export function wireToolName(qualified: string): string {
  return qualified.replace(/\./g, '-');
}

/** Inverse de `wireToolName` à la réception d'un appel d'outil. */
export function toolNameFromWire(name: string): string {
  return name.replace(/-/g, '.');
}

/** Arguments JSON d'un appel d'outil ; `{}` si vides ou invalides (comme Python). */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Extrait les lignes `data:` d'un bloc SSE (les autres champs sont ignorés). */
function* dataLines(block: string): Generator<string> {
  for (const line of block.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim();
  }
}

/**
 * Découpe un flux SSE en valeurs `data:` (lignes `event:`/`id:` ignorées).
 * Les blocs sont séparés par une ligne vide (`\n\n` ou `\r\n\r\n`) ;
 * `[DONE]` est émis tel quel pour que l'appelant le reconnaisse.
 */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  /** Découpe `buffer` sur le prochain séparateur, s'il est complet. */
  const takeBlock = (): string | null => {
    for (;;) {
      const lf = buffer.indexOf('\n\n');
      const crlf = buffer.indexOf('\r\n\r\n');
      if (lf < 0 && crlf < 0) return null;
      if (crlf >= 0 && (lf < 0 || crlf < lf)) {
        const block = buffer.slice(0, crlf);
        buffer = buffer.slice(crlf + 4);
        return block;
      }
      const block = buffer.slice(0, lf);
      buffer = buffer.slice(lf + 2);
      return block;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let block = takeBlock(); block !== null; block = takeBlock()) {
        yield* dataLines(block);
      }
    }
    buffer += decoder.decode();
    // Dernier bloc sans ligne vide finale.
    if (buffer.trim() !== '') yield* dataLines(buffer);
  } finally {
    reader.releaseLock();
  }
}

/** Message d'erreur lisible d'une réponse non-2xx (sans jamais citer la clé). */
async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return response.statusText || 'no response body';
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === 'string') return error;
      if (error !== null && typeof error === 'object') {
        const nested = error as Record<string, unknown>;
        if (typeof nested.message === 'string') return nested.message;
        return JSON.stringify(nested);
      }
      if (typeof record.message === 'string') return record.message;
      if (typeof record.detail === 'string') return record.detail;
    }
  } catch {
    // Corps non JSON : le texte brut suffit.
  }
  return text.slice(0, 500);
}

/** Erreur `${label} API error <status>: <message>` (miroir de l'attendu). */
async function providerHttpError(label: string, response: Response): Promise<LLMProviderError> {
  const message = await readErrorMessage(response);
  return new LLMProviderError(`${label} API error ${response.status}: ${message}`, response.status);
}

/** `fetch` POST + timeout fournisseur ; erreurs réseau nommées. */
async function postJson(label: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new LLMConfigError(`${label} provider timed out after ${PROVIDER_TIMEOUT_MS / 1000}s`);
    }
    throw new LLMProviderError(`${label} provider cannot reach ${new URL(url).origin}`);
  }
}

/** `{...tool, function: {...fn, name: safe}}` (schéma OpenAI). */
function openAiToolSchema(tool: ToolSchema): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: wireToolName(tool.name),
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (openai, openrouter, groq, ollama)
// ---------------------------------------------------------------------------

export interface OpenAiAdapterOptions {
  /** Nom du vendeur (`OpenAI`, `Groq`, `Ollama`…) pour les erreurs. */
  label: string;
  apiKey: string;
  /** Base incluant `/v1` (ex. `https://api.groq.com/openai/v1`). */
  baseUrl: string;
  /** En-têtes additionnels (OpenRouter : `HTTP-Referer`/`X-Title`). */
  extraHeaders?: Record<string, string>;
}

/** Normalise une racine de serveur (avec ou sans `/v1` final), comme Python. */
export function openAiCompatibleBaseUrl(baseUrl: string | null | undefined): string {
  const root = (baseUrl ?? '').trim().replace(/\/+$/, '') || OLLAMA_DEFAULT_BASE_URL;
  return root.endsWith('/v1') ? root : `${root}/v1`;
}

/** `gpt-5` et la série `o` exigent `max_completion_tokens`. */
export function usesCompletionTokens(model: string): boolean {
  const lower = model.toLowerCase();
  return ['gpt-5', 'o1', 'o3', 'o4'].some((prefix) => lower.startsWith(prefix));
}

type OpenAiWireMessage = Record<string, unknown>;

/** Conversion neutre → messages Chat Completions (voir `_to_openai_messages`). */
export function toOpenAiMessages(system: string, messages: ProviderMessage[]): OpenAiWireMessage[] {
  const out: OpenAiWireMessage[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const message of messages) {
    if (message.role === 'system') {
      const text = joinText(message);
      if (text) out.push({ role: 'system', content: text });
      continue;
    }
    if (message.role === 'user') {
      out.push({ role: 'user', content: joinText(message) });
      continue;
    }
    if (message.role === 'assistant') {
      const text = joinText(message);
      const toolCalls = message.content
        .filter((block): block is Extract<typeof block, { type: 'tool_use' }> => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          type: 'function',
          function: { name: wireToolName(block.name), arguments: JSON.stringify(block.input) },
        }));
      const wire: OpenAiWireMessage = { role: 'assistant', content: text || null };
      if (toolCalls.length > 0) wire.tool_calls = toolCalls;
      out.push(wire);
      continue;
    }
    // Un message neutre `tool` à N résultats devient N messages `role:"tool"`.
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      out.push({
        role: 'tool',
        tool_call_id: block.tool_call_id,
        content: stringifyContent(block.content),
      });
    }
  }
  return out;
}

interface OpenAiPendingCall {
  id: string;
  name: string;
  args: string;
}

/** Adaptateur générique OpenAI-compatible (streaming Chat Completions). */
export function createOpenAiCompatibleProvider(options: OpenAiAdapterOptions): Provider {
  const base = options.baseUrl.replace(/\/+$/, '');
  return {
    async *complete(completion: CompletionOptions): AsyncGenerator<ProviderEvent> {
      const body: Record<string, unknown> = {
        model: completion.model,
        messages: toOpenAiMessages(completion.system, completion.messages),
        stream: true,
        stream_options: { include_usage: true },
      };
      const tokenParam = usesCompletionTokens(completion.model)
        ? 'max_completion_tokens'
        : 'max_tokens';
      body[tokenParam] = completion.maxTokens;
      if (completion.tools.length > 0) {
        body.tools = completion.tools.map(openAiToolSchema);
        body.parallel_tool_calls = false;
      }

      const response = await postJson(options.label, `${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${options.apiKey}`,
          ...(options.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await providerHttpError(options.label, response);
      if (!response.body) {
        throw new LLMProviderError(`${options.label} API error ${response.status}: empty body`, response.status);
      }

      /** index -> fragments d'appel en cours. */
      const pending = new Map<number, OpenAiPendingCall>();
      let stopReason = 'stop';

      for await (const data of readSseData(response.body)) {
        if (!data || data === '[DONE]') continue;
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        const usage = chunk.usage as
          | { prompt_tokens?: number; completion_tokens?: number }
          | null
          | undefined;
        if (usage) {
          yield {
            kind: 'usage',
            input_tokens: Number(usage.prompt_tokens ?? 0),
            output_tokens: Number(usage.completion_tokens ?? 0),
          };
        }

        const choices = Array.isArray(chunk.choices) ? (chunk.choices as Record<string, unknown>[]) : [];
        const choice = choices[0];
        if (!choice) continue;
        const delta = (choice.delta ?? {}) as Record<string, unknown>;

        if (typeof delta.content === 'string' && delta.content !== '') {
          yield { kind: 'text_delta', text: delta.content };
        }

        const toolCalls = Array.isArray(delta.tool_calls)
          ? (delta.tool_calls as Record<string, unknown>[])
          : [];
        for (const call of toolCalls) {
          const index = typeof call.index === 'number' ? call.index : 0;
          const slot = pending.get(index) ?? { id: '', name: '', args: '' };
          if (typeof call.id === 'string' && call.id) slot.id = call.id;
          const fn = (call.function ?? {}) as Record<string, unknown>;
          if (typeof fn.name === 'string' && fn.name) slot.name = fn.name;
          if (typeof fn.arguments === 'string' && fn.arguments) slot.args += fn.arguments;
          pending.set(index, slot);
        }

        if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
          stopReason = choice.finish_reason;
        }
      }

      const ordered = [...pending.entries()].sort((a, b) => a[0] - b[0]);
      for (const [index, slot] of ordered) {
        yield {
          kind: 'tool_use',
          id: slot.id || `call_${index}`,
          name: toolNameFromWire(slot.name),
          input: parseToolArguments(slot.args),
        };
      }

      yield { kind: 'done', stop_reason: stopReason };
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

export interface AnthropicAdapterOptions {
  label: string;
  apiKey: string;
  baseUrl?: string;
}

/** Bloc de contenu Anthropic (fil). */
type AnthropicBlock = Record<string, unknown>;

/** Conversion neutre → messages Anthropic (fusion des tours de même rôle). */
export function toAnthropicMessages(messages: ProviderMessage[]): AnthropicBlock[] {
  const out: { role: string; content: AnthropicBlock[] }[] = [];
  const push = (role: string, blocks: AnthropicBlock[]): void => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const message of messages) {
    if (message.role === 'system') {
      const text = joinText(message);
      if (text) push('user', [{ type: 'text', text }]);
      continue;
    }
    if (message.role === 'user') {
      const text = joinText(message);
      if (text) push('user', [{ type: 'text', text }]);
      continue;
    }
    if (message.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      const text = joinText(message);
      if (text) blocks.push({ type: 'text', text });
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue;
        blocks.push({
          type: 'tool_use',
          id: block.id,
          name: wireToolName(block.name),
          input: block.input,
        });
      }
      push('assistant', blocks);
      continue;
    }
    const results: AnthropicBlock[] = [];
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      const wire: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: block.tool_call_id,
        content: stringifyContent(block.content),
      };
      if (block.is_error) wire.is_error = true;
      results.push(wire);
    }
    push('user', results);
  }
  return out;
}

/** Adaptateur Anthropic (Messages API, streaming SSE). */
export function createAnthropicProvider(options: AnthropicAdapterOptions): Provider {
  const base = (options.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  return {
    async *complete(completion: CompletionOptions): AsyncGenerator<ProviderEvent> {
      const body: Record<string, unknown> = {
        model: completion.model,
        messages: toAnthropicMessages(completion.messages),
        max_tokens: completion.maxTokens,
        stream: true,
      };
      if (completion.system) body.system = completion.system;
      if (completion.tools.length > 0) {
        body.tools = completion.tools.map((tool) => ({
          name: wireToolName(tool.name),
          description: tool.description,
          input_schema: tool.input_schema,
        }));
        body.tool_choice = { type: 'auto', disable_parallel_tool_use: true };
      }

      const response = await postJson(options.label, `${base}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'x-api-key': options.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await providerHttpError(options.label, response);
      if (!response.body) {
        throw new LLMProviderError(`${options.label} API error ${response.status}: empty body`, response.status);
      }

      const pending = new Map<number, OpenAiPendingCall>();
      let inputTokens = 0;
      let outputTokens = 0;
      let stopReason = 'end_turn';

      for await (const data of readSseData(response.body)) {
        if (!data || data === '[DONE]') continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const kind = typeof event.type === 'string' ? event.type : '';

        if (kind === 'message_start') {
          const message = (event.message ?? {}) as Record<string, unknown>;
          const usage = (message.usage ?? {}) as Record<string, unknown>;
          inputTokens = Number(usage.input_tokens ?? 0);
        } else if (kind === 'content_block_start') {
          const block = (event.content_block ?? {}) as Record<string, unknown>;
          if (block.type === 'tool_use') {
            const index = Number(event.index ?? 0);
            pending.set(index, {
              id: typeof block.id === 'string' ? block.id : '',
              name: typeof block.name === 'string' ? block.name : '',
              args: '',
            });
          }
        } else if (kind === 'content_block_delta') {
          const delta = (event.delta ?? {}) as Record<string, unknown>;
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            yield { kind: 'text_delta', text: delta.text };
          } else if (delta.type === 'input_json_delta') {
            const slot = pending.get(Number(event.index ?? 0));
            if (slot && typeof delta.partial_json === 'string') slot.args += delta.partial_json;
          }
        } else if (kind === 'message_delta') {
          const delta = (event.delta ?? {}) as Record<string, unknown>;
          if (typeof delta.stop_reason === 'string' && delta.stop_reason) {
            stopReason = delta.stop_reason;
          }
          const usage = event.usage as Record<string, unknown> | null | undefined;
          if (usage && usage.output_tokens !== undefined) {
            outputTokens = Number(usage.output_tokens);
          }
        } else if (kind === 'error') {
          const error = (event.error ?? {}) as Record<string, unknown>;
          throw new LLMProviderError(
            `${options.label} API error: ${String(error.message ?? 'stream error')}`,
          );
        }
      }

      yield { kind: 'usage', input_tokens: inputTokens, output_tokens: outputTokens };

      const ordered = [...pending.entries()].sort((a, b) => a[0] - b[0]);
      for (const [index, slot] of ordered) {
        yield {
          kind: 'tool_use',
          id: slot.id || `toolu_${index}`,
          name: toolNameFromWire(slot.name),
          input: parseToolArguments(slot.args),
        };
      }

      yield { kind: 'done', stop_reason: stopReason };
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini (API native streamGenerateContent)
// ---------------------------------------------------------------------------

export interface GeminiAdapterOptions {
  label: string;
  apiKey: string;
  baseUrl?: string;
}

type GeminiPart = Record<string, unknown>;

/**
 * L'API native n'accepte qu'un sous-ensemble de JSON Schema : tout nom
 * inconnu (`exclusiveMinimum`, `additionalProperties`, `pattern`…) fait
 * échouer la requête en 400. On ne conserve que les champs du proto
 * `Schema` et on projette les bornes exclusives sur `minimum`/`maximum`.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'properties',
  'required',
  'propertyOrdering',
  'items',
  'minimum',
  'maximum',
  'default',
  'anyOf',
]);

function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'exclusiveMinimum' || key === 'exclusiveMaximum') {
      const bound = key === 'exclusiveMinimum' ? 'minimum' : 'maximum';
      if (!(bound in source) && typeof value === 'number') out[bound] = value;
      continue;
    }
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const properties: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(value as Record<string, unknown>)) {
        properties[name] = sanitizeGeminiSchema(property);
      }
      out.properties = properties;
      continue;
    }
    out[key] = sanitizeGeminiSchema(value);
  }
  return out;
}

/** Id `tool_use` → nom d'outil (fil), pour nommer les `functionResponse`. */
function toolNamesById(messages: ProviderMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') names.set(block.id, block.name);
    }
  }
  return names;
}

/**
 * `contents` Gemini : un tour « user » peut porter le texte utilisateur ET
 * les `functionResponse` (un message `tool` neutre devient un tour user
 * avec les réponses), comme le recommande l'API `functionCall`.
 */
export function toGeminiContents(messages: ProviderMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const names = toolNamesById(messages);
  const push = (role: 'user' | 'model', parts: GeminiPart[]): void => {
    if (parts.length === 0) return;
    const last = out[out.length - 1] as { role: string; parts: GeminiPart[] } | undefined;
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };

  for (const message of messages) {
    if (message.role === 'system') {
      const text = joinText(message);
      if (text) push('user', [{ text }]);
      continue;
    }
    if (message.role === 'user') {
      const text = joinText(message);
      if (text) push('user', [{ text }]);
      continue;
    }
    if (message.role === 'assistant') {
      const parts: GeminiPart[] = [];
      const text = joinText(message);
      if (text) parts.push({ text });
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue;
        const part: GeminiPart = {
          functionCall: { name: wireToolName(block.name), args: block.input },
        };
        // Gemini 3 exige le renvoi du `thoughtSignature` du tour précédent.
        const signature = block.provider_meta?.thought_signature;
        if (typeof signature === 'string' && signature !== '') part.thoughtSignature = signature;
        parts.push(part);
      }
      push('model', parts);
      continue;
    }
    const parts: GeminiPart[] = [];
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      // `functionResponse.response` doit être un objet JSON.
      const payload =
        block.content !== null && typeof block.content === 'object' && !Array.isArray(block.content)
          ? (block.content as Record<string, unknown>)
          : { result: block.content ?? null };
      parts.push({
        functionResponse: {
          name: wireToolName(names.get(block.tool_call_id) ?? 'tool'),
          response: payload,
        },
      });
    }
    push('user', parts);
  }
  return out;
}

/**
 * Associe chaque `functionResponse` à l'id `tool_call_id` d'origine (Gemini
 * ne renvoie pas d'id : les parties d'une même réponse sont dans l'ordre
 * des `functionCall` du tour modèle précédent).
 */
function toolCallIdsFromHistory(messages: ProviderMessage[]): string[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'assistant') {
      return message.content
        .filter((block): block is Extract<typeof block, { type: 'tool_use' }> => block.type === 'tool_use')
        .map((block) => block.id);
    }
  }
  return [];
}

/** `finishReason` Gemini → vocabulaire des autres fournisseurs. */
export function geminiStopReason(reason: string | null): string {
  switch (reason) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case undefined:
    case null:
    case '':
      return 'end_turn';
    default:
      return reason.toLowerCase();
  }
}

/** Adaptateur Gemini natif (`streamGenerateContent?alt=sse`). */
export function createGeminiProvider(options: GeminiAdapterOptions): Provider {
  const base = (options.baseUrl ?? GEMINI_NATIVE_BASE_URL).replace(/\/+$/, '');
  return {
    async *complete(completion: CompletionOptions): AsyncGenerator<ProviderEvent> {
      const body: Record<string, unknown> = {
        contents: toGeminiContents(completion.messages),
        generationConfig: { maxOutputTokens: completion.maxTokens },
      };
      if (completion.system) body.systemInstruction = { parts: [{ text: completion.system }] };
      if (completion.tools.length > 0) {
        body.tools = [
          {
            functionDeclarations: completion.tools.map((tool) => ({
              name: wireToolName(tool.name),
              description: tool.description,
              parameters: sanitizeGeminiSchema(tool.input_schema),
            })),
          },
        ];
      }

      const model = encodeURIComponent(completion.model);
      const url = `${base}/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(options.apiKey)}`;
      const response = await postJson(options.label, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await providerHttpError(options.label, response);
      if (!response.body) {
        throw new LLMProviderError(`${options.label} API error ${response.status}: empty body`, response.status);
      }

      const callIds = toolCallIdsFromHistory(completion.messages);
      let callIndex = 0;
      let stopReason = 'end_turn';

      for await (const data of readSseData(response.body)) {
        if (!data || data === '[DONE]') continue;
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }

        const usage = chunk.usageMetadata as Record<string, unknown> | undefined;
        if (usage) {
          yield {
            kind: 'usage',
            input_tokens: Number(usage.promptTokenCount ?? 0),
            output_tokens: Number(usage.candidatesTokenCount ?? 0),
          };
        }

        const candidates = Array.isArray(chunk.candidates)
          ? (chunk.candidates as Record<string, unknown>[])
          : [];
        const candidate = candidates[0];
        if (!candidate) continue;

        const contentType = (candidate.content ?? {}) as Record<string, unknown>;
        const parts = Array.isArray(contentType.parts) ? (contentType.parts as GeminiPart[]) : [];
        for (const part of parts) {
          if (typeof part.text === 'string' && part.text !== '') {
            yield { kind: 'text_delta', text: part.text };
          }
          const call = part.functionCall as Record<string, unknown> | undefined;
          if (call && typeof call.name === 'string') {
            const id = callIds[callIndex] ?? `call_${callIndex}`;
            callIndex += 1;
            const args = call.args;
            // Gemini 3 renvoie un `thoughtSignature` à rejouer au tour suivant.
            const signature = part.thoughtSignature;
            const event: ProviderEvent = {
              kind: 'tool_use',
              id,
              name: toolNameFromWire(call.name),
              input:
                args !== null && typeof args === 'object' && !Array.isArray(args)
                  ? (args as Record<string, unknown>)
                  : {},
            };
            if (typeof signature === 'string' && signature !== '') {
              event.provider_meta = { thought_signature: signature };
            }
            yield event;
          }
        }

        if (typeof candidate.finishReason === 'string' && candidate.finishReason) {
          stopReason = geminiStopReason(candidate.finishReason);
        }
      }

      yield { kind: 'done', stop_reason: stopReason };
    },
  };
}

// ---------------------------------------------------------------------------
// Fabriques (`factory.py`) — exportées pour les tests
// ---------------------------------------------------------------------------

/** `_create_openai`. */
export function createOpenAiProvider(apiKey: string): Provider {
  if (!apiKey) throw new LLMConfigError('OpenAI provider requires OPENAI_API_KEY');
  return createOpenAiCompatibleProvider({
    label: 'OpenAI',
    apiKey,
    baseUrl: OPENAI_BASE_URL,
  });
}

/** `_create_openrouter`. */
export function createOpenRouterProvider(apiKey: string): Provider {
  if (!apiKey) throw new LLMConfigError('OpenRouter provider requires OPENROUTER_API_KEY');
  return createOpenAiCompatibleProvider({
    label: 'OpenRouter',
    apiKey,
    baseUrl: OPENROUTER_BASE_URL,
    extraHeaders: {
      // Recommandés par OpenRouter pour l'attribution (données publiques).
      'HTTP-Referer': 'https://visiodental.app',
      'X-Title': 'VisioDental',
    },
  });
}

/** `_create_groq`. */
export function createGroqProvider(apiKey: string): Provider {
  if (!apiKey) throw new LLMConfigError('Groq provider requires GROQ_API_KEY');
  return createOpenAiCompatibleProvider({ label: 'Groq', apiKey, baseUrl: GROQ_BASE_URL });
}

/** `GeminiProvider` (endpoint OpenAI-compatible de Google, comme Python). */
export function createGeminiOpenAiProvider(apiKey: string): Provider {
  if (!apiKey) throw new LLMConfigError('Gemini provider requires GEMINI_API_KEY');
  return createOpenAiCompatibleProvider({
    label: 'Gemini',
    apiKey,
    baseUrl: GEMINI_OPENAI_BASE_URL,
  });
}

/** `_create_ollama` (aucune clé ; racine lue dans `OLLAMA_BASE_URL`). */
export function createOllamaProvider(baseUrl?: string | null): Provider {
  return createOpenAiCompatibleProvider({
    label: 'Ollama',
    apiKey: OLLAMA_PLACEHOLDER_API_KEY,
    baseUrl: openAiCompatibleBaseUrl(baseUrl ?? config.ollamaBaseUrl),
  });
}

/** `_create_anthropic`. */
export function createAnthropicProviderFromKey(apiKey: string): Provider {
  if (!apiKey) throw new LLMConfigError('Anthropic provider requires ANTHROPIC_API_KEY');
  return createAnthropicProvider({ label: 'Anthropic', apiKey });
}

/**
 * Résolution par nom, utilisée par `provider.getProvider`. Aucune clé
 * manquante ne peut passer : `getProvider` l'a déjà refusée.
 */
export function createAdapterFor(
  name: string,
  apiKey: string | null,
  baseUrl: string | null,
): Provider {
  switch (name) {
    case 'openai':
      return createOpenAiProvider(apiKey ?? '');
    case 'anthropic':
      return createAnthropicProviderFromKey(apiKey ?? '');
    case 'gemini':
      // API native (et non l'endpoint OpenAI-compatible) : Gemini 3 exige le
      // renvoi du `thoughtSignature` des appels d'outils au tour suivant ;
      // l'adaptateur compatible OpenAI le perd et la 2e manche échoue en 400.
      return createGeminiProvider({
        label: 'Gemini',
        apiKey: apiKey ?? '',
        baseUrl: baseUrl ?? undefined,
      });
    case 'openrouter':
      return createOpenRouterProvider(apiKey ?? '');
    case 'groq':
      return createGroqProvider(apiKey ?? '');
    case 'ollama':
      return createOllamaProvider(baseUrl);
    default: {
      // Même message que `getProviderSpec` (liste dans l'ordre du manifeste).
      const supported = providerSpecs()
        .map((spec) => spec.name)
        .join(', ');
      throw new LLMConfigError(`Unsupported LLM provider: '${name}' (supported: ${supported})`);
    }
  }
}

/** Clé configurée pour un nom de fournisseur (`factory.get_configured_api_key`). */
export function configuredKeyFor(name: string): string | null {
  return getConfiguredApiKey(getProviderSpec(name));
}

/** Base URL configurée pour un nom de fournisseur (`factory.get_configured_base_url`). */
export function configuredBaseUrlFor(name: string): string | null {
  return getConfiguredBaseUrl(getProviderSpec(name));
}
