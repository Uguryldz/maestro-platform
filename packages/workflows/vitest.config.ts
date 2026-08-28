import { defineConfig } from "vitest/config";

/**
 * The workflow suite boots a local, in-process Temporal time-skipping server
 * and bundles the workflow with webpack, so its budget is measured in seconds
 * rather than milliseconds — while the workflow TIME it exercises is measured
 * in weeks. Nothing here reaches the network.
 */
export default defineConfig({
  test: {
    testTimeout: 180_000,
    hookTimeout: 120_000,
  },
});
