/**
 * A CEF reader written from the format rules alone — deliberately NOT the
 * inverse of `src/cef.ts`. If both sides shared code, a wrong escape rule would
 * round-trip happily and still be unreadable to Splunk or QRadar; here the
 * decoder is an independent implementation, so the round-trip test is evidence.
 */
export interface ParsedCef {
  readonly version: number;
  readonly vendor: string;
  readonly product: string;
  readonly deviceVersion: string;
  readonly deviceEventClassId: string;
  readonly name: string;
  readonly severity: number;
  readonly extensions: Record<string, string>;
}

export function parseCefLine(line: string): ParsedCef {
  if (line.includes("\n") || line.includes("\r")) throw new Error("a CEF event must be a single line");
  if (!line.startsWith("CEF:")) throw new Error("line does not start with CEF:");

  const { fields, rest } = splitHeader(line, 7);
  const [prefix, vendor, product, deviceVersion, classId, name, severity] = fields;
  if (severity === undefined) throw new Error("CEF header is incomplete");

  return {
    version: Number(prefix!.slice("CEF:".length)),
    vendor: vendor!,
    product: product!,
    deviceVersion: deviceVersion!,
    deviceEventClassId: classId!,
    name: name!,
    severity: Number(severity),
    extensions: parseExtension(rest),
  };
}

/** Split off `count` header fields on unescaped pipes; the remainder is the extension. */
function splitHeader(line: string, count: number): { fields: string[]; rest: string } {
  const fields: string[] = [];
  let current = "";
  let index = 0;

  while (index < line.length) {
    const char = line[index]!;
    if (char === "\\" && index + 1 < line.length) {
      const next = line[index + 1]!;
      // Only `\\` and `\|` are defined header escapes.
      current += next === "|" || next === "\\" ? next : `\\${next}`;
      index += 2;
      continue;
    }
    if (char === "|") {
      fields.push(current);
      current = "";
      index += 1;
      if (fields.length === count) return { fields, rest: line.slice(index) };
      continue;
    }
    current += char;
    index += 1;
  }

  throw new Error(`CEF header has only ${fields.length} fields`);
}

/**
 * Extension is `key=value` pairs separated by spaces. Values may contain spaces,
 * so a value ends at the space that precedes the next unescaped `=`.
 */
function parseExtension(extension: string): Record<string, string> {
  const keyStarts: { key: string; keyStart: number; valueStart: number }[] = [];

  for (let index = 0; index < extension.length; index += 1) {
    if (extension[index] !== "=" || extension[index - 1] === "\\") continue;
    let keyStart = index;
    while (keyStart > 0 && extension[keyStart - 1] !== " ") keyStart -= 1;
    const key = extension.slice(keyStart, index);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error(`unparseable extension key ${JSON.stringify(key)}`);
    keyStarts.push({ key, keyStart, valueStart: index + 1 });
  }

  const result: Record<string, string> = {};
  keyStarts.forEach((entry, position) => {
    const next = keyStarts[position + 1];
    const end = next ? next.keyStart - 1 : extension.length;
    if (end < entry.valueStart) throw new Error(`extension value for ${entry.key} is malformed`);
    result[entry.key] = unescapeExtension(extension.slice(entry.valueStart, end));
  });
  return result;
}

function unescapeExtension(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) throw new Error("extension value ends with a dangling escape");
    out += next === "n" ? "\n" : next === "r" ? "\r" : next;
    index += 1;
  }
  return out;
}
