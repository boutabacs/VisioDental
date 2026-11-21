import crypto from 'node:crypto';

import { Router, type Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { JwtPayload } from 'jsonwebtoken';
import type { Prisma } from '@prisma/client';

import { config } from '../../config';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, forbidden, notFound, unprocessable, unauthorized } from '../../lib/errors';
import { ok, paginated } from '../../lib/http';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../../core/auth/password';
import {
  ACCESS_COOKIE,
  CSRF_COOKIE,
  REFRESH_COOKIE,
  newCsrfToken,
  clearSessionCookies,
  setSessionCookies,
} from '../../core/auth/cookies';
import {
  TokenError,
  createAccessToken,
  createInviteToken,
  decodeToken,
  revokeFamily,
  rotateRefreshToken,
} from '../../core/auth/tokens';
import { authenticate, blockInDemo, requireClinic, requirePermission } from '../../middleware/auth';
import {
  budgetSettingsPatchSchema,
  clinicUpdateSchema,
  communicationsSettingsPatchSchema,
  loginFormSchema,
  onboardingPatchSchema,
  refreshBodySchema,
  setPasswordSchema,
  setupSchema,
  userCreateSchema,
  userUpdateSchema,
} from './schemas';
import {
  COUNTRY_PRESETS,
  DEFAULT_CABINET_NAME,
  GENERIC_PRESET,
  getPreset,
  taxIdMatches,
} from './country-presets';
import {
  buildMePayload,
  createClinicUser,
  deleteClinicUser,
  findUserForLogin,
  getBudgetSettings,
  getClinicMetadata,
  getCommunicationsSettings,
  listClinicUsers,
  listMemberships,
  listProfessionals,
  setupStatus,
  startSession,
  toClinicBrief,
  toUserDto,
  updateBudgetSettings,
  updateClinicMetadata,
  updateClinicUser,
  updateCommunicationsSettings,
  updateOnboardingState,
} from './service';

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.isTest,
  keyGenerator: (req) => {
    const body = req.body as Record<string, unknown> | undefined;
    return `${ipKeyGenerator(req.ip ?? '')}:${String(body?.username ?? '')}`;
  },
});

/** Limiteur de refresh par utilisateur (le jeton est lisible serveur). */
const refreshLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.isTest,
  keyGenerator: (req) => {
    const cookies = req.cookies as Record<string, string | undefined>;
    const token = cookies[REFRESH_COOKIE];
    try {
      if (token) {
        const sub = decodeToken<JwtPayload>(token).sub;
        if (sub) return `refresh:${sub}`;
      }
    } catch {
      // jeton illisible → bucket par IP
    }
    return ipKeyGenerator(req.ip ?? 'unknown');
  },
});

const logoutLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.isTest,
});

const setupLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.isTest,
});

const setPasswordLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.isTest,
});

function clientIp(req: Request): string | undefined {
  return req.ip;
}

function cookies(req: Request): Record<string, string | undefined> {
  return (req.cookies ?? {}) as Record<string, string | undefined>;
}

function parsePagination(req: Request): { page: number; pageSize: number } {
  const page = Math.max(Number.parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
  const rawSize = Number.parseInt(String(req.query.page_size ?? '1000'), 10);
  const pageSize = Number.isFinite(rawSize) && rawSize > 0 ? Math.min(rawSize, 1000) : 1000;
  return { page, pageSize };
}

// ---------------------------------------------------------------------------
// Premier démarrage
// ---------------------------------------------------------------------------

authRouter.get('/setup/status', async (_req, res) => {
  res.json(ok(await setupStatus()));
});

authRouter.get('/setup/presets', (_req, res) => {
  res.json(
    ok({
      countries: Object.values(COUNTRY_PRESETS),
      fallback: GENERIC_PRESET,
    }),
  );
});

authRouter.post('/setup', setupLimiter, async (req, res) => {
  const input = setupSchema.parse(req.body);

  if ((await prisma.users.count()) > 0) {
    throw conflict('System already initialized');
  }

  const strength = validatePasswordStrength(input.admin_password);
  if (!strength.valid) throw unprocessable(strength.message ?? 'Password too weak');

  const preset = getPreset(input.country);
  if (input.country && !taxIdMatches(preset, input.clinic_tax_id)) {
    throw unprocessable(
      `Invalid tax id format for ${input.country.toUpperCase()} (${preset.tax_id_label})`,
    );
  }

  const timezone = input.timezone || (input.country ? preset.timezone : 'Europe/Madrid');
  const currency = input.currency || (input.country ? preset.currency : 'EUR');
  const language = input.language || preset.language;

  const settings: Record<string, unknown> = { communication_language: language };
  if (input.country) settings.country = input.country.toUpperCase();

  const address = Object.fromEntries(
    Object.entries({
      country: input.country?.toUpperCase(),
      street: input.clinic_street,
      city: input.clinic_city,
      postal_code: input.clinic_postal_code,
    }).filter(([, value]) => Boolean(value)),
  );

  const now = new Date();
  const clinicId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(input.admin_password);
  const cabinetName = DEFAULT_CABINET_NAME[language] ?? DEFAULT_CABINET_NAME.en!;

  const adminRole = await prisma.roles.findFirst({
    where: { name: 'admin', clinic_id: null },
  });

  const user = await prisma.$transaction(async (tx) => {
    await tx.clinics.create({
      data: {
        id: clinicId,
        name: input.clinic_name,
        tax_id: input.clinic_tax_id,
        address: address as Prisma.InputJsonValue,
        settings: settings as Prisma.InputJsonValue,
        timezone,
        currency,
        created_at: now,
        updated_at: now,
      },
    });

    const created = await tx.users.create({
      data: {
        id: userId,
        email: input.admin_email,
        password_hash: passwordHash,
        first_name: input.admin_first_name,
        last_name: input.admin_last_name,
        is_active: true,
        token_version: 0,
        created_at: now,
        updated_at: now,
      },
    });

    await tx.clinic_memberships.create({
      data: {
        id: crypto.randomUUID(),
        user_id: userId,
        clinic_id: clinicId,
        role: 'admin',
        role_id: adminRole?.id ?? null,
        is_professional: input.admin_is_professional,
        created_at: now,
        updated_at: now,
      },
    });

    await tx.cabinets.create({
      data: {
        id: crypto.randomUUID(),
        clinic_id: clinicId,
        name: cabinetName,
        color: '#3B82F6',
        display_order: 0,
        is_active: true,
        created_at: now,
        updated_at: now,
      },
    });

    return created;
  });

  const tokens = await startSession(res, user, clinicId, {
    userAgent: req.headers['user-agent'],
    clientIp: clientIp(req),
  });
  res.status(201).json(tokens);
});

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

authRouter.post('/login', loginLimiter, async (req, res) => {
  const input = loginFormSchema.parse(req.body);
  const user = await findUserForLogin(input.username);

  if (!user || !(await verifyPassword(input.password, user.password_hash))) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    throw unauthorized('Invalid email or password');
  }
  if (!user.is_active) throw forbidden('User account is inactive');

  const memberships = await listMemberships(user.id);
  const clinicId = memberships[0]?.clinic_id ?? null;

  const tokens = await startSession(res, user, clinicId, {
    userAgent: req.headers['user-agent'],
    clientIp: clientIp(req),
  });
  const payload = await buildMePayload(user);
  res.json({ ...tokens, user: payload.user, clinics: payload.clinics });
});

authRouter.post('/logout', logoutLimiter, async (req, res) => {
  const candidates: string[] = [];
  const authorization = req.headers.authorization ?? '';
  if (authorization.toLowerCase().startsWith('bearer ')) {
    candidates.push(authorization.slice(7).trim());
  }
  const jar = cookies(req);
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
    const value = jar[name];
    if (value) candidates.push(value);
  }
  const body = req.body as { refresh_token?: unknown } | undefined;
  if (typeof body?.refresh_token === 'string') candidates.push(body.refresh_token);

  for (const token of candidates) {
    try {
      const payload = decodeToken<JwtPayload>(token);
      const family = typeof payload.fam === 'string' ? payload.fam : null;
      if (family) await revokeFamily(family);
    } catch {
      // Jeton expiré/illisible : les cookies sont quand même effacés.
    }
  }

  clearSessionCookies(res);
  res.status(204).end();
});

authRouter.post('/refresh', refreshLimiter, async (req, res) => {
  const body = refreshBodySchema.parse(req.body ?? {});
  const presented = body.refresh_token ?? cookies(req)[REFRESH_COOKIE];
  if (!presented) throw badRequest('Invalid refresh token');

  let rotated;
  try {
    rotated = await rotateRefreshToken(presented, {
      userAgent: req.headers['user-agent'],
      clientIp: clientIp(req),
    });
  } catch (error) {
    clearSessionCookies(res);
    if (error instanceof TokenError) {
      res.status(401).json({ detail: error.message });
      return;
    }
    throw error;
  }

  const memberships = await listMemberships(rotated.user.id);
  const clinicId = memberships[0]?.clinic_id ?? null;
  const accessToken = createAccessToken(rotated.user.id, {
    clinicId,
    tokenVersion: rotated.user.token_version,
    familyId: rotated.familyId,
  });

  setSessionCookies(res, {
    accessToken,
    refreshToken: rotated.token,
    // Le CSRF est lié à la famille, pas à l'access token : on conserve
    // celui que le navigateur détient déjà.
    csrfToken: cookies(req)[CSRF_COOKIE] || newCsrfToken(),
  });

  res.json({
    access_token: accessToken,
    refresh_token: rotated.token,
    token_type: 'bearer',
    user: toUserDto(rotated.user),
    clinics: memberships.map(toClinicBrief),
  });
});

authRouter.get('/me', authenticate, async (req, res) => {
  const payload = await buildMePayload(req.user!);
  res.json(ok(payload));
});

authRouter.post('/set-password', setPasswordLimiter, async (req, res) => {
  const input = setPasswordSchema.parse(req.body);

  let payload: JwtPayload;
  try {
    payload = decodeToken<JwtPayload>(input.token);
  } catch {
    throw badRequest('Invalid or expired link');
  }
  if (payload.type !== 'invite' || !payload.sub) throw badRequest('Invalid link');

  const userId = String(payload.sub);
  const expectedVersion = Number(payload.token_version ?? 0);

  const strength = validatePasswordStrength(input.password);
  if (!strength.valid) throw unprocessable(strength.message ?? 'Password too weak');

  // Usage unique atomique : la version attendue doit encore être celle du
  // compte ; la mise à jour la incrémente et invalide le lien.
  const updated = await prisma.users.updateMany({
    where: { id: userId, token_version: expectedVersion, is_active: true },
    data: {
      password_hash: await hashPassword(input.password),
      token_version: { increment: 1 },
      updated_at: new Date(),
    },
  });
  if (updated.count === 0) throw badRequest('Invalid or used link');

  const user = await prisma.users.findUnique({ where: { id: userId } });
  if (!user) throw badRequest('Invalid or used link');

  const memberships = await listMemberships(user.id);
  const clinicId = memberships[0]?.clinic_id ?? null;

  const tokens = await startSession(res, user, clinicId, {
    userAgent: req.headers['user-agent'],
    clientIp: clientIp(req),
  });
  res.json(tokens);
});

// ---------------------------------------------------------------------------
// Utilisateurs du cabinet
// ---------------------------------------------------------------------------

authRouter.get(
  '/users',
  authenticate,
  requireClinic,
  requirePermission('admin.users.read'),
  async (req, res) => {
    const { page, pageSize } = parsePagination(req);
    const result = await listClinicUsers(req.clinicId!, page, pageSize);
    res.json(paginated(result.rows, result.total, result.page, result.pageSize));
  },
);

authRouter.post(
  '/users',
  authenticate,
  requireClinic,
  requirePermission('admin.users.write'),
  blockInDemo,
  async (req, res) => {
    const input = userCreateSchema.parse(req.body);
    const user = await createClinicUser(req.clinicId!, req.user!.id, input);
    res.status(201).json(ok(toUserDto(user)));
  },
);

authRouter.post(
  '/users/:userId/invite-link',
  authenticate,
  requireClinic,
  requirePermission('admin.users.write'),
  blockInDemo,
  async (req, res) => {
    const userId = z.string().uuid().parse(req.params.userId);
    const user = await prisma.users.findFirst({
      where: {
        id: userId,
        clinic_memberships: { some: { clinic_id: req.clinicId! } },
      },
    });
    if (!user) throw notFound('User not found');
    if (!user.is_active) throw badRequest('User is inactive');

    const invite = createInviteToken(user.id, user.token_version);
    res.json(ok({ token: invite.token, expires_at: invite.expiresAt.toISOString() }));
  },
);

authRouter.put(
  '/users/:userId',
  authenticate,
  requireClinic,
  requirePermission('admin.users.write'),
  blockInDemo,
  async (req, res) => {
    const userId = z.string().uuid().parse(req.params.userId);
    const input = userUpdateSchema.parse(req.body);
    const updated = await updateClinicUser(req.clinicId!, req.user!.id, userId, input);
    res.json(ok(updated));
  },
);

authRouter.delete(
  '/users/:userId',
  authenticate,
  requireClinic,
  requirePermission('admin.users.write'),
  blockInDemo,
  async (req, res) => {
    const userId = z.string().uuid().parse(req.params.userId);
    await deleteClinicUser(req.clinicId!, req.user!.id, userId);
    res.status(204).end();
  },
);

authRouter.get(
  '/professionals',
  authenticate,
  requireClinic,
  requirePermission('agenda.appointments.read'),
  async (req, res) => {
    const professionals = await listProfessionals(req.clinicId!);
    res.json(paginated(professionals, professionals.length, 1, professionals.length));
  },
);

// ---------------------------------------------------------------------------
// Métadonnées du cabinet
// ---------------------------------------------------------------------------

authRouter.get('/clinics', authenticate, requireClinic, async (req, res) => {
  const clinic = await getClinicMetadata(req.clinic!);
  res.json(paginated([clinic], 1, 1, 1));
});

authRouter.get('/clinics/:clinicId', authenticate, requireClinic, async (req, res) => {
  const clinicId = z.string().uuid().parse(req.params.clinicId);
  if (clinicId !== req.clinicId) throw forbidden('Access denied to this clinic');
  res.json(ok(await getClinicMetadata(req.clinic!)));
});

authRouter.put(
  '/clinics',
  authenticate,
  requireClinic,
  requirePermission('admin.clinic.write'),
  blockInDemo,
  async (req, res) => {
    const input = clinicUpdateSchema.parse(req.body);
    res.json(ok(await updateClinicMetadata(req.clinic!, input)));
  },
);

authRouter.patch(
  '/clinic/settings/onboarding',
  authenticate,
  requireClinic,
  requirePermission('admin.clinic.write'),
  async (req, res) => {
    const input = onboardingPatchSchema.parse(req.body);
    res.json(ok(await updateOnboardingState(req.clinicId!, input)));
  },
);

authRouter.get(
  '/clinic/settings/budget',
  authenticate,
  requireClinic,
  requirePermission('admin.clinic.read'),
  async (req, res) => {
    res.json(ok(await getBudgetSettings(req.clinicId!)));
  },
);

authRouter.patch(
  '/clinic/settings/budget',
  authenticate,
  requireClinic,
  requirePermission('admin.clinic.write'),
  async (req, res) => {
    const input = budgetSettingsPatchSchema.parse(req.body ?? {});
    res.json(ok(await updateBudgetSettings(req.clinicId!, input)));
  },
);

authRouter.get(
  '/clinic/settings/communications',
  authenticate,
  requireClinic,
  requirePermission('admin.clinic.read'),
  async (req, res) => {
    res.json(ok(await getCommunicationsSettings(req.clinicId!)));
  },
);

authRouter.patch(
  '/clinic/settings/communications',
  authenticate,
  requireClinic,
  requirePermission('admin.clinic.write'),
  async (req, res) => {
    const input = communicationsSettingsPatchSchema.parse(req.body ?? {});
    res.json(ok(await updateCommunicationsSettings(req.clinicId!, input)));
  },
);

