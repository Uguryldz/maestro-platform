import { z } from "zod";
import { AppId, IsoDateTime, NonEmpty, ProjectKey, TicketKey, WorkMode } from "./common.js";

/**
 * Jira-shaped snapshot of a work item as adapters deliver it to the core.
 * Field names intentionally mirror Jira DC issue fields (M46/M102).
 */
export const TicketSnapshot = z.object({
  key: TicketKey,
  projectKey: ProjectKey,
  issueType: NonEmpty, // e.g. Story, Bug, Task — pass-through, no mapping forced (M98)
  summary: NonEmpty,
  description: z.string().default(""),
  reporter: NonEmpty,
  assignee: NonEmpty.nullable().default(null),
  components: z.array(NonEmpty).default([]),
  labels: z.array(NonEmpty).default([]),
  parentKey: TicketKey.nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TicketSnapshot = z.infer<typeof TicketSnapshot>;

/** Jira comment commands (mock "Jira komut seti" screen is the reference UX). */
export const CommandName = z.enum([
  "approve",
  "reject",
  "status",
  "ai-explain",
  "ai-start",
  "ai-assign",
  "mode-change",
  "ai-takeover",
]);
export type CommandName = z.infer<typeof CommandName>;

export const ParsedCommand = z.discriminatedUnion("name", [
  z.object({ name: z.literal("approve") }),
  z.object({ name: z.literal("reject"), reason: NonEmpty }),
  z.object({ name: z.literal("status") }),
  z.object({ name: z.literal("ai-explain") }),
  z.object({ name: z.literal("ai-start") }),
  z.object({ name: z.literal("ai-assign"), appId: AppId }),
  z.object({ name: z.literal("mode-change"), mode: WorkMode }),
  z.object({ name: z.literal("ai-takeover") }),
]);
export type ParsedCommand = z.infer<typeof ParsedCommand>;

export const CommandEnvelope = z.object({
  ticketKey: TicketKey,
  author: NonEmpty,
  at: IsoDateTime,
  command: ParsedCommand,
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;
