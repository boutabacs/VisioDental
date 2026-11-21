// Installation initiale native (sans Docker) — multiplateforme.
//
//   npm run setup
//
// Étapes :
//   1. crée .env depuis .env.example s'il n'existe pas
//   2. installe les dépendances backend (npm) et génère le client Prisma
//   3. synchronise le schéma PostgreSQL (`prisma db push`)
//   4. installe les dépendances frontend (npm ci)
//
// Prérequis : PostgreSQL démarré, Node 22.

import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  backendReady,
  frontendDir,
  installBackend,
  loadEnv,
  pushSchema,
  repoRoot,
  run,
} from "./lib.mjs";

const envFile = join(repoRoot, ".env");

if (!existsSync(envFile)) {
  console.log("Création de .env depuis .env.example");
  copyFileSync(join(repoRoot, ".env.example"), envFile);
  console.log(
    "  -> éditez .env (DATABASE_URL, SECRET_KEY) avant le premier lancement",
  );
} else {
  console.log(".env déjà présent, inchangé");
}

// Charge-le pour que les commandes ci-dessous voient DATABASE_URL / SECRET_KEY.
loadEnv(envFile);

if (backendReady()) {
  console.log("Dépendances backend déjà installées, inchangées.");
} else {
  installBackend();
}

console.log("Synchronisation du schéma PostgreSQL (prisma db push)...");
pushSchema();

if (existsSync(join(frontendDir, "node_modules"))) {
  console.log("Dépendances frontend déjà installées, inchangées.");
} else {
  console.log("Installation des dépendances frontend (npm ci)...");
  run("npm", ["ci"], { cwd: frontendDir });
}

console.log("");
console.log("Configuration terminée. Tout lancer avec :");
console.log("  npm start        # backend + frontend");
console.log("  lancer.bat       # double-clic sous Windows");
console.log("");
console.log("Données de démo (optionnel) : npm run seed");
