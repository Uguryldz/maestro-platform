import { CapabilityNotSupportedError } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import { JiraDriverConfig } from "../src/config.js";
import { NotifyDeliveryError, NotifyRecipientError } from "../src/errors.js";
import { createJiraCommentNotifier } from "../src/jira.js";
import { aNotification, fakeSleep, fakeWorkPort } from "./helpers.js";

const CONFIG = JiraDriverConfig.parse({ retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 } });

function jiraNotification(to = ["UGURPAY-501"]) {
  return aNotification({ channel: "jira", to, messageKey: "notify.gate_reminder", params: { ticket: "UGURPAY-501", gate: "5", days: "2" } });
}

describe("jira comment driver (M44/M45)", () => {
  it("writes the catalog text through the injected WorkPort", async () => {
    const work = fakeWorkPort();
    await createJiraCommentNotifier(CONFIG, { work, sleep: fakeSleep().sleep }).send(jiraNotification());
    expect(work.comments).toEqual([
      { ticket: "UGURPAY-501", body: "UGURPAY-501 2 gündür 5 kapısında bekliyor" },
    ]);
  });

  it("comments on every ticket in `to`", async () => {
    const work = fakeWorkPort();
    await createJiraCommentNotifier(CONFIG, { work, sleep: fakeSleep().sleep }).send(
      jiraNotification(["UGURPAY-501", "UGURPAY-502"]),
    );
    expect(work.comments.map((comment) => comment.ticket)).toEqual(["UGURPAY-501", "UGURPAY-502"]);
  });

  it("rejects a recipient that is not a Jira issue key before sending anything", async () => {
    const work = fakeWorkPort();
    await expect(
      createJiraCommentNotifier(CONFIG, { work }).send(jiraNotification(["ops@bank.local"])),
    ).rejects.toThrow(NotifyRecipientError);
    expect(work.comments).toHaveLength(0);
  });

  it("retries a 503 from the work system", async () => {
    const work = fakeWorkPort((_ticket, call) => {
      if (call === 1) throw Object.assign(new Error("Jira down"), { status: 503 });
    });
    const sleep = fakeSleep();
    await createJiraCommentNotifier(CONFIG, { work, sleep: sleep.sleep }).send(jiraNotification());
    expect(work.comments).toHaveLength(1);
    expect(sleep.waits).toEqual([10]);
  });

  it("does not retry a 403 (missing Add Comment permission)", async () => {
    const work = fakeWorkPort(() => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    });
    const sleep = fakeSleep();
    const error = await createJiraCommentNotifier(CONFIG, { work, sleep: sleep.sleep })
      .send(jiraNotification())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotifyDeliveryError);
    expect((error as NotifyDeliveryError).attempts).toBe(1);
    expect(sleep.waits).toEqual([]);
  });

  it("treats an unsupported capability as permanent", async () => {
    const work = fakeWorkPort(() => {
      throw new CapabilityNotSupportedError("work", "addComment");
    });
    const error = await createJiraCommentNotifier(CONFIG, { work })
      .send(jiraNotification())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotifyDeliveryError);
    expect((error as NotifyDeliveryError).attempts).toBe(1);
  });

  it("retries a socket failure that carries no status", async () => {
    const work = fakeWorkPort((_ticket, call) => {
      if (call === 1) throw Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    });
    const sleep = fakeSleep();
    await createJiraCommentNotifier(CONFIG, { work, sleep: sleep.sleep }).send(jiraNotification());
    expect(work.comments).toHaveLength(1);
  });

  it("reports which tickets failed when only some did", async () => {
    const work = fakeWorkPort((ticket) => {
      if (ticket === "UGURPAY-502") throw Object.assign(new Error("gone"), { status: 404 });
    });
    const error = await createJiraCommentNotifier(CONFIG, { work })
      .send(jiraNotification(["UGURPAY-501", "UGURPAY-502"]))
      .catch((caught: unknown) => caught);
    expect(String(error)).toContain("UGURPAY-502");
    expect(work.comments.map((comment) => comment.ticket)).toEqual(["UGURPAY-501"]);
  });
});
