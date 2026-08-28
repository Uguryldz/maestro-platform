import type { JournalEntry } from "@maestro/contracts";
import type { AgentSessionOptions, AgentSessionResult, LlmOutcome, LlmPort } from "@maestro/ports";
import type { z } from "zod";
import type { BootstrapContext } from "../src/bootstrap.js";
import type { ChangedFile, CommandResult, CommandSpec, VerificationRunner, WorkspaceProbe } from "../src/types.js";

/** A checksum-valid TR IBAN — real shape, fictional owner. */
export const SAMPLE_IBAN = "TR330006100519786457841326";

export function journalEntry(seq: number, over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    runId: "run-000001",
    seq,
    at: `2026-08-08T10:0${seq}:00.000Z`,
    actor: "ai",
    kind: "engineering",
    title: `entry ${seq}`,
    detail: "",
    ...over,
  };
}

export function bootstrapContext(over: Partial<BootstrapContext> = {}): BootstrapContext {
  return {
    ticketKey: "UGURPAY-42",
    runId: "run-000001",
    task: "Add the missing null check in the payment mapper.",
    journal: [journalEntry(0, { kind: "intake", title: "ticket picked up" })],
    livingSummary: { runId: "run-000001", upToSeq: 0, text: "Ticket accepted; analysis approved." },
    workspace: { path: "/w/UGURPAY-42", present: true, branch: "feat/x", baseSha: "abc1234", dirtyFiles: [] },
    protectedPaths: ["**/migrations/**"],
    mcpServers: ["jira", "workspace"],
    ...over,
  };
}

export function changed(path: string, over: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: "modified", insertions: 3, deletions: 1, ...over };
}

/** Probe double: tracked changes, and optionally changes under `.git/`. */
export function fixedProbe(files: readonly ChangedFile[], internal: readonly ChangedFile[] = []): WorkspaceProbe {
  return {
    changedFiles: () => Promise.resolve(files),
    internalChangedFiles: () => Promise.resolve(internal),
  };
}

export function failingProbe(message: string): WorkspaceProbe {
  return {
    changedFiles: () => Promise.reject(new Error(message)),
    internalChangedFiles: () => Promise.resolve([]),
  };
}

/** `git status` is clean but `.git/` itself moved — the invisible case. */
export function gitInternalProbe(internal: readonly ChangedFile[]): WorkspaceProbe {
  return {
    changedFiles: () => Promise.resolve([]),
    internalChangedFiles: () => Promise.resolve(internal),
  };
}

/** Verification runner double: exit codes keyed by command name. */
export function stubVerifier(exitCodes: Record<string, number>, output = ""): VerificationRunner & { seen: CommandSpec[] } {
  const seen: CommandSpec[] = [];
  return {
    seen,
    run(_workspacePath: string, spec: CommandSpec): Promise<CommandResult> {
      seen.push(spec);
      const exitCode = exitCodes[spec.name] ?? 0;
      return Promise.resolve({
        name: spec.name,
        command: spec.command,
        exitCode,
        stdoutTail: exitCode === 0 ? "" : output,
        stderrTail: "",
        durationMs: 10,
      });
    },
  };
}

export interface LlmStub extends LlmPort {
  readonly calls: AgentSessionOptions[];
}

/** LlmPort double — only `agentSession` is exercised by this package. */
export function stubLlm(outcomes: Array<LlmOutcome<AgentSessionResult>>): LlmStub {
  const calls: AgentSessionOptions[] = [];
  let index = 0;
  return {
    calls,
    generateObject<T>(_req: unknown, _schema: z.ZodType<T>): Promise<LlmOutcome<T>> {
      return Promise.reject(new Error("generateObject is not used by @maestro/execution"));
    },
    agentSession(opts: AgentSessionOptions): Promise<LlmOutcome<AgentSessionResult>> {
      calls.push(opts);
      const outcome = outcomes[index];
      index += 1;
      if (!outcome) throw new Error(`unexpected agentSession call #${index}`);
      return Promise.resolve(outcome);
    },
  };
}

/**
 * LlmPort double whose answer is computed at call time: the first turn says
 * `first`, every later turn says whatever `later()` returns then. Needed where
 * a turn must quote what an EARLIER turn produced, which a canned list cannot
 * express.
 */
export function echoingLlm(later: () => string, first: string): LlmStub {
  const calls: AgentSessionOptions[] = [];
  let turn = 0;
  return {
    calls,
    generateObject<T>(_req: unknown, _schema: z.ZodType<T>): Promise<LlmOutcome<T>> {
      return Promise.reject(new Error("generateObject is not used by @maestro/execution"));
    },
    agentSession(opts: AgentSessionOptions): Promise<LlmOutcome<AgentSessionResult>> {
      calls.push(opts);
      turn += 1;
      return Promise.resolve(okSession({ finalText: turn === 1 ? first : later() }));
    },
  };
}

export function okSession(over: Partial<AgentSessionResult> = {}): LlmOutcome<AgentSessionResult> {
  return {
    status: "ok",
    value: {
      resumeToken: "resume-1",
      finalText: "done",
      log: llmLog(),
      ...over,
    },
    log: llmLog(),
  };
}

function llmLog() {
  return {
    at: "2026-08-08T10:00:00.000Z",
    runId: null,
    role: "engineer" as const,
    variantId: "v1",
    driver: "claude-sub" as const,
    model: "claude-opus-4",
    tokensIn: 10,
    tokensOut: 5,
    cachePct: null,
    usd: null,
    dataClass: "dahili" as const,
  };
}

/** A clock that ticks one second per call — deterministic, never `Date.now`. */
export function tickingClock(startIso = "2026-08-08T10:00:00.000Z"): () => Date {
  let ms = Date.parse(startIso);
  return () => {
    const at = new Date(ms);
    ms += 1000;
    return at;
  };
}
