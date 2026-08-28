import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { composePath, dockerfilePath, dockerignorePath, envExamplePath } from "./paths.js";

/**
 * The compose stack, checked as data rather than by eye.
 *
 * A compose file is code that nobody typechecks: a healthcheck with a typo, a
 * `depends_on` without a condition, or a service that quietly runs as root all
 * parse perfectly and all fail only in front of an operator. These assertions
 * are the type system this file does not have.
 */

interface ComposeService {
  build?: { dockerfile?: string; args?: Record<string, string> };
  image?: string;
  depends_on?: Record<string, { condition?: string }>;
  healthcheck?: { test?: unknown; interval?: string; retries?: number; start_period?: string };
  ports?: string[];
  user?: string;
  read_only?: boolean;
  security_opt?: string[];
  cap_drop?: string[];
  network_mode?: string;
  privileged?: boolean;
  volumes?: string[];
  environment?: Record<string, string>;
  restart?: string;
  command?: string[];
}

/**
 * `merge: true` resolves the `<<:` merge keys.
 *
 * Without it the shared hardening block reads as absent on every service that
 * inherits it, and assertions about `user` or `read_only` would pass or fail
 * for reasons that have nothing to do with the file's meaning. Docker resolves
 * these the same way — `docker compose config` shows the merged result — so
 * this is the shape the daemon actually runs.
 */
const compose = parse(readFileSync(composePath(), "utf8"), { merge: true }) as {
  name?: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};

const NODE_SERVICES = ["bff", "worker", "migrate"] as const;

describe("compose: shape", () => {
  it("parses as YAML and declares the whole stack", () => {
    expect(Object.keys(compose.services).sort()).toEqual(
      ["bff", "migrate", "postgres", "redis", "studio", "temporal", "temporal-ui", "worker"].sort(),
    );
  });

  it("publishes the documented ports", () => {
    const published = (name: string): string[] => compose.services[name]?.ports ?? [];
    expect(published("bff").join()).toContain(":7001");
    expect(published("studio").join()).toContain(":8080");
    expect(published("temporal").join()).toContain(":7233");
    expect(published("postgres").join()).toContain(":5432");
  });

  it("keeps the database on a named volume so a restart is not a data loss", () => {
    expect(compose.volumes).toHaveProperty("postgres-data");
    expect(compose.services["postgres"]?.volumes?.join()).toContain("postgres-data");
  });
});

describe("compose: health and ordering", () => {
  it.each(["postgres", "temporal", "bff", "studio"])("%s has a real healthcheck", (name) => {
    const health = compose.services[name]?.healthcheck;
    expect(health, `${name} has no healthcheck`).toBeDefined();
    expect(health?.test, `${name} healthcheck has no test`).toBeTruthy();
    // A probe with no retries fails the first time the service is merely slow.
    expect(health?.retries ?? 0, `${name} healthcheck has no retries`).toBeGreaterThan(0);
    expect(health?.start_period, `${name} has no start_period`).toBeTruthy();
  });

  it("probes the BFF's readiness, not just its liveness", () => {
    // `/healthz` only proves the process is up. `/readyz` pings Temporal and
    // the kill-switch store, which is what "would a request work" means.
    expect(JSON.stringify(compose.services["bff"]?.healthcheck?.test)).toContain("/readyz");
  });

  it("waits for dependencies to be HEALTHY, never merely created", () => {
    for (const name of ["bff", "worker"]) {
      const deps = compose.services[name]?.depends_on ?? {};
      expect(deps["postgres"]?.condition, `${name} → postgres`).toBe("service_healthy");
      expect(deps["temporal"]?.condition, `${name} → temporal`).toBe("service_healthy");
    }
  });

  it("holds the application back until migrations have COMPLETED", () => {
    // Not `service_started`: a BFF querying a table a migration has not
    // created yet fails in a way that reads as a code bug.
    for (const name of ["bff", "worker"]) {
      expect(compose.services[name]?.depends_on?.["migrate"]?.condition).toBe(
        "service_completed_successfully",
      );
    }
  });

  it("runs migrate as a one-shot job that is not restarted", () => {
    // A restarting migration job would re-enter the advisory lock in a loop.
    expect(compose.services["migrate"]?.restart).toBe("no");
    expect(compose.services["migrate"]?.healthcheck).toBeUndefined();
  });

  it("orders temporal behind postgres, since it stores its own state there", () => {
    expect(compose.services["temporal"]?.depends_on?.["postgres"]?.condition).toBe("service_healthy");
  });

  it("serves studio only once the BFF it talks to is healthy", () => {
    expect(compose.services["studio"]?.depends_on?.["bff"]?.condition).toBe("service_healthy");
  });

  it.each(["bff", "worker"])("holds %s back until redis answers", (name) => {
    // A service that starts before its coordination store falls back to a
    // process-local limiter, or throws on its first take. Either way the
    // failure looks like an application bug rather than a startup ordering one.
    expect(compose.services[name]?.depends_on?.["redis"]?.condition).toBe("service_healthy");
  });
});

describe("compose: redis (M4 coordination)", () => {
  const redis = (): ComposeService | undefined => compose.services["redis"];

  it("answers a real healthcheck, not just a TCP probe", () => {
    expect(JSON.stringify(redis()?.healthcheck?.test)).toContain("ping");
  });

  it("keeps no data on disk, because everything it holds is derivable", () => {
    // Token buckets refill, permits expire, cache entries have a TTL. A disk
    // write per rate-limit check would be the slowest thing in the request
    // path, for data whose worst-case loss is one refilled bucket.
    const command = JSON.stringify(redis()?.command ?? []);
    expect(command).toContain("--appendonly");
    expect(command).toContain("--save");
    expect(compose.volumes ?? {}).not.toHaveProperty("redis-data");
  });

  it("evicts by TTL rather than refusing writes when it fills up", () => {
    // The default `noeviction` turns a full Redis into a rate limiter that
    // errors instead of limiting. Every key here carries a TTL, so evicting
    // the nearest-to-expiry is the right answer under pressure.
    const command = JSON.stringify(redis()?.command ?? []);
    expect(command).toContain("volatile-ttl");
    expect(command).toContain("--maxmemory");
  });

  it("is not published to the host", () => {
    // An unauthenticated Redis on a host port is a well-known way to lose a box.
    expect(redis()?.ports).toBeUndefined();
  });

  it("drops every capability and gains no privileges", () => {
    expect(redis()?.security_opt).toContain("no-new-privileges:true");
    expect(redis()?.cap_drop).toContain("ALL");
  });

  it("is reachable by the services that need it, by service name", () => {
    const composeText = readFileSync(composePath(), "utf8");
    expect(composeText).toContain("REDIS_URL: redis://redis:6379");
  });
});

describe("compose: hardening", () => {
  it("runs no service as root", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      if (service.user === undefined) continue;
      expect(service.user, `${name} runs as root`).not.toMatch(/^(0|root)(:|$)/);
    }
  });

  it("gives every application service an explicit non-root user", () => {
    for (const name of NODE_SERVICES) {
      expect(compose.services[name]?.user, `${name} has no user`).toBe("10001:10001");
    }
  });

  it("uses no host networking anywhere", () => {
    // `network_mode: host` would put a bank's services on the host's stack and
    // make every published-port decision in this file meaningless.
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.network_mode, `${name} uses host networking`).toBeUndefined();
    }
  });

  it("runs nothing privileged", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.privileged, `${name} is privileged`).not.toBe(true);
    }
  });

  it("sets no-new-privileges on every service", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.security_opt?.join(), `${name}`).toContain("no-new-privileges:true");
    }
  });

  it("drops all capabilities from the application services", () => {
    for (const name of [...NODE_SERVICES, "studio"]) {
      expect(compose.services[name]?.cap_drop, `${name}`).toContain("ALL");
    }
  });

  it("gives the application services a read-only root filesystem", () => {
    for (const name of [...NODE_SERVICES, "studio"]) {
      expect(compose.services[name]?.read_only, `${name}`).toBe(true);
    }
  });

  it("mounts no docker socket into a service", () => {
    // A mounted docker socket is root on the host, whatever the container's
    // own user is.
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.volumes?.join() ?? "", `${name} mounts the docker socket`).not.toContain(
        "docker.sock",
      );
    }
  });
});

describe("compose: secrets", () => {
  const raw = readFileSync(composePath(), "utf8");

  it("binds the BFF host explicitly rather than inheriting a default", () => {
    // `EnvSchema` defaults BFF_HOST to loopback on purpose, so a service that
    // listens on every interface must say so where somebody can read it.
    expect(compose.services["bff"]?.environment?.["BFF_HOST"]).toBe("0.0.0.0");
  });

  it("passes secret values through interpolation, never as literals", () => {
    for (const line of raw.split("\n")) {
      // Assignments only — a comment mentioning the variable is documentation,
      // not a value.
      const match = /^\s*(MAESTRO_SECRET_[A-Z0-9_]+)\s*:\s*(.+)$/.exec(line);
      if (match === null) continue;
      expect(match[2]?.trim(), `literal secret in compose.yaml: ${match[1]}`).toMatch(/^\$\{.*\}$/);
    }
  });

  it("carries no private key or bearer token", () => {
    expect(raw).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(raw).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{16,}/);
  });

  it("keeps the only committed password local-only and overridable", () => {
    // The Postgres password is reachable only inside the compose network and
    // must stay overridable from the environment.
    expect(raw).toContain("${POSTGRES_PASSWORD:-DEGISTIR-parola-uret-openssl-rand-hex-24}");
  });
});

describe("deployment artefacts", () => {
  it("references Dockerfiles that exist", () => {
    for (const service of Object.values(compose.services)) {
      const dockerfile = service.build?.dockerfile;
      if (dockerfile === undefined) continue;
      const name = dockerfile.replace(/^deploy\/docker\//, "");
      expect(() => readFileSync(dockerfilePath(name), "utf8")).not.toThrow();
    }
  });

  /**
   * The entrypoints compose names are COMPILED paths (`dist/bin/*.js`), and
   * `dist/` exists only after a build — inside the image, or after
   * `node scripts/build-dist.mjs`. Asserting the compiled file is present
   * would make this suite pass or fail on whether someone had built recently,
   * which is a test of the working tree rather than of the compose file.
   *
   * So the assertion is made against the SOURCE each entrypoint is compiled
   * from. That still catches the mistake this test exists for — a compose file
   * naming an entrypoint that does not exist, or left behind when one is
   * renamed — and it catches it in a tree that has never been built.
   */
  it("points each Node service at an entrypoint whose source exists", () => {
    for (const name of NODE_SERVICES) {
      const script = compose.services[name]?.build?.args?.["ENTRYPOINT_SCRIPT"];
      expect(script, `${name} names no entrypoint`).toBeTruthy();
      expect(script, `${script} is not a compiled entrypoint`).toMatch(/^apps\/\w+\/dist\/.+\.js$/);
      const source = (script as string).replace("/dist/", "/src/").replace(/\.js$/, ".ts");
      const path = new URL(`../../../${source}`, import.meta.url);
      expect(() => readFileSync(path, "utf8"), `${source} does not exist`).not.toThrow();
    }
  });

  it("ships a .env.example that documents every variable compose interpolates", () => {
    const example = readFileSync(envExamplePath(), "utf8");
    const composeText = readFileSync(composePath(), "utf8");
    const referenced = new Set(
      [...composeText.matchAll(/\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/g)].map((match) => match[1] as string),
    );
    const undocumented = [...referenced].filter((name) => !example.includes(name));
    expect(undocumented, `undocumented in .env.example: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("puts no real credential in .env.example", () => {
    const example = readFileSync(envExamplePath(), "utf8");
    // Every MAESTRO_SECRET_* line must be commented out or empty.
    for (const line of example.split("\n")) {
      const match = /^\s*(MAESTRO_SECRET_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      expect(match[2], `${match[1]} has a value in .env.example`).toBe("");
    }
    expect(example).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});

describe("Dockerfiles", () => {
  const node = readFileSync(dockerfilePath("Dockerfile.node"), "utf8");
  const studio = readFileSync(dockerfilePath("Dockerfile.studio"), "utf8");

  it("drops to a non-root user in the Node image", () => {
    expect(node).toMatch(/USER\s+10001:10001/);
    // And the last USER instruction must be the unprivileged one.
    const users = [...node.matchAll(/^USER\s+(.+)$/gm)].map((match) => match[1]?.trim());
    expect(users.at(-1)).toBe("10001:10001");
  });

  it("keeps the Node image multi-stage with a separate dependency layer", () => {
    expect(node).toMatch(/FROM .* AS deps/);
    expect(node).toMatch(/FROM .* AS runner/);
    // The dependency layer must copy manifests before sources, or every source
    // edit re-resolves the whole workspace.
    expect(node.indexOf("COPY pnpm-lock.yaml")).toBeLessThan(node.indexOf("COPY . ."));
  });

  it("installs from the lockfile without letting the build rewrite it", () => {
    expect(node).toContain("--frozen-lockfile");
  });

  it("execs the entrypoint so PID 1 receives SIGTERM", () => {
    // Without the exec, the shell is PID 1, the drain never runs, and a
    // rolling deploy drops in-flight webhooks.
    expect(node).toMatch(/exec node/);
  });

  it("serves studio from an unprivileged nginx on a high port", () => {
    expect(studio).toMatch(/nginx-unprivileged/);
    expect(studio).toMatch(/USER\s+101:101/);
    expect(studio).toContain("EXPOSE 8080");
  });
});

/**
 * What the build is allowed to SEE.
 *
 * `maestro/node:canli-a564f6d` shipped `/app/deploy/.env` — 18 KB, untracked,
 * no placeholder left in it, i.e. a developer's real credentials, inside an
 * image built to be carried into a bank on a USB stick. The rule meant to stop
 * that read `.env`, and a `.dockerignore` pattern with no slash matches only at
 * the CONTEXT ROOT, so it never looked at `deploy/`.
 *
 * Nothing in the image tells you this: the file is only visible by listing a
 * BUILT image, which is how it was found and not something CI does. So the
 * pattern itself is what gets asserted — cheap, and it fails at the moment
 * somebody narrows it back.
 */
describe(".dockerignore", () => {
  const ignore = readFileSync(dockerignorePath(), "utf8");
  const patterns = ignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  it("excludes env files at EVERY depth, not just the context root", () => {
    expect(patterns).toContain("**/.env");
    expect(patterns).toContain("**/.env.*");
  });

  it("keeps no allow-list entry that would let one back in", () => {
    // A `!` line re-includes a path the patterns above just excluded. Neither
    // Dockerfile copies an env file, so any exception here is a hole with no
    // caller — and `!deploy/.env.example` was one character away from
    // `!deploy/.env`.
    const reincluded = patterns.filter((p) => p.startsWith("!") && p.includes(".env"));
    expect(reincluded).toEqual([]);
  });

  it("excludes the git directory, which carries every secret ever committed", () => {
    expect(patterns).toContain(".git");
  });
});
