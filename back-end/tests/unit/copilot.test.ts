import { describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/lib/prisma';

import { config } from '../../src/config';
import {
  LLMConfigError,
  buildProviderSpecs,
  createRedactor,
  getProvider,
  getProviderSpec,
  providerSpecs,
  runTurn,
  textBlock,
  type Provider,
  type ProviderEvent,
  type ProviderMessage,
  type ToolRegistryLike,
} from '../../src/modules/copilot/provider';
import {
  COPILOT_GUARDRAILS,
  SYSTEM_PROMPT,
  driveTurn,
  frameFor,
  resumeTurn,
  sseFrame,
} from '../../src/modules/copilot/bridge';
import {
  allows,
  copilotToolRegistry,
  dateArg,
  permissionMatches,
  toolNamesFor,
  BUDGET_LIST_BUDGETS,
  RECALLS_LIST_DUE_RECALLS,
} from '../../src/modules/copilot/tools';
import {
  ClinicBudgetGuard,
  clampWindowDays,
  currentPeriodStart,
  errorRate,
  recipientIds,
  rollPeriod,
  sameUtcDate,
  toConversationDto,
  toNudgeDto,
  tokenUsagePct,
  messageFromRow,
} from '../../src/modules/copilot/service';
import { boundedIntQuery } from '../../src/modules/copilot/schemas';

// ---------------------------------------------------------------------------
// Fournisseurs (spec.py / factory.py)
// ---------------------------------------------------------------------------

describe('provider specifications', () => {
  it('registers the six Python providers in manifest order', () => {
    expect(providerSpecs().map((spec) => spec.name)).toEqual([
      'openai',
      'anthropic',
      'gemini',
      'openrouter',
      'groq',
      'ollama',
    ]);
  });

  it('reads the same env variable names for API keys', () => {
    const specs = buildProviderSpecs({
      openai: 'a',
      anthropic: 'b',
      gemini: 'c',
      openrouter: 'd',
      groq: 'e',
      ollama: 'f',
    });
    expect(specs.map((spec) => spec.apiKeySetting)).toEqual([
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
      'GROQ_API_KEY',
      null,
    ]);
    expect(specs.find((spec) => spec.name === 'ollama')?.baseUrlSetting).toBe('OLLAMA_BASE_URL');
    expect(specs.filter((spec) => spec.needsApiKey)).toHaveLength(5);
  });

  it('uses the COPILOT_MODEL_CHAT_* defaults of config.ts', () => {
    const spec = getProviderSpec('openai');
    expect(spec.defaultModel).toBe(config.copilotModelChatOpenai);
    expect(spec.toolDialect).toBe('openai');
    expect(getProviderSpec('anthropic').toolDialect).toBe('anthropic');
  });

  it('raises the Python message for an unknown provider', () => {
    expect(() => getProviderSpec('nope')).toThrowError(
      "Unsupported LLM provider: 'nope' (supported: openai, anthropic, gemini, openrouter, groq, ollama)",
    );
    expect(() => getProviderSpec('nope')).toThrow(LLMConfigError);
  });

  it('getProvider fails closed without an adapter or a key', () => {
    const previous = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      expect(() => getProvider('groq')).toThrowError(
        'Groq provider selected but GROQ_API_KEY is not configured',
      );
    } finally {
      if (previous !== undefined) process.env.GROQ_API_KEY = previous;
    }
  });

  it('ships the copilot prompt and inline-confirmation guardrails', () => {
    expect(SYSTEM_PROMPT).toContain('Eres el copiloto de VisioDental');
    expect(SYSTEM_PROMPT).toContain('Briefing del día');
    expect(COPILOT_GUARDRAILS.requireApprovalFor).toEqual([]);
    expect(COPILOT_GUARDRAILS.autoRequireApprovalForDestructive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SSE (`router._sse` / `_frame`)
// ---------------------------------------------------------------------------

describe('SSE framing', () => {
  it('writes `event:`/`data:` lines with a blank line terminator', () => {
    expect(sseFrame('token', { text: 'hola' })).toBe(
      'event: token\ndata: {"text":"hola"}\n\n',
    );
  });

  it('maps each turn event to its Python frame', () => {
    expect(frameFor({ kind: 'token', text: 'a' })).toBe('event: token\ndata: {"text":"a"}\n\n');
    expect(
      frameFor({ kind: 'tool_call_started', call_id: 'c1', name: 'x', arguments: {} }),
    ).toBe('event: tool_call\ndata: {"call_id":"c1","name":"x","arguments":{}}\n\n');
    expect(
      frameFor({ kind: 'tool_call_finished', call_id: 'c1', name: 'x', ok: true, result: null }),
    ).toBe('event: tool_result\ndata: {"call_id":"c1","name":"x","ok":true,"result":null}\n\n');
    expect(
      frameFor({ kind: 'confirmation_required', call_id: 'c1', name: 'x', arguments: {} }),
    ).toBe('event: confirmation_required\ndata: {"call_id":"c1","name":"x","arguments":{}}\n\n');
    expect(frameFor({ kind: 'usage', input_tokens: 3, output_tokens: 4 })).toBe(
      'event: usage\ndata: {"input_tokens":3,"output_tokens":4}\n\n',
    );
    expect(frameFor({ kind: 'final', stop_reason: 'end_turn' })).toBe(
      'event: done\ndata: {"stop_reason":"end_turn"}\n\n',
    );
    expect(frameFor({ kind: 'budget_exceeded' })).toBe('event: budget_exceeded\ndata: {}\n\n');
  });
});

// ---------------------------------------------------------------------------
// Registre d'outils restreint et RBAC
// ---------------------------------------------------------------------------

describe('tool registry', () => {
  it('permission_matches honours the RBAC wildcards', () => {
    expect(permissionMatches('recalls.read', '*')).toBe(true);
    expect(permissionMatches('recalls.read', 'recalls.*')).toBe(true);
    expect(permissionMatches('recalls.read', 'recalls.read')).toBe(true);
    expect(permissionMatches('recalls.read', 'budget.*')).toBe(false);
    expect(allows(['budget.*'], 'budget.read')).toBe(true);
  });

  const REGISTRY_ORDER = [
    'recalls.list_due_recalls',
    'recalls.get_recall',
    'recalls.create_recall',
    'recalls.log_contact_attempt',
    'recalls.snooze_recall',
    'recalls.complete_recall',
    'budget.list_budgets',
    'budget.get_budget',
    'budget.send_budget',
    'agenda.get_day_overview',
    'agenda.get_appointment',
    'agenda.list_cabinets',
    'agenda.list_professionals',
    'agenda.book_appointment',
    'agenda.reschedule_appointment',
    'agenda.update_appointment_status',
    'agenda.cancel_appointment',
    'billing.list_invoices',
    'billing.get_invoice',
    'catalog.list_catalog_items',
    'catalog.get_catalog_item',
    'patients.search_patients',
    'patients.get_patient',
    'patients.create_patient',
    'patients.update_patient',
    'payments.payments_summary',
    'payments.collections_by_method',
    'payments.record_payment',
    'payments.patient_payment_history',
    'reports.billing_report',
    'reports.top_clients_by_billing',
    'reports.scheduling_report',
    'reports.financial_report',
    'reports.patient_stats_report',
    'reports.operational_report',
    'schedules.get_availability',
    'schedules.find_free_slots',
    'patient_timeline.get_patient_timeline',
    'notifications.send_notification',
  ];

  it('lists tools in Python registration order', () => {
    expect(copilotToolRegistry.list()).toEqual(REGISTRY_ORDER);
    expect(copilotToolRegistry.category(RECALLS_LIST_DUE_RECALLS)).toBe('read');
  });

  it('filters tools with the AND of permissions', () => {
    expect(toolNamesFor(['*'])).toEqual(REGISTRY_ORDER);
    expect(toolNamesFor(['recalls.read'])).toEqual([
      'recalls.list_due_recalls',
      'recalls.get_recall',
    ]);
    expect(toolNamesFor(['budget.read'])).toEqual([
      'budget.list_budgets',
      'budget.get_budget',
    ]);
    expect(toolNamesFor([])).toEqual([]);
  });

  it('rejects calls without the tool permission (like a denied registry call)', async () => {
    const result = await copilotToolRegistry.call(
      { clinicId: 'c', timeZone: 'UTC', role: 'r', permissions: [], userId: 'u' },
      RECALLS_LIST_DUE_RECALLS,
      {},
    );
    expect(result).toEqual({ ok: false, error: 'permission denied: recalls.read' });
  });

  it('parses date arguments like the Pydantic `date` type', () => {
    expect(dateArg('2026-03-17')?.toISOString()).toBe('2026-03-17T00:00:00.000Z');
    expect(dateArg('2026-03-17T10:00:00')).not.toBeNull();
    expect(dateArg('17/03/2026')).toBeNull();
    expect(dateArg(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// run_turn (`orchestrator.py`)
// ---------------------------------------------------------------------------

async function* streamOf(events: ProviderEvent[]): AsyncGenerator<ProviderEvent> {
  for (const event of events) yield event;
}

interface FakeProvider {
  provider: Provider;
  /** Nombre d'appels fournisseur effectués (lecture dynamique). */
  state: { calls: number };
}

function fakeProvider(script: ProviderEvent[][]): FakeProvider {
  const state = { calls: 0 };
  return {
    state,
    provider: {
      complete(options) {
        const events = script[state.calls] ?? [];
        state.calls += 1;
        void options;
        return streamOf(events);
      },
    },
  };
}

const emptyRegistry: ToolRegistryLike = {
  list: () => [],
  category: () => null,
  call: async () => ({ ok: false, error: 'unused' }),
  schemaFor: () => null,
};

describe('runTurn', () => {
  it('streams tokens at whitespace boundaries, then usage and done', async () => {
    const { provider } = fakeProvider([
      [
        { kind: 'text_delta', text: 'Hola ' },
        { kind: 'text_delta', text: 'mundo' },
        { kind: 'usage', input_tokens: 10, output_tokens: 2 },
        { kind: 'done', stop_reason: 'end_turn' },
      ],
    ]);
    const history: ProviderMessage[] = [{ role: 'user', content: [textBlock('hi')] }];
    const events = [];
    for await (const event of runTurn({
      provider,
      system: 's',
      history,
      toolNames: [],
      redactor: createRedactor(false),
      model: 'm',
      maxTokens: 10,
      tools: emptyRegistry,
      toolContext: {},
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      { kind: 'token', text: 'Hola ' },
      { kind: 'token', text: 'mundo' },
      { kind: 'usage', input_tokens: 10, output_tokens: 2 },
      { kind: 'final', stop_reason: 'end_turn' },
    ]);
    expect(history).toHaveLength(2);
    expect(history[1]!.role).toBe('assistant');
    expect(history[1]!.content).toEqual([{ type: 'text', text: 'Hola mundo' }]);
  });

  it('executes READ tools and feeds the result back', async () => {
    const { provider, state } = fakeProvider([
      [
        { kind: 'tool_use', id: 'c1', name: 'recalls.list_due_recalls', input: { overdue: true } },
        { kind: 'done', stop_reason: 'tool_use' },
      ],
      [{ kind: 'text_delta', text: 'Listo. ' }, { kind: 'done', stop_reason: 'end_turn' }],
    ]);
    const registry: ToolRegistryLike = {
      list: () => ['recalls.list_due_recalls'],
      category: () => 'read',
      schemaFor: () => ({ name: 'recalls.list_due_recalls', description: 'd', input_schema: {} }),
      call: async () => ({ ok: true, data: { total: 0, recalls: [] } }),
    };
    const events = [];
    for await (const event of runTurn({
      provider,
      system: 's',
      history: [],
      toolNames: ['recalls.list_due_recalls'],
      redactor: createRedactor(false),
      model: 'm',
      maxTokens: 10,
      tools: registry,
      toolContext: {},
    })) {
      events.push(event);
    }
    expect(state.calls).toBe(2);
    expect(events.map((event) => event.kind)).toEqual([
      'tool_call_started',
      'tool_call_finished',
      'token',
      'final',
    ]);
    expect(events[1]).toMatchObject({ ok: true, result: { total: 0, recalls: [] } });
  });

  it('executes every READ of a parallel batch and keeps responses balanced', async () => {
    const { provider, state } = fakeProvider([
      [
        { kind: 'tool_use', id: 'c1', name: 'recalls.list_due_recalls', input: {} },
        { kind: 'tool_use', id: 'c2', name: 'budget.list_budgets', input: {} },
        { kind: 'done', stop_reason: 'tool_use' },
      ],
      [{ kind: 'text_delta', text: 'Listo. ' }, { kind: 'done', stop_reason: 'end_turn' }],
    ]);
    const registry: ToolRegistryLike = {
      list: () => ['recalls.list_due_recalls', 'budget.list_budgets'],
      category: () => 'read',
      schemaFor: () => null,
      call: async (_ctx, name) => ({ ok: true, data: { tool: name } }),
    };
    const history: ProviderMessage[] = [];
    const events = [];
    for await (const event of runTurn({
      provider,
      system: 's',
      history,
      toolNames: ['recalls.list_due_recalls', 'budget.list_budgets'],
      redactor: createRedactor(false),
      model: 'm',
      maxTokens: 10,
      tools: registry,
      toolContext: {},
    })) {
      events.push(event);
    }
    expect(state.calls).toBe(2);
    expect(events.filter((event) => event.kind === 'tool_call_finished')).toHaveLength(2);
    const toolMessage = history.find((message) => message.role === 'tool')!;
    expect(toolMessage.content).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_call_id: 'c1' }),
      expect.objectContaining({ type: 'tool_result', tool_call_id: 'c2' }),
    ]);
  });

  it('pauses on the first WRITE of a batch and marks the rest not executed', async () => {
    const { provider } = fakeProvider([
      [
        { kind: 'tool_use', id: 'c1', name: 'recalls.list_due_recalls', input: {} },
        { kind: 'tool_use', id: 'c2', name: 'agenda.book_appointment', input: {} },
        { kind: 'tool_use', id: 'c3', name: 'agenda.cancel_appointment', input: {} },
      ],
    ]);
    const registry: ToolRegistryLike = {
      list: () => [],
      category: (_name) => (String(_name).includes('list') ? 'read' : 'write'),
      schemaFor: () => null,
      call: async () => ({ ok: true, data: { total: 0 } }),
    };
    const history: ProviderMessage[] = [];
    const events = [];
    for await (const event of runTurn({
      provider,
      system: 's',
      history,
      toolNames: [],
      redactor: createRedactor(false),
      model: 'm',
      maxTokens: 10,
      tools: registry,
      toolContext: {},
    })) {
      events.push(event);
    }
    expect(events[events.length - 1]).toMatchObject({
      kind: 'confirmation_required',
      call_id: 'c2',
    });
    expect(history[history.length - 1]!.content).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_call_id: 'c1' }),
      expect.objectContaining({
        type: 'tool_result',
        tool_call_id: 'c3',
        content: { status: 'not_executed', reason: 'parallel_call' },
      }),
    ]);
  });

  it('suspends the turn on a WRITE tool (inline confirmation)', async () => {
    const { provider, state } = fakeProvider([
      [{ kind: 'tool_use', id: 'c9', name: 'agenda.book_appointment', input: { patient_id: 'p' } }],
    ]);
    let executed = false;
    const registry: ToolRegistryLike = {
      list: () => [],
      category: () => 'write',
      schemaFor: () => null,
      call: async () => {
        executed = true;
        return { ok: true, data: null };
      },
    };
    const events = [];
    for await (const event of runTurn({
      provider,
      system: 's',
      history: [],
      toolNames: [],
      redactor: createRedactor(false),
      model: 'm',
      maxTokens: 10,
      tools: registry,
      toolContext: {},
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        kind: 'confirmation_required',
        call_id: 'c9',
        name: 'agenda.book_appointment',
        arguments: { patient_id: 'p' },
      },
    ]);
    // Le tour s'arrête : un seul appel fournisseur, aucune exécution.
    expect(state.calls).toBe(1);
    expect(executed).toBe(false);
  });

  it('stops with budget_exceeded once the guard refuses', async () => {
    const { provider } = fakeProvider([[{ kind: 'done', stop_reason: 'end_turn' }]]);
    const events = [];
    for await (const event of runTurn({
      provider,
      system: 's',
      history: [],
      toolNames: [],
      redactor: createRedactor(false),
      model: 'm',
      maxTokens: 10,
      tools: emptyRegistry,
      toolContext: {},
      budget: { check: () => false, record: () => undefined },
    })) {
      events.push(event);
    }
    expect(events).toEqual([{ kind: 'budget_exceeded' }]);
  });
});

// ---------------------------------------------------------------------------
// Budget et compteurs (`ClinicBudgetGuard`, métriques)
// ---------------------------------------------------------------------------
describe('ClinicBudgetGuard', () => {
  it('allows everything when no limit is set', () => {
    const guard = new ClinicBudgetGuard(
      { monthly_token_limit: null, period_input_tokens: 999, period_output_tokens: 999 },
      { total_input_tokens: 0, total_output_tokens: 0 },
    );
    expect(guard.check()).toBe(true);
  });

  it('records usage and flags the 80% threshold', () => {
    const settings = { monthly_token_limit: 100, period_input_tokens: 0, period_output_tokens: 0 };
    const conversation = { total_input_tokens: 0, total_output_tokens: 0 };
    const guard = new ClinicBudgetGuard(settings, conversation);
    guard.record(50, 10);
    expect(guard.thresholdCrossed).toBe(false);
    guard.record(20, 0);
    expect(settings.period_input_tokens).toBe(70);
    expect(conversation.total_input_tokens).toBe(70);
    expect(conversation.total_output_tokens).toBe(10);
    expect(guard.thresholdCrossed).toBe(true);
    expect(guard.check()).toBe(true);
  });

  it('refuses once the monthly total reaches the limit', () => {
    const guard = new ClinicBudgetGuard(
      { monthly_token_limit: 10, period_input_tokens: 6, period_output_tokens: 4 },
      { total_input_tokens: 0, total_output_tokens: 0 },
    );
    expect(guard.check()).toBe(false);
  });
});

describe('metrics helpers', () => {
  it('clamps the window to 1..365', () => {
    expect(clampWindowDays(0)).toBe(1);
    expect(clampWindowDays(30)).toBe(30);
    expect(clampWindowDays(1000)).toBe(365);
  });

  it('computes error_rate and token_usage_pct like Python', () => {
    expect(errorRate(0, 0)).toBe(0);
    expect(errorRate(2, 8)).toBe(0.25);
    expect(tokenUsagePct(50, null)).toBeNull();
    expect(tokenUsagePct(50, 0)).toBeNull();
    expect(tokenUsagePct(50, 200)).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// Période mensuelle et sérialisation
// ---------------------------------------------------------------------------

describe('settings period roll', () => {
  it('uses the first day of the current UTC month', () => {
    expect(currentPeriodStart(new Date('2026-11-18T23:59:59Z')).toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
    expect(sameUtcDate(new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'))).toBe(
      true,
    );
  });

  it('zeroes the counters when the month changed', () => {
    const row = {
      clinic_id: 'c',
      provider: 'openai',
      model: 'm',
      redaction_enabled: true,
      monthly_token_limit: 100,
      monthly_cost_limit_cents: null,
      period_start: new Date('2026-10-01T00:00:00Z'),
      period_input_tokens: 5,
      period_output_tokens: 7,
      period_cost_cents: 3,
      updated_at: new Date(),
      digest_enabled: false,
      digest_hour: 8,
      digest_recipient_user_ids: [],
    };
    const rolled = rollPeriod(row, new Date('2026-11-18T10:00:00Z'));
    expect(rolled.period_start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(rolled.period_input_tokens).toBe(0);
    expect(rolled.period_output_tokens).toBe(0);
    expect(rolled.period_cost_cents).toBe(0);
    expect(rolled.monthly_token_limit).toBe(100);
    // Même mois : renvoie la même instance.
    expect(rollPeriod(row, new Date('2026-10-20T10:00:00Z'))).toBe(row);
  });

  it('serialises recipients and messages from JSONB columns', () => {
    expect(recipientIds({ digest_recipient_user_ids: ['a', 2, 'b'] })).toEqual(['a', 'b']);
    expect(recipientIds({ digest_recipient_user_ids: null })).toEqual([]);
    expect(
      messageFromRow('tool', [{ type: 'tool_result', tool_call_id: 'c', content: {}, is_error: false }])
        .role,
    ).toBe('tool');
  });

  it('maps a conversation and a nudge row to the Pydantic shape', () => {
    const now = new Date('2026-11-18T10:00:00Z');
    const conversation = toConversationDto({
      id: 'c1',
      clinic_id: 'cl',
      user_id: 'u',
      session_id: null,
      title: null,
      context: {},
      redaction_salt: null,
      provider: 'openai',
      model: 'm',
      status: 'active',
      total_input_tokens: 3,
      total_output_tokens: 4,
      cost_cents: 0,
      created_at: now,
      updated_at: now,
    });
    expect(conversation).toEqual({
      id: 'c1',
      title: null,
      status: 'active',
      provider: 'openai',
      model: 'm',
      total_input_tokens: 3,
      total_output_tokens: 4,
      created_at: '2026-11-18T10:00:00.000Z',
      updated_at: '2026-11-18T10:00:00.000Z',
    });
    expect(
      toNudgeDto({
        id: 'n1',
        clinic_id: 'cl',
        kind: 'appointment_cancelled',
        payload: { appointment_id: 'a' },
        required_permission: null,
        status: 'pending',
        dedupe_key: 'k',
        created_at: now,
        expires_at: now,
      }).payload,
    ).toEqual({ appointment_id: 'a' });
  });
});

// ---------------------------------------------------------------------------
// Validation des Query(...)
// ---------------------------------------------------------------------------

describe('boundedIntQuery', () => {
  it('applies the FastAPI defaults and clamps', () => {
    expect(boundedIntQuery(undefined, 20, 1, 100, 'page_size')).toBe(20);
    expect(boundedIntQuery('50', 20, 1, 100, 'page_size')).toBe(50);
    expect(boundedIntQuery('0', 20, 1, 100, 'page_size')).toEqual({
      error: 'page_size: Input should be greater than or equal to 1',
    });
    expect(boundedIntQuery('101', 20, 1, 100, 'page_size')).toEqual({
      error: 'page_size: Input should be less than or equal to 100',
    });
    expect(boundedIntQuery('abc', 30, 1, 365, 'days')).toEqual({
      error: 'days: Input should be a valid integer',
    });
  });
});

// ---------------------------------------------------------------------------
// bridge.driveTurn / resumeTurn (Prisma simulé, fournisseur injecté)
// ---------------------------------------------------------------------------

describe('bridge turns', () => {
  it('persists the user message, streams the turn and stores the tail', async () => {
    const rows: Array<Record<string, unknown>> = [];
    vi.spyOn(prisma.copilot_messages, 'findMany').mockResolvedValue([] as never);
    vi.spyOn(prisma.copilot_messages, 'aggregate').mockResolvedValue({
      _max: { seq: null },
    } as never);
    vi.spyOn(prisma.copilot_messages, 'create').mockImplementation((async (args: {
      data: Record<string, unknown>;
    }) => {
      const row = { ...args.data, id: `m${rows.length}`, seq: rows.length + 1 };
      rows.push(row);
      return row;
    }) as never);

    const conv = {
      id: 'conv',
      clinic_id: 'clinic',
      user_id: 'user',
      session_id: 'sess',
      title: null,
      context: {},
      redaction_salt: 'salt',
      provider: 'openai',
      model: 'gpt',
      status: 'active',
      total_input_tokens: 0,
      total_output_tokens: 0,
      cost_cents: 0,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const settingsRow = {
      clinic_id: 'clinic',
      provider: 'openai',
      model: 'gpt',
      redaction_enabled: false,
      monthly_token_limit: null,
      monthly_cost_limit_cents: null,
      period_start: new Date(),
      period_input_tokens: 0,
      period_output_tokens: 0,
      period_cost_cents: 0,
      updated_at: new Date(),
      digest_enabled: false,
      digest_hour: 8,
      digest_recipient_user_ids: [],
    };

    const { provider } = fakeProvider([[
      { kind: 'text_delta', text: 'Hola ' },
      { kind: 'usage', input_tokens: 5, output_tokens: 6 },
      { kind: 'done', stop_reason: 'end_turn' },
    ]]);

    const events = [] as string[];
    for await (const event of driveTurn(
      {
        conv,
        settingsRow,
        permissions: ['*'],
        userId: 'user',
        agentId: 'agent',
        sessionId: 'sess',
        timeZone: 'Europe/Madrid',
        provider,
      },
      '¿Qué hay hoy?',
    )) {
      events.push(event.kind);
    }

    expect(events).toEqual(['token', 'usage', 'final']);
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant']);
    expect(rows[0]!.content).toEqual([{ type: 'text', text: '¿Qué hay hoy?' }]);
    // `usage` n'est pas persisté par message : seuls les blocs le sont,
    // comme `_persist_tail` (les compteurs passent par le budget).
    expect(rows[1]!.content).toEqual([{ type: 'text', text: 'Hola ' }]);
    vi.restoreAllMocks();
  });

  it('replays the stored result on a duplicate confirm (#532)', async () => {
    const historyRows = [
      { id: 'a', role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'x', input: {} }] },
      {
        id: 'b',
        role: 'tool',
        content: [{ type: 'tool_result', tool_call_id: 'c1', content: { ok: 1 }, is_error: false }],
      },
    ];
    vi.spyOn(prisma.copilot_messages, 'findMany').mockResolvedValue(historyRows as never);
    const create = vi.spyOn(prisma.copilot_messages, 'create');
    vi.spyOn(prisma.copilot_messages, 'aggregate').mockResolvedValue({ _max: { seq: 2 } } as never);
    const { provider, state } = fakeProvider([[
      { kind: 'done', stop_reason: 'end_turn' },
    ]]);

    const events = [];
    for await (const event of resumeTurn(
      {
        conv: { id: 'conv', clinic_id: 'clinic', provider: 'openai', model: 'gpt', redaction_salt: 's' } as never,
        settingsRow: { redaction_enabled: false, monthly_token_limit: null, period_input_tokens: 0, period_output_tokens: 0 } as never,
        permissions: ['*'],
        userId: 'user',
        agentId: 'agent',
        sessionId: 'sess',
        timeZone: 'UTC',
        provider,
      },
      'c1',
      true,
    )) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      kind: 'tool_call_finished',
      call_id: 'c1',
      name: 'x',
      ok: true,
      result: { ok: 1 },
    });
    // Rien n'est ré-ajouté pour l'outil (ni exécution ni `tool_result`) :
    // seul l'assistant vide du tour repris est persisté, comme Python.
    expect(create.mock.calls).toHaveLength(1);
    const persisted = create.mock.calls[0]![0] as { data: { role: string; content: unknown } };
    expect(persisted.data.role).toBe('assistant');
    expect(persisted.data.content).toEqual([]);
    // L'historique persiste bien deux entrées (tool_use + tool_result) :
    // le tour repris repart de la fin de l'historique.
    expect(create.mock.calls).toHaveLength(1);
    expect(state.calls).toBe(1);
    vi.restoreAllMocks();
  });
});
