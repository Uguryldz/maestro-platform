import type { NotifyPort } from "@maestro/ports";
import { PortRegistry } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import { JIRA_DRIVER, MULTI_DRIVER, NOTIFY_PORT, SLACK_DRIVER, SMTP_DRIVER, TEAMS_DRIVER } from "../src/config.js";
import { NotifyConfigError, NotifyPermanentError } from "../src/errors.js";
import { type NotifyDeps, registerNotifyDrivers } from "../src/register.js";
import { FakeFetch, FakeSocket, aNotification, fakeSecrets, fakeSleep, fakeWorkPort, happyRelayReplies } from "./helpers.js";

const WEBHOOK = "https://hooks.example.internal/ops/TOKEN";

function deps(overrides: Partial<NotifyDeps> = {}): NotifyDeps {
  return {
    fetchImpl: new FakeFetch().reply(200, "1").fetch,
    secrets: fakeSecrets({ hook: WEBHOOK, pw: "relay-password" }),
    work: fakeWorkPort(),
    socketFactory: async () => new FakeSocket(happyRelayReplies(1)),
    sleep: fakeSleep().sleep,
    ...overrides,
  };
}

const TEAMS_CONFIG = { targets: { ops: "hook" } };
const SMTP_CONFIG = { host: "mail.bank.local", from: "maestro@bank.local", username: "svc", passwordRef: "pw" };

describe("driver registration (M44)", () => {
  it("registers one driver per channel plus the composite", () => {
    const registry = new PortRegistry();
    registerNotifyDrivers(registry, deps());
    expect(registry.drivers(NOTIFY_PORT).sort()).toEqual(
      [TEAMS_DRIVER, SMTP_DRIVER, JIRA_DRIVER, SLACK_DRIVER, MULTI_DRIVER].sort(),
    );
  });

  it("resolves a working teams port through the registry", async () => {
    const registry = new PortRegistry();
    const fetch = new FakeFetch().reply(200, "1");
    registerNotifyDrivers(registry, deps({ fetchImpl: fetch.fetch }));
    const port = registry.resolve<NotifyPort>(NOTIFY_PORT, TEAMS_DRIVER)(TEAMS_CONFIG);
    await port.send(aNotification());
    expect(fetch.calls[0]?.url).toBe(WEBHOOK);
  });

  it("fails loudly when a required collaborator was not injected", () => {
    const registry = new PortRegistry();
    registerNotifyDrivers(registry, deps({ socketFactory: undefined }));
    expect(() => registry.resolve<NotifyPort>(NOTIFY_PORT, SMTP_DRIVER)(SMTP_CONFIG)).toThrow(
      /deps.socketFactory is required/,
    );
  });

  it("rejects an invalid driver configuration instead of guessing", () => {
    const registry = new PortRegistry();
    registerNotifyDrivers(registry, deps());
    expect(() => registry.resolve<NotifyPort>(NOTIFY_PORT, SMTP_DRIVER)({ host: "mail" })).toThrow(
      NotifyConfigError,
    );
  });
});

describe("composite driver (M71 channel selection)", () => {
  it("dispatches each notification to the channel it names", async () => {
    const registry = new PortRegistry();
    const fetch = new FakeFetch().reply(200, "1");
    const work = fakeWorkPort();
    registerNotifyDrivers(registry, deps({ fetchImpl: fetch.fetch, work }));
    const port = registry.resolve<NotifyPort>(NOTIFY_PORT, MULTI_DRIVER)({ teams: TEAMS_CONFIG, jira: {} });

    await port.send(aNotification());
    await port.send(
      aNotification({
        channel: "jira",
        to: ["UGURPAY-501"],
        messageKey: "notify.ci_red",
        params: { ticket: "UGURPAY-501" },
      }),
    );

    expect(fetch.calls).toHaveLength(1);
    expect(work.comments).toEqual([{ ticket: "UGURPAY-501", body: "UGURPAY-501 CI kırmızı — ajan düzeltme turunda" }]);
  });

  it("refuses a channel that is not enabled — no silent drop", async () => {
    const registry = new PortRegistry();
    registerNotifyDrivers(registry, deps());
    const port = registry.resolve<NotifyPort>(NOTIFY_PORT, MULTI_DRIVER)({ teams: TEAMS_CONFIG });
    await expect(port.send(aNotification({ channel: "slack" }))).rejects.toBeInstanceOf(NotifyPermanentError);
  });

  it("refuses a composite with no channel at all", () => {
    const registry = new PortRegistry();
    registerNotifyDrivers(registry, deps());
    expect(() => registry.resolve<NotifyPort>(NOTIFY_PORT, MULTI_DRIVER)({})).toThrow(/would notify nobody/);
  });
});
