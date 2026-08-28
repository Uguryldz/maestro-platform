import { z } from "zod";
import type { PublishReceipt, PublishRequest, PublishTarget } from "@maestro/contracts";
import type { WorkPort } from "@maestro/ports";
import { markdownToAdf } from "../adf.js";
import { PublishConfigError, PublishRenderError } from "../errors.js";
import { contentHash } from "../md.js";
import type { PublishStateStore, RunContextResolver, TargetPublisher } from "../types.js";

const JiraPublishState = z.object({ commentId: z.string().min(1), hash: z.string().min(1) });

export interface JiraPublisherDeps {
  work: WorkPort;
  state: PublishStateStore;
  runContext: RunContextResolver;
}

/**
 * Jira driver (M47): publishes the document as a comment through `WorkPort` —
 * no Jira client of its own (M44), so DC/Cloud differences stay in the adapter.
 *
 * Idempotent by M75: the comment id of a (run, document) pair is remembered, so
 * republishing EDITS that comment instead of opening a second one, and an
 * unchanged document does not even touch Jira.
 */
export class JiraPublisher implements TargetPublisher {
  readonly target: PublishTarget = "jira";

  constructor(private readonly deps: JiraPublisherDeps) {
    if (typeof deps.work?.addComment !== "function") {
      throw new PublishConfigError("the jira target needs deps.work (WorkPort)");
    }
  }

  async publish(req: PublishRequest, markdownSource: string): Promise<PublishReceipt> {
    const { ticketKey } = await this.deps.runContext(req.runId);
    const stateKey = `publish:jira:${req.runId}:${req.doc}`;
    const previous = await this.readState(stateKey);
    const hash = contentHash(markdownSource);

    if (previous && previous.hash === hash) {
      return { target: this.target, ref: previous.commentId };
    }

    const body = markdownToAdf(markdownSource);
    if (body.content.length === 0) {
      // `{ content: [] }` is not a valid ADF document and Jira renders it as an
      // empty comment. The source was not blank — parsing consumed all of it —
      // so this must fail rather than post a blank comment under a receipt.
      throw new PublishRenderError(`document ${req.doc} rendered to an empty ADF document`);
    }
    if (previous) {
      await this.deps.work.updateComment(ticketKey, previous.commentId, body);
      await this.deps.state.set(stateKey, JSON.stringify({ commentId: previous.commentId, hash }));
      return { target: this.target, ref: previous.commentId };
    }

    const { commentId } = await this.deps.work.addComment(ticketKey, body);
    if (typeof commentId !== "string" || commentId.trim().length === 0) {
      throw new PublishConfigError("WorkPort.addComment returned an empty comment id");
    }
    await this.deps.state.set(stateKey, JSON.stringify({ commentId, hash }));
    return { target: this.target, ref: commentId };
  }

  /**
   * Unreadable bookkeeping is treated as "no comment yet": the alternative is
   * editing a comment id we cannot trust. A second comment is recoverable,
   * overwriting someone else's is not.
   */
  private async readState(key: string): Promise<z.infer<typeof JiraPublishState> | null> {
    const raw = await this.deps.state.get(key);
    if (raw === null) return null;
    try {
      const parsed = JiraPublishState.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
