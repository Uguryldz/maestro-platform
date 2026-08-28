import { PublishReceipt, PublishRequest, type PublishTarget } from "@maestro/contracts";
import { CapabilityNotSupportedError, type PublishPort } from "@maestro/ports";
import { PublishRenderError } from "./errors.js";
import type { TargetPublisher } from "./types.js";

/** Registry port name (M44). */
export const PUBLISH_PORT = "publish";

/**
 * Masks the document before any target sees it (M20/M82). Required rather than
 * optional: an artefact port whose PII gate can be left unwired has no gate.
 */
export type PublishRedactor = (req: PublishRequest, markdownSource: string) => Promise<string>;

/**
 * `PublishPort` implementation that fans a request out over its targets
 * (M47: "hepsi olsun, esnek ve modüler"). Targets run in request order and one
 * failing target fails the publish — partial success would hand a run a
 * receipt list that silently misses a target.
 *
 * docx/pdf (M103r) are served like any other target, and the composition-time
 * discipline is unchanged: a target that cannot be BUILT — a `pdf` with no
 * storage sink — is refused while composing, so a `jira+pdf` project can never
 * post its Jira comment and only then discover the second target is unusable.
 */
export class MaestroPublishPort implements PublishPort {
  constructor(
    private readonly publishers: Map<PublishTarget, TargetPublisher>,
    private readonly redact: PublishRedactor,
  ) {}

  /** Targets this instance can actually serve. */
  targets(): PublishTarget[] {
    return [...this.publishers.keys()];
  }

  async publish(req: PublishRequest, markdownSource: string): Promise<PublishReceipt[]> {
    const request = PublishRequest.parse(req);
    if (typeof markdownSource !== "string" || markdownSource.trim().length === 0) {
      throw new PublishRenderError("refusing to publish an empty document");
    }
    // Masked once, here: every driver below writes to an artefact store.
    const source = await this.redact(request, markdownSource);

    const receipts: PublishReceipt[] = [];
    for (const target of new Set(request.targets)) {
      const publisher = this.publishers.get(target);
      if (!publisher) throw new CapabilityNotSupportedError(PUBLISH_PORT, target);
      receipts.push(PublishReceipt.parse(await publisher.publish(request, source)));
    }
    return receipts;
  }
}
