import type { Notification } from "@maestro/contracts";

/** Notify port (M45): teams · smtp · jira · slack drivers, chosen by parameter. */
export interface NotifyPort {
  send(notification: Notification): Promise<void>;
}
