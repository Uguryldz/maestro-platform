/**
 * `@maestro/notify` — NotifyPort drivers (M45): teams · smtp · jira · slack,
 * plus the parametric escalation ladder (M88). Message text always comes from
 * the central catalog (M104); secrets always come from SecretPort (M80).
 */
export * from "./calendar.js";
export * from "./config.js";
export * from "./deps.js";
export * from "./errors.js";
export * from "./escalation.js";
export * from "./jira.js";
export * from "./message.js";
export * from "./register.js";
export * from "./retry.js";
export * from "./slack.js";
export * from "./smtp.js";
export * from "./smtp-client.js";
export * from "./smtp-protocol.js";
export * from "./teams.js";
export * from "./webhook.js";
