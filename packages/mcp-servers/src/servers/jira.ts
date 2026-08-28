import { TicketKey } from "@maestro/contracts";
import type { TicketSnapshot } from "@maestro/contracts";
import type { WorkPort } from "@maestro/ports";
import { z } from "zod";
import { assertReadOnlyServer, defineServer, defineTool, type ServerDefinition } from "../tool.js";

/** One Jira comment as the agent needs to read it. */
export interface JiraComment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly at: string;
}

/** A neighbouring ticket found by search — enough to decide whether to open it. */
export interface RelatedTicket {
  readonly key: string;
  readonly summary: string;
  readonly issueType: string;
  readonly status: string;
  readonly relation: "parent" | "child" | "link" | "search";
}

/**
 * Reads this server needs that `WorkPort` does not expose yet: the comment
 * stream and a scoped search. Kept as its own DI seam rather than reached for
 * through a driver import (M44) — the port extension is requested in RAPOR.md.
 */
export interface JiraReadAccess {
  listComments(key: string, limit: number): Promise<readonly JiraComment[]>;
  searchRelated(query: {
    ticketKey: string;
    text: string | undefined;
    limit: number;
  }): Promise<readonly RelatedTicket[]>;
}

export interface JiraMcpDeps {
  readonly work: WorkPort;
  readonly reads: JiraReadAccess;
}

const MAX_COMMENTS = 200;
const MAX_RESULTS = 50;

/**
 * `jira-mcp` — what an agent session may see of Jira (M37).
 *
 * READ ONLY, and structurally so: `assertReadOnlyServer` refuses any tool
 * whose scope is not `read`, so the absence of `add_comment` / `set_labels` /
 * `transition` is enforced rather than remembered.
 *
 * Why no write tool. Everything the platform says in a ticket — the live
 * status comment (M75), a clarification question, a label, a fan-out child —
 * is written by a WORKFLOW ACTIVITY through `WorkPort`, under the worker's own
 * identity, at a point in the flow the workflow chose. Handing the same power
 * to the model inside the sandbox would mean the ticket history stops being a
 * record of what the platform did and becomes a record of what a turn felt
 * like doing: two voices, no ordering guarantee, no retry semantics, and an
 * approval command (M105) posted by something that is not a person.
 */
export function jiraMcpServer(deps: JiraMcpDeps): ServerDefinition {
  const server = defineServer({
    name: "jira-mcp",
    version: "0.1.0",
    description: "Read access to the work item the session is working on, and its neighbourhood.",
    tools: [
      defineTool({
        name: "get_ticket",
        description: "Full snapshot of a Jira issue: summary, description, type, labels, components, parent.",
        scope: "read",
        input: z.object({ ticketKey: TicketKey }),
        subject: (args) => args.ticketKey,
        handler: async (args): Promise<TicketSnapshot> => deps.work.getTicket(args.ticketKey),
      }),
      defineTool({
        name: "get_ticket_comments",
        description:
          "Comment stream of a Jira issue in chronological order — clarification answers and human decisions live here.",
        scope: "read",
        input: z.object({
          ticketKey: TicketKey,
          limit: z.number().int().positive().max(MAX_COMMENTS).default(50),
        }),
        subject: (args) => args.ticketKey,
        handler: async (args) => deps.reads.listComments(args.ticketKey, args.limit),
      }),
      defineTool({
        name: "search_related_tickets",
        description:
          "Tickets related to this one: parent, children, issue links, plus a text search scoped to the same project.",
        scope: "read",
        input: z.object({
          ticketKey: TicketKey,
          text: z.string().trim().min(2).max(200).optional(),
          limit: z.number().int().positive().max(MAX_RESULTS).default(20),
        }),
        subject: (args) => args.ticketKey,
        handler: async (args) =>
          deps.reads.searchRelated({ ticketKey: args.ticketKey, text: args.text, limit: args.limit }),
      }),
    ],
  });
  assertReadOnlyServer(server);
  return server;
}
