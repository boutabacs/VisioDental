// Superviseur du serveur de cabinet : démarre l'API Express puis le site
// Nuxt, surveille les deux processus et les redémarre en cas de crash.
//
// Lancé par le service Windows (WinSW) :
//
//   runtime\node.exe runtime\start.mjs
//
// Arborescence attendue (posée par l'installeur) :
//
//   .env            configuration générée à l'installation
//   api\            API compilée (dist/, prisma/, node_modules/)
//   site\.output\   serveur Nuxt
//   runtime\        ce fichier + node.exe
//   logs\           journaux (rédigés par WinSW)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(runtimeDir, "..");
const apiDir = join(root, "api");
const siteDir = join(root, "site");

const isWindows = process.platform === "win32";

function log(message) {
  console.log(`[server] ${message}`);
}

/** Charge `<racine>/.env` sans écraser l'environnement du service. */
function loadEnv() {
  const envFile = join(root, ".env");
  if (!existsSync(envFile)) return;
  for (const rawLine of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z0-9_]+$/i.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnv();

const apiPort = Number(process.env.PORT ?? 8100);
const sitePort = Number(process.env.NUXT_PORT ?? 3000);
const siteHost = process.env.NUXT_HOST ?? "0.0.0.0";

if (!process.env.DATABASE_URL) {
  console.error("[server] DATABASE_URL absent de .env — arrêt.");
  process.exit(1);
}

for (const required of [
  join(apiDir, "dist", "server.js"),
  join(siteDir, ".output", "server", "index.mjs"),
]) {
  if (!existsSync(required)) {
    console.error(`[server] fichier manquant : ${required}`);
    process.exit(1);
  }
}

mkdirSync(join(root, "logs"), { recursive: true });

let stopping = false;
let siteStarted = false;
const children = new Set();
const pidFile = join(root, "logs", "children.json");

/** Mémorise les PIDs pour pouvoir les nettoyer après un arrêt brutal. */
function persistChildren() {
  try {
    writeFileSync(pidFile, JSON.stringify([...children].map((child) => child.pid)));
  } catch {
    /* au pire, pas de nettoyage au prochain démarrage */
  }
}

/**
 * WinSW (arrêt ou redémarrage) tue le superviseur, pas ses enfants : au
 * démarrage suivant, les anciens processus pourraient garder les ports. On
 * tue les PIDs mémorisés s'ils datent de moins de 12 h (limite le risque de
 * réutilisation de PID).
 */
function killStaleChildren() {
  if (!existsSync(pidFile)) return;
  try {
    if (Date.now() - statSync(pidFile).mtimeMs > 12 * 60 * 60 * 1000) return;
    const pids = JSON.parse(readFileSync(pidFile, "utf8"));
    for (const pid of Array.isArray(pids) ? pids : []) {
      if (typeof pid !== "number" || pid <= 0) continue;
      log(`Nettoyage du processus résiduel ${pid}.`);
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    }
  } catch {
    /* fichier illisible : on ignore */
  } finally {
    rmSync(pidFile, { force: true });
  }
}

function pipeOutput(child, prefix) {
  const forward = (stream, sink) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        sink.write(`[${prefix}] ${buffer.slice(0, newline + 1)}`);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    stream.on("end", () => {
      if (buffer) sink.write(`[${prefix}] ${buffer}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      /* déjà terminé */
    }
  }
}

async function apiHealthy(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopping) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return true;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  return false;
}

async function startApi() {
  const child = spawn(process.execPath, [join(apiDir, "dist", "server.js")], {
    cwd: apiDir,
    env: { ...process.env, PORT: String(apiPort) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  persistChildren();
  pipeOutput(child, "api");
  log(`API démarrée (PID ${child.pid}) sur le port ${apiPort}.`);

  child.on("exit", (code, signal) => {
    children.delete(child);
    persistChildren();
    if (stopping) return;
    log(`API arrêtée (code ${code ?? "?"}, signal ${signal ?? "-"}). Redémarrage dans 5 s.`);
    setTimeout(() => void bootApi(), 5_000);
  });

  const healthy = await apiHealthy();
  if (!healthy && !stopping) {
    log("L'API n'a pas répondu à /health après 90 s — vérifiez les journaux.");
  }
  return healthy;
}

let apiRunning = false;
async function bootApi() {
  if (stopping || apiRunning) return;
  apiRunning = true;
  try {
    await startApi();
  } finally {
    apiRunning = false;
    if (!stopping && !siteStarted) await startSite();
  }
}

function startSite() {
  if (stopping || siteStarted) return;
  siteStarted = true;
  // Cible SSR et proxy /api/v1. Le site est toujours servi sur la même
  // machine que l'API qu'il vient de lancer : on dérive l'adresse du port et
  // de l'hôte d'écoute, et on ignore toute API_BASE_URL_SERVER héritée d'un
  // .env de développement (elle pointerait vers un port arbitraire).
  // Les clés Nuxt se surchargent à l'exécution via NUXT_*.
  const apiHost = process.env.API_HOST?.trim();
  const apiLoopback =
    !apiHost || apiHost === "0.0.0.0" || apiHost === "::" ? "127.0.0.1" : apiHost;
  const apiTarget = `http://${apiLoopback}:${apiPort}`;
  const child = spawn(process.execPath, [join(siteDir, ".output", "server", "index.mjs")], {
    cwd: siteDir,
    env: {
      ...process.env,
      NITRO_PORT: String(sitePort),
      NITRO_HOST: siteHost,
      PORT: String(sitePort),
      NUXT_PORT: String(sitePort),
      NUXT_HOST: siteHost,
      NUXT_API_PROXY: process.env.NUXT_API_PROXY ?? "true",
      API_BASE_URL_SERVER: apiTarget,
      NUXT_API_BASE_URL_SERVER: apiTarget,
      NUXT_PUBLIC_API_BASE_URL: process.env.NUXT_PUBLIC_API_BASE_URL ?? "/",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  persistChildren();
  pipeOutput(child, "site");
  log(`Site démarré (PID ${child.pid}) sur http://${siteHost}:${sitePort}.`);

  let restarts = 0;
  child.on("exit", (code, signal) => {
    children.delete(child);
    persistChildren();
    siteStarted = false;
    if (stopping) return;
    restarts += 1;
    const delay = Math.min(30_000, 2_000 * restarts);
    log(`Site arrêté (code ${code ?? "?"}, signal ${signal ?? "-"}). Redémarrage dans ${delay / 1000} s.`);
    setTimeout(() => startSite(), delay);
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} reçu — arrêt.`);
  for (const child of children) killTree(child);
  rmSync(pidFile, { force: true });
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  console.error("[server] exception non capturée :", error);
});
process.on("unhandledRejection", (error) => {
  console.error("[server] promesse rejetée :", error);
});

log(`Démarrage du serveur VisioDental (racine : ${root}).`);
killStaleChildren();
void bootApi();
