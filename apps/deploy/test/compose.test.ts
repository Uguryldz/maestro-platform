import { createJiraCloudWorkPort } from "@maestro/adapter-jira";
import { MaestroPublishPort } from "@maestro/publish";
import { createPgBlobStorage, ObjectLockNotConfiguredError } from "@maestro/storage";
import { describe, expect, it } from "vitest";
import { bootPlatform } from "../src/boot.js";
import { assertAllPortsPresent, CompositionError, describeWiring, workerSelection } from "../src/compose.js";
import { adoConfig, storageConfig } from "../src/driver-config.js";
import { loadDeployEnv, vaultMounts } from "../src/env.js";
import { ALL_PORT_KEYS, driversFor, WORKER_PORT_KEYS } from "../src/profile.js";
import { buildSecretPort } from "../src/secrets.js";
import { docAttacherFor } from "../src/stores/doc-attacher.js";
import { statusMoverFor } from "../src/stores/status-mover.js";
import { isNotConfigured } from "../src/stores/unavailable-ports.js";
import { DEV_ENV, envWithout, OFFLINE_SQL, PROD_ENV } from "./fixtures.js";

/**
 * These tests boot the REAL composition root against the REAL driver packages.
 * Nothing is stubbed except the two collaborators a process must own (the SQL
 * executor and, in the prod profile, the S3 key material): if a driver's config
 * schema changes under us, these fail — which is the entire point of wiring
 * tests that do not use fakes.
 */

async function boot(source: Record<string, string | undefined>) {
  return bootPlatform({ source, sql: OFFLINE_SQL, quiet: true });
}

describe("composition root: dev profile", () => {
  it("fills every port with a real driver instance", async () => {
    const { deployment } = await boot({ ...DEV_ENV });

    // Not "no error was thrown" — every port is an object with methods on it.
    for (const key of ALL_PORT_KEYS) {
      const port =
        key === "ci"
          ? deployment.ci
          : (deployment.ports as unknown as Record<string, unknown>)[
              key === "secret" ? "secrets" : key
            ];
      expect(port, `port ${key}`).toBeTypeOf("object");
      expect(port, `port ${key}`).not.toBeNull();
    }
  });

  it("exposes the port→driver table the dev profile promises", async () => {
    const { deployment } = await boot({ ...DEV_ENV });
    const table = Object.fromEntries(
      describeWiring(deployment.selection).map(({ port, driver }) => [port, driver]),
    );

    expect(table).toEqual({
      work: "jira-dc",
      // The REAL GitHub driver, on a stack nobody has given a GitHub token to.
      // That is the whole point of the Dalga E change: the engineering ports
      // compose everywhere, so no deployment can decide the product may not
      // write code. `ci`/`scan` stay honestly unconfigured until set up.
      scm: "github",
      ci: "not-configured",
      llm: "gateway",
      scan: "not-configured",
      storage: "pg-blob",
      secret: "env-file",
      notify: "jira",
      // `multi`, not `jira`: the analysis deliverable is a Word/PDF as well as
      // a comment (M103r), and a port composed for the `jira` target alone
      // answered the delivery step's request for a file with
      // `CapabilityNotSupportedError`. See `publishConfig`.
      publish: "multi",
    });
  });

  /**
   * M103r. The analysis Word/PDF only exist if the publish port was COMPOSED
   * to serve them — `MaestroPublishPort` refuses a target it has no publisher
   * for, so a port built for `jira` alone makes the delivery step's document
   * request fail at run time, on a ticket, every time.
   *
   * This asserts against the real port built by the real registry, so a
   * missing storage sink (which `registerPublishDrivers` refuses at
   * composition) fails here rather than in front of an analyst.
   */
  it("composes a publish port that can actually serve docx and pdf (M103r)", async () => {
    const { deployment } = await boot({ ...DEV_ENV });
    // The concrete port, not the `PublishPort` interface: `targets()` is what
    // says which publishers were actually BUILT, which is the fact under test.
    const publish = deployment.ports.publish;
    expect(publish).toBeInstanceOf(MaestroPublishPort);
    expect((publish as MaestroPublishPort).targets()).toEqual(
      expect.arrayContaining(["jira", "docx", "pdf"]),
    );
  });

  /**
   * M56/M57, and the reason a finished analysis attached NOTHING to a live
   * ticket (OPS-42, OPS-49): the composed storage port had no `objectLock`
   * configuration, the `docx` target asks for a locked put, and the driver
   * refused it rather than storing an unprotected record. The refusal was
   * correct; the missing configuration was the defect.
   *
   * Asserted against the REAL driver over a recording executor, so it proves
   * the row is written WITH retention — not merely that a config key exists.
   */
  it("composes a storage port that can actually honour a locked put (M56/M57)", async () => {
    const writes: { sql: string; params: readonly unknown[] }[] = [];
    const recordingSql = {
      query: (sql: string, params: readonly unknown[] = []) => {
        if (sql.startsWith("INSERT")) writes.push({ sql, params });
        return Promise.resolve([]);
      },
    };
    const { deployment } = await bootPlatform({
      source: { ...DEV_ENV },
      sql: recordingSql,
      quiet: true,
    });

    const before = Date.now();
    await deployment.ports.storage.put("evidence/OPS-49/analiz.docx", new Uint8Array([1, 2, 3]), {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      objectLock: true,
    });

    // The put reached the table AND carried retention: `object_lock` true and a
    // `retain_until` ten years out. Before the fix this call threw instead.
    expect(writes).toHaveLength(1);
    const params = writes[0]?.params ?? [];
    expect(params[4], "object_lock column").toBe(true);
    const retainUntil = new Date(String(params[5])).getTime();
    const expected = new Date(before).setUTCFullYear(new Date(before).getUTCFullYear() + 10);
    // Same calendar day; the clock advances a few ms between the two readings.
    expect(Math.abs(retainUntil - expected)).toBeLessThan(60_000);
  });

  /**
   * The other half, and the one that must NOT be "fixed": a driver built with
   * no retention configuration still REFUSES a locked put. If this ever starts
   * passing silently, the platform has begun writing records it tells the
   * evidence package are WORM-protected while they are deletable.
   */
  it("still refuses a locked put when objectLock is unconfigured (M57 fail-closed)", async () => {
    const unconfigured = createPgBlobStorage(
      { table: "storage_blob" },
      { sql: OFFLINE_SQL as never },
    );

    await expect(
      unconfigured.put("evidence/OPS-49/analiz.docx", new Uint8Array([1]), { objectLock: true }),
    ).rejects.toThrow(ObjectLockNotConfiguredError);

    // An UNLOCKED put through the same driver still works — the refusal is
    // scoped to the request that asked for protection, not a dead driver.
    await expect(
      unconfigured.put("scratch/note.txt", new Uint8Array([1])),
    ).resolves.toBeUndefined();
  });

  /**
   * The prod profile signs with S3's own Object Lock rather than emulating it,
   * so the config must carry the same retention the pg-blob driver applies —
   * a deployment that locks for ten years in dev and not at all in prod is the
   * exact "works in dev, silently broken in prod" failure this asserts against.
   */
  it("configures the same retention on the prod s3-compat driver (M56/M57)", () => {
    const env = loadDeployEnv({ ...PROD_ENV });
    const config = storageConfig(env, "prod", {
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "secret",
    });

    expect(config["objectLock"]).toEqual({ mode: "COMPLIANCE", years: 10 });
  });

  /**
   * M103r/M44. The core declares the SHAPE (`DocAttacher`); this is where it
   * is matched to a driver. Asserted against the REAL drivers rather than
   * stubs, because the whole risk is that the concrete Cloud port stops
   * carrying `addAttachment` and the seam silently becomes `undefined` — which
   * would read, on a live ticket, as "this deployment cannot attach files".
   */
  it("gives the worker a doc attacher only when the work driver can carry a file", async () => {
    // Data Center: no attachment endpoint on the driver, so no seam. The
    // documents are still generated and stored; the journal says they did not
    // reach the ticket, which is honest rather than a stub that throws.
    const dc = await boot({ ...DEV_ENV });
    expect(driversFor("dev").work).toBe("jira-dc");
    expect(docAttacherFor(dc.deployment.ports.work)).toBeUndefined();

    // Cloud — what a site running Jira Cloud selects with `WORK_DRIVER`:
    // `addAttachment` exists, so the seam is wired and the analysis Word/PDF
    // land on the ticket.
    const cloud = createJiraCloudWorkPort({
      baseUrl: "https://jira.invalid",
      email: "maestro-bot@bank.invalid",
      apiTokenRef: "kv/jira#token",
      deps: { secrets: buildSecretPort(loadDeployEnv(DEV_ENV)) },
    });
    const attacher = docAttacherFor(cloud);
    expect(attacher).toBeDefined();
    expect(typeof attacher?.addAttachment).toBe("function");
  });

  /**
   * The listening rule's status map, wired the same way and at the same risk:
   * if the concrete Cloud port stops carrying `transitionToStatus`, the seam
   * silently becomes `undefined` and every mapped run degrades to comment-only
   * mode — the exact behaviour operators configured the map to get away from.
   */
  it("gives the worker a status mover only when the work driver can transition", async () => {
    // Data Center: no transition-by-name capability, so no seam. M102 — the
    // driver has no workflow permissions there, and progress is a label.
    const dc = await boot({ ...DEV_ENV });
    expect(statusMoverFor(dc.deployment.ports.work)).toBeUndefined();

    const cloud = createJiraCloudWorkPort({
      baseUrl: "https://jira.invalid",
      email: "maestro-bot@bank.invalid",
      apiTokenRef: "kv/jira#token",
      deps: { secrets: buildSecretPort(loadDeployEnv(DEV_ENV)) },
    });
    const mover = statusMoverFor(cloud);
    expect(mover).toBeDefined();
    expect(typeof mover?.move).toBe("function");
  });

  it("resolves ports that actually carry their interface's methods", async () => {
    const { deployment } = await boot({ ...DEV_ENV });

    // A registered factory could return an object with nothing on it and
    // `assertAllPortsPresent` would pass it. These are the methods the
    // workflow activities call, checked against the live instances.
    expect(deployment.ports.work.verifyWebhook).toBeTypeOf("function");
    expect(deployment.ports.work.addComment).toBeTypeOf("function");
    expect(deployment.ports.secrets.get).toBeTypeOf("function");
    expect(deployment.ports.secrets.issueShortLived).toBeTypeOf("function");
    expect(deployment.ports.storage.put).toBeTypeOf("function");
    expect(deployment.ports.storage.presign).toBeTypeOf("function");
    expect(deployment.ports.llm.generateObject).toBeTypeOf("function");
    expect(deployment.ports.llm.agentSession).toBeTypeOf("function");
    expect(deployment.ports.notify.send).toBeTypeOf("function");
    expect(deployment.ports.scm.openPr).toBeTypeOf("function");
    expect(deployment.ports.scm.getPushCredential).toBeTypeOf("function");
    expect(deployment.ports.publish.publish).toBeTypeOf("function");
    expect(deployment.ci.parseBuildEvent).toBeTypeOf("function");
  });

  /**
   * The behaviour the whole Dalga E change is for.
   *
   * The old `analiz` profile wired `scm` to a stub whose every method rejected.
   * A run configured for `gelistirme` therefore did intake, wrote the analysis,
   * published it, waited for a human to approve it — and only then reached
   * `deps.scm.resolveRepo` and died, because of a string in a `.env` file.
   *
   * What is asserted here is that no such stub is reachable any more. The port
   * an engineering run calls is the REAL GitHub driver on a stack that has been
   * given no GitHub credential at all: it composes, it carries its methods, and
   * whatever it does next is a question about a connection, not about how the
   * server was installed.
   */
  it("gives an engineering run a real scm port, on a stack with no GitHub credential", async () => {
    // DEV_ENV names no GITHUB_* variable and no github token — the exact state
    // of an install whose operator has not opened the connections screen yet.
    expect(DEV_ENV["GITHUB_API_BASE_URL"]).toBeUndefined();
    const { deployment } = await boot({ ...DEV_ENV });

    expect(deployment.selection.scm.driver).toBe("github");
    // Not a stub: the methods the engineering turn actually calls are here, and
    // calling one is a network question rather than an instant refusal.
    for (const method of ["resolveRepo", "createBranch", "openPr", "mergePr"] as const) {
      expect(deployment.ports.scm[method], `scm.${method}`).toBeTypeOf("function");
    }
  });

  /**
   * The other half of the same honesty: what is genuinely unconfigured must say
   * so in a way a CALLER can act on, not as an unhandled refusal.
   *
   * `ci` has no allow-list on a fresh install (M12 refuses to read an empty one
   * as "allow all"), so it cannot answer. It rejects — but with a marked,
   * catchable state naming what is missing, which is what lets a screen tell an
   * operator "build verification is not set up" instead of rendering a stack
   * trace or, worse, reading the silence as a passing gate.
   */
  it("surfaces an unconfigured ci as a named, catchable state", async () => {
    const { deployment } = await boot({ ...DEV_ENV });
    expect(deployment.selection.ci.driver).toBe("not-configured");

    const error = await deployment.ci
      .parseBuildEvent({} as never)
      .then(() => null)
      .catch((cause: unknown) => cause);

    // Catchable BY THE STATE, not by string-matching a sentence that will be
    // reworded: this is what a caller branches on.
    expect(isNotConfigured(error)).toBe(true);
    // And the sentence names the fix, in the operator's own terms.
    expect((error as Error).message).toMatch(/yapılandırılmadı/);
  });

  it("never lets an unscanned repository read as 'no findings'", async () => {
    const { deployment } = await boot({ ...DEV_ENV });

    // The one refusal that must NEVER become a permissive default: a scan port
    // that resolved empty would let a gate blocking on findings pass on a
    // repository nobody scanned (M27).
    const error = await deployment.ports.scan
      .run("trivy" as never, {} as never)
      .then(() => null)
      .catch((cause: unknown) => cause);

    expect(isNotConfigured(error)).toBe(true);
  });

  it("hands the worker exactly the eight ports it knows, without ci", async () => {
    const { deployment } = await boot({ ...DEV_ENV });
    const selection = workerSelection(deployment.selection);

    expect(Object.keys(selection).sort()).toEqual([...WORKER_PORT_KEYS].sort());
    expect(selection).not.toHaveProperty("ci");
  });
});

describe("composition root: prod profile", () => {
  it("names the bank drivers, not the dev ones", () => {
    const env = loadDeployEnv({ ...PROD_ENV });
    const table = Object.fromEntries(
      ALL_PORT_KEYS.map((port) => [port, driversFor(env.profile)[port]]),
    );

    expect(table["secret"]).toBe("vault");
    expect(table["storage"]).toBe("s3-compat");
    expect(table["notify"]).toBe("multi");
    expect(table["publish"]).toBe("multi");
  });

  it("builds a real Vault secret port from the AppRole", () => {
    const env = loadDeployEnv({ ...PROD_ENV });
    const secrets = buildSecretPort(env);

    expect(secrets.get).toBeTypeOf("function");
    expect(secrets.issueShortLived).toBeTypeOf("function");
  });

  it("refuses to build the s3-compat storage port without key material", () => {
    const env = loadDeployEnv({ ...PROD_ENV });
    // The prod storage driver signs requests with the key itself, so composing
    // it without one must fail rather than produce a port that 403s later.
    expect(() => storageConfig(env, "prod")).toThrow(/credential/i);
  });

  it("keeps the git mount in the allow-list so push credentials can be issued", () => {
    const env = loadDeployEnv({ ...PROD_ENV });
    // A mount list without `git` composes fine and then denies every push at
    // the first engineering turn (M31) — the driver rejects it at build time.
    expect(vaultMounts(env)).toContain("git");
  });
});

/**
 * Which Jira this install talks to, derived from what it named.
 *
 * This block exists because deleting the `analiz` profile took a live site
 * down. That profile was the only one naming `jira-cloud`, so a deployment
 * whose Jira is Cloud silently fell through to the Data Center driver and died
 * at boot with "JIRA_BASE_URL: the work port has no default instance" — a
 * message that never mentions Cloud, which is the axis that was wrong. No test
 * caught it because every fixture set `JIRA_BASE_URL`.
 */
describe("composition root: Cloud or Data Center", () => {
  const cloudOnly = {
    ...envWithout(DEV_ENV, "JIRA_BASE_URL"),
    JIRA_CLOUD_BASE_URL: "https://bank.atlassian.invalid",
    MAESTRO_BOT_EMAIL: "maestro-bot@bank.invalid",
  };

  /**
   * THE REGRESSION TEST: the live deployment's exact shape.
   *
   * Jira Cloud configured, no `JIRA_BASE_URL`, and — since the profile that
   * used to carry `jira-cloud` no longer exists — no `MAESTRO_PROFILE` either.
   * This is the environment that was running in production, and the one the
   * change broke.
   */
  it("boots a Cloud-only deployment that names no profile at all", async () => {
    const { deployment } = await boot(envWithout(cloudOnly, "MAESTRO_PROFILE"));
    expect(deployment.selection.work.driver).toBe("jira-cloud");
    // Composed, not merely selected: the Cloud driver validates its own config,
    // so a wrong address or a missing e-mail would have thrown by here.
    expect(deployment.ports.work.addComment).toBeTypeOf("function");
  });

  it("composes the Data Center driver when only JIRA_BASE_URL is named", async () => {
    const { deployment } = await boot({ ...DEV_ENV });
    expect(deployment.selection.work.driver).toBe("jira-dc");
  });

  /**
   * Both set is a conflict only the operator can settle. Guessing one would
   * point a bank's tickets at whichever Jira the tie-break happened to favour —
   * and the operator who set both did so believing one was inert, which is
   * exactly the belief that makes a silent winner dangerous.
   */
  it("refuses by name when both Jira addresses are set", async () => {
    await expect(
      boot({ ...DEV_ENV, JIRA_CLOUD_BASE_URL: "https://bank.atlassian.invalid" }),
    ).rejects.toThrow(/JIRA_BASE_URL ve JIRA_CLOUD_BASE_URL/);
  });

  /**
   * A fresh install must BOOT. The wizard is how a Jira gets configured, so a
   * process that refuses to start without one can never be configured through
   * its own panel — the gap has to surface at first USE instead.
   */
  it("boots with no Jira at all, and refuses on first use rather than at startup", async () => {
    const { deployment } = await boot(envWithout(DEV_ENV, "JIRA_BASE_URL"));
    expect(deployment.selection.work.driver).toBe("not-configured");

    const error = await deployment.ports.work
      .getTicket("OPS-1" as never)
      .then(() => null)
      .catch((cause: unknown) => cause);

    expect(isNotConfigured(error)).toBe(true);
    // The message names the axis the old failure never mentioned.
    expect((error as Error).message).toMatch(/JIRA_CLOUD_BASE_URL/);
  });

  /**
   * `boot.ts` builds one work port for `notify`/`publish` to post through, and
   * `buildPortSelection` builds another for the activities. While the profile
   * owned the answer and `WORK_DRIVER` overrode it, only the first honoured the
   * override — one environment could produce two differently-authenticated Jira
   * clients. Both now read the same function over the same variables.
   */
  it("gives the notifier and the activities the same Jira driver", async () => {
    const { deployment } = await boot(cloudOnly);
    expect(deployment.selection.work.driver).toBe("jira-cloud");
    expect(deployment.ports.work).toBeTypeOf("object");
  });

  it("ignores a stale WORK_DRIVER rather than letting it override the address", async () => {
    // The bank compose used to pass `${WORK_DRIVER:-jira-dc}`, so this variable
    // was set on EVERY bundle install and masked the profile. A leftover value
    // must not be able to point a Cloud site at the Data Center driver.
    const { deployment } = await boot({ ...cloudOnly, WORK_DRIVER: "jira-dc" });
    expect(deployment.selection.work.driver).toBe("jira-cloud");
  });
});

describe("composition root: fail-closed", () => {
  it.each([
    ["DATABASE_URL", "production"],
    ["TEMPORAL_ADDRESS", "production"],
  ])("refuses to boot in production without %s", async (missing) => {
    await expect(
      boot({ ...envWithout(DEV_ENV, missing), NODE_ENV: "production", MAESTRO_PROFILE: "prod" }),
    ).rejects.toThrow(missing);
  });

  /**
   * The Azure DevOps guards, asserted against `adoConfig` rather than through a
   * boot.
   *
   * No profile selects `ado` any more — `scm` is GitHub and `ci` is
   * not-configured until an operator sets one up — so booting can no longer
   * reach this config, and a test that booted would now pass for the wrong
   * reason: it would prove ADO was never built, not that a half-configured ADO
   * is refused. The M12 rule these pin is about the CONFIG, and it still holds
   * for the deployment that selects the driver.
   */
  it("refuses when the ADO organisation is unset", () => {
    expect(() => adoConfig(loadDeployEnv(envWithout(DEV_ENV, "ADO_ORG")))).toThrow(/ADO_ORG/);
  });

  it("refuses when the CI allow-list is empty rather than allowing every pipeline", () => {
    expect(() =>
      adoConfig(loadDeployEnv(envWithout(DEV_ENV, "ADO_PR_VALIDATION_BUILDS"))),
    ).toThrow(/ADO_PR_VALIDATION_BUILDS/);
  });

  it("refuses a malformed CI allow-list entry instead of skipping it", () => {
    expect(() =>
      adoConfig(loadDeployEnv({ ...DEV_ENV, ADO_PR_VALIDATION_BUILDS: "core-api:not-a-number" })),
    ).toThrow(/repo:definitionId/);
  });

  it("BOOTS when no LLM endpoint is named, because the panel is how one is added", async () => {
    /**
     * THIS ASSERTION IS INVERTED ON PURPOSE (M107). It used to demand that a
     * stack without `LLM_BASE_URL` refuse to start, and that demand was the
     * wall: the endpoint is now something an admin types into "Ayarlar &
     * bağlantılar", and a process that will not start until a model is
     * configured can never be configured through its own panel. Same reasoning
     * that gave the `work` port a not-configured driver rather than a boot
     * refusal — and the gap is not swallowed, it is reported by name at first
     * USE (`ModelNotConfiguredError`, pinned in the gateway's own suite).
     */
    const { deployment } = await boot(envWithout(DEV_ENV, "LLM_BASE_URL"));
    expect(deployment.ports.llm).toBeTypeOf("object");
  });

  it("names the port that failed to build", async () => {
    // A bad Jira base URL must not surface as a bare "invalid url".
    await expect(boot({ ...DEV_ENV, JIRA_BASE_URL: "not-a-url" })).rejects.toThrow(/JIRA_BASE_URL/);
  });

  it("refuses the dev profile under NODE_ENV=production", async () => {
    await expect(boot({ ...DEV_ENV, NODE_ENV: "production" })).rejects.toThrow(/dev/);
  });

  it("refuses an unknown profile, naming the ones that exist", async () => {
    await expect(boot({ ...DEV_ENV, MAESTRO_PROFILE: "staging" })).rejects.toThrow(/prod, dev/);
  });

  it("refuses the prod profile without a Vault AppRole", async () => {
    await expect(
      boot({ ...DEV_ENV, MAESTRO_PROFILE: "prod", NODE_ENV: "development" }),
    ).rejects.toThrow(/VAULT_ROLE_ID/);
  });
});

describe("assertAllPortsPresent", () => {
  it("rejects a bundle whose port resolved to nothing", () => {
    const bundle = Object.fromEntries(
      WORKER_PORT_KEYS.map((key) => [key === "secret" ? "secrets" : key, {}]),
    ) as never;
    expect(() => assertAllPortsPresent({ ...(bundle as object), storage: undefined } as never, {} as never))
      .toThrow(CompositionError);
  });

  it("accepts a bundle where every port is an object", () => {
    const bundle = Object.fromEntries(
      WORKER_PORT_KEYS.map((key) => [key === "secret" ? "secrets" : key, {}]),
    ) as never;
    expect(() => assertAllPortsPresent(bundle, {} as never)).not.toThrow();
  });
});
