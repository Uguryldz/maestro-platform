import type {
  ApplicationRecord,
  Locale,
  PublishReceipt,
  PublishRequest,
  PublishTarget,
  RunId,
  TicketKey,
} from "@maestro/contracts";
import type { ScmPort, SecretPort, WorkPort } from "@maestro/ports";
import type { DocumentSink, TemplateWarning } from "./doc-template.js";
import type { DocTemplateSource } from "./drivers/binary-doc.js";
import type { PublishPiiDeps } from "./pii.js";

/**
 * Message-catalog lookup (M104). Structurally identical to `@maestro/config`'s
 * `t()`, but INJECTED: this package must not decide where the catalog lives,
 * and tests must not depend on catalog content that is still being written.
 */
export type Translate = (locale: Locale, key: string, params?: Record<string, string>) => string;

/** Narrow `fetch` shape the Confluence driver depends on — keeps tests offline. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Publish bookkeeping (idempotency, M75). Keyed by target+run+doc; the value is
 * an opaque JSON string owned by the driver that wrote it.
 *
 * It exists because idempotency cannot be derived from the remote systems:
 * `WorkPort` has no "list comments", so without a remembered comment id the
 * only way to republish is to post a SECOND comment.
 */
export interface PublishStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Process-local store for tests, seeds and offline demos — NOT production. */
export class InMemoryPublishState implements PublishStateStore {
  private readonly entries = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
    return Promise.resolve();
  }
}

/**
 * Repo checkout the repo-docs driver writes into. Injected because this package
 * owns no git client (M44): the runner/workspace layer supplies one, `ScmPort`
 * supplies branch + PR. See RAPOR.md — `ScmPort` has no file/commit method.
 */
export interface RepoWorkspace {
  /** Current content of `path` on `branch`, or null when the file is absent. */
  readFile(branch: string, path: string): Promise<string | null>;
  /** Stage `content` at `path` and commit it on `branch`; returns the new sha. */
  commitFile(args: {
    branch: string;
    path: string;
    content: string;
    message: string;
  }): Promise<{ sha: string }>;
  /**
   * Sha of the commit that last touched `path` on `branch`, when the workspace
   * can answer it. Needed only on the recovery path: bookkeeping lost while
   * the repository already holds these exact bytes. Without it the driver has
   * nothing true to put in the receipt and refuses rather than receipting a
   * file path as if it were a commit (F8).
   */
  headSha?(branch: string, path: string): Promise<string | null>;
}

/**
 * Run-scoped facts the drivers need but `PublishRequest` does not carry
 * (it has only `runId`): the ticket the document belongs to, and the primary
 * application whose repo receives repo-docs. Resolved through an injected
 * function so this package never reads the database.
 */
export interface PublishRunContext {
  ticketKey: TicketKey;
  app?: ApplicationRecord;
  /**
   * The ticket's declared data class (M18/M63). `unknown` on purpose: it comes
   * from a Jira field, so an absent or unrecognised value must land on the
   * strictest masking profile rather than throw.
   */
  dataClass?: unknown;
  /**
   * The exact values this run's documents must keep in clear despite masking.
   * Two things belong here and nothing else (RAPOR §4.9):
   *
   * 1. the corporate addresses of the people who signed the gates — the
   *    evidence summary exists to say WHO approved (M82), and `[EMAIL_1.…]`
   *    would destroy the only fact it is kept for;
   * 2. the pinned template version (M83). `analysis-template@1.4.0` matches
   *    the email detector, so an unlisted pin is masked; the redactor refuses
   *    the publish in that case rather than shipping a corrupted pin.
   */
  piiExemptions?: readonly string[];
}

export type RunContextResolver = (runId: RunId) => Promise<PublishRunContext>;

/** Collaborators the composition root wires in (M44 clean-room DI). */
export interface PublishDeps {
  translate: Translate;
  runContext: RunContextResolver;
  state: PublishStateStore;
  /** PII gate (M20/M82). Not optional — see `src/pii.ts`. */
  pii: PublishPiiDeps;
  work?: WorkPort;
  scm?: ScmPort;
  workspace?: RepoWorkspace;
  secrets?: SecretPort;
  fetchImpl?: FetchLike;
  /** Injected so the Confluence 409 retry is instant in tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Where `docx`/`pdf` park the file they generate (M103r). Structurally
   * `StoragePort.put`; typed here so this package needs no storage dependency.
   */
  sink?: DocumentSink;
  /** The institution's corporate `.docx` template (M103r/M108). */
  docTemplates?: DocTemplateSource;
  /** Injected clock — the künye date is otherwise not testable. */
  now?: () => Date;
  /**
   * Called when a document was produced but not exactly as the template
   * promised (no template, an appended section, a missing placeholder). These
   * are surfaced, never swallowed: Studio's doc-template screen shows them.
   */
  onTemplateWarnings?: (warnings: readonly TemplateWarning[], req: PublishRequest) => void;
}

/** One target's publisher; the port fans out over `req.targets`. */
export interface TargetPublisher {
  readonly target: PublishTarget;
  publish(req: PublishRequest, markdownSource: string): Promise<PublishReceipt>;
}
