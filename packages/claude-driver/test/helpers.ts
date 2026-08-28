import type { SpawnFn, SpawnSpec } from "../src/types.js";

export const SESSION_ID = "7f1c2b90-4a1d-4a55-9f3e-0c9c8b7a6d54";
export const OTHER_SESSION_ID = "11111111-2222-4333-8444-555555555555";

export function initLine(sessionId = SESSION_ID): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/w",
    session_id: sessionId,
    tools: ["Read", "Edit"],
    mcp_servers: [{ name: "jira", status: "connected" }],
    model: "claude-opus-4",
    permissionMode: "acceptEdits",
  });
}

export function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { id: "m1", model: "claude-opus-4", role: "assistant", content: [{ type: "text", text }] },
    session_id: SESSION_ID,
  });
}

export function resultLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    duration_ms: 1200,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 2,
    result: "done",
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 5,
      output_tokens: 40,
    },
    modelUsage: {},
    permission_denials: [],
    session_id: SESSION_ID,
    uuid: "9d5a2f2e-1111-4222-8333-444444444444",
    ...over,
  });
}

export function stream(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

export interface SpawnStubResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SpawnStub {
  readonly calls: SpawnSpec[];
  readonly fn: SpawnFn;
}

/** Records every invocation and replays canned process results in order. */
export function stubSpawn(results: Array<Partial<SpawnStubResult>>): SpawnStub {
  const calls: SpawnSpec[] = [];
  let index = 0;
  const fn: SpawnFn = (spec) => {
    calls.push(spec);
    const canned = results[index];
    index += 1;
    if (!canned) throw new Error(`unexpected spawn call #${index}`);
    return Promise.resolve({
      exitCode: canned.exitCode ?? 0,
      stdout: canned.stdout ?? "",
      stderr: canned.stderr ?? "",
      timedOut: canned.timedOut ?? false,
    });
  };
  return { calls, fn };
}
