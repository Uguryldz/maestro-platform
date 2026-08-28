import { MissingMessageError, t } from "@maestro/config";
import { Notification, type NotifyChannel } from "@maestro/contracts";
import type { NotifyRouting } from "./config.js";
import { NotifyMessageError, NotifyPermanentError } from "./errors.js";

/**
 * M104 — message bodies are NEVER hardcoded in a driver. A notification
 * carries `messageKey` + `params`; the text is resolved from the central
 * catalog for the notification's locale. Adding a language = adding a catalog
 * file; no driver changes.
 */
export interface RenderedMessage {
  /** One-line summary: e-mail Subject, Adaptive Card title, Slack fallback. */
  subject: string;
  /** Full body text as the catalog renders it. */
  body: string;
}

const SUBJECT_LIMIT = 120;
/** Exactly the placeholder syntax `@maestro/config`'s `t()` interpolates. */
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Fail-closed parse of untrusted input against the frozen contract. A
 * malformed notification is a permanent failure: retrying it changes nothing.
 */
export function requireNotification(driver: string, input: unknown): Notification {
  const result = Notification.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new NotifyPermanentError(driver, `invalid notification: ${issues}`);
}

/**
 * Resolve the catalog text. Two fail-closed rules:
 *  1. an unknown key throws (it is never "silently skipped" — M104), and
 *  2. a template whose `{param}` was not supplied throws, because shipping
 *     "{ticket} is waiting for {gate}" to a bank's approvers is worse than a
 *     loud error the workflow can retry with correct params.
 *
 * The completeness check reads the TEMPLATE, never the rendered body: a ticket
 * summary or a log line routinely contains braces, and checking the output
 * turned `{ops_takimi}` inside a parameter VALUE into a permanent failure —
 * i.e. the gate notification never went out at all.
 */
export function renderMessage(notification: Notification): RenderedMessage {
  // `t()` with no params returns the template verbatim: every `{name}` falls
  // back to itself. That is how the template is obtained without a second API.
  let template: string;
  try {
    template = t(notification.locale, notification.messageKey);
  } catch (error) {
    if (error instanceof MissingMessageError) {
      throw new NotifyMessageError(notification.messageKey, `not in the "${notification.locale}" catalog`);
    }
    throw error;
  }

  const missing = [...template.matchAll(PLACEHOLDER)]
    .map((match) => match[1] as string)
    .filter((name) => notification.params[name] === undefined);
  if (missing.length > 0) {
    const named = [...new Set(missing)].map((name) => `{${name}}`).join(", ");
    throw new NotifyMessageError(
      notification.messageKey,
      `missing parameter ${named} for locale "${notification.locale}"`,
    );
  }

  const body = t(notification.locale, notification.messageKey, notification.params);
  return { subject: toSubject(body), body };
}

/** First line, whitespace collapsed, bounded — headers must stay one line. */
function toSubject(body: string): string {
  const firstLine = body.split(/\r?\n/, 1)[0] ?? body;
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SUBJECT_LIMIT) return collapsed;
  return `${collapsed.slice(0, SUBJECT_LIMIT - 1).trimEnd()}…`;
}

/** Everything a notification needs except the channel (routing decides that). */
export type NotificationDraft = Omit<Notification, "channel">;

export interface RoutedNotifications {
  notifications: Notification[];
  /** true when routing maps this event to zero channels (deliberate mute). */
  muted: boolean;
}

/**
 * M45/M71/M87 — channel selection is a parameter, not code. One draft fans out
 * to one notification per configured channel. A muted event is reported, not
 * hidden, so the caller can log "muted by parameter" instead of losing it.
 */
export function routeNotification(routing: NotifyRouting, draft: NotificationDraft): RoutedNotifications {
  const configured = Object.hasOwn(routing.byEvent, draft.event)
    ? (routing.byEvent[draft.event] ?? routing.default)
    : routing.default;
  const channels = [...new Set<NotifyChannel>(configured)];
  return {
    notifications: channels.map((channel) => ({ ...draft, channel })),
    muted: channels.length === 0,
  };
}
