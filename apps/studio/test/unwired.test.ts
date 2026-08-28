import { describe, expect, it } from "vitest";
import { ApiError, NetworkError } from "../src/api/errors.ts";
import { isNotBuilt } from "../src/screens/shared/unwired.tsx";

/**
 * `isNotBuilt` decides whether a failure renders as "not available here"
 * (deliberately blank) instead of a red error.
 *
 * The 503 case is the one that matters most: a read model this deployment did
 * not wire (runners, scans, eval) refuses by NAME with `503
 * capability_not_wired`, not 404. Before this was recognised those screens
 * rendered a breakage for a capability that is simply absent. A 503 with any
 * OTHER code is a genuine outage and must STAY an error, so the code — not just
 * the status — is what the check keys on.
 */
describe("isNotBuilt", () => {
  it("treats 404 and 501 as not-built", () => {
    expect(isNotBuilt(new ApiError(404, "not_found", null))).toBe(true);
    expect(isNotBuilt(new ApiError(501, "not_implemented", null))).toBe(true);
  });

  it("treats a 503 capability_not_wired as not-built (the unwired read model)", () => {
    expect(isNotBuilt(new ApiError(503, "capability_not_wired", { capability: "scans.list" }))).toBe(
      true,
    );
  });

  it("keeps a 503 with any OTHER code as a real error (a genuine outage)", () => {
    expect(isNotBuilt(new ApiError(503, "temporarily_unavailable", null))).toBe(false);
    expect(isNotBuilt(new ApiError(503, "upstream_down", null))).toBe(false);
  });

  it("keeps ordinary errors as errors", () => {
    expect(isNotBuilt(new ApiError(500, "internal", null))).toBe(false);
    expect(isNotBuilt(new ApiError(403, "forbidden", null))).toBe(false);
    expect(isNotBuilt(new NetworkError(new Error("offline")))).toBe(false);
    expect(isNotBuilt(null)).toBe(false);
    expect(isNotBuilt(new Error("boom"))).toBe(false);
  });
});
