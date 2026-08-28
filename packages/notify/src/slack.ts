import type { Notification } from "@maestro/contracts";
import { SLACK_DRIVER, type WebhookDriverConfig } from "./config.js";
import { type WebhookDeps, WebhookNotifier } from "./webhook.js";

/**
 * Slack Incoming Webhook (M45 — shipped, off by default). `text` is the
 * notification/fallback line, `blocks` the rendered body. Text is catalog
 * output (M104); nothing is composed here.
 */
export function buildSlackMessage(_notification: Notification, subject: string, body: string): unknown {
  return {
    // `text` is the notification/fallback line and Slack renders it with the
    // same mrkdwn rules as a block, so it needs the same escaping: an
    // unescaped `<https://evil|Onayla>` is a clickable link in a bank's
    // approval alert.
    text: escapeMrkdwn(subject),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: escapeMrkdwn(body) } }],
  };
}

/**
 * Slack's mrkdwn treats `&`, `<` and `>` as markup. A ticket summary
 * containing `<script>` or `A & B` would otherwise render mangled or be
 * misread as a link.
 */
export function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Slack replies `ok` on success; ANYTHING else on a 2xx is a refusal. This is a
 * whitelist on purpose — `channel_not_found` and `action_prohibited` carry none
 * of the words a blacklist looks for, and were silently counted as delivered.
 */
export function slackBodyFailure(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "ok") return null;
  return trimmed;
}

export function createSlackNotifier(config: WebhookDriverConfig, deps: WebhookDeps): WebhookNotifier {
  return new WebhookNotifier(
    { channel: SLACK_DRIVER, buildPayload: buildSlackMessage, checkBody: slackBodyFailure },
    config,
    deps,
  );
}
