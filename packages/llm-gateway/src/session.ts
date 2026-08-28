import type { DataClass, LlmDriverId } from "@maestro/contracts";
import { UnknownResumeTokenError } from "./errors.js";

/**
 * What Wave 2 (`packages/execution`, Claude Agent SDK) must implement. This
 * package decides WHICH backend and WHICH session a doing-role turn belongs to;
 * it deliberately does not run the agent (M17).
 */
export interface AgentRunInput {
  driver: LlmDriverId;
  model: string;
  workspacePath: string;
  task: string;
  mcpServers: string[];
  /** Vendor session handle from the previous turn; null on the first turn. */
  vendorSessionId: string | null;
  /** Subscription seat credential when the pool picked one (M55). */
  credentialRef: string | null;
}

export interface AgentRunOutput {
  finalText: string;
  tokensIn: number;
  tokensOut: number;
  /** Handle to hand back on the next turn; the runner may keep the old one. */
  vendorSessionId?: string;
}

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunOutput>;
}

/**
 * What the first turn decided and every later turn must still agree with. The
 * data class and the masking flag belong here, not just the backend: a session
 * whose second turn goes out unmasked is a session that was never masked (M20).
 */
export interface SessionPin {
  driver: LlmDriverId;
  model: string;
  dataClass: DataClass;
  masked: boolean;
}

export interface SessionRecord extends SessionPin {
  resumeToken: string;
  workspacePath: string;
  vendorSessionId: string | null;
  turns: number;
  createdAt: string;
  updatedAt: string;
}

/** Human-readable pin, for the error a policy change raises. */
export function describePin(pin: SessionPin): string {
  return `${pin.driver}/${pin.model} (${pin.dataClass}${pin.masked ? ", masked" : ""})`;
}

/**
 * Session bookkeeping for `agentSession`. A resume token is bound to one
 * workspace and one backend: an unknown token or a workspace switch is an
 * error, never a silently fresh session that would lose the agent's context.
 */
export class AgentSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly newId: () => string,
    private readonly now: () => Date,
  ) {}

  start(pin: SessionPin, workspacePath: string): SessionRecord {
    const at = this.now().toISOString();
    const record: SessionRecord = {
      ...pin,
      resumeToken: this.newId(),
      workspacePath,
      vendorSessionId: null,
      turns: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.sessions.set(record.resumeToken, record);
    return record;
  }

  resume(resumeToken: string, workspacePath: string): SessionRecord {
    const record = this.sessions.get(resumeToken);
    if (!record) throw new UnknownResumeTokenError(resumeToken);
    if (record.workspacePath !== workspacePath) {
      throw new UnknownResumeTokenError(
        `${resumeToken} (bound to workspace ${record.workspacePath}, not ${workspacePath})`,
      );
    }
    return record;
  }

  /** One completed turn: the backend stays pinned, the vendor handle refreshes. */
  complete(resumeToken: string, vendorSessionId: string | null): SessionRecord {
    const record = this.sessions.get(resumeToken);
    if (!record) throw new UnknownResumeTokenError(resumeToken);
    record.turns += 1;
    record.updatedAt = this.now().toISOString();
    if (vendorSessionId !== null) record.vendorSessionId = vendorSessionId;
    return record;
  }
}
