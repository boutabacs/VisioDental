import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LLMConfigError,
  type ProviderEvent,
  type ProviderMessage,
  textBlock,
  toolResultBlock,
  toolUseBlock,
} from '../../src/modules/copilot/provider';
import {
  createAnthropicProviderFromKey,
  createGeminiProvider,
  createOpenAiProvider,
  toolNameFromWire,
  wireToolName,
} from '../../src/modules/copilot/providers';

// ---------------------------------------------------------------------------
// fetch simulé : renvoie un body SSE construit à partir de chunks
// ---------------------------------------------------------------------------

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = frames.map((frame) => `data: ${frame}\n\n`).join('');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Deux morceaux pour vérifier le réassemblage des trames à cheval.
      const half = Math.floor(payload.length / 2);
      controller.enqueue(encoder.encode(payload.slice(0, half)));
      controller.enqueue(encoder.encode(payload.slice(half)));
      controller.close();
    },
  });
}

function mockFetch(frames: string[], status = 200): Captured {
  const captured: Captured = { url: '', init: {}, body: {} };
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    captured.url = String(url);
    captured.init = init;
    captured.body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    return new Response(status === 200 ? sseBody(frames) : '{"error":{"message":"boom"}}', {
      status,
      headers: { 'Content-Type': status === 200 ? 'text/event-stream' : 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return captured;
}

async function collect(
  provider: { complete: (options: {
    system: string;
    messages: ProviderMessage[];
    tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
    model: string;
    maxTokens: number;
  }) => AsyncIterable<ProviderEvent> },
  messages: ProviderMessage[] = [{ role: 'user', content: [textBlock('hola')] }],
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[] = [],
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of provider.complete({
    system: 'eres un copiloto',
    messages,
    tools,
    model: 'test-model',
    maxTokens: 512,
  })) {
    out.push(event);
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Bijection des noms d'outils (`. ` ↔ `-`)
// ---------------------------------------------------------------------------

describe('wire tool names', () => {
  it('maps qualified names to the OpenAI/Anthropic charset and back', () => {
    expect(wireToolName('recalls.list_due_recalls')).toBe('recalls-list_due_recalls');
    expect(toolNameFromWire('recalls-list_due_recalls')).toBe('recalls.list_due_recalls');
    expect(wireToolName('recalls.list_due_recalls')).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible (openai / openrouter / groq / ollama)
// ---------------------------------------------------------------------------

describe('OpenAI-compatible adapter', () => {
  it('maps messages, tools and streams text + assembled tool call + usage', async () => {
    const captured = mockFetch([
      '{"choices":[{"delta":{"content":"Hola "}}]}',
      '{"choices":[{"delta":{"content":"mundo"}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"recalls-list_due_recalls","arguments":"{\\"over"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"due\\":true}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":7}}',
      '[DONE]',
    ]);

    const provider = createOpenAiProvider('sk-test');
    const history: ProviderMessage[] = [
      { role: 'user', content: [textBlock('cuántos recalls')] },
      {
        role: 'assistant',
        content: [toolUseBlock('c0', 'budget.list_budgets', { limit: 5 })],
      },
      { role: 'tool', content: [toolResultBlock('c0', { total: 0 })] },
    ];
    const events = await collect(
      provider,
      history,
      [
        {
          name: 'recalls.list_due_recalls',
          description: 'd',
          input_schema: { type: 'object', properties: {} },
        },
      ],
    );

    // Requête
    expect(captured.url).toBe('https://api.openai.com/v1/chat/completions');
    expect((captured.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(captured.body.stream).toBe(true);
    expect(captured.body.max_tokens).toBe(512);
    const messages = captured.body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'eres un copiloto' });
    expect(messages[1]).toEqual({ role: 'user', content: 'cuántos recalls' });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'c0',
          type: 'function',
          function: { name: 'budget-list_budgets', arguments: '{"limit":5}' },
        },
      ],
    });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'c0', content: '{"total":0}' });
    const tools = captured.body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'recalls-list_due_recalls', description: 'd' },
    });

    // Flux
    expect(events).toEqual([
      { kind: 'text_delta', text: 'Hola ' },
      { kind: 'text_delta', text: 'mundo' },
      { kind: 'usage', input_tokens: 11, output_tokens: 7 },
      {
        kind: 'tool_use',
        id: 'call_1',
        name: 'recalls.list_due_recalls',
        input: { overdue: true },
      },
      { kind: 'done', stop_reason: 'tool_calls' },
    ]);
  });

  it('raises the Python-shaped error on a non-2xx answer', async () => {
    mockFetch([], 401);
    const provider = createOpenAiProvider('sk-secret-value');
    await expect(collect(provider)).rejects.toThrow('OpenAI API error 401: boom');
    await expect(collect(provider)).rejects.not.toThrow(/sk-secret-value/);
  });

  it('requires an API key for the keyed providers', () => {
    expect(() => createOpenAiProvider('')).toThrow(LLMConfigError);
    expect(() => createAnthropicProviderFromKey('')).toThrow(
      'Anthropic provider requires ANTHROPIC_API_KEY',
    );
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe('Anthropic adapter', () => {
  it('streams text, input_json_delta tool input, usage and stop_reason', async () => {
    const captured = mockFetch([
      '{"type":"message_start","message":{"usage":{"input_tokens":21,"output_tokens":1}}}',
      '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Listo"}}',
      '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"agenda-book_appointment"}}',
      '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"patient_id\\":"}}',
      '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"p1\\"}"}}',
      '{"type":"content_block_stop","index":1}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
      '{"type":"message_stop"}',
    ]);

    const provider = createAnthropicProviderFromKey('ant-test');
    const events = await collect(provider, undefined, [
      {
        name: 'agenda.book_appointment',
        description: 'd',
        input_schema: { type: 'object', properties: {} },
      },
    ]);

    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = captured.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(captured.body.system).toBe('eres un copiloto');
    expect(typeof captured.body.max_tokens).toBe('number');
    const tools = captured.body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({
      name: 'agenda-book_appointment',
      input_schema: { type: 'object' },
    });

    expect(events).toEqual([
      { kind: 'text_delta', text: 'Listo' },
      { kind: 'usage', input_tokens: 21, output_tokens: 9 },
      { kind: 'tool_use', id: 'toolu_1', name: 'agenda.book_appointment', input: { patient_id: 'p1' } },
      { kind: 'done', stop_reason: 'tool_use' },
    ]);
  });

  it('encodes tool results as tool_result blocks', async () => {
    const captured = mockFetch([
      '{"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}',
      '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      '{"type":"message_stop"}',
    ]);
    const provider = createAnthropicProviderFromKey('ant-test');
    await collect(provider, [
      { role: 'user', content: [textBlock('hola')] },
      { role: 'assistant', content: [toolUseBlock('t1', 'patients.get_patient', { patient_id: 'p' })] },
      { role: 'tool', content: [toolResultBlock('t1', { id: 'p' })] },
    ]);
    const messages = captured.body.messages as Array<Record<string, unknown>>;
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '{"id":"p"}' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Gemini (endpoint natif)
// ---------------------------------------------------------------------------

describe('Gemini adapter', () => {
  it('streams text parts, functionCall and usage from the native endpoint', async () => {
    const captured = mockFetch([
      '{"candidates":[{"content":{"parts":[{"text":"Buenos"}]}}]}',
      '{"candidates":[{"content":{"parts":[{"text":" días"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}',
      '{"candidates":[{"content":{"parts":[{"functionCall":{"name":"catalog-list_catalog_items","args":{"page":1}}}]},"finishReason":"STOP"}]}',
    ]);

    const provider = createGeminiProvider({ label: 'Gemini', apiKey: 'gem-key' });
    const events = await collect(
      provider,
      [
        { role: 'user', content: [textBlock('hola')] },
        { role: 'assistant', content: [toolUseBlock('g0', 'patients.search_patients', {})] },
        { role: 'tool', content: [toolResultBlock('g0', { total: 0 })] },
      ],
      [
        {
          name: 'catalog.list_catalog_items',
          description: 'd',
          input_schema: { type: 'object', properties: {} },
        },
      ],
    );

    expect(captured.url).toContain('/models/test-model:streamGenerateContent?alt=sse');
    expect(captured.url).toContain('key=gem-key');
    expect(captured.body.systemInstruction).toEqual({ parts: [{ text: 'eres un copiloto' }] });
    const tools = captured.body.tools as Array<{ functionDeclarations: unknown[] }>;
    expect(tools[0]!.functionDeclarations[0]).toMatchObject({
      name: 'catalog-list_catalog_items',
    });
    const contents = captured.body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    expect(contents[contents.length - 1]!.parts[0]).toEqual({
      functionResponse: { name: 'patients-search_patients', response: { total: 0 } },
    });

    expect(events.filter((event) => event.kind === 'text_delta')).toEqual([
      { kind: 'text_delta', text: 'Buenos' },
      { kind: 'text_delta', text: ' días' },
    ]);
    expect(events.find((event) => event.kind === 'tool_use')).toMatchObject({
      name: 'catalog.list_catalog_items',
      input: { page: 1 },
    });
    expect(events[events.length - 1]).toEqual({ kind: 'done', stop_reason: 'end_turn' });
  });

  it('replays the thoughtSignature of the previous tool call', async () => {
    const captured = mockFetch([
      '{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}',
    ]);
    const provider = createGeminiProvider({ label: 'Gemini', apiKey: 'gem-key' });
    await collect(provider, [
      { role: 'user', content: [textBlock('hola')] },
      {
        role: 'assistant',
        content: [toolUseBlock('g0', 'budget.list_budgets', {}, { thought_signature: 'sig-abc' })],
      },
      { role: 'tool', content: [toolResultBlock('g0', { total: 0 })] },
    ]);
    const contents = captured.body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const model = contents.find((content) => content.role === 'model')!;
    expect(model.parts[0]).toEqual({
      functionCall: { name: 'budget-list_budgets', args: {} },
      thoughtSignature: 'sig-abc',
    });
  });

  it('exposes the streamed thoughtSignature on the tool_use event', async () => {
    mockFetch([
      '{"candidates":[{"content":{"parts":[{"functionCall":{"name":"budget-list_budgets"},"thoughtSignature":"sig-stream"}]}}]}',
    ]);
    const provider = createGeminiProvider({ label: 'Gemini', apiKey: 'gem-key' });
    const events = await collect(provider);
    expect(events.find((event) => event.kind === 'tool_use')).toMatchObject({
      kind: 'tool_use',
      provider_meta: { thought_signature: 'sig-stream' },
    });
  });

  it('drops JSON Schema keywords the native endpoint rejects', async () => {
    const captured = mockFetch([
      '{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}',
    ]);
    const provider = createGeminiProvider({ label: 'Gemini', apiKey: 'gem-key' });
    await collect(provider, undefined, [
      {
        name: 'budget.list_budgets',
        description: 'd',
        input_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 100 },
            filters: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
        },
      },
    ]);
    const tools = captured.body.tools as Array<{ functionDeclarations: unknown[] }>;
    expect(tools[0]!.functionDeclarations[0]).toEqual({
      name: 'budget-list_budgets',
      description: 'd',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', minimum: 0, maximum: 100 },
          filters: { type: 'object' },
        },
      },
    });
  });
});
