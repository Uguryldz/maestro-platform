import type { Prisma } from "@prisma/client";
import { ago, demoRunId } from "./clock.js";
import { UGURPAY_TICKETS, type DemoTicket } from "./ticket-data.js";
import { OTHER_PROJECT_TICKETS } from "./ticket-data-other.js";

export type { DemoTicket } from "./ticket-data.js";

/** The mock's 22 tickets, in the order the Studio list shows them. */
export const DEMO_TICKETS: readonly DemoTicket[] = [
  ...UGURPAY_TICKETS,
  ...OTHER_PROJECT_TICKETS,
];

export class DemoTicketInvariantError extends Error {
  constructor(ticketKey: string, reason: string) {
    super(`demo ticket ${ticketKey}: ${reason}`);
    this.name = "DemoTicketInvariantError";
  }
}

/**
 * Invariants checked while the rows are built, not in a test that could be
 * deleted. `updatedAt < startedAt` is not a data-entry slip, it is a run that
 * changed state before it existed — and the whole demo (journal ordering, gate
 * timing, evidence timestamps) is anchored on this window being real.
 */
export function assertTicketInvariants(ticket: DemoTicket): void {
  if (ticket.idleHours > ticket.ageHours) {
    throw new DemoTicketInvariantError(
      ticket.key,
      `idleHours ${ticket.idleHours} > ageHours ${ticket.ageHours} (updatedAt before startedAt)`,
    );
  }
  if (ticket.idleHours < 0 || ticket.ageHours <= 0) {
    throw new DemoTicketInvariantError(
      ticket.key,
      "ageHours must be positive and idleHours non-negative",
    );
  }
  // Every run needs room for the intake entry half an hour in.
  if (ticket.ageHours < 1) {
    throw new DemoTicketInvariantError(ticket.key, "ageHours must leave room for the intake entries");
  }
}

export const RUNS: Prisma.WorkflowRunCreateManyInput[] = DEMO_TICKETS.map((ticket) => {
  assertTicketInvariants(ticket);
  return {
    id: demoRunId(ticket.key),
    ticketKey: ticket.key,
    appId: ticket.appId,
    mode: ticket.mode,
    risk: ticket.risk,
    dataClass: ticket.dataClass,
    step: ticket.step,
    status: ticket.status,
    matchJson: ticket.match,
    startedAt: ago(ticket.ageHours),
    updatedAt: ago(ticket.idleHours),
  };
});
