import {
  countField,
  countOccurrence,
  newAccumulator,
  toCounts,
  type CountAccumulator,
} from "./counts.js";
import { detectorPriority } from "./detectors/index.js";
import { PiiArgumentError, PiiLeakError } from "./errors.js";
import { compileProfile, type CompiledProfile } from "./policy.js";
import { ReverseMap } from "./reverse-map.js";
import {
  PII_TYPES,
  TOKEN_SHAPE_SOURCE,
  WHOLE_TOKEN_PATTERN,
  type MaskCounts,
  type MaskProfile,
  type PiiMatch,
  type PiiType,
} from "./types.js";

/** Guards against cycles and pathological payloads alike. */
const MAX_DEPTH = 64;

/**
 * One masking session: a compiled profile plus the ReverseMap that gives the
 * session its token numbering. Reusing a session across a whole LLM exchange
 * is what makes `[TCKN_1]` mean the same person in the prompt and in the
 * answer; a fresh session per exchange is what keeps the map short-lived.
 */
export interface MaskSession {
  readonly profile: CompiledProfile;
  readonly map: ReverseMap;
}

export function createSession(profile: MaskProfile, nonce?: string): MaskSession {
  return { profile: compileProfile(profile), map: new ReverseMap(nonce) };
}

export function createSessionWith(profile: CompiledProfile, nonce?: string): MaskSession {
  return { profile, map: new ReverseMap(nonce) };
}

export interface MaskTextResult {
  readonly text: string;
  readonly counts: MaskCounts;
}

export interface MaskValueResult<T> {
  readonly value: T;
  readonly counts: MaskCounts;
}

/**
 * All detectors run over the whole string; overlaps are then resolved
 * left-to-right, longest-first, detector priority breaking ties. Running them
 * independently and reconciling afterwards is what keeps an IBAN from being
 * chopped up by the phone detector.
 */
function collectMatches(text: string, profile: CompiledProfile): PiiMatch[] {
  const all: PiiMatch[] = [];
  for (const detector of profile.detectors) {
    all.push(...detector.scan(text, profile.detectorContext));
  }
  if (all.length < 2) return all;
  all.sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) ||
      detectorPriority(a.type) - detectorPriority(b.type),
  );
  const picked: PiiMatch[] = [];
  let consumedTo = 0;
  for (const m of all) {
    if (m.start < consumedTo) continue;
    picked.push(m);
    consumedTo = m.end;
  }
  return picked;
}

const TOKEN_SHAPE = new RegExp(TOKEN_SHAPE_SOURCE, "g");

/**
 * Strip the brackets off every token-shaped string this session did not mint.
 *
 * A `[TCKN_1]` sitting in a Jira description is not a token, it is user input,
 * and leaving it alone let `unmask` fill it in afterwards with whatever
 * `[TCKN_1]` happened to mean — another ticket's customer (verifier B-9).
 * De-fanging costs the reader nothing (`TCKN_1` still reads the same) and is
 * not counted as masking, because nothing was disclosed.
 */
function defangForeignTokens(text: string, map: ReverseMap): string {
  if (!text.includes("[")) return text;
  return text.replace(TOKEN_SHAPE, (token) => (map.has(token) ? token : token.slice(1, -1)));
}

function maskInto(text: string, session: MaskSession, acc: CountAccumulator): string {
  const source = defangForeignTokens(text, session.map);
  const matches = collectMatches(source, session.profile);
  if (matches.length === 0) return source;
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    out += source.slice(cursor, m.start);
    out += session.map.tokenFor(m.type, m.canonical, m.text);
    cursor = m.end;
    countOccurrence(acc, m.type);
  }
  return out + source.slice(cursor);
}

/** Mask a bare string. Counts one "field" when anything changed. */
export function maskText(text: string, session: MaskSession): MaskTextResult {
  const acc = newAccumulator();
  const masked = maskInto(text, session, acc);
  if (masked !== text) countField(acc);
  return { text: masked, counts: toCounts(acc) };
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function maskString(
  value: string,
  session: MaskSession,
  acc: CountAccumulator,
  fieldRuleApplies: boolean,
): string {
  if (!fieldRuleApplies) return maskInto(value, session, acc);
  // An already-masked value must survive a second pass unchanged, otherwise
  // masking twice would mint `[FIELD_n]` around `[TCKN_1.a3f9]`. The shape now
  // requires a nonce, so a bare `[FIELD_1]` typed by a user is not exempt; a
  // well-formed token from *another* session is exempt but inert, because no
  // map here can open it.
  if (value.length === 0 || session.map.has(value) || WHOLE_TOKEN_PATTERN.test(value)) return value;
  countOccurrence(acc, "field");
  return session.map.tokenFor("field", value, value);
}

function walk(
  value: unknown,
  session: MaskSession,
  acc: CountAccumulator,
  path: string,
  depth: number,
  fieldRuleApplies: boolean,
): unknown {
  if (depth > MAX_DEPTH) {
    throw new PiiArgumentError(path, "payload is circular or nested deeper than 64 levels");
  }
  if (value === null || value === undefined || typeof value === "boolean") return value;

  if (typeof value === "string") {
    const masked = maskString(value, session, acc, fieldRuleApplies);
    if (masked !== value) countField(acc);
    return masked;
  }

  // Numbers are scanned as text: an identifier does not stop being an
  // identifier because someone stored it as a number, and letting it through
  // untouched would be exactly the silent leak this package exists to stop.
  if (typeof value === "number" || typeof value === "bigint") {
    const asText = String(value);
    const masked = maskString(asText, session, acc, fieldRuleApplies);
    if (masked === asText) return value;
    countField(acc);
    return masked;
  }

  if (typeof value !== "object") {
    throw new PiiArgumentError(path, `${typeof value} values cannot be masked`);
  }
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      walk(item, session, acc, `${path}[${i}]`, depth + 1, fieldRuleApplies),
    );
  }
  if (value instanceof Date) return value;
  if (!isPlainObject(value)) {
    // Fail closed: we cannot promise we visited every string of a Map, a Set
    // or a class instance, so we refuse instead of masking part of it.
    throw new PiiArgumentError(path, "only plain objects, arrays, Dates and primitives are maskable");
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = walk(
      item,
      session,
      acc,
      path === "" ? key : `${path}.${key}`,
      depth + 1,
      session.profile.fieldRules.has(key.toLowerCase()),
    );
  }
  return out;
}

/**
 * Mask any JSON-shaped payload. The input is never mutated; masking an
 * already-masked payload is a no-op (tokens match no detector).
 */
export function maskValue<T>(value: T, session: MaskSession): MaskValueResult<T> {
  const acc = newAccumulator();
  const masked = walk(value, session, acc, "", 0, false) as T;
  return { value: masked, counts: toCounts(acc) };
}

function unwalk(value: unknown, map: ReverseMap, path: string, depth: number): unknown {
  if (depth > MAX_DEPTH) {
    throw new PiiArgumentError(path, "payload is circular or nested deeper than 64 levels");
  }
  if (typeof value === "string") return map.unmask(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v, i) => unwalk(v, map, `${path}[${i}]`, depth + 1));
  if (value instanceof Date) return value;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = unwalk(item, map, path === "" ? key : `${path}.${key}`, depth + 1);
  }
  return out;
}

/** Put real values back into model output — user-facing surfaces only (M20). */
export function unmaskValue<T>(value: T, map: ReverseMap): T {
  return unwalk(value, map, "", 0) as T;
}

/**
 * Every string of a payload that masking does not rewrite: object keys.
 *
 * `{ "12345678950": { balance: … } }` is an ordinary per-customer map, and a
 * masker that renamed keys would hand the callee a payload its schema no
 * longer fits — so masking leaves keys alone and the tripwire refuses them
 * instead (verifier B-10). This is also the one thing the tripwire genuinely
 * sees that the masker cannot: everywhere else they share detectors, and
 * RAPOR §2 no longer claims otherwise.
 */
function countKeyPii(value: unknown, profile: CompiledProfile, acc: CountAccumulator): void {
  if (value === null || typeof value !== "object") return;
  if (value instanceof Date) return;
  if (Array.isArray(value)) {
    for (const item of value) countKeyPii(item, profile, acc);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    for (const match of collectMatches(key, profile)) countOccurrence(acc, match.type);
    countKeyPii(item, profile, acc);
  }
}

/**
 * Count the PII in a payload without keeping any of it: the ReverseMap this
 * creates is discarded with the call frame. Keys are counted as well as
 * values, because this is a leak detector rather than a transformer.
 */
export function scanForPii(value: unknown, profile: CompiledProfile): MaskCounts {
  const session = createSessionWith(profile);
  const acc = newAccumulator();
  walk(value, session, acc, "", 0, false);
  countKeyPii(value, profile, acc);
  return toCounts(acc);
}

/**
 * Egress tripwire. Install it at any place raw data could leave the process
 * (LLM call, artifact write, notification) and unmasked PII becomes an
 * exception instead of a disclosure.
 */
export function assertNoPii(value: unknown, profile: CompiledProfile, boundary: string): void {
  const counts = scanForPii(value, profile);
  if (counts.occurrences === 0) return;
  const types = PII_TYPES.filter((t): t is PiiType => counts.byType[t] !== undefined);
  throw new PiiLeakError(boundary, types, counts.occurrences);
}
