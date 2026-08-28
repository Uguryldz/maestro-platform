import { z } from "zod";
import { defineServer, defineTool, type ServerDefinition } from "../tool.js";
import { assertSearchGlob, redactSearchHits } from "../workspace-glob.js";
import { guardWorkspacePath, unreadablePatterns, workspaceMatcher } from "../workspace-path.js";

export interface WorkspaceEntry {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly bytes: number;
}

export interface WorkspaceMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface WorkspaceFileContent {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/**
 * The filesystem seam. Every `path` handed to a driver has already been
 * normalised to a workspace-relative path by `guardWorkspacePath`, so a driver
 * joins it to the sandbox root and nothing else.
 *
 * A driver still owes one thing this package cannot check without touching a
 * disk: after resolving symlinks, the target must remain under the root. A
 * symlink planted inside the workspace pointing at `/etc` turns a legal
 * relative path into an escape, and only the driver can see that.
 */
export interface WorkspaceFs {
  readFile(path: string, maxBytes: number): Promise<WorkspaceFileContent>;
  writeFile(path: string, content: string): Promise<{ bytes: number }>;
  listDir(path: string): Promise<readonly WorkspaceEntry[]>;
  /**
   * `glob` has already been validated as workspace-relative and free of `..`,
   * absolute prefixes and control characters — join it to the sandbox root and
   * nothing else. Two obligations remain the DRIVER's, because only it touches
   * the disk (verifier B5):
   *
   *  · resolve the glob under the root and refuse anything that leaves it after
   *    symlink resolution — the same duty the path tools carry;
   *  · never return a hit whose path is on the read-deny list
   *    (`unreadablePatterns()`): a hit carries the matched LINE, so a match
   *    inside `tls/server.key` is the key material itself.
   *
   * The second is enforced again on the way out (`redactSearchHits`); it is
   * stated here because a driver that shells out to `grep -r` will otherwise
   * read those files even when the boundary drops the result.
   */
  search(query: { text: string; glob: string | undefined; limit: number }): Promise<readonly WorkspaceMatch[]>;
}

export interface WorkspaceMcpDeps {
  readonly fs: WorkspaceFs;
  /**
   * The repo's `.maestro.yaml` `protected_paths` (M52). These ADD to the
   * platform defaults; there is no way to build a matcher without the
   * defaults, so an empty list means "nothing extra", never "nothing at all".
   */
  readonly protectedPaths?: readonly string[];
}

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_CHARS = 1_000_000;
const MAX_SEARCH_HITS = 200;

/**
 * `workspace-mcp` — the sandbox filesystem (M37).
 *
 * M52 is enforced HERE, at the tool boundary, not only afterwards. The
 * post-session gate in `@maestro/execution` still runs and still stops the
 * flow on a protected diff, but by then the file has been written: the secret
 * has been overwritten, the migration has been edited, and the sandbox layer
 * that the runner may cache still carries it. Refusing at the tool means the
 * change never exists, and the model is told why in the same turn — which is
 * also the only feedback that makes it try a legal route instead.
 *
 * The two gates are not redundant. This one covers what the model asks the
 * platform to do; the session can still write through its own shell, and that
 * is what the diff gate is for.
 */
export function workspaceMcpServer(deps: WorkspaceMcpDeps): ServerDefinition {
  const matcher = workspaceMatcher(deps.protectedPaths ?? []);

  return defineServer({
    name: "workspace-mcp",
    version: "0.1.0",
    description: "Sandbox workspace filesystem: read, write, list and search, inside the M52 deny-list.",
    tools: [
      defineTool({
        name: "read_file",
        description: "Read a workspace file as UTF-8 text, truncated at a byte budget.",
        scope: "read",
        input: z.object({
          path: z.string().trim().min(1).max(1024),
          maxBytes: z.number().int().positive().max(MAX_READ_BYTES).default(MAX_READ_BYTES),
        }),
        subject: (args) => args.path,
        handler: async (args) =>
          deps.fs.readFile(guardWorkspacePath("read_file", matcher, args.path, "read"), args.maxBytes),
      }),
      defineTool({
        name: "list_dir",
        description: "List a workspace directory; `.` is the repository root.",
        scope: "read",
        input: z.object({ path: z.string().trim().min(1).max(1024).default(".") }),
        subject: (args) => args.path,
        handler: async (args) => deps.fs.listDir(guardWorkspacePath("list_dir", matcher, args.path, "read")),
      }),
      defineTool({
        name: "search_workspace",
        description: "Search file contents in the workspace, optionally narrowed by a glob.",
        scope: "read",
        input: z.object({
          text: z.string().trim().min(2).max(400),
          glob: z.string().trim().min(1).max(200).optional(),
          limit: z.number().int().positive().max(MAX_SEARCH_HITS).default(50),
        }),
        subject: (args) => args.glob ?? "(workspace)",
        // B5: this tool used to reach the driver with no path check at all, so
        // `glob: "../../**/*.pem"` answered `ok`. The glob is validated first,
        // and the hits are filtered afterwards — the driver owes the filter as
        // well (see `WorkspaceFs`), but a boundary that trusts its driver is
        // not a boundary.
        handler: async (args) => {
          const glob = args.glob === undefined ? undefined : assertSearchGlob("search_workspace", args.glob);
          const hits = await deps.fs.search({ text: args.text, glob, limit: args.limit });
          return redactSearchHits(hits);
        },
      }),
      defineTool({
        name: "write_file",
        description:
          "Write a workspace file. Refused for protected paths (M52: migrations, secrets, CI and runner surfaces).",
        scope: "operate",
        input: z.object({
          path: z.string().trim().min(1).max(1024),
          content: z.string().max(MAX_WRITE_CHARS),
        }),
        subject: (args) => args.path,
        handler: async (args) => {
          const path = guardWorkspacePath("write_file", matcher, args.path, "write");
          const { bytes } = await deps.fs.writeFile(path, args.content);
          return { path, bytes };
        },
      }),
    ],
  });
}

/** The write deny-list this server will actually apply — for bootstrap prompts and tests. */
export function workspaceProtectedPatterns(deps: WorkspaceMcpDeps): readonly string[] {
  return workspaceMatcher(deps.protectedPaths ?? []).patterns;
}

/**
 * The stricter half: paths denied on BOTH legs (B6). A repo cannot add to this
 * one — it is a platform floor, and "my source is unreadable to the agent" is
 * not a policy a repo gets to declare.
 */
export function workspaceUnreadablePatterns(): readonly string[] {
  return unreadablePatterns();
}
