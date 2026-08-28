import { AuditEvent } from "@maestro/contracts";
import { actionInfo } from "./actions.js";
import { parseActor } from "./actor.js";
import { canonicalize } from "./canonical.js";
import { AuditExportError } from "./errors.js";

/**
 * SIEM export (M33): ArcSight CEF over syslog. CEF was chosen because it is
 * collector-independent — Splunk, QRadar and ArcSight all parse it out of the
 * box, so the platform does not have to know which SIEM the bank runs.
 *
 *   CEF:0|Maestro|Maestro|<ver>|<action>|<name>|<severity>|<extension>
 *
 * Escaping is where CEF exports usually break, so both rules are implemented
 * strictly: in the header `\` and `|` are escaped; in the extension `\`, `=`
 * and newlines are escaped (a raw newline would split one event into two,
 * which is how a forged record gets injected into a SIEM).
 */
export const CEF_VERSION = 0;
export const CEF_VENDOR = "Maestro";
export const CEF_PRODUCT = "Maestro";

export interface CefOptions {
  /** Device Version header field — the Maestro release that emitted the record. */
  readonly deviceVersion?: string;
}

/** Escape a CEF *header* field: backslash and pipe; newlines cannot appear at all. */
export function escapeCefHeader(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

/** Escape a CEF *extension* value: backslash, equals, CR and LF. */
export function escapeCefExtension(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/=/g, "\\=")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

/** Render one audit record as a CEF line (no syslog framing). */
export function toCefLine(event: unknown, options: CefOptions = {}): string {
  const parsed = AuditEvent.safeParse(event);
  if (!parsed.success) {
    throw new AuditExportError(`record is not an AuditEvent: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  const record = parsed.data;
  const info = actionInfo(record.action);
  const identity = parseActor(record.actor);

  const header = [
    `CEF:${CEF_VERSION}`,
    escapeCefHeader(CEF_VENDOR),
    escapeCefHeader(CEF_PRODUCT),
    escapeCefHeader(options.deviceVersion ?? "0.1.0"),
    escapeCefHeader(record.action),
    escapeCefHeader(info.name),
    String(info.severity),
  ].join("|");

  const extension: [string, string][] = [
    ["rt", String(Date.parse(record.at))],
    ["externalId", String(record.seq)],
    ["suser", record.actor],
    ["act", record.action],
    ["cat", info.category],
    ["cs1Label", "subject"],
    ["cs1", record.subject],
    ["cs2Label", "eventHash"],
    ["cs2", record.hash],
    ["cs3Label", "prevHash"],
    ["cs3", record.prevHash],
  ];

  if (info.outcome) extension.push(["outcome", info.outcome]);
  if (identity?.kind === "ai_delegated") {
    // M101: the human whose token the AI borrowed stays visible in the SIEM.
    extension.push(["cs4Label", "delegatedBy"], ["cs4", identity.user]);
  }
  if (Object.keys(record.meta).length > 0) {
    extension.push(["cs5Label", "meta"], ["cs5", canonicalize(record.meta)]);
  }
  extension.push(["msg", `${info.name}: ${record.subject}`]);

  const rendered = extension.map(([key, value]) => `${key}=${escapeCefExtension(value)}`).join(" ");
  return `${header}|${rendered}`;
}

export function toCefLines(events: readonly unknown[], options: CefOptions = {}): string[] {
  return events.map((event) => toCefLine(event, options));
}

export interface SyslogOptions extends CefOptions {
  /** Hostname in the syslog header; the worker/BFF host in production. */
  readonly host: string;
  /** Syslog tag. Defaults to `maestro`. */
  readonly tag?: string;
  /** Syslog facility number. Defaults to 13 (log audit). */
  readonly facility?: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** CEF severity (0-10) → syslog severity (crit/err/warning/info). */
function syslogSeverity(cefSeverity: number): number {
  if (cefSeverity >= 9) return 2;
  if (cefSeverity >= 7) return 3;
  if (cefSeverity >= 4) return 4;
  return 6;
}

/**
 * RFC 3164 framing around the CEF line — the shape SIEM collectors expect from
 * a file drop or a UDP/TCP syslog feed. The timestamp is the record's own
 * instant in UTC, so replaying a file does not rewrite history.
 */
export function toSyslogLine(event: unknown, options: SyslogOptions): string {
  const parsed = AuditEvent.safeParse(event);
  if (!parsed.success) {
    throw new AuditExportError(`record is not an AuditEvent: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  if (options.host.trim().length === 0) throw new AuditExportError("syslog host must not be empty");

  const record = parsed.data;
  const facility = options.facility ?? 13;
  if (!Number.isInteger(facility) || facility < 0 || facility > 23) {
    throw new AuditExportError(`syslog facility ${facility} is out of range 0-23`);
  }
  const priority = facility * 8 + syslogSeverity(actionInfo(record.action).severity);

  const at = new Date(record.at);
  const month = MONTHS[at.getUTCMonth()] ?? "Jan";
  const day = String(at.getUTCDate()).padStart(2, " ");
  const time = [at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");

  const tag = (options.tag ?? "maestro").replace(/[^A-Za-z0-9_-]/g, "");
  return `<${priority}>${month} ${day} ${time} ${options.host.trim()} ${tag}: ${toCefLine(record, options)}`;
}
