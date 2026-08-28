import { describe, expect, it } from "vitest";
import { GithubResponseError } from "../src/index.js";
import { fixture, pathOf, queryOf, REPO, scmDriver as driver } from "./helpers.js";

describe("GithubScmDriver review threads (12b loop)", () => {
  it("groups the flat review-comment list into threads by root id", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("pull-comments") }));
    const threads = await scm.listPrThreads(REPO, 128);

    expect(pathOf(calls[0]!)).toBe(
      "https://api.github.com/repos/ugurbank/ugurpay/pulls/128/comments",
    );
    expect(queryOf(calls[0]!, "per_page")).toBe("100");
    // 9001 (root) + its replies 9003, 9004 form one thread; 9002 is its own.
    expect(threads.map((t) => [t.threadId, t.comments.length])).toEqual([
      [9001, 3],
      [9002, 1],
    ]);
  });

  it("reports every mapped thread active (REST carries no resolved flag)", async () => {
    const { scm } = driver(() => ({ json: fixture("pull-comments") }));
    const threads = await scm.listPrThreads(REPO, 128);
    expect(threads.every((t) => t.status === "active")).toBe(true);
  });

  it("keeps reviewer login, body and timestamp, in GitHub order", async () => {
    const { scm } = driver(() => ({ json: fixture("pull-comments") }));
    const threads = await scm.listPrThreads(REPO, 128);

    expect(threads[0]!.comments).toEqual([
      {
        author: "tech-lead",
        text: "IBAN checksum should reject lowercase input as well.",
        at: "2026-08-08T10:31:07Z",
      },
      {
        author: "maestro-bot",
        text: "Uppercasing before the checksum now; added a lowercase test.",
        at: "2026-08-08T11:02:44Z",
      },
      {
        author: "tech-lead",
        text: "Looks good, thanks.",
        at: "2026-08-08T11:20:01Z",
      },
    ]);
  });

  it("keeps a reply whose parent is off the current page under the parent id", async () => {
    const { scm } = driver(() => ({
      json: [
        {
          id: 7002,
          in_reply_to_id: 7001,
          user: { login: "reviewer" },
          body: "orphaned reply",
          created_at: "2026-08-08T09:00:00Z",
        },
      ],
    }));
    const threads = await scm.listPrThreads(REPO, 128);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.threadId).toBe(7001);
  });

  it("replies inside the thread, parented to its root comment id", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("comment-reply-created") }));
    await scm.replyThread(REPO, 128, 9001, "Addressed in the latest iteration.");

    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(pathOf(call)).toBe(
      "https://api.github.com/repos/ugurbank/ugurpay/pulls/128/comments/9001/replies",
    );
    expect(call.body).toEqual({ body: "Addressed in the latest iteration." });
  });

  it("rejects a comments response that does not match the schema", async () => {
    const { scm } = driver(() => ({ json: [{ id: "nine-thousand" }] }));
    await expect(scm.listPrThreads(REPO, 128)).rejects.toBeInstanceOf(GithubResponseError);
  });
});
