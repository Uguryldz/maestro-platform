import { McpDefinitionError } from "./errors.js";
import type { ServerDefinition } from "./tool.js";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TOOLS THAT ARE ABSENT ON PURPOSE  (M32 SoD · M101)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  approve_gate · reject_gate · merge_pr
 *
 * These are not "unimplemented yet" and they are not gated behind an
 * admin scope. They do not exist, and this file exists to keep them from
 * coming into existence by accident.
 *
 * Why: M32 says the party that PRODUCES work may not be the party that
 * APPROVES it. Every gate in the flow (steps 4, 5, 9, 11, 12) is closed by a
 * signature that an auditor must be able to trace to a person, verified
 * against AD/Jira group membership. The AI produced the analysis, the diff and
 * the tests; if the same session could also call `approve_gate`, then "üreten ≠
 * onaylayan" is a sentence in a policy document and nothing more.
 *
 * What maestro-mcp may do instead: LIST pending gates, SUMMARISE why one is
 * stuck, and REMIND its owner. Deciding is a human channel — a Jira comment
 * (M46/M105) or Studio — and the decision carries `GateDecision.source`, which
 * only those two channels can set.
 *
 * The same logic removes `merge_pr`: the merge is the moment work becomes
 * production, ADO requires at least one human reviewer on the PR (M12), and a
 * tool that merges would let the producing identity close its own loop.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  WHAT THIS FILE IS, AND WHAT IT IS NOT
 * ───────────────────────────────────────────────────────────────────────────
 * This is a NAME safety net. It is not the guarantee, and RAPOR.md used to say
 * it was — that these tools "cannot be written". They can: a determined
 * maintainer picks a name this file does not recognise (the verifier walked 47
 * of 48 equivalents past the old patterns) and `defineTool` accepts it.
 *
 * The real guarantee is structural and lives in two places:
 *  · `MaestroPlatform` — the injected interface has no method that decides a
 *    gate. A tool cannot call what does not exist, whatever it is named.
 *  · the BFF — a gate verdict is accepted only from a human channel, and
 *    `GateDecision.source` has exactly two values (`jira`, `studio`), neither
 *    of which an MCP session can set.
 *
 * What this file buys is that a maintainer REACHING for one of these names
 * hits a boot failure and a paragraph of reasoning, rather than a code review
 * where somebody has to remember M32. `assertNoGateDecisionTools` runs for
 * EVERY server this package builds.
 */
export const FORBIDDEN_TOOL_NAMES: readonly string[] = ["approve_gate", "reject_gate", "merge_pr"];

/**
 * Also refused: any spelling that would obviously be the same power under
 * another name. Matching is on the normalised tool name, so `approveGate`,
 * `gate-approve` and `pr_merge` are caught too. Over-matching here costs a
 * rename; under-matching costs the separation of duties.
 *
 * The verb list grew after the verifier walked 47 of 48 equivalents straight
 * past it (B7): `close_gate`, `sign_off`, `set_run_status` and `signal_workflow`
 * are all the same power, and only the first one was spelled the way the
 * patterns expected. The plural and the double-separator variants are here for
 * the same reason — a net with a hole in it reads as a net.
 */
const GATE_VERB =
  "approve|reject|decide|sign|signoff|close|open|resolve|resume|complete|deny|veto|dismiss|pass|fail|skip";
const PR_VERB = "merge|complete|close|approve|abandon|finish|squash";
const PR_NOUN = "pr|prs|pullrequest|pullrequests";

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  new RegExp(`^(?:${GATE_VERB})_?gates?$`),
  new RegExp(`^gates?_?(?:${GATE_VERB})$`),
  new RegExp(`^(?:${PR_VERB})_?(?:${PR_NOUN})$`),
  new RegExp(`^(?:${PR_NOUN})_?(?:${PR_VERB})$`),
  // Setting the outcome IS the decision, whatever the verb in front of it.
  /^set_?(?:gate|run|workflow|step|pr)_?(?:status|state|verdict|decision|outcome|result)$/,
  /^(?:gate|run|workflow|step|pr)_?(?:status|state|verdict|decision|outcome|result)_?set$/,
  // A signature is a human's mark; a signal into a running workflow is how a
  // gate gets closed without going near the word "gate".
  //
  // `resume` is deliberately NOT in this list. Resuming a run is real operate
  // work (M101) and `resume_run` is a tool this server ships; a net that
  // refuses it is a net that has to be worked around, and a net that gets
  // worked around stops being consulted. Only `resume_gate` is refused, and it
  // is refused by the gate-verb pattern above.
  /^sign_?off(?:_.*)?$/,
  /^(?:signal|advance|force|override|skip)_?(?:workflow|run|gate|step)$/,
  /^(?:workflow|run|gate|step)_?(?:signal|override|force|skip)$/,
];

/**
 * Lower-cased, width-folded, separators dropped to a single `_`.
 *
 * `NFKC` first, so a full-width `ａpprove_gate` folds onto the ASCII form
 * before anything else looks at it. Then a hard ASCII-only rule: a Cyrillic
 * `а` is indistinguishable from a Latin `a` in every review tool a human uses,
 * so a name carrying one is refused rather than compared — `defineTool` already
 * requires `[a-z0-9_]`, and this makes the safety net agree with it instead of
 * being quietly bypassed by a paste from a design document.
 */
export function normaliseToolName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s‐-―_-]+/g, "_");
}

/**
 * Homoglyph guard. After NFKC there should be nothing left outside ASCII; if
 * there is, the name contains a character that renders as a Latin letter in
 * every review tool a human uses — a Cyrillic `а` in `аpprove_gate` being the
 * canonical case. We cannot read such a name, so we cannot certify it, and the
 * ASCII-folded form is compared instead: a look-alike of a forbidden name is
 * refused as that forbidden name.
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  ѕ: "s",
  і: "i",
  ј: "j",
  ԁ: "d",
  ɡ: "g",
  τ: "t",
  ν: "v",
};

function foldHomoglyphs(name: string): string {
  return [...name].map((char) => HOMOGLYPHS[char] ?? char).join("");
}

export function isGateDecisionToolName(name: string): boolean {
  for (const candidate of [name, foldHomoglyphs(name.normalize("NFKC").toLowerCase())]) {
    const normalised = normaliseToolName(candidate);
    if (FORBIDDEN_TOOL_NAMES.includes(normalised)) return true;
    if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(normalised))) return true;
  }
  return false;
}

/**
 * Fail-closed guard, called from the server runtime for every server. Throws
 * `McpDefinitionError` — a definition problem, discovered at boot, never at
 * the moment somebody's approval is forged.
 */
export function assertNoGateDecisionTools(definition: ServerDefinition): void {
  const offenders = definition.tools.filter((tool) => isGateDecisionToolName(tool.name));
  if (offenders.length > 0) {
    throw new McpDefinitionError(
      `${definition.name}: gate decisions are a human channel (M32/M101); refusing tools: ` +
        offenders.map((tool) => tool.name).join(", "),
    );
  }
}
