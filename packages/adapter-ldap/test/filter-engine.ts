import type { LdapEntry } from "../src/client.js";

/**
 * A real (small) RFC 4515 filter evaluator, for the fake directory.
 *
 * This exists so the injection tests are not vacuous. A fake that ignored the
 * filter and returned a canned entry would pass those tests whether or not the
 * escaping worked — the assertion would prove nothing. Because this parses and
 * evaluates for real, an unescaped payload genuinely changes which entries come
 * back, and removing the escaping makes the tests fail.
 *
 * Supports what the driver actually emits: `&`, `|`, `!`, equality, presence,
 * substring wildcards, and the two AD extensible-match rules (bit-AND and
 * in-chain).
 */

export type FilterNode =
  | { kind: "and"; children: FilterNode[] }
  | { kind: "or"; children: FilterNode[] }
  | { kind: "not"; child: FilterNode }
  | { kind: "present"; attribute: string }
  | { kind: "equal"; attribute: string; value: string; rule?: string }
  | { kind: "substring"; attribute: string; parts: string[] };

export interface ChainContext {
  readonly groups: readonly { dn: string; members: readonly string[] }[];
}

export function parseFilter(filter: string): FilterNode {
  const input = filter.trim();
  const [node, rest] = parseNode(input, 0);
  if (rest !== input.length) throw new Error(`trailing filter input in ${filter}`);
  return node;
}

function parseNode(input: string, at: number): [FilterNode, number] {
  if (input[at] !== "(") throw new Error(`expected ( at ${at} in ${input}`);
  let i = at + 1;
  const operator = input[i];

  if (operator === "&" || operator === "|") {
    const children: FilterNode[] = [];
    i += 1;
    while (input[i] === "(") {
      const [child, next] = parseNode(input, i);
      children.push(child);
      i = next;
    }
    if (input[i] !== ")") throw new Error(`unclosed group at ${i}`);
    return [{ kind: operator === "&" ? "and" : "or", children }, i + 1];
  }

  if (operator === "!") {
    const [child, next] = parseNode(input, i + 1);
    if (input[next] !== ")") throw new Error(`unclosed ! at ${next}`);
    return [{ kind: "not", child }, next + 1];
  }

  const close = findClose(input, i);
  return [parseItem(input.slice(i, close)), close + 1];
}

function findClose(input: string, from: number): number {
  for (let i = from; i < input.length; i += 1) {
    if (input[i] === "\\") {
      i += 2;
      continue;
    }
    if (input[i] === ")") return i;
    if (input[i] === "(") throw new Error(`nested ( inside assertion at ${i}`);
  }
  throw new Error("unterminated assertion");
}

function parseItem(body: string): FilterNode {
  const equals = body.indexOf("=");
  if (equals === -1) throw new Error(`assertion without = : ${body}`);
  let attribute = body.slice(0, equals);
  const rawValue = body.slice(equals + 1);

  // Extensible match, e.g. `userAccountControl:1.2.840.113556.1.4.803:=2`
  let rule: string | undefined;
  const colon = attribute.indexOf(":");
  if (colon !== -1) {
    rule = attribute.slice(colon + 1).replace(/:$/, "");
    attribute = attribute.slice(0, colon);
  }

  if (rawValue === "*") return { kind: "present", attribute: attribute.toLowerCase() };

  // A `*` that survived escaping is a WILDCARD; `\2a` is a literal asterisk.
  if (rawValue.includes("*")) {
    return {
      kind: "substring",
      attribute: attribute.toLowerCase(),
      parts: rawValue.split("*").map(unescapeFilterValue),
    };
  }

  return { kind: "equal", attribute: attribute.toLowerCase(), value: unescapeFilterValue(rawValue), rule };
}

/** `\2a` → `*`. The inverse of the driver's escaping, so literals compare as literals. */
export function unescapeFilterValue(value: string): string {
  return value.replace(/\\([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

export function matchesFilter(entry: LdapEntry, node: FilterNode, context: ChainContext): boolean {
  switch (node.kind) {
    case "and":
      return node.children.every((child) => matchesFilter(entry, child, context));
    case "or":
      return node.children.some((child) => matchesFilter(entry, child, context));
    case "not":
      return !matchesFilter(entry, node.child, context);
    case "present":
      return (entry.attributes[node.attribute]?.length ?? 0) > 0;
    case "equal":
      return matchesEqual(entry, node, context);
    case "substring": {
      const values = entry.attributes[node.attribute] ?? [];
      return values.some((value) => matchesSubstring(value.toLowerCase(), node.parts));
    }
  }
}

function matchesEqual(
  entry: LdapEntry,
  node: Extract<FilterNode, { kind: "equal" }>,
  context: ChainContext,
): boolean {
  const values = entry.attributes[node.attribute] ?? [];

  // LDAP_MATCHING_RULE_BIT_AND — how AD expresses "is this flag set".
  if (node.rule === "1.2.840.113556.1.4.803") {
    const mask = Number.parseInt(node.value, 10);
    return values.some((value) => (Number.parseInt(value, 10) & mask) !== 0);
  }

  // LDAP_MATCHING_RULE_IN_CHAIN — nested membership, resolved transitively.
  if (node.rule === "1.2.840.113556.1.4.1941") {
    return matchesInChain(entry, node.attribute, node.value, context);
  }

  return values.some((value) => eq(value, node.value));
}

/**
 * Transitive membership, in both directions the driver uses:
 * `member:…1941:=<userDn>` on a group, `memberOf:…1941:=<groupDn>` on a user.
 */
function matchesInChain(
  entry: LdapEntry,
  attribute: string,
  target: string,
  context: ChainContext,
): boolean {
  const { groups } = context;

  if (attribute === "member") {
    const seen = new Set<string>();
    const walk = (groupDn: string): boolean => {
      const key = groupDn.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      const group = groups.find((g) => eq(g.dn, groupDn));
      if (group === undefined) return false;
      if (group.members.some((m) => eq(m, target))) return true;
      return group.members.some((m) => walk(m));
    };
    return walk(entry.dn);
  }

  if (attribute === "memberof") {
    const seen = new Set<string>();
    const walk = (dn: string): boolean => {
      const key = dn.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      for (const group of groups) {
        if (!group.members.some((m) => eq(m, dn))) continue;
        if (eq(group.dn, target)) return true;
        if (walk(group.dn)) return true;
      }
      return false;
    };
    return walk(entry.dn);
  }

  return false;
}

function matchesSubstring(value: string, parts: string[]): boolean {
  let index = 0;
  for (const [position, rawPart] of parts.entries()) {
    const part = rawPart.toLowerCase();
    if (part === "") continue;
    if (position === 0) {
      if (!value.startsWith(part)) return false;
      index = part.length;
      continue;
    }
    if (position === parts.length - 1) return value.slice(index).endsWith(part);
    const found = value.indexOf(part, index);
    if (found === -1) return false;
    index = found + part.length;
  }
  return true;
}

export function eq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
