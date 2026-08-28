import type { Notification, NotifyChannel } from "@maestro/contracts";
import type { NotifyPort, SecretPort } from "@maestro/ports";
import type { WebhookDriverConfig } from "./config.js";
import type { FetchLike, Sleep } from "./deps.js";
import { systemSleep } from "./deps.js";
import {
  NotifyPermanentError,
  NotifyRecipientError,
  NotifyTransientError,
  redact,
  safeMessage,
} from "./errors.js";
import { renderMessage, requireNotification } from "./message.js";
import { sendToEachTarget } from "./retry.js";

/**
 * Shared machinery of the two Incoming-Webhook channels (Teams, Slack). They
 * differ only in the JSON they POST and in how a "200 but actually failed"
 * body reads, so both are passed in as functions.
 */
export interface WebhookDriverSpec {
  channel: NotifyChannel;
  buildPayload: (notification: Notification, subject: string, body: string) => unknown;
  /** Returns a reason when a 2xx body still means failure, else null. */
  checkBody: (text: string) => string | null;
}

export interface WebhookDeps {
  fetchImpl: FetchLike;
  secrets: SecretPort;
  sleep?: Sleep;
}

const BODY_SNIPPET_LIMIT = 200;

export class WebhookNotifier implements NotifyPort {
  private readonly sleep: Sleep;

  constructor(
    private readonly spec: WebhookDriverSpec,
    private readonly config: WebhookDriverConfig,
    private readonly deps: WebhookDeps,
  ) {
    this.sleep = deps.sleep ?? systemSleep;
  }

  async send(input: Notification): Promise<void> {
    const notification = requireNotification(this.spec.channel, input);
    if (notification.channel !== this.spec.channel) {
      throw new NotifyPermanentError(
        this.spec.channel,
        `notification is addressed to channel "${notification.channel}"`,
      );
    }
    // Checked before the fan-out, and without echoing the value: a caller that
    // put a webhook URL in `to` handed us a bearer credential, and the fan-out
    // report names every target it tried.
    if (notification.to.some((target) => target.includes("://"))) {
      throw new NotifyPermanentError(
        this.spec.channel,
        "`to` must carry configured target names, never a webhook URL",
      );
    }
    const { subject, body } = renderMessage(notification);
    const payload = JSON.stringify(this.spec.buildPayload(notification, subject, body));

    await sendToEachTarget(
      {
        driver: this.spec.channel,
        event: notification.event,
        policy: this.config.retry,
        sleep: this.sleep,
      },
      notification.to,
      (target) => this.post(target, payload),
    );
  }

  /** One POST to one target. Throws transient/permanent; never returns false. */
  private async post(target: string, payload: string): Promise<void> {
    const url = await this.resolveUrl(target);
    let response: Response;
    try {
      response = await this.deps.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      // A transport error message routinely embeds the full URL (undici does).
      throw new NotifyTransientError(this.spec.channel, safeMessage(error, [url]));
    }

    const text = redactedBody(await readBody(response), url);
    if (response.ok) {
      const reason = this.spec.checkBody(text);
      if (reason === null) return;
      throw new NotifyPermanentError(
        this.spec.channel,
        `target "${target}" answered HTTP ${response.status} but rejected the message: ${reason}`,
      );
    }

    const where = `target "${target}" answered HTTP ${response.status}: ${text}`;
    if (response.status === 429) {
      throw new NotifyTransientError(this.spec.channel, where, retryAfterMs(response.headers.get("retry-after")));
    }
    if (response.status === 408 || response.status >= 500) {
      throw new NotifyTransientError(this.spec.channel, where);
    }
    throw new NotifyPermanentError(this.spec.channel, where);
  }

  /**
   * `to` carries channel NAMES, never URLs: the URL is a bearer credential and
   * lives only in the secret store (M80). An unknown name is a permanent error
   * — silently dropping it is how a gate notification vanishes.
   */
  private async resolveUrl(target: string): Promise<string> {
    // `Object.hasOwn`, not `targets[target]`: "__proto__", "constructor" and
    // "toString" resolve on Object.prototype, which turned an unknown target
    // into a bogus secret ref, a transient error and a pointless retry loop.
    if (!Object.hasOwn(this.config.targets, target)) {
      const known = Object.keys(this.config.targets).sort().join(", ") || "(none configured)";
      throw new NotifyRecipientError(this.spec.channel, target, `not a configured target — known: ${known}`);
    }
    const ref = this.config.targets[target];
    if (ref === undefined) {
      throw new NotifyRecipientError(this.spec.channel, target, "configured target has no secret reference");
    }
    let url: string;
    try {
      url = await this.deps.secrets.get(ref);
    } catch (error) {
      throw new NotifyTransientError(this.spec.channel, `secret "${ref}" unavailable: ${safeMessage(error, [])}`);
    }
    if (!/^https:\/\/\S+$/.test(url.trim())) {
      // No http:// — the credential sits in the URL path, so cleartext would
      // leak it to every hop. The value itself is never named in the error.
      throw new NotifyPermanentError(
        this.spec.channel,
        `webhook URL for target "${target}" (secret "${ref}") is not an https:// URL`,
      );
    }
    return url.trim();
  }
}

async function readBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, BODY_SNIPPET_LIMIT);
  } catch {
    return "";
  }
}

function redactedBody(text: string, url: string): string {
  return redact(text.replace(/\s+/g, " ").trim(), [url]);
}

/** Retry-After in seconds; an HTTP-date is ignored on purpose. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, 300_000);
}
