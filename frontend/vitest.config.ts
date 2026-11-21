import { defineVitestConfig } from "@nuxt/test-utils/config";
import { fileURLToPath } from "node:url";

// Module layers live at ./layers relative to frontend/.
const moduleLayersPath = fileURLToPath(new URL("./layers", import.meta.url));

export default defineVitestConfig({
  resolve: {
    alias: {
      "#module-layers": moduleLayersPath,
    },
  },
  test: {
    environment: "nuxt",
    globals: true,
    // Playwright E2E specs live under tests/e2e/. They use their own
    // test runner (see playwright.config.ts) and must not be picked up
    // by vitest — doing so throws
    // "Playwright Test did not expect test.describe() to be called here".
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"],
    setupFiles: ["./tests/setup.ts"],
    environmentOptions: {
      nuxt: {
        mock: {
          intersectionObserver: true,
          indexedDb: true,
        },
      },
    },
  },
});
