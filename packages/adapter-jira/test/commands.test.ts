import { ParsedCommand } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { COMMAND_MESSAGE_KEYS, parseCommandBody, parseCommandLine } from "../src/index.js";

function ok(line: string): ParsedCommand {
  const result = parseCommandLine(line);
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status} for "${line}"`);
  // Commands cross into the core through the contract — validate them here.
  return ParsedCommand.parse(result.command);
}

describe("comment command grammar", () => {
  it("parses the argument-free commands", () => {
    expect(ok("/approve")).toEqual({ name: "approve" });
    expect(ok("/status")).toEqual({ name: "status" });
    expect(ok("/ai-explain")).toEqual({ name: "ai-explain" });
    expect(ok("/ai-start")).toEqual({ name: "ai-start" });
    expect(ok("/ai-takeover")).toEqual({ name: "ai-takeover" });
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(ok("   /APPROVE  ")).toEqual({ name: "approve" });
  });

  it("takes the whole rest of the line as the reject reason", () => {
    expect(ok("/reject kabul kriterleri eksik, AC-3 yok")).toEqual({
      name: "reject",
      reason: "kabul kriterleri eksik, AC-3 yok",
    });
  });

  it("refuses /reject without a reason and says which message to render", () => {
    const result = parseCommandLine("/reject");
    expect(result).toEqual({
      status: "invalid",
      command: "reject",
      messageKey: COMMAND_MESSAGE_KEYS.rejectNeedsReason,
      messageParams: {},
    });
  });

  it("parses /ai-assign with an application id", () => {
    expect(ok("/ai-assign ugurweb")).toEqual({ name: "ai-assign", appId: "ugurweb" });
    expect(ok("/ai-assign UgurWeb")).toEqual({ name: "ai-assign", appId: "ugurweb" });
  });

  it("rejects a malformed application id", () => {
    const result = parseCommandLine("/ai-assign 9_bad app");
    expect(result).toMatchObject({ status: "invalid", messageKey: COMMAND_MESSAGE_KEYS.invalidAppId });
  });

  it("accepts both hyphen and underscore work modes", () => {
    expect(ok("/mode-change ai-assist")).toEqual({ name: "mode-change", mode: "ai_assist" });
    expect(ok("/mode-change human_lead")).toEqual({ name: "mode-change", mode: "human_lead" });
  });

  it("rejects an unknown work mode and offers the valid set", () => {
    const result = parseCommandLine("/mode-change turbo");
    expect(result).toMatchObject({ status: "invalid", messageKey: COMMAND_MESSAGE_KEYS.invalidMode });
    if (result.status !== "invalid") throw new Error("unreachable");
    expect(result.messageParams["modes"]).toContain("full_auto");
  });

  it("flags an unknown slash command without throwing", () => {
    const result = parseCommandLine("/deploy-prod");
    expect(result).toMatchObject({ status: "invalid", command: "deploy-prod", messageKey: COMMAND_MESSAGE_KEYS.unknown });
    if (result.status !== "invalid") throw new Error("unreachable");
    expect(result.messageParams["commands"]).toContain("/approve");
  });

  it("treats ordinary prose as no command at all", () => {
    expect(parseCommandLine("kapsam uygun, ilerleyin")).toEqual({ status: "none" });
    expect(parseCommandLine("")).toEqual({ status: "none" });
  });

  it("only inspects the first non-empty line of a comment", () => {
    expect(parseCommandBody("\n\n/approve")).toEqual({ status: "ok", command: { name: "approve" } });
    expect(parseCommandBody("\n/reject AC-3 yok\nbu satır yok sayılır")).toEqual({
      status: "ok",
      command: { name: "reject", reason: "AC-3 yok" },
    });
    expect(parseCommandBody("cevabım şu:\n/approve")).toEqual({ status: "none" });
    expect(parseCommandBody(undefined)).toEqual({ status: "none" });
  });

  // K-1: Turkish puts negation after the verb, so trailing text can invert the
  // command it follows. An argument-free command must therefore stand alone.
  it("refuses an /approve that carries extra text on the same line", () => {
    for (const line of ["/approve etmiyorum, reddediyorum", "/approve değil", "/approve ama sonra"]) {
      expect(parseCommandLine(line)).toEqual({
        status: "invalid",
        command: "approve",
        messageKey: COMMAND_MESSAGE_KEYS.takesNoArgument,
        messageParams: { command: "/approve" },
      });
    }
  });

  it("refuses an /approve followed by prose on another line", () => {
    for (const body of ["/approve\n\nAma önce güvenlik testi bitsin.", "/approve\n/reject AC-3 yok"]) {
      expect(parseCommandBody(body)).toMatchObject({
        status: "invalid",
        command: "approve",
        messageKey: COMMAND_MESSAGE_KEYS.takesNoArgument,
      });
    }
  });

  it("applies the stand-alone rule to every argument-free command", () => {
    for (const name of ["status", "ai-explain", "ai-start", "ai-takeover"]) {
      expect(parseCommandLine(`/${name} lütfen`)).toMatchObject({
        status: "invalid",
        command: name,
        messageKey: COMMAND_MESSAGE_KEYS.takesNoArgument,
      });
      expect(parseCommandBody(`/${name}\nteşekkürler`)).toMatchObject({
        status: "invalid",
        messageKey: COMMAND_MESSAGE_KEYS.takesNoArgument,
      });
    }
  });

  it("still lets argument commands take the rest of their line", () => {
    expect(ok("/reject kabul kriterleri eksik")).toEqual({ name: "reject", reason: "kabul kriterleri eksik" });
    expect(ok("/mode-change full-auto")).toEqual({ name: "mode-change", mode: "full_auto" });
  });
});
