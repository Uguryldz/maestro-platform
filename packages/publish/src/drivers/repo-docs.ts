import { z } from "zod";
import { NonEmpty, type PublishReceipt, type PublishRequest, type PublishTarget } from "@maestro/contracts";
import type { ScmPort } from "@maestro/ports";
import { PublishConfigError } from "../errors.js";
import { contentHash } from "../md.js";
import type { PublishStateStore, RepoWorkspace, RunContextResolver, TargetPublisher } from "../types.js";

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** `docs/../../etc` matches the charset but escapes the repository. */
const RepoPath = z
  .string()
  .regex(PATH_SEGMENT)
  .refine((value) => !value.split("/").includes(".."), { message: "must not contain a `..` segment" });

export const RepoDocsPublishConfig = z
  .object({
    /** Directory inside the application's repo, e.g. `docs/maestro`. */
    docsDir: RepoPath.default("docs/maestro"),
    baseBranch: NonEmpty.default("main"),
    branchPrefix: RepoPath.default("docs/maestro"),
    /** Documents land through review by default (M49 trunk-based). */
    openPullRequest: z.boolean().default(true),
  })
  .strict();
export type RepoDocsPublishConfig = z.infer<typeof RepoDocsPublishConfig>;

const PrState = z.enum(["draft", "active", "completed", "abandoned"]);

/**
 * Remembered delivery state. `prState` and `revision` were added because the
 * branch alone is not enough: once a PR is merged the branch is normally
 * deleted, and a driver that only remembers its name commits the next revision
 * to a ref nobody can see.
 */
const RepoDocsState = z.object({
  branch: z.string().min(1),
  path: z.string().min(1),
  hash: z.string().min(1),
  sha: z.string().min(1).nullable(),
  prId: z.number().int().positive().optional(),
  prState: PrState.optional(),
  revision: z.number().int().nonnegative().default(0),
});
type RepoDocsState = z.infer<typeof RepoDocsState>;

export interface RepoDocsPublisherDeps {
  scm: ScmPort;
  workspace: RepoWorkspace;
  state: PublishStateStore;
  runContext: RunContextResolver;
}

/**
 * repo-docs driver (M47): the document is written into the application's own
 * repository and delivered as a commit (plus a PR by default). No git client
 * here (M44) — `ScmPort` does branch/PR, the injected workspace does the file.
 *
 * Idempotent by content: if the file on the branch already holds these exact
 * bytes, nothing is committed. Republishing an unchanged document produces no
 * empty commit and no second PR.
 *
 * Commit message, branch name and PR title stay ENGLISH (M59) even when the
 * document body is Turkish.
 */
export class RepoDocsPublisher implements TargetPublisher {
  readonly target: PublishTarget = "repo-docs";

  constructor(
    private readonly config: RepoDocsPublishConfig,
    private readonly deps: RepoDocsPublisherDeps,
  ) {
    if (typeof deps.scm?.resolveRepo !== "function") {
      throw new PublishConfigError("the repo-docs target needs deps.scm (ScmPort)");
    }
    if (typeof deps.workspace?.commitFile !== "function") {
      throw new PublishConfigError("the repo-docs target needs deps.workspace (RepoWorkspace)");
    }
  }

  async publish(req: PublishRequest, markdownSource: string): Promise<PublishReceipt> {
    const { ticketKey, app } = await this.deps.runContext(req.runId);
    if (!app) {
      throw new PublishConfigError(`run ${req.runId} has no application — repo-docs has no repository to write to`);
    }

    const stateKey = `publish:repo-docs:${req.runId}:${req.doc}`;
    const previous = await this.readState(stateKey);
    const hash = contentHash(markdownSource);
    // "Already published" means committed AND delivered: a run that died
    // between the commit and the PR left the document on a branch nobody was
    // asked to review, and an early return here would leave it there forever.
    const delivered = this.config.openPullRequest ? previous?.prId !== undefined : true;
    if (previous && previous.hash === hash && previous.sha && delivered) {
      return { target: this.target, ref: previous.sha };
    }

    const path = `${this.config.docsDir}/${ticketKey}/${req.doc}.md`;
    const repo = await this.deps.scm.resolveRepo(app);
    const cycle = await this.resolveCycle(repo, ticketKey, req.doc, previous);
    const { branch } = cycle;
    const title = `docs(maestro): ${req.doc.replace(/_/g, " ")} for ${ticketKey}`;
    // Every side effect is followed immediately by a state write. A publish
    // interrupted between the commit and the PR used to leave no trace at all:
    // the next attempt found identical bytes, could not name the commit and
    // opened a SECOND pull request for the same document (F8).
    const remember = (patch: Partial<RepoDocsState>): Promise<void> =>
      this.deps.state.set(stateKey, JSON.stringify({ ...cycle.record, path, hash, ...patch }));

    const existing = await this.deps.workspace.readFile(branch, path);
    if (existing === null && cycle.fresh) {
      await this.deps.scm.createBranch(repo, branch, this.config.baseBranch);
      await remember({});
    }

    let sha = cycle.record.sha;
    if (existing !== markdownSource) {
      const committed = await this.deps.workspace.commitFile({ branch, path, content: markdownSource, message: title });
      if (typeof committed?.sha !== "string" || committed.sha.trim().length === 0) {
        throw new PublishConfigError("RepoWorkspace.commitFile returned an empty commit sha");
      }
      sha = committed.sha;
      cycle.record.sha = sha;
      await remember({});
    }

    if (this.config.openPullRequest && cycle.record.prId === undefined) {
      const opened = await this.deps.scm.openPr(repo, {
        sourceBranch: branch,
        targetBranch: this.config.baseBranch,
        title,
        description: `Automated document publication for ${ticketKey} (run ${req.runId}). File: ${path}`,
        draft: false,
      });
      cycle.record.prId = opened.prId;
      cycle.record.prState = "active";
      await remember({});
    }

    return { target: this.target, ref: sha ?? (await this.recoverSha(branch, path)) };
  }

  /**
   * Which branch this publication belongs on.
   *
   * The M54 rejection loop is routine: analysis published → PR merged → branch
   * deleted → analysis rejected → revised analysis published. The driver used
   * to reuse the remembered branch because it existed once and to skip the PR
   * because an id was remembered, so the revision was committed to a dangling
   * ref and the receipt still said "published". `ScmPort` exposes no branch
   * lookup (see RAPOR §6.2b), so the PR is the witness: a completed or
   * abandoned PR ends the cycle and the next revision gets its own branch.
   */
  private async resolveCycle(
    repo: Awaited<ReturnType<ScmPort["resolveRepo"]>>,
    ticketKey: string,
    doc: string,
    previous: RepoDocsState | null,
  ): Promise<{ branch: string; fresh: boolean; record: RepoDocsState }> {
    const base = `${this.config.branchPrefix}/${ticketKey}-${doc}`;
    const start = (revision: number): { branch: string; fresh: boolean; record: RepoDocsState } => {
      const branch = revision === 0 ? base : `${base}-r${String(revision)}`;
      return { branch, fresh: true, record: { branch, path: "", hash: "", sha: null, revision } };
    };
    if (!previous) return start(0);
    if (previous.prId === undefined) {
      return { branch: previous.branch, fresh: false, record: { ...previous } };
    }

    const status = await this.deps.scm.getPrStatus(repo, previous.prId);
    if (status.state === "active" || status.state === "draft") {
      return { branch: previous.branch, fresh: false, record: { ...previous, prState: status.state } };
    }
    return start(previous.revision + 1);
  }

  /**
   * Bookkeeping lost while the repository already holds these exact bytes.
   * The receipt used to carry the file path here, which reads as a commit ref
   * in an evidence package and is not one; a workspace that cannot name the
   * commit must fail loudly instead.
   */
  private async recoverSha(branch: string, path: string): Promise<string> {
    const sha = (await this.deps.workspace.headSha?.(branch, path)) ?? null;
    if (sha === null || sha.trim().length === 0) {
      throw new PublishConfigError(
        `${path} on ${branch} already holds these bytes but its commit sha is unknown ` +
          `(no RepoWorkspace.headSha) — refusing to receipt a file path as a commit`,
      );
    }
    return sha;
  }

  private async readState(key: string): Promise<RepoDocsState | null> {
    const raw = await this.deps.state.get(key);
    if (raw === null) return null;
    try {
      const parsed = RepoDocsState.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
