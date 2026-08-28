import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  bankaComposePath,
  bankaEnvExamplePath,
  bankaInstallPath,
  bankaReadmePath,
  migrationsDir,
} from "./paths.js";

/**
 * The bank bundle (`deploy/banka/`), checked as data.
 *
 * This is a DIFFERENT artefact from `deploy/compose.yaml` and needs its own
 * guards: it builds nothing, it is carried into an air-gapped site on a USB
 * stick, and the person who runs it cannot read the source to work out why it
 * refused. Everything asserted here is a defect a full installation rehearsal
 * actually hit — each one produced a stack that either would not install or
 * would install over somebody else's data.
 */

interface ComposeService {
  container_name?: string;
  image?: string;
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
}

const composeText = readFileSync(bankaComposePath(), "utf8");
const compose = parse(composeText, { merge: true }) as {
  name?: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};
const envExample = readFileSync(bankaEnvExamplePath(), "utf8");
const install = readFileSync(bankaInstallPath(), "utf8");
const readme = readFileSync(bankaReadmePath(), "utf8");

/**
 * Two installations on one host.
 *
 * The bundle used to pin `name: maestro` and a fixed `container_name:` on every
 * service. Both are GLOBAL to the docker daemon, so a second installation —
 * an acceptance environment, or a rehearsal of the next release — did not
 * become a second stack. It resolved to the SAME project and therefore the same
 * `maestro_postgres-data` volume as the running one, and compose treated it as
 * an update of production rather than as a new install.
 *
 * Nothing warned: `install.sh` prints "KURULUM TAMAM" either way.
 */
describe("banka bundle: two installations must not collide", () => {
  it("takes the stack name from the environment instead of pinning it", () => {
    // Pinned, `-p` is the only escape and `install.sh` never passes one.
    expect(compose.name).toBe("${COMPOSE_PROJECT_NAME:-maestro}");
  });

  it("keeps the single-install default, so an existing site sees no change", () => {
    expect(compose.name).toContain(":-maestro}");
  });

  it("pins no container_name, because that name is global to the daemon", () => {
    // A project name scopes volumes and networks but NOT container_name: two
    // stacks with `container_name: maestro-bff` cannot both exist, whatever
    // `-p` says.
    for (const [service, definition] of Object.entries(compose.services)) {
      expect(definition.container_name, `${service} pins a global container_name`).toBeUndefined();
    }
  });

  it("documents the second-install hazard where the operator sets the name", () => {
    expect(envExample).toContain("COMPOSE_PROJECT_NAME");
  });

  it("never looks a container up by a hard-coded name", () => {
    // With container_name gone the real names carry the project prefix
    // (`maestro-bff-1`, `kabul-bff-1`). A `docker inspect maestro-bff` here
    // fails silently — the `|| echo ""` swallows it — and the installer then
    // reports a healthy stack as "not ready" after waiting 150 seconds.
    // Comment lines are excluded: the fix's own rationale names the old call.
    const code = install
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(code).not.toMatch(/docker inspect\s+maestro-(bff|studio|postgres|worker|temporal)\b/);
    // It must ask compose which container the service resolved to.
    expect(install).toMatch(/docker compose ps -q\s+bff/);
    expect(install).toMatch(/docker compose ps -q\s+studio/);
  });
});

/**
 * The first run of a freshly copied bundle.
 *
 * `.env.example` shipped an ACTIVE `NODE_EXTRA_CA_CERTS` naming a CA file that
 * no bundle contains (`certs/` holds only `.gitkeep`). `install.sh` verifies
 * that the named file exists, so the documented flow — copy the example, fill
 * in every `DEGISTIR` — refused on the very first run, at a line the operator
 * was never told to touch. The value holds no `DEGISTIR`, so nothing marked it
 * as needing attention: it reads as a setting that is already correct.
 */
describe("banka bundle: a filled-in .env.example installs as-is", () => {
  it("ships NODE_EXTRA_CA_CERTS commented out, since no CA file is bundled", () => {
    const active = envExample
      .split("\n")
      .filter((line) => /^\s*NODE_EXTRA_CA_CERTS\s*=/.test(line));
    expect(active, "NODE_EXTRA_CA_CERTS is active but certs/ ships empty").toEqual([]);
  });

  it("still documents the setting for a site that does need it", () => {
    // Commented out is not the same as removed: a bank whose Jira runs on an
    // internally signed certificate needs this, and needs to find it here.
    expect(envExample).toContain("NODE_EXTRA_CA_CERTS");
    expect(envExample).toContain("CA_BUNDLE_DIR");
  });

  const MANDATORY = [
    "CONNECTOR_MASTER_KEY",
    "POSTGRES_PASSWORD",
    "REDIS_PASSWORD",
    "MAESTRO_SECRET_KV_JIRA__WEBHOOK",
    // The bank-specific pair: image tags are minted at build time on the
    // internet-connected machine (`maestro/node:$TAG`), so unlike the registry
    // bundle — whose published 1.0.x addresses are known and shipped filled in
    // — this bundle cannot know them and must make the operator write them.
    "MAESTRO_NODE_IMAGE",
    "MAESTRO_STUDIO_IMAGE",
  ] as const;

  it("leaves every mandatory blank marked with the placeholder the installer greps for", () => {
    // `install.sh` refuses while any DEGISTIR remains. That contract only holds
    // if the fields needing a value actually carry the marker.
    //
    // The list is SHORT now, and that is the point of it. What is left is
    // infrastructure — the two datastore passwords and the key that enciphers
    // everything else — plus the one inbound secret that cannot come from the
    // store it would have to authenticate a request against (see below), plus
    // the two image names only the operator's `docker load` can answer.
    for (const key of MANDATORY) {
      const line = envExample.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
      expect(line, `${key} is missing from .env.example`).toBeDefined();
      expect(line, `${key} ships without a DEGISTIR marker`).toContain("DEGISTIR");
    }
  });

  it("demands nothing beyond those six", () => {
    /**
     * The list is EXACT, not a superset — and exactness is the property this
     * bundle silently lost once: while the registry bundle moved the model to
     * the panel, this file kept `LLM_MODEL="DEGISTIR"`, so a bank was forced
     * to fill a value the panel was about to own anyway. A new DEGISTIR
     * appearing here means a credential crept back into a file on the server;
     * it may not be added without deleting this line and explaining why.
     */
    const marked = envExample
      .split("\n")
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=.*DEGISTIR/.test(line))
      .map((line) => line.slice(0, line.indexOf("=")));
    expect(marked.sort()).toEqual([...MANDATORY].sort());
  });

  it("no longer demands the credentials the connector panel now owns", () => {
    /**
     * THE SHRINK, as a property rather than an edit.
     *
     * These were fills an operator had to perform in a file on the server,
     * for credentials the panel ALREADY collects, tests live and enciphers.
     * Worse, the two never met: the panel's Jira token was stored, tested and
     * shown green while every run authenticated with the `.env` one.
     *
     * A run now reads the managed connection first
     * (`stores/connection-secrets.ts`), so demanding these here would be
     * demanding the same secret twice in two places that could disagree.
     * Whatever remains of them in the bundle must therefore be OPTIONAL —
     * either commented out or shipped empty — never a DEGISTIR the installer
     * refuses to start without.
     */
    for (const key of [
      "MAESTRO_SECRET_KV_JIRA__TOKEN",
      "MAESTRO_SECRET_KV_GITHUB__TOKEN",
      "MAESTRO_SECRET_KV_LLM__API__2D_KEY",
      "MAESTRO_BOT_ACCOUNT_ID",
      "LLM_MODEL",
    ]) {
      const line = envExample.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
      expect(line ?? "", `${key} is still a mandatory fill`).not.toContain("DEGISTIR");
    }

    // And the installer must not refuse a stack that leaves them to the panel.
    // `ZORUNLU` is the list it dies over; a name in it is a name that has to be
    // in the file whatever the panel holds. The bundle DID die over three of
    // these until the panel-model release reached it: a bank had to invent a
    // dummy model key to get past a check for a credential the panel owns.
    const mandatory = install.slice(install.indexOf("ZORUNLU=("));
    const list = mandatory.slice(0, mandatory.indexOf(")"));
    for (const key of [
      "MAESTRO_SECRET_KV_JIRA__TOKEN",
      "MAESTRO_SECRET_KV_GITHUB__TOKEN",
      "MAESTRO_SECRET_KV_LLM__API__2D_KEY",
      "MAESTRO_BOT_ACCOUNT_ID",
      "MAESTRO_BOT_EMAIL",
      "JIRA_TOKEN_REF",
      "LLM_API_KEY_REF",
    ]) {
      expect(list, `${key} is in the installer's mandatory list`).not.toContain(key);
    }
  });

  it("keeps the webhook secret in the file, with its reason written down", () => {
    /**
     * The one credential that did NOT move, and must not.
     *
     * Every other reference is resolved on an OUTBOUND call the platform chose
     * to make. This one is resolved on an INBOUND, UNAUTHENTICATED request:
     * `POST /webhooks/jira` verifies the signature before it parses the body
     * and before anything has established the caller is Jira. Serving it from
     * the connection store would put a database read in front of the signature
     * check on an unrate-limited route — every forged delivery would become a
     * query.
     *
     * The reasoning is asserted, not just the value: an operator who finds one
     * lone `MAESTRO_SECRET_*` line among credentials that all moved to the
     * panel will reasonably assume it was overlooked, and delete it.
     */
    const line = envExample
      .split("\n")
      .find((candidate) => candidate.startsWith("MAESTRO_SECRET_KV_JIRA__WEBHOOK="));
    expect(line).toBeDefined();
    expect(envExample).toContain("BU NEDEN PANELE TAŞINMADI");
  });
});

/**
 * The bundle's own invariant, stated in its header: a variable that is not
 * named in a service's `environment:` block never reaches the process, however
 * carefully `.env` was filled in.
 */
describe("banka bundle: every documented variable reaches a container", () => {
  it("documents in .env.example every variable the compose interpolates", () => {
    const referenced = new Set(
      [...composeText.matchAll(/\$\{([A-Z0-9_]+)(?::[?-][^}]*)?\}/g)].map(
        (match) => match[1] as string,
      ),
    );
    const undocumented = [...referenced].filter((name) => !envExample.includes(name));
    expect(undocumented, `undocumented in .env.example: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("carries no real credential", () => {
    for (const line of envExample.split("\n")) {
      const match = /^\s*(MAESTRO_SECRET_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
      // A placeholder is fine; a filled-in secret in a shipped file is not.
      // (The old `yerel-endpoint-...` dummy model key is gone: the panel owns
      // the model key now, so the bundle no longer teaches inventing one.)
      expect(
        value === "" || value.includes("DEGISTIR"),
        `${match[1]} carries a real-looking value in .env.example`,
      ).toBe(true);
    }
    expect(envExample).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});

/**
 * The secrets anchor, checked against the header's own warning: a variable not
 * named in `environment:` never reaches the process, however carefully `.env`
 * was filled in.
 */
describe("banka bundle: the secrets the stack depends on actually arrive", () => {
  it("forwards the GitHub fallback token to every application service", () => {
    /**
     * The exact failure the header warns about, and the one this bundle
     * shipped: `MAESTRO_SECRET_KV_GITHUB__TOKEN` was documented, fillable in
     * `.env`, visibly correct — and absent from `x-node-secrets`, so the env-
     * file driver answered the first SCM call with SecretNotFoundError while
     * the operator stared at a filled-in line.
     */
    for (const service of ["migrate", "bff", "worker"]) {
      expect(
        compose.services[service]?.environment?.["MAESTRO_SECRET_KV_GITHUB__TOKEN"],
        `${service} never sees MAESTRO_SECRET_KV_GITHUB__TOKEN`,
      ).toBeDefined();
    }
  });

  it("makes the webhook secret REQUIRED, because its verification fails closed", () => {
    // `${VAR:-}` here is a stack that starts green and 401s EVERY webhook
    // delivery: the signature check runs before anything else and an unset
    // secret rejects all comers. The flow then simply never begins — no error
    // on the operator's screen, one line per delivery in a log nobody reads.
    expect(composeText).toContain("${MAESTRO_SECRET_KV_JIRA__WEBHOOK:?");
    expect(composeText).not.toContain("${MAESTRO_SECRET_KV_JIRA__WEBHOOK:-");
  });
});

/**
 * The audit's pass-through set (B2/B3/B6/B7 + the bootstrap password), twin of
 * the registry bundle's block: every one of these is READ by the code and used
 * to be absent from `environment:`, so `.env` could carry it and the process
 * would never see it — this bundle's most expensive historical failure mode.
 */
describe("banka bundle: the audited variables reach the process that reads them", () => {
  it("hands the gate-group mapping to BOTH deciders, bff and worker", () => {
    // B2: the BFF verifies /approve against the Jira group, the worker writes
    // the owner onto the gate record (stores/gate-directory.ts, bin/worker.ts).
    // Resolved differently, a real approval passes one process and is refused
    // by the other.
    for (const service of ["bff", "worker"]) {
      for (const name of ["GATE_GROUPS", "GATE_GROUP_DEFAULT"]) {
        expect(
          compose.services[service]?.environment?.[name],
          `${service} never sees ${name}`,
        ).toBeDefined();
      }
    }
  });

  it("hands the BFF its own knobs: flow fallback, comment poller, repo checkout", () => {
    // B3 (MAESTRO_FLOW, bin/bff.ts flowOf), B7 (JIRA_POLL_MS, startJiraPoller)
    // and B6 (WORKSPACE_ROOT/SCM_*, checkoutOrNull) are all read by the BFF.
    for (const name of ["MAESTRO_FLOW", "JIRA_POLL_MS", "WORKSPACE_ROOT", "SCM_TOKEN_REF", "SCM_HOST"]) {
      expect(compose.services["bff"]?.environment?.[name], `bff never sees ${name}`).toBeDefined();
    }
  });

  it("hands the bootstrap password to migrate, and ONLY to migrate", () => {
    // Only migrate plants the first admin (bin/migrate.ts). Every extra
    // container holding a password is another place it can be read out of.
    expect(compose.services["migrate"]?.environment?.["MAESTRO_BOOTSTRAP_PASSWORD"]).toBeDefined();
    for (const service of ["bff", "worker", "postgres", "redis", "temporal", "studio"]) {
      expect(
        compose.services[service]?.environment?.["MAESTRO_BOOTSTRAP_PASSWORD"],
        `${service} carries the bootstrap password`,
      ).toBeUndefined();
    }
  });

  it("keeps every one of them OPTIONAL, so empty still means today's behaviour", () => {
    // A `:?` on any of these would refuse to start a stack that worked
    // yesterday. Empty is a supported state for all of them by design.
    for (const name of [
      "GATE_GROUPS",
      "GATE_GROUP_DEFAULT",
      "MAESTRO_FLOW",
      "JIRA_POLL_MS",
      "WORKSPACE_ROOT",
      "SCM_TOKEN_REF",
      "SCM_HOST",
      "MAESTRO_BOOTSTRAP_PASSWORD",
    ]) {
      expect(composeText, `${name} became mandatory`).not.toContain(`\${${name}:?`);
    }
  });

  it("mounts the shared workspace into bff AND worker at the same path", () => {
    // B6: the BFF clones (checkoutOrNull), the worker READS the clone at
    // `RunContext.workspacePath` (packages/workflows/src/impl/analysis.ts).
    // Read-only root + per-container /tmp tmpfs means only a shared volume at
    // one path lets the worker see what the BFF checked out.
    for (const service of ["bff", "worker"]) {
      expect(
        compose.services[service]?.volumes ?? [],
        `${service} has no workspace mount`,
      ).toContain("maestro-workspace:/workspace");
    }
    expect(compose.services["migrate"]?.volumes ?? []).not.toContain("maestro-workspace:/workspace");
    expect(compose.volumes, "maestro-workspace volume is not declared").toHaveProperty(
      "maestro-workspace",
    );
  });

  it("gives the workspace volume to uid 10001, or the clone dies on its first mkdir", () => {
    // A plain named volume is born root-owned; the services run as 10001 and
    // the checkout would fail EACCES — silently, into a repo-blind analysis.
    const volume = compose.volumes?.["maestro-workspace"] as
      | { driver_opts?: { o?: string } }
      | undefined;
    expect(volume?.driver_opts?.o ?? "").toContain("uid=10001");
  });
});

/**
 * Freshness: the numbers a stale bundle lies with.
 */
describe("banka bundle: the hand-written literals match the repository", () => {
  it("expects exactly as many migrations as the repo carries", () => {
    /**
     * `MIG_BEKLENEN` is the installer's floor for the migration-directory
     * count inside the image, and it is a hand-written literal in a shell
     * script no compiler reads. It went stale exactly once: 0021 landed, the
     * script kept saying 21, and because the comparison is `-ge` a pre-panel
     * image passed the check as green. This assertion is the only thing that
     * makes the literal move when the schema does.
     */
    const literal = /^MIG_BEKLENEN=(\d+)$/m.exec(install);
    expect(literal, "install.sh no longer pins MIG_BEKLENEN").not.toBeNull();
    const repoCount = readdirSync(migrationsDir(), { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && /^\d/.test(entry.name),
    ).length;
    expect(Number(literal?.[1])).toBe(repoCount);
  });

  it("carries ONE bundle version, wherever the date is written", () => {
    // Four places name the version; the README's own header says they must
    // agree ("Üçü tutmuyorsa elinizdeki paket karışıktır — kurmayın"). The
    // bundle sat at 2026-08-16 while its sibling moved on — the drift this
    // test exists to make loud.
    const fromInstall = /^BUNDLE_VERSION="([0-9-]+)"$/m.exec(install)?.[1];
    const fromEnv = /^BUNDLE_VERSION="([0-9-]+)"$/m.exec(envExample)?.[1];
    const fromReadme = /Paket sürümü: ([0-9-]+)/.exec(readme)?.[1];
    const fromCompose = /BUNDLE_VERSION: ([0-9-]+)/.exec(composeText)?.[1];
    expect(fromInstall).toBeDefined();
    expect(fromEnv).toBe(fromInstall);
    expect(fromReadme).toBe(fromInstall);
    expect(fromCompose).toBe(fromInstall);
  });

  it("teaches the panel-era model flow, not the .env one", () => {
    // The installer must tell an operator with an empty LLM_BASE_URL where the
    // model is actually defined — silence here reads as "misconfigured".
    expect(install).toContain("model PANELDEN tanımlanacak");
    expect(install).toContain("Ayarlar & bağlantılar");
  });
});

/**
 * The two settings that decide whether an analysis install can finish a ticket.
 *
 * Both ship commented out in `.env.example`, and both failing silently produces
 * the same field report: "the analysis never finished". Reproduced on a clean
 * install of the real bundle:
 *
 *  · `MAESTRO_FLOW` empty — a ticket that matches no listening rule takes the
 *    FULL pipeline. The analysis is written, both gates are approved, and the
 *    run then dies in the engineering turn because `RUNNER_IMAGE_LINUX` is
 *    unset: after the work is done, at the most expensive point.
 *  · `JIRA_POLL_MS` empty — `/approve` written on the ticket is never read. On
 *    Jira Cloud the webhook signature cannot be verified, so polling is the
 *    ONLY path; without it every gate waits forever and the run looks stuck.
 *
 * The installer does not force either — a code-writing site legitimately wants
 * both off — but it must not pass over them in silence. Asking costs one
 * prompt; not asking costs an operator a week of reading logs.
 */
describe("the installer refuses to pass silently over the analysis settings", () => {
  it("warns when no flow is set, and says what happens", () => {
    expect(install).toContain("MAESTRO_FLOW");
    // Names the consequence, not just the variable.
    expect(install).toMatch(/KOD YAZAN akışa düşer/);
    expect(install).toMatch(/MAESTRO_FLOW=\\"analiz\\"/);
  });

  it("warns when the Jira poller is off, and says approvals will not be read", () => {
    expect(install).toContain("JIRA_POLL_MS");
    expect(install).toMatch(/\/approve OKUNMAZ/);
    // And says when leaving it off is CORRECT, so a DC site is not scared into
    // enabling a second reader for comments its webhook already delivers.
    expect(install).toMatch(/Data Center/);
  });

  it("asks rather than dies, because both settings have legitimate off states", () => {
    const flowSection = install.slice(install.indexOf("MAESTRO_FLOW boş"));
    expect(flowSection).toContain("onay ");
  });
});

/**
 * The autohealer is the only container that talks to the Docker daemon, and
 * both of its wiring mistakes were invisible until a live install.
 *
 * It runs as uid 10001 (the shared hardening) while the socket is root:docker,
 * so without an extra group membership every call it makes returns EACCES —
 * the service comes up, logs "izleniyor", and rescues nothing. Measured: the
 * first version shipped exactly like that.
 */
describe("autoheal can actually reach the Docker socket", () => {
  const autoheal = (compose.services as Record<string, Record<string, unknown>>)["autoheal"];

  it("is in the bundle at all", () => {
    expect(autoheal).toBeDefined();
  });

  it("joins the socket's group, because uid 10001 alone gets EACCES", () => {
    expect(autoheal?.["group_add"]).toEqual([expect.stringContaining("DOCKER_GID")]);
  });

  it("mounts the socket READ-ONLY — it restarts, it does not build or remove", () => {
    const volumes = autoheal?.["volumes"] as string[];
    expect(volumes.some((v) => v.endsWith("/var/run/docker.sock:ro"))).toBe(true);
  });

  /**
   * A blank project name would widen the restart filter to EVERY container on
   * the host. The bin refuses to start without one; the bundle must never be
   * the thing that hands it an empty string.
   */
  it("names the project whose containers it may restart", () => {
    const env = autoheal?.["environment"] as Record<string, string>;
    expect(env["COMPOSE_PROJECT_NAME"]).toContain("COMPOSE_PROJECT_NAME");
  });
});
