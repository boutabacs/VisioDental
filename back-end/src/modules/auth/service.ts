import crypto from 'node:crypto';

import { Prisma, type clinic_memberships, type clinics, type users } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { hashPassword, validatePasswordStrength } from '../../core/auth/password';
import { expandPermissions, resolveGrantedPermissions } from '../../core/auth/rbac';
import {
  createAccessToken,
  issueRefreshToken,
  type IssuedRefreshToken,
} from '../../core/auth/tokens';
import { newCsrfToken, setSessionCookies } from '../../core/auth/cookies';
import {
  PROFESSIONAL_ROLES,
  SYSTEM_ROLES,
  type BudgetSettingsPatchInput,
  type ClinicUpdateInput,
  type CommunicationsSettingsPatchInput,
  type OnboardingPatchInput,
  type UserCreateInput,
  type UserUpdateInput,
} from './schemas';

export interface UserDto {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  professional_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ClinicBriefDto {
  id: string;
  name: string;
  role: string;
}

export interface UserWithRoleDto extends UserDto {
  role: string;
  is_professional: boolean;
}

export interface ClinicMetadataDto {
  id: string;
  name: string;
  tax_id: string;
  legal_name: string | null;
  address: unknown;
  phone: string | null;
  email: string | null;
  timezone: string;
  currency: string;
  settings: unknown;
  cabinets: Array<{
    id: string;
    name: string;
    color: string;
    display_order: number;
    is_active: boolean;
  }>;
}

type MembershipWithClinic = clinic_memberships & { clinics: clinics };

export function toUserDto(user: users): UserDto {
  return {
    id: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    professional_id: user.professional_id,
    is_active: user.is_active,
    created_at: user.created_at.toISOString(),
    updated_at: user.updated_at.toISOString(),
  };
}

export function toClinicBrief(membership: MembershipWithClinic): ClinicBriefDto {
  return { id: membership.clinics.id, name: membership.clinics.name, role: membership.role };
}

export function toUserWithRole(membership: clinic_memberships & { users: users }): UserWithRoleDto {
  return {
    ...toUserDto(membership.users),
    role: membership.role,
    is_professional: membership.is_professional,
  };
}

export async function listMemberships(userId: string): Promise<MembershipWithClinic[]> {
  return prisma.clinic_memberships.findMany({
    where: { user_id: userId },
    include: { clinics: true },
    orderBy: { created_at: 'asc' },
  });
}

/** Recherche insensible à la casse, l'orthographe exacte prioritaire, puis le plus ancien. */
export async function findUserForLogin(rawEmail: string): Promise<users | null> {
  const email = rawEmail.trim().toLowerCase();
  const candidates = await prisma.users.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    orderBy: { created_at: 'asc' },
  });
  if (!candidates.length) return null;
  return candidates.find((user) => user.email === rawEmail.trim()) ?? candidates[0] ?? null;
}

export interface SessionTokens {
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
}

export interface SessionContext {
  userAgent?: string;
  clientIp?: string;
}

export async function startSession(
  res: Parameters<typeof setSessionCookies>[0],
  user: users,
  clinicId: string | null,
  context: SessionContext = {},
): Promise<SessionTokens> {
  const issued: IssuedRefreshToken = await issueRefreshToken(user, context);
  const accessToken = createAccessToken(user.id, {
    clinicId,
    tokenVersion: user.token_version,
    familyId: issued.familyId,
  });
  setSessionCookies(res, {
    accessToken,
    refreshToken: issued.token,
    csrfToken: newCsrfToken(),
  });
  return { access_token: accessToken, refresh_token: issued.token, token_type: 'bearer' };
}

export interface MePayload {
  user: UserDto;
  clinics: ClinicBriefDto[];
  permissions: string[];
}

export async function buildMePayload(user: users): Promise<MePayload> {
  const memberships = await listMemberships(user.id);
  const permissions: string[] = [];
  if (memberships.length > 0) {
    const first = memberships[0]!;
    const grants = await resolveGrantedPermissions(first.clinic_id, first.role);
    permissions.push(...(await expandPermissions(grants)));
  }
  return {
    user: toUserDto(user),
    clinics: memberships.map(toClinicBrief),
    permissions,
  };
}

async function roleIsValidForClinic(clinicId: string, role: string): Promise<boolean> {
  if ((SYSTEM_ROLES as readonly string[]).includes(role)) return true;
  const custom = await prisma.roles.findFirst({ where: { clinic_id: clinicId, name: role } });
  return Boolean(custom);
}

async function resolveRoleId(clinicId: string, role: string): Promise<string | null> {
  const roles = await prisma.roles.findMany({
    where: { name: role, OR: [{ clinic_id: clinicId }, { clinic_id: null }] },
  });
  return roles.find((row) => row.clinic_id === clinicId)?.id ?? roles[0]?.id ?? null;
}

async function refuseIfLastAdmin(clinicId: string, userId: string): Promise<void> {
  const admins = await prisma.clinic_memberships.count({
    where: { clinic_id: clinicId, role: 'admin', user_id: { not: userId } },
  });
  if (admins === 0) {
    throw unprocessable('Cannot remove the last admin of the clinic');
  }
}

export async function listClinicUsers(clinicId: string, page: number, pageSize: number) {
  const take = Math.min(Math.max(pageSize, 1), 100);
  const currentPage = Math.max(page, 1);
  const where = { clinic_id: clinicId };
  const [rows, total] = await Promise.all([
    prisma.clinic_memberships.findMany({
      where,
      include: { users: true },
      orderBy: { created_at: 'asc' },
      skip: (currentPage - 1) * take,
      take,
    }),
    prisma.clinic_memberships.count({ where }),
  ]);
  return { rows: rows.map(toUserWithRole), total, page: currentPage, pageSize: take };
}

export async function createClinicUser(
  callerClinicId: string,
  callerUserId: string,
  input: UserCreateInput,
): Promise<users> {
  const clinicId = input.clinic_id ?? callerClinicId;
  if (clinicId !== callerClinicId) {
    const callerMembership = await prisma.clinic_memberships.findFirst({
      where: { user_id: callerUserId, clinic_id: clinicId, role: 'admin' },
      select: { id: true },
    });
    if (!callerMembership) throw forbidden('You do not administer the target clinic');
  }

  if (!(await roleIsValidForClinic(clinicId, input.role))) {
    throw unprocessable(
      `Invalid role. Must be a system role (${SYSTEM_ROLES.join(', ')}) or a custom role in this clinic.`,
    );
  }

  if (input.password) {
    const strength = validatePasswordStrength(input.password);
    if (!strength.valid) throw unprocessable(strength.message ?? 'Password too weak');
  }

  const existing = await prisma.users.findFirst({
    where: { email: { equals: input.email, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existing) throw conflict('Email already registered');

  const now = new Date();
  const passwordHash = await hashPassword(input.password ?? crypto.randomBytes(32).toString('base64url'));

  return prisma.$transaction(async (tx) => {
    const user = await tx.users.create({
      data: {
        id: crypto.randomUUID(),
        email: input.email,
        password_hash: passwordHash,
        first_name: input.first_name,
        last_name: input.last_name,
        is_active: true,
        token_version: 0,
        created_at: now,
        updated_at: now,
      },
    });
    await tx.clinic_memberships.create({
      data: {
        id: crypto.randomUUID(),
        user_id: user.id,
        clinic_id: clinicId,
        role: input.role,
        role_id: await resolveRoleId(clinicId, input.role),
        is_professional:
          input.is_professional ?? PROFESSIONAL_ROLES.has(input.role),
        created_at: now,
        updated_at: now,
      },
    });
    return user;
  });
}

export async function updateClinicUser(
  callerClinicId: string,
  callerUserId: string,
  userId: string,
  input: UserUpdateInput,
): Promise<UserWithRoleDto> {
  const membership = await prisma.clinic_memberships.findFirst({
    where: { user_id: userId, clinic_id: callerClinicId },
    include: { users: true },
  });
  if (!membership) throw notFound('User not found in this clinic');

  if (input.is_active === false && userId === callerUserId) {
    throw unprocessable('Cannot deactivate your own account');
  }
  if (input.role !== undefined && !(await roleIsValidForClinic(callerClinicId, input.role))) {
    throw unprocessable(
      `Invalid role. Must be a system role (${SYSTEM_ROLES.join(', ')}) or a custom role in this clinic.`,
    );
  }
  if (input.email && input.email !== membership.users.email) {
    const duplicate = await prisma.users.findFirst({
      where: { email: { equals: input.email, mode: 'insensitive' }, id: { not: userId } },
      select: { id: true },
    });
    if (duplicate) throw conflict('Email already registered');
  }

  if (input.is_active === false && membership.role === 'admin') {
    await refuseIfLastAdmin(callerClinicId, userId);
  }
  if (input.role && input.role !== membership.role) {
    if (userId === callerUserId) throw unprocessable('Cannot change your own role');
    if (membership.role === 'admin') await refuseIfLastAdmin(callerClinicId, userId);
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updatedUser = await tx.users.update({
      where: { id: userId },
      data: {
        ...(input.first_name !== undefined ? { first_name: input.first_name } : {}),
        ...(input.last_name !== undefined ? { last_name: input.last_name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.is_active !== undefined
          ? {
              is_active: input.is_active,
              ...(input.is_active ? {} : { token_version: { increment: 1 } }),
            }
          : {}),
        updated_at: now,
      },
    });

    const updatedMembership = await tx.clinic_memberships.update({
      where: { id: membership.id },
      data: {
        ...(input.role !== undefined
          ? { role: input.role, role_id: await resolveRoleId(callerClinicId, input.role) }
          : {}),
        ...(input.is_professional !== undefined && input.is_professional !== null
          ? { is_professional: input.is_professional }
          : input.role !== undefined
            ? { is_professional: PROFESSIONAL_ROLES.has(input.role) }
            : {}),
        updated_at: now,
      },
    });

    return toUserWithRole({ ...updatedMembership, users: updatedUser });
  });
}

export async function deleteClinicUser(
  callerClinicId: string,
  callerUserId: string,
  userId: string,
): Promise<void> {
  if (userId === callerUserId) throw unprocessable('Cannot remove yourself from the clinic');
  const membership = await prisma.clinic_memberships.findFirst({
    where: { user_id: userId, clinic_id: callerClinicId },
  });
  if (!membership) throw notFound('User not found in this clinic');
  if (membership.role === 'admin') await refuseIfLastAdmin(callerClinicId, userId);
  await prisma.clinic_memberships.delete({ where: { id: membership.id } });
}

export async function listProfessionals(clinicId: string) {
  const rows = await prisma.clinic_memberships.findMany({
    where: { clinic_id: clinicId, is_professional: true },
    include: { users: true },
    orderBy: { created_at: 'asc' },
  });
  return rows
    .filter((row) => row.users.is_active)
    .map((row) => ({
      id: row.users.id,
      email: row.users.email,
      first_name: row.users.first_name,
      last_name: row.users.last_name,
      role: row.role,
    }));
}

export async function getClinicMetadata(clinic: clinics): Promise<ClinicMetadataDto> {
  const cabinets = await prisma.cabinets.findMany({
    where: { clinic_id: clinic.id },
    orderBy: { display_order: 'asc' },
  });
  return {
    id: clinic.id,
    name: clinic.name,
    tax_id: clinic.tax_id,
    legal_name: clinic.legal_name,
    address: clinic.address,
    phone: clinic.phone,
    email: clinic.email,
    timezone: clinic.timezone,
    currency: clinic.currency,
    settings: (clinic.settings as Record<string, unknown> | null) ?? {},
    cabinets: cabinets.map((cabinet) => ({
      id: cabinet.id,
      name: cabinet.name,
      color: cabinet.color,
      display_order: cabinet.display_order,
      is_active: cabinet.is_active,
    })),
  };
}

export async function updateClinicMetadata(
  clinic: clinics,
  input: ClinicUpdateInput,
): Promise<ClinicMetadataDto> {
  const existingAddress = (clinic.address as Record<string, unknown> | null) ?? {};
  let settings = (clinic.settings as Record<string, unknown> | null) ?? {};

  if (input.address) {
    const addressPatch = Object.fromEntries(
      Object.entries(input.address).filter(([, value]) => value !== undefined),
    );
    const merged = { ...existingAddress, ...addressPatch };
    const country = String(addressPatch.country ?? '').toUpperCase();
    if (country.length === 2 && /^[A-Z]{2}$/.test(country)) {
      settings = { ...settings, country };
    }
    const updated = await prisma.clinics.update({
      where: { id: clinic.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.tax_id !== undefined ? { tax_id: input.tax_id } : {}),
        ...(input.legal_name !== undefined ? { legal_name: input.legal_name || null } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        address: merged as Prisma.InputJsonValue,
        settings: settings as Prisma.InputJsonValue,
        updated_at: new Date(),
      },
    });
    return getClinicMetadata(updated);
  }

  const updated = await prisma.clinics.update({
    where: { id: clinic.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.tax_id !== undefined ? { tax_id: input.tax_id } : {}),
      ...(input.legal_name !== undefined ? { legal_name: input.legal_name || null } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      settings: settings as Prisma.InputJsonValue,
      updated_at: new Date(),
    },
  });
  return getClinicMetadata(updated);
}

export async function setupStatus(): Promise<{ initialized: boolean }> {
  const count = await prisma.users.count();
  return { initialized: count > 0 };
}

// ---------------------------------------------------------------------------
// Onboarding (clinic.settings.onboarding)
// ---------------------------------------------------------------------------

export interface OnboardingStateDto {
  dismissed_at: string | null;
  completed_at: string | null;
  skipped: Record<string, string>;
}

function readOnboarding(settings: unknown): OnboardingStateDto {
  const state = ((settings as Record<string, unknown> | null)?.onboarding ?? {}) as Record<
    string,
    unknown
  >;
  const skipped = (state.skipped ?? {}) as Record<string, string>;
  return {
    dismissed_at: (state.dismissed_at as string | null | undefined) ?? null,
    completed_at: (state.completed_at as string | null | undefined) ?? null,
    skipped,
  };
}

export async function updateOnboardingState(
  clinicId: string,
  input: OnboardingPatchInput,
): Promise<OnboardingStateDto> {
  const clinic = await prisma.clinics.findUnique({ where: { id: clinicId } });
  if (!clinic) throw notFound('Clinic not found');

  const current = (clinic.settings as Record<string, unknown> | null) ?? {};
  const state = input.reset
    ? ({} as Record<string, unknown>)
    : { ...((current.onboarding as Record<string, unknown> | null) ?? {}) };
  const now = new Date().toISOString();

  if (input.dismissed !== undefined && input.dismissed !== null) {
    state.dismissed_at = input.dismissed ? now : null;
  }
  if (input.completed !== undefined && input.completed !== null) {
    state.completed_at = input.completed ? now : null;
  }

  const skipped = { ...((state.skipped as Record<string, string> | null) ?? {}) };
  for (const ruleId of input.skip ?? []) skipped[ruleId] = now;
  for (const ruleId of input.unskip ?? []) delete skipped[ruleId];
  state.skipped = skipped;

  const settings = { ...current, onboarding: state };
  await prisma.clinics.update({
    where: { id: clinicId },
    data: { settings: settings as Prisma.InputJsonValue, updated_at: new Date() },
  });

  return readOnboarding(settings);
}

// ---------------------------------------------------------------------------
// Budget & communications settings (clés de premier niveau de clinic.settings)
// ---------------------------------------------------------------------------

export interface BudgetSettingsDto {
  budget_expiry_days: number;
  plan_auto_close_days_after_expiry: number;
  budget_reminders_enabled: boolean;
  budget_public_auth_disabled: boolean;
}

function readBudgetSettings(settings: unknown): BudgetSettingsDto {
  const raw = (settings as Record<string, unknown> | null) ?? {};
  const intOr = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  };
  return {
    budget_expiry_days: intOr(raw.budget_expiry_days, 30),
    plan_auto_close_days_after_expiry: intOr(raw.plan_auto_close_days_after_expiry, 30),
    budget_reminders_enabled: Boolean(raw.budget_reminders_enabled ?? false),
    budget_public_auth_disabled: Boolean(raw.budget_public_auth_disabled ?? false),
  };
}

export async function getBudgetSettings(clinicId: string): Promise<BudgetSettingsDto> {
  const clinic = await prisma.clinics.findUnique({
    where: { id: clinicId },
    select: { settings: true },
  });
  if (!clinic) throw notFound('Clinic not found');
  return readBudgetSettings(clinic.settings);
}

export async function updateBudgetSettings(
  clinicId: string,
  input: BudgetSettingsPatchInput,
): Promise<BudgetSettingsDto> {
  const clinic = await prisma.clinics.findUnique({
    where: { id: clinicId },
    select: { settings: true },
  });
  if (!clinic) throw notFound('Clinic not found');

  const current = { ...((clinic.settings as Record<string, unknown> | null) ?? {}) };
  for (const [key, value] of Object.entries(input)) {
    // `exclude_unset` côté Python : null/false restent des valeurs à écrire,
    // mais un null explicite sur les entiers serait stocké puis relu en 500 ;
    // on l'ignore volontairement.
    if (value === undefined) continue;
    if (value === null && key !== 'budget_reminders_enabled' && key !== 'budget_public_auth_disabled') {
      continue;
    }
    current[key] = value;
  }

  const updated = await prisma.clinics.update({
    where: { id: clinicId },
    data: { settings: current as Prisma.InputJsonValue, updated_at: new Date() },
  });
  return readBudgetSettings(updated.settings);
}

export interface CommunicationsSettingsDto {
  language: string;
}

function readCommunicationsSettings(settings: unknown): CommunicationsSettingsDto {
  const raw = (settings as Record<string, unknown> | null) ?? {};
  return { language: String(raw.communication_language ?? 'es') };
}

export async function getCommunicationsSettings(
  clinicId: string,
): Promise<CommunicationsSettingsDto> {
  const clinic = await prisma.clinics.findUnique({
    where: { id: clinicId },
    select: { settings: true },
  });
  if (!clinic) throw notFound('Clinic not found');
  return readCommunicationsSettings(clinic.settings);
}

export async function updateCommunicationsSettings(
  clinicId: string,
  input: CommunicationsSettingsPatchInput,
): Promise<CommunicationsSettingsDto> {
  const clinic = await prisma.clinics.findUnique({
    where: { id: clinicId },
    select: { settings: true },
  });
  if (!clinic) throw notFound('Clinic not found');

  const current = { ...((clinic.settings as Record<string, unknown> | null) ?? {}) };
  if (input.language !== undefined && input.language !== null) {
    current.communication_language = input.language;
  }

  const updated = await prisma.clinics.update({
    where: { id: clinicId },
    data: { settings: current as Prisma.InputJsonValue, updated_at: new Date() },
  });
  return readCommunicationsSettings(updated.settings);
}
