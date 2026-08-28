import { LdapConfigError } from "./errors.js";

/**
 * LDAP filter and DN escaping (RFC 4515 §3, RFC 4514 §2.4).
 *
 * This is the file that decides whether a username is DATA or CODE. The search
 * filter is a little language, and `uid=<username>` splices caller input into
 * it: a login of `*)(uid=*` turns the intended
 *
 *     (&(objectClass=user)(uid=*)(uid=*))
 *
 * into a filter that matches EVERY account, and the driver then binds as
 * whichever one the directory returned first. That is not a leak, it is an
 * authentication bypass — the classic LDAP injection, and the reason this
 * module exists separately from the client that uses it.
 *
 * Escaping is done on the way IN (before the filter string is built), never by
 * sanitising a built filter afterwards: a filter that is already wrong cannot
 * be repaired by inspection.
 */

/**
 * RFC 4515 §3: the four characters that are structural in a filter, plus NUL.
 * Each becomes a `\`-prefixed two-digit hex escape of its byte value.
 *
 * A directory reads `\2a` as a LITERAL asterisk, so a user genuinely called
 * `a*b` still authenticates — escaping preserves meaning, it does not reject.
 */
const FILTER_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["\\", "\\5c"], // MUST be first conceptually: it introduces every other escape
  ["*", "\\2a"],
  ["(", "\\28"],
  [")", "\\29"],
  ["\0", "\\00"],
]);

/**
 * Escape one assertion VALUE for use inside a search filter.
 *
 * Non-ASCII is left alone deliberately: RFC 4515 allows UTF-8 in an assertion
 * value, and the bank's directory holds Turkish names (`Uğur`, `Şeyma`). What
 * is escaped is the filter grammar, not the alphabet — mangling `ğ` would lock
 * people out of their own accounts while closing no hole.
 *
 * Every byte outside printable ASCII that is a CONTROL character is escaped
 * too: a newline in an assertion value is how a crafted username reaches a log
 * parser or an upstream proxy on its own line.
 */
export function escapeFilterValue(value: string): string {
  let out = "";
  for (const char of value) {
    const escape = FILTER_ESCAPES.get(char);
    if (escape !== undefined) {
      out += escape;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    // C0 controls and DEL — never meaningful in a name, always meaningful to a log.
    if (code < 0x20 || code === 0x7f) {
      out += `\\${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * RFC 4514 §2.4 escaping for a value spliced into a DN (e.g. a group DN built
 * from configuration). Different rule set from a filter: the structural
 * characters of a DN are the comma, plus, quote, angle brackets and semicolon,
 * and leading/trailing space plus a leading `#` are positionally special.
 */
export function escapeDnValue(value: string): string {
  const special = new Set(["\\", ",", "+", '"', "<", ">", ";", "="]);
  let out = "";
  for (const [index, char] of [...value].entries()) {
    const code = char.codePointAt(0) ?? 0;
    if (special.has(char)) {
      out += `\\${char}`;
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\${code.toString(16).padStart(2, "0")}`;
    } else if (char === " " && (index === 0 || index === [...value].length - 1)) {
      out += "\\ ";
    } else if (char === "#" && index === 0) {
      out += "\\#";
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * The `{{username}}` placeholder a configured filter template carries.
 *
 * A template rather than a hardcoded `(uid=%s)` because the attribute holding
 * the login name is a per-directory fact: Active Directory uses
 * `sAMAccountName`, OpenLDAP conventionally `uid`, and some banks key on
 * `userPrincipalName`. Guessing wrong is not a subtle failure — nobody logs in.
 */
export const USERNAME_PLACEHOLDER = "{{username}}";

/**
 * Render a configured filter template with the caller's username.
 *
 * The username is escaped BEFORE substitution, so a template author cannot
 * accidentally opt out of escaping and a caller cannot inject through it. This
 * is the only supported way to build a user-search filter in this package —
 * there is deliberately no "raw filter" entry point, because an escape hatch
 * here is an escape hatch around the whole defence.
 */
export function renderUserFilter(template: string, username: string): string {
  if (!template.includes(USERNAME_PLACEHOLDER)) {
    throw new LdapConfigError(
      `user search filter must contain ${USERNAME_PLACEHOLDER} — a filter without it ignores the ` +
        `login name and matches an unrelated account`,
    );
  }
  return template.split(USERNAME_PLACEHOLDER).join(escapeFilterValue(username));
}
