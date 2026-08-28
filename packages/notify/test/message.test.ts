import { describe, expect, it } from "vitest";
import { NotifyRouting } from "../src/config.js";
import { NotifyMessageError, NotifyPermanentError } from "../src/errors.js";
import { renderMessage, requireNotification, routeNotification } from "../src/message.js";
import { aNotification } from "./helpers.js";

describe("message rendering (M104)", () => {
  it("resolves the body from the catalog, not from code", () => {
    const rendered = renderMessage(aNotification());
    expect(rendered.body).toBe("UGURPAY-501 için 5 bekliyor — sorumlu: Ayşe");
  });

  it("renders the same key in the other locale", () => {
    const rendered = renderMessage(aNotification({ locale: "en" }));
    expect(rendered.body).toBe("UGURPAY-501 is waiting for 5 — owner: Ayşe");
  });

  it("throws on a key the catalog does not have — never a silent skip", () => {
    expect(() => renderMessage(aNotification({ messageKey: "notify.nope" }))).toThrow(NotifyMessageError);
  });

  it("throws when a template parameter was not supplied", () => {
    const notification = aNotification({ params: { ticket: "UGURPAY-501" } });
    expect(() => renderMessage(notification)).toThrow(/missing parameter \{gate\}/);
  });

  it("keeps the subject on one line and bounded", () => {
    const long = "x".repeat(300);
    const rendered = renderMessage(
      aNotification({ params: { ticket: long, gate: "5", owner: "a\nb" } }),
    );
    expect(rendered.subject.length).toBe(120);
    expect(rendered.subject).not.toMatch(/[\r\n]/);
  });

  it("rejects a notification that does not satisfy the frozen contract", () => {
    expect(() => requireNotification("teams", { event: "gate_open" })).toThrow(NotifyPermanentError);
    expect(() => requireNotification("teams", aNotification({ to: [] }))).toThrow(/to/);
  });
});

describe("channel routing (M45/M71/M87)", () => {
  it("uses the per-event mapping and falls back to the default", () => {
    const routing = NotifyRouting.parse({ default: ["teams"], byEvent: { runner_health: ["slack", "smtp"] } });
    const health = routeNotification(routing, aNotification({ event: "runner_health" }));
    expect(health.notifications.map((n) => n.channel)).toEqual(["slack", "smtp"]);

    const gate = routeNotification(routing, aNotification());
    expect(gate.notifications.map((n) => n.channel)).toEqual(["teams"]);
  });

  it("de-duplicates channels so nobody is notified twice by a typo", () => {
    const routing = NotifyRouting.parse({ byEvent: { gate_open: ["teams", "teams", "jira"] } });
    expect(routeNotification(routing, aNotification()).notifications).toHaveLength(2);
  });

  it("reports an event muted by parameter instead of hiding it", () => {
    const routing = NotifyRouting.parse({ byEvent: { gate_open: [] } });
    const routed = routeNotification(routing, aNotification());
    expect(routed.muted).toBe(true);
    expect(routed.notifications).toEqual([]);
  });
});
