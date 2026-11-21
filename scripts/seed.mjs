// Charge les données de démo (natif, sans Docker).
//
//   npm run seed
//
// Le jeu de démo (clinique, utilisateurs, patients, catalogue, agenda,
// budgets, factures) est un instantané JSON inséré par
// `back-end/src/scripts/seed.ts`. Connexion : admin@demo.clinic / demo1234.

import {
  backendDir,
  backendReady,
  installBackend,
  loadEnv,
  run,
} from "./lib.mjs";

// Charge le .env racine pour que le backend voie DATABASE_URL / SECRET_KEY.
loadEnv();

if (!backendReady()) installBackend();

run("npx", ["tsx", "src/scripts/seed.ts", ...process.argv.slice(2)], {
  cwd: backendDir,
});
