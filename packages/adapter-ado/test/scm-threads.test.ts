import { describe, expect, it } from "vitest";
import { AdoResponseError } from "../src/index.js";
import { fixture, pathOf, REPO, scmDriver as driver } from "./helpers.js";

describe("AdoScmDriver review threads (12b loop)", () => {
  it("maps ADO thread statuses onto the port's three states", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("threads-list") }));
    const threads = await scm.listPrThreads(REPO, 128);

    expect(pathOf(calls[0]!)).toBe(
      "https://dev.azure.com/ugurbank/UgurPay/_apis/git/repositories/ugurpay/pullrequests/128/threads",
    );
    expect(threads.map((t) => [t.threadId, t.status])).toEqual([
      [9001, "active"],
      [9002, "fixed"],
      [9003, "closed"],
      [9006, "active"],
    ]);
  });

  it("keeps reviewer comments with author and timestamp", async () => {
    const { scm } = driver(() => ({ json: fixture("threads-list") }));
    const threads = await scm.listPrThreads(REPO, 128);

    expect(threads[0]!.comments).toEqual([
      {
        author: "Tech Lead",
        text: "IBAN checksum should reject lowercase input as well.",
        at: "2026-08-08T10:31:07.253Z",
      },
    ]);
    expect(threads[1]!.comments).toHaveLength(2);
  });

  it("drops deleted threads and system (vote/policy) threads", async () => {
    const { scm } = driver(() => ({ json: fixture("threads-list") }));
    const ids = (await scm.listPrThreads(REPO, 128)).map((t) => t.threadId);
    expect(ids).not.toContain(9004); // vote update, system comment only
    expect(ids).not.toContain(9005); // deleted thread
  });

  it("replies inside the thread, parented to its first comment", async () => {
    const { scm, calls } = driver(() => ({ json: fixture("thread-comment-created") }));
    await scm.replyThread(REPO, 128, 9001, "Addressed in the latest iteration.");

    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(pathOf(call)).toBe(
      "https://dev.azure.com/ugurbank/UgurPay/_apis/git/repositories/ugurpay" +
        "/pullrequests/128/threads/9001/comments",
    );
    expect(call.body).toEqual({
      content: "Addressed in the latest iteration.",
      parentCommentId: 1,
      commentType: "text",
    });
  });

  it("rejects a threads response that does not match the schema", async () => {
    const { scm } = driver(() => ({ json: { value: [{ id: "nine-thousand" }] } }));
    await expect(scm.listPrThreads(REPO, 128)).rejects.toBeInstanceOf(AdoResponseError);
  });
});
