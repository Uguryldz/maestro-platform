import type { CommandEnvelope, TicketKey, TicketSnapshot } from "@maestro/contracts";
import type { WorkEvent, WorkEventReader } from "@maestro/bff";
import {
  CapabilityNotSupportedError,
  type CiPort,
  type CiWebhookRequest,
  type WorkPort,
} from "@maestro/ports";

/**
 * Jira, in memory.
 *
 * The only method the demo exercises for real is `verifyMembership`, and it is
 * the one that matters: it is the entire authority behind a gate decision
 * (M32/M35). It answers from a seeded directory, so a user who is not in the
 * gate's owning group is genuinely refused — the demo does not hand out
 * approvals to anyone with a login.
 *
 * Everything else THROWS rather than returning a plausible value. There is no
 * Jira here: a `getTicket` that returned an invented snapshot, or an
 * `addComment` that silently swallowed a comment and reported success, would let
 * a screen render a Jira interaction that never happened. `CapabilityNotSupportedError`
 * is the same refusal the real DC driver uses for `transition`, so the shape is
 * one the platform already understands.
 */
export class DemoWorkPort implements WorkPort {
  private readonly groups = new Map<string, Set<string>>();

  constructor(memberships: Readonly<Record<string, readonly string[]>> = {}) {
    for (const [group, members] of Object.entries(memberships)) {
      this.groups.set(group, new Set(members.map((member) => member.trim().toLowerCase())));
    }
  }

  /**
   * Real membership, from the seeded directory. Fail-closed by construction: an
   * unknown group has no members, so it refuses rather than defaulting to true.
   */
  verifyMembership(userId: string, group: string): Promise<boolean> {
    return Promise.resolve(this.groups.get(group)?.has(userId.trim().toLowerCase()) ?? false);
  }

  /**
   * No webhook may be accepted. The demo has no Jira secret to verify against,
   * and a `verifyWebhook` that resolved would turn the intake endpoint into an
   * unauthenticated write path — the exact hole M7 exists to close.
   */
  verifyWebhook(_rawBody: string | Uint8Array, _headers: Record<string, string>): Promise<void> {
    return Promise.reject(
      new Error(
        "demo stack: no Jira webhook secret is configured — deliveries are refused rather than " +
          "trusted. Intake is not part of the demo; runs are seeded.",
      ),
    );
  }

  parseCommand(_rawBody: unknown): Promise<CommandEnvelope | null> {
    // Not "no command found": there is no verified delivery to parse in the
    // first place, and null would read as "that comment carried nothing".
    throw new CapabilityNotSupportedError("WorkPort", "parseCommand");
  }

  getTicket(_key: TicketKey): Promise<TicketSnapshot> {
    throw new CapabilityNotSupportedError("WorkPort", "getTicket");
  }
  addComment(_key: TicketKey, _body: unknown): Promise<{ commentId: string }> {
    throw new CapabilityNotSupportedError("WorkPort", "addComment");
  }
  updateComment(_key: TicketKey, _commentId: string, _body: unknown): Promise<void> {
    throw new CapabilityNotSupportedError("WorkPort", "updateComment");
  }
  setLabels(_key: TicketKey, _labels: string[]): Promise<void> {
    throw new CapabilityNotSupportedError("WorkPort", "setLabels");
  }
  assign(_key: TicketKey, _accountId: string | null): Promise<void> {
    throw new CapabilityNotSupportedError("WorkPort", "assign");
  }
  createLinkedIssue(): Promise<{ key: TicketKey }> {
    throw new CapabilityNotSupportedError("WorkPort", "createLinkedIssue");
  }
  transition(_key: TicketKey, _transitionId: string): Promise<void> {
    throw new CapabilityNotSupportedError("WorkPort", "transition");
  }
}

/** No verified delivery exists, so there is never an event to read out of one. */
export class DemoWorkEventReader implements WorkEventReader {
  read(_payload: unknown): WorkEvent {
    throw new CapabilityNotSupportedError("WorkEventReader", "read");
  }
}

/**
 * ADO, in memory. Authentication comes first and fails: the demo holds no
 * Service Hook credential, and "no header configured" must never mean "no
 * authentication required" (M12).
 */
export class DemoCiPort implements CiPort {
  parseBuildEvent(_request: CiWebhookRequest): Promise<null> {
    return Promise.reject(
      new Error(
        "demo stack: no ADO Service Hook credential is configured — build deliveries are " +
          "refused rather than accepted unauthenticated.",
      ),
    );
  }
}
