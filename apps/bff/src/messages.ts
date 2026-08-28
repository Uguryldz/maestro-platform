import { t } from "@maestro/config";
import { STEP_META, type StepId } from "@maestro/contracts";
import type { MessageCatalog } from "./deps.js";

/**
 * Every sentence this service writes into Jira comes from the catalog (M104).
 * Nothing here is a literal, which is also why adding Turkish-plus-English is
 * an orchestrator edit to `packages/config/locales`, not a change to this file.
 */
export const BFF_MESSAGE_KEYS = {
  gateApproved: "gate.approved",
  gateRejected: "gate.rejected",
  gateMembershipFailed: "gate.membership_failed",
  gateSodFailed: "gate.sod_failed",
  killSwitch: "notify.kill_switch",
  /** The nudge `notify_gate_owner` posts when a gate has been waiting (M45/M101). */
  gateReminder: "notify.gate_reminder",
  commandAccepted: "command.accepted",
  commandNoRun: "command.no_run",
  commandNoOpenGate: "command.no_open_gate",
  commandRunStatus: "command.run_status",
  commandUnsupported: "command.unsupported",
  /** The comment's author is not an account the audit trail can attribute (M33). */
  commandUnknownActor: "command.unknown_actor",
  pendingAssignment: "match.pending_assignment",
  /**
   * Intake refused the ticket, and the person who typed `/ai-start` is told
   * why ON THE TICKET.
   *
   * This used to return silently: the command was refused, no comment was
   * posted, no run appeared in Studio, and the only trace was a `warn` line in
   * a container log. An operator's first attempt on a fresh install produced
   * nothing at all, anywhere — which is exactly how "I could not even get an
   * analysis" happens.
   *
   * `unbound` stays silent on purpose (M102, see `jira-commands.ts`): the
   * project is not ours to answer for. This one is, and the fix is a label the
   * author can add themselves.
   */
  intakeNotOptedIn: "intake.not_opted_in",
  /**
   * The ticket was taken and a run started — said on the ticket, because that
   * is where the person who assigned it is looking.
   */
  intakeAccepted: "intake.accepted",
} as const;

export type BffMessageKey = (typeof BFF_MESSAGE_KEYS)[keyof typeof BFF_MESSAGE_KEYS];

/** Step titles are quoted back to the user in every gate reply (M104). */
export function stepTitleKey(step: StepId): string {
  return STEP_META[step].titleKey;
}

const STEP_TITLE_KEYS: readonly string[] = Object.values(STEP_META).map((meta) => meta.titleKey);

/**
 * Keys the work driver hands back when a comment looks like a command but is
 * not one it can honour (M105). The BFF renders them, so it is the BFF that
 * must be able to — checking them at boot pins the driver↔catalog contract.
 */
export const COMMAND_DIAGNOSIS_KEYS: readonly string[] = [
  "command.unknown",
  "command.reject_needs_reason",
  "command.takes_no_argument",
  "command.invalid_app_id",
  "command.invalid_mode",
];

/** Everything this service must be able to render before it accepts traffic. */
export const REQUIRED_MESSAGE_KEYS: readonly string[] = [
  ...Object.values(BFF_MESSAGE_KEYS),
  ...STEP_TITLE_KEYS,
  ...COMMAND_DIAGNOSIS_KEYS,
];

/**
 * Keys this package needs that the shipped catalog does not carry yet. This is
 * the seam that lets a packet request wording without weakening
 * `assertCatalog`, which stays fail-closed about every other key. The tr+en
 * text is in RAPOR.md for the orchestrator to add to
 * `packages/config/locales`; once it lands, this list empties again.
 */
export const REQUESTED_MESSAGE_KEYS: readonly string[] = [];

/** The catalog shipped with `@maestro/config`. */
export const defaultCatalog: MessageCatalog = {
  t: (locale, key, params) => t(locale, key, params ?? {}),
};

export class MissingCatalogKeysError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(
      `message catalog is missing ${keys.length} key(s) this service writes to users: ${keys.join(", ")} — see apps/bff/RAPOR.md for the tr+en wording`,
    );
    this.name = "MissingCatalogKeysError";
  }
}

/** Keys the catalog cannot resolve, in declaration order. */
export function missingKeys(
  catalog: MessageCatalog,
  locale: Parameters<MessageCatalog["t"]>[0],
  keys: readonly string[] = REQUIRED_MESSAGE_KEYS,
): string[] {
  return keys.filter((key) => {
    try {
      catalog.t(locale, key, {});
      return false;
    } catch {
      return true;
    }
  });
}

/**
 * Boot-time gate (M6 fail-closed): a server that cannot render the sentence it
 * owes a user must not accept traffic. Silently posting a raw key into a Jira
 * ticket would be worse than refusing to start, because nobody would notice.
 *
 * `REQUESTED_MESSAGE_KEYS` are exempt, and only those: contracts and config are
 * read-only to this packet, so a key whose wording is still awaiting an
 * orchestrator edit cannot be added here. The exemption is narrow and listed by
 * name — every other key keeps the service from starting. The renderer falls
 * back to the key's own text, so the worst case is an untranslated sentence in
 * a Jira comment rather than a BFF that will not boot.
 */
export function assertCatalog(
  catalog: MessageCatalog,
  locale: Parameters<MessageCatalog["t"]>[0],
): void {
  const enforced = REQUIRED_MESSAGE_KEYS.filter((key) => !REQUESTED_MESSAGE_KEYS.includes(key));
  const missing = missingKeys(catalog, locale, enforced);
  if (missing.length > 0) throw new MissingCatalogKeysError(missing);
}
