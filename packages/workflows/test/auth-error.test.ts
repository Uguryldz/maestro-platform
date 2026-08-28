import { LlmAuthError } from "@maestro/llm-gateway";
import { ApplicationFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { describe, expect, it } from "vitest";
import { runIntake } from "../src/impl/intake.js";
import { AUTH_RETRY_MAX_ATTEMPTS, LLM_AUTH_REJECTED } from "../src/impl/outcome.js";
import { makeFakes } from "./fakes.js";

/**
 * The install-rehearsal defect: a driver-thrown `LlmAuthError` (OpenRouter
 * answers `403 Key limit exceeded` for an exhausted OR a revoked key) is a
 * plain exception, so it never reached `resolveOutcome` — and to Temporal a
 * plain exception is retryable, which under the thinking proxy's unlimited
 * 1-hour ladder meant a run sat `running` for days with a silent panel.
 *
 * These tests drive the REAL gateway error class through a fake driver, so
 * the guard's structural match (`err.name === "LlmAuthError"`) is proven
 * against the object the live driver actually throws, not a hand-built double.
 */
const authError = (): LlmAuthError =>
  new LlmAuthError(
    403,
    "openai-compat",
    "https://openrouter.ai/api/v1/chat/completions",
    '{"error":{"message":"Key limit exceeded"}}',
  );

/** An activity context pinned to one attempt number, like Temporal's retries. */
const atAttempt = <T>(attempt: number, fn: () => Promise<T>): Promise<T> =>
  new MockActivityEnvironment({ attempt }).run(fn) as Promise<T>;

describe("guardModelCall — a rejected model key must never retry in silence", () => {
  it("rethrows the 403 retryable and puts the wait on the panel (N/M in the journal)", async () => {
    const fakes = makeFakes({
      generateObject: () => {
        throw authError();
      },
    });

    await expect(atAttempt(1, () => runIntake(fakes.deps, "PAY-101"))).rejects.toSatisfy(
      // The ORIGINAL error, not an ApplicationFailure: the activity proxy's
      // own ladder owns the backoff, and the error keeps its name for
      // Temporal's failure record.
      (err: unknown) => err instanceof LlmAuthError && !(err instanceof ApplicationFailure),
    );

    const line = fakes.journalStore.entries.at(-1);
    expect(line?.title).toBe("model anahtarı reddedildi");
    expect(line?.detail).toContain("HTTP 403");
    expect(line?.detail).toContain(`yeniden denenecek (1/${AUTH_RETRY_MAX_ATTEMPTS})`);
  });

  it("counts the attempt Temporal reports, so the panel shows real progress", async () => {
    const fakes = makeFakes({
      generateObject: () => {
        throw authError();
      },
    });

    await expect(atAttempt(7, () => runIntake(fakes.deps, "PAY-101"))).rejects.toThrow();
    expect(fakes.journalStore.entries.at(-1)?.detail).toContain(
      `yeniden denenecek (7/${AUTH_RETRY_MAX_ATTEMPTS})`,
    );
  });

  it(`attempt ${AUTH_RETRY_MAX_ATTEMPTS} hands the ticket to a human and dies non-retryably`, async () => {
    const fakes = makeFakes({
      generateObject: () => {
        throw authError();
      },
    });

    await expect(
      atAttempt(AUTH_RETRY_MAX_ATTEMPTS, () => runIntake(fakes.deps, "PAY-101")),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ApplicationFailure &&
        err.type === LLM_AUTH_REJECTED &&
        err.nonRetryable === true,
    );

    // The handover trail is complete BEFORE the activity dies: journal,
    // ai-assist mode, and a notification a human will actually receive.
    const handover = fakes.journalStore.entries.find((entry) => entry.kind === "handover");
    expect(handover?.detail).toContain("model anahtarı reddedildi");
    expect(handover?.detail).toContain("Ayarlar");
    expect(fakes.patches).toContainEqual({ mode: "ai_assist" });
    expect(fakes.recorded.notifications.length).toBeGreaterThan(0);
  });

  it("touches nothing that is not an auth error", async () => {
    const fakes = makeFakes({
      generateObject: () => {
        throw new Error("schema exploded");
      },
    });

    await expect(runIntake(fakes.deps, "PAY-101")).rejects.toThrow("schema exploded");
    expect(
      fakes.journalStore.entries.some((entry) => entry.title === "model anahtarı reddedildi"),
    ).toBe(false);
  });
});
