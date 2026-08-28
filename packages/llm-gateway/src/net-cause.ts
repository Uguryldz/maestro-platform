/**
 * Why a fetch REALLY failed — read from the error's `code` chain, never from
 * its message.
 *
 * Node's `fetch` (undici) wraps every transport failure in a generic
 * `TypeError: fetch failed` and buries the truth in `error.cause`: a DNS miss
 * is `ENOTFOUND`, a closed port is `ECONNREFUSED` (often inside an
 * `AggregateError`, one entry per dialled address), a corporate/self-signed
 * certificate is `SELF_SIGNED_CERT_IN_CHAIN` or one of its OpenSSL siblings.
 * Anything that renders only the outer message therefore tells an operator
 * "unreachable" for four completely different repairs — the defect that left
 * an on-prem OpenShift model server saying "Adrese ulaşılamadı" when the real
 * problem was an unintroduced corporate root CA.
 *
 * THE SECRECY RULE this module leans on: only `code`/`name` fields are ever
 * read, NEVER `message`. A message can quote the URL, the request headers and
 * therefore the credential; a code is a vendor constant (`ENOTFOUND`,
 * `CERT_HAS_EXPIRED`) that structurally cannot carry any of that. What this
 * module returns is safe to log, to persist and to show.
 */

/** DNS never produced an address — the name is wrong or the resolver is. */
const DNS_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN"]);

/** Something answered the network but nothing listens on that port. */
const REFUSED_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED"]);

/**
 * Nothing answered in time — undici's own timeout codes plus the socket-level
 * one, plus the NAMES an `AbortSignal.timeout()` rejection carries (a
 * `DOMException` has a numeric legacy `code`, so it is recognised by name).
 */
const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);
const TIMEOUT_NAMES: ReadonlySet<string> = new Set(["TimeoutError", "AbortError"]);

/**
 * The certificate could not be verified. The first four are what a
 * self-signed or corporate-CA chain actually produces (which one depends on
 * where in the chain verification broke); the issuer pair is the classic
 * "root CA not installed on this machine"; the altname code is a certificate
 * for the wrong host. All of them have the SAME operator answer on this
 * deployment — introduce the corporate root CA via `NODE_EXTRA_CA_CERTS` (or
 * fix the certificate) — so they classify as one kind and the message names
 * the exact code.
 */
const TLS_CODES: ReadonlySet<string> = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

export type NetworkFailureKind = "dns" | "refused" | "timeout" | "tls";

export interface NetworkFailure {
  /** What broke, or `null` when the codes name nothing this module knows. */
  kind: NetworkFailureKind | null;
  /** The single code that decided `kind`, when one did. */
  code?: string;
  /**
   * Every code (and timeout-shaped name) on the cause chain, outermost first
   * and de-duplicated — the payload a server-side log line should carry.
   */
  codes: readonly string[];
}

/**
 * Walk `error` → `cause` → … (and each member of an `AggregateError`),
 * collecting `code` strings. Depth-capped and cycle-guarded because a cause
 * chain is caller-supplied data, not something to trust with the stack.
 */
export function collectFailureCodes(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    const record = node as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === "string" && record.code !== "") {
      if (!codes.includes(record.code)) codes.push(record.code);
    } else if (typeof record.name === "string" && TIMEOUT_NAMES.has(record.name)) {
      // Only timeout-shaped names: a bare `Error`/`TypeError` name says nothing.
      if (!codes.includes(record.name)) codes.push(record.name);
    }
    if (Array.isArray(record.errors)) for (const entry of record.errors) walk(entry, depth + 1);
    walk(record.cause, depth + 1);
  };
  walk(error, 0);
  return codes;
}

/**
 * Classify a thrown fetch failure. TLS is checked FIRST: a broken handshake
 * can sit beside a retry's socket code on the same chain, and "your CA is not
 * trusted" is the diagnosis with the concrete fix. Anything unrecognised
 * stays `kind: null` — the caller keeps its honest last-resort "unreachable"
 * rather than this module guessing.
 */
export function classifyNetworkFailure(error: unknown): NetworkFailure {
  const codes = collectFailureCodes(error);
  const tls = codes.find((code) => TLS_CODES.has(code) || code.startsWith("ERR_TLS_"));
  if (tls !== undefined) return { kind: "tls", code: tls, codes };
  const dns = codes.find((code) => DNS_CODES.has(code));
  if (dns !== undefined) return { kind: "dns", code: dns, codes };
  const refused = codes.find((code) => REFUSED_CODES.has(code));
  if (refused !== undefined) return { kind: "refused", code: refused, codes };
  const timeout = codes.find((code) => TIMEOUT_CODES.has(code) || TIMEOUT_NAMES.has(code));
  if (timeout !== undefined) return { kind: "timeout", code: timeout, codes };
  return { kind: null, codes };
}

/**
 * A one-line, secret-free human summary for error MESSAGES that end up in a
 * run journal (`String(error)` in `packages/workflows` is what a failed step
 * records). Turkish on purpose: the journal's own prose is Turkish, and this
 * string is composed at throw time where no locale or catalog is in reach —
 * the panel's connection test does NOT use this, it maps `kind` to catalog
 * keys so tr/en parity holds there (M104).
 */
export function networkFailureSummary(error: unknown): string | null {
  const failure = classifyNetworkFailure(error);
  switch (failure.kind) {
    case "tls":
      return `TLS sertifikası doğrulanamadı (${failure.code ?? "?"}) — bağlantı ayarında "TLS doğrulamasını atla"yı açın ya da kurumsal kök CA'yı NODE_EXTRA_CA_CERTS ile tanıtın`;
    case "dns":
      return `sunucu adı çözülemedi (DNS, ${failure.code ?? "?"})`;
    case "refused":
      return `bağlantı reddedildi (${failure.code ?? "?"}) — hedef port dinlemiyor olabilir`;
    case "timeout":
      return `zaman aşımı (${failure.code ?? "?"}) — güvenlik duvarı veya yanlış port olabilir`;
    case null:
      return failure.codes.length === 0 ? null : failure.codes.join(" → ");
  }
}
