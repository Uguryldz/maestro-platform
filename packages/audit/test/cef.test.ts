import { AuditAction, type AuditEvent } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTION_INFO,
  AuditChain,
  AuditExportError,
  InMemoryAuditStore,
  actionInfo,
  canonicalize,
  escapeCefExtension,
  escapeCefHeader,
  toCefLine,
  toCefLines,
  toSyslogLine,
} from "../src/index.js";
import { fixedClock } from "./helpers.js";
import { parseCefLine } from "./cef-parser.js";

/** One record per action, written through the real chain. */
async function oneOfEach(): Promise<AuditEvent[]> {
  const chain = new AuditChain({
    store: new InMemoryAuditStore(),
    clock: fixedClock("2026-08-08T09:00:00.000Z"),
  });
  return chain.appendMany(
    AuditAction.options.map((action) => ({
      // Gate decisions may only be recorded for a human actor (M32).
      actor: AUDIT_ACTION_INFO[action].humanOnly ? "po.demir@ugurbank.corp" : "maestro-worker",
      action,
      subject: `UGURPAY-${action.length}`,
      meta: { note: `sample for ${action}` },
    })),
  );
}

describe("CEF export (M33)", () => {
  it("renders every AuditAction as a line a SIEM can parse", async () => {
    const events = await oneOfEach();
    expect(events).toHaveLength(AuditAction.options.length);

    for (const event of events) {
      const info = actionInfo(event.action);
      const parsed = parseCefLine(toCefLine(event, { deviceVersion: "1.4.0" }));

      expect(parsed.version).toBe(0);
      expect(parsed.vendor).toBe("Maestro");
      expect(parsed.product).toBe("Maestro");
      expect(parsed.deviceVersion).toBe("1.4.0");
      expect(parsed.deviceEventClassId).toBe(event.action);
      expect(parsed.name).toBe(info.name);
      expect(parsed.severity).toBe(info.severity);
      expect(parsed.severity).toBeGreaterThanOrEqual(0);
      expect(parsed.severity).toBeLessThanOrEqual(10);

      expect(parsed.extensions["rt"]).toBe(String(Date.parse(event.at)));
      expect(parsed.extensions["externalId"]).toBe(String(event.seq));
      expect(parsed.extensions["suser"]).toBe(event.actor);
      expect(parsed.extensions["act"]).toBe(event.action);
      expect(parsed.extensions["cat"]).toBe(info.category);
      expect(parsed.extensions["cs1"]).toBe(event.subject);
      expect(parsed.extensions["cs1Label"]).toBe("subject");
      expect(parsed.extensions["cs2"]).toBe(event.hash);
      expect(parsed.extensions["cs3"]).toBe(event.prevHash);
      expect(parsed.extensions["cs5"]).toBe(canonicalize(event.meta));
      expect(parsed.extensions["outcome"]).toBe(info.outcome);
      expect(parsed.extensions["msg"]).toContain(info.name);
    }
  });

  it("keeps the M101 delegating human visible in the SIEM", async () => {
    const chain = new AuditChain({ store: new InMemoryAuditStore(), clock: fixedClock("2026-08-08T09:00:00.000Z") });
    const event = await chain.append({
      actor: "ai-via:po.demir@ugurbank.corp",
      action: "ASSIGN_APP",
      subject: "UGURPAY-101",
    });
    const parsed = parseCefLine(toCefLine(event));

    expect(parsed.extensions["suser"]).toBe("ai-via:po.demir@ugurbank.corp");
    expect(parsed.extensions["cs4Label"]).toBe("delegatedBy");
    expect(parsed.extensions["cs4"]).toBe("po.demir@ugurbank.corp");
  });

  it("survives pipes, equals signs, backslashes and newlines in the data", async () => {
    const chain = new AuditChain({ store: new InMemoryAuditStore(), clock: fixedClock("2026-08-08T09:00:00.000Z") });
    const subject = 'UGURPAY-1|drop=all\\admin "quoted"';
    const event = await chain.append({
      actor: "maestro-worker",
      action: "SECURITY_SCAN_FAIL",
      subject,
      meta: { finding: "line one\nline two\r\nCEF:0|Evil|Evil|1|FAKE|Injected|10|", path: "C:\\repo\\src" },
    });

    const line = toCefLine(event);
    // A raw newline would split one event into two records at the collector —
    // which is how a forged event gets injected into a SIEM.
    expect(line.includes("\n")).toBe(false);
    expect(line.includes("\r")).toBe(false);

    const parsed = parseCefLine(line);
    // The injected "CEF:0|Evil|…" header inside the data stayed data.
    expect(parsed.vendor).toBe("Maestro");
    expect(parsed.deviceEventClassId).toBe("SECURITY_SCAN_FAIL");
    expect(parsed.name).toBe(actionInfo("SECURITY_SCAN_FAIL").name);
    expect(parsed.extensions["cs1"]).toBe(subject);
    expect(parsed.extensions["cs5"]).toBe(canonicalize(event.meta));
  });

  it("escapes header and extension by their own rules", () => {
    expect(escapeCefHeader("a|b\\c")).toBe("a\\|b\\\\c");
    expect(escapeCefHeader("a\nb")).toBe("a b");
    expect(escapeCefExtension("k=v\\x")).toBe("k\\=v\\\\x");
    expect(escapeCefExtension("a\r\nb")).toBe("a\\r\\nb");
    expect(escapeCefExtension("a|b")).toBe("a|b"); // pipes are legal inside the extension
  });

  it("omits the meta field when there is no meta", async () => {
    const chain = new AuditChain({ store: new InMemoryAuditStore(), clock: fixedClock("2026-08-08T09:00:00.000Z") });
    const event = await chain.append({ actor: "maestro-worker", action: "RUN_CLOSED", subject: "UGURPAY-1" });
    const parsed = parseCefLine(toCefLine(event));

    expect(parsed.extensions["cs5"]).toBeUndefined();
    expect(parsed.extensions["cs5Label"]).toBeUndefined();
  });

  it("refuses to export anything that is not an AuditEvent", () => {
    expect(() => toCefLine({ seq: 1, actor: "x" })).toThrow(AuditExportError);
    expect(() => toCefLine(null)).toThrow(AuditExportError);
  });

  it("exports a batch in order", async () => {
    const events = await oneOfEach();
    const lines = toCefLines(events);
    expect(lines).toHaveLength(events.length);
    expect(lines.every((line) => line.startsWith("CEF:0|Maestro|Maestro|"))).toBe(true);
  });
});

describe("syslog framing", () => {
  it("wraps the CEF line in an RFC 3164 header", async () => {
    const events = await oneOfEach();
    const killSwitch = events.find((event) => event.action === "KILL_SWITCH")!;
    const line = toSyslogLine(killSwitch, { host: "maestro-worker-01", tag: "maestro" });

    // facility 13 (log audit) * 8 + severity 2 (critical, CEF 10) = 106
    expect(line.startsWith("<106>Aug ")).toBe(true);
    expect(line).toMatch(/^<106>Aug [ \d]\d \d\d:\d\d:\d\d maestro-worker-01 maestro: CEF:0\|/);
    expect(parseCefLine(line.slice(line.indexOf("CEF:0|"))).deviceEventClassId).toBe("KILL_SWITCH");
  });

  it("maps CEF severity onto syslog severity", async () => {
    const events = await oneOfEach();
    const priorities = new Map<string, number>();
    for (const event of events) {
      const line = toSyslogLine(event, { host: "h" });
      priorities.set(event.action, Number(line.slice(1, line.indexOf(">"))));
    }

    expect(priorities.get("RUN_STARTED")).toBe(13 * 8 + 6); // informational
    expect(priorities.get("GATE_APPROVE")).toBe(13 * 8 + 4); // warning
    expect(priorities.get("SECURITY_SCAN_FAIL")).toBe(13 * 8 + 3); // error
    expect(priorities.get("KILL_SWITCH")).toBe(13 * 8 + 2); // critical
  });

  it("rejects a missing host or an out-of-range facility", async () => {
    const [event] = await oneOfEach();
    expect(() => toSyslogLine(event!, { host: "  " })).toThrow(AuditExportError);
    expect(() => toSyslogLine(event!, { host: "h", facility: 24 })).toThrow(/facility/);
  });
});
