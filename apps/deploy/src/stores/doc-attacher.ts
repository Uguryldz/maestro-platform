import type { WorkPort } from "@maestro/ports";
import type { DocAttacher } from "@maestro/workflows";

/**
 * Hand the worker the ability to put a FILE on a ticket (M103r).
 *
 * `WorkPort` is FROZEN and has no `addAttachment`; the capability is real only
 * on the concrete Jira Cloud driver. `@maestro/workflows` therefore declares
 * the SHAPE it needs (`DocAttacher`) and imports no adapter — and this file,
 * in the composition root, is where the shape is matched to a driver. That is
 * the M44 split: the core names a capability, the root names a driver.
 *
 * Detection is STRUCTURAL rather than an `instanceof`, on purpose. The
 * alternative is importing `JiraCloudWorkPort` here to test against it, which
 * would put an adapter class in the middle of a wiring decision the registry
 * already made — and would break the moment a second driver (a DC release with
 * an attachment API, a bank's own fork) grows the same capability. Anything
 * that can attach a file gets to; anything that cannot is absent, and the
 * delivery says so in the journal instead of pretending.
 */

/** The concrete driver's signature, as `JiraCloudWorkPort.addAttachment` has it. */
type AttachFn = (
  ticket: string,
  fileName: string,
  bytes: Uint8Array,
  contentType: string,
) => Promise<{ ids: string[] }>;

/**
 * The attacher this deployment's work driver supports, or `undefined`.
 *
 * `undefined` is a supported answer, not a degraded one to be papered over: on
 * the Data Center driver there is no attachment endpoint, and returning a stub
 * that throws would turn every analysis delivery into a journal full of
 * failures for a capability the deployment was never going to have.
 */
export function docAttacherFor(work: WorkPort): DocAttacher | undefined {
  const candidate = (work as Partial<Record<"addAttachment", unknown>>).addAttachment;
  if (typeof candidate !== "function") return undefined;
  const attach = candidate.bind(work) as AttachFn;
  return {
    addAttachment: (ticket, fileName, bytes, contentType) => attach(ticket, fileName, bytes, contentType),
  };
}
