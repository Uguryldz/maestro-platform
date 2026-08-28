import { describe, expect, it } from "vitest";
import { CapabilityNotSupportedError, PortRegistry, type PublishPort } from "@maestro/ports";
import { PublishConfigError, PublishRenderError } from "../src/errors.js";
import { MaestroPublishPort, PUBLISH_PORT } from "../src/port.js";
import { PUBLISH_MULTI_DRIVER, createPublishPort, registerPublishDrivers } from "../src/register.js";
import { InMemoryPublishState, type PublishDeps } from "../src/types.js";
import {
  APP,
  FakeScmPort,
  FakeWorkPort,
  FakeWorkspace,
  fakeFetch,
  fakeSecrets,
  fakeTranslate,
  piiDeps,
  request,
  runContext,
} from "./helpers.js";

const CONFLUENCE = {
  baseUrl: "https://confluence.test",
  spaceKey: "MAESTRO",
  tokenRef: "secret/confluence-pat",
  retryDelayMs: 0,
};

function deps(overrides: Partial<PublishDeps> = {}): PublishDeps {
  // Minimal Confluence: nothing found, everything created as page 900.
  const { fetchImpl } = fakeFetch((req) =>
    req.method === "POST"
      ? { status: 200, body: { id: "900", version: { number: 1 }, body: { storage: { value: "" } } } }
      : { status: 200, body: { results: [] } },
  );
  return {
    translate: fakeTranslate(),
    runContext: runContext({ app: APP }),
    state: new InMemoryPublishState(),
    pii: piiDeps(),
    work: new FakeWorkPort().asPort(),
    scm: new FakeScmPort().asPort(),
    workspace: new FakeWorkspace(),
    secrets: fakeSecrets(),
    fetchImpl,
    sleep: () => Promise.resolve(),
    ...overrides,
  };
}

const DOC = "# Analiz\n\nmetin";

describe("publish port fan-out (M47)", () => {
  it("returns one receipt per requested target, in request order", async () => {
    const port = createPublishPort(["jira", "confluence", "repo-docs"], { confluence: CONFLUENCE }, deps());

    const receipts = await port.publish(request({ targets: ["repo-docs", "jira", "confluence"] }), DOC);

    expect(receipts.map((r) => r.target)).toEqual(["repo-docs", "jira", "confluence"]);
    expect(receipts.every((r) => r.ref.length > 0)).toBe(true);
  });

  it("publishes a repeated target once", async () => {
    const port = createPublishPort(["jira"], {}, deps());
    const receipts = await port.publish(request({ targets: ["jira", "jira"] }), DOC);
    expect(receipts).toHaveLength(1);
  });

  it("builds docx and pdf when a sink is wired (M103r)", () => {
    const port = createPublishPort(["docx", "pdf"], {}, deps({ sink: { put: () => Promise.resolve() } }));
    expect(port.targets().sort()).toEqual(["docx", "pdf"]);
  });

  it("refuses docx and pdf at COMPOSITION time when they cannot be built (M103r)", () => {
    // The refusal moved from "this target does not exist" to "this target
    // cannot store its file", but the MOMENT is the point and is unchanged: a
    // `jira+pdf` project must not compose, post the Jira comment and only then
    // fail — side effects done, no receipt, no way to tell what landed.
    expect(() => createPublishPort(["docx"], {}, deps())).toThrow(PublishConfigError);
    expect(() => createPublishPort(["pdf"], {}, deps())).toThrow(PublishConfigError);
    expect(() => createPublishPort(["jira", "pdf"], {}, deps())).toThrow(PublishConfigError);
  });

  it("does not touch a target when another in the set cannot be built", () => {
    const work = new FakeWorkPort();
    expect(() => createPublishPort(["jira", "docx"], {}, deps({ work: work.asPort() }))).toThrow(PublishConfigError);
    expect(work.calls).toHaveLength(0);
  });

  it("refuses a target this instance was not built for", async () => {
    const port = createPublishPort(["jira"], {}, deps());
    await expect(port.publish(request({ targets: ["confluence"] }), DOC)).rejects.toThrow(CapabilityNotSupportedError);
  });

  it("refuses an empty document and an invalid request", async () => {
    const port = createPublishPort(["jira"], {}, deps());
    await expect(port.publish(request(), "   \n ")).rejects.toThrow(PublishRenderError);
    await expect(port.publish(request({ targets: [] }), DOC)).rejects.toThrow();
    await expect(port.publish(request({ runId: "short" }), DOC)).rejects.toThrow();
  });

  it("fails the publish when one target fails — no partial receipt list", async () => {
    const failing = new FakeWorkPort();
    failing.addComment = () => Promise.reject(new Error("jira down"));
    const port = createPublishPort(["jira", "repo-docs"], {}, deps({ work: failing.asPort() }));

    await expect(port.publish(request({ targets: ["jira", "repo-docs"] }), DOC)).rejects.toThrow("jira down");
  });
});

describe("driver registration (M44)", () => {
  it("registers one driver per target plus the project-wide multi driver", () => {
    const registry = new PortRegistry();
    registerPublishDrivers(registry, deps());

    expect(registry.drivers(PUBLISH_PORT).sort()).toEqual(
      ["confluence", "docx", "jira", "multi", "pdf", "repo-docs"].sort(),
    );
  });

  it("resolves a driver into a working PublishPort", async () => {
    const registry = new PortRegistry();
    registerPublishDrivers(registry, deps());

    const port = registry.resolve<PublishPort>(PUBLISH_PORT, "jira")({});
    const receipts = await port.publish(request(), DOC);

    expect(receipts).toEqual([{ target: "jira", ref: "comment-1" }]);
  });

  it("builds the multi driver from the project's target set", async () => {
    const registry = new PortRegistry();
    registerPublishDrivers(registry, deps());

    const port = registry.resolve<MaestroPublishPort>(PUBLISH_PORT, PUBLISH_MULTI_DRIVER)({
      targets: ["jira", "repo-docs"],
      repoDocs: { openPullRequest: false },
    });

    expect(port.targets()).toEqual(["jira", "repo-docs"]);
    const receipts = await port.publish(request({ targets: ["jira", "repo-docs"] }), DOC);
    expect(receipts.map((r) => r.target)).toEqual(["jira", "repo-docs"]);
  });

  it("refuses the multi driver without a configured target set", () => {
    const registry = new PortRegistry();
    registerPublishDrivers(registry, deps());
    expect(() => registry.resolve(PUBLISH_PORT, PUBLISH_MULTI_DRIVER)({})).toThrow(PublishConfigError);
  });

  it("refuses configuration for a target whose collaborator is missing", () => {
    expect(() => createPublishPort(["confluence"], { confluence: CONFLUENCE }, deps({ secrets: undefined }))).toThrow(
      PublishConfigError,
    );
    expect(() => createPublishPort(["confluence"], {}, deps())).toThrow(PublishConfigError);
    expect(() => createPublishPort(["repo-docs"], {}, deps({ workspace: undefined }))).toThrow(PublishConfigError);
    expect(() => createPublishPort(["jira"], {}, deps({ work: undefined }))).toThrow(PublishConfigError);
  });

  it("refuses unknown configuration keys and missing core dependencies", () => {
    expect(() => createPublishPort(["jira"], { targetz: ["jira"] }, deps())).toThrow(PublishConfigError);
    expect(() => createPublishPort(["jira"], {}, deps({ translate: undefined as never }))).toThrow(PublishConfigError);
    expect(() => createPublishPort(["jira"], {}, deps({ state: undefined as never }))).toThrow(PublishConfigError);
    expect(() => createPublishPort(["jira"], {}, deps({ runContext: undefined as never }))).toThrow(
      PublishConfigError,
    );
  });
});
