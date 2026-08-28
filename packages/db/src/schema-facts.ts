/**
 * Pure text helpers over `prisma/schema.prisma`.
 *
 * The Prisma schema is the source of truth for the physical model, but it is
 * not TypeScript — nothing stops it from drifting away from
 * `@maestro/contracts`. These parsers let the test-suite assert the two in
 * lock-step (enum options, table coverage of the generated migration) without
 * pulling in a Prisma parser dependency or touching a database.
 *
 * The grammar handled here is deliberately narrow: the block shapes actually
 * used by our schema (`enum X { ... }`, `model X { ... }`, `/// doc` lines,
 * `// line comments`). It is not a general Prisma parser.
 */

/** An `enum` block: Prisma name, member names, and the leading `///` doc line. */
export interface SchemaEnum {
  name: string;
  values: string[];
  /** Text of the `///` doc comment directly above the block, if any. */
  doc: string | null;
}

/** A `model` block: Prisma name and the physical table name it maps to. */
export interface SchemaModel {
  name: string;
  /** `@@map("...")` when present, otherwise the model name. */
  tableName: string;
}

const ENUM_BLOCK = /(?:^|\n)((?:[ \t]*\/\/\/[^\n]*\n)*)[ \t]*enum[ \t]+(\w+)[ \t]*\{([^}]*)\}/g;
const MODEL_BLOCK = /(?:^|\n)[ \t]*model[ \t]+(\w+)[ \t]*\{([^}]*)\}/g;
const MAP_ATTRIBUTE = /@@map\("([^"]+)"\)/;

/** Strip `//` and `///` comments from a block body, keeping line structure. */
function stripComments(body: string): string {
  return body
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function lastDocLine(docBlock: string): string | null {
  const lines = docBlock
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("///"))
    .map((l) => l.replace(/^\/\/\/\s?/, "").trim());
  return lines.length > 0 ? (lines[lines.length - 1] ?? null) : null;
}

/**
 * Parse every `enum` block. Member names are returned verbatim — our
 * convention forbids `@map` on enum members precisely so that the Prisma
 * value and the contract value are the same string.
 */
export function parseEnums(schemaText: string): SchemaEnum[] {
  const out: SchemaEnum[] = [];
  for (const match of schemaText.matchAll(ENUM_BLOCK)) {
    const [, doc = "", name = "", body = ""] = match;
    const values = stripComments(body)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.split(/\s+/)[0] ?? "");
    out.push({ name, values, doc: lastDocLine(doc) });
  }
  return out;
}

/** Parse every `model` block and resolve its physical table name. */
export function parseModels(schemaText: string): SchemaModel[] {
  const out: SchemaModel[] = [];
  for (const match of schemaText.matchAll(MODEL_BLOCK)) {
    const [, name = "", body = ""] = match;
    const mapped = MAP_ATTRIBUTE.exec(body);
    out.push({ name, tableName: mapped?.[1] ?? name });
  }
  return out;
}

/** Every `@db.<native type>` used in the schema, deduplicated and sorted. */
export function parseNativeTypes(schemaText: string): string[] {
  const found = new Set<string>();
  for (const m of schemaText.matchAll(/@db\.(\w+)/g)) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found].sort();
}

/** Names of every `DateTime` field, so tests can demand timestamptz everywhere. */
export function parseDateTimeFields(schemaText: string): { model: string; field: string; native: string | null }[] {
  const out: { model: string; field: string; native: string | null }[] = [];
  for (const match of schemaText.matchAll(MODEL_BLOCK)) {
    const [, model = "", body = ""] = match;
    for (const line of stripComments(body).split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const parts = trimmed.split(/\s+/);
      const field = parts[0] ?? "";
      const type = parts[1] ?? "";
      if (type !== "DateTime" && type !== "DateTime?") continue;
      const native = /@db\.(\w+(?:\(\d+\))?)/.exec(trimmed);
      out.push({ model, field, native: native?.[1] ?? null });
    }
  }
  return out;
}
