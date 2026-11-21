// Build de production pour l'installeur « VisioDental Server ».
//
//   npm run build:prod            # API compilée + site Nuxt + runtime
//   npm run build:prod -- --fresh # réinstalle aussi les dépendances API
//
// Produit `dist-server/`, arborescence autonome posée par l'installeur :
//
//   dist-server/
//     api/                API Express compilée + Prisma + dépendances prod
//     site/.output/       serveur Nuxt (preset node-server)
//     runtime/start.mjs   superviseur (API + site), node.exe embarqué
//     server.env.example  modèle de configuration, rempli à l'installation
//     VERSION
//
// Prérequis machine de build : Node 22+, accès réseau (npm ci, prisma).

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const backendDir = join(root, "back-end");
const frontendDir = join(root, "frontend");
const outDir = join(root, "dist-server");

const args = new Set(process.argv.slice(2));
const fresh = args.has("--fresh");
const skipApi = args.has("--site-only");
const skipSite = args.has("--api-only");

const npmCli = join(
  dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
const npm = existsSync(npmCli) ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const npmPrefix = npm === process.execPath ? [npmCli] : [];

function npmRun(argv, options = {}) {
  run(npm, [...npmPrefix, ...argv], options);
}

function log(message) {
  console.log(`\n[build:prod] ${message}`);
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${argv.join(" ")} a échoué (code ${result.status})`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function cleanTarget(...segments) {
  rmSync(join(outDir, ...segments), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 1. API Express
// ---------------------------------------------------------------------------

function buildApi() {
  log("Compilation de l'API (tsc)…");
  npmRun(["run", "build"], { cwd: backendDir });
  if (args.has("--prisma-generate")) {
    // Nécessaire seulement après une modification du schéma. Sous Windows,
    // le serveur de développement verrouille le moteur : arrêtez-le d'abord.
    run(process.execPath, [
      join(backendDir, "node_modules", "prisma", "build", "index.js"),
      "generate",
    ], { cwd: backendDir });
  }

  const apiDir = join(outDir, "api");
  cleanTarget("api", "dist");
  cleanTarget("api", "prisma");
  mkdirSync(apiDir, { recursive: true });

  cpSync(join(backendDir, "dist"), join(apiDir, "dist"), { recursive: true });
  cpSync(join(backendDir, "prisma"), join(apiDir, "prisma"), {
    recursive: true,
    // L'installeur n'embarque pas le jeu de démonstration ; `base.json`
    // (données structurelles) suffit à l'assistant /setup.
    filter: (source) => !source.endsWith("demo.json"),
  });

  const source = readJson(join(backendDir, "package.json"));
  const runtimePackage = {
    name: "visiodental-api",
    version: source.version,
    private: true,
    type: source.type,
    main: "dist/server.js",
    scripts: {
      start: "node dist/server.js",
      provision: "node dist/scripts/provision.js",
    },
    engines: source.engines,
    dependencies: source.dependencies,
  };
  writeFileSync(join(apiDir, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`);
  cpSync(join(backendDir, "package-lock.json"), join(apiDir, "package-lock.json"));

  const modulesPresent = existsSync(join(apiDir, "node_modules"));
  if (fresh || !modulesPresent) {
    log("Installation des dépendances de production de l'API (npm ci --omit=dev)…");
    npmRun(["ci", "--omit=dev"], { cwd: apiDir });
    log("Génération du client Prisma pour la cible…");
    run(process.execPath, [
      join(apiDir, "node_modules", "prisma", "build", "index.js"),
      "generate",
      `--schema=${join(apiDir, "prisma", "schema.prisma")}`,
    ]);
  } else {
    log("node_modules API déjà présent — réutilisé (--fresh pour réinstaller).");
  }
}

// ---------------------------------------------------------------------------
// 2. Site Nuxt
// ---------------------------------------------------------------------------

function buildSite() {
  log("Build du site Nuxt (preset node-server)…");
  npmRun(["run", "build"], {
    cwd: frontendDir,
    env: {
      ...process.env,
      NUXT_PRESET: "node-server",
      // Le build Nuxt dépasse la limite V8 par défaut (tous les layers sont
      // compilés d'un coup) : 6 Go suffisent sur un poste 16 Go.
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=6144",
    },
  });
  cleanTarget("site");
  mkdirSync(join(outDir, "site"), { recursive: true });
  cpSync(join(frontendDir, ".output"), join(outDir, "site", ".output"), { recursive: true });
}

// ---------------------------------------------------------------------------
// 3. Runtime (superviseur + Node embarqué + modèle .env)
// ---------------------------------------------------------------------------

function buildRuntime() {
  log("Copie du runtime (superviseur, node.exe, modèle de configuration)…");
  cleanTarget("runtime");
  mkdirSync(join(outDir, "runtime"), { recursive: true });
  cpSync(join(root, "packaging", "runtime", "start.mjs"), join(outDir, "runtime", "start.mjs"));
  cpSync(join(root, "packaging", "backup.ps1"), join(outDir, "runtime", "backup.ps1"));
  cpSync(join(root, "packaging", "server.env.example"), join(outDir, "server.env.example"));
  // L'installeur et le désinstalleur voyagent avec le paquet : ils se lancent
  // depuis le dossier dist-server, à côté de api/, site/ et runtime/.
  for (const script of ["install-server.ps1", "uninstall-server.ps1"]) {
    cpSync(join(root, "packaging", script), join(outDir, script));
  }
  cpSync(join(root, "packaging", "winsw", "VisioDental.xml"), join(outDir, "VisioDental.xml"));
  cpSync(
    join(root, "packaging", "winsw", "VisioDentalPostgres.xml"),
    join(outDir, "VisioDentalPostgres.xml"),
  );

  const nodeTarget = join(outDir, "runtime", process.platform === "win32" ? "node.exe" : "node");
  cpSync(process.execPath, nodeTarget);
  if (process.platform !== "win32") {
    try {
      chmodSync(nodeTarget, 0o755);
    } catch {
      /* best effort */
    }
  }

  const api = readJson(join(backendDir, "package.json"));
  const site = readJson(join(frontendDir, "package.json"));
  writeFileSync(
    join(outDir, "VERSION"),
    `api=${api.version}\nsite=${site.version}\nbuilt_at=${new Date().toISOString()}\nnode=${process.version}\n`,
  );
}

// ---------------------------------------------------------------------------

log(`Sortie : ${outDir}`);
if (fresh) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

if (!skipApi) buildApi();
if (!skipSite) buildSite();
buildRuntime();

log("Terminé.");
log("Paquet prêt dans dist-server/ — l'installeur est décrit dans packaging/README.md.");
