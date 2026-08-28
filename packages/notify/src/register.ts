import type { Notification, NotifyChannel } from "@maestro/contracts";
import type { NotifyPort, PortRegistry, SecretPort, WorkPort } from "@maestro/ports";
import {
  JIRA_DRIVER,
  JiraDriverConfig,
  MULTI_DRIVER,
  NOTIFY_PORT,
  SLACK_DRIVER,
  SMTP_DRIVER,
  SmtpDriverConfig,
  TEAMS_DRIVER,
  WebhookDriverConfig,
  parseConfig,
} from "./config.js";
import type { Clock, FetchLike, Sleep, SocketFactory } from "./deps.js";
import { NotifyConfigError, NotifyPermanentError } from "./errors.js";
import { createJiraCommentNotifier } from "./jira.js";
import { createSlackNotifier } from "./slack.js";
import { createSmtpNotifier } from "./smtp.js";
import { createTeamsNotifier } from "./teams.js";

/**
 * Runtime collaborators a declarative config cannot carry (M44 clean room):
 * the core never imports a driver module, and a driver never reaches for a
 * global. Only the channels whose collaborators are supplied can be resolved —
 * asking for `smtp` without a socket factory fails loudly at wiring time.
 */
export interface NotifyDeps {
  /** Teams + Slack. */
  fetchImpl?: FetchLike;
  /** Webhook URLs and the SMTP password (M80). */
  secrets?: SecretPort;
  /** Jira comments go through the WorkPort — never a Jira client of our own. */
  work?: WorkPort;
  /** SMTP transport; see deps.ts for the contract. */
  socketFactory?: SocketFactory;
  clock?: Clock;
  sleep?: Sleep;
  messageId?: () => string;
}

/**
 * Composite driver: one `NotifyPort` for the core, dispatching on
 * `notification.channel` (M71 — the channel is a parameter, so the workflow
 * layer must not hold four ports and choose between them).
 */
export class CompositeNotifier implements NotifyPort {
  constructor(private readonly byChannel: ReadonlyMap<NotifyChannel, NotifyPort>) {}

  channels(): NotifyChannel[] {
    return [...this.byChannel.keys()];
  }

  async send(notification: Notification): Promise<void> {
    const port = this.byChannel.get(notification.channel);
    if (!port) {
      const enabled = this.channels().join(", ") || "(none)";
      throw new NotifyPermanentError(
        MULTI_DRIVER,
        `channel "${notification.channel}" is not enabled — enabled: ${enabled}`,
      );
    }
    await port.send(notification);
  }
}

/** Per-channel config of the composite; an absent channel is disabled. */
export interface CompositeConfig {
  teams?: unknown;
  smtp?: unknown;
  jira?: unknown;
  slack?: unknown;
}

export function createNotifier(channel: NotifyChannel, config: unknown, deps: NotifyDeps): NotifyPort {
  switch (channel) {
    case TEAMS_DRIVER:
      return createTeamsNotifier(parseConfig(WebhookDriverConfig, config, TEAMS_DRIVER), {
        fetchImpl: requireDep(deps.fetchImpl, TEAMS_DRIVER, "fetchImpl"),
        secrets: requireDep(deps.secrets, TEAMS_DRIVER, "secrets"),
        sleep: deps.sleep,
      });
    case SLACK_DRIVER:
      return createSlackNotifier(parseConfig(WebhookDriverConfig, config, SLACK_DRIVER), {
        fetchImpl: requireDep(deps.fetchImpl, SLACK_DRIVER, "fetchImpl"),
        secrets: requireDep(deps.secrets, SLACK_DRIVER, "secrets"),
        sleep: deps.sleep,
      });
    case JIRA_DRIVER:
      return createJiraCommentNotifier(parseConfig(JiraDriverConfig, config ?? {}, JIRA_DRIVER), {
        work: requireDep(deps.work, JIRA_DRIVER, "work"),
        sleep: deps.sleep,
      });
    case SMTP_DRIVER:
      return createSmtpNotifier(parseConfig(SmtpDriverConfig, config, SMTP_DRIVER), {
        socketFactory: requireDep(deps.socketFactory, SMTP_DRIVER, "socketFactory"),
        secrets: requireDep(deps.secrets, SMTP_DRIVER, "secrets"),
        clock: deps.clock,
        sleep: deps.sleep,
        messageId: deps.messageId,
      });
  }
}

export function createCompositeNotifier(config: unknown, deps: NotifyDeps): CompositeNotifier {
  const input = (typeof config === "object" && config !== null ? config : {}) as CompositeConfig;
  const enabled = new Map<NotifyChannel, NotifyPort>();
  for (const channel of [TEAMS_DRIVER, SMTP_DRIVER, JIRA_DRIVER, SLACK_DRIVER] as const) {
    const channelConfig = input[channel];
    if (channelConfig === undefined) continue;
    enabled.set(channel, createNotifier(channel, channelConfig, deps));
  }
  if (enabled.size === 0) {
    throw new NotifyConfigError(`${MULTI_DRIVER}: no channel is configured — the platform would notify nobody`);
  }
  return new CompositeNotifier(enabled);
}

/**
 * M44: drivers register factories, the composition root resolves them by name.
 * Driver ids are exactly the `NotifyChannel` values, plus `multi`.
 */
export function registerNotifyDrivers(registry: PortRegistry, deps: NotifyDeps): void {
  for (const channel of [TEAMS_DRIVER, SMTP_DRIVER, JIRA_DRIVER, SLACK_DRIVER] as const) {
    registry.register<NotifyPort>(NOTIFY_PORT, channel, (config) => createNotifier(channel, config, deps));
  }
  registry.register<NotifyPort>(NOTIFY_PORT, MULTI_DRIVER, (config) => createCompositeNotifier(config, deps));
}

function requireDep<T>(value: T | undefined, driver: string, name: string): T {
  if (value === undefined) {
    throw new NotifyConfigError(`${driver}: deps.${name} is required but was not supplied`);
  }
  return value;
}
