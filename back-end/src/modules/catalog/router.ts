/**
 * Routes du catalogue — port de `app/modules/catalog/router.py`.
 *
 * Permissions : `catalog.read`, `catalog.write`, `catalog.admin`.
 * Enveloppes FastAPI (`{data}`, `{data,total,page,page_size}`), codes 201/204,
 * messages d'erreur repris mot pour mot.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';

import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { ok, paginated } from '../../lib/http';
import { authenticate, requireClinic, requirePermission } from '../../middleware/auth';
import {
  catalogItemCreateSchema,
  catalogItemUpdateSchema,
  categoryCreateSchema,
  categoryUpdateSchema,
  lockedFieldChanges,
  vatTypeCreateSchema,
  vatTypeUpdateSchema,
  type CatalogItemUpdateInput,
} from './schemas';
import {
  createCategory,
  createItem,
  createVatType,
  deleteCategory,
  deleteItem,
  deleteVatType,
  getCategory,
  getCategoryByKey,
  getDefaultVatType,
  getItem,
  getItemByCode,
  getOdontogramTreatments,
  getPopularItems,
  getTreatmentsByCategory,
  getVatType,
  listCategories,
  listItems,
  listVatTypes,
  searchItems,
  seedClinicDefaults,
  toCatalogItemBriefDto,
  toCatalogItemDto,
  toCategoryDto,
  toVatTypeDto,
  updateCategory,
  updateItem,
  updateVatType,
} from './service';

export const catalogRouter = Router();

const uuid = z.string().uuid();

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function queryInt(req: Request, key: string, fallback: number): number {
  const parsed = Number.parseInt(queryString(req, key) ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Booléen de requête façon Pydantic (`true/false/1/0/yes/no/on/off`). */
function queryBool(req: Request, key: string, fallback: boolean | null = null): boolean | null {
  const value = queryString(req, key)?.trim().toLowerCase();
  if (value === undefined || value === '') return fallback;
  if (['true', '1', 'yes', 'on', 't', 'y'].includes(value)) return true;
  if (['false', '0', 'no', 'off', 'f', 'n'].includes(value)) return false;
  return fallback;
}

/** Valide un id de chemin (UUID) — un id malformé est un 422. */
function pathId(value: string | string[] | undefined): string {
  return uuid.parse(Array.isArray(value) ? value[0] : value);
}

/** 400 exigé par `_check_parent` : parent de la clinique, hors cycle. */
async function checkParent(
  clinicId: string,
  parentId: string,
  moving: string | null = null,
): Promise<void> {
  const seen = new Set<string>();
  let current: string | null | undefined = parentId;
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (moving !== null && current === moving) {
      throw badRequest("A category can't be its own parent or descendant");
    }
    seen.add(current);
    const node = await getCategory(clinicId, current, true);
    if (node === null) throw badRequest('Parent category not found');
    current = node.parent_id;
  }
}

/** 400 exigé par `_check_vat_type` : type de TVA de la clinique. */
async function checkVatType(clinicId: string, vatTypeId: string): Promise<void> {
  if (!(await getVatType(clinicId, vatTypeId))) {
    throw badRequest('VAT type not found');
  }
}

// ---------------------------------------------------------------------------
// Catégories
// ---------------------------------------------------------------------------

catalogRouter.get(
  '/categories',
  authenticate,
  requireClinic,
  requirePermission('catalog.read'),
  async (req, res) => {
    const includeInactive = queryBool(req, 'include_inactive', false) ?? false;
    const rows = await listCategories(req.clinicId!, includeInactive);
    res.json(ok(rows.map(toCategoryDto)));
  },
);

catalogRouter.get(
  '/categories/:categoryId',
  authenticate,
  requireClinic,
  requirePermission('catalog.read'),
  async (req, res) => {
    const categoryId = pathId(req.params.categoryId);
    const category = await getCategory(req.clinicId!, categoryId);
    if (!category) throw notFound('Category not found');
    res.json(ok(toCategoryDto(category)));
  },
);

catalogRouter.post(
  '/categories',
  authenticate,
  requireClinic,
  requirePermission('catalog.admin'),
  async (req, res) => {
    const input = categoryCreateSchema.parse(req.body);

    const existing = await getCategoryByKey(req.clinicId!, input.key);
    if (existing) throw conflict(`Category with key '${input.key}' already exists`);

    if (input.parent_id) await checkParent(req.clinicId!, input.parent_id);

    const category = await createCategory(req.clinicId!, input);
    res.status(201).json(ok(toCategoryDto(category)));
  },
);

catalogRouter.put(
  '/categories/:categoryId',
  authenticate,
  requireClinic,
  requirePermission('catalog.admin'),
  async (req, res) => {
    const categoryId = pathId(req.params.categoryId);
    const category = await getCategory(req.clinicId!, categoryId, true);
    if (!category) throw notFound('Category not found');

    if (category.is_system) throw forbidden('Cannot modify system category');

    const input = categoryUpdateSchema.parse(req.body);

    if (input.key && input.key !== category.key) {
      const existing = await getCategoryByKey(req.clinicId!, input.key);
      if (existing) throw conflict(`Category with key '${input.key}' already exists`);
    }

    if (input.parent_id && input.parent_id !== category.parent_id) {
      await checkParent(req.clinicId!, input.parent_id, category.id);
    }

    const updated = await updateCategory(category, input);
    res.json(ok(toCategoryDto(updated)));
  },
);

catalogRouter.delete(
  '/categories/:categoryId',
  authenticate,
  requireClinic,
  requirePermission('catalog.admin'),
  async (req, res) => {
    const categoryId = pathId(req.params.categoryId);
    const category = await getCategory(req.clinicId!, categoryId);
    if (!category) throw notFound('Category not found');

    if (category.is_system) throw forbidden('Cannot delete system category');

    await deleteCategory(category);
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Types de TVA
// ---------------------------------------------------------------------------

catalogRouter.get(
  '/vat-types',
  authenticate,
  requireClinic,
  requirePermission('catalog.read'),
  async (req, res) => {
    const includeInactive = queryBool(req, 'include_inactive', false) ?? false;
    const rows = await listVatTypes(req.clinicId!, includeInactive);
    res.json(ok(rows.map(toVatTypeDto)));
  },
);

// Déclaré avant `/vat-types/:vatTypeId` (Express 5 ne gère pas les conflits).
catalogRouter.get(
  '/vat-types/default',
  authenticate,
  requireClinic,
  requirePermission('catalog.read'),
  async (req, res) => {
    const vatType = await getDefaultVatType(req.clinicId!);
    res.json(ok(vatType ? toVatTypeDto(vatType) : null));
  },
);

catalogRouter.get(
  '/vat-types/:vatTypeId',
  authenticate,
  requireClinic,
  requirePermission('catalog.read'),
  async (req, res) => {
    const vatTypeId = pathId(req.params.vatTypeId);
    const vatType = await getVatType(req.clinicId!, vatTypeId);
    if (!vatType) throw notFound('VAT type not found');
    res.json(ok(toVatTypeDto(vatType)));
  },
);

catalogRouter.post(
  '/vat-types',
  authenticate,
  requireClinic,
  requirePermission('catalog.admin'),
  async (req, res) => {
    const input = vatTypeCreateSchema.parse(req.body);
    const vatType = await createVatType(req.clinicId!, input);
    res.status(201).json(ok(toVatTypeDto(vatType)));
  },
);

catalogRouter.put(
  '/vat-types/:vatTypeId',
  authenticate,
  requireClinic,
  requirePermission('catalog.admin'),
  async (req, res) => {
    const vatTypeId = pathId(req.params.vatTypeId);
    const vatType = await getVatType(req.clinicId!, vatTypeId);
    if (!vatType) throw notFound('VAT type not found');

    const parsed = vatTypeUpdateSchema.parse(req.body);
    const provided = parsed as Record<string, unknown>;

    if (vatType.is_system) {
      // Types système : taux et noms verrouillés, mais le drapeau par défaut
      // et la note légale facture restent la propriété de la clinique (#237).
      const allowed = new Set(['is_default', 'legal_note']);
      const updateData: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(provided)) {
        if (allowed.has(key)) updateData[key] = value;
      }
      if (Object.keys(updateData).length === 0) {
        throw forbidden(
          'Cannot modify system VAT type (only default status can be changed)',
        );
      }
      const updated = await updateVatType(req.clinicId!, vatType, updateData);
      res.json(ok(toVatTypeDto(updated)));
      return;
    }

    const updated = await updateVatType(req.clinicId!, vatType, parsed);
    res.json(ok(toVatTypeDto(updated)));
  },
);

catalogRouter.delete(
  '/vat-types/:vatTypeId',
  authenticate,
  requireClinic,
  requirePermission('catalog.admin'),
  async (req, res) => {
    const vatTypeId = pathId(req.params.vatTypeId);
    const vatType = await getVatType(req.clinicId!, vatTypeId);
    if (!vatType) throw notFound('VAT type not found');

    if (vatType.is_system) throw forbidden('Cannot delete system VAT type');

    if (vatType.is_default) {
      throw badRequest(
        'Cannot delete the default VAT type. Set another VAT type as default first.',
      );
    }

    await deleteVatType(vatType);
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Items du catalogue
// ---------------------------------------------------------------------------

catalogRouter.get(
  '/items',
  authenticate,
  requireClinic,
  requirePermission('catalog.read'),
  async (req, res) => {
    const page = Math.max(queryInt(req, 'page', 1), 1);
    const pageSize = Math.min(Math.max(queryInt(req, 'page_size', 20), 1), 500);
    const categoryId = queryString(req, 'category_id');
    if (categoryId) uuid.parse(categoryId);

    const result = await listItems(req.clinicId!, {
      page,
      pageSize,
      categoryId: categoryId ?? null,
      isActive: queryBool(req, 'is_active', true),
      treatmentScope: queryString(req, 'treatment_scope') ?? null,
      hasOdontogramMapping: queryBool(req, 'has_odontogram_mapping', null),
      search: queryString(req, 'search') ?? null,
    });

    res.json(paginated(result.rows.map(toCatalogItemDto), result.total, page, pageSize));
  },
);

catalogRouter.get(
  '/items/popular',
  authenticate,
  requireClinic,
  requirePermission('catalog.read'),
  async (req, res) => {
    const limit = Math.min(Math.max(queryInt(req, 'limit', 8), 1), 20);
    const rows = await getPopularItems(req.clinicId!, limit);
    res.json(ok(rows.map(toCatalogItemBriefDto)));
  },
);

catalogRouter.get(
  '/items/search',
  authenticate,
  requireClinic,
  requirePermission('catalog.read'),
  async (req, res) => {
    // `q` est un paramètre requis (1 à 100 caractères) : absent → 422.
    const q = z.string().min(1).max(100).parse(queryString(req, 'q'));
    const limit = Math.min(Math.max(queryInt(req, 'limit', 20), 1), 50);
    const rows = await searchItems(req.clinicId!, q, limit);
    res.json(ok(rows.map(toCatalogItemBriefDto)));
  },
);

catalogRouter.get(
  '/items/:itemId',
  authenticate,
  requireClinic,
  requirePermission('catalog.read'),
  async (req, res) => {
    const itemId = pathId(req.params.itemId);
    const item = await getItem(req.clinicId!, itemId);
    if (!item) throw notFound('Catalog item not found');
    res.json(ok(toCatalogItemDto(item)));
  },
);

catalogRouter.post(
  '/items',
  authenticate,
  requireClinic,
  requirePermission('catalog.write'),
  async (req, res) => {
    const input = catalogItemCreateSchema.parse(req.body);

    const category = await getCategory(req.clinicId!, input.category_id);
    if (!category) throw badRequest('Category not found');

    if (input.vat_type_id) await checkVatType(req.clinicId!, input.vat_type_id);

    const existing = await getItemByCode(req.clinicId!, input.internal_code);
    if (existing) {
      throw conflict(`Item with code '${input.internal_code}' already exists`);
    }

    // `SessionTemplateError` (restée telle quelle) → 422 par le handler global.
    const item = await createItem(req.clinicId!, input);
    res.status(201).json(ok(toCatalogItemDto(item)));
  },
);

catalogRouter.put(
  '/items/:itemId',
  authenticate,
  requireClinic,
  requirePermission('catalog.write'),
  async (req, res) => {
    const itemId = pathId(req.params.itemId);
    const item = await getItem(req.clinicId!, itemId);
    if (!item) throw notFound('Catalog item not found');

    const input = catalogItemUpdateSchema.parse(req.body);

    if (item.is_system) {
      // Le modal renvoie tout le formulaire : on ne refuse que si un champ
      // verrouillé change réellement (#237).
      const current: Record<string, unknown> = {
        internal_code: item.internal_code,
        category_id: item.category_id,
        pricing_strategy: item.pricing_strategy,
        treatment_scope: item.treatment_scope,
        is_diagnostic: item.is_diagnostic,
        requires_surfaces: item.requires_surfaces,
      };
      const changed = lockedFieldChanges(
        current,
        input as Record<string, unknown>,
      );
      if (changed.length > 0) {
        throw forbidden(`Cannot modify system catalog item fields: ${JSON.stringify(changed)}`);
      }
      // Le mapping seedé est conservé.
      delete (input as CatalogItemUpdateInput).odontogram_mapping;
    }

    if (input.category_id && input.category_id !== item.category_id) {
      const category = await getCategory(req.clinicId!, input.category_id);
      if (!category) throw badRequest('Category not found');
    }

    if (input.vat_type_id && input.vat_type_id !== item.vat_type_id) {
      await checkVatType(req.clinicId!, input.vat_type_id);
    }

    if (input.internal_code && input.internal_code !== item.internal_code) {
      const existing = await getItemByCode(req.clinicId!, input.internal_code);
      if (existing) {
        throw conflict(`Item with code '${input.internal_code}' already exists`);
      }
    }

    const updated = await updateItem(req.clinicId!, item, input);
    res.json(ok(toCatalogItemDto(updated)));
  },
);

catalogRouter.delete(
  '/items/:itemId',
  authenticate,
  requireClinic,
  requirePermission('catalog.write'),
  async (req, res) => {
    const itemId = pathId(req.params.itemId);
    const item = await getItem(req.clinicId!, itemId);
    if (!item) throw notFound('Catalog item not found');

    if (item.is_system) throw forbidden('Cannot delete system catalog item');

    await deleteItem(item);
    res.status(204).end();
  },
);

// ---------------------------------------------------------------------------
// Intégration odontogramme
// ---------------------------------------------------------------------------

catalogRouter.get(
  '/odontogram-treatments',
  authenticate,
  requireClinic,
  requirePermission('catalog.read'),
  async (req, res) => {
    const treatments = await getOdontogramTreatments(req.clinicId!);
    res.json(ok(treatments));
  },
);

catalogRouter.get(
  '/odontogram-treatments/by-category',
  authenticate,
  requireClinic,
  requirePermission('catalog.read'),
  async (req, res) => {
    const grouped = await getTreatmentsByCategory(req.clinicId!);
    res.json(ok(grouped));
  },
);

// ---------------------------------------------------------------------------
// Seed du catalogue par défaut
// ---------------------------------------------------------------------------

catalogRouter.post(
  '/seed',
  authenticate,
  requireClinic,
  requirePermission('catalog.admin'),
  async (req, res) => {
    const summary = await seedClinicDefaults(req.clinicId!);
    res.json(ok(summary));
  },
);
