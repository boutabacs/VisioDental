/**
 * Couche service du catalogue — port de `app/modules/catalog/service.py`.
 *
 * Les DTO reproduisent les schémas Pydantic (`VatTypeResponse`,
 * `CategoryResponse`, `CatalogItemResponse`, `CatalogItemBrief`,
 * `OdontogramTreatmentResponse`) : décimales sérialisées en nombres (floats
 * Python), JSON renvoyé tel quel, horodatages en ISO 8601.
 */

import crypto from 'node:crypto';

import { Prisma } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { getPreset } from '../auth/country-presets';
import {
  toDecimalString,
  validateSessionTemplate,
  type CatalogItemCreateInput,
  type CatalogItemUpdateInput,
  type CategoryCreateInput,
  type CategoryUpdateInput,
  type VatTypeCreateInput,
  type VatTypeUpdateInput,
} from './schemas';
import { CATEGORIES, TREATMENTS, VAT_PRESETS, seedUuid, type SeedVatType } from './seed';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface VatTypeDto {
  id: string;
  clinic_id: string;
  names: Record<string, string>;
  rate: number;
  legal_note: string | null;
  is_default: boolean;
  is_active: boolean;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface VatTypeBriefDto {
  id: string;
  names: Record<string, string>;
  rate: number;
  is_default: boolean;
  is_active: boolean;
  is_system: boolean;
}

export interface CategoryDto {
  id: string;
  clinic_id: string;
  parent_id: string | null;
  key: string;
  names: Record<string, string>;
  descriptions: Record<string, string> | null;
  display_order: number;
  icon: string | null;
  is_active: boolean;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface OdontogramMappingDto {
  id: string;
  odontogram_treatment_type: string;
  visualization_rules: unknown;
  visualization_config: unknown;
  clinical_category: string;
}

export interface CatalogSessionDto {
  id: string;
  sequence: number;
  labels: Record<string, string>;
  default_price: number;
}

export interface CatalogItemDto {
  id: string;
  clinic_id: string;
  category_id: string;
  internal_code: string;
  names: Record<string, string>;
  descriptions: Record<string, string> | null;
  default_price: number | null;
  cost_price: number | null;
  default_duration_minutes: number | null;
  requires_appointment: boolean;
  vat_type_id: string | null;
  vat_type: VatTypeBriefDto | null;
  pricing_strategy: string;
  pricing_config: unknown;
  surface_prices: Record<string, number> | null;
  treatment_scope: string;
  is_diagnostic: boolean;
  requires_surfaces: boolean;
  material_notes: string | null;
  is_active: boolean;
  is_system: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  category: CategoryDto | null;
  odontogram_mapping: OdontogramMappingDto | null;
  sessions: CatalogSessionDto[];
}

export interface CatalogItemBriefDto {
  id: string;
  internal_code: string;
  names: Record<string, string>;
  default_price: number | null;
  default_duration_minutes: number | null;
  is_active: boolean;
}

export interface OdontogramTreatmentDto {
  id: string;
  internal_code: string;
  names: Record<string, string>;
  default_price: number | null;
  treatment_scope: string;
  requires_surfaces: boolean;
  is_diagnostic: boolean;
  pricing_strategy: string;
  pricing_config: unknown;
  surface_prices: Record<string, number> | null;
  odontogram_treatment_type: string | null;
  visualization_rules: unknown[];
  visualization_config: unknown;
  clinical_category: string | null;
  category_key: string | null;
  category_names: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): Record<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as JsonRecord)) {
      result[key] = typeof item === 'string' ? item : String(item);
    }
    return result;
  }
  return {};
}

function asRecordOrNull(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined) return null;
  return asRecord(value);
}

/** Décimal PostgreSQL → float, comme `CatalogItemResponse.default_price`. */
export function decimalToNumber(value: Prisma.Decimal | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value.toString());
}

/** Map « clé → prix » JSONB → nombres (paliers de surfaces). */
export function numericMap(value: unknown): Record<string, number> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value as JsonRecord)) {
    const parsed = Number(toDecimalString(item) ?? '0');
    result[key] = parsed;
  }
  return result;
}

function jsonValue(value: Prisma.Decimal) {
  return Number(value.toString());
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// VAT types
// ---------------------------------------------------------------------------

type VatTypeRow = Prisma.vat_typesGetPayload<Record<string, never>>;
type CategoryRow = Prisma.treatment_categoriesGetPayload<Record<string, never>>;

export function toVatTypeDto(row: VatTypeRow): VatTypeDto {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    names: asRecord(row.names),
    rate: row.rate,
    legal_note: row.legal_note,
    is_default: row.is_default,
    is_active: row.is_active,
    is_system: row.is_system,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function toVatTypeBriefDto(row: VatTypeRow): VatTypeBriefDto {
  return {
    id: row.id,
    names: asRecord(row.names),
    rate: row.rate,
    is_default: row.is_default,
    is_active: row.is_active,
    is_system: row.is_system,
  };
}

export function toCategoryDto(row: CategoryRow): CategoryDto {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    parent_id: row.parent_id,
    key: row.key,
    names: asRecord(row.names),
    descriptions: asRecordOrNull(row.descriptions),
    display_order: row.display_order,
    icon: row.icon,
    is_active: row.is_active,
    is_system: row.is_system,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export async function listVatTypes(
  clinicId: string,
  includeInactive = false,
): Promise<VatTypeRow[]> {
  return prisma.vat_types.findMany({
    where: {
      clinic_id: clinicId,
      ...(includeInactive ? {} : { is_active: true }),
    },
    orderBy: [{ rate: 'asc' }, { created_at: 'asc' }],
  });
}

export async function getVatType(
  clinicId: string,
  vatTypeId: string,
): Promise<VatTypeRow | null> {
  return prisma.vat_types.findFirst({ where: { id: vatTypeId, clinic_id: clinicId } });
}

export async function getDefaultVatType(clinicId: string): Promise<VatTypeRow | null> {
  return prisma.vat_types.findFirst({
    where: { clinic_id: clinicId, is_default: true, is_active: true },
  });
}

async function unsetDefaultVatType(
  tx: Prisma.TransactionClient,
  clinicId: string,
  exceptId?: string,
): Promise<void> {
  await tx.vat_types.updateMany({
    where: {
      clinic_id: clinicId,
      is_default: true,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { is_default: false },
  });
}

export async function createVatType(
  clinicId: string,
  input: VatTypeCreateInput,
): Promise<VatTypeRow> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const id = crypto.randomUUID();
    if (input.is_default) await unsetDefaultVatType(tx, clinicId, id);

    return tx.vat_types.create({
      data: {
        id,
        clinic_id: clinicId,
        names: inputJson(input.names),
        rate: input.rate,
        legal_note: input.legal_note ?? null,
        is_default: input.is_default,
        is_active: true,
        is_system: false,
        created_at: now,
        updated_at: now,
      },
    });
  });
}

export async function updateVatType(
  clinicId: string,
  current: VatTypeRow,
  input: VatTypeUpdateInput,
): Promise<VatTypeRow> {
  // `null` = « non envoyé » (comme `if value is not None` côté Python) ; seul
  // `legal_note` est nullable en base.
  const data: Prisma.vat_typesUpdateInput = { updated_at: new Date() };
  if (input.names !== undefined && input.names !== null) data.names = inputJson(input.names);
  if (input.rate !== undefined && input.rate !== null) data.rate = input.rate;
  if (input.is_default !== undefined && input.is_default !== null) {
    data.is_default = input.is_default;
  }
  if (input.is_active !== undefined && input.is_active !== null) {
    data.is_active = input.is_active;
  }
  if (input.legal_note !== undefined) data.legal_note = input.legal_note;

  return prisma.$transaction(async (tx) => {
    if (input.is_default === true && !current.is_default) {
      await unsetDefaultVatType(tx, clinicId, current.id);
    }
    return tx.vat_types.update({ where: { id: current.id }, data });
  });
}

/** Suppression douce : désactivation (`is_active = false`). */
export async function deleteVatType(current: VatTypeRow): Promise<void> {
  await prisma.vat_types.update({
    where: { id: current.id },
    data: { is_active: false, updated_at: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Catégories
// ---------------------------------------------------------------------------

export async function listCategories(
  clinicId: string,
  includeInactive = false,
): Promise<CategoryRow[]> {
  return prisma.treatment_categories.findMany({
    where: {
      clinic_id: clinicId,
      ...(includeInactive ? {} : { is_active: true }),
    },
    orderBy: [{ display_order: 'asc' }, { key: 'asc' }],
  });
}

export async function getCategory(
  clinicId: string,
  categoryId: string,
  includeInactive = false,
): Promise<CategoryRow | null> {
  return prisma.treatment_categories.findFirst({
    where: {
      id: categoryId,
      clinic_id: clinicId,
      ...(includeInactive ? {} : { is_active: true }),
    },
  });
}

export async function getCategoryByKey(
  clinicId: string,
  key: string,
): Promise<CategoryRow | null> {
  return prisma.treatment_categories.findFirst({ where: { clinic_id: clinicId, key } });
}

function categoryCreateData(input: CategoryCreateInput) {
  return {
    parent_id: input.parent_id ?? null,
    key: input.key,
    names: inputJson(input.names),
    descriptions:
      input.descriptions === undefined || input.descriptions === null
        ? Prisma.JsonNull
        : inputJson(input.descriptions),
    display_order: input.display_order,
    icon: input.icon ?? null,
  };
}

export async function createCategory(
  clinicId: string,
  input: CategoryCreateInput,
): Promise<CategoryRow> {
  const now = new Date();
  return prisma.treatment_categories.create({
    data: {
      id: crypto.randomUUID(),
      clinic_id: clinicId,
      ...categoryCreateData(input),
      is_active: true,
      is_system: false,
      created_at: now,
      updated_at: now,
    },
  });
}

export async function updateCategory(
  current: CategoryRow,
  input: CategoryUpdateInput,
): Promise<CategoryRow> {
  // `null` = « non envoyé » : un parent ne peut pas être effacé par PUT.
  const parentId =
    input.parent_id !== undefined && input.parent_id !== null ? input.parent_id : undefined;
  // `exclude_unset` + `if value is not None` : seules les clés envoyées et
  // non nulles changent. `descriptions` est la seule nullable en base.
  const data: Prisma.treatment_categoriesUncheckedUpdateInput = { updated_at: new Date() };
  if (input.key !== undefined && input.key !== null) data.key = input.key;
  if (input.names !== undefined && input.names !== null) data.names = inputJson(input.names);
  if (input.descriptions !== undefined) {
    data.descriptions =
      input.descriptions === null ? Prisma.DbNull : inputJson(input.descriptions);
  }
  if (input.display_order !== undefined && input.display_order !== null) {
    data.display_order = input.display_order;
  }
  if (input.icon !== undefined && input.icon !== null) data.icon = input.icon;
  if (input.is_active !== undefined && input.is_active !== null) {
    data.is_active = input.is_active;
  }

  // `parent_id` (FK) n'existe que dans la variante *Unchecked* du type.
  if (parentId !== undefined) data.parent_id = parentId;

  return prisma.treatment_categories.update({ where: { id: current.id }, data });
}

/** Suppression douce d'une catégorie (`is_active = false`). */
export async function deleteCategory(current: CategoryRow): Promise<void> {
  await prisma.treatment_categories.update({
    where: { id: current.id },
    data: { is_active: false, updated_at: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const ITEM_INCLUDE = {
  treatment_categories: true,
  treatment_odontogram_mappings: true,
  vat_types: true,
  catalog_item_sessions: { orderBy: { sequence: 'asc' } },
} satisfies Prisma.treatment_catalog_itemsInclude;

export type CatalogItemRow = Prisma.treatment_catalog_itemsGetPayload<{
  include: typeof ITEM_INCLUDE;
}>;

export function toCatalogItemDto(row: CatalogItemRow): CatalogItemDto {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    category_id: row.category_id,
    internal_code: row.internal_code,
    names: asRecord(row.names),
    descriptions: asRecordOrNull(row.descriptions),
    default_price: decimalToNumber(row.default_price),
    cost_price: decimalToNumber(row.cost_price),
    default_duration_minutes: row.default_duration_minutes,
    requires_appointment: row.requires_appointment,
    vat_type_id: row.vat_type_id,
    vat_type: row.vat_types ? toVatTypeBriefDto(row.vat_types) : null,
    pricing_strategy: row.pricing_strategy,
    pricing_config: row.pricing_config,
    surface_prices: numericMap(row.surface_prices),
    treatment_scope: row.treatment_scope,
    is_diagnostic: row.is_diagnostic,
    requires_surfaces: row.requires_surfaces,
    material_notes: row.material_notes,
    is_active: row.is_active,
    is_system: row.is_system,
    deleted_at: row.deleted_at ? row.deleted_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    category: row.treatment_categories ? toCategoryDto(row.treatment_categories) : null,
    odontogram_mapping: row.treatment_odontogram_mappings
      ? {
          id: row.treatment_odontogram_mappings.id,
          odontogram_treatment_type:
            row.treatment_odontogram_mappings.odontogram_treatment_type,
          visualization_rules: row.treatment_odontogram_mappings.visualization_rules,
          visualization_config: row.treatment_odontogram_mappings.visualization_config,
          clinical_category: row.treatment_odontogram_mappings.clinical_category,
        }
      : null,
    sessions: row.catalog_item_sessions.map((session) => ({
      id: session.id,
      sequence: session.sequence,
      labels: asRecord(session.labels),
      default_price: jsonValue(session.default_price),
    })),
  };
}

export function toCatalogItemBriefDto(row: {
  id: string;
  internal_code: string;
  names: unknown;
  default_price: Prisma.Decimal | null;
  default_duration_minutes: number | null;
  is_active: boolean;
}): CatalogItemBriefDto {
  return {
    id: row.id,
    internal_code: row.internal_code,
    names: asRecord(row.names),
    default_price: decimalToNumber(row.default_price),
    default_duration_minutes: row.default_duration_minutes,
    is_active: row.is_active,
  };
}

export interface CatalogItemListFilters {
  page: number;
  pageSize: number;
  categoryId?: string | null;
  isActive?: boolean | null;
  treatmentScope?: string | null;
  hasOdontogramMapping?: boolean | null;
  search?: string | null;
}

export async function listItems(
  clinicId: string,
  filters: CatalogItemListFilters,
): Promise<{ rows: CatalogItemRow[]; total: number }> {
  const pageSize = Math.min(Math.max(filters.pageSize, 1), 100);
  const page = Math.max(filters.page, 1);

  const and: Prisma.treatment_catalog_itemsWhereInput[] = [
    { clinic_id: clinicId },
    { deleted_at: null },
  ];
  if (filters.isActive !== null && filters.isActive !== undefined) {
    and.push({ is_active: filters.isActive });
  }
  if (filters.categoryId) and.push({ category_id: filters.categoryId });
  if (filters.treatmentScope) and.push({ treatment_scope: filters.treatmentScope });
  if (filters.hasOdontogramMapping !== null && filters.hasOdontogramMapping !== undefined) {
    and.push(
      filters.hasOdontogramMapping
        ? { treatment_odontogram_mappings: { isNot: null } }
        : { treatment_odontogram_mappings: { is: null } },
    );
  }
  if (filters.search) {
    // Python : ILIKE sur `internal_code` ou sur le JSONB `names` casté en
    // text. Prisma ne sait pas caster un Json : on interroge les valeurs
    // texte des langues connues (`names` est toujours un objet plat).
    and.push({
      OR: [
        { internal_code: { contains: filters.search, mode: 'insensitive' } },
        { names: { path: [], string_contains: filters.search } },
      ],
    });
  }

  const where: Prisma.treatment_catalog_itemsWhereInput = { AND: and };
  const total = await prisma.treatment_catalog_items.count({ where });
  const rows = await prisma.treatment_catalog_items.findMany({
    where,
    include: ITEM_INCLUDE,
    orderBy: [{ category_id: 'asc' }, { internal_code: 'asc' }, { id: 'asc' }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return { rows, total };
}

export async function getItem(
  clinicId: string,
  itemId: string,
): Promise<CatalogItemRow | null> {
  return prisma.treatment_catalog_items.findFirst({
    where: { id: itemId, clinic_id: clinicId, deleted_at: null },
    include: ITEM_INCLUDE,
  });
}

export async function getItemByCode(
  clinicId: string,
  internalCode: string,
): Promise<CatalogItemRow | null> {
  return prisma.treatment_catalog_items.findFirst({
    where: { clinic_id: clinicId, internal_code: internalCode, deleted_at: null },
    include: ITEM_INCLUDE,
  });
}

function sessionRows(
  itemId: string,
  sessions: NonNullable<CatalogItemCreateInput['sessions']>,
) {
  const now = new Date();
  return sessions.map((session, index) => ({
    id: crypto.randomUUID(),
    catalog_item_id: itemId,
    sequence: session.sequence || index + 1,
    labels: inputJson(session.labels ?? {}),
    default_price: session.default_price,
    created_at: now,
    updated_at: now,
  }));
}

function mappingRow(
  clinicId: string,
  itemId: string,
  mapping: NonNullable<CatalogItemCreateInput['odontogram_mapping']>,
) {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    clinic_id: clinicId,
    catalog_item_id: itemId,
    odontogram_treatment_type: mapping.odontogram_treatment_type,
    visualization_rules: inputJson(mapping.visualization_rules ?? []),
    visualization_config: inputJson(mapping.visualization_config ?? {}),
    clinical_category: mapping.clinical_category,
    created_at: now,
    updated_at: now,
  };
}

export async function createItem(
  clinicId: string,
  input: CatalogItemCreateInput,
): Promise<CatalogItemRow> {
  const sessions = input.sessions ?? null;

  // Valide le modèle de séances contre le total de l'item (→ 422).
  validateSessionTemplate(input.default_price ?? null, sessions);

  let vatTypeId = input.vat_type_id ?? null;
  if (!vatTypeId) {
    const defaultVat = await getDefaultVatType(clinicId);
    if (defaultVat) vatTypeId = defaultVat.id;
  }

  const itemId = crypto.randomUUID();
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.treatment_catalog_items.create({
      data: {
        id: itemId,
        clinic_id: clinicId,
        category_id: input.category_id,
        internal_code: input.internal_code,
        names: inputJson(input.names),
        descriptions:
          input.descriptions === undefined || input.descriptions === null
            ? Prisma.JsonNull
            : inputJson(input.descriptions),
        default_price: input.default_price ?? null,
        cost_price: input.cost_price ?? null,
        default_duration_minutes: input.default_duration_minutes ?? null,
        requires_appointment: input.requires_appointment,
        vat_type_id: vatTypeId,
        pricing_strategy: input.pricing_strategy,
        pricing_config:
          input.pricing_config === undefined || input.pricing_config === null
            ? Prisma.JsonNull
            : inputJson(input.pricing_config),
        surface_prices:
          input.surface_prices === undefined || input.surface_prices === null
            ? Prisma.JsonNull
            : inputJson(input.surface_prices),
        treatment_scope: input.treatment_scope,
        is_diagnostic: input.is_diagnostic,
        requires_surfaces: input.requires_surfaces,
        billing_mode: 'on_completion',
        material_notes: input.material_notes ?? null,
        is_active: true,
        is_system: false,
        deleted_at: null,
        created_at: now,
        updated_at: now,
      },
    });

    if (input.odontogram_mapping) {
      await tx.treatment_odontogram_mappings.create({
        data: mappingRow(clinicId, itemId, input.odontogram_mapping),
      });
    }

    if (sessions && sessions.length > 0) {
      for (const row of sessionRows(itemId, sessions)) {
        await tx.catalog_item_sessions.create({ data: row });
      }
    }
  });

  const created = await getItem(clinicId, itemId);
  if (!created) throw new Error('Created catalog item could not be reloaded');
  return created;
}

/**
 * Met à jour un item.
 *
 * Sémantique de `sessions` : clé absente = modèle conservé ; clé présente
 * (liste, même vide) = remplacement atomique du modèle.
 */
export async function updateItem(
  clinicId: string,
  current: CatalogItemRow,
  input: CatalogItemUpdateInput,
): Promise<CatalogItemRow> {
  const provided = (key: keyof CatalogItemUpdateInput) =>
    Object.prototype.hasOwnProperty.call(input, key);
  const notNull = <T>(value: T | null | undefined): value is T =>
    value !== undefined && value !== null;

  const sessionsProvided = provided('sessions');
  const effectiveTotal = provided('default_price')
    ? (input.default_price ?? null)
    : decimalToNumber(current.default_price);
  if (sessionsProvided) {
    validateSessionTemplate(effectiveTotal, input.sessions ?? null);
  }

  const data: Prisma.treatment_catalog_itemsUpdateInput = { updated_at: new Date() };

  if (notNull(input.internal_code)) data.internal_code = input.internal_code;
  if (notNull(input.category_id)) {
    data.treatment_categories = { connect: { id: input.category_id } };
  }
  if (notNull(input.names)) data.names = inputJson(input.names);
  if (provided('descriptions')) {
    data.descriptions =
      input.descriptions === null ? Prisma.DbNull : inputJson(input.descriptions);
  }

  // Champs nullables : un `null` explicite efface la valeur (#740).
  if (provided('default_price')) data.default_price = input.default_price ?? null;
  if (provided('cost_price')) data.cost_price = input.cost_price ?? null;
  if (provided('default_duration_minutes')) {
    data.default_duration_minutes = input.default_duration_minutes ?? null;
  }

  if (notNull(input.requires_appointment)) {
    data.requires_appointment = input.requires_appointment;
  }
  if (provided('vat_type_id')) {
    data.vat_types = input.vat_type_id
      ? { connect: { id: input.vat_type_id } }
      : { disconnect: true };
  }
  if (notNull(input.pricing_strategy)) data.pricing_strategy = input.pricing_strategy;
  if (provided('pricing_config')) {
    data.pricing_config =
      input.pricing_config === null ? Prisma.DbNull : inputJson(input.pricing_config);
  }
  if (provided('surface_prices')) {
    data.surface_prices =
      input.surface_prices === null ? Prisma.DbNull : inputJson(input.surface_prices);
  }
  if (notNull(input.treatment_scope)) data.treatment_scope = input.treatment_scope;
  if (notNull(input.is_diagnostic)) data.is_diagnostic = input.is_diagnostic;
  if (notNull(input.requires_surfaces)) data.requires_surfaces = input.requires_surfaces;
  if (notNull(input.material_notes)) data.material_notes = input.material_notes;
  if (notNull(input.is_active)) data.is_active = input.is_active;

  await prisma.$transaction(async (tx) => {
    await tx.treatment_catalog_items.update({ where: { id: current.id }, data });

    const mapping = input.odontogram_mapping;
    if (mapping) {
      const existing = await tx.treatment_odontogram_mappings.findUnique({
        where: { catalog_item_id: current.id },
      });
      if (existing) {
        await tx.treatment_odontogram_mappings.update({
          where: { id: existing.id },
          data: {
            odontogram_treatment_type: mapping.odontogram_treatment_type,
            visualization_rules: inputJson(mapping.visualization_rules ?? []),
            visualization_config: inputJson(mapping.visualization_config ?? {}),
            clinical_category: mapping.clinical_category,
            updated_at: new Date(),
          },
        });
      } else {
        await tx.treatment_odontogram_mappings.create({
          data: mappingRow(clinicId, current.id, mapping),
        });
      }
    }

    if (sessionsProvided) {
      await tx.catalog_item_sessions.deleteMany({ where: { catalog_item_id: current.id } });
      const rows = sessionRows(current.id, input.sessions ?? []);
      for (const row of rows) {
        await tx.catalog_item_sessions.create({ data: row });
      }
    }
  });

  const updated = await getItem(clinicId, current.id);
  if (!updated) throw new Error('Updated catalog item could not be reloaded');
  return updated;
}

/** Suppression douce : `deleted_at` + `is_active = false`, le code est libéré. */
export async function deleteItem(current: CatalogItemRow): Promise<void> {
  const now = new Date();
  await prisma.treatment_catalog_items.update({
    where: { id: current.id },
    data: { deleted_at: now, is_active: false, updated_at: now },
  });
}

export async function searchItems(
  clinicId: string,
  query: string,
  limit = 20,
): Promise<CatalogItemRow[]> {
  return prisma.treatment_catalog_items.findMany({
    where: {
      AND: [
        { clinic_id: clinicId },
        { is_active: true },
        { deleted_at: null },
        {
          OR: [
            { internal_code: { contains: query, mode: 'insensitive' } },
            { names: { path: [], string_contains: query } },
          ],
        },
      ],
    },
    include: ITEM_INCLUDE,
    take: limit,
  });
}

/**
 * Items populaires par nombre d'utilisations dans les budgets / factures.
 * Lecture des tables sœurs (`budget_items`, `invoice_items`) via une requête
 * brute — même union SQL que Python, sans importer les modules budget/billing.
 * Repli « démarrage à froid » : items actifs les plus récents.
 */
export async function getPopularItems(
  clinicId: string,
  limit = 8,
): Promise<CatalogItemRow[]> {
  const usage = await prisma.$queryRaw<Array<{ catalog_item_id: string; n: bigint }>>`
    SELECT catalog_item_id, COUNT(*) AS n
    FROM (
      SELECT catalog_item_id FROM budget_items
      WHERE clinic_id = ${clinicId}::uuid
        AND catalog_item_id IS NOT NULL
      UNION ALL
      SELECT catalog_item_id FROM invoice_items
      WHERE clinic_id = ${clinicId}::uuid
        AND catalog_item_id IS NOT NULL
    ) AS usage
    GROUP BY catalog_item_id
    ORDER BY n DESC
    LIMIT ${limit}
  `;

  const rankedIds = usage.map((row) => row.catalog_item_id);

  const include = {
    treatment_categories: true,
    treatment_odontogram_mappings: true,
    vat_types: true,
    catalog_item_sessions: { orderBy: { sequence: 'asc' } },
  } satisfies Prisma.treatment_catalog_itemsInclude;

  if (rankedIds.length === 0) {
    return prisma.treatment_catalog_items.findMany({
      where: { clinic_id: clinicId, is_active: true, deleted_at: null },
      include,
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  const rows = await prisma.treatment_catalog_items.findMany({
    where: {
      clinic_id: clinicId,
      id: { in: rankedIds },
      is_active: true,
      deleted_at: null,
    },
    include,
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return rankedIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

// ---------------------------------------------------------------------------
// Intégration odontogramme
// ---------------------------------------------------------------------------

export async function getOdontogramTreatments(
  clinicId: string,
): Promise<OdontogramTreatmentDto[]> {
  const items = await prisma.treatment_catalog_items.findMany({
    where: { clinic_id: clinicId, is_active: true, deleted_at: null },
    include: { treatment_categories: true, treatment_odontogram_mappings: true },
  });

  // Items mappés (dessinables) + items globaux non mappés (proposés au plan).
  // Les items « tooth »/« multi_tooth » non mappés restent exclus : ni
  // visualisables, ni applicables.
  const treatments: OdontogramTreatmentDto[] = [];
  for (const item of items) {
    const mapping = item.treatment_odontogram_mappings;
    if (!mapping && item.treatment_scope !== 'global_mouth' && item.treatment_scope !== 'global_arch') {
      continue;
    }
    treatments.push({
      id: item.id,
      internal_code: item.internal_code,
      names: asRecord(item.names),
      default_price: item.default_price ? Number(item.default_price.toString()) : null,
      treatment_scope: item.treatment_scope,
      requires_surfaces: item.requires_surfaces,
      is_diagnostic: item.is_diagnostic,
      pricing_strategy: item.pricing_strategy || 'flat',
      pricing_config: (item.pricing_config ?? null) as unknown,
      surface_prices: numericMap(item.surface_prices),
      odontogram_treatment_type: mapping ? mapping.odontogram_treatment_type : null,
      visualization_rules: (mapping ? (mapping.visualization_rules as unknown[]) : []) ?? [],
      visualization_config: mapping ? mapping.visualization_config : {},
      clinical_category: mapping ? mapping.clinical_category : null,
      category_key: item.treatment_categories ? item.treatment_categories.key : null,
      category_names: item.treatment_categories ? asRecord(item.treatment_categories.names) : {},
    });
  }
  return treatments;
}

export async function getTreatmentsByCategory(
  clinicId: string,
): Promise<Record<string, OdontogramTreatmentDto[]>> {
  const treatments = await getOdontogramTreatments(clinicId);
  const grouped: Record<string, OdontogramTreatmentDto[]> = {};
  for (const treatment of treatments) {
    const category = treatment.clinical_category;
    if (category === null) continue;
    (grouped[category] ??= []).push(treatment);
  }
  return grouped;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export interface SeedSummary {
  categories: number;
  items: number;
  vat_types: number;
}

function clinicCountry(settings: unknown): string | null {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const country = (settings as JsonRecord).country;
    if (typeof country === 'string') return country;
  }
  return null;
}

/**
 * Seed idempotent : seules les lignes manquantes sont ajoutées.
 * ``with_prices=False`` met tous les prix à zéro (devises hors EUR).
 */
export async function seedCatalog(
  clinicId: string,
  vatPreset = 'es',
  withPrices = true,
): Promise<SeedSummary> {
  const presets = (VAT_PRESETS[vatPreset] ?? VAT_PRESETS.generic) as SeedVatType[];

  return prisma.$transaction(async (tx) => {
    const vatTypeMap = new Map<string, string>();
    let vatTypesCreated = 0;

    for (const vat of presets) {
      // Un taux n'est pas unique par clinique : réutiliser la ligne système
      // puis la ligne active, comme `_ensure_vat_types`.
      const existing = await tx.vat_types.findFirst({
        where: { clinic_id: clinicId, rate: vat.rate },
        orderBy: [{ is_system: 'desc' }, { is_active: 'desc' }, { created_at: 'asc' }, { id: 'asc' }],
      });
      if (existing) {
        vatTypeMap.set(vat.key, existing.id);
        continue;
      }
      const now = new Date();
      const created = await tx.vat_types.create({
        data: {
          id: seedUuid('vat', clinicId, vat.key),
          clinic_id: clinicId,
          names: inputJson(vat.names),
          rate: vat.rate,
          legal_note: vat.legal_note ?? null,
          is_default: vat.is_default,
          is_active: true,
          is_system: true,
          created_at: now,
          updated_at: now,
        },
      });
      vatTypeMap.set(vat.key, created.id);
      vatTypesCreated += 1;
    }

    let categoriesCreated = 0;
    const categoryMap = new Map<string, string>();

    for (const category of CATEGORIES) {
      const existing = await tx.treatment_categories.findFirst({
        where: { clinic_id: clinicId, key: category.key },
      });
      if (existing) {
        categoryMap.set(category.key, existing.id);
        continue;
      }
      const now = new Date();
      const created = await tx.treatment_categories.create({
        data: {
          id: seedUuid('category', clinicId, category.key),
          clinic_id: clinicId,
          parent_id: null,
          key: category.key,
          names: inputJson(category.names),
          descriptions: inputJson(category.descriptions),
          display_order: category.display_order,
          icon: category.icon,
          is_active: true,
          is_system: true,
          created_at: now,
          updated_at: now,
        },
      });
      categoryMap.set(category.key, created.id);
      categoriesCreated += 1;
    }

    let itemsCreated = 0;

    for (const [categoryKey, treatments] of Object.entries(TREATMENTS)) {
      const categoryId = categoryMap.get(categoryKey);
      if (!categoryId) continue;

      for (const treatment of treatments) {
        const existing = await tx.treatment_catalog_items.findFirst({
          where: { clinic_id: clinicId, internal_code: treatment.internal_code },
        });
        // Une ligne supprimée peut partager le code (#736) : on l'ignore aussi.
        if (existing) continue;

        const vatKey = treatment.vat_type ?? 'exempt';
        const vatTypeId = vatTypeMap.get(vatKey) ?? vatTypeMap.get('exempt') ?? null;

        const zero = (value: number | undefined) =>
          value === undefined || value === null ? null : withPrices ? value : 0;
        const priceMap = (map: Record<string, number> | undefined) => {
          if (!map) return Prisma.JsonNull;
          if (withPrices) return inputJson(map);
          return inputJson(Object.fromEntries(Object.keys(map).map((key) => [key, 0])));
        };
        const pricingConfig = treatment.pricing_config
          ? inputJson(
              withPrices
                ? treatment.pricing_config
                : Object.fromEntries(
                    Object.entries(treatment.pricing_config).map(([key, value]) => [
                      key,
                      typeof value === 'number' ? 0 : value,
                    ]),
                  ),
            )
          : Prisma.JsonNull;

        const itemId = seedUuid('item', clinicId, treatment.internal_code);
        const now = new Date();

        await tx.treatment_catalog_items.create({
          data: {
            id: itemId,
            clinic_id: clinicId,
            category_id: categoryId,
            internal_code: treatment.internal_code,
            names: inputJson(treatment.names),
            descriptions: treatment.descriptions
              ? inputJson(treatment.descriptions)
              : Prisma.JsonNull,
            default_price: zero(treatment.default_price),
            cost_price: null,
            default_duration_minutes: treatment.default_duration_minutes ?? null,
            requires_appointment: true,
            vat_type_id: vatTypeId,
            pricing_strategy: treatment.pricing_strategy ?? 'flat',
            pricing_config: pricingConfig,
            surface_prices: priceMap(treatment.surface_prices),
            treatment_scope: treatment.treatment_scope,
            is_diagnostic: treatment.is_diagnostic ?? false,
            requires_surfaces: treatment.requires_surfaces ?? false,
            billing_mode: 'on_completion',
            material_notes: null,
            is_active: true,
            is_system: true,
            deleted_at: null,
            created_at: now,
            updated_at: now,
          },
        });

        if (treatment.odontogram_treatment_type && treatment.visualization_rules) {
          await tx.treatment_odontogram_mappings.create({
            data: {
              id: seedUuid('mapping', clinicId, treatment.internal_code),
              clinic_id: clinicId,
              catalog_item_id: itemId,
              odontogram_treatment_type: treatment.odontogram_treatment_type,
              visualization_rules: inputJson(treatment.visualization_rules),
              visualization_config: inputJson(treatment.visualization_config ?? {}),
              clinical_category: categoryKey,
              created_at: now,
              updated_at: now,
            },
          });
        }

        if (treatment.sessions) {
          for (const [index, session] of treatment.sessions.entries()) {
            await tx.catalog_item_sessions.create({
              data: {
                id: seedUuid('session', clinicId, treatment.internal_code, String(index + 1)),
                catalog_item_id: itemId,
                sequence: index + 1,
                labels: inputJson(session.labels ?? {}),
                default_price: withPrices ? session.default_price : 0,
                created_at: now,
                updated_at: now,
              },
            });
          }
        }

        itemsCreated += 1;
      }
    }

    return { categories: categoriesCreated, items: itemsCreated, vat_types: vatTypesCreated };
  });
}

/**
 * Seed par défaut d'une clinique, dérivé de son pays / devise. Point
 * d'entrée unique de `POST /catalog/seed`.
 */
export async function seedClinicDefaults(clinicId: string): Promise<SeedSummary> {
  const clinic = await prisma.clinics.findUnique({ where: { id: clinicId } });
  if (!clinic) throw new Error(`Clinic ${clinicId} not found`);

  const preset = getPreset(clinicCountry(clinic.settings));
  // Les prix de référence sont des montants EUR espagnols : sans objet dans
  // une autre devise.
  return seedCatalog(clinicId, preset.vat_preset, clinic.currency === 'EUR');
}
