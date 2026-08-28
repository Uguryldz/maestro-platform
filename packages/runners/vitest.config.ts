import { defineConfig } from "vitest/config";

/**
 * The default (offline) suite runs files in parallel — nothing it touches is
 * shared. The opt-in Docker battery (`MAESTRO_DOCKER_IT=1`) does not: its files
 * share ONE daemon, and each of them asserts that no maestro-labelled
 * container, volume or network is left behind. Those assertions only mean
 * something if no other file is mid-run, so the battery runs file by file.
 */
export default defineConfig({
  test: {
    fileParallelism: process.env["MAESTRO_DOCKER_IT"] !== "1",
  },
});
