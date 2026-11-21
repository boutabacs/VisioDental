/**
 * Routeur du module `copilot` — port de `app/modules/copilot/router.py`.
 * Monté sous `/api/v1/copilot`.
 *
 * Le chat est streamé en SSE (`text/event-stream`) ; tout le reste est
 * enveloppé `ApiResponse`/`PaginatedApiResponse` (enveloppes FastAPI).
 * Les routes de chat ouvrent leur propre « session » logique : le tour est
 * joué dans un générateur, les écritures sont appliquées message par message
 * (équivalent du commit unique Python en cas de succès ; une erreur en cours
 * de tour est diffusée en `event: error` et interrompt le flux, jamais un
 * 500 après envoi des en-têtes).
 *
 * Permissions (manifeste `copilot`), chacune vérifiée en base :
 * `copilot.chat`, `copilot.history.read` (+ `copilot.history.read_all` pour
 * lever le filtre propriétaire), `copilot.configure`, `copilot.supervise`.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { hasPermission, resolveGrantedPermissions } from '../../core/auth/rbac';
import { ApiError, badRequest, notFound, unprocessable } from '../../lib/errors';
import { ok, paginated } from '../../lib/http';
import { prisma } from '../../lib/prisma';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import { driveTurn, frameFor, resumeTurn, sseFrame, type TurnOptions } from './bridge';
import type { TurnEvent } from './provider';
import {
  confirmRequestSchema,
  messageCreateSchema,
  settingsUpdateSchema,
  sessionCreateSchema,
  boundedIntQuery,
  type PendingItemDto,
} from './schemas';
import {
  ConversationService,
  CopilotMetricsService,
  CopilotSettingsService,
  NudgeService,
  PendingService,
  getOrCreateCopilotAgent,
  getOrCreatePendingSession,
  startAgentSession,
  toConversationDto,
  toMessageDto,
  toNudgeDto,
  toSettingsDto,
} from './service';
import { createToolContext } from './tools';

export const copilotRouter = Router();

const uuid = z.string().uuid();

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function parseUuid(value: string): string {
  return uuid.parse(value);
}

/** `{conversation_id}` de FastAPI : UUID invalide → `{detail}` de validation. */
function conversationIdParam(req: Request): string {
  return parseUuid(String(req.params.conversationId));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

copilotRouter.post(
  '/sessions',
  authenticate,
  requireClinic,
  requirePermission('copilot.chat'),
  async (req, res) => {
    const input = sessionCreateSchema.parse(req.body ?? {});
    const clinicId = req.clinicId!;
    const userId = req.user!.id;

    const settingsRow = await CopilotSettingsService.getOrCreatePersisted(clinicId);
    const agent = await getOrCreateCopilotAgent(clinicId);
    const session = await startAgentSession(agent.id, clinicId, userId, { surface: 'copilot' });
    const conv = await ConversationService.create({
      clinicId,
      userId,
      provider: settingsRow.provider,
      model: settingsRow.model,
      context: input.context ?? {},
      sessionId: session.id,
    });

    res.status(201).json(ok(toConversationDto(conv)));
  },
);

copilotRouter.get(
  '/sessions',
  authenticate,
  requireClinic,
  requirePermission('copilot.history.read'),
  async (req, res) => {
    const page = boundedIntQuery(queryString(req, 'page'), 1, 1, Number.MAX_SAFE_INTEGER, 'page');
    if (typeof page !== 'number') throw unprocessable(page.error);
    const pageSize = boundedIntQuery(queryString(req, 'page_size'), 20, 1, 100, 'page_size');
    if (typeof pageSize !== 'number') throw unprocessable(pageSize.error);

    const readAll = await hasPermission(req.clinicId!, req.role!, 'copilot.history.read_all');
    const result = await ConversationService.list(req.clinicId!, {
      userId: readAll ? null : req.user!.id,
      page,
      pageSize,
    });

    res.json(
      paginated(result.rows.map(toConversationDto), result.total, page, pageSize),
    );
  },
);

copilotRouter.get(
  '/sessions/:conversationId/messages',
  authenticate,
  requireClinic,
  requirePermission('copilot.history.read'),
  async (req, res) => {
    const conversationId = conversationIdParam(req);
    const readAll = await hasPermission(req.clinicId!, req.role!, 'copilot.history.read_all');
    const conv = await ConversationService.get(
      req.clinicId!,
      conversationId,
      readAll ? null : req.user!.id,
    );
    if (!conv) throw notFound('Conversation not found');
    const rows = await ConversationService.listMessages(conv.id);
    res.json(ok(rows.map(toMessageDto)));
  },
);

copilotRouter.post(
  '/sessions/:conversationId/end',
  authenticate,
  requireClinic,
  requirePermission('copilot.chat'),
  async (req, res) => {
    const conversationId = conversationIdParam(req);
    // Filtre propriétaire inconditionnel côté Python (`user_id=ctx.user_id`).
    const conv = await ConversationService.get(req.clinicId!, conversationId, req.user!.id);
    if (!conv) throw notFound('Conversation not found');
    const ended = await ConversationService.end(conv.id);
    res.json(ok(toConversationDto(ended)));
  },
);

// ---------------------------------------------------------------------------
// Chat streamé (SSE)
// ---------------------------------------------------------------------------

/**
 * `_load_for_turn` : conversation du propriétaire + réglages + identifiants
 * de la session d'agent liée (`agent_sessions.agent_id`). `null` → 404.
 */
async function loadForTurn(
  clinicId: string,
  conversationId: string,
  userId: string,
): Promise<{ context: Omit<TurnOptions, 'permissions'> } | null> {
  const conv = await ConversationService.get(clinicId, conversationId, userId);
  if (!conv) return null;
  const settingsRow = await CopilotSettingsService.getOrCreatePersisted(clinicId);
  let agentId = '';
  if (conv.session_id) {
    const session = await prisma.agent_sessions.findUnique({
      where: { id: conv.session_id },
      select: { agent_id: true },
    });
    agentId = session?.agent_id ?? '';
  }
  return {
    context: {
      conv,
      settingsRow,
      userId,
      agentId,
      sessionId: conv.session_id,
      // Remplacé par le fuseau de la requête dans `streamTurn`.
      timeZone: 'UTC',
    },
  };
}

/**
 * Prépare la réponse SSE. Les erreurs de préparation (UUID invalide,
 * conversation étrangère…) restent des réponses JSON `{detail}` ; une fois
 * les en-têtes envoyés, toute erreur devient un `event: error`.
 */
async function streamTurn(
  req: Request,
  res: Response,
  run: (context: TurnOptions) => AsyncGenerator<TurnEvent>,
): Promise<void> {
  const clinicId = req.clinicId!;
  const userId = req.user!.id;

  const conversationId = conversationIdParam(req);
  const loaded = await loadForTurn(clinicId, conversationId, userId);
  if (!loaded) throw notFound('Conversation not found');

  const grants = await resolveGrantedPermissions(clinicId, req.role!);
  const context: TurnOptions = {
    ...loaded.context,
    timeZone: req.clinic?.timezone ?? 'UTC',
    permissions: [...grants],
  };

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    for await (const event of run(context)) {
      const frame = frameFor(event);
      if (frame !== null) res.write(frame);
    }
  } catch (error) {
    // Comme Python : l'erreur devient un événement SSE, pas un 500 coupé.
    res.write(sseFrame('error', { detail: (error as Error).message }));
  } finally {
    res.end();
  }
}

copilotRouter.post(
  '/sessions/:conversationId/messages',
  authenticate,
  requireClinic,
  requirePermission('copilot.chat'),
  async (req, res) => {
    // Validation avant d'ouvrir le flux : un 422 reste un JSON `{detail}`.
    const input = messageCreateSchema.parse(req.body);
    await streamTurn(req, res, (context) => driveTurn(context, input.content));
  },
);

copilotRouter.post(
  '/sessions/:conversationId/confirmations/:callId',
  authenticate,
  requireClinic,
  requirePermission('copilot.chat'),
  async (req, res) => {
    const callId = String(req.params.callId);
    const input = confirmRequestSchema.parse(req.body);
    const approve = input.decision === 'confirm';
    await streamTurn(req, res, (context) => resumeTurn(context, callId, approve));
  },
);

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

copilotRouter.get(
  '/settings',
  authenticate,
  requireClinic,
  requirePermission('copilot.configure'),
  async (req, res) => {
    const row = await CopilotSettingsService.getOrCreatePersisted(req.clinicId!);
    res.json(ok(toSettingsDto(row)));
  },
);

copilotRouter.patch(
  '/settings',
  authenticate,
  requireClinic,
  requirePermission('copilot.configure'),
  async (req, res) => {
    // `exclude_unset` de Pydantic : seules les clés présentes sont appliquées
    // (un `null` explicite est une valeur, l'absence ne touche à rien).
    const input = settingsUpdateSchema.parse(pickDefinedKeys((req.body ?? {}) as Record<string, unknown>));
    try {
      const row = await CopilotSettingsService.update(req.clinicId!, input, req.user!.id);
      res.json(ok(toSettingsDto(row)));
    } catch (error) {
      if (error instanceof Error && !(error instanceof ApiError)) throw badRequest(error.message);
      throw error;
    }
  },
);

/** Ne garde que les clés réellement présentes dans le corps (non `undefined`). */
function pickDefinedKeys(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pendientes
// ---------------------------------------------------------------------------

copilotRouter.get(
  '/pending',
  authenticate,
  requireClinic,
  requirePermission('copilot.chat'),
  async (req, res) => {
    const clinicId = req.clinicId!;
    const userId = req.user!.id;
    const agent = await getOrCreateCopilotAgent(clinicId);
    await getOrCreatePendingSession(agent.id, clinicId, userId);
    const grants = await resolveGrantedPermissions(clinicId, req.role!);
    const items = await PendingService.get(
      createToolContext({
        clinicId,
        timeZone: req.clinic!.timezone,
        role: req.role!,
        permissions: [...grants],
        userId,
      }),
    );
    res.json(ok(items as PendingItemDto[]));
  },
);

// ---------------------------------------------------------------------------
// Nudges
// ---------------------------------------------------------------------------

copilotRouter.get(
  '/nudges',
  authenticate,
  requireClinic,
  requirePermission('copilot.chat'),
  async (req, res) => {
    const grants = await resolveGrantedPermissions(req.clinicId!, req.role!);
    const rows = await NudgeService.listActive(req.clinicId!, [...grants]);
    res.json(ok(rows.map(toNudgeDto)));
  },
);

copilotRouter.post(
  '/nudges/:nudgeId/dismiss',
  authenticate,
  requireClinic,
  requirePermission('copilot.chat'),
  async (req, res) => {
    const nudgeId = parseUuid(String(req.params.nudgeId));
    const dismissed = await NudgeService.dismiss(req.clinicId!, nudgeId);
    if (!dismissed) throw notFound('Nudge not found');
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Métriques
// ---------------------------------------------------------------------------

copilotRouter.get(
  '/metrics',
  authenticate,
  requireClinic,
  requirePermission('copilot.supervise'),
  async (req, res) => {
    const days = boundedIntQuery(queryString(req, 'days'), 30, 1, 365, 'days');
    if (typeof days !== 'number') throw unprocessable(days.error);
    const data = await CopilotMetricsService.get(req.clinicId!, days);
    res.json(ok(data));
  },
);
