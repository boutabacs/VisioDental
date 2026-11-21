// Run ESLint from the repository root.
//
// Module layers now live inside frontend/layers, so `frontend` covers both
// the host app and every module layer. Running from the repository root
// keeps the root eslint.config.mjs (which also covers shared tooling) in
// charge.
//
//   node scripts/run-eslint.mjs [--fix]
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(frontendDir, '..')
const eslintBin = resolve(frontendDir, 'node_modules', 'eslint', 'bin', 'eslint.js')

const result = spawnSync(
  process.execPath,
  [eslintBin, ...process.argv.slice(2), 'frontend'],
  { cwd: repoRoot, stdio: 'inherit' }
)

if (result.error) throw result.error
process.exit(result.status ?? 1)
