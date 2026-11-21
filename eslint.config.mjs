// @ts-check
// ESLint is configured at the repository root on purpose. Module-layer
// frontend code lives in backend/app/modules/*/frontend — outside frontend/ —
// and ESLint only lints files inside the current working directory, so a
// config rooted in frontend/ could not reach them without the old
// `module_layers` symlink (a Linux-only artifact that does not exist on
// Windows). `npm run lint` (frontend/package.json) runs ESLint from the
// repository root via scripts/run-eslint.mjs, where both the host app and
// every module layer are inside the base path.
import withNuxt from './frontend/.nuxt/eslint.config.mjs'

export default withNuxt(
  {
    // Mirror `nuxt/disables/routes`: routed components are allowed
    // single-word names (new.vue, index.vue, [id].vue).
    name: 'visiodental/module-layers/routes',
    files: ['backend/app/modules/*/frontend/{pages,layouts}/**/*.{js,ts,jsx,tsx,vue}'],
    rules: {
      'vue/multi-word-component-names': 'off'
    }
  },
  {
    // #522: `new Date(y, m, d).toISOString().slice(0, 10)` renders a *local*
    // midnight in UTC, which is the previous day for every zone ahead of it —
    // wrong at midday in Madrid, Rome, Warsaw, Budapest and Kolkata, not just
    // near midnight. That shipped in 32 places before anyone noticed, and a
    // one-off sweep goes stale the moment a module lands (orthodontics
    // arrived with #505 carrying two fresh copies). `toISODate(d)` reads the
    // Y-M-D fields off the Date; `clinicToday(tz)` is the one for "today".
    name: 'visiodental/dates/no-utc-day-slicing',
    files: ['frontend/app/**/*.{js,ts,vue}', 'backend/app/modules/*/frontend/**/*.{js,ts,vue}'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector:
            'CallExpression[callee.object.callee.property.name="toISOString"][callee.property.name="slice"]',
          message:
            'Use toISODate(d) from ~~/app/utils/wallClock (or clinicToday(tz) for today). '
            + 'toISOString() renders the instant in UTC, so a local midnight comes back as the previous day (#522).'
        },
        {
          selector:
            'CallExpression[callee.object.callee.property.name="toISOString"][callee.property.name="split"]',
          message:
            'Use toISODate(d) from ~~/app/utils/wallClock (or clinicToday(tz) for today). '
            + 'toISOString() renders the instant in UTC, so a local midnight comes back as the previous day (#522).'
        }
      ]
    }
  },
  {
    // Python bytecode caches under backend/app/modules would otherwise be
    // traversed now that the module layers are lint targets.
    ignores: ['backend/app/modules/**/__pycache__/**', 'backend/app/modules/**/migrations/**']
  }
)
