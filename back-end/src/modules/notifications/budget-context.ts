import { prisma } from '../../lib/prisma';

/**
 * Contexte `treatments` rendu par `budget_sent.html` — port de
 * `budget_treatments_context` (`service.py`).
 *
 * Une seule implémentation : en Python le code existait à la fois dans
 * `handlers.py` et dans `router.py` et les copies avaient divergé (#527).
 * Les noms du catalogue sont lus en une requête `IN`, pas une par ligne.
 */

/** `CATALOG_NAME_PRIORITY` (`app/core/i18n_names.py`). */
export const CATALOG_NAME_PRIORITY = [
  'es',
  'en',
  'fr',
  'pt',
  'ta',
  'te',
  'hi',
  'de',
  'hu',
  'it',
  'pl',
  'ar',
] as const;

function usable(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * `catalog_name` : priorité linguistique puis n'importe quelle traduction
 * non vide ; `null` sinon. Les chaînes vides ou blanches comptent comme
 * absentes.
 */
export function catalogName(names: unknown): string | null {
  if (!names || typeof names !== 'object' || Array.isArray(names)) return null;
  const record = names as Record<string, unknown>;
  for (const lang of CATALOG_NAME_PRIORITY) {
    if (usable(record[lang])) return record[lang];
  }
  for (const value of Object.values(record)) {
    if (usable(value)) return value;
  }
  return null;
}

export interface BudgetTreatmentLine {
  name: string;
  tooth: number | null;
  price: number;
}

export async function budgetTreatmentsContext(
  clinicId: string,
  budgetId: string,
): Promise<BudgetTreatmentLine[]> {
  const items = await prisma.budget_items.findMany({
    where: { budget_id: budgetId, clinic_id: clinicId },
    orderBy: { display_order: 'asc' },
  });
  if (items.length === 0) return [];

  const catalogIds = [...new Set(items.map((item) => item.catalog_item_id).filter(Boolean))];
  const namesById = new Map<string, unknown>();
  if (catalogIds.length > 0) {
    const rows = await prisma.treatment_catalog_items.findMany({
      where: { id: { in: catalogIds } },
      select: { id: true, names: true },
    });
    for (const row of rows) namesById.set(row.id, row.names);
  }

  return items.map((item) => ({
    name: catalogName(namesById.get(item.catalog_item_id)) ?? 'Tratamiento',
    tooth: item.tooth_number,
    price: Number(item.line_total.toString()),
  }));
}
