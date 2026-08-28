import { AuditCanonicalizationError } from "./errors.js";

/**
 * Canonical serialisation for hashing (M33).
 *
 * The hash of an audit record must depend on the record's *meaning*, never on
 * how a caller happened to build the object. `JSON.stringify` is unfit: key
 * order follows insertion order, so the same event hashed twice can produce two
 * hashes. This writer is deterministic instead:
 *
 *  · object keys are sorted by UTF-16 code unit (`Array.prototype.sort`);
 *  · no insignificant whitespace;
 *  · strings are JSON-escaped, and `|` is additionally escaped as a unicode escape so a
 *    string can never contain the field separator used by the chain input
 *    (`a|b` as one actor must not hash like actor `a` + subject `b`);
 *  · anything that cannot be represented without loss — `undefined`, functions,
 *    symbols, `NaN`/`Infinity`, BigInt, Map/Set/RegExp, class instances, cycles
 *    — is refused, never coerced or dropped. A silently dropped field would be
 *    a hole in the evidence.
 *
 * `Date` is the one accepted non-plain object: it serialises as its UTC ISO
 * string, which is the same value the rest of the platform stores.
 */
export function canonicalize(value: unknown): string {
  return write(value, "$", new Set<object>());
}

/** Canonical form of a string, including the `|` escape. Exported for the chain input. */
export function canonicalString(value: string): string {
  return escapeString(value);
}

function write(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return escapeString(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new AuditCanonicalizationError(path, `${String(value)} has no canonical form`);
      }
      // JSON.stringify gives the shortest round-tripping decimal form; -0 renders as 0.
      return JSON.stringify(value);
    case "bigint":
      throw new AuditCanonicalizationError(path, "bigint is ambiguous — pass it as a string");
    case "undefined":
      throw new AuditCanonicalizationError(path, "undefined cannot be hashed — omit the key or use null");
    case "function":
    case "symbol":
      throw new AuditCanonicalizationError(path, `${typeof value} is not data`);
    default:
      return writeObject(value as object, path, seen);
  }
}

function writeObject(value: object, path: string, seen: Set<object>): string {
  if (seen.has(value)) {
    throw new AuditCanonicalizationError(path, "circular reference");
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new AuditCanonicalizationError(path, "invalid Date");
    }
    return escapeString(value.toISOString());
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item, index) => write(item, `${path}[${index}]`, seen));
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AuditCanonicalizationError(path, `${value.constructor?.name ?? "object"} is not a plain object`);
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map((key) => `${escapeString(key)}:${write(record[key], `${path}.${key}`, seen)}`);
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * JSON string escaping plus `|`. `JSON.stringify` on a string is fully specified
 * (control characters and lone surrogates become `\uXXXX`), so its output is
 * stable across engines; the only addition is the separator escape.
 */
function escapeString(value: string): string {
  return JSON.stringify(value).replace(/\|/g, "\\u007c");
}
