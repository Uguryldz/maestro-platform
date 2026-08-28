/**
 * The ENGLISH name beside a Turkish Jira name — a label, never a value.
 *
 * The bank's Jira serves issue-type and status names in Turkish (`Görev`,
 * `Hata`, `İNCELEMEDE`), but a good part of the staff runs the Jira UI in
 * English and goes looking for `Task`, `Bug`, `In Review`. They cannot find
 * their own trigger in a rule that only ever says `Görev`.
 *
 * THE ONE RULE THIS MODULE EXISTS TO PROTECT: the value a rule STORES stays the
 * localised one. `flow-decision.ts` compares `rule.matchValue` to the ticket's
 * `fields.issuetype.name` verbatim, and OPS-66 really does carry `Görev` — a
 * rule holding `Task` matches nothing, silently, forever (the bug fixed in
 * e7ac247). So everything here is presentation: `englishAside("Görev")` answers
 * `"Task"`, and the caller renders `Görev (Task)` while sending `Görev`. No
 * function in this file may ever be used to build a payload.
 *
 * WHY A TABLE AND NOT A JIRA CALL. The obvious route is to ask Jira for the
 * untranslated name, and it was investigated first:
 *
 *  · `/rest/api/3/issuetype` and `/rest/api/3/issue/createmeta/{key}/issuetypes`
 *    both return `name` in the SITE's locale — the same Turkish the tickets
 *    carry. There is no `untranslatedName` on an issue type (Jira has that
 *    field for custom FIELDS, not for types or statuses), so neither endpoint
 *    can be asked for the English one.
 *  · `Accept-Language` is not documented as affecting these names, and Jira
 *    Cloud resolves the translation from the site/user language rather than the
 *    request header. Sending it and trusting the answer would be a guess about
 *    another company's deployment.
 *  · `/rest/api/3/project/{key}/statuses` DOES return the default-locale names
 *    (measured live on OPS: `Task/Story/Bug/Epic` where createmeta says
 *    `Görev/Hikaye/Hata/Epik` — see `jira-match-values-service.ts`). Pairing the
 *    two by issue-type id would be an honest English source, but it costs a
 *    second live call on every dropdown render, it exists only for Jira Cloud
 *    (the DC flavour deliberately has no createmeta path), and its failure mode
 *    is a MISPAIRED name — `Görev (Bug)` — which is worse than no aside at all
 *    on the exact screen we are here to make trustworthy.
 *
 * So: a closed table of the standard set Jira ships with every project, in the
 * two localisations we have actually measured. A name outside it gets NO aside —
 * a custom type called `Talep` is shown as `Talep` and nothing more, because
 * inventing "Request" for it would be exactly the kind of confident wrong answer
 * this screen must not produce.
 */

/**
 * The standard set, Turkish → English. Only names Jira itself ships: the five
 * default issue types and the four default statuses. Keys are the TURKISH names
 * as Jira writes them (`İNCELEMEDE` is genuinely upper-case on this site).
 *
 * `Subtask` and `Feature` are absent on purpose: Jira serves those two
 * untranslated in this deployment, so they are already the English name and an
 * aside would read `Subtask (Subtask)`.
 */
const ENGLISH_BY_TURKISH: Readonly<Record<string, string>> = {
  // ── issue types ──
  görev: "Task",
  hikaye: "Story",
  hata: "Bug",
  epik: "Epic",
  "alt görev": "Subtask",
  "alt-görev": "Subtask",
  // ── statuses ──
  yapılacaklar: "To Do",
  yapılacak: "To Do",
  "devam ediyor": "In Progress",
  incelemede: "In Review",
  tamam: "Done",
  bitti: "Done",
};

/**
 * Fold a Jira name to a lookup key.
 *
 * Turkish case folding is the reason this is not a bare `toLowerCase()`.
 * `"İNCELEMEDE".toLowerCase()` yields `i̇ncelemede` — an `i` followed by a
 * COMBINING DOT ABOVE (U+0307) — which no hand-written key can match, and the
 * dotted capital İ is exactly the character this site's most common status
 * uses. The `tr` locale folds it to a plain `i`; the combining-mark strip after
 * it is the belt for the browser that does not implement the locale and falls
 * back to the invariant rule.
 */
function fold(name: string): string {
  return name.trim().toLocaleLowerCase("tr").replace(/̇/g, "");
}

/**
 * The English name for a Turkish Jira name, or `null` when we do not know one.
 *
 * `null` is a real answer and the caller must render it as "nothing extra",
 * never as an empty parenthesis. A name that is ALREADY English (`Bug` typed on
 * an English site) also answers `null` — repeating it would be noise.
 */
export function englishAside(name: string): string | null {
  const english = ENGLISH_BY_TURKISH[fold(name)];
  if (english === undefined) return null;
  // The site may already serve the English name (an English-locale Jira, or a
  // type Jira never translated). `Task (Task)` helps nobody.
  return fold(english) === fold(name) ? null : english;
}

/**
 * The label for a match value: `Görev (Task)`, or just `Görev` when there is no
 * known English name.
 *
 * A LABEL. The value that goes on the wire is the argument, untouched — every
 * caller of this function passes the same string to its `value` prop and this
 * one only to what a human reads.
 */
export function matchValueLabel(name: string): string {
  const english = englishAside(name);
  return english === null ? name : `${name} (${english})`;
}
