import type { AgentKillLevel } from "./protocol.js";

/**
 * The agent's view of the two-level kill switch (M58, task #5).
 *
 * The level arrives on EVERY platform reply — pull and lease-renew both carry
 * it — and lands here. One object holds it so that the two questions the agent
 * asks ("may I take work?", "may I keep going?") are answered from the same
 * value, and so a running job can be told to stop between steps.
 *
 * This is why the checks are not in one place: a kill switch consulted only
 * when work is pulled stops NEW jobs and lets a four-hour build run to
 * completion, which is not what "stop everything" means. The same bug was
 * found in the workflow package.
 */

/** Something a running job can be told to abandon. */
export interface Abortable {
  abort(reason: string): void;
}

export class KillSwitchState {
  #level: AgentKillLevel = "off";
  readonly #running = new Set<Abortable>();

  get level(): AgentKillLevel {
    return this.#level;
  }

  /**
   * Applies a level from a platform reply. Escalating to `stop_all` aborts
   * everything already running, immediately — not at the next poll.
   */
  apply(level: AgentKillLevel): void {
    const previous = this.#level;
    this.#level = level;
    if (level === "stop_all" && previous !== "stop_all") this.#abortAll("kill_switch_stop_all");
  }

  /** True when the agent may accept NEW work. Both stop levels say no. */
  mayAcceptWork(): boolean {
    return this.#level === "off";
  }

  /**
   * True when a job already in flight may continue. Only `stop_all` stops it:
   * `pause_intake` explicitly means "let what is running finish".
   */
  mayContinueRunning(): boolean {
    return this.#level !== "stop_all";
  }

  /**
   * Registers a running job so a later `stop_all` can reach it. Returns the
   * de-registration function; the caller MUST call it when the job ends, or
   * the set grows for the life of the process.
   */
  track(job: Abortable): () => void {
    this.#running.add(job);
    // A job started while the switch is already down is aborted at once,
    // closing the race between "switch flipped" and "job registered".
    if (this.#level === "stop_all") job.abort("kill_switch_stop_all");
    return () => this.#running.delete(job);
  }

  /** Aborts everything — used by `stop_all` and by graceful shutdown. */
  abortAll(reason: string): void {
    this.#abortAll(reason);
  }

  get runningCount(): number {
    return this.#running.size;
  }

  #abortAll(reason: string): void {
    // Copied first: `abort` handlers de-register, which mutates the set.
    for (const job of [...this.#running]) job.abort(reason);
  }
}
