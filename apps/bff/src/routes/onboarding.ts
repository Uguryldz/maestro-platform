import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { humanBehind } from "@maestro/audit";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { BindingWrite, ResolvedDeps } from "../deps.js";
import { badRequest, conflict, notFound } from "../errors.js";
import {
  assertBindable,
  assertProjectBindable,
  bucketize,
  DEFAULT_DRY_RUN_SAMPLE,
  MAX_DRY_RUN_SAMPLE,
} from "../onboarding-service.js";
import { assertWritable, FOUR_EYES_GROUP } from "../platform/propose.js";
import { isMasterApprover } from "../platform/master-approver.js";
import { seedProjectDefaults } from "../listening-seed.js";
import { listScmRepos } from "../scm-repos-service.js";
import { listJiraProjects } from "../jira-projects-service.js";
import { listJiraMatchValues } from "../jira-match-values-service.js";
import type { ConnectionStore } from "../connection-store.js";
import { engineIdentityWarning } from "../connection-service.js";
import type { SecretPort } from "@maestro/ports";
import { pageOf } from "./paging.js";
import { unwired } from "./unwired.js";

/**
 * Self-service onboarding (M93/M102): connecting a Jira project to a
 * repository — or, for an analysis-only team, to no repository at all (the
 * draft then omits the repo pair and the binding carries `appId: null`; only
 * the `analiz` flow can start on it).
 *
 * Reading the options is open to the roles that could act on them; both writes
 * are admin/tech-lead, and neither of them CONFIGURES anything. The wizard's
 * last step files a proposal for a second human to approve, because a binding
 * decides where an agent will be allowed to push code — the same reason a
 * guarded parameter takes four eyes (M32/M71/M78). That reasoning covers the
 * repo-less binding too: the second human is confirming precisely that NO
 * repository is in scope.
 */
export const ONBOARDING_ROLES = ["admin", "tech-lead"] as const;

/** Where an onboarding proposal waits for its second approver. */
export const ONBOARDING_PROPOSAL_PREFIX = "onboarding.binding";

/**
 * The wizard's draft, validated as a closed shape.
 *
 * Every enum is the screen's own union (`OnboardingDraft` in
 * `screens/onboard/OnboardingSteps.tsx`) and none of them has a default here:
 * the SCREEN picks the safe defaults, and a server that silently supplied its
 * own would file a proposal for settings nobody chose. `.strict()` refuses an
 * unknown field rather than dropping it, so a client sending `mergeMode: auto`
 * under a misspelled key is told, not quietly given a human merge.
 */
const DraftBody = z
  .object({
    jiraProject: z.string().trim().min(1).max(32),
    /**
     * The repository — OPTIONAL since analysis-only bindings, and optional
     * TOGETHER with `platform` (the `.superRefine` below): a repo without a
     * build profile cannot be registered, and a platform without a repo
     * describes nothing. A draft that omits both proposes a binding with no
     * application; intake then accepts only the `analiz` flow on it and still
     * refuses every code-writing flow with `no_application`, so the omission
     * cannot widen what an agent may touch.
     */
    adoRepo: z.string().trim().min(1).max(128).optional(),
    platform: z.string().trim().min(1).max(32).optional(),
    triggerMode: z.enum(["opt_in", "automatic"]),
    gateSet: z.enum(["risk_tiered", "always_six"]),
    mergeMode: z.enum(["human", "auto"]),
    /**
     * The binding's data class (M18). OPTIONAL, and its absence still means
     * `gizli` — an older client that does not send the field must keep getting
     * the fail-closed answer it has always got, since a missing field is not
     * evidence that the tickets are safe to send to a cloud model.
     *
     * A client that DOES send it is answering a question a human was asked, and
     * that answer is the one that binds. This is the field whose absence cost
     * SAM1 an analysis: the wizard never asked, every binding came out `gizli`,
     * and `packages/llm-gateway/src/policy.ts` then correctly refused to send
     * the content to a cloud model — leaving the operator with "modeli
     * kullanamadım, elle tamamlayın" and no way to learn why.
     */
    dataClass: z.enum(["acik", "dahili", "gizli"]).optional(),
  })
  .strict()
  .superRefine((draft, ctx) => {
    // Both halves of the repository, or neither. A repo with no platform would
    // register an app that cannot be built; a platform with no repo is a value
    // with nothing to describe — either way the client dropped a field, and
    // that is a 400 to report, not a shape to guess a meaning for.
    if ((draft.adoRepo === undefined) !== (draft.platform === undefined)) {
      ctx.addIssue({ code: "custom", message: "adoRepo and platform must be sent together" });
    }
  });

/**
 * The field-level violations behind an `invalid_onboarding_body`, in the BFF's
 * existing error-detail idiom (`details.issues`, the `"path: message"` strings
 * settings.ts and the notify service already answer with). The bare code told
 * an operator THAT the draft was refused but never WHICH field — a wizard with
 * eight fields and a strict schema left them diffing their payload against the
 * source. Schema violations name fields, never values, so nothing secret can
 * ride along.
 */
function bodyIssues(error: z.ZodError): { issues: string[] } {
  return {
    issues: error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
}

/** The `?connectionId=` shared by the live SCM-repo and Jira-project listings. */
const ConnectionIdQuery = z.object({ connectionId: z.string().trim().min(1).max(64) });
const MatchValuesQuery = z.object({
  connectionId: z.string().trim().min(1).max(64),
  project: z.string().trim().min(1).max(64),
  kind: z.enum(["status", "issuetype"]),
});

/** Approve/reject an onboarding package by the project it binds. */
const ApproveBody = z.object({ projectKey: z.string().trim().min(1).max(32) }).strict();
const RejectBody = z
  .object({
    projectKey: z.string().trim().min(1).max(32),
    reason: z.string().trim().max(256).optional(),
  })
  .strict();

/**
 * Split a repo's full name (`owner/repo`) into the two registry columns.
 *
 * The wizard sends the exact string it picked from the live SCM list, so the
 * appId is that string verbatim and the two halves are what the SCM/`.docx`
 * adapters read (owner → `adoProject`, repo → `adoRepo`; M100). A name with no
 * slash, or an empty half, is not a repository this platform can bind, so it is
 * refused by name rather than written as a row with a blank column.
 */
function splitRepoFullName(
  fullName: string,
): { adoProject: string; adoRepo: string } | null {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash === fullName.length - 1) return null;
  const adoProject = fullName.slice(0, slash);
  const adoRepo = fullName.slice(slash + 1);
  // A second slash would make `adoRepo` itself contain one; GitHub repo names
  // never do, so this is a malformed pick rather than a nested path.
  if (adoRepo.includes("/")) return null;
  return { adoProject, adoRepo };
}

/**
 * The onboarding draft's two-valued choices, mapped to the binding columns.
 *
 * `triggerMode automatic` → `auto` (every ticket starts a run); `opt_in` → `label`
 * (wait for the maestro label / a command, M48a). `mergeMode auto` → `full_auto`;
 * `human` → `human_lead` (a person owns the merge).
 *
 * `dataClass` is the proposer's ANSWER when the draft carried one, and `gizli`
 * when it did not. That order matters: the fallback is still the fail-closed
 * one — guessing low is the guess that leaks — but a fallback is not the same
 * thing as an assumption, and this used to be an assumption. Every binding the
 * wizard filed came out `gizli`, which on an install with no on-prem model
 * means the analysis silently cannot run (M18, no exceptions). The wizard now
 * asks the question with the consequence spelled out, and an answered question
 * beats a default that nobody could see.
 */
function bindingFromProposal(value: OnboardingProposalValue): BindingWrite {
  return {
    projectKey: value.jiraProject,
    trigger: value.triggerMode === "automatic" ? "auto" : "label",
    state: "active",
    defaults: {
      appId: value.appId,
      mode: value.mergeMode === "auto" ? "full_auto" : "human_lead",
      dataClass: value.dataClass ?? "gizli",
    },
  };
}

/** The shape stored in an `onboarding.binding` pending value (submit writes it). */
interface OnboardingProposalValue {
  jiraProject: string;
  /**
   * Absent — together with `platform` — on an analysis-only proposal: the
   * wizard bound no repository, and `appId` below is then `null`. Older
   * proposals always carry both.
   */
  adoRepo?: string;
  platform?: string;
  triggerMode: "opt_in" | "automatic";
  gateSet: "risk_tiered" | "always_six";
  mergeMode: "human" | "auto";
  /**
   * Absent on proposals filed before the wizard asked, and on any client that
   * does not send it. `bindingFromProposal` reads that absence as `gizli`, so a
   * proposal filed yesterday approves today into exactly the binding it always
   * would have — the field is additive, not a re-interpretation of the queue.
   */
  dataClass?: "acik" | "dahili" | "gizli";
  /**
   * `null` for an analysis-only proposal. `bindingFromProposal` writes it into
   * `defaults.appId` verbatim, which is the null `parseDefaults` already reads
   * back — the binding then starts `analiz` runs in ticket-text mode and
   * intake refuses everything that writes code.
   */
  appId: string | null;
}

/**
 * The connector store, or 503-by-name when a deployment did not wire it — the
 * SCM-picker endpoints cannot list repos without the connections that hold the
 * credential, and an empty list would read as "no repos" rather than "connectors
 * are not editable here" (the `connections` unwired convention).
 */
function connectorStore(deps: ResolvedDeps): ConnectionStore {
  if (deps.connections === undefined) unwired("connections");
  return deps.connections;
}

function connectorSecrets(deps: ResolvedDeps): SecretPort {
  if (deps.connectorSecrets === undefined) unwired("connections");
  return deps.connectorSecrets;
}

/**
 * The dry run needs only the routing half of the draft; the screen sends
 * exactly that.
 *
 * `adoRepo` is OPTIONAL, and that is the whole point of the rehearsal: it
 * replays a PROJECT's recent tickets against the routing rules and never
 * touches a repository — it only echoes the name back as the appId. Requiring
 * it meant an analysis-only operator, who has no repository and needs none,
 * could not run the rehearsal the wizard makes mandatory, and so could never
 * finish onboarding.
 */
const DryRunBody = z
  .object({
    jiraProject: z.string().trim().min(1).max(32),
    adoRepo: z.string().trim().max(128).optional(),
    sampleSize: z.coerce.number().int().positive().max(MAX_DRY_RUN_SAMPLE).optional(),
  })
  .strict();

/** What the screen renders; `DryRunResult` in `screens/common/onboarding-api.ts`. */
const DryRunResponse = z.object({
  byRule: z.array(z.string()),
  bySuggestion: z.array(z.string()),
  unresolved: z.array(z.string()),
  sampled: z.number().int().nonnegative(),
  projectKey: z.string(),
  appId: z.string(),
});

/** `OnboardingOptions` — three flat string lists, exactly as the selects expect. */
const OptionsResponse = z.object({
  jiraProjects: z.array(z.string()),
  adoRepos: z.array(z.string()),
  platforms: z.array(z.string()),
});

const ProposalResponse = z.object({
  proposalId: z.string(),
  status: z.literal("pending_four_eyes"),
  approverGroup: z.string(),
});

export async function onboardingRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const preHandler = [authGuard(deps), requireAnyRole(...ONBOARDING_ROLES)];

  /**
   * The lists the wizard's selects are built from (M93).
   *
   * Bound projects are included, carrying nothing but their key here — the
   * conflict is reported by the dry run and the submit path, which can say
   * WHICH state is in the way. Omitting them would make an already-bound
   * project simply missing from the list, with no way for the operator to find
   * out why the project they came to connect is not there.
   */
  app.get("/onboarding/options", { preHandler }, async (request, reply) => {
    const options = await deps.read.onboarding.options(pageOf(request.query));
    const body = OptionsResponse.parse({
      jiraProjects: options.projects.map((project) => project.projectKey),
      adoRepos: options.repos.map((repo) => repo.appId),
      platforms: [...options.platforms],
    });
    return reply.code(200).send(body);
  });

  /**
   * The SCM connections a repo can be picked from (github / ADO). Read straight
   * off the managed connector list (Ayarlar > Bağlantılar) so the wizard offers
   * exactly what the platform is actually wired to — never a hard-coded "ADO".
   * Only the non-secret fields are returned; the token never leaves the store.
   */
  app.get("/onboarding/scm-connections", { preHandler }, async (_request, reply) => {
    const store = connectorStore(deps);
    const all = await store.list();
    const scm = all
      .filter((c) => c.enabled && (c.kind === "github" || c.kind === "ado"))
      .map((c) => ({ id: c.id, kind: c.kind, displayName: c.displayName }));
    return reply.code(200).send({ connections: scm });
  });

  /**
   * The repositories a chosen SCM connection can reach — read LIVE off the
   * provider with the connection's STORED token (the `jira-workflow` pattern: a
   * live read behind an unwired gate). The token is fetched here and passed to
   * the service; it never appears in the request, the response or an error.
   */
  app.get("/onboarding/scm-repos", { preHandler }, async (request, reply) => {
    const store = connectorStore(deps);
    const secrets = connectorSecrets(deps);
    const parsed = ConnectionIdQuery.safeParse(request.query);
    if (!parsed.success) throw badRequest("invalid_onboarding_body", bodyIssues(parsed.error));

    const connection = await store.get(parsed.data.connectionId);
    if (connection === null) throw badRequest("unknown_connection");

    const token =
      connection.secretRef === null
        ? null
        : await secrets.get(connection.secretRef).catch(() => null);
    const result = await listScmRepos(connection, token, deps.connectorFetch);
    return reply.code(200).send(result);
  });

  /**
   * The Jira connections a project can be picked from (Cloud / Data Center),
   * read off the managed connector list — the sibling of `scm-connections`. The
   * project list is empty until a project is actually bound (the binding table
   * is what `options` reads), so an operator onboarding the FIRST project has
   * nothing to select; this lets them pick projects LIVE off Jira instead. Only
   * the non-secret fields are returned.
   */
  app.get("/onboarding/jira-connections", { preHandler }, async (_request, reply) => {
    const store = connectorStore(deps);
    const all = await store.list();
    const jira = all
      .filter((c) => c.enabled && (c.kind === "jira_cloud" || c.kind === "jira_dc"))
      // `botAccountId` (learned on connection test) lets a listening rule offer
      // "the bot" instead of a hand-copied GUID. Absent until the connection has
      // been tested once; the rule form falls back to free text then.
      .map((c) => {
        const botAccountId = c.config["botAccountId"] ?? null;
        // The value is served STILL, with a flag beside it, never blanked.
        //
        // This endpoint is what the wizard pre-fills a rule's assignee from, so
        // it is the last place a doomed id can be caught before it is written
        // into a rule that will match nothing. But it is a pure store read — no
        // token, no `/myself` — so it cannot re-derive who the connection really
        // is; all it can honestly compare is the id already learned against the
        // account the engine works as. That is enough for the case that matters,
        // because the learned id IS the connection's true owner whenever the
        // test has run at all.
        //
        // Blanking it was the alternative and is worse: the wizard would fall
        // back to a free-text box and an operator would hand-copy the very same
        // wrong GUID, with the tool now silent about it. A value plus "this
        // disagrees with the engine" lets the screen explain the problem; a
        // missing value explains nothing.
        const engineMismatch = engineIdentityWarning(
          botAccountId ?? undefined,
          deps.config.engineBotAccountId,
        );
        return {
          id: c.id,
          kind: c.kind,
          displayName: c.displayName,
          botAccountId,
          ...(engineMismatch === undefined ? {} : { engineMismatch }),
        };
      });
    return reply.code(200).send({ connections: jira });
  });

  /**
   * The projects a chosen Jira connection can reach — read LIVE off Jira with
   * the connection's STORED token (same pattern as `scm-repos`). The token is
   * fetched here and passed to the service; it never appears in the request, the
   * response or an error.
   */
  app.get("/onboarding/jira-projects", { preHandler }, async (request, reply) => {
    const store = connectorStore(deps);
    const secrets = connectorSecrets(deps);
    const parsed = ConnectionIdQuery.safeParse(request.query);
    if (!parsed.success) throw badRequest("invalid_onboarding_body", bodyIssues(parsed.error));

    const connection = await store.get(parsed.data.connectionId);
    if (connection === null) throw badRequest("unknown_connection");

    const token =
      connection.secretRef === null
        ? null
        : await secrets.get(connection.secretRef).catch(() => null);
    const result = await listJiraProjects(connection, token, deps.connectorFetch);
    return reply.code(200).send(result);
  });

  /**
   * The status / issue-type NAMES a listening rule can match on for a project —
   * read live off Jira so the rule form offers a dropdown of exactly the names
   * Jira will present, instead of free text where "hata" vs "Hata" silently
   * matches nothing. Same connection + stored-token pattern as jira-projects.
   */
  app.get("/onboarding/jira-match-values", { preHandler }, async (request, reply) => {
    const store = connectorStore(deps);
    const secrets = connectorSecrets(deps);
    const parsed = MatchValuesQuery.safeParse(request.query);
    if (!parsed.success) throw badRequest("invalid_onboarding_body", bodyIssues(parsed.error));

    const connection = await store.get(parsed.data.connectionId);
    if (connection === null) throw badRequest("unknown_connection");

    const token =
      connection.secretRef === null
        ? null
        : await secrets.get(connection.secretRef).catch(() => null);
    const result = await listJiraMatchValues(
      connection,
      parsed.data.project,
      parsed.data.kind,
      token,
      deps.connectorFetch,
    );
    return reply.code(200).send(result);
  });

  /**
   * The dry run (M102): where the last N tickets WOULD land under these rules.
   *
   * It replays REAL runs from the project's history and reads each one's
   * recorded `MatchResult`, so the three buckets are a measurement rather than
   * a preview. A project with no history returns three empty buckets and
   * `sampled: 0` — the screen can then say the run proved nothing, which is
   * true and is not the same sentence as "everything resolved cleanly".
   *
   * Not a write, and deliberately not gated on the kill switch: rehearsing a
   * binding changes nothing, and an operator working out what went wrong during
   * an incident should still be able to ask.
   *
   * It does NOT require the repo to be in the registry. The rehearsal replays a
   * PROJECT's history and is independent of which repo the operator is about to
   * bind — insisting the repo already exist would make the dry run impossible
   * for the repo picked LIVE off SCM, which is the whole point of onboarding a
   * NEW app (the same reason submit registers the repo itself). Only the project
   * is checked, and only for "already bound".
   */
  app.post("/onboarding/dry-run", { preHandler }, async (request, reply) => {
    const parsed = DryRunBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("invalid_onboarding_body", bodyIssues(parsed.error));

    await assertProjectBindable(deps, parsed.data.jiraProject);
    const limit = parsed.data.sampleSize ?? DEFAULT_DRY_RUN_SAMPLE;
    const samples = await deps.read.onboarding.recentTickets(parsed.data.jiraProject, limit);
    const buckets = bucketize(samples);

    return reply.code(200).send(
      DryRunResponse.parse({
        ...buckets,
        projectKey: parsed.data.jiraProject,
        // The repo the operator picked — echoed back as the appId. The dry run
        // rehearses the project, so this is the target it rehearsed against, not
        // a registry lookup. Empty on an analysis-only draft, which binds no
        // application at all: the routing verdicts above are the real answer.
        appId: parsed.data.adoRepo ?? "",
      }),
    );
  });

  /**
   * Submit the wizard (M93). Files a PROPOSAL; it never binds anything.
   *
   * The four-eyes channel is `ParamStore.putPending`, the same one a guarded
   * parameter and a kill-switch change wait in (M32/M71/M58) — one queue an
   * admin already watches, rather than a second approval mechanism that could
   * disagree with the first about who has confirmed what.
   *
   * A dry run is a precondition of ACTIVATION, not of proposing: the approver
   * is the one who must have seen it, and this endpoint records the draft for
   * them to judge. What it does enforce is that the target is real and free,
   * because a proposal to bind a project that is already live is not a decision
   * worth putting in front of a human.
   *
   * When an `appRegistry` writer is wired (M100), the repo is first REGISTERED
   * into the inventory — the wizard is what creates the app row, so an operator
   * no longer has to have onboarded the repo through some other path before it
   * can be bound. The binding itself stays four-eyes: registering a repo is
   * inventory, but pointing a project's tickets at it is the decision a second
   * human confirms. Without the writer the endpoint keeps its older behaviour,
   * where `assertBindable` requires the repo to already exist.
   */
  app.post("/onboarding", { preHandler }, async (request, reply) => {
    const parsed = DraftBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("invalid_onboarding_body", bodyIssues(parsed.error));

    // Nothing is filed while the platform is stopped (M58). A proposal is not
    // an effect, but it is the first half of one, and an incident is not the
    // moment to queue up new bindings for an approver to find later. The
    // registration below is a write too, so it must not happen either.
    await assertWritable(deps);

    const actor = sessionActor(sessionOf(request));
    const at = deps.clock.now().toISOString();
    const scopeRef = parsed.data.jiraProject;
    // Both repo fields, together or not at all (the schema's `.superRefine`
    // enforced the pairing). Narrowed here ONCE so the registration, the
    // platform check and the proposal all agree on whether this draft binds a
    // repository — `null` is the analysis-only draft.
    const repoHalf =
      parsed.data.adoRepo === undefined || parsed.data.platform === undefined
        ? null
        : { adoRepo: parsed.data.adoRepo, platform: parsed.data.platform };

    // Check the PROJECT before writing anything. Registering the repo and only
    // then finding the project unusable would leave a stranded app row with no
    // proposal — so an unknown or already-bound project is refused here, before
    // the inventory write below can happen.
    await assertProjectBindable(deps, scopeRef);

    // Register the repo into the inventory, when the deployment wired a writer
    // AND the draft actually names a repo — an analysis-only draft has no
    // inventory to fill. `assertBindable` then finds the row it just wrote and
    // the older `unknown_app` wall no longer stands between the wizard and a
    // repo the operator legitimately picked off the live SCM list. The binding
    // stays a proposal below — this only fills the inventory, it does not
    // route anything.
    if (deps.appRegistry !== undefined && repoHalf !== null) {
      const halves = splitRepoFullName(repoHalf.adoRepo);
      if (halves === null) throw badRequest("invalid_repo_name", { repo: repoHalf.adoRepo });
      await deps.appRegistry.register({
        appId: repoHalf.adoRepo,
        displayName: repoHalf.adoRepo,
        adoProject: halves.adoProject,
        adoRepo: halves.adoRepo,
        platform: repoHalf.platform,
      });
      // The inventory write is its own audited fact, separate from the binding
      // proposal below: one records that the app now exists, the other that a
      // human proposed pointing a project at it. `AuditAction` (frozen) has no
      // APP_REGISTERED, and PARAM_CHANGED is the closest true statement — the
      // same convention the other registry writes use.
      await deps.audit.append({
        actor,
        action: "PARAM_CHANGED",
        subject: `application:${repoHalf.adoRepo}`,
        at,
        meta: {
          registered: "application",
          appId: repoHalf.adoRepo,
          adoProject: halves.adoProject,
          adoRepo: halves.adoRepo,
          platform: repoHalf.platform,
          createdVia: "onboarding",
        },
      });
    }

    // The repo checks only exist when there IS a repo. An analysis-only draft
    // resolves to no application at all — `assertProjectBindable` above already
    // proved the project is real and free, which is everything such a draft
    // can be wrong about.
    let appId: string | null = null;
    if (repoHalf !== null) {
      const target = await assertBindable(deps, { jiraProject: scopeRef, adoRepo: repoHalf.adoRepo });
      // The selected platform must be the repo's own. A mismatch means the
      // operator changed the repo after step 2 and the wizard carried a stale
      // profile — binding on it would build the app in the wrong toolchain.
      if (repoHalf.platform !== target.platform) {
        throw conflict("platform_mismatch", {
          appId: target.appId,
          platform: target.platform,
        });
      }
      appId = target.appId;
    }

    // One open proposal per project. A second one would leave two drafts
    // waiting on the same binding with no rule about which the approver's
    // confirmation applies to.
    const pending = await deps.params.pending();
    const open = pending.find(
      (candidate) =>
        candidate.key === ONBOARDING_PROPOSAL_PREFIX && candidate.scopeRef === scopeRef,
    );
    if (open !== undefined && open.proposedBy !== actor) {
      throw conflict("proposal_open", { projectKey: scopeRef, proposedBy: open.proposedBy });
    }

    await deps.params.putPending({
      key: ONBOARDING_PROPOSAL_PREFIX,
      scopeRef,
      value: { ...parsed.data, appId },
      proposedBy: actor,
      at,
    });

    await deps.audit.append({
      actor,
      action: "PARAM_CHANGED",
      subject: `onboarding:${scopeRef}`,
      at,
      meta: {
        proposal: "onboarding_binding",
        projectKey: scopeRef,
        // The same honesty rule as intake's RUN_STARTED: a null in a SIEM row
        // reads as a lost field, while "who proposed binding OPS with no
        // repository" is a decision the trail must be able to answer.
        appId: appId ?? "yok (yalnızca analiz)",
        triggerMode: parsed.data.triggerMode,
        gateSet: parsed.data.gateSet,
        mergeMode: parsed.data.mergeMode,
        // Which data class the proposer chose, in the chain rather than only in
        // the pending value: the class decides whether this project's tickets
        // may reach a cloud model at all, so "who asked for `acik` on a bank
        // system, and when" is a question the audit trail has to be able to
        // answer months later.
        dataClass: parsed.data.dataClass ?? "gizli",
      },
    });

    return reply.code(202).send(
      ProposalResponse.parse({
        proposalId: `${ONBOARDING_PROPOSAL_PREFIX}:${scopeRef}:${at}`,
        status: "pending_four_eyes",
        approverGroup: FOUR_EYES_GROUP,
      }),
    );
  });

  /**
   * The onboarding packages waiting for a second approver (M93).
   *
   * Reads the SAME pending queue a guarded parameter waits in (`params.pending`),
   * filtered to `onboarding.binding`. Until now this queue had no reader — a
   * submitted package sat in it invisibly and nobody could approve it. This is
   * the list the "Jira bağlantısı & eşleme" screen renders so an admin can act.
   */
  app.get("/onboarding/pending", { preHandler }, async (_request, reply) => {
    const open = (await deps.params.pending()).filter(
      (candidate) => candidate.key === ONBOARDING_PROPOSAL_PREFIX,
    );
    const items = open.map((entry) => {
      const value = entry.value as OnboardingProposalValue;
      return {
        projectKey: entry.scopeRef ?? value.jiraProject,
        // Explicit nulls, not dropped keys, for an analysis-only package: the
        // approver's screen must render "depo yok — yalnızca analiz" from a
        // value it can see, and a missing field is indistinguishable from a
        // serializer bug.
        appId: value.appId ?? null,
        adoRepo: value.adoRepo ?? null,
        platform: value.platform ?? null,
        triggerMode: value.triggerMode,
        gateSet: value.gateSet,
        mergeMode: value.mergeMode,
        // Shown to the APPROVER, and resolved here rather than left absent: the
        // second human is confirming what the binding will actually be, and
        // "the field is missing" is not something they can act on. The `??`
        // mirrors `bindingFromProposal` exactly, so the queue can never display
        // a class other than the one approval would write.
        dataClass: value.dataClass ?? "gizli",
        proposedBy: entry.proposedBy,
        at: entry.at,
      };
    });
    return reply.code(200).send({ items });
  });

  /**
   * Approve an onboarding package: turn the proposal into a LIVE binding (M93).
   *
   * Four-eyes: the approver must be a DIFFERENT human from the proposer — the
   * whole point of the queue is that a second person confirms where an agent will
   * be allowed to push code. `assertProjectBindable` is re-checked at approval
   * time, not just at submit: a project bound by someone else in between must not
   * be silently re-pointed (TOCTOU). The binding write is what makes the project
   * live; the proposal is then cleared. `bindingWriter` unwired → 503-by-name.
   */
  app.post("/onboarding/approve", { preHandler }, async (request, reply) => {
    const parsed = ApproveBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("invalid_onboarding_body", bodyIssues(parsed.error));
    if (deps.bindingWriter === undefined) unwired("bindingWriter");

    await assertWritable(deps);

    const open = (await deps.params.pending()).find(
      (candidate) =>
        candidate.key === ONBOARDING_PROPOSAL_PREFIX && candidate.scopeRef === parsed.data.projectKey,
    );
    if (open === undefined) throw notFound("no_pending_binding", { projectKey: parsed.data.projectKey });

    const session = sessionOf(request);
    const actor = sessionActor(session);
    // A person cannot approve their own proposal. Compared through `humanBehind`
    // so an AI delegate acting for a person is still that person (M32/M101).
    // EXCEPTION: a master admin (maestro-admins) may approve their own package —
    // a single-admin install must not deadlock. The audit trail records it as a
    // solo approval so the exception is visible, not hidden.
    const selfApproval =
      humanBehind(actor) !== null && humanBehind(actor) === humanBehind(open.proposedBy);
    const masterSolo = selfApproval && isMasterApprover(session.groups);
    if (selfApproval && !masterSolo) {
      throw conflict("self_approval", { projectKey: parsed.data.projectKey });
    }

    // Re-check the project is still free at approval time (TOCTOU).
    await assertProjectBindable(deps, parsed.data.projectKey);

    const value = open.value as OnboardingProposalValue;
    await deps.bindingWriter.bind(bindingFromProposal(value));
    await deps.params.clearPending(ONBOARDING_PROPOSAL_PREFIX, parsed.data.projectKey);

    const at = deps.clock.now().toISOString();
    await deps.audit.append({
      actor,
      action: "PARAM_CHANGED",
      subject: `onboarding:${parsed.data.projectKey}`,
      at,
      meta: {
        approved: "onboarding_binding",
        projectKey: parsed.data.projectKey,
        appId: value.appId,
        approvedBy: actor,
        // True only when a master admin approved a package they proposed
        // themselves — the four-eyes exemption, recorded so it is auditable.
        soloApproval: masterSolo,
      },
    });

    // "Works out of the box": seed the project's default listening rules right
    // here, so a freshly bound project is listened to without anyone writing a
    // rule by hand. FAIL-SOFT by contract — the binding above is already live
    // and audited, and a seed that cannot run (no Jira connection, untested
    // connection, Jira unreachable) must never turn a successful approval into
    // an error. Failures are logged, nothing more; the admin can re-run the
    // seed later via POST /studio/listening-rules/seed-defaults.
    let listeningSeed: { created: number; skipped: number } | null = null;
    // WHY the seed did not run, when it did not. Fail-soft used to mean the
    // reason lived only in a server log line: the screen saw "bound" (green),
    // zero rules listened to any ticket, and the operator had nothing to act
    // on. The named reason travels with the response so the approval result
    // can say "tohumlanamadı: <sebep>" instead of celebrating a half-setup.
    let seedSkipped: { reason: string } | null = null;
    try {
      const seeded = await seedProjectDefaults(deps, parsed.data.projectKey);
      if (seeded.ok) {
        listeningSeed = { created: seeded.created, skipped: seeded.skipped };
      } else {
        seedSkipped = { reason: seeded.reason };
        request.log.warn(
          { projectKey: parsed.data.projectKey, reason: seeded.reason },
          "listening seed skipped after onboarding approve",
        );
      }
    } catch (error) {
      // An unexpected throw (a store write failing mid-seed) has no named
      // outcome; `seed_error` is the honest catch-all — still fail-soft, the
      // binding above stays live.
      seedSkipped = { reason: "seed_error" };
      request.log.warn(
        { projectKey: parsed.data.projectKey, err: error },
        "listening seed failed after onboarding approve",
      );
    }

    // The chain's next natural step: this project has no listening rules yet
    // (or, when the seed above ran, they were just created — `listeningSeed`
    // tells the screen which sentence is true, and `seedSkipped` carries the
    // reason when the answer is "none, and here is why").
    return reply.code(200).send({
      status: "bound",
      projectKey: parsed.data.projectKey,
      nextStep: "listening_rule",
      listeningSeed,
      ...(seedSkipped === null ? {} : { seedSkipped }),
    });
  });

  /**
   * Reject (or withdraw) an onboarding package (M93).
   *
   * Unlike approve, the PROPOSER may reject their own package — withdrawing a
   * draft you filed is legitimate. It only clears the pending entry; no binding
   * is written. The Application row the submit registered stays (it is inventory,
   * not a binding), so a later re-proposal reuses it.
   */
  app.post("/onboarding/reject", { preHandler }, async (request, reply) => {
    const parsed = RejectBody.safeParse(request.body);
    if (!parsed.success) throw badRequest("invalid_onboarding_body", bodyIssues(parsed.error));

    const open = (await deps.params.pending()).find(
      (candidate) =>
        candidate.key === ONBOARDING_PROPOSAL_PREFIX && candidate.scopeRef === parsed.data.projectKey,
    );
    if (open === undefined) throw notFound("no_pending_binding", { projectKey: parsed.data.projectKey });

    await deps.params.clearPending(ONBOARDING_PROPOSAL_PREFIX, parsed.data.projectKey);

    const actor = sessionActor(sessionOf(request));
    const at = deps.clock.now().toISOString();
    await deps.audit.append({
      actor,
      action: "PARAM_CHANGED",
      subject: `onboarding:${parsed.data.projectKey}`,
      at,
      meta: {
        rejected: "onboarding_binding",
        projectKey: parsed.data.projectKey,
        rejectedBy: actor,
        ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
      },
    });

    return reply.code(200).send({ status: "rejected", projectKey: parsed.data.projectKey });
  });
}
