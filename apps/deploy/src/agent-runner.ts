import { ClaudeSubRunner, nodeSpawn, type SeatCredential } from "@maestro/claude-driver";
import type { AgentRunner } from "@maestro/llm-gateway";
import type { SecretPort } from "@maestro/ports";
import { LOCAL_SEAT_REF } from "./driver-config.js";
import type { DeployEnv } from "./env.js";

/**
 * The agent runner: what lets an activity open a SESSION in a repository
 * rather than make a single model call.
 *
 * Two steps need it. Step 3ö reads the primary application's repo before the
 * analysis is written, so the analyst reasons about the code that exists
 * instead of guessing at it (M100); step 6a continues that same conversation
 * to write the change (M30). Without one, `LlmGateway.agentSession` throws
 * `AgentRunnerNotWiredError` and the run stops there.
 *
 * It was never wired. `packages/claude-driver` implements it and nothing built
 * one — not the worker, not the pilot — so every deployment refused step 3ö,
 * which is why the pilot's analyst has always been repo-blind.
 *
 * Absent configuration this returns `undefined` rather than a stub: the
 * gateway's own error names the missing dependency precisely, and a stub that
 * resolved with empty findings would let an analysis claim it had read a
 * repository it never opened.
 */
export function buildAgentRunner(env: DeployEnv, secrets: SecretPort): AgentRunner | undefined {
  const binPath = env.source["CLAUDE_BIN_PATH"]?.trim();
  if (binPath === undefined || binPath === "") return undefined;

  return new ClaudeSubRunner(nodeSpawn(), {
    binPath,
    /**
     * Where the agent may read and write. This is the sandbox's mount point,
     * not a host path: the runner passes it to a CLI that runs against the
     * workspace the fleet prepared, and a host path here would let a session
     * reach the machine's own filesystem.
     */
    basePath: env.source["CLAUDE_BASE_PATH"]?.trim() ?? "/workspace",
    home: env.source["CLAUDE_HOME"]?.trim() ?? "/tmp/claude-home",
    /**
     * Read-only tools, and no permission prompts.
     *
     * Step 3ö is a READING step: it inventories the repository. Handing it
     * write tools would mean an analysis step that can edit a bank's source,
     * which nothing in the workflow expects and no gate reviews. The
     * engineering turn asks for its own tool set when it is enabled.
     *
     * `dontAsk` rather than `bypassPermissions`: there is nobody at a terminal
     * to answer a prompt, and a session that blocked on one would hang the
     * activity until its timeout. What bounds this session is the tool list
     * below plus the container it runs in — the permission mode only decides
     * whether the CLI stops to ask about a tool it was already given.
     */
    permissionMode: "dontAsk",
    tools: ["Read", "Grep", "Glob"],
    mcpConfigPath: null,
    /**
     * Sandboxed unless a deployment says otherwise. The CLI's own sandbox is a
     * second layer under the container the fleet already provides — defence in
     * depth, not a replacement for it.
     */
    sandboxed: env.source["CLAUDE_SANDBOXED"]?.trim() !== "false",
    timeoutMs: Number(env.source["CLAUDE_TIMEOUT_MS"]?.trim() ?? 300_000),
    resolveSeat: (credentialRef) => resolveSeat(env, secrets, credentialRef),
    /**
     * Corporate TLS trust and proxy settings reach the CLI through these.
     * A bank's Claude endpoint sits behind the same proxy everything else
     * does, and a subprocess that cannot verify the certificate fails in a way
     * that reads as an agent problem.
     */
    envPassthrough: passthrough(env),
  });
}

/**
 * A seat's credentials.
 *
 * `oauthToken: null` means "use the machine's own interactive login", which is
 * how a developer workstation with `claude login` already done behaves. A bank
 * names a secret instead, and it is resolved through the SecretPort like every
 * other credential — never read from the environment directly.
 *
 * `configDir` is mandatory even for the interactive case: seats that share one
 * config directory share one transcript store, so a turn resumed on seat B
 * would replay seat A's conversation under B's account. The session id check
 * cannot catch that — the id is right, the account is not.
 */
async function resolveSeat(
  env: DeployEnv,
  secrets: SecretPort,
  credentialRef: string | null,
): Promise<SeatCredential> {
  const configDir = env.source["CLAUDE_CONFIG_DIR"]?.trim() ?? `${env.source["HOME"] ?? "/tmp"}/.claude`;
  // No reference, or the sentinel the pool carries for a host that is already
  // logged in: use that login rather than asking for a secret nobody stored.
  if (credentialRef === null || credentialRef === LOCAL_SEAT_REF) {
    return { oauthToken: null, configDir };
  }
  return { oauthToken: await secrets.get(credentialRef), configDir };
}

/** Proxy and TLS variables the CLI needs; the driver filters this list again. */
function passthrough(env: DeployEnv): Record<string, string> {
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env.source[name];
    if (value !== undefined && value.trim() !== "") out[name] = value;
  }
  return out;
}
