import { z } from "zod";
import { IsoDateTime, Locale, NonEmpty } from "./common.js";

/** Pluggable notify channels (M45); channel choice is a Studio parameter. */
export const NotifyChannel = z.enum(["teams", "smtp", "jira", "slack"]);
export type NotifyChannel = z.infer<typeof NotifyChannel>;

export const NotifyEventKey = z.enum([
  "gate_open",
  "gate_reminder",
  "escalation",
  "clarification_reminder",
  "handover",
  "ci_red",
  "quota_wait",
  "runner_health",
  "kill_switch",
]);
export type NotifyEventKey = z.infer<typeof NotifyEventKey>;

/** Message text comes from the catalog via messageKey + params (M104). */
export const Notification = z.object({
  event: NotifyEventKey,
  channel: NotifyChannel,
  to: z.array(NonEmpty).min(1),
  locale: Locale,
  messageKey: NonEmpty,
  params: z.record(z.string(), z.string()).default({}),
  at: IsoDateTime,
});
export type Notification = z.infer<typeof Notification>;
