import type { AgentRunInput, AgentRunOutput, AgentRunner } from "@maestro/llm-gateway";
import { buildClaudeArgs, buildClaudeEnv, type PermissionMode } from "./cli.js";
import { ClaudeCliError, ClaudeCliProtocolError, ClaudeConfigError } from "./errors.js";
import { parseStreamJson } from "./stream-json.js";
import type { SpawnFn, SpawnResult } from "./types.js";

/**
 * M55/M107 subscription driver, execution half. The gateway decides WHICH seat
 * and session a doing-role turn belongs to; this class makes the turn happen by
 * driving the operator's local `claude` login non-interactively. There is no API
 * key anywhere on this path — that is the point of the driver class.
 */
export interface ClaudeSubRunnerOptions {
  readonly binPath: string;
  /** `PATH` handed to the child; the binary's own directory must be on it. */
  readonly basePath: string;
  /** `HOME` handed to the child (where the seat's login lives). */
  readonly home: string;
  readonly permissionMode: PermissionMode;
  /** Built-in tool set the turn may use — see `ClaudeCliOptions.tools`. */
  readonly tools: readonly string[];
  readonly mcpConfigPath: string | null;
  /** The platform's own settings file, if it ships one. */
  readonly settingsPath?: string | null;
  readonly sandboxed?: boolean;
  readonly timeoutMs: number;
  /** Resolves the pool's `credentialRef` into a seat. A function, so no token
   * is ever held by this object. */
  readonly resolveSeat: (credentialRef: string | null) => Promise<SeatCredential>;
  /** New session id when we pin one ourselves (`--session-id`). */
  readonly newSessionId?: () => string;
  readonly onStdoutLine?: (line: string) => void;
  /** Corporate proxy / TLS trust vars; filtered by `PASSTHROUGH_ENV`. */
  readonly envPassthrough?: Readonly<Record<string, string>>;
}

export interface SeatCredential {
  /** `null` when the seat is the machine's own interactive login (HOME-based). */
  readonly oauthToken: string | null;
  /**
   * `CLAUDE_CONFIG_DIR` for this seat. Mandatory, not optional: seats sharing
   * one config dir share one transcript store, so a turn resumed on seat B
   * would replay seat A's conversation under B's account. The session-id check
   * cannot see that — the id is correct, the account is not.
   */
  readonly configDir: string;
}

/** Driver ids this runner serves. Anything else is a wiring bug, not a fallback. */
export const CLAUDE_SUB_DRIVER = "claude-sub";

export class ClaudeSubRunner implements AgentRunner {
  constructor(
    private readonly spawn: SpawnFn,
    private readonly opts: ClaudeSubRunnerOptions,
  ) {
    if (opts.timeoutMs <= 0) throw new ClaudeConfigError("timeoutMs must be positive");
  }

  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    if (input.driver !== CLAUDE_SUB_DRIVER) {
      throw new ClaudeConfigError(
        `ClaudeSubRunner was handed driver "${input.driver}"; it only drives "${CLAUDE_SUB_DRIVER}"`,
      );
    }
    const seat = await this.opts.resolveSeat(input.credentialRef);
    if (typeof seat.configDir !== "string" || seat.configDir.trim() === "") {
      throw new ClaudeConfigError(
        `seat for credentialRef "${input.credentialRef ?? "(none)"}" has no configDir; pooled seats must not share one session store`,
      );
    }
    const resumeSessionId = input.vendorSessionId;
    const pinnedSessionId = resumeSessionId === null ? (this.opts.newSessionId?.() ?? null) : null;
    const args = buildClaudeArgs({
      binPath: this.opts.binPath,
      model: input.model,
      tools: this.opts.tools,
      mcpServers: input.mcpServers,
      mcpConfigPath: this.opts.mcpConfigPath,
      permissionMode: this.opts.permissionMode,
      settingsPath: this.opts.settingsPath ?? null,
      sandboxed: this.opts.sandboxed ?? false,
      sessionId: pinnedSessionId,
      resumeSessionId,
    });

    const spawned = await this.spawn({
      command: this.opts.binPath,
      args,
      cwd: input.workspacePath,
      // The prompt goes over stdin, never argv (see cli.ts).
      stdin: input.task,
      env: buildClaudeEnv({
        basePath: this.opts.basePath,
        home: this.opts.home,
        oauthToken: seat.oauthToken,
        configDir: seat.configDir,
        ...(this.opts.envPassthrough ? { extra: this.opts.envPassthrough } : {}),
      }),
      timeoutMs: this.opts.timeoutMs,
      ...(this.opts.onStdoutLine ? { onStdoutLine: this.opts.onStdoutLine } : {}),
    });

    return this.readTurn(spawned, resumeSessionId, pinnedSessionId);
  }

  /** A timeout, a non-zero exit and an `is_error` result all throw: the
   * gateway's contract says an exception means something broke, and a broken
   * turn must not be logged as an answer. */
  private readTurn(
    spawned: SpawnResult,
    resumeSessionId: string | null,
    pinnedSessionId: string | null,
  ): AgentRunOutput {
    const fail = (why: string): never => {
      throw new ClaudeCliError(why, spawned.exitCode, tail(spawned.stderr));
    };
    if (spawned.timedOut) fail(`claude CLI exceeded ${this.opts.timeoutMs}ms and was killed`);
    // Parse even on a non-zero exit: the result message usually carries the real
    // reason, and `stderr` alone would lose it.
    const parsed = spawned.stdout.trim() === "" ? null : parseStreamJson(spawned.stdout);
    if (parsed === null) return fail(`claude CLI exited ${spawned.exitCode} without any stream output`);
    if (parsed.isError || spawned.exitCode !== 0) {
      const why = parsed.errors.length > 0 ? parsed.errors.join("; ") : tail(spawned.stderr);
      fail(`claude CLI turn failed (exit ${spawned.exitCode}): ${why}`);
    }
    if (parsed.unparsedLines > 0) {
      // The parser counts these; nothing used to read the count, so the
      // "never silently dropped" promise ended inside the parser. In
      // stream-json mode every stdout line is NDJSON by contract, so anything
      // else is version drift or something writing into the stream.
      throw new ClaudeCliProtocolError(
        `${parsed.unparsedLines} stdout line(s) were not JSON; the turn cannot be read as a whole`,
      );
    }
    this.assertSessionIdentity(parsed.sessionId, resumeSessionId, pinnedSessionId, fail);
    return {
      finalText: parsed.finalText,
      tokensIn: parsed.tokensIn,
      tokensOut: parsed.tokensOut,
      vendorSessionId: parsed.sessionId,
    };
  }

  /**
   * Both directions, not just resume. `--resume` without `--fork-session` keeps
   * the id, so a different one means the CLI started a fresh conversation and
   * M30's context is gone. `--session-id` pins a NEW id, so a different one
   * means the gateway's session store is about to record an id that does not
   * address this transcript — the same loss, one turn later.
   */
  private assertSessionIdentity(
    got: string,
    resumeSessionId: string | null,
    pinnedSessionId: string | null,
    fail: (why: string) => never,
  ): void {
    if (resumeSessionId !== null && got !== resumeSessionId) {
      fail(`resume of session ${resumeSessionId} came back as ${got}; the previous context was lost`);
    }
    if (pinnedSessionId !== null && got !== pinnedSessionId) {
      fail(`session ${pinnedSessionId} was pinned with --session-id but the turn came back as ${got}`);
    }
  }
}

const TAIL_CHARS = 2000;

function tail(text: string): string {
  return text.length <= TAIL_CHARS ? text : text.slice(-TAIL_CHARS);
}
