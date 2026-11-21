/**
 * Registre d'outils d'agent du copilot — port de `get_tools()` de chaque
 * module Python installé et déjà porté côté Express :
 *
 * | module            | outils | lecture | écriture | destructif |
 * |-------------------|--------|---------|----------|------------|
 * | recalls           | 6      | 2       | 4        | –          |
 * | budget            | 3      | 2       | –        | 1          |
 * | agenda            | 8      | 4       | 3        | 1          |
 * | billing           | 2      | 2       | –        | –          |
 * | catalog           | 2      | 2       | –        | –          |
 * | patients          | 4      | 2       | 2        | –          |
 * | payments          | 4      | 3       | 1        | –          |
 * | reports           | 6      | 6       | –        | –          |
 * | schedules         | 2      | 2       | –        | –          |
 * | patient_timeline  | 1      | 1       | –        | –          |
 * | notifications     | 1      | –       | 1        | –          |
 *
 * Chaque entrée reprend le nom qualifié (`{module}.{tool}`), la description,
 * le schéma d'arguments (`tool-schema.ts`), les permissions RBAC
 * (`Tool.permissions`), la catégorie (`read`/`write`/`destructive`) et
 * `exposes_free_text`. Les handlers délèguent aux services portés
 * (`modules/<module>/service.ts`) sans logique métier propre.
 *
 * Le registre est le point d'invocation unique (`ToolRegistry._invoke`) :
 * ordre des contrôles identique à Python — outil inconnu, permissions,
 * exécution du handler, erreurs converties en `ToolCallOutcome { ok:false }`.
 * Les outils `write`/`destructive` ne sont **jamais** exécutés par
 * `run_turn` : le tour est suspendu (`confirmation_required`) et le bridge
 * reprend via `copilotToolRegistry.call` après approbation.
 *
 * Contexte (`AgentContext` réduit) : `{ prisma, clinicId, timeZone, userId,
 * role, permissions, granted, hasPermission(perm) }`. `prisma` vaut le client
 * partagé par défaut ; les services de conversion couramment simulés en test
 * peuvent le remplacer.
 */

import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';

import { prisma as sharedPrisma } from '../../lib/prisma';
import type { ToolCallOutcome, ToolRegistryLike, ToolSchema } from './provider';

// Services portés (aucune logique métier locale).
import * as agendaService from '../agenda/service';
import { VALID_TRANSITIONS } from '../agenda/schemas';
import * as billingService from '../billing/service';
import * as budgetService from '../budget/service';
import * as catalogService from '../catalog/service';
import * as notificationService from '../notifications/service';
import { NOTIFICATION_TYPES } from '../notifications/helpers';
import * as patientTimelineService from '../patient_timeline/service';
import * as patientsService from '../patients/service';
import * as paymentsService from '../payments/service';
import {
  PAYMENT_METHODS,
  catalogName,
  decimalFromUnknown,
} from '../payments/schemas';
import * as recallsService from '../recalls/service';
import { RecallClosedError, RecallReferenceError } from '../../lib/errors';
import {
  CHANNELS as RECALL_CHANNELS,
  OUTCOMES as RECALL_OUTCOMES,
  PRIORITIES as RECALL_PRIORITIES,
  REASONS as RECALL_REASONS,
  RECALL_STATUSES,
  clinicToday,
  normalizeDueMonth,
} from '../recalls/schemas';
import * as reportsService from '../reports/service';
import * as schedulesService from '../schedules/service';
import * as timeLib from '../../lib/time';

import {
  EMPTY_PARAMETERS,
  arrayArg,
  booleanArg,
  dateArgSchema,
  dateTimeArgSchema,
  integerArg,
  nullable,
  numberArg,
  objectSchema,
  stringArg,
  stringMapArg,
  uuidArg,
  type JsonSchema,
} from './tool-schema';

export type ToolCategory = 'read' | 'write' | 'destructive';

// ---------------------------------------------------------------------------
// Contexte
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** Client Prisma (ou transaction) utilisé par le contexte agent. */
  prisma: typeof sharedPrisma;
  clinicId: string;
  /** Fuseau de la clinique (`req.clinic.timezone`). */
  timeZone: string;
  userId: string;
  role: string;
  /** Permissions RBAC accordées (codes effectifs, wildcards compris). */
  permissions: string[];
  /** Alias de `permissions` (vocabulaire Python `AgentContext.permissions`). */
  granted: string[];
  /** Vrai si l'une des permissions accordées couvre `permission`. */
  hasPermission(permission: string): boolean;
}

/** Permissions effectives d'un rôle (`granted_permissions_for`). */
export type GrantedPermissions = string[];

/** `permission_matches` (app/core/auth/permissions.py) — wildcards RBAC. */
export function permissionMatches(required: string, granted: string): boolean {
  if (granted === '*') return true;
  if (granted.endsWith('.*')) return required.startsWith(granted.slice(0, -1));
  return required === granted;
}

/** AND de wildcards, comme `_tool_names_for` / le registre Python. */
export function allows(grants: readonly string[], required: string): boolean {
  return grants.some((granted) => permissionMatches(required, granted));
}

/**
 * Contexte agent minimal, avec les mêmes champs que Python
 * (`clinic_id`, `supervisor_id` → `userId`, `permissions`, `timezone`).
 */
export function createToolContext(input: {
  clinicId: string;
  timeZone: string;
  userId: string;
  role?: string;
  permissions: readonly string[];
  prisma?: typeof sharedPrisma;
}): ToolContext {
  const permissions = [...input.permissions];
  return {
    prisma: input.prisma ?? sharedPrisma,
    clinicId: input.clinicId,
    timeZone: input.timeZone,
    userId: input.userId,
    role: input.role ?? '',
    permissions,
    granted: permissions,
    hasPermission: (permission: string) => allows(permissions, permission),
  };
}

/**
 * Contexte exploitable par les handlers. Le bridge ne fournit que
 * `{ clinicId, timeZone, role, permissions, userId }` ; `prisma`, `granted`
 * et `hasPermission` sont complétés ici.
 */
export type AgentToolContext = Omit<ToolContext, 'prisma' | 'granted' | 'hasPermission'> &
  Partial<Pick<ToolContext, 'prisma' | 'granted' | 'hasPermission'>>;

/** Accepte un `AgentToolContext` complet ou un DTO partiel (tests, appels directs). */
function normalizeContext(raw: unknown): ToolContext | null {
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const permissions = Array.isArray(record.permissions)
    ? record.permissions.filter((value): value is string => typeof value === 'string')
    : [];
  const base = createToolContext({
    clinicId: typeof record.clinicId === 'string' ? record.clinicId : '',
    timeZone:
      typeof record.timeZone === 'string'
        ? record.timeZone
        : typeof record.timezone === 'string'
          ? record.timezone
          : 'UTC',
    userId: typeof record.userId === 'string' ? record.userId : '',
    role: typeof record.role === 'string' ? record.role : '',
    permissions,
    prisma:
      record.prisma && typeof record.prisma === 'object'
        ? (record.prisma as typeof sharedPrisma)
        : sharedPrisma,
  });
  return base;
}

// ---------------------------------------------------------------------------
// Définition d'outil
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

export interface AgentTool {
  /** Nom qualifié (`recalls.list_due_recalls`). */
  name: string;
  description: string;
  input_schema: JsonSchema;
  permissions: string[];
  category: ToolCategory;
  exposes_free_text: boolean;
  handler(ctx: ToolContext, args: Args): Promise<unknown>;
}

function tool(definition: {
  name: string;
  description: string;
  parameters: JsonSchema;
  permissions: string[];
  category: ToolCategory;
  exposes_free_text?: boolean;
  handler(ctx: ToolContext, args: Args): Promise<unknown>;
}): AgentTool {
  return {
    name: definition.name,
    description: definition.description,
    input_schema: definition.parameters,
    permissions: definition.permissions,
    category: definition.category,
    exposes_free_text: definition.exposes_free_text ?? false,
    handler: definition.handler,
  };
}

// ---------------------------------------------------------------------------
// Helpers d'arguments (miroir des contraintes Pydantic)
// ---------------------------------------------------------------------------

function stringArgOrNull(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

function boolArg(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

function intArg(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  return Math.min(Math.max(value, min), max);
}

function numberOrNull(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
    return Number(raw);
  }
  return null;
}

function stringList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const items = raw.filter((value): value is string => typeof value === 'string' && value !== '');
  return items.length > 0 ? items : null;
}

/** `YYYY-MM-DD` → `Date` UTC, comme le parseur `date` de Pydantic. */
export function dateArg(raw: unknown): Date | null {
  const value = stringArgOrNull(raw);
  if (!value) return null;
  const trimmed = value.trim().slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? new Date(`${trimmed}T00:00:00Z`) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

/** `date` requis : lève une erreur de validation lisible sinon. */
function requireDate(raw: unknown, field: string): Date {
  const value = dateArg(raw);
  if (!value) throw new Error(`validation error: ${field}: Input should be a valid date`);
  return value;
}

function requireString(raw: unknown, field: string): string {
  const value = stringArgOrNull(raw);
  if (!value) throw new Error(`validation error: ${field}: field required`);
  return value;
}

function requireNumber(raw: unknown, field: string): number {
  const value = numberOrNull(raw);
  if (value === null) throw new Error(`validation error: ${field}: Input should be a number`);
  return value;
}

function dateString(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function fullName(row: { first_name: string | null; last_name: string | null } | null): string | null {
  return row ? `${row.first_name ?? ''} ${row.last_name ?? ''}` : null;
}

async function clinicTimezoneFor(ctx: ToolContext): Promise<string> {
  return recallsService.clinicTimezone(ctx.clinicId);
}

// ---------------------------------------------------------------------------
// Module recalls (6) — `app/modules/recalls/tools.py`
// ---------------------------------------------------------------------------

interface RecallSummary {
  id: string;
  patient_id: string;
  patient_name: string | null;
  phone: string | null;
  due_month: string;
  reason: string;
  priority: string;
  status: string;
  contact_attempt_count: number;
  last_contact_attempt_at: string | null;
}

type RecallRow = recallsService.RecallRow;
type PatientBrief = { first_name: string; last_name: string; phone: string | null };

function recallSummary(recall: RecallRow, patient: PatientBrief | null): RecallSummary {
  return {
    id: recall.id,
    patient_id: recall.patient_id,
    patient_name: patient ? `${patient.first_name} ${patient.last_name}` : null,
    phone: patient?.phone ?? null,
    due_month: recall.due_month.toISOString().slice(0, 10),
    reason: recall.reason,
    priority: recall.priority,
    status: recall.status,
    contact_attempt_count: recall.contact_attempt_count,
    last_contact_attempt_at: recall.last_contact_attempt_at?.toISOString() ?? null,
  };
}

async function patientBriefFor(ctx: ToolContext, patientId: string): Promise<PatientBrief | null> {
  return ctx.prisma.patients.findFirst({
    where: { id: patientId, clinic_id: ctx.clinicId },
    select: { first_name: true, last_name: true, phone: true },
  });
}

const recallsTools: AgentTool[] = [
  tool({
    name: 'recalls.list_due_recalls',
    description:
      'Listar recalls (rellamadas a pacientes) pendientes: por mes, vencidos, por ' +
      'estado/prioridad o por paciente. Excluye pacientes archivados y con do_not_contact.',
    parameters: objectSchema({
      month: nullable(
        dateArgSchema({ description: 'Cualquier día del mes objetivo (se normaliza a mes).' }),
      ),
      overdue: booleanArg({
        default: false,
        description: 'Solo recalls activos vencidos (mes anterior al actual).',
      }),
      status: nullable(stringArg({ enum: RECALL_STATUSES })),
      priority: nullable(stringArg({ enum: RECALL_PRIORITIES })),
      patient_id: nullable(uuidArg()),
      limit: integerArg({ default: 30, minimum: 1, maximum: 50 }),
    }),
    permissions: ['recalls.read'],
    category: 'read',
    async handler(ctx, args) {
      const limit = intArg(args.limit, 30, 1, 50);
      const month = dateArg(args.month);
      const { rows, total } = await recallsService.listRecalls(
        ctx.clinicId,
        {
          month: month ? normalizeDueMonth(month) : null,
          overdue: boolArg(args.overdue, false),
          status: stringArgOrNull(args.status),
          priority: stringArgOrNull(args.priority),
          patientId: stringArgOrNull(args.patient_id),
        },
        1,
        limit,
      );
      return {
        total,
        recalls: rows.map(({ recall, patient }) => recallSummary(recall, patient)),
      };
    },
  }),
  tool({
    name: 'recalls.get_recall',
    description: 'Detalle de un recall, incluidas notas e intentos de contacto.',
    parameters: objectSchema({ recall_id: uuidArg() }, ['recall_id']),
    permissions: ['recalls.read'],
    category: 'read',
    exposes_free_text: true,
    async handler(ctx, args) {
      const recallId = requireString(args.recall_id, 'recall_id');
      const { recall, attempts } = await recallsService.getWithAttempts(ctx.clinicId, recallId);
      if (!recall) return { error: 'not_found' };
      const patient = await patientBriefFor(ctx, recall.patient_id);
      return {
        ...recallSummary(recall, patient),
        reason_note: recall.reason_note,
        linked_appointment_id: recall.linked_appointment_id,
        attempts: attempts.map((attempt) => ({
          attempted_at: attempt.attempted_at.toISOString(),
          channel: attempt.channel,
          outcome: attempt.outcome,
          note: attempt.note,
        })),
      };
    },
  }),
  tool({
    name: 'recalls.create_recall',
    description:
      'Crear un recall (rellamada futura) para un paciente. Si ya existe uno activo ' +
      'con el mismo motivo, se actualiza ese (created=false). Requiere confirmación del usuario.',
    parameters: objectSchema(
      {
        patient_id: uuidArg(),
        reason: stringArg({ enum: RECALL_REASONS }),
        due_month: dateArgSchema({ description: 'Mes objetivo (cualquier día del mes).' }),
        priority: nullable(stringArg({ enum: RECALL_PRIORITIES })),
        reason_note: nullable(stringArg({ maxLength: 500 })),
        assigned_professional_id: nullable(uuidArg()),
      },
      ['patient_id', 'reason', 'due_month'],
    ),
    permissions: ['recalls.write'],
    category: 'write',
    async handler(ctx, args) {
      const dueMonth = requireDate(args.due_month, 'due_month');
      const { recall, created } = await recallsService.createRecall(
        ctx.clinicId,
        {
          patient_id: requireString(args.patient_id, 'patient_id'),
          reason: requireString(args.reason, 'reason') as (typeof RECALL_REASONS)[number],
          due_month: dueMonth.toISOString().slice(0, 10),
          priority: (stringArgOrNull(args.priority) ??
            'normal') as (typeof RECALL_PRIORITIES)[number],
          reason_note: stringArgOrNull(args.reason_note),
          assigned_professional_id: stringArgOrNull(args.assigned_professional_id),
        },
        ctx.userId || null,
      );
      return {
        id: recall.id,
        created,
        due_month: recall.due_month.toISOString().slice(0, 10),
        status: recall.status,
      };
    },
  }),
  tool({
    name: 'recalls.log_contact_attempt',
    description:
      'Registrar un intento de contacto de un recall (canal + resultado). Con ' +
      'outcome=scheduled enlaza la cita creada. Requiere confirmación del usuario.',
    parameters: objectSchema(
      {
        recall_id: uuidArg(),
        channel: stringArg({ enum: RECALL_CHANNELS }),
        outcome: stringArg({ enum: RECALL_OUTCOMES }),
        note: nullable(stringArg({ maxLength: 500 })),
        linked_appointment_id: nullable(
          uuidArg({ description: 'Cita creada a raíz de la llamada (outcome=scheduled).' }),
        ),
      },
      ['recall_id', 'channel', 'outcome'],
    ),
    permissions: ['recalls.write'],
    category: 'write',
    async handler(ctx, args) {
      try {
        const result = await recallsService.logAttempt(
          ctx.clinicId,
          requireString(args.recall_id, 'recall_id'),
          {
            channel: requireString(args.channel, 'channel') as (typeof RECALL_CHANNELS)[number],
            outcome: requireString(args.outcome, 'outcome') as (typeof RECALL_OUTCOMES)[number],
            note: stringArgOrNull(args.note),
            linked_appointment_id: stringArgOrNull(args.linked_appointment_id),
          },
          ctx.userId,
        );
        if (!result) return { error: 'not_found' };
        return {
          id: result.recall.id,
          status: result.recall.status,
          contact_attempt_count: result.recall.contact_attempt_count,
        };
      } catch (error) {
        if (error instanceof RecallClosedError) return { error: 'recall_closed' };
        if (error instanceof RecallReferenceError) {
          return { error: error.message };
        }
        throw error;
      }
    },
  }),
  tool({
    name: 'recalls.snooze_recall',
    description: 'Posponer un recall N meses. Requiere confirmación del usuario.',
    parameters: objectSchema(
      {
        recall_id: uuidArg(),
        months: integerArg({ minimum: 1, maximum: 24 }),
        reason_note: nullable(stringArg({ maxLength: 500 })),
      },
      ['recall_id', 'months'],
    ),
    permissions: ['recalls.write'],
    category: 'write',
    async handler(ctx, args) {
      const months = intArg(args.months, 0, 1, 24);
      const timeZone = await clinicTimezoneFor(ctx);
      try {
        const recall = await recallsService.snoozeRecall(
          ctx.clinicId,
          requireString(args.recall_id, 'recall_id'),
          timeZone,
          months,
          stringArgOrNull(args.reason_note),
          ctx.userId || null,
        );
        if (!recall) return { error: 'not_found' };
        return {
          id: recall.id,
          due_month: recall.due_month.toISOString().slice(0, 10),
          status: recall.status,
        };
      } catch (error) {
        if (error instanceof RecallClosedError) return { error: 'recall_closed' };
        throw error;
      }
    },
  }),
  tool({
    name: 'recalls.complete_recall',
    description: 'Marcar un recall como completado. Requiere confirmación del usuario.',
    parameters: objectSchema({ recall_id: uuidArg() }, ['recall_id']),
    permissions: ['recalls.write'],
    category: 'write',
    async handler(ctx, args) {
      try {
        const recall = await recallsService.markDone(
          ctx.clinicId,
          requireString(args.recall_id, 'recall_id'),
          ctx.userId || null,
        );
        if (!recall) return { error: 'not_found' };
        return { id: recall.id, status: recall.status };
      } catch (error) {
        if (error instanceof RecallClosedError) return { error: 'recall_closed' };
        throw error;
      }
    },
  }),
];

// ---------------------------------------------------------------------------
// Module budget (3) — `app/modules/budget/tools.py`
// ---------------------------------------------------------------------------

interface BudgetSummary {
  id: string;
  number: string;
  patient_id: string;
  patient_name: string | null;
  status: string;
  total: number;
  valid_until: string | null;
  created_at: string;
}

const budgetTools: AgentTool[] = [
  tool({
    name: 'budget.list_budgets',
    description:
      'Listar presupuestos de la clínica: por estado (draft, sent, accepted, ' +
      'completed, rejected, expired, cancelled), paciente, fechas o vencidos.',
    parameters: objectSchema({
      status: nullable(
        arrayArg({
          items: { type: 'string' },
          description: "Filtrar por estados (p. ej. ['sent'] para pendientes).",
        }),
      ),
      patient_id: nullable(uuidArg()),
      date_from: nullable(dateArgSchema()),
      date_to: nullable(dateArgSchema()),
      expired: nullable(booleanArg()),
      limit: integerArg({ default: 20, minimum: 1, maximum: 50 }),
    }),
    permissions: ['budget.read'],
    category: 'read',
    async handler(ctx, args) {
      const limit = intArg(args.limit, 20, 1, 50);
      // Date seule → colonne `date` (YYYY-MM-DD), comme Pydantic.
      const { rows, total } = await budgetService.BudgetService.listBudgets(
        ctx.prisma as never,
        ctx.clinicId,
        {
          page: 1,
          pageSize: limit,
          patientId: stringArgOrNull(args.patient_id),
          statuses: stringList(args.status),
          dateFrom: dateString(dateArg(args.date_from)),
          dateTo: dateString(dateArg(args.date_to)),
          expired: typeof args.expired === 'boolean' ? args.expired : null,
        },
      );
      return {
        total,
        budgets: rows.map((row): BudgetSummary => ({
          id: row.id,
          number: row.budget_number,
          patient_id: row.patient?.id ?? '',
          patient_name: fullName(row.patient),
          status: row.status,
          total: row.total,
          valid_until: row.valid_until,
          created_at: row.created_at,
        })),
      };
    },
  }),
  tool({
    name: 'budget.get_budget',
    description: 'Detalle de un presupuesto con sus líneas.',
    parameters: objectSchema({ budget_id: uuidArg() }, ['budget_id']),
    permissions: ['budget.read'],
    category: 'read',
    async handler(ctx, args) {
      const budget = await budgetService.BudgetService.getBudgetDetail(
        ctx.prisma as never,
        ctx.clinicId,
        requireString(args.budget_id, 'budget_id'),
      );
      if (!budget) return { error: 'not_found' };
      return {
        id: budget.id,
        number: budget.budget_number,
        patient_id: budget.patient_id,
        patient_name: fullName(budget.patient),
        status: budget.status,
        total: budget.total,
        valid_until: budget.valid_until,
        created_at: budget.created_at,
        items: budget.items.map((item) => ({
          description: item.catalog_item ? catalogName(item.catalog_item.names) : null,
          quantity: item.quantity,
          total: item.line_total,
        })),
      };
    },
  }),
  tool({
    name: 'budget.send_budget',
    description:
      'Enviar un presupuesto al paciente por email o WhatsApp (o marcarlo como ' +
      'entregado en mano). Acción irreversible: requiere confirmación.',
    parameters: objectSchema({
      budget_id: uuidArg(),
      send_method: nullable(
        stringArg({
          enum: ['manual', 'email', 'whatsapp'],
          description:
            "Canal de envío: 'email' o 'whatsapp' (mensaje por la pasarela), 'manual' " +
            'para marcar entregado en mano. Si se omite, se usa send_email.',
        }),
      ),
      send_email: booleanArg({
        default: true,
        description: '(Legado) True: enviar por email al paciente. False: marcar entregado en mano.',
      }),
      custom_message: nullable(stringArg({ maxLength: 500 })),
    }, ['budget_id']),
    permissions: ['budget.write'],
    category: 'destructive',
    async handler(ctx, args) {
      const db = ctx.prisma as never;
      const row = await budgetService.BudgetService.getBudgetRow(
        db,
        ctx.clinicId,
        requireString(args.budget_id, 'budget_id'),
      );
      if (!row) return { error: 'not_found' };
      const budget = await budgetService.loadWorkflowBudget(db, ctx.clinicId, row.id);
      if (!budget) return { error: 'not_found' };

      const sendMethod =
        (stringArgOrNull(args.send_method) as 'manual' | 'email' | 'whatsapp' | null) ??
        (boolArg(args.send_email, true) ? 'email' : 'manual');

      let recipientEmail: string | null = null;
      const patient = row.patients;
      if (sendMethod === 'email') {
        if (!patient || !patient.email) {
          return {
            error: 'no_patient_email',
            detail: 'El paciente no tiene email registrado.',
          };
        }
        recipientEmail = patient.email;
      } else if (sendMethod === 'whatsapp') {
        if (!patient || !patient.phone) {
          return {
            error: 'no_patient_phone',
            detail: 'El paciente no tiene teléfono registrado.',
          };
        }
      }

      // `custom_message` n'a pas de champ dans l'historique Express : seul le
      // canal / destinataire est journalisé (voir `BudgetWorkflowService`).
      void args.custom_message;
      try {
        await budgetService.BudgetWorkflowService.sendBudget(
          db,
          budget,
          ctx.userId,
          { sendMethod, recipientEmail },
        );
      } catch (error) {
        if (error instanceof budgetService.BudgetWorkflowError) {
          return { error: 'workflow_error', detail: error.message, status: row.status };
        }
        throw error;
      }
      return {
        id: row.id,
        status: 'sent',
        send_method: sendMethod,
        recipient_email: recipientEmail,
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// Module agenda (8) — `app/modules/agenda/tools.py`
// ---------------------------------------------------------------------------

type AppointmentRow = NonNullable<Awaited<ReturnType<typeof agendaService.getAppointment>>>;

function appointmentSummary(ctx: ToolContext, appt: AppointmentRow): Record<string, unknown> {
  return {
    id: appt.id,
    patient_id: appt.patient_id,
    patient_name: fullName(appt.patients),
    professional_id: appt.professional_id,
    start_time: timeLib.toZonedIso(appt.start_time, ctx.timeZone),
    end_time: timeLib.toZonedIso(appt.end_time, ctx.timeZone),
    status: appt.status,
    cabinet: appt.cabinet,
  };
}

const agendaTools: AgentTool[] = [
  tool({
    name: 'agenda.get_day_overview',
    description: 'Listar las citas de la clínica para un día concreto.',
    parameters: objectSchema(
      { date: dateArgSchema({ description: 'Día a consultar (YYYY-MM-DD).' }) },
      ['date'],
    ),
    permissions: ['agenda.appointments.read'],
    category: 'read',
    async handler(ctx, args) {
      const day = dateArg(args.date);
      const dayString = dateString(day);
      if (!dayString) throw new Error('validation error: date: Input should be a valid date');
      // Bornes « mur d'horloge » de la clinique (`datetime.combine(..., min/max)`).
      const { rows, total } = await agendaService.listAppointments(ctx.clinicId, ctx.timeZone, {
        startDate: `${dayString}T00:00:00`,
        endDate: `${dayString}T23:59:59.999`,
        page: 1,
        pageSize: 200,
        order: 'asc',
      });
      return {
        date: dayString,
        total,
        appointments: rows.map((row) => ({
          id: row.id,
          patient_id: row.patient_id,
          patient_name: row.patient ? `${row.patient.first_name} ${row.patient.last_name}` : null,
          professional_id: row.professional_id,
          start_time: row.start_time,
          end_time: row.end_time,
          status: row.status,
          cabinet: row.cabinet,
        })),
      };
    },
  }),
  tool({
    name: 'agenda.get_appointment',
    description: 'Obtener los datos de una cita por su id.',
    parameters: objectSchema({ appointment_id: uuidArg() }, ['appointment_id']),
    permissions: ['agenda.appointments.read'],
    category: 'read',
    async handler(ctx, args) {
      const appt = await agendaService.getAppointment(
        ctx.clinicId,
        requireString(args.appointment_id, 'appointment_id'),
      );
      return appt ? appointmentSummary(ctx, appt) : { error: 'not_found' };
    },
  }),
  tool({
    name: 'agenda.list_cabinets',
    description: 'Listar los gabinetes/sillones de la clínica.',
    parameters: EMPTY_PARAMETERS,
    permissions: ['agenda.cabinets.read'],
    category: 'read',
    async handler(ctx) {
      const cabinets = await agendaService.listCabinets(ctx.clinicId);
      return {
        cabinets: cabinets.map((cabinet) => ({
          id: cabinet.id,
          name: cabinet.name,
          is_active: cabinet.is_active,
        })),
      };
    },
  }),
  tool({
    name: 'agenda.list_professionals',
    description: 'Listar los profesionales (dentistas/higienistas) de la clínica con su id.',
    parameters: EMPTY_PARAMETERS,
    permissions: ['agenda.appointments.read'],
    category: 'read',
    async handler(ctx) {
      const memberships = await ctx.prisma.clinic_memberships.findMany({
        where: {
          clinic_id: ctx.clinicId,
          is_professional: true,
          users: { is_active: true },
        },
        select: { user_id: true, users: { select: { first_name: true, last_name: true } } },
        orderBy: [{ users: { last_name: 'asc' } }, { user_id: 'asc' }],
      });
      return {
        professionals: memberships.map((row) => ({
          id: row.user_id,
          professional_name: `${row.users.first_name} ${row.users.last_name}`,
        })),
      };
    },
  }),
  tool({
    name: 'agenda.book_appointment',
    description: 'Reservar una cita. Requiere confirmación del usuario.',
    parameters: objectSchema(
      {
        patient_id: uuidArg(),
        professional_id: uuidArg(),
        start_time: dateTimeArgSchema(),
        end_time: dateTimeArgSchema(),
        cabinet: nullable(stringArg({ maxLength: 50 })),
      },
      ['patient_id', 'professional_id', 'start_time', 'end_time'],
    ),
    permissions: ['agenda.appointments.write'],
    category: 'write',
    async handler(ctx, args) {
      try {
        const appt = await agendaService.createAppointment(
          ctx.clinicId,
          ctx.userId,
          ctx.timeZone,
          {
            patientId: requireString(args.patient_id, 'patient_id'),
            professionalId: requireString(args.professional_id, 'professional_id'),
            cabinet: stringArgOrNull(args.cabinet),
            startTime: requireString(args.start_time, 'start_time'),
            endTime: requireString(args.end_time, 'end_time'),
          },
        );
        return {
          id: appt.id,
          start_time: timeLib.toZonedIso(appt.start_time, ctx.timeZone),
          status: appt.status,
        };
      } catch (error) {
        if (isSlotConflict(error)) return SLOT_CONFLICT;
        throw error;
      }
    },
  }),
  tool({
    name: 'agenda.reschedule_appointment',
    description:
      'Mover una cita existente a otra fecha/hora (y opcionalmente otro profesional ' +
      'o gabinete). Requiere confirmación del usuario.',
    parameters: objectSchema(
      {
        appointment_id: uuidArg(),
        start_time: dateTimeArgSchema(),
        end_time: dateTimeArgSchema(),
        professional_id: nullable(uuidArg()),
        cabinet: nullable(stringArg({ maxLength: 50 })),
      },
      ['appointment_id', 'start_time', 'end_time'],
    ),
    permissions: ['agenda.appointments.write'],
    category: 'write',
    async handler(ctx, args) {
      const appt = await agendaService.getAppointment(
        ctx.clinicId,
        requireString(args.appointment_id, 'appointment_id'),
      );
      if (!appt) return { error: 'not_found' };
      const professionalId = stringArgOrNull(args.professional_id);
      const cabinet = stringArgOrNull(args.cabinet);
      try {
        const updated = await agendaService.updateAppointment(appt, ctx.timeZone, ctx.userId, {
          professionalId,
          cabinet,
          cabinetTouched: cabinet !== null,
          startTime: requireString(args.start_time, 'start_time'),
          endTime: requireString(args.end_time, 'end_time'),
        });
        return appointmentSummary(ctx, updated);
      } catch (error) {
        if (isSlotConflict(error)) return SLOT_CONFLICT;
        throw error;
      }
    },
  }),
  tool({
    name: 'agenda.update_appointment_status',
    description:
      'Cambiar el estado de una cita (confirmed, checked_in, in_treatment, completed, ' +
      'no_show). Para cancelar usa cancel_appointment. Requiere confirmación del usuario.',
    parameters: objectSchema(
      {
        appointment_id: uuidArg(),
        to_status: stringArg({
          enum: ['confirmed', 'checked_in', 'in_treatment', 'completed', 'no_show'],
          description: 'Nuevo estado. Para cancelar usa cancel_appointment.',
        }),
        note: nullable(stringArg({ maxLength: 500 })),
      },
      ['appointment_id', 'to_status'],
    ),
    permissions: ['agenda.appointments.write'],
    category: 'write',
    async handler(ctx, args) {
      const appt = await agendaService.getAppointment(
        ctx.clinicId,
        requireString(args.appointment_id, 'appointment_id'),
      );
      if (!appt) return { error: 'not_found' };
      const toStatus = requireString(args.to_status, 'to_status');
      const refusal = agendaRefusal(appt.status, toStatus, Boolean(appt.cabinet_id));
      if (refusal === 'already_in_state') return { error: 'already_in_state', status: appt.status };
      if (refusal === 'invalid_transition') {
        return {
          error: 'invalid_transition',
          status: appt.status,
          allowed: [...(VALID_TRANSITIONS[appt.status] ?? [])].sort(),
        };
      }
      if (refusal === 'cabinet_required') {
        return {
          error: 'cabinet_required',
          detail: "Asigna un gabinete antes de pasar la cita a 'in_treatment'.",
        };
      }
      const updated = await agendaService.transitionAppointment(
        appt,
        toStatus,
        ctx.userId,
        stringArgOrNull(args.note),
      );
      return { id: updated.id, status: updated.status };
    },
  }),
  tool({
    name: 'agenda.cancel_appointment',
    description: 'Cancelar una cita existente. Acción destructiva: requiere confirmación.',
    parameters: objectSchema({ appointment_id: uuidArg() }, ['appointment_id']),
    permissions: ['agenda.appointments.write'],
    category: 'destructive',
    async handler(ctx, args) {
      const appt = await agendaService.getAppointment(
        ctx.clinicId,
        requireString(args.appointment_id, 'appointment_id'),
      );
      if (!appt) return { error: 'not_found' };
      if (!(VALID_TRANSITIONS[appt.status] ?? []).includes('cancelled')) {
        return {
          error: 'not_cancellable',
          detail: `Una cita en estado '${appt.status}' no se puede cancelar.`,
        };
      }
      await agendaService.cancelAppointment(appt, ctx.userId);
      return { id: appt.id, status: 'cancelled' };
    },
  }),
];

/** `AlreadyInStateError` / `InvalidTransitionError` / `CabinetRequiredError`. */
function agendaRefusal(
  fromStatus: string,
  toStatus: string,
  hasCabinet: boolean,
): 'already_in_state' | 'invalid_transition' | 'cabinet_required' | null {
  if (fromStatus === toStatus) return 'already_in_state';
  if (!(VALID_TRANSITIONS[fromStatus] ?? []).includes(toStatus)) return 'invalid_transition';
  if (toStatus === 'in_treatment' && !hasCabinet) return 'cabinet_required';
  return null;
}

/** Résultat Python `{"error": "slot_conflict", ...}` pour une `IntegrityError`. */
const SLOT_CONFLICT = {
  error: 'slot_conflict',
  detail: 'El hueco solicitado no está disponible.',
} as const;

/** Créneau déjà pris : violation d'unicité ou refus explicite du service. */
function isSlotConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return true;
  return error instanceof Error && /Time slot is already occupied/.test(error.message);
}

// ---------------------------------------------------------------------------
// Module billing (2, lecture seule) — `app/modules/billing/tools.py`
// ---------------------------------------------------------------------------

const billingTools: AgentTool[] = [
  tool({
    name: 'billing.list_invoices',
    description:
      'Listar facturas de la clínica: por paciente, estado (draft, issued, partial, ' +
      'paid, cancelled, voided), fechas, vencidas o rectificativas. Solo lectura.',
    parameters: objectSchema({
      patient_id: nullable(uuidArg()),
      status: nullable(arrayArg({ items: { type: 'string' } })),
      date_from: nullable(dateArgSchema()),
      date_to: nullable(dateArgSchema()),
      overdue: nullable(
        booleanArg({
          description: 'Solo facturas emitidas/parciales con vencimiento pasado.',
        }),
      ),
      is_credit_note: nullable(booleanArg()),
      limit: integerArg({ default: 20, minimum: 1, maximum: 50 }),
    }),
    permissions: ['billing.read'],
    category: 'read',
    async handler(ctx, args) {
      const limit = intArg(args.limit, 20, 1, 50);
      const { rows, total } = await billingService.listInvoices(ctx.prisma, ctx.clinicId, ctx.timeZone, {
        page: 1,
        pageSize: limit,
        patientId: stringArgOrNull(args.patient_id),
        status: stringList(args.status),
        dateFrom: dateString(dateArg(args.date_from)),
        dateTo: dateString(dateArg(args.date_to)),
        overdue: typeof args.overdue === 'boolean' ? args.overdue : null,
        isCreditNote: typeof args.is_credit_note === 'boolean' ? args.is_credit_note : null,
      });
      return {
        total,
        invoices: rows.map((row) => ({
          id: row.id,
          number: row.invoice_number,
          patient_id: row.patients?.id ?? '',
          patient_name: fullName(row.patients),
          status: row.status,
          issue_date: row.issue_date,
          due_date: row.due_date,
          total: row.total,
        })),
      };
    },
  }),
  tool({
    name: 'billing.get_invoice',
    description: 'Detalle de una factura con sus líneas. Solo lectura.',
    parameters: objectSchema({ invoice_id: uuidArg() }, ['invoice_id']),
    permissions: ['billing.read'],
    category: 'read',
    async handler(ctx, args) {
      // `include_payments=False` : jamais les deux axes côte à côte (off-books).
      const invoice = await billingService.getInvoice(
        ctx.prisma,
        ctx.clinicId,
        requireString(args.invoice_id, 'invoice_id'),
        'detail',
      );
      if (!invoice) return { error: 'not_found' };
      return {
        id: invoice.id,
        number: invoice.invoice_number,
        patient_id: invoice.patients?.id ?? invoice.patient_id,
        patient_name: fullName(invoice.patients),
        status: invoice.status,
        issue_date: dateString(invoice.issue_date),
        due_date: dateString(invoice.due_date),
        total: billingService.toInvoiceDetail(invoice).total,
        items: invoice.invoice_items.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          total: billingService.toItemDto(item).line_total,
        })),
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// Module catalog (2) — `app/modules/catalog/tools.py`
// ---------------------------------------------------------------------------

type CatalogItem = catalogService.CatalogItemDto;

function catalogSummary(item: CatalogItem): Record<string, unknown> {
  return {
    id: item.id,
    internal_code: item.internal_code,
    name: catalogName(item.names),
    category: item.category ? catalogName(item.category.names) : null,
    default_price: item.default_price,
    default_duration_minutes: item.default_duration_minutes,
    pricing_strategy: item.pricing_strategy,
    treatment_scope: item.treatment_scope,
    requires_appointment: item.requires_appointment,
    is_active: item.is_active,
  };
}

const catalogTools: AgentTool[] = [
  tool({
    name: 'catalog.list_catalog_items',
    description:
      'Listar el catálogo de tratamientos de la clínica con su nombre, código, ' +
      'categoría, precio y duración. Filtra por texto o categoría.',
    parameters: objectSchema({
      search: nullable(
        stringArg({
          description: 'Fragmento de nombre o código interno a buscar (opcional).',
        }),
      ),
      category_id: nullable(
        uuidArg({ description: 'Filtrar por categoría (opcional).' }),
      ),
      page: integerArg({ default: 1, minimum: 1 }),
      page_size: integerArg({ default: 20, minimum: 1, maximum: 50 }),
    }),
    permissions: ['catalog.read'],
    category: 'read',
    async handler(ctx, args) {
      const { rows, total } = await catalogService.listItems(ctx.clinicId, {
        page: Math.max(intArg(args.page, 1, 1, Number.MAX_SAFE_INTEGER), 1),
        pageSize: intArg(args.page_size, 20, 1, 50),
        categoryId: stringArgOrNull(args.category_id),
        search: stringArgOrNull(args.search),
      });
      return { total, items: rows.map((row) => catalogSummary(catalogService.toCatalogItemDto(row))) };
    },
  }),
  tool({
    name: 'catalog.get_catalog_item',
    description: 'Obtener el detalle de un tratamiento del catálogo por su id.',
    parameters: objectSchema({ item_id: uuidArg() }, ['item_id']),
    permissions: ['catalog.read'],
    category: 'read',
    async handler(ctx, args) {
      const row = await catalogService.getItem(ctx.clinicId, requireString(args.item_id, 'item_id'));
      if (!row) return { error: 'not_found' };
      const item = catalogService.toCatalogItemDto(row);
      return {
        ...catalogSummary(item),
        description: catalogName(item.descriptions),
        cost_price: item.cost_price,
        billing_mode: null,
        requires_surfaces: item.requires_surfaces,
        is_diagnostic: item.is_diagnostic,
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// Module patients (4) — `app/modules/patients/tools.py`
// ---------------------------------------------------------------------------

interface PatientSummary {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  status: string;
}

function patientSummary(patient: {
  id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  status: string;
}): PatientSummary {
  return {
    id: patient.id,
    full_name: `${patient.first_name} ${patient.last_name}`,
    phone: patient.phone,
    email: patient.email,
    status: patient.status,
  };
}

const patientsTools: AgentTool[] = [
  tool({
    name: 'patients.search_patients',
    description:
      'Buscar pacientes de la clínica por nombre (completo o parcial), teléfono, ' +
      'email o DNI/NIE. Pasa el nombre y apellido juntos en una sola consulta.',
    parameters: objectSchema(
      {
        query: stringArg({
          description:
            "Search text: full name, partial name, phone, email or national ID. Multiple " +
            "words are matched independently against the patient's name fields, so " +
            "'Juan Pérez' (or reversed 'Pérez Juan') finds the patient — pass the whole " +
            "name as one query, don't split it into separate searches.",
        }),
        limit: integerArg({ default: 20, minimum: 1, maximum: 50 }),
      },
      ['query'],
    ),
    permissions: ['patients.read'],
    category: 'read',
    async handler(ctx, args) {
      const { rows, total } = await patientsService.listPatients(ctx.clinicId, {
        search: requireString(args.query, 'query'),
        page: 1,
        pageSize: intArg(args.limit, 20, 1, 50),
        includeArchived: false,
        statuses: [],
      });
      return { total, patients: rows.map(patientSummary) };
    },
  }),
  tool({
    name: 'patients.get_patient',
    description: 'Obtener los datos de un paciente por su id.',
    parameters: objectSchema({ patient_id: uuidArg() }, ['patient_id']),
    permissions: ['patients.read'],
    category: 'read',
    async handler(ctx, args) {
      const patient = await patientsService.getPatient(
        ctx.clinicId,
        requireString(args.patient_id, 'patient_id'),
      );
      if (!patient) return { error: 'not_found' };
      return {
        ...patientSummary(patient),
        date_of_birth: dateString(patient.date_of_birth),
        do_not_contact: patient.do_not_contact,
      };
    },
  }),
  tool({
    name: 'patients.create_patient',
    description: 'Crear un paciente nuevo. Requiere confirmación del usuario.',
    parameters: objectSchema(
      {
        first_name: stringArg({ minLength: 1, maxLength: 100 }),
        last_name: stringArg({ minLength: 1, maxLength: 100 }),
        phone: nullable(stringArg({ maxLength: 20 })),
        email: nullable(stringArg({ maxLength: 255 })),
      },
      ['first_name', 'last_name'],
    ),
    permissions: ['patients.write'],
    category: 'write',
    async handler(ctx, args) {
      const patient = await patientsService.createPatient(ctx.clinicId, {
        first_name: requireString(args.first_name, 'first_name'),
        last_name: requireString(args.last_name, 'last_name'),
        phone: stringArgOrNull(args.phone),
        email: stringArgOrNull(args.email),
        do_not_contact: false,
      });
      return { id: patient.id, full_name: `${patient.first_name} ${patient.last_name}` };
    },
  }),
  tool({
    name: 'patients.update_patient',
    description:
      'Actualizar los datos de contacto (teléfono, email) de un paciente existente. ' +
      'Requiere confirmación del usuario.',
    parameters: objectSchema(
      {
        patient_id: uuidArg(),
        phone: nullable(stringArg({ maxLength: 20 })),
        email: nullable(stringArg({ maxLength: 255 })),
      },
      ['patient_id'],
    ),
    permissions: ['patients.write'],
    category: 'write',
    async handler(ctx, args) {
      const patient = await patientsService.getPatient(
        ctx.clinicId,
        requireString(args.patient_id, 'patient_id'),
      );
      if (!patient) return { error: 'not_found' };
      const patch: { phone?: string; email?: string } = {};
      const phone = stringArgOrNull(args.phone);
      const email = stringArgOrNull(args.email);
      if (phone !== null) patch.phone = phone;
      if (email !== null) patch.email = email;
      if (Object.keys(patch).length === 0) return { error: 'nothing_to_update' };
      const updated = await patientsService.updatePatient(patient, patch);
      return patientSummary(updated);
    },
  }),
];

// ---------------------------------------------------------------------------
// Module payments (4) — `app/modules/payments/tools.py`
// ---------------------------------------------------------------------------

async function clinicCurrency(ctx: ToolContext): Promise<string> {
  const clinic = await ctx.prisma.clinics.findUnique({
    where: { id: ctx.clinicId },
    select: { currency: true },
  });
  return clinic?.currency || 'EUR';
}

function periodArgs(args: Args): { dateFrom: string; dateTo: string } {
  return {
    dateFrom: requireDate(args.date_from, 'date_from').toISOString().slice(0, 10),
    dateTo: requireDate(args.date_to, 'date_to').toISOString().slice(0, 10),
  };
}

const paymentsTools: AgentTool[] = [
  tool({
    name: 'payments.payments_summary',
    description:
      'Resumen de cobros de un periodo: cobrado, devuelto y neto. Solo eje cobro ' +
      '(no incluye facturación ni saldo pendiente).',
    parameters: objectSchema(
      {
        date_from: dateArgSchema({ description: 'Inicio del periodo (YYYY-MM-DD).' }),
        date_to: dateArgSchema({ description: 'Fin del periodo (YYYY-MM-DD).' }),
      },
      ['date_from', 'date_to'],
    ),
    permissions: ['payments.reports.read'],
    category: 'read',
    async handler(ctx, args) {
      const { dateFrom, dateTo } = periodArgs(args);
      const summary = await paymentsService.reportsSummary(
        ctx.clinicId,
        await clinicCurrency(ctx),
        dateFrom,
        dateTo,
      );
      // Axe cobro uniquement : pas de patient_credit / clinic_receivable.
      return {
        date_from: dateFrom,
        date_to: dateTo,
        currency: summary.currency,
        total_collected: summary.total_collected,
        total_refunded: summary.total_refunded,
        net_collected: summary.net_collected,
        payment_count: summary.payment_count,
        refund_count: summary.refund_count,
      };
    },
  }),
  tool({
    name: 'payments.collections_by_method',
    description: 'Desglose de lo cobrado por método de pago en un periodo (eje cobro).',
    parameters: objectSchema(
      {
        date_from: dateArgSchema({ description: 'Inicio del periodo (YYYY-MM-DD).' }),
        date_to: dateArgSchema({ description: 'Fin del periodo (YYYY-MM-DD).' }),
      },
      ['date_from', 'date_to'],
    ),
    permissions: ['payments.reports.read'],
    category: 'read',
    async handler(ctx, args) {
      const { dateFrom, dateTo } = periodArgs(args);
      const rows = await paymentsService.reportsByMethod(ctx.clinicId, dateFrom, dateTo);
      return {
        methods: rows.map((row) => ({
          method: row.method,
          total: row.total,
          count: row.count,
        })),
      };
    },
  }),
  tool({
    name: 'payments.record_payment',
    description:
      'Registrar un cobro de un paciente con su reparto (presupuesto/s o a cuenta). ' +
      'La suma de allocations debe igualar el importe. Requiere confirmación del usuario.',
    parameters: objectSchema(
      {
        patient_id: uuidArg(),
        amount: numberArg({ exclusiveMinimum: 0 }),
        method: stringArg({ enum: PAYMENT_METHODS }),
        payment_date: dateArgSchema(),
        allocations: arrayArg({
          minItems: 1,
          items: objectSchema(
            {
              target_type: stringArg({ enum: ['budget', 'on_account'] }),
              target_id: nullable(
                uuidArg({
                  description: 'Id del presupuesto (solo target_type=budget).',
                }),
              ),
              amount: numberArg({ exclusiveMinimum: 0 }),
            },
            ['target_type', 'amount'],
          ),
          description: 'Reparto del cobro; la suma debe igualar amount.',
        }),
        reference: nullable(stringArg({ maxLength: 100 })),
        notes: nullable(stringArg({ maxLength: 500 })),
        idempotency_key: nullable(
          stringArg({
            maxLength: 100,
            description:
              'Clave de idempotencia: repetir la llamada con la misma clave devuelve el ' +
              'cobro ya registrado.',
          }),
        ),
      },
      ['patient_id', 'amount', 'method', 'payment_date', 'allocations'],
    ),
    permissions: ['payments.record.write'],
    category: 'write',
    async handler(ctx, args) {
      const amount = decimalFromUnknown(requireNumber(args.amount, 'amount'));
      if (!amount) throw new Error('validation error: amount: Input should be a number');
      const rawAllocations = Array.isArray(args.allocations) ? args.allocations : [];
      if (rawAllocations.length === 0) {
        throw new Error('validation error: allocations: List should have at least 1 item');
      }
      const allocations = rawAllocations.map((raw, index) => {
        const item = (raw ?? {}) as Record<string, unknown>;
        const allocationAmount = decimalFromUnknown(requireNumber(item.amount, `allocations.${index}.amount`));
        if (!allocationAmount) {
          throw new Error(`validation error: allocations.${index}.amount: Input should be a number`);
        }
        return {
          target_type: requireString(item.target_type, `allocations.${index}.target_type`) as
            | 'budget'
            | 'on_account',
          target_id: stringArgOrNull(item.target_id),
          amount: allocationAmount,
        };
      });

      try {
        const payment = await paymentsService.recordPayment({
          clinicId: ctx.clinicId,
          currency: await clinicCurrency(ctx),
          patientId: requireString(args.patient_id, 'patient_id'),
          amount,
          method: requireString(args.method, 'method'),
          paymentDate: requireDate(args.payment_date, 'payment_date').toISOString().slice(0, 10),
          recordedBy: ctx.userId,
          allocations,
          reference: stringArgOrNull(args.reference),
          notes: stringArgOrNull(args.notes),
          idempotencyKey: stringArgOrNull(args.idempotency_key),
        });
        return {
          id: payment.id,
          amount: Number(payment.amount.toString()),
          currency: payment.currency,
          method: payment.method,
          payment_date: dateString(payment.payment_date),
        };
      } catch (error) {
        if (error instanceof paymentsService.PaymentWorkflowError) {
          return { error: 'workflow_error', detail: error.message };
        }
        throw error;
      }
    },
  }),
  tool({
    name: 'payments.patient_payment_history',
    description:
      'Historial de cobros y devoluciones de un paciente (eje cobro: total pagado, ' +
      'saldo a cuenta y últimos movimientos). No incluye facturación ni saldo pendiente.',
    parameters: objectSchema(
      {
        patient_id: uuidArg(),
        limit: integerArg({
          default: 20,
          minimum: 1,
          maximum: 50,
          description: 'Últimos N movimientos.',
        }),
      },
      ['patient_id'],
    ),
    permissions: ['payments.record.read'],
    category: 'read',
    async handler(ctx, args) {
      const limit = intArg(args.limit, 20, 1, 50);
      const ledger = await paymentsService.getPatientLedger(
        ctx.clinicId,
        requireString(args.patient_id, 'patient_id'),
        await clinicCurrency(ctx),
      );
      // Axe cobro : paiements + remboursements uniquement.
      const movements = ledger.timeline
        .filter((entry) => entry.entry_type === 'payment' || entry.entry_type === 'refund')
        .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0));
      return {
        patient_id: ledger.patient_id,
        currency: ledger.currency,
        total_paid: ledger.total_paid,
        on_account_balance: ledger.on_account_balance,
        movements: movements.slice(0, limit).map((entry) => ({
          entry_type: entry.entry_type,
          occurred_at: entry.occurred_at,
          amount: entry.amount,
          method_or_reason: entry.description,
        })),
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// Module reports (6, lecture seule) — `app/modules/reports/tools.py`
// ---------------------------------------------------------------------------

function reportPeriod(args: Args): { from: Date; to: Date } {
  return {
    from: requireDate(args.date_from, 'date_from'),
    to: requireDate(args.date_to, 'date_to'),
  };
}

const PERIOD_PARAMETERS = objectSchema(
  {
    date_from: dateArgSchema({ description: 'Inicio del periodo (YYYY-MM-DD).' }),
    date_to: dateArgSchema({ description: 'Fin del periodo (YYYY-MM-DD).' }),
  },
  ['date_from', 'date_to'],
);

const reportsTools: AgentTool[] = [
  tool({
    name: 'reports.billing_report',
    description:
      'Resumen de facturación de un periodo: total facturado y nº de facturas. Solo ' +
      'eje factura (no incluye cobros ni pendiente).',
    parameters: PERIOD_PARAMETERS,
    permissions: ['reports.billing.read'],
    category: 'read',
    async handler(ctx, args) {
      const { from, to } = reportPeriod(args);
      const summary = await reportsService.BillingReportService.getSummary(
        ctx.clinicId,
        ctx.timeZone,
        from,
        to,
      );
      // Axe facture seul : jamais settled / pending / overdue.
      return {
        date_from: dateString(from),
        date_to: dateString(to),
        total_invoiced: summary.total_invoiced ?? 0,
        invoice_count: summary.invoice_count ?? 0,
      };
    },
  }),
  tool({
    name: 'reports.top_clients_by_billing',
    description: 'Ranking de pacientes por importe facturado en un año (eje factura).',
    parameters: objectSchema(
      {
        year: integerArg({ minimum: 2000, maximum: 2100 }),
        limit: integerArg({ default: 10, minimum: 1, maximum: 50 }),
      },
      ['year'],
    ),
    permissions: ['reports.billing.read'],
    category: 'read',
    async handler(ctx, args) {
      const year = intArg(args.year, 0, 2000, 2100);
      const limit = intArg(args.limit, 10, 1, 50);
      // Somme « émise » des factures (jamais les paiements) — axe facture.
      const rows = await ctx.prisma.invoices.groupBy({
        by: ['patient_id'],
        where: {
          clinic_id: ctx.clinicId,
          status: { notIn: ['draft', 'voided'] },
          issue_date: {
            gte: new Date(`${year}-01-01T00:00:00.000Z`),
            lte: new Date(`${year}-12-31T00:00:00.000Z`),
          },
          deleted_at: null,
        },
        _sum: { total: true },
        _count: { id: true },
        orderBy: { _sum: { total: 'desc' } },
        take: limit,
      });
      const patientIds = rows.map((row) => row.patient_id);
      const patients = patientIds.length
        ? await ctx.prisma.patients.findMany({
            where: { id: { in: patientIds } },
            select: { id: true, first_name: true, last_name: true },
          })
        : [];
      const byId = new Map(patients.map((patient) => [patient.id, patient]));
      return {
        year,
        clients: rows.map((row) => {
          const patient = byId.get(row.patient_id);
          return {
            patient_id: row.patient_id,
            patient_name: patient ? `${patient.first_name} ${patient.last_name}` : null,
            total_invoiced: Number((row._sum.total ?? new Prisma.Decimal(0)).toString()),
            invoice_count: row._count.id,
          };
        }),
      };
    },
  }),
  tool({
    name: 'reports.scheduling_report',
    description:
      'Resumen de actividad de agenda de un periodo (citas, completadas, canceladas).',
    parameters: PERIOD_PARAMETERS,
    permissions: ['reports.scheduling.read'],
    category: 'read',
    async handler(ctx, args) {
      const { from, to } = reportPeriod(args);
      return reportsService.SchedulingReportService.getSummary(ctx.clinicId, ctx.timeZone, from, to);
    },
  }),
  tool({
    name: 'reports.financial_report',
    description:
      'Antigüedad de facturas pendientes por tramos y emitido mensual de un periodo. ' +
      'Solo eje factura (importes emitidos, nunca cobros ni diferencias).',
    parameters: PERIOD_PARAMETERS,
    permissions: ['reports.financial.read'],
    category: 'read',
    async handler(ctx, args) {
      const { from, to } = reportPeriod(args);
      const buckets = await reportsService.FinancialReportService.agingBuckets(
        ctx.clinicId,
        ctx.timeZone,
      );
      const trend = await reportsService.FinancialReportService.issuedTrend(ctx.clinicId, from, to);
      return {
        date_from: dateString(from),
        date_to: dateString(to),
        aging: buckets.map((bucket) => ({
          bucket: bucket.label,
          total: bucket.total,
          invoices: bucket.count,
        })),
        issued_trend: trend.map((point) => ({
          month: point.month,
          total: point.total,
          invoices: point.count,
        })),
      };
    },
  }),
  tool({
    name: 'reports.patient_stats_report',
    description: 'Demografía de pacientes y frecuencia de visitas de un periodo.',
    parameters: PERIOD_PARAMETERS,
    permissions: ['reports.patient_stats.read'],
    category: 'read',
    async handler(ctx, args) {
      const { from, to } = reportPeriod(args);
      const demo = await reportsService.PatientStatsService.demographics(ctx.clinicId, ctx.timeZone);
      const visits = await reportsService.PatientStatsService.visitFrequency(
        ctx.clinicId,
        ctx.timeZone,
        from,
        to,
      );
      return {
        total_patients: demo.total_patients,
        age_bands: demo.age_bands,
        visits,
      };
    },
  }),
  tool({
    name: 'reports.operational_report',
    description: 'Productividad: completadas por profesional y gabinete en un periodo.',
    parameters: PERIOD_PARAMETERS,
    permissions: ['reports.operational.read'],
    category: 'read',
    async handler(ctx, args) {
      const { from, to } = reportPeriod(args);
      const data = await reportsService.OperationalReportService.productivity(
        ctx.clinicId,
        ctx.timeZone,
        from,
        to,
      );
      return {
        date_from: dateString(from),
        date_to: dateString(to),
        completed_total: data.completed_total,
        by_professional: data.by_professional.map((row) => ({
          name: row.professional_name,
          completed: row.completed,
        })),
        by_cabinet: data.by_cabinet,
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// Module schedules (2) — `app/modules/schedules/tools.py`
// ---------------------------------------------------------------------------

/** Statuts qui bloquent un créneau (`_BLOCKING_STATUSES`). */
const BLOCKING_STATUSES = ['scheduled', 'confirmed', 'checked_in', 'in_treatment', 'completed'];

function subtractIntervals(
  start: number,
  end: number,
  busy: readonly { start: number; end: number }[],
): Array<{ start: number; end: number }> {
  let free = [{ start, end }];
  for (const block of busy) {
    const next: Array<{ start: number; end: number }> = [];
    for (const window of free) {
      if (block.end <= window.start || block.start >= window.end) {
        next.push(window);
        continue;
      }
      if (block.start > window.start) next.push({ start: window.start, end: block.start });
      if (block.end < window.end) next.push({ start: block.end, end: window.end });
    }
    free = next;
  }
  return free;
}

/** Chevauchement avec la demi-journée demandée (frontière à 14 h locales). */
function overlapsPart(start: Date, end: Date, part: string, timeZone: string): boolean {
  if (part === 'morning') {
    return Number(timeLib.toZonedIso(start, timeZone).slice(11, 13)) < 14;
  }
  if (part === 'afternoon') {
    const noon = schedulesService.zonedInstant(
      timeLib.toZonedIso(start, timeZone).slice(0, 10),
      14 * 60,
      timeZone,
    );
    return end > noon;
  }
  return true;
}

const schedulesTools: AgentTool[] = [
  tool({
    name: 'schedules.get_availability',
    description:
      'Ventanas de horario abierto de la clínica (o de un profesional) para un día. ' +
      'No descuenta citas reservadas; usa find_free_slots para huecos reales.',
    parameters: objectSchema(
      {
        date: dateArgSchema({ description: 'Día a consultar (YYYY-MM-DD).' }),
        professional_id: nullable(
          uuidArg({ description: 'Opcional: restringe a un profesional.' }),
        ),
      },
      ['date'],
    ),
    permissions: ['schedules.availability.read'],
    category: 'read',
    async handler(ctx, args) {
      const day = requireDate(args.date, 'date').toISOString().slice(0, 10);
      const clinic = await ctx.prisma.clinics.findUnique({
        where: { id: ctx.clinicId },
        select: { timezone: true },
      });
      const { timeZone, ranges } = await schedulesService.resolveAvailability(
        ctx.clinicId,
        clinic?.timezone ?? ctx.timeZone,
        day,
        day,
        stringArgOrNull(args.professional_id),
      );
      return {
        date: day,
        timezone: timeZone,
        open_windows: ranges
          .filter((range) => range.state === 'open')
          .map((range) => ({ start: range.start, end: range.end })),
      };
    },
  }),
  tool({
    name: 'schedules.find_free_slots',
    description:
      'Ventanas libres reales de un profesional (horario abierto menos citas ya ' +
      'reservadas), ordenadas de la más cercana a la más lejana. Devuelve ' +
      '`free_windows` con `start`, `end` y `minutes` (la duración real de cada hueco ' +
      'contiguo), no slots de tamaño fijo: úsalo para saber cuánto dura cada hueco y ' +
      'proponer una hora dentro. `slot_minutes` filtra ventanas que no llegan a esa ' +
      'duración mínima. Filtra también por franja (part_of_day) y días (days_ahead).',
    parameters: objectSchema(
      {
        professional_id: uuidArg(),
        slot_minutes: integerArg({
          default: 30,
          minimum: 5,
          maximum: 480,
          description: 'Duración mínima (min) que debe caber en la ventana libre para incluirla.',
        }),
        days_ahead: integerArg({ default: 14, minimum: 1, maximum: 60 }),
        part_of_day: stringArg({ enum: ['morning', 'afternoon', 'any'], default: 'any' }),
        date_from: nullable(
          dateArgSchema({ description: 'Primer día a considerar; por defecto hoy.' }),
        ),
        limit: integerArg({ default: 5, minimum: 1, maximum: 20 }),
      },
      ['professional_id'],
    ),
    permissions: ['schedules.availability.read', 'agenda.appointments.read'],
    category: 'read',
    async handler(ctx, args) {
      const professionalId = requireString(args.professional_id, 'professional_id');
      const slotMinutes = intArg(args.slot_minutes, 30, 5, 480);
      const daysAhead = intArg(args.days_ahead, 14, 1, 60);
      const part = stringArgOrNull(args.part_of_day) ?? 'any';
      const limit = intArg(args.limit, 5, 1, 20);

      const clinic = await ctx.prisma.clinics.findUnique({
        where: { id: ctx.clinicId },
        select: { timezone: true },
      });
      const clinicTimeZone = schedulesService.safeTimeZone(clinic?.timezone ?? ctx.timeZone);
      const startDay =
        dateString(dateArg(args.date_from)) ??
        dateString(clinicToday(clinicTimeZone)) ??
        new Date().toISOString().slice(0, 10);
      const startDayDate = new Date(`${startDay}T00:00:00.000Z`);
      const endDay = new Date(startDayDate.getTime() + daysAhead * 86_400_000)
        .toISOString()
        .slice(0, 10);

      const { timeZone, ranges } = await schedulesService.resolveAvailability(
        ctx.clinicId,
        clinic?.timezone ?? ctx.timeZone,
        startDay,
        endDay,
        professionalId,
      );
      const openRanges = ranges
        .filter((range) => range.state === 'open')
        .map((range) => ({ start: range.start.getTime(), end: range.end.getTime() }))
        .sort((a, b) => a.start - b.start);
      if (openRanges.length === 0) return { professional_id: professionalId, free_windows: [] };

      // `list_appointments` interprète les bornes naïves en mur d'horloge clinique.
      const { rows } = await agendaService.listAppointments(ctx.clinicId, timeZone, {
        startDate: `${startDay}T00:00:00`,
        endDate: `${endDay}T23:59:59.999`,
        professionalId,
        page: 1,
        pageSize: 500,
        order: 'asc',
      });
      const busy = rows
        .filter((row) => BLOCKING_STATUSES.includes(row.status))
        .map((row) => ({
          start: timeLib.parseClinicDate(row.start_time, timeZone).getTime(),
          end: timeLib.parseClinicDate(row.end_time, timeZone).getTime(),
        }))
        .sort((a, b) => a.start - b.start);

      const minDuration = slotMinutes * 60_000;
      const windows: Array<{ start: Date; end: Date }> = [];
      for (const range of openRanges) {
        for (const free of subtractIntervals(range.start, range.end, busy)) {
          if (free.end - free.start < minDuration) continue;
          const start = new Date(free.start);
          const end = new Date(free.end);
          if (!overlapsPart(start, end, part, timeZone)) continue;
          windows.push({ start, end });
        }
      }
      windows.sort((a, b) => a.start.getTime() - b.start.getTime());

      return {
        professional_id: professionalId,
        min_minutes: slotMinutes,
        free_windows: windows.slice(0, limit).map((window) => ({
          start: timeLib.toZonedIso(window.start, timeZone),
          end: timeLib.toZonedIso(window.end, timeZone),
          minutes: Math.floor((window.end.getTime() - window.start.getTime()) / 60_000),
        })),
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// Module patient_timeline (1) — `app/modules/patient_timeline/tools.py`
// ---------------------------------------------------------------------------

const patientTimelineTools: AgentTool[] = [
  tool({
    name: 'patient_timeline.get_patient_timeline',
    description:
      'Actividad reciente de un paciente (citas, presupuestos, tratamientos…).',
    parameters: objectSchema(
      {
        patient_id: uuidArg(),
        limit: integerArg({ default: 20, minimum: 1, maximum: 50 }),
      },
      ['patient_id'],
    ),
    permissions: ['patient_timeline.read'],
    category: 'read',
    async handler(ctx, args) {
      const { entries, total } = await patientTimelineService.getTimeline(
        ctx.clinicId,
        requireString(args.patient_id, 'patient_id'),
        null,
        1,
        intArg(args.limit, 20, 1, 50),
      );
      // Métadonnées structurées uniquement (`description`/`event_data` omis).
      return {
        total,
        events: entries.map((entry) => ({
          event_type: entry.event_type,
          category: entry.event_category,
          title: entry.title,
          occurred_at: entry.occurred_at,
        })),
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// Module notifications (1) — `app/modules/notifications/tools.py`
// ---------------------------------------------------------------------------

const notificationsTools: AgentTool[] = [
  tool({
    name: 'notifications.send_notification',
    description:
      'Encolar una notificación a un paciente por su canal preferido (email / ' +
      'WhatsApp), con fallback a email. Respeta el consentimiento del paciente ' +
      '(do_not_contact) y la configuración de la clínica. La entrega es asíncrona ' +
      '(cola de salida).',
    parameters: objectSchema(
      {
        patient_id: uuidArg(),
        notification_type: stringArg({
          enum: NOTIFICATION_TYPES,
          description: 'Tipo de notificación.',
        }),
        channel: nullable(
          stringArg({
            enum: ['email', 'whatsapp'],
            description: 'Canal forzado (email / whatsapp). None = automático con fallback.',
          }),
        ),
        context: stringMapArg({
          description: 'Variables adicionales de plantilla (p. ej. fecha de la cita).',
        }),
      },
      ['patient_id', 'notification_type'],
    ),
    permissions: ['notifications.send'],
    category: 'write',
    async handler(ctx, args) {
      const patientId = requireString(args.patient_id, 'patient_id');
      const patient = await ctx.prisma.patients.findFirst({
        where: { id: patientId, clinic_id: ctx.clinicId },
        select: { id: true, first_name: true, last_name: true },
      });
      if (!patient) return { error: 'patient_not_found' };

      const rawContext = (args.context ?? {}) as Record<string, unknown>;
      const context: Record<string, unknown> = { ...rawContext };
      if (context.patient_name === undefined) {
        context.patient_name = `${patient.first_name} ${patient.last_name}`;
      }
      const channel = stringArgOrNull(args.channel);

      const message = await notificationService.enqueue({
        clinicId: ctx.clinicId,
        notificationType: requireString(args.notification_type, 'notification_type'),
        context,
        patientId,
        channels: channel ? [channel] : null,
        triggeredByUserId: ctx.userId || null,
      });
      if (!message) return { status: 'duplicate_skipped' };
      return {
        message_id: message.id,
        channel: message.channel,
        status: message.status,
        error_message: message.error_message,
      };
    },
  }),
];

// ---------------------------------------------------------------------------
// Registre
// ---------------------------------------------------------------------------

/**
 * Outils dans l'ordre d'enregistrement Python (`get_tools()` par module,
 * modules dans l'ordre de chargement du manifeste).
 */
export const AGENT_TOOLS: readonly AgentTool[] = [
  ...recallsTools,
  ...budgetTools,
  ...agendaTools,
  ...billingTools,
  ...catalogTools,
  ...patientsTools,
  ...paymentsTools,
  ...reportsTools,
  ...schedulesTools,
  ...patientTimelineTools,
  ...notificationsTools,
];

const TOOLS_BY_NAME = new Map(AGENT_TOOLS.map((entry) => [entry.name, entry]));

/** Noms qualifiés, dans l'ordre d'enregistrement. */
export const AGENT_TOOL_NAMES: readonly string[] = AGENT_TOOLS.map((entry) => entry.name);

/** Outils du premier lot (contrats `GET /pending` du copilot). */
export const RECALLS_LIST_DUE_RECALLS = 'recalls.list_due_recalls';
export const BUDGET_LIST_BUDGETS = 'budget.list_budgets';

export type CopilotToolOutcome = { ok: true; data: unknown } | { ok: false; error: string };

export const copilotToolRegistry: ToolRegistryLike & {
  schemaFor(name: string): ToolSchema | null;
  permissionsFor(name: string): string[];
  exposesFreeText(name: string): boolean;
  definition(name: string): AgentTool | null;
  call(ctx: unknown, name: string, args: Record<string, unknown>): Promise<CopilotToolOutcome>;
} = {
  list(): string[] {
    return [...AGENT_TOOL_NAMES];
  },

  category(name: string): ToolCategory | null {
    return TOOLS_BY_NAME.get(name)?.category ?? null;
  },

  schemaFor(name: string): ToolSchema | null {
    const entry = TOOLS_BY_NAME.get(name);
    if (!entry) return null;
    return {
      name: entry.name,
      description: entry.description,
      input_schema: entry.input_schema,
    };
  },

  permissionsFor(name: string): string[] {
    return TOOLS_BY_NAME.get(name)?.permissions ?? [];
  },

  exposesFreeText(name: string): boolean {
    return TOOLS_BY_NAME.get(name)?.exposes_free_text ?? false;
  },

  definition(name: string): AgentTool | null {
    return TOOLS_BY_NAME.get(name) ?? null;
  },

  /**
   * Invocation unique : outil, permissions, handler, erreurs converties.
   * Comme `ToolRegistry._invoke`, jamais d'exception : tout échec renvoie
   * `{ ok: false, error }` avec le message du service.
   */
  async call(
    ctx: unknown,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CopilotToolOutcome> {
    const entry = TOOLS_BY_NAME.get(name);
    if (!entry) return { ok: false, error: `unknown tool: ${name}` };

    const context = normalizeContext(ctx);
    if (!context) return { ok: false, error: 'permission denied: invalid tool context' };
    for (const required of entry.permissions) {
      if (!context.hasPermission(required)) {
        return { ok: false, error: `permission denied: ${required}` };
      }
    }

    try {
      const data = await entry.handler(context, args ?? {});
      return { ok: true, data: jsonify(data) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};

/** `tooling.jsonify` : valeurs JSON sérialisables (`Date` → ISO, `Decimal` → nombre). */
export function jsonify(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return Number(value.toString());
  if (Array.isArray(value)) return value.map(jsonify);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = jsonify(item);
    }
    return out;
  }
  return value;
}

/**
 * Outils visibles pour un jeu de permissions (`bridge._tool_names_for`).
 * `includeFreeText=false` (rédaction active) exclut les outils marqués
 * `exposes_free_text` (prose non tokenisable : `recalls.get_recall`).
 */
export function toolNamesFor(permissions: readonly string[], includeFreeText = true): string[] {
  return AGENT_TOOL_NAMES.filter((name) => {
    if (!includeFreeText && copilotToolRegistry.exposesFreeText(name)) return false;
    return copilotToolRegistry.permissionsFor(name).every((required) => allows(permissions, required));
  });
}

export type AgentPrismaClient = typeof sharedPrisma;

/** Résultat d'invocation (alias exporté pour les tests/mocks). */
export type { ToolCallOutcome };
