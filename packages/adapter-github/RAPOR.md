# RAPOR — `@maestro/adapter-github` (Dalga C1)

A second **ScmPort** driver for Maestro, implementing the frozen
`packages/ports/src/scm.ts` interface against the real **GitHub REST API v3**
(`api.github.com`) plus one **GraphQL** mutation. It mirrors the structure and
the safety discipline of `packages/adapter-ado` and is grounded offline in
hand-authored SHAPE fixtures, exactly as `adapter-jira/src/cloud` is. It does
**not** touch pilot/bff — that wiring is C2/C4.

`packages/contracts` and `packages/ports` were treated as **read-only** (FROZEN).
No new runtime dependencies: transport is native `fetch` (Node 24); the only
other imports are `zod` and the two workspace packages, matching `adapter-ado`.

## RepoRef mapping

`RepoRef { project, repo }` maps to GitHub as **`project` = owner (login)** and
**`repo` = repository name**. `ApplicationRecord.adoProject` / `adoRepo` are
reused verbatim as owner / repo — those contract field names predate GitHub;
the semantics here are owner/repo, noted in code comments at every use site.

## ScmPort method → GitHub endpoint

| ScmPort method | GitHub call |
| --- | --- |
| `resolveRepo(app)` | `GET /repos/{owner}/{repo}` → `{project: owner.login, repo: name}` |
| `createBranch(repo, name, fromRef)` | (branch base) `GET /repos/{owner}/{repo}/git/ref/heads/{fromRef}` → base sha, then `POST /repos/{owner}/{repo}/git/refs` `{ref: "refs/heads/{name}", sha}`. A full 40-char commit id skips step 1. |
| `getPushCredential(repo, ttl)` | **No REST call** — token minted by the injected `SecretIssuer` (SecretPort), TTL-bounded (see below). |
| `openPr(draft)` | `POST /repos/{owner}/{repo}/pulls` `{title, head, base, body, draft}` → `prId = number` |
| `activatePr(repo, prId)` | `GET /repos/{owner}/{repo}/pulls/{n}` for the node id, then **GraphQL** `markPullRequestReadyForReview(input:{pullRequestId})`, verified `isDraft === false` |
| `listPrThreads(repo, prId)` | `GET /repos/{owner}/{repo}/pulls/{n}/comments?per_page=100` → grouped into `PrThread[]` |
| `replyThread(repo, prId, threadId, text)` | `POST /repos/{owner}/{repo}/pulls/{n}/comments/{threadId}/replies` `{body}` |
| `getPrStatus(repo, prId)` | `GET /repos/{owner}/{repo}/pulls/{n}` → state mapping (below) |

## Decision: draft → active (activatePr)

GitHub has **no REST route** for "ready for review". Converting a draft is only
possible through the GraphQL `markPullRequestReadyForReview` mutation, which is
keyed by the PR's **node id** (a GraphQL `ID!`), not its number. So `activatePr`:

1. does a REST `GET /pulls/{n}` to read `node_id`, then
2. runs the GraphQL mutation with that id, and
3. verifies the returned `pullRequest.isDraft` is `false` — no optimistic
   success (same "verify the effect" rule as the ADO `PATCH isDraft:false`).

The `GithubClient.graphql` helper treats a **200 with a populated `errors`
array** as a failure (`GithubResponseError`), because GitHub reports GraphQL
errors under HTTP 200 — a 2xx alone would let a "could not resolve node" slip
through as success.

## Decision: thread mapping (listPrThreads / replyThread)

GitHub returns **review comments** (line-anchored) as a **flat list**; threads
are reconstructed from `in_reply_to_id`: a comment with no `in_reply_to_id` is a
thread root, and the driver walks the chain to the root so a reply-to-a-reply
still lands in the right thread. Grouping key is the resolved **root comment
id**, which becomes `PrThread.threadId`. `replyThread` posts to the
`/comments/{root_id}/replies` route, parenting the reply to that root.

**Which GitHub conversation maps to `PrThread`:** the **review** conversation
(`/pulls/{n}/comments`), *not* the issue conversation (`/issues/{n}/comments`).
The M102/12b engineering loop must answer line-anchored review feedback; issue
comments are the PR's non-anchored chatter and are deliberately **not** mapped.
This is documented in `scm.ts` at `listPrThreads`.

**Status:** GitHub's REST comment list carries **no per-thread
resolved/unresolved flag** (that state lives only in the GraphQL
`PullRequestReviewThread.isResolved`). Rather than guess, every mapped thread is
reported **`"active"`** — an open item for the loop until answered, never a
silent `"fixed"`. If the loop later needs true resolved-state, it is a GraphQL
follow-up (a candidate for a C-series hardening pass), noted here so the choice
is explicit rather than an accident.

## Decision: getPrStatus state mapping

| GitHub | PrStatus.state | mergeSha |
| --- | --- | --- |
| `state:"open"`, `draft:true` | `draft` | `null` |
| `state:"open"` | `active` | `null` |
| `state:"closed"`, `merged:true` | `completed` | `merge_commit_sha` |
| `state:"closed"`, `merged:false` | `abandoned` | `null` |

`mergeSha` is filled **only** when `merged === true`. GitHub populates
`merge_commit_sha` on an **open** PR too (the test-merge *preview* commit) and on
a **closed-unmerged** PR (the last attempted merge) — neither commit is on the
base branch. Reporting it would tell the gate a PR merged while review is still
open (the exact K3 trap the ADO driver guards against with `lastMergeCommit`). A
merged PR with a **missing or malformed** `merge_commit_sha` is a contract
breach and throws, rather than degrading to a fake "not merged".

## Decision: getPushCredential — token & short-lived enforcement

`getPushCredential` makes **no GitHub call**; it returns whatever the injected
`SecretIssuer` mints (SecretPort), under the stable scope
`github/{owner}/{repo}/push`. The same M31 discipline as ADO is enforced on both
sides: the requested TTL may not exceed the configured ceiling (default 3600s,
hard cap 86400s), and the issued credential must actually expire **inside** the
requested window (with 60s clock skew) — an already-expired or over-long
credential is a hard failure, not a warning.

**Token vs. hardened path.** A **fine-grained PAT** has a **fixed expiry set at
creation** (up to a year, or "never"), which the runner cannot shorten per push;
fed through `getPushCredential` against a short TTL it correctly **fails** the
"outlives its ttl" check (there is a test for exactly this). The **hardened
path** is a **GitHub App installation token**: max one-hour lifetime, scoped to
the single repo, minted on demand — that is the credential this expiry check is
designed for, and what the composition root should wire as the `SecretIssuer`
before go-live. The driver holds neither value; the secrets package is never
imported (M44/M80 clean-room DI).

## Error classification

`GithubClient` maps transport failures to a typed taxonomy that mirrors the ADO
driver so the orchestrator classifies both SCM drivers identically:

- `401` / `403` → `GithubAuthError`
- `403` **with a rate-limit tell** (`retry-after`, `x-ratelimit-remaining: 0`,
  or a "secondary rate limit" body) → `GithubRateLimitError` (**retryable**) —
  GitHub hides its secondary rate limit behind a 403, so this split keeps the
  workflow from abandoning a run a short wait would clear.
- `404` → `GithubNotFoundError`
- `422` → `GithubValidationError` (branch already exists, bad base sha, …)
- `429` → `GithubRateLimitError` (retryable)
- `5xx` → `GithubHttpError` with `retryable: true`; other `4xx` → not retryable
- A 2xx whose shape fails Zod → `GithubResponseError`

Every response is Zod-validated through partial `looseObject` schemas
(unknown keys allowed, so a GitHub API addition cannot break the driver).

## Fixture nature — SHAPE, not live

**All fixtures under `test/fixtures/` are SHAPE fixtures**: hand-authored from
the documented GitHub REST v3 / GraphQL response shapes (verified against the
current GitHub API docs), **not** live recordings — there is no network access
to `github.com` in this environment, and tests **never** hit it. The
`fixture()` helper and `helpers.ts` say so in comments. The orchestrator must
**re-record these against the user's real repo** (following the
`adapter-jira/src/cloud` recording discipline) before the driver goes live.

Fixtures: `repo-get`, `ref-get-main`, `ref-create-success`, `pr-create-draft`,
`pr-get-active`, `pr-get-completed`, `pr-get-abandoned`, `pull-comments`,
`comment-reply-created`, `graphql-mark-ready`.

## Tests

**59 tests, all green**, across 6 files, every one offline against fixtures /
the fake transport:

- `config.test.ts` (8) — cloud defaults, enterprise roots, api-version override, https/scheme guard, ttl ceiling.
- `client.test.ts` (13) — URL building (cloud + GHES), Bearer + api-version header, per-request token, full error classification incl. the 403 rate-limit split and 5xx-retryable, GraphQL routing + errors-array.
- `scm.test.ts` (18) — resolveRepo, createBranch (single-call full-sha **and** two-step base-name→sha), openPr (bare branches, refs/heads stripping), activatePr (node-id fetch → GraphQL, still-draft guard, GraphQL error), getPrStatus **all four** state mappings incl. merged→mergeSha and the malformed/missing merge-sha guards.
- `scm-threads.test.ts` (6) — flat-list grouping by root id, all-active status, author/body/time mapping in order, off-page-parent reply, reply route, schema rejection.
- `scm-credential.test.ts` (9) — scope, no REST call, ttl bounds, ceiling, already-expired / outlives-ttl (the PAT trap), clock skew.
- `register.test.ts` (5) — registers under `scm`, config validation, Bearer wiring, ttl-ceiling wiring, duplicate-registration guard.

Gate: `pnpm -F @maestro/adapter-github typecheck && test` green; `eslint
packages/adapter-github/ --max-warnings 0` clean.
