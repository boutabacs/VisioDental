// Helpers partagés du lanceur natif VisioDental (Node, multiplateforme).
//
// Aucune dépendance externe : uniquement des modules Node standards, pour que
// `npm start` fonctionne sans `npm install` à la racine du dépôt.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const isWindows = process.platform === "win32";
export const scriptsDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptsDir, "..");
export const backendDir = join(repoRoot, "back-end");
export const frontendDir = join(repoRoot, "frontend");

// Ports par défaut de la stack native.
export const backendPort = 8100;
export const frontendPort = 3000;
export const backendUrl = `http://localhost:${backendPort}`;

// Charge le .env racine dans process.env (règles dotenv usuelles : une
// `CLE=VALEUR` par ligne, commentaires `#` en début ou en fin de ligne,
// guillemets simples/doubles optionnels autour de la valeur).
export function loadEnv(file = join(repoRoot, ".env")) {
  if (!existsSync(file)) {
    console.warn(`[env] ${file} introuvable — copiez .env.example en .env`);
    return;
  }
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.indexOf("=");
    if (sep < 1) continue;
    const name = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    value = value.replace(/\s+#.*$/, "");
    if (value.length >= 2) {
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
        value = value.slice(1, -1);
      }
    }
    if (!(name in process.env)) process.env[name] = value;
  }

  // Le .env historique (FastAPI) porte un suffixe de driver SQLAlchemy que
  // Prisma refuse (`postgresql+asyncpg://`).
  if (/^postgresql\+[A-Za-z0-9_]+:/.test(process.env.DATABASE_URL ?? "")) {
    process.env.DATABASE_URL = process.env.DATABASE_URL.replace(
      /^postgresql\+[A-Za-z0-9_]+:/,
      "postgresql:",
    );
  }
}

// Exécute une commande au premier plan et échoue si le code de sortie n'est pas 0.
// `shell` vaut true par défaut (résout npm.cmd / npx sous Windows).
export function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: true,
    env: process.env,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `échec de « ${command} ${args.join(" ")} » (code ${result.status})`,
    );
  }
}

// La commande est-elle disponible dans le PATH ?
export function has(command) {
  const probe = spawnSync(command, ["--version"], {
    stdio: "ignore",
    shell: true,
  });
  return !probe.error && probe.status === 0;
}

// --- Back-end : Express + TypeScript + Prisma --------------------------------
// Les dépendances vivent dans `back-end/node_modules` ; le client Prisma est
// généré à partir de `back-end/prisma/schema.prisma`.

export function backendReady() {
  return (
    existsSync(join(backendDir, "node_modules")) &&
    existsSync(join(backendDir, "node_modules", "@prisma", "client", "index.js"))
  );
}

export function installBackend() {
  // `npm install` (et non `npm ci`) : il met à jour node_modules sur place au
  // lieu de le supprimer, ce qui évite les EPERM sur le moteur Prisma quand un
  // serveur de dev tourne encore.
  console.log("Installation des dépendances backend (npm install)...");
  run("npm", ["install"], { cwd: backendDir });
  console.log("Génération du client Prisma...");
  run("npx", ["prisma", "generate"], { cwd: backendDir });
}

// Synchronise le schéma PostgreSQL avec `prisma/schema.prisma` (sans migration
// versionnée : la base de démo est créée/alignée directement).
export function pushSchema() {
  run("npx", ["prisma", "db", "push", "--skip-generate"], {
    cwd: backendDir,
  });
}
