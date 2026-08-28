import { z } from "zod";
import { IsoDateTime, RunId, TicketKey } from "@maestro/contracts";
import { InvalidKeyError } from "./errors.js";

/** M56: audit + evidence packages are retained for ten years. */
export const RETENTION_YEARS_DEFAULT = 10;

/** Retention buckets a stored object can belong to. Drives the key prefix and the tags. */
export const RetentionClass = z.enum(["evidence", "archive", "journal", "knowledge"]);
export type RetentionClass = z.infer<typeof RetentionClass>;

const MAX_KEY_BYTES = 1024;
// eslint-disable-next-line no-control-regex -- control characters are exactly what we reject
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Key safety. Both drivers apply the exact same rules so that a key accepted
 * by one backend is accepted by the other (driver invariance, masterplan §4).
 */
export function assertValidKey(key: string): void {
  if (key.length === 0) throw new InvalidKeyError(key, "empty");
  assertKeyByteLength(key);
  if (key.startsWith("/")) throw new InvalidKeyError(key, "must not start with '/'");
  if (key.endsWith("/")) throw new InvalidKeyError(key, "must not end with '/'");
  if (key.includes("//")) throw new InvalidKeyError(key, "must not contain an empty segment");
  if (key.includes("\\")) throw new InvalidKeyError(key, "must not contain a backslash");
  if (CONTROL_CHARS.test(key)) throw new InvalidKeyError(key, "must not contain control characters");
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new InvalidKeyError(key, "must not contain '.' or '..' segments");
  }
}

/**
 * S3's key-length ceiling. Applied to the *physical* key as well, so a tenant
 * `keyPrefix` cannot push an otherwise legal key past the limit at the endpoint.
 */
export function assertKeyByteLength(key: string): void {
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    throw new InvalidKeyError(key, `longer than ${MAX_KEY_BYTES} bytes`);
  }
}

/**
 * Retention class of one object, derived from its key. The class is a property
 * of the object, not of the deployment: an M65 workspace archive written
 * through the same driver as an M34 evidence package must not inherit the
 * evidence label. Keys outside the known layouts fall back to the driver default.
 */
export function retentionClassForKey(key: string, fallback: RetentionClass): RetentionClass {
  const top = key.split("/", 1)[0] ?? "";
  const parsed = RetentionClass.safeParse(top);
  return parsed.success ? parsed.data : fallback;
}

/** Prefixes are keys that may be empty or end in a separator. */
export function assertValidPrefix(prefix: string): void {
  if (prefix === "") return;
  assertValidKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}

/**
 * File names arrive from `contracts.EvidenceFile.name`, which is any non-empty
 * string: `test-report (junit).xml` and `rapor özet.pdf` (M59 — analysis output
 * is Turkish) are both legal and must not make the M34 closing step fail. The
 * key builder therefore *encodes* the name instead of rejecting it; only what
 * cannot live inside a single key segment stays forbidden.
 */
const FileName = z
  .string()
  .min(1)
  .refine((name) => !name.includes("/"), "file name must not contain '/'")
  .refine((name) => !CONTROL_CHARS.test(name), "file name must not contain control characters");

/** Percent-encodes one path segment; `decodeSegment` is its exact inverse. */
function encodeSegment(name: string): string {
  return encodeURIComponent(name);
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Four-digit calendar year — the width `parseEvidenceKey` accepts. */
const KeyYear = z.number().int().min(1000).max(9999);

const EvidenceKeyInput = z.object({
  ticketKey: TicketKey,
  runId: RunId,
  fileName: FileName,
  createdAt: IsoDateTime,
});
export type EvidenceKeyInput = z.infer<typeof EvidenceKeyInput>;

/**
 * Evidence package layout (M34 + M56): `evidence/<year>/<ticket>/<runId>/<file>`.
 * The year comes first so a lifecycle rule can expire a whole vintage with one
 * prefix, and the ticket is the second hop so auditors can list one ticket cheaply.
 */
export function evidenceKey(input: EvidenceKeyInput): string {
  const { ticketKey, runId, fileName, createdAt } = EvidenceKeyInput.parse(input);
  const key = `evidence/${utcYear(createdAt)}/${ticketKey}/${runId}/${encodeSegment(fileName)}`;
  assertValidKey(key);
  return key;
}

/** Prefix for every evidence object of one ticket in one year — for `list`. */
export function evidenceTicketPrefix(ticketKey: string, year: number): string {
  return `evidence/${KeyYear.parse(year)}/${TicketKey.parse(ticketKey)}/`;
}

const ArchiveKeyInput = z.object({
  ticketKey: TicketKey,
  fileName: FileName,
  createdAt: IsoDateTime,
});

/**
 * Workspace archive layout (M65): a dormant workspace is deleted from disk but
 * its session + journal survive here, so the ticket can be bootstrapped later.
 */
export function archiveKey(input: z.input<typeof ArchiveKeyInput>): string {
  const { ticketKey, fileName, createdAt } = ArchiveKeyInput.parse(input);
  const key = `archive/${utcYear(createdAt)}/${ticketKey}/${encodeSegment(fileName)}`;
  assertValidKey(key);
  return key;
}

/** Parses a key produced by `evidenceKey`; returns undefined for anything else. */
export function parseEvidenceKey(
  key: string,
): { year: number; ticketKey: string; runId: string; fileName: string } | undefined {
  const parts = key.split("/");
  if (parts.length !== 5 || parts[0] !== "evidence") return undefined;
  const [, yearText, ticketKey, runId, encoded] = parts as [string, string, string, string, string];
  const year = Number(yearText);
  if (!/^\d{4}$/.test(yearText) || !TicketKey.safeParse(ticketKey).success) return undefined;
  if (!RunId.safeParse(runId).success) return undefined;
  const fileName = decodeSegment(encoded);
  if (fileName === undefined || fileName.length === 0) return undefined;
  return { year, ticketKey, runId, fileName };
}

/**
 * Retention deadline. Uses UTC calendar arithmetic; a 29 February start rolls
 * to 1 March, which lengthens retention and is therefore always safe.
 */
export function retainUntil(fromIso: string, years: number = RETENTION_YEARS_DEFAULT): string {
  const parsedYears = z.number().int().positive().parse(years);
  const at = new Date(IsoDateTime.parse(fromIso));
  const until = new Date(at.getTime());
  until.setUTCFullYear(until.getUTCFullYear() + parsedYears);
  return until.toISOString();
}

export interface RetentionPolicy {
  retentionClass: RetentionClass;
  retentionYears: number;
  /** Days after which the object may move to a colder storage tier. */
  archiveAfterDays: number;
}

/** Default lifecycle per class (M56 / M65). Cold tiering is advisory metadata. */
export function retentionPolicy(retentionClass: RetentionClass): RetentionPolicy {
  const archiveAfterDays = retentionClass === "knowledge" ? 3650 : 90;
  return { retentionClass, retentionYears: RETENTION_YEARS_DEFAULT, archiveAfterDays };
}

/**
 * Object tags carrying the policy alongside the data, so a lifecycle rule (or a
 * restore drill, M66) can be reconstructed from the bucket alone.
 */
export function retentionTags(policy: RetentionPolicy): Record<string, string> {
  return {
    "maestro-class": policy.retentionClass,
    "maestro-retention-years": String(policy.retentionYears),
    "maestro-archive-after-days": String(policy.archiveAfterDays),
  };
}

/** Encodes tags as an `x-amz-tagging` header value (RFC 3986 url-encoded pairs). */
export function encodeTagging(tags: Record<string, string>): string {
  return Object.entries(tags)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function utcYear(iso: string): number {
  return new Date(iso).getUTCFullYear();
}
