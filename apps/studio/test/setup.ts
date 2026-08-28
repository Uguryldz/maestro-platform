import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * How long `findBy*` waits before declaring an element absent.
 *
 * Testing Library's default is 1000 ms, and that was enough while a screen
 * mounted one or two panels. The settings screen now mounts four, each with its
 * own query, and the kill switch is the last of them — so under the gate's
 * four-package parallelism its button had not rendered within the second, and
 * the suite reported "Unable to find role=button" for a button that appears
 * every time when the file runs alone (5/5) or as the whole suite (336/336).
 *
 * This is the ASYNC-UTIL budget, not the per-test one (`vitest.config.ts` sets
 * that): a genuinely missing element still fails, five seconds later instead of
 * one, while a slow-but-correct render stops being reported as a defect.
 */
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom does not implement the <dialog> top layer; Modal calls these.
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

// No test may reach the network. Any unmocked fetch is a test bug.
globalThis.fetch = (() => {
  throw new Error("network access is not allowed in tests; inject a fetch stub");
}) as unknown as typeof fetch;
