/**
 * Charge les données de démo VisioDental (port de `backend/scripts/seed_demo.py`).
 *
 * Le jeu de données est un instantané JSON de la clinique de démonstration
 * (`prisma/seed-data/demo.json`) : clinique, utilisateurs (mot de passe
 * `demo1234`), patients + dossier clinique, catalogue, odontogramme, plans,
 * budgets, rendez-vous, factures et réglages RBAC/modules.
 *
 *   npx tsx src/scripts/seed.ts          # depuis back-end/
 *   npm run seed                         # depuis la racine du dépôt
 *
 * Idempotent : si la clinique de démo existe déjà, ne touche à rien.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Prisma } from '@prisma/client';

import { prisma } from '../lib/prisma';

type Row = Record<string, unknown>;
type Fixture = Record<string, Row[]>;

const FIXTURE_PATH = path.resolve(__dirname, '../../prisma/seed-data/demo.json');
const DEMO_CLINIC_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const CHUNK_SIZE = 200;

const modelByName = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [model.name, model] as const),
);

/** Ordre d'insertion : une table après toutes celles qu'elle référence. */
function insertionOrder(tables: string[]): string[] {
  const present = new Set(tables);
  const deps = new Map<string, string[]>();
  for (const table of tables) {
    const model = modelByName.get(table);
    const targets: string[] = [];
    for (const field of model?.fields ?? []) {
      if (
        field.kind === 'object' &&
        field.relationFromFields &&
        field.relationFromFields.length > 0 &&
        present.has(field.type) &&
        // Auto-référence (parent_id, credit_note_for_id…) : différée après
        // l'insertion, sinon l'ordre ne peut pas être calculé.
        field.type !== table
      ) {
        targets.push(field.type);
      }
    }
    deps.set(table, targets);
  }

  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (table: string) => {
    const current = state.get(table);
    if (current === 'done') return;
    if (current === 'visiting') {
      throw new Error(`Cycle de clés étrangères détecté autour de ${table}`);
    }
    state.set(table, 'visiting');
    for (const dep of deps.get(table) ?? []) visit(dep);
    state.set(table, 'done');
    order.push(table);
  };
  for (const table of tables) visit(table);
  return order;
}

/** Restaure les types Prisma (dates, gros entiers) depuis le JSON. */
function restoreRow(table: string, row: Row): Row {
  const model = modelByName.get(table);
  if (!model) return row;
  const result: Row = { ...row };
  for (const field of model.fields) {
    if (field.kind !== 'scalar' && field.kind !== 'enum') continue;
    const value = result[field.name];
    if (value === null || value === undefined) continue;
    if (field.type === 'DateTime') {
      result[field.name] = new Date(value as string);
    } else if (field.type === 'BigInt') {
      result[field.name] = BigInt(value as string);
    } else if (field.type === 'Bytes') {
      const buffer = value as { type: 'Buffer'; data: number[] };
      result[field.name] = Buffer.from(buffer.data);
    }
  }
  return result;
}

function delegateFor(table: string): {
  createMany: (args: unknown) => Promise<unknown>;
  update: (args: unknown) => Promise<unknown>;
} {
  const delegate = (prisma as unknown as Record<string, unknown>)[table];
  if (
    !delegate ||
    typeof (delegate as { createMany?: unknown }).createMany !== 'function' ||
    typeof (delegate as { update?: unknown }).update !== 'function'
  ) {
    throw new Error(`Modèle Prisma inconnu : ${table}`);
  }
  return delegate as {
    createMany: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  };
}

/** Colonnes FK d'une relation vers la même table (ex. `parent_id`). */
function selfForeignKeyFields(table: string): string[] {
  const model = modelByName.get(table);
  const fields: string[] = [];
  for (const field of model?.fields ?? []) {
    if (
      field.kind === 'object' &&
      field.type === table &&
      field.relationFromFields &&
      field.relationFromFields.length > 0
    ) {
      fields.push(...field.relationFromFields);
    }
  }
  return fields;
}

function primaryKeyWhere(table: string, row: Row): Row {
  const model = modelByName.get(table);
  const where: Row = {};
  for (const field of model?.fields ?? []) {
    if (field.isId) where[field.name] = row[field.name];
  }
  return where;
}

async function main(): Promise<void> {
  const existing = await prisma.clinics.findUnique({
    where: { id: DEMO_CLINIC_ID },
    select: { id: true },
  });
  if (existing) {
    console.log('Données de démo déjà présentes (clinique de démo trouvée) — rien à faire.');
    return;
  }

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
  const tables = Object.keys(fixture).filter((table) => fixture[table]!.length > 0);
  console.log(`Chargement de ${tables.length} tables depuis ${path.basename(FIXTURE_PATH)}...`);

  for (const table of insertionOrder(tables)) {
    const rows = fixture[table]!.map((row) => restoreRow(table, row));
    const selfFields = selfForeignKeyFields(table);
    const patches: { row: Row; data: Row }[] = [];
    for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
      const chunk = rows.slice(index, index + CHUNK_SIZE).map((row) => {
        if (selfFields.length === 0) return row;
        const copy = { ...row };
        const data: Row = {};
        for (const field of selfFields) {
          if (copy[field] !== null && copy[field] !== undefined) {
            data[field] = copy[field];
            copy[field] = null;
          }
        }
        if (Object.keys(data).length > 0) patches.push({ row, data });
        return copy;
      });
      await delegateFor(table).createMany({ data: chunk });
    }
    for (const { row, data } of patches) {
      await delegateFor(table).update({ where: primaryKeyWhere(table, row), data });
    }
    console.log(`  ${table}: ${rows.length}`);
  }

  console.log('');
  console.log('Données de démo chargées.');
  console.log('  Connexion : admin@demo.clinic / demo1234');
}

main()
  .catch((error) => {
    console.error('Échec du chargement des données de démo :', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
