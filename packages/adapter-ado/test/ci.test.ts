import { CiResultSignal } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { AdoConfigError, AdoResponseError, parseBuildCompleteEvent } from "../src/index.js";
import { fixture, PR_VALIDATION_BUILDS } from "./helpers.js";

/** Parses against the allow-list that matches the fixtures. */
function parse(rawBody: unknown) {
  return parseBuildCompleteEvent(rawBody, PR_VALIDATION_BUILDS);
}

/** Deep-clones a fixture so a variant cannot leak into another test. */
function variant(name: string, patch: (resource: Record<string, unknown>) => void): unknown {
  const event = structuredClone(fixture(name)) as { resource: Record<string, unknown> };
  patch(event.resource);
  return event;
}

describe("parseBuildCompleteEvent (M12 passive CI)", () => {
  it("maps a Services build.complete for a PR validation build", () => {
    const event = parse(fixture("event-build-complete-services"));

    expect(event?.signal).toEqual({
      ticketKey: "UGURPAY-4312",
      prId: 128,
      buildId: 4711,
      status: "succeeded",
      detailsUrl: "https://dev.azure.com/ugurbank/UgurPay/_build/results?buildId=4711",
      finishedAt: "2026-08-08T10:14:22.710Z",
    });
    expect(CiResultSignal.safeParse(event?.signal).success).toBe(true);
  });

  it("carries the provenance the frozen signal cannot hold", () => {
    // CiResultSignal has no project/repo/definition fields, so the driver
    // returns them alongside it: correlation must not rest on prId alone.
    const event = parse(fixture("event-build-complete-services"));
    expect(event).toMatchObject({ project: "UgurPay", repository: "ugurpay", definitionId: 12 });
  });

  it("maps an on-prem Server build.complete the same way", () => {
    const event = parse(fixture("event-build-complete-server"));

    expect(event?.signal).toMatchObject({
      ticketKey: "UGURWEB-902",
      prId: 77,
      buildId: 20261,
      status: "failed",
      finishedAt: "2026-08-08T07:49:05.880Z",
    });
    expect(event?.signal.detailsUrl).toContain("tfs.ugurbank.local");
    expect(event?.project).toBe("UgurWeb");
  });

  it("returns null for a non-build event", () => {
    expect(parse(fixture("event-git-push"))).toBeNull();
  });

  it("returns null for a branch CI build with no pull request", () => {
    expect(parse(fixture("event-build-complete-branch-ci"))).toBeNull();
  });

  it("returns null when the source branch carries no ticket key (M49)", () => {
    // A PR validation build from an allow-listed definition, on
    // refs/heads/hotfix/... — guessing a key here would signal an unrelated
    // workflow run, so the event is ignored.
    expect(parse(fixture("event-build-complete-no-ticket"))).toBeNull();
  });

  it("returns null for a body that is not a Service Hook envelope", () => {
    expect(parse({})).toBeNull();
    expect(parse(null)).toBeNull();
    expect(parse("build.complete")).toBeNull();
    expect(parse({ eventType: "" })).toBeNull();
  });

  it("returns null when the merge ref is the only ref and carries no ticket key", () => {
    const event = variant("event-build-complete-services", (resource) => {
      delete resource["triggerInfo"];
      resource["sourceBranch"] = "refs/pull/128/merge";
    });
    // No triggerInfo means no feature branch anywhere → no ticket key → null.
    expect(parse(event)).toBeNull();
  });

  it("takes the pull request id from the merge ref when pr.number is missing", () => {
    const event = variant("event-build-complete-services", (resource) => {
      resource["triggerInfo"] = { "pr.sourceBranch": "refs/heads/feature/UGURPAY-4312-iban" };
    });
    expect(parse(event)?.signal.prId).toBe(128);
  });

  it("treats partiallySucceeded and canceled as failed (fail-closed 10b gate)", () => {
    for (const result of ["partiallySucceeded", "canceled", "none", "somethingNew"]) {
      const event = variant("event-build-complete-services", (resource) => {
        resource["result"] = result;
      });
      expect(parse(event)?.signal.status).toBe("failed");
    }
  });

  it("reads the verdict from `status` on resourceVersion 1.0 payloads", () => {
    const succeeded = variant("event-build-complete-services", (resource) => {
      delete resource["result"];
      resource["status"] = "succeeded";
    });
    expect(parse(succeeded)?.signal.status).toBe("succeeded");

    const failed = variant("event-build-complete-services", (resource) => {
      delete resource["result"];
      resource["status"] = "failed";
    });
    expect(parse(failed)?.signal.status).toBe("failed");
  });

  it("recovers the branch from sourceGetVersion when no branch field exists", () => {
    const event = variant("event-build-complete-services", (resource) => {
      delete resource["sourceBranch"];
      resource["triggerInfo"] = { "pr.number": "128" };
      resource["sourceGetVersion"] =
        "LG:refs/heads/feature/UGURPAY-4312-iban-validation:b7a41f3c9d825e0641a2b3c4d5e6f708192a3b4c";
    });
    expect(parse(event)?.signal.ticketKey).toBe("UGURPAY-4312");
  });

  it("falls back to lastChangedDate, then to the envelope date, for finishedAt", () => {
    const lastChanged = variant("event-build-complete-services", (resource) => {
      delete resource["finishTime"];
      resource["lastChangedDate"] = "2026-08-08T10:20:00.0000000Z";
    });
    expect(parse(lastChanged)?.signal.finishedAt).toBe("2026-08-08T10:20:00.000Z");

    const envelopeDate = variant("event-build-complete-services", (resource) => {
      delete resource["finishTime"];
    });
    expect(parse(envelopeDate)?.signal.finishedAt).toBe("2026-08-08T10:14:23.123Z");
  });

  it("reads a zone-less on-prem timestamp as UTC, not as local time", () => {
    const event = variant("event-build-complete-services", (resource) => {
      resource["finishTime"] = "2026-08-08T10:14:22.710";
    });
    expect(parse(event)?.signal.finishedAt).toBe("2026-08-08T10:14:22.710Z");
  });

  it("drops a details URL that is not a URL instead of failing the signal", () => {
    const event = variant("event-build-complete-services", (resource) => {
      resource["_links"] = { web: { href: "not-a-url" } };
    });
    const signal = parse(event)?.signal;
    expect(signal?.detailsUrl).toBeUndefined();
    expect(CiResultSignal.safeParse(signal).success).toBe(true);
  });

  it("throws instead of going silent when a build.complete resource is malformed", () => {
    const broken = { eventType: "build.complete", resource: { id: "not-a-number" } };
    expect(() => parse(broken)).toThrow(AdoResponseError);
  });

  it("throws when a Maestro build has no usable timestamp at all", () => {
    const event = structuredClone(fixture("event-build-complete-services")) as {
      resource: Record<string, unknown>;
      createdDate?: string;
    };
    delete event.resource["finishTime"];
    delete event.createdDate;
    expect(() => parse(event)).toThrow(/finish time/);
  });
});

describe("build provenance gate (K1: no forged green)", () => {
  it("rejects a manually queued build, whatever its result says", () => {
    // The attack the gate closes: queue an "always green" pipeline by hand
    // on the PR's merge ref. Branch policy never ran; the verdict is worth
    // nothing, and it must not reach the 10b gate.
    for (const reason of ["manual", "individualCI", "schedule", "batchedCI", undefined]) {
      const event = variant("event-build-complete-services", (resource) => {
        if (reason === undefined) delete resource["reason"];
        else resource["reason"] = reason;
      });
      expect(parse(event)).toBeNull();
    }
    // Sanity: the same payload with reason "pullRequest" does produce a signal.
    expect(parse(fixture("event-build-complete-services"))?.signal.status).toBe("succeeded");
  });

  it("rejects a build definition that is not allow-listed", () => {
    for (const definition of [{ id: 99, name: "always-green" }, undefined]) {
      const event = variant("event-build-complete-services", (resource) => {
        if (definition === undefined) delete resource["definition"];
        else resource["definition"] = definition;
      });
      expect(parse(event)).toBeNull();
    }
  });

  it("rejects a build from another project or another repository", () => {
    const otherProject = variant("event-build-complete-services", (resource) => {
      resource["project"] = { id: "x", name: "UgurSandbox" };
    });
    expect(parse(otherProject)).toBeNull();

    const otherRepo = variant("event-build-complete-services", (resource) => {
      resource["repository"] = { id: "x", type: "TfsGit", name: "ugurpay-fork" };
    });
    expect(parse(otherRepo)).toBeNull();

    // Definition 33 is allow-listed, but only for UgurWeb/ugurweb.
    const crossed = variant("event-build-complete-services", (resource) => {
      resource["definition"] = { id: 33, name: "ugurweb-pr-validation" };
    });
    expect(parse(crossed)).toBeNull();

    const missingContainers = variant("event-build-complete-services", (resource) => {
      delete resource["project"];
      delete resource["repository"];
    });
    expect(parse(missingContainers)).toBeNull();
  });

  it("matches project and repository case-insensitively, as ADO does", () => {
    const event = variant("event-build-complete-services", (resource) => {
      resource["project"] = { id: "x", name: "UGURPAY" };
      resource["repository"] = { id: "x", type: "TfsGit", name: "UgurPay" };
    });
    expect(parse(event)?.signal.ticketKey).toBe("UGURPAY-4312");
  });

  it("refuses to run at all with an empty allow-list", () => {
    // Fail-closed: "nothing configured" must never read as "trust anything".
    expect(() => parseBuildCompleteEvent(fixture("event-build-complete-services"), [])).toThrow(
      AdoConfigError,
    );
  });
});
