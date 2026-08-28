import { describe, expect, it } from "vitest";
import { AdoCiDriver, AdoConfigError, AdoWebhookAuthError } from "../src/index.js";
import { authHeaders, CI_CONFIG, fixture, WEBHOOK_SECRET } from "./helpers.js";

/**
 * O1: the Service Hook credential check is no longer an exported function
 * nobody calls — the CI driver refuses to parse a body it has not
 * authenticated, so the endpoint cannot forget to ask.
 */
function driver(secret: string = WEBHOOK_SECRET) {
  const calls: string[] = [];
  const ci = new AdoCiDriver({
    ci: { ...CI_CONFIG, webhookSecretRef: "ado/webhook/secret" },
    resolveWebhookSecret: () => {
      calls.push("resolve");
      return secret;
    },
  });
  return { ci, calls };
}

const BUILD_EVENT = fixture("event-build-complete-services");

describe("AdoCiDriver webhook authentication (O1)", () => {
  it("parses an authenticated request and returns only the signal over the port", async () => {
    const { ci } = driver();
    const signal = await ci.parseBuildEvent({ headers: authHeaders(), body: BUILD_EVENT });

    expect(signal).toMatchObject({ ticketKey: "UGURPAY-4312", prId: 128, status: "succeeded" });
  });

  it("refuses a bare Service Hook body: no headers, no parse", async () => {
    const { ci } = driver();
    // The old shape — the raw envelope straight from the request body. It
    // cannot be authenticated, so it is rejected rather than trusted.
    await expect(ci.parseBuildEvent(BUILD_EVENT)).rejects.toBeInstanceOf(AdoWebhookAuthError);
    await expect(ci.parseBuildEvent({ headers: authHeaders() })).rejects.toBeInstanceOf(
      AdoWebhookAuthError,
    );
    await expect(ci.parseBuildEvent(null)).rejects.toBeInstanceOf(AdoWebhookAuthError);
  });

  it("rejects a wrong, missing or non-basic credential", async () => {
    const { ci } = driver();
    const cases: Array<[Record<string, string>, string]> = [
      [authHeaders("wrong-secret"), "mismatch"],
      [authHeaders(WEBHOOK_SECRET, "someone-else"), "mismatch"],
      [{ "content-type": "application/json" }, "missing"],
      [{ Authorization: "Bearer token" }, "malformed"],
    ];
    for (const [headers, reason] of cases) {
      const rejection = ci.parseBuildEvent({ headers, body: BUILD_EVENT });
      await expect(rejection).rejects.toMatchObject({ reason });
    }
  });

  it("authenticates before parsing: a forged body never reaches the parser", async () => {
    const { ci } = driver();
    // A body that would throw AdoResponseError if it were parsed. The auth
    // error proves the parser was never reached.
    const broken = { eventType: "build.complete", resource: { id: "not-a-number" } };
    await expect(
      ci.parseBuildEvent({ headers: authHeaders("wrong-secret"), body: broken }),
    ).rejects.toBeInstanceOf(AdoWebhookAuthError);
  });

  it("refuses to run when the resolved shared secret is empty (fail-closed)", async () => {
    const { ci } = driver("");
    await expect(
      ci.parseBuildEvent({ headers: authHeaders(""), body: BUILD_EVENT }),
    ).rejects.toBeInstanceOf(AdoConfigError);
  });

  it("resolves the secret on every request, so a rotation takes effect", async () => {
    const { ci, calls } = driver();
    await ci.parseBuildEvent({ headers: authHeaders(), body: BUILD_EVENT });
    await ci.parseBuildEvent({ headers: authHeaders(), body: BUILD_EVENT });
    expect(calls).toHaveLength(2);
  });

  it("finds the header whatever its casing, and takes the first repeated value", async () => {
    const { ci } = driver();
    const lower = { authorization: authHeaders()["Authorization"]! };
    await expect(
      ci.parseBuildEvent({ headers: lower, body: BUILD_EVENT }),
    ).resolves.toMatchObject({ prId: 128 });

    const repeated = { AUTHORIZATION: [authHeaders()["Authorization"]!, "Basic bogus"] };
    await expect(
      ci.parseAuthenticatedBuildEvent(repeated, BUILD_EVENT),
    ).resolves.toMatchObject({ definitionId: 12 });
  });

  it("hands the provenance to the endpoint through the driver's own method", async () => {
    const { ci } = driver();
    const event = await ci.parseAuthenticatedBuildEvent(authHeaders(), BUILD_EVENT);
    expect(event).toMatchObject({ project: "UgurPay", repository: "ugurpay", definitionId: 12 });
    expect(event?.signal.buildId).toBe(4711);
  });

  it("still returns null for an authenticated event that is not ours", async () => {
    const { ci } = driver();
    await expect(
      ci.parseBuildEvent({ headers: authHeaders(), body: fixture("event-git-push") }),
    ).resolves.toBeNull();
  });
});
