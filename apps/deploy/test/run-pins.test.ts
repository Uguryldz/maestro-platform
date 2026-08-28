import { describe, expect, it } from "vitest";
import {
  activeAnalystVariantId,
  activeTemplateVersion,
  DEFAULT_ANALYST_VARIANT,
  UNVERSIONED_TEMPLATE,
  type RunPinDb,
} from "../src/stores/run-pins.js";

/**
 * What a run is pinned to when it opens.
 *
 * The fallbacks are the point. An empty variant is not a neutral default: it
 * reaches the gateway as a contract violation on the first model call, which is
 * how a run opened without one presents itself — as a model failure, three
 * activity retries away from the actual mistake.
 */

function db(over: Partial<RunPinDb> = {}): RunPinDb {
  return {
    variant: { findFirst: () => Promise.resolve(null) },
    analysisTemplateVersion: { findFirst: () => Promise.resolve(null) },
    ...over,
  };
}

describe("activeAnalystVariantId", () => {
  it("uses the analyst variant the deployment has", async () => {
    const id = await activeAnalystVariantId(
      db({ variant: { findFirst: () => Promise.resolve({ id: "analyst-kredi" }) } }),
    );
    expect(id).toBe("analyst-kredi");
  });

  it("falls back to a named variant rather than an empty string", async () => {
    expect(await activeAnalystVariantId(db())).toBe(DEFAULT_ANALYST_VARIANT);
    expect(DEFAULT_ANALYST_VARIANT.length).toBeGreaterThan(0);
  });

  it("asks for the analyst role, not whichever variant sorts first", async () => {
    // `engineer-default` sorts before `analyst-kredi` by id; asking without the
    // role filter would pin an analysis run to the engineering agent.
    let asked: unknown;
    await activeAnalystVariantId(
      db({
        variant: {
          findFirst: (args) => {
            asked = args.where;
            return Promise.resolve({ id: "analyst-kredi" });
          },
        },
      }),
    );
    expect(asked).toEqual({ role: "analyst" });
  });
});

describe("activeTemplateVersion", () => {
  it("pins the newest published version", async () => {
    const version = await activeTemplateVersion(
      db({ analysisTemplateVersion: { findFirst: () => Promise.resolve({ version: 7 }) } }),
    );
    expect(version).toBe("7");
  });

  it("names the absence rather than pinning an empty string", async () => {
    // `assertDocument` compares this against what the analyst stamped and
    // reports the mismatch; "" would make that message say nothing.
    expect(await activeTemplateVersion(db())).toBe(UNVERSIONED_TEMPLATE);
  });
});
