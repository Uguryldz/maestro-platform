import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  dockerignorePath,
  migrationsDir,
  ugurdockerComposePath,
  ugurdockerEnvExamplePath,
  ugurdockerGitignorePath,
  ugurdockerInstallPath,
  ugurdockerReadmePath,
} from "./paths.js";

/**
 * The registry bundle (`deploy/ugurdocker/`), checked as data.
 *
 * It differs from the bank bundle in ONE thing: images are pulled from a
 * registry the operator populates and administers themselves, instead of being
 * carried in as tar files. Everything else is deliberately the same stack.
 *
 * That sameness is the reason this file exists. Two compose files that share no
 * code but are meant to stay equivalent drift apart one edit at a time, and the
 * drift is invisible until an installation fails at a site nobody can reach.
 * Each assertion below is a property the bank bundle earned the hard way —
 * restated here so the copy cannot quietly lose it.
 */

interface ComposeService {
  build?: unknown;
  container_name?: string;
  image?: string;
  user?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  volumes?: string[];
}

const composeText = readFileSync(ugurdockerComposePath(), "utf8");
const compose = parse(composeText, { merge: true }) as {
  name?: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};
const envExample = readFileSync(ugurdockerEnvExamplePath(), "utf8");
const install = readFileSync(ugurdockerInstallPath(), "utf8");
const readme = readFileSync(ugurdockerReadmePath(), "utf8");
const gitignore = readFileSync(ugurdockerGitignorePath(), "utf8");
const dockerignore = readFileSync(dockerignorePath(), "utf8");

/** Services that run the application image, as opposed to the data layer. */
const NODE_SERVICES = ["migrate", "bff", "worker"] as const;

/**
 * The one substantive difference from `banka/`: nothing is built, everything is
 * pulled. A `build:` key here would be a stack that quietly compiles from
 * whatever source tree happens to sit beside it, which is not what the operator
 * pushed to their registry and not what the tag says is running.
 */
describe("ugurdocker bundle: images come from a registry, never from a build", () => {
  it("declares no build: key on any service", () => {
    for (const [service, definition] of Object.entries(compose.services)) {
      expect(definition.build, `${service} declares a build:`).toBeUndefined();
    }
  });

  it("takes every image from a variable, so the registry prefix is the operator's to set", () => {
    // The operator names their own repositories. A hard-coded prefix here would
    // be a guess about somebody else's registry layout.
    for (const [service, definition] of Object.entries(compose.services)) {
      expect(definition.image, `${service} has no image:`).toBeDefined();
      expect(definition.image, `${service} pins a literal image`).toMatch(/^\$\{[A-Z0-9_]+/);
    }
  });

  it("makes the two application images REQUIRED, with no default to fall back to", () => {
    /**
     * `${VAR:?...}` and not `${VAR:-maestro/node:latest}`.
     *
     * A default would be worse than a failure: compose would resolve it, `pull`
     * would reach for an image the operator never pushed, and the error would
     * name a registry path they have never seen. Required-with-a-message stops
     * at the variable the operator actually has to fill in.
     */
    for (const variable of ["MAESTRO_NODE_IMAGE", "MAESTRO_STUDIO_IMAGE"]) {
      expect(composeText, `${variable} is not required`).toContain(`\${${variable}:?`);
      expect(composeText).not.toContain(`\${${variable}:-`);
    }
  });

  it("tells the installer to pull, and to stop when the pull fails", () => {
    // Continuing past a failed pull lets `up -d` fall back to whatever local
    // image happens to carry that tag — and then nobody knows what is running.
    expect(install).toMatch(/docker compose pull/);
    expect(install).toMatch(/if ! docker compose pull/);
  });
});

/**
 * Two installations on one host.
 *
 * The bank bundle used to pin `name: maestro` and a fixed `container_name:` on
 * every service. Both are GLOBAL to the docker daemon, so a second installation
 * did not become a second stack — it resolved to the same project and the same
 * `maestro_postgres-data` volume as the running one. A live database was
 * destroyed exactly this way.
 */
describe("ugurdocker bundle: two installations must not collide", () => {
  it("takes the stack name from the environment instead of pinning it", () => {
    expect(compose.name).toBe("${COMPOSE_PROJECT_NAME:-maestro}");
  });

  it("keeps the single-install default, so an existing site sees no change", () => {
    expect(compose.name).toContain(":-maestro}");
  });

  it("pins no container_name, because that name is global to the daemon", () => {
    for (const [service, definition] of Object.entries(compose.services)) {
      expect(definition.container_name, `${service} pins a global container_name`).toBeUndefined();
    }
  });

  it("documents the second-install hazard where the operator sets the name", () => {
    expect(envExample).toContain("COMPOSE_PROJECT_NAME");
  });

  it("never looks a container up by a hard-coded name", () => {
    // Real names carry the project prefix (`maestro-bff-1`, `kabul-bff-1`). A
    // `docker inspect maestro-bff` fails silently — `|| echo ""` swallows it —
    // and the installer then calls a healthy stack "not ready" after 150s.
    const code = install
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(code).not.toMatch(/docker inspect\s+maestro-(bff|studio|postgres|worker|temporal)\b/);
    expect(install).toMatch(/docker compose ps -q\s+bff/);
    expect(install).toMatch(/docker compose ps -q\s+studio/);
  });
});

/**
 * The four fills, and only four.
 *
 * What is left after the connector panel took over the tokens is infrastructure
 * — the two datastore passwords and the key that enciphers everything else —
 * plus the one inbound secret that cannot come from the store it would have to
 * authenticate a request against.
 */
describe("ugurdocker bundle: a filled-in .env.example installs as-is", () => {
  const MANDATORY = [
    "POSTGRES_PASSWORD",
    "REDIS_PASSWORD",
    "CONNECTOR_MASTER_KEY",
    "MAESTRO_SECRET_KV_JIRA__WEBHOOK",
  ] as const;

  it("marks every mandatory blank with the placeholder the installer greps for", () => {
    // `install.sh` refuses while any DEGISTIR remains. That contract only holds
    // if the fields needing a value actually carry the marker.
    for (const key of MANDATORY) {
      const line = envExample.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
      expect(line, `${key} is missing from .env.example`).toBeDefined();
      expect(line, `${key} ships without a DEGISTIR marker`).toContain("DEGISTIR");
    }
  });

  it("ships every image as a working address, not a placeholder", () => {
    /**
     * The images are PUBLISHED now, so a guessable prefix exists and the
     * example carries it: a pilot installation pulls straight from Docker Hub
     * and changes nothing here, while a site mirroring into its own Nexus
     * overwrites the whole line. `DEGISTIR` here would make the published
     * images unreachable by the documented flow — `install.sh` refuses while
     * any marker remains, so every operator would have to edit five lines to
     * arrive back at the values shipped in this file.
     *
     * Compose still declares the two application images `${VAR:?}` (asserted
     * above): a default THERE would resolve for an operator who deleted the
     * line, and pull an image they never chose.
     */
    for (const key of [
      "MAESTRO_NODE_IMAGE",
      "MAESTRO_STUDIO_IMAGE",
      "POSTGRES_IMAGE",
      "REDIS_IMAGE",
      "TEMPORAL_IMAGE",
    ]) {
      const line = envExample.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
      expect(line, `${key} is missing from .env.example`).toBeDefined();
      expect(line, `${key} still ships as a placeholder`).not.toContain("DEGISTIR");
      // A tag, and never `latest`: which version is installed must be legible
      // from the file, and a rollback must have something to roll back to.
      expect(line, `${key} carries no pinned tag`).toMatch(/=".+:[^:"]+"/);
      expect(line, `${key} floats on :latest`).not.toMatch(/:latest"/);
    }
  });

  it("demands nothing beyond those four", () => {
    /**
     * THE SHRINK, as a property rather than an edit.
     *
     * A fifth DEGISTIR appearing here means a credential crept back into a
     * file on the server — most likely one the panel already collects, tests
     * live and enciphers. That was the old failure: the panel's Jira token was
     * stored, tested and shown green while every run authenticated with the
     * `.env` one, and no screen could show the difference.
     *
     * The list is EXACT, not a superset: the shrink is only real while nothing
     * may be added without deleting this line and explaining why.
     */
    const marked = envExample
      .split("\n")
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=.*DEGISTIR/.test(line))
      .map((line) => line.slice(0, line.indexOf("=")));
    expect(marked.sort()).toEqual([...MANDATORY].sort());
  });

  it("no longer demands the credentials the connector panel now owns", () => {
    // A run reads the managed connection first (`stores/connection-secrets.ts`),
    // so demanding these here would be demanding the same secret twice in two
    // places that could disagree. Whatever remains must be OPTIONAL.
    for (const key of [
      "MAESTRO_SECRET_KV_JIRA__TOKEN",
      "MAESTRO_SECRET_KV_GITHUB__TOKEN",
      "MAESTRO_SECRET_KV_LLM__API__2D_KEY",
      "MAESTRO_BOT_ACCOUNT_ID",
    ]) {
      const line = envExample.split("\n").find((candidate) => candidate.startsWith(`${key}=`));
      expect(line ?? "", `${key} is still a mandatory fill`).not.toContain("DEGISTIR");
    }

    // And the installer must not refuse a stack that leaves them to the panel.
    const mandatory = install.slice(install.indexOf("ZORUNLU=("));
    const list = mandatory.slice(0, mandatory.indexOf(")"));
    for (const key of [
      "MAESTRO_SECRET_KV_JIRA__TOKEN",
      "MAESTRO_SECRET_KV_GITHUB__TOKEN",
      "MAESTRO_SECRET_KV_LLM__API__2D_KEY",
      "MAESTRO_BOT_ACCOUNT_ID",
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
     * `POST /webhooks/jira` verifies the signature before it parses the body.
     * Serving it from the connection store would put a database read in front
     * of the signature check on an unrate-limited route.
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

  it("ships NODE_EXTRA_CA_CERTS commented out, since no CA file is bundled", () => {
    // Active, it names a file `certs/` does not contain, and `install.sh`
    // verifies that the named file exists — so the documented flow would refuse
    // on the very first run, at a line the operator was never told to touch.
    const active = envExample
      .split("\n")
      .filter((line) => /^\s*NODE_EXTRA_CA_CERTS\s*=/.test(line));
    expect(active, "NODE_EXTRA_CA_CERTS is active but certs/ ships empty").toEqual([]);
    // Commented out is not removed: a site whose Jira runs on an internally
    // signed certificate needs this, and needs to find it here.
    expect(envExample).toContain("NODE_EXTRA_CA_CERTS");
    expect(envExample).toContain("CA_BUNDLE_DIR");
  });
});

/**
 * The hardening, restated. The bank bundle's stack was verified end to end with
 * these settings; a registry-pull copy that relaxes them is a different stack
 * wearing the same name.
 */
describe("ugurdocker bundle: the hardening survives the copy", () => {
  it("runs the application services unprivileged, read-only and capability-free", () => {
    for (const service of NODE_SERVICES) {
      const definition = compose.services[service];
      expect(definition, `${service} is missing`).toBeDefined();
      expect(definition?.user, `${service} does not drop to uid 10001`).toBe("10001:10001");
      expect(definition?.read_only, `${service} has a writable root filesystem`).toBe(true);
      expect(definition?.cap_drop, `${service} keeps capabilities`).toContain("ALL");
      expect(definition?.security_opt, `${service} allows privilege escalation`).toContain(
        "no-new-privileges:true",
      );
    }
  });

  it("hardens studio too, which is the only service exposed to the network", () => {
    const studio = compose.services["studio"];
    expect(studio?.read_only).toBe(true);
    expect(studio?.cap_drop).toContain("ALL");
    expect(studio?.security_opt).toContain("no-new-privileges:true");
  });

  it("publishes exactly one port, and it is the panel's", () => {
    // BFF listens on 7001 INSIDE the container and is never published; the
    // number is repeated verbatim in the healthcheck and in studio-nginx.conf.
    const published = Object.entries(compose.services).filter(
      ([, definition]) => "ports" in definition,
    );
    expect(published.map(([name]) => name)).toEqual(["studio"]);
  });

  it("installs the schema before the application, and waits for it", () => {
    // `migrate` runs to completion first; bff and worker refuse to start until
    // it has. Without this a fresh install races the schema and dies on a
    // missing table — or worse, writes to a column that is not there yet.
    expect(compose.services["bff"]?.depends_on?.["migrate"]?.condition).toBe(
      "service_completed_successfully",
    );
    expect(compose.services["worker"]?.depends_on?.["migrate"]?.condition).toBe(
      "service_completed_successfully",
    );
    for (const dependency of ["postgres", "redis", "temporal"]) {
      expect(
        compose.services["bff"]?.depends_on?.[dependency]?.condition,
        `bff does not wait for ${dependency} to be healthy`,
      ).toBe("service_healthy");
    }
    expect(compose.services["studio"]?.depends_on?.["bff"]?.condition).toBe("service_healthy");
  });
});

/**
 * The bundle's own invariant, stated in its header: a variable that is not
 * named in a service's `environment:` block never reaches the process, however
 * carefully `.env` was filled in.
 */
describe("ugurdocker bundle: every documented variable reaches a container", () => {
  it("documents every variable an operator must supply, in .env.example itself", () => {
    /**
     * Only the variables compose REQUIRES (`${VAR:?}`) — the ones with no
     * default anywhere, where an operator who cannot find the name in `.env`
     * has no way to learn it exists.
     *
     * A variable compose defaults (`${VAR:-...}`) is a different case, and
     * conflating the two is what grew this file to 411 lines: `LDAP_USER_FILTER`
     * and `STORAGE_REGION` were listed not because anyone sets them but because
     * this assertion demanded the string be present, and the reader then had to
     * decide, line by line, which of 31 variables were decisions and which were
     * restatements of a default. The defaulted ones are documented in
     * README §8 instead — with their values, so the table can be checked
     * against compose — and the next test pins that.
     */
    const required = new Set(
      [...composeText.matchAll(/\$\{([A-Z0-9_]+):\?[^}]*\}/g)].map((match) => match[1] as string),
    );
    const undocumented = [...required].filter((name) => !envExample.includes(name));
    expect(undocumented, `undocumented in .env.example: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("documents every OTHER interpolated variable in the README, if not in .env.example", () => {
    /**
     * Removing a line from `.env.example` is only safe while the name stays
     * findable. A variable that is in neither file is one an operator can only
     * discover by reading compose — which is the failure mode the assertion
     * above was written for, reappearing at the place the shrink moved things
     * to.
     */
    const referenced = new Set(
      [...composeText.matchAll(/\$\{([A-Z0-9_]+)(?::[?-][^}]*)?\}/g)].map(
        (match) => match[1] as string,
      ),
    );
    const undocumented = [...referenced].filter(
      (name) => !envExample.includes(name) && !readme.includes(name),
    );
    expect(undocumented, `documented nowhere: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("hands the master key to every service that reads a stored token", () => {
    // Without it a connection token cannot be deciphered, and the panel's whole
    // point — that credentials live there rather than in this file — collapses.
    for (const service of NODE_SERVICES) {
      expect(
        compose.services[service]?.environment?.["CONNECTOR_MASTER_KEY"],
        `${service} never sees CONNECTOR_MASTER_KEY`,
      ).toBeDefined();
    }
  });

  it("keeps secrets out of the data-layer containers", () => {
    // A separate anchor exists precisely so postgres/redis/temporal never get
    // the application's secrets: they have no use for them, and every extra
    // container holding a secret is another place it can be read out of.
    for (const service of ["postgres", "redis", "temporal"]) {
      const environment = compose.services[service]?.environment ?? {};
      const leaked = Object.keys(environment).filter(
        (name) => name.startsWith("MAESTRO_SECRET_") || name === "CONNECTOR_MASTER_KEY",
      );
      expect(leaked, `${service} carries application secrets`).toEqual([]);
    }
  });

  it("carries no real credential", () => {
    for (const line of envExample.split("\n")) {
      const match = /^\s*(MAESTRO_SECRET_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
      expect(
        value === "" || value.includes("DEGISTIR"),
        `${match[1]} carries a real-looking value in .env.example`,
      ).toBe(true);
    }
    expect(envExample).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});

/**
 * Freshness: the number a stale image lies with.
 */
describe("ugurdocker bundle: the hand-written migration floor matches the repository", () => {
  it("expects exactly as many migrations as the repo carries", () => {
    /**
     * `MIG_BEKLENEN` is the installer's floor for the migration-directory
     * count inside the pulled image, and it is a hand-written literal in a
     * shell script no compiler reads. It went stale exactly once: 0021 landed,
     * the script kept saying 21, and because the comparison is `-ge` a
     * pre-panel 1.0.0 image passed the check as green — the check exists to
     * catch precisely that image. This assertion is the only thing that makes
     * the literal move when the schema does.
     */
    const literal = /^MIG_BEKLENEN=(\d+)$/m.exec(install);
    expect(literal, "install.sh no longer pins MIG_BEKLENEN").not.toBeNull();
    const repoCount = readdirSync(migrationsDir(), { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && /^\d/.test(entry.name),
    ).length;
    expect(Number(literal?.[1])).toBe(repoCount);
  });
});

/**
 * The audit's pass-through set (B2/B3/B6/B7 + the bootstrap password): every
 * one of these is READ by the code and used to be absent from `environment:`,
 * so `.env` could carry it and the process would never see it — the header's
 * own failure mode. Each assertion names the process that reads the variable,
 * because handing a variable to the wrong service is the same bug inverted.
 */
describe("ugurdocker bundle: the audited variables reach the process that reads them", () => {
  it("hands the gate-group mapping to BOTH deciders, bff and worker", () => {
    /**
     * B2. `/approve` is verified against Jira GROUP membership and the role
     * names are only defaults (stores/gate-directory.ts). The BFF verifies
     * membership, the worker writes the owner onto the gate record
     * (bin/worker.ts) — resolved differently, a real approval passes one
     * process and is refused by the other.
     */
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
    /**
     * B6. The BFF clones (checkoutOrNull), the worker READS the clone at
     * `RunContext.workspacePath` (packages/workflows/src/impl/analysis.ts).
     * The root filesystem is read-only and /tmp is a PER-CONTAINER tmpfs, so
     * without one shared volume at one path the worker can never see what the
     * BFF checked out. Migrate has no business with it.
     */
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
 * The filled-in `.env` is the most dangerous file in the bundle: datastore
 * passwords, the key that enciphers every stored token, and the webhook secret.
 * Two separate ignore files have to hold for it never to escape.
 */
describe("ugurdocker bundle: the filled-in .env cannot escape", () => {
  it("keeps .env out of git while keeping the example in", () => {
    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toMatch(/^!\.env\.example$/m);
  });

  it("keeps .env out of every image, wherever in the tree it sits", () => {
    /**
     * `**\/.env`, not `.env`.
     *
     * A pattern without a slash matches only at the CONTEXT ROOT, so plain
     * `.env` never excluded `deploy/.env` — and an image once shipped carrying
     * 18 KB of real credentials because of it. The bundle's own `.gitignore`
     * cannot help here: docker build does not read it.
     */
    expect(dockerignore).toMatch(/^\*\*\/\.env$/m);
  });
});

/**
 * What the installer refuses to let an operator walk past in silence.
 *
 * Each of these is a setting that, left alone, produces a system that RUNS and
 * is WRONG — the worst failure shape for a bank, because nothing errors and the
 * operator has no thread to pull. They were found by audit before the bank
 * install, not after it.
 */
describe("ugurdocker bundle: the installer asks before a silent-wrong install", () => {
  const install = readFileSync(
    new URL("../../../deploy/ugurdocker/install.sh", import.meta.url),
    "utf8",
  );

  /**
   * Approval groups. With no mapping, Maestro treats the ROLE NAME as the group
   * name and looks for `product-owners` / `tech-leads` / `qa` in Jira. No bank
   * has groups by those names, so every `/approve` is refused as "not a member"
   * and the gate waits forever — a run that looks stuck with no error anywhere.
   */
  it("asks when no approval group is mapped, because gates then refuse everyone", () => {
    expect(install).toContain("GATE_GROUPS");
    expect(install).toContain("GATE_GROUP_DEFAULT");
    const guard = install.slice(install.indexOf("GATE_GROUPS ve GATE_GROUP_DEFAULT"));
    // It must offer the fix, not just name the problem.
    expect(guard).toContain("onay ");
  });

  /**
   * The sweep is a Jira Cloud capability: JQL search exists only on that
   * driver. Setting the interval on a Data Center install buys nothing, and an
   * operator who believes tickets will arrive by sweep will not set up the
   * webhook that is actually carrying them.
   */
  it("asks when the sweep is set but no Jira Cloud connection can serve it", () => {
    expect(install).toContain("JIRA_DISCOVER_MS dolu ama");
    expect(install).toContain("JIRA_CLOUD_BASE_URL");
  });

  /**
   * Migrations are forward-only and there is no down migration. If an upgrade
   * goes wrong, moving the image tag back is NOT enough — the schema has
   * already changed. The only real way back is a backup taken BEFORE the
   * upgrade, so the installer asks for one when it sees an existing database.
   */
  it("asks for a backup before upgrading over an existing database", () => {
    expect(install).toContain("YEDEK BULUNAMADI");
    expect(install).toContain("pg_dump");
    // Detected from the volume, not from a flag the operator could forget.
    expect(install).toContain("postgres-data");
  });
});
