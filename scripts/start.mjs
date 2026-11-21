// Lance la stack VisioDental en natif : backend Express (port 8100) + frontend
// Nuxt (port 3000) dans un seul processus, avec les logs préfixés.
//
//   npm start            # backend + frontend
//   npm run backend      # backend seul
//   npm run frontend     # frontend seul
//
// Au premier lancement, installe les dépendances manquantes et synchronise le
// schéma PostgreSQL (`prisma db push`). Aucune dépendance à un système
// d'exploitation particulier.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  backendDir,
  backendReady,
  backendUrl,
  frontendDir,
  frontendPort,
  installBackend,
  isWindows,
  loadEnv,
  pushSchema,
  repoRoot,
  run,
} from "./lib.mjs";

const COLORS = { backend: "\x1b[36m", frontend: "\x1b[35m", reset: "\x1b[0m" };

const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length) : null;
const withBackend = only !== "frontend";
const withFrontend = only !== "backend";

if (!existsSync(join(repoRoot, ".env"))) {
  console.error("[ERREUR] .env manquant. Lancez d'abord : npm run setup");
  process.exit(1);
}
loadEnv();

// --- première exécution : dépendances ----------------------------------------
if (withBackend && !backendReady()) {
  console.log("Premier lancement — préparation du backend (npm + prisma)...");
  installBackend();
}
if (withFrontend && !existsSync(join(frontendDir, "node_modules"))) {
  console.log(
    "Premier lancement — installation des dépendances frontend (npm ci)...",
  );
  run("npm", ["ci"], { cwd: frontendDir });
}

// --- schéma PostgreSQL -------------------------------------------------------
if (withBackend) {
  try {
    pushSchema();
  } catch (error) {
    console.error("\n[ERREUR] Impossible de synchroniser le schéma PostgreSQL.");
    console.error(
      "Vérifiez que PostgreSQL est démarré et que DATABASE_URL (.env) est correct.",
    );
    console.error(String(error.message));
    process.exit(1);
  }
}

// --- démarrage ---------------------------------------------------------------
const children = [];
let stopping = false;

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) killTree(child);
  process.exit(code);
}

function launch(name, command, args, cwd, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd,
    shell: true,
    detached: !isWindows,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const label = `${COLORS[name] ?? ""}[${name}]${COLORS.reset} `;
  for (const stream of [child.stdout, child.stderr]) {
    let buffered = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(label + line + "\n");
    });
  }
  child.on("error", (error) => {
    process.stdout.write(`${label}erreur : ${error.message}\n`);
  });
  child.on("exit", (code) => {
    process.stdout.write(`${label}arrêté (code ${code ?? 0})\n`);
    stop(code ?? 0);
  });
  return child;
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

if (withBackend) {
  children.push(
    launch("backend", "npx", ["tsx", "watch", "src/server.ts"], backendDir),
  );
}
if (withFrontend) {
  children.push(
    launch("frontend", "npm", ["run", "dev"], frontendDir, {
      NUXT_PUBLIC_API_BASE_URL: process.env.NUXT_PUBLIC_API_BASE_URL || backendUrl,
      API_BASE_URL_SERVER: process.env.API_BASE_URL_SERVER || backendUrl,
      API_BASE_URL: process.env.API_BASE_URL || backendUrl,
    }),
  );
}

console.log("");
console.log("  VisioDental démarré :");
if (withBackend) console.log(`    backend  -> ${backendUrl}`);
if (withFrontend) console.log(`    frontend -> http://localhost:${frontendPort}`);
console.log("  Ctrl+C pour tout arrêter.");
console.log("");
