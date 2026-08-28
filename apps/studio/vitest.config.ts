import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Test config is separate from vite.config.ts: the dev server config carries a
 * proxy and a port that tests must never inherit, and Vite's own config type no
 * longer accepts a `test` block.
 *
 * Vite is pinned to 7.x here on purpose. The repo standardises on vitest 3,
 * which bundles its own Vite 7; installing Vite 8 alongside it makes the plugin
 * types of the two copies mutually unassignable and typecheck fails. Moving to
 * Vite 8 means moving the whole monorepo to vitest 4 in one step.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@maestro/config/i18n": fileURLToPath(
        new URL("../../packages/config/src/i18n.ts", import.meta.url),
      ),
    },
  },
  test: {
    /**
     * 20 s, not vitest's 5 s.
     *
     * These are jsdom + React Testing Library suites: each test mounts a tree,
     * runs effects and waits on `findBy*`. Alone they finish in tens of
     * milliseconds, but the gate runs four packages at once on an eight-core
     * box that is often also compiling for a dozen background agents — at load
     * 25 the same test misses 5 s and reports a defect that is not there. Three
     * different suites failed that way in one session (`screens-users`,
     * `screens-params`, `screens-killswitch`), every one of them green on its
     * own.
     *
     * Per-package, deliberately: a cross-cutting knob was tried three times and
     * each attempt either did nothing or overrode `@maestro/workflows`'s own
     * 180 s — see the note in `scripts/gate.mjs`. A real hang still fails, just
     * twenty seconds later.
     */
    testTimeout: 20_000,
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
