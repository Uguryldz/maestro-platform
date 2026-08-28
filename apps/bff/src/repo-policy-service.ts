import { compileProtectedPath, DEFAULT_PROTECTED_PATHS } from "@maestro/execution";
import { badRequest, conflict } from "./errors.js";
import type { RepoPolicyRecord } from "./onboarding-models.js";

/**
 * The protected-path rules (M52), as decisions rather than as HTTP handling.
 *
 * The platform floor comes from `@maestro/execution` — the SAME list the runner
 * enforces against a diff. Re-typing it here would create a second list that
 * agrees with the first until somebody adds a pattern to one of them, and the
 * copy Studio shows is the copy an operator trusts when deciding whether a repo
 * needs an addition.
 */

/**
 * The floor a repo may add to and may never shrink.
 *
 * Sorted for the screen's benefit; `DEFAULT_PROTECTED_PATHS` is grouped by
 * intent (secrets first, then the execution surface), which reads well in
 * source and badly in a UI list an operator is scanning for one entry.
 */
export const PLATFORM_DEFAULT_PATHS: readonly string[] = [...DEFAULT_PROTECTED_PATHS].sort();

/** Normalise a pattern the way the matcher will, so comparisons see one spelling. */
function canonicalPath(path: string): string {
  return path.trim().normalize("NFC");
}

/**
 * True when this pattern is part of the platform floor.
 *
 * Compared on the canonical spelling rather than raw equality: a pattern with a
 * stray trailing space is the same rule, and letting whitespace decide would
 * make the floor removable by anybody who could type a space.
 */
export function isPlatformDefault(path: string): boolean {
  const candidate = canonicalPath(path);
  return PLATFORM_DEFAULT_PATHS.some((entry) => canonicalPath(entry) === candidate);
}

/**
 * Add a path to a repo's additions.
 *
 * Three refusals, each of them a way the list could end up meaning less than it
 * says:
 *
 *  · an uncompilable pattern — `compileProtectedPath` is fail-closed by design,
 *    and a pattern it cannot parse would sit in the list matching NOTHING while
 *    reading as protection in review. That is the single most dangerous entry
 *    this list can hold, so it never gets in.
 *  · a duplicate — harmless to the matcher, confusing in a UI that offers a
 *    delete button per row.
 *  · a platform default — already enforced, and accepting it would create a
 *    repo-owned COPY of a floor entry that the delete path would then happily
 *    remove, leaving the operator believing they had removed the default.
 */
export function addRepoAddition(
  current: readonly string[],
  path: string,
): readonly string[] {
  const candidate = canonicalPath(path);
  if (candidate === "") throw badRequest("invalid_path");

  try {
    compileProtectedPath(candidate);
  } catch (error) {
    throw badRequest("invalid_path_pattern", {
      path: candidate,
      reason: error instanceof Error ? error.message : "unsupported pattern",
    });
  }

  if (isPlatformDefault(candidate)) {
    throw conflict("protected_path_is_default", { path: candidate });
  }
  if (current.some((entry) => canonicalPath(entry) === candidate)) {
    throw conflict("protected_path_exists", { path: candidate });
  }

  return [...current, candidate];
}

/**
 * Remove a path from a repo's additions — and refuse to remove a default.
 *
 * This is the rule the whole screen is arranged around. `DEFAULT_PROTECTED_PATHS`
 * covers migrations, CI definitions, git hooks and secret material; a repo that
 * could delete one could give an agent write access to the build machine before
 * any human gate. The refusal is a 409 naming the path, not a silent no-op:
 * a caller that thinks it removed a guard and did not is worse off than one
 * that was told no.
 */
export function removeRepoAddition(
  current: readonly string[],
  path: string,
): readonly string[] {
  const candidate = canonicalPath(path);

  if (isPlatformDefault(candidate)) {
    throw conflict("protected_path_is_default", { path: candidate });
  }

  const remaining = current.filter((entry) => canonicalPath(entry) !== candidate);
  // Removing something that is not there is a mistake worth reporting: the
  // caller is working from a stale list, and answering 200 would confirm a
  // deletion that never happened.
  if (remaining.length === current.length) {
    throw conflict("protected_path_unknown", { path: candidate });
  }
  return remaining;
}

/**
 * Render the policy as the `.maestro.yaml` the screen displays.
 *
 * Built from what was OBSERVED in the repo, never from a template: the screen
 * says "this is what is checked in", and a rendering that filled in plausible
 * build commands would be the platform inventing a repo's configuration and
 * showing it back as fact.
 *
 * When no run has ever read the file this returns "" and the WIRE says so
 * separately (`yamlPresent`). It used to return a six-line English comment
 * block explaining the absence, which put untranslated prose on a Turkish
 * screen — the BFF does not send sentences (M104). The explanation is the
 * screen's to render, from its own catalog, in the operator's language. M52
 * still stops the flow when the file is missing; the screen still shows it.
 */
export function renderPolicyYaml(record: RepoPolicyRecord): string {
  if (!record.yamlPresent) return "";

  const lines: string[] = [`platform: ${record.platform}`, ""];

  // The KEYS below are the repository's own YAML vocabulary and stay verbatim
  // — `verification:` is what the file says, not a label this platform chose,
  // and translating it would show an operator a document that does not match
  // what is checked in. The explanatory COMMENTS that used to trail each empty
  // list were this platform's prose, not the repo's, so they moved to the
  // screen's catalog (`yaml.empty_*`, `yaml.note.defaults`) where they can be
  // read in Turkish. An empty `[]` still renders, because "the file declares
  // none" is a fact about the file.
  lines.push("verification:");
  if (record.verification.length === 0) {
    lines.push("  []");
  } else {
    for (const spec of record.verification) {
      lines.push(`  - name: ${spec.name}`);
      lines.push(`    command: [${spec.command.map((part) => JSON.stringify(part)).join(", ")}]`);
    }
  }

  lines.push("", "protected_paths:");
  if (record.repoAdditions.length === 0) {
    lines.push("  []");
  } else {
    for (const path of record.repoAdditions) lines.push(`  - ${JSON.stringify(path)}`);
  }

  return lines.join("\n");
}
