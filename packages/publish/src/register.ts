import { z } from "zod";
import { PublishTarget } from "@maestro/contracts";
import type { PortRegistry } from "@maestro/ports";
import { BinaryDocPublisher, BinaryDocPublishConfig } from "./drivers/binary-doc.js";
import { ConfluencePublisher, ConfluencePublishConfig } from "./drivers/confluence.js";
import { JiraPublisher } from "./drivers/jira.js";
import { RepoDocsPublisher, RepoDocsPublishConfig } from "./drivers/repo-docs.js";
import { PublishConfigError } from "./errors.js";
import { createPublishRedactor } from "./pii.js";
import { MaestroPublishPort, PUBLISH_PORT } from "./port.js";
import type { PublishDeps, TargetPublisher } from "./types.js";

/** Driver name that serves the project's whole target set at once (M47). */
export const PUBLISH_MULTI_DRIVER = "multi";

export const PublishDriverConfig = z
  .object({
    /** Only for the `multi` driver: the project's target set (M47 parameter). */
    targets: z.array(PublishTarget).min(1).optional(),
    confluence: ConfluencePublishConfig.optional(),
    repoDocs: RepoDocsPublishConfig.optional(),
    /** Shared by the `docx` and `pdf` targets (M103r). */
    binaryDoc: BinaryDocPublishConfig.optional(),
  })
  .strict();
export type PublishDriverConfig = z.infer<typeof PublishDriverConfig>;

/**
 * Build a `PublishPort` for an explicit target set. Configuration missing for a
 * requested target is an error HERE, at composition time — never a target that
 * quietly disappears from a run's receipts.
 */
export function createPublishPort(targets: PublishTarget[], config: unknown, deps: PublishDeps): MaestroPublishPort {
  const parsed = PublishDriverConfig.safeParse(config ?? {});
  if (!parsed.success) {
    throw new PublishConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  }
  assertDeps(deps);
  const publishers = new Map<PublishTarget, TargetPublisher>();
  for (const target of targets) publishers.set(target, buildPublisher(target, parsed.data, deps));
  return new MaestroPublishPort(publishers, createPublishRedactor(deps.pii, deps.runContext));
}

function buildPublisher(target: PublishTarget, config: PublishDriverConfig, deps: PublishDeps): TargetPublisher {
  const shared = { state: deps.state, runContext: deps.runContext };
  switch (target) {
    case "jira":
      if (!deps.work) throw new PublishConfigError("the jira target needs deps.work (WorkPort)");
      return new JiraPublisher({ ...shared, work: deps.work });
    case "confluence": {
      if (!config.confluence) throw new PublishConfigError("the confluence target needs config.confluence");
      if (!deps.secrets) throw new PublishConfigError("the confluence target needs deps.secrets (SecretPort)");
      return new ConfluencePublisher(config.confluence, {
        ...shared,
        secrets: deps.secrets,
        translate: deps.translate,
        fetchImpl: deps.fetchImpl,
        sleep: deps.sleep,
      });
    }
    case "repo-docs": {
      if (!deps.scm) throw new PublishConfigError("the repo-docs target needs deps.scm (ScmPort)");
      if (!deps.workspace) throw new PublishConfigError("the repo-docs target needs deps.workspace (RepoWorkspace)");
      return new RepoDocsPublisher(config.repoDocs ?? RepoDocsPublishConfig.parse({}), {
        ...shared,
        scm: deps.scm,
        workspace: deps.workspace,
      });
    }
    case "docx":
    case "pdf": {
      // M103r. These targets are served now, but the discipline that used to
      // live here as a blanket refusal is kept exactly: a missing sink is an
      // error at COMPOSITION time, so a `jira+pdf` project cannot post its Jira
      // comment and only then discover the second target cannot store a file.
      if (!deps.sink) {
        throw new PublishConfigError(`the ${target} target needs deps.sink (StoragePort) to store the generated file`);
      }
      return new BinaryDocPublisher(target, config.binaryDoc ?? BinaryDocPublishConfig.parse({}), {
        ...shared,
        sink: deps.sink,
        translate: deps.translate,
        templates: deps.docTemplates,
        now: deps.now,
        onWarnings: deps.onTemplateWarnings,
      });
    }
  }
}

function assertDeps(deps: PublishDeps): void {
  if (typeof deps?.translate !== "function") {
    throw new PublishConfigError("deps.translate is required — user-facing text comes from the catalog (M104)");
  }
  if (typeof deps.runContext !== "function") {
    throw new PublishConfigError("deps.runContext is required — PublishRequest carries no ticket key");
  }
  if (typeof deps.state?.get !== "function" || typeof deps.state.set !== "function") {
    throw new PublishConfigError("deps.state is required — idempotent publishing needs bookkeeping");
  }
  if (typeof deps.pii?.policy !== "object" || deps.pii.policy === null) {
    throw new PublishConfigError(
      "deps.pii.policy is required — every published document is an artefact (M20/M82) and is masked before egress",
    );
  }
}

/**
 * Register the publish drivers (M44 clean-room DI): one driver per target for
 * direct use, plus `multi` for the project's configured target set. The core
 * never imports this module; the composition root calls it once.
 */
export function registerPublishDrivers(registry: PortRegistry, deps: PublishDeps): void {
  assertDeps(deps);
  for (const target of PublishTarget.options) {
    registry.register(PUBLISH_PORT, target, (config) => createPublishPort([target], config, deps));
  }
  registry.register(PUBLISH_PORT, PUBLISH_MULTI_DRIVER, (config) => {
    const parsed = PublishDriverConfig.safeParse(config ?? {});
    const targets = parsed.success ? parsed.data.targets : undefined;
    if (!targets) {
      throw new PublishConfigError(`the "${PUBLISH_MULTI_DRIVER}" driver needs config.targets (the project's target set)`);
    }
    return createPublishPort(targets, config, deps);
  });
}
