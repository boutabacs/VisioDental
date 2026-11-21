/**
 * Amorçage d'une base vierge (installation cabinet).
 *
 * Insère uniquement les données *structurelles* — celles qui ne dépendent
 * d'aucune clinique : permissions, modules connus, rôles système, matrice
 * rôle → permissions, modèles de notifications. La clinique, l'administrateur
 * et le premier fauteuil sont créés ensuite par l'assistant `/setup`
 * (`POST /api/v1/auth/setup`), qui exige une base sans utilisateur.
 *
 * Idempotent (`skipDuplicates`) : peut tourner à chaque mise à jour.
 *
 *   node dist/scripts/provision.js       # installation empaquetée
 *   npx tsx src/scripts/provision.ts     # depuis back-end/
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { prisma } from '../lib/prisma';

type Row = Record<string, unknown>;
type Fixture = Record<string, Row[]>;

const FIXTURE_PATH = path.resolve(__dirname, '../../prisma/seed-data/base.json');

/** Ordre d'insertion : les clés étrangères pointent vers les tables d'avant. */
const TABLES = [
  'permissions',
  'roles',
  'module_default_role_permissions',
  'role_permissions',
  'notification_templates',
  'core_module',
] as const;

const CHUNK_SIZE = 200;

function restoreRow(row: Row): Row {
  const result: Row = { ...row };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== 'string') continue;
    // Les horodatages du fixture sont des ISO 8601 complets.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
      result[key] = new Date(value);
    }
  }
  return result;
}

function delegateFor(table: string): {
  createMany: (args: {
    data: Row[];
    skipDuplicates: boolean;
  }) => Promise<{ count: number }>;
} {
  const delegate = (prisma as unknown as Record<string, unknown>)[table];
  if (!delegate || typeof (delegate as { createMany?: unknown }).createMany !== 'function') {
    throw new Error(`Modèle Prisma inconnu : ${table}`);
  }
  return delegate as {
    createMany: (args: { data: Row[]; skipDuplicates: boolean }) => Promise<{ count: number }>;
  };
}

async function main(): Promise<void> {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
  let inserted = 0;

  for (const table of TABLES) {
    const rows = (fixture[table] ?? []).map(restoreRow);
    if (rows.length === 0) continue;
    let count = 0;
    for (let index = 0; index < rows.length; index += CHUNK_SIZE) {
      const chunk = rows.slice(index, index + CHUNK_SIZE);
      const result = await delegateFor(table).createMany({
        data: chunk,
        skipDuplicates: true,
      });
      count += result.count;
    }
    inserted += count;
    console.log(`  ${table}: ${count} ajouté(s) / ${rows.length}`);
  }

  const users = await prisma.users.count();
  console.log('');
  console.log(`Données structurelles en place (${inserted} ligne(s) ajoutée(s)).`);
  if (users === 0) {
    console.log('Base sans utilisateur : ouvrez /setup pour créer la clinique et l’administrateur.');
  } else {
    console.log(`Base déjà initialisée (${users} utilisateur(s)) — assistant /setup verrouillé.`);
  }
}

main()
  .catch((error) => {
    console.error('Échec de l’amorçage de la base :', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
