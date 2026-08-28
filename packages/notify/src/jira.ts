import { type Notification, TicketKey } from "@maestro/contracts";
import { CapabilityNotSupportedError, type NotifyPort, type WorkPort } from "@maestro/ports";
import { JIRA_DRIVER, type JiraDriverConfig } from "./config.js";
import { type Sleep, systemSleep } from "./deps.js";
import {
  NotifyPermanentError,
  NotifyRecipientError,
  NotifyTransientError,
  safeMessage,
} from "./errors.js";
import { renderMessage, requireNotification } from "./message.js";
import { sendToEachTarget } from "./retry.js";

/**
 * Jira comment channel (M45). Clean room (M44): this driver owns NO Jira
 * client, URL or PAT — it writes through the injected `WorkPort`, so
 * `@maestro/adapter-jira` stays swappable and this package never learns that
 * Jira has an HTTP API. `Notification.to` carries ticket keys.
 */
export interface JiraNotifyDeps {
  work: WorkPort;
  sleep?: Sleep;
}

export class JiraCommentNotifier implements NotifyPort {
  private readonly sleep: Sleep;

  constructor(
    private readonly config: JiraDriverConfig,
    private readonly deps: JiraNotifyDeps,
  ) {
    this.sleep = deps.sleep ?? systemSleep;
  }

  async send(input: Notification): Promise<void> {
    const notification = requireNotification(JIRA_DRIVER, input);
    if (notification.channel !== JIRA_DRIVER) {
      throw new NotifyPermanentError(
        JIRA_DRIVER,
        `notification is addressed to channel "${notification.channel}"`,
      );
    }
    const { body } = renderMessage(notification);
    // Plain text on purpose: turning it into ADF is the WorkPort driver's job
    // (its `addComment` accepts either), and duplicating that here would be a
    // second, silently diverging renderer.
    for (const recipient of notification.to) {
      if (!TicketKey.safeParse(recipient).success) {
        throw new NotifyRecipientError(JIRA_DRIVER, recipient, "not a Jira issue key (e.g. UGURPAY-123)");
      }
    }

    await sendToEachTarget(
      { driver: JIRA_DRIVER, event: notification.event, policy: this.config.retry, sleep: this.sleep },
      notification.to,
      (ticket) => this.comment(ticket, body),
    );
  }

  private async comment(ticket: string, body: string): Promise<void> {
    try {
      await this.deps.work.addComment(ticket, body);
    } catch (error) {
      throw classify(ticket, error);
    }
  }
}

/**
 * The WorkPort contract does not define an error taxonomy, and importing the
 * Jira driver's error classes would break the clean room. So classification is
 * structural: any error carrying a numeric `status` is treated as HTTP.
 * Unknown shapes are PERMANENT — retrying an error we do not understand just
 * multiplies comments on a bank's ticket.
 */
export function classify(ticket: string, error: unknown): Error {
  if (error instanceof CapabilityNotSupportedError) {
    return new NotifyPermanentError(JIRA_DRIVER, `${ticket}: ${error.message}`);
  }
  const status = httpStatusOf(error);
  const reason = `${ticket}: ${safeMessage(error, [])}`;
  if (status !== undefined && (status === 408 || status === 429 || status >= 500)) {
    return new NotifyTransientError(JIRA_DRIVER, reason);
  }
  if (status !== undefined) return new NotifyPermanentError(JIRA_DRIVER, reason);
  // No status at all: a socket/DNS failure looks like this too, and those are
  // worth one more try — but only when the port itself did not reject us.
  return isNetworkish(error)
    ? new NotifyTransientError(JIRA_DRIVER, reason)
    : new NotifyPermanentError(JIRA_DRIVER, reason);
}

function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

const NETWORKISH = /(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket|network|timeout|aborted)/i;

function isNetworkish(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && NETWORKISH.test(code)) return true;
  return error instanceof Error && NETWORKISH.test(`${error.name} ${error.message}`);
}

export function createJiraCommentNotifier(
  config: JiraDriverConfig,
  deps: JiraNotifyDeps,
): JiraCommentNotifier {
  return new JiraCommentNotifier(config, deps);
}
