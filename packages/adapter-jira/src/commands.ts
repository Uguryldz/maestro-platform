import { AppId, ParsedCommand, WorkMode } from "@maestro/contracts";

/**
 * Jira comment command grammar (M46; mock screen "Jira komut seti" is the
 * reference UX). Commands that take an argument consume the rest of their
 * line, and any following line is free prose. Commands that take NO argument
 * must stand alone in the whole comment — see NO_ARGUMENT_COMMANDS.
 */

/** Catalog keys the caller renders — no user-facing literals here (M104). */
export const COMMAND_MESSAGE_KEYS = {
  unknown: "command.unknown",
  rejectNeedsReason: "command.reject_needs_reason",
  invalidAppId: "command.invalid_app_id",
  invalidMode: "command.invalid_mode",
  takesNoArgument: "command.takes_no_argument",
} as const;

export const COMMAND_LIST = [
  "/approve",
  "/reject",
  "/status",
  "/ai-explain",
  "/ai-start",
  "/ai-assign",
  "/mode-change",
  "/ai-takeover",
] as const;

/**
 * Structured outcome so the BFF can answer a mistyped command instead of
 * silently ignoring it (M14: no silent defaults). `none` = the comment simply
 * is not a command; `invalid` = it looks like one but the argument is wrong.
 */
export type CommandParseResult =
  | { status: "ok"; command: ParsedCommand }
  | { status: "none" }
  | { status: "invalid"; command: string; messageKey: string; messageParams: Record<string, string> };

const NONE: CommandParseResult = { status: "none" };

/**
 * Commands that carry no argument at all. A gate decision (M51: `/approve` is
 * the primary approval path) has to be unambiguous, and Jira comments are
 * written in Turkish (M59) where negation trails the verb — "/approve
 * etmiyorum" ("I do not approve") would otherwise be read as an approval.
 * So any extra text, on the command line OR on a following line, makes the
 * comment invalid instead of silently swallowing the reader's real intent.
 */
const NO_ARGUMENT_COMMANDS = ["approve", "status", "ai-explain", "ai-start", "ai-takeover"] as const;
type NoArgumentCommand = (typeof NO_ARGUMENT_COMMANDS)[number];

function isNoArgumentCommand(name: string): name is NoArgumentCommand {
  return (NO_ARGUMENT_COMMANDS as readonly string[]).includes(name);
}

function invalid(command: string, messageKey: string, messageParams: Record<string, string> = {}): CommandParseResult {
  return { status: "invalid", command, messageKey, messageParams };
}

function takesNoArgument(name: string): CommandParseResult {
  return invalid(name, COMMAND_MESSAGE_KEYS.takesNoArgument, { command: `/${name}` });
}

/**
 * Parse a whole comment body. The first non-empty line carries the command;
 * for argument-free commands the remaining lines must be empty too, so a
 * trailing "ama onaylamıyorum" cannot ride along with an `/approve`.
 */
export function parseCommandBody(body: unknown): CommandParseResult {
  if (typeof body !== "string") return NONE;
  const lines = body.split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex === -1) return NONE;

  const result = parseCommandLine(lines[firstIndex]!);
  if (result.status !== "ok" || !isNoArgumentCommand(result.command.name)) return result;
  const hasTrailingText = lines.slice(firstIndex + 1).some((line) => line.trim().length > 0);
  return hasTrailingText ? takesNoArgument(result.command.name) : result;
}

/** Parse a single line. Never throws — an unknown command is data, not a fault. */
export function parseCommandLine(line: string): CommandParseResult {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return NONE;

  const [rawName = "", ...rest] = trimmed.split(/\s+/);
  const name = rawName.slice(1).toLowerCase();
  const argument = rest.join(" ").trim();

  if (isNoArgumentCommand(name)) {
    if (argument.length > 0) return takesNoArgument(name);
    return { status: "ok", command: { name } };
  }

  switch (name) {
    case "reject": {
      if (argument.length === 0) return invalid(name, COMMAND_MESSAGE_KEYS.rejectNeedsReason);
      return { status: "ok", command: { name: "reject", reason: argument } };
    }
    case "ai-assign": {
      const appId = AppId.safeParse(argument.toLowerCase());
      if (!appId.success) return invalid(name, COMMAND_MESSAGE_KEYS.invalidAppId, { value: argument });
      return { status: "ok", command: { name: "ai-assign", appId: appId.data } };
    }
    case "mode-change": {
      // The UI writes both `ai-assist` and `ai_assist`; the contract enum is
      // snake_case, so hyphens are normalised rather than rejected.
      const mode = WorkMode.safeParse(argument.toLowerCase().replace(/-/g, "_"));
      if (!mode.success) {
        return invalid(name, COMMAND_MESSAGE_KEYS.invalidMode, {
          value: argument,
          modes: WorkMode.options.join(" · "),
        });
      }
      return { status: "ok", command: { name: "mode-change", mode: mode.data } };
    }
    default:
      return invalid(name, COMMAND_MESSAGE_KEYS.unknown, { commands: COMMAND_LIST.join(" ") });
  }
}
