// Réinitialise le schéma PostgreSQL (natif, sans Docker).
//
//   npm run reset-db
//
// `prisma db push --force-reset` supprime tout le schéma public puis le
// recrée depuis `back-end/prisma/schema.prisma`.
// Rechargez ensuite les données de démo : npm run seed.

import { spawnSync } from "node:child_process";
import { backendDir, loadEnv, run } from "./lib.mjs";

// Charge le .env racine pour DATABASE_URL.
loadEnv();

if (!process.env.DATABASE_URL) {
  console.error(
    "error: DATABASE_URL is not set (edit .env or set it in the environment)",
  );
  process.exit(1);
}

console.log("Réinitialisation du schéma public (prisma db push --force-reset)...");
const result = spawnSync(
  "npx",
  ["prisma", "db", "push", "--force-reset", "--skip-generate"],
  { cwd: backendDir, stdio: "inherit", shell: true, env: process.env },
);
if (result.error) {
  console.error(
    "\n[ERREUR] Impossible d'exécuter `prisma db push` (dépendances backend installées ?).",
  );
  console.error(String(result.error.message));
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

console.log("");
console.log(
  "Base réinitialisée. Chargez les données de démo avec : npm run seed",
);
