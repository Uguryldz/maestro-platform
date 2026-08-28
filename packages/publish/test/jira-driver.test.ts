import { describe, expect, it } from "vitest";
import type { AdfDoc } from "../src/adf.js";
import { JiraPublisher } from "../src/drivers/jira.js";
import { PublishConfigError, PublishRenderError } from "../src/errors.js";
import { InMemoryPublishState } from "../src/types.js";
import { FakeWorkPort, TICKET, request, runContext } from "./helpers.js";

function publisher(work = new FakeWorkPort(), state = new InMemoryPublishState()) {
  return { work, state, driver: new JiraPublisher({ work: work.asPort(), state, runContext: runContext() }) };
}

const DOC = "# Analiz\n\n- kabul kriteri";

describe("jira publish driver (M47)", () => {
  it("publishes through WorkPort as an ADF comment — no Jira client of its own", async () => {
    const { work, driver } = publisher();
    const receipt = await driver.publish(request(), DOC);

    expect(receipt).toEqual({ target: "jira", ref: "comment-1" });
    expect(work.calls).toHaveLength(1);
    expect(work.calls[0]?.method).toBe("addComment");
    expect(work.calls[0]?.args[0]).toBe(TICKET);
    const body = work.calls[0]?.args[1] as AdfDoc;
    expect(body.type).toBe("doc");
    expect(JSON.stringify(body)).toContain("kabul kriteri");
  });

  it("republishing the SAME document touches Jira zero times (idempotent)", async () => {
    const { work, driver } = publisher();
    const first = await driver.publish(request(), DOC);
    const second = await driver.publish(request(), DOC);

    expect(second).toEqual(first);
    expect(work.calls).toHaveLength(1);
  });

  it("edits the existing comment when the document changed — never a second comment (M75)", async () => {
    const { work, driver } = publisher();
    await driver.publish(request(), DOC);
    const receipt = await driver.publish(request(), `${DOC}\n\n- ikinci kriter`);

    expect(receipt.ref).toBe("comment-1");
    expect(work.calls.map((c) => c.method)).toEqual(["addComment", "updateComment"]);
    expect(work.calls[1]?.args[1]).toBe("comment-1");
    expect(JSON.stringify(work.calls[1]?.args[2])).toContain("ikinci kriter");
  });

  it("keeps one comment per document kind, not one per run", async () => {
    const { work, driver } = publisher();
    const analysis = await driver.publish(request({ doc: "analysis" }), DOC);
    const release = await driver.publish(request({ doc: "release_note" }), DOC);

    expect(analysis.ref).not.toBe(release.ref);
    expect(work.calls.map((c) => c.method)).toEqual(["addComment", "addComment"]);
  });

  it("survives unreadable bookkeeping by posting a new comment, never editing a stranger's", async () => {
    const state = new InMemoryPublishState();
    const { work, driver } = publisher(new FakeWorkPort(), state);
    await state.set("publish:jira:run-20260808-0001:analysis", "not json at all");
    await driver.publish(request(), DOC);

    expect(work.calls.map((c) => c.method)).toEqual(["addComment"]);
  });

  it("refuses an empty comment id instead of remembering nothing", async () => {
    const work = new FakeWorkPort();
    work.addComment = () => Promise.resolve({ commentId: "  " });
    const driver = new JiraPublisher({
      work: work.asPort(),
      state: new InMemoryPublishState(),
      runContext: runContext(),
    });

    await expect(driver.publish(request(), DOC)).rejects.toThrow(PublishConfigError);
  });

  it("refuses to be constructed without a WorkPort", () => {
    expect(
      () =>
        new JiraPublisher({
          work: undefined as never,
          state: new InMemoryPublishState(),
          runContext: runContext(),
        }),
    ).toThrow(PublishConfigError);
  });

  it("refuses a document that renders to an empty ADF comment", async () => {
    const { work, driver } = publisher();

    // `{ content: [] }` is not a valid ADF document; it used to be POSTed as a
    // blank Jira comment under a success receipt. One stray unterminated
    // comment in model output was enough to produce it.
    await expect(driver.publish(request(), "<!-- kapanmamis yorum")).rejects.toThrow(PublishRenderError);
    expect(work.calls).toHaveLength(0);
  });
});
