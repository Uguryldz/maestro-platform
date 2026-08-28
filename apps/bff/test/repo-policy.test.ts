import { DEFAULT_PROTECTED_PATHS } from "@maestro/execution";
import { describe, expect, it } from "vitest";
import type { RepoPolicyRecord } from "../src/onboarding-models.js";
import { harness, type Harness } from "./helpers.js";

/**
 * `.maestro.yaml` and the M52 deny-list.
 *
 * The property under test throughout is the FLOOR: `DEFAULT_PROTECTED_PATHS`
 * covers migrations, CI definitions, git hooks and secret material, and a repo
 * may add to it and may never shrink it. A repo that could delete one of these
 * could hand an agent write access to the build machine before any human gate,
 * so every route below is checked for the refusal rather than for the success.
 */

const POLICIES: readonly RepoPolicyRecord[] = [
  {
    appId: "ugurpay",
    platform: "linux-node",
    repo: "Odeme/_git/ugurpay",
    yamlPresent: true,
    repoAdditions: ["src/payment-core/**"],
    verification: [
      { name: "lint", command: ["pnpm", "lint"] },
      { name: "test", command: ["pnpm", "test"] },
    ],
    observedAt: "2026-08-08T10:00:00.000Z",
  },
  {
    // Never cloned: the platform has no copy of this repo's policy file.
    appId: "cards",
    platform: "linux-java",
    repo: "Kart/_git/cards",
    yamlPresent: false,
    repoAdditions: [],
    verification: [],
    observedAt: null,
  },
];

async function policyApp(): Promise<Harness> {
  return harness({ policies: POLICIES });
}

async function adminToken(app: Harness): Promise<string> {
  await app.addUser({ username: "ayse.kaya", roles: ["admin"], groups: ["maestro-admins"] });
  return app.login("ayse.kaya");
}

describe("GET /repo-policy", () => {
  it("returns every application, with the platform floor spelled out separately", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "GET",
      url: "/repo-policy",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const { policies } = response.json();
    expect(policies).toHaveLength(2);

    const [first] = policies;
    expect(first.appId).toBe("ugurpay");
    expect(first.repo).toBe("Odeme/_git/ugurpay");
    expect(first.fetchedAt).toBe("2026-08-08T10:00:00.000Z");
    // The two halves are separate, and the defaults are the platform's own
    // list rather than a copy that could drift from what the runner enforces.
    expect(first.protectedPaths.repoAdditions).toEqual(["src/payment-core/**"]);
    expect([...first.protectedPaths.platformDefaults].sort()).toEqual(
      [...DEFAULT_PROTECTED_PATHS].sort(),
    );
  });

  it("renders the observed commands, and says so when nothing was observed", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "GET",
      url: "/repo-policy",
      headers: { authorization: `Bearer ${token}` },
    });

    const { policies } = response.json();
    expect(policies[0].yaml).toContain("pnpm");
    expect(policies[0].yaml).toContain("lint");
    expect(policies[0].yamlPresent).toBe(true);

    // The app whose file was never read sends the FACT, not an explanation.
    // It used to render six lines of English YAML comments, which landed
    // untranslated on a Turkish screen; the screen now writes that sentence
    // from its own catalog (`yaml.absent.*`). Empty is not "we invented an
    // empty config" — `yamlPresent: false` is what says which it is.
    expect(policies[1].yamlPresent).toBe(false);
    expect(policies[1].yaml).toBe("");
    expect(policies[1].yaml).not.toContain("pnpm");
  });

  it("refuses a developer", async () => {
    const app = await policyApp();
    await app.addUser({ username: "dev", roles: ["developer"] });
    const token = await app.login("dev");

    const response = await app.app.inject({
      method: "GET",
      url: "/repo-policy",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses an anonymous caller", async () => {
    const app = await policyApp();
    const response = await app.app.inject({ method: "GET", url: "/repo-policy" });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /repo-policy/:appId", () => {
  it("404s an application that is not in the registry", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "GET",
      url: "/repo-policy/nosuchapp",
      headers: { authorization: `Bearer ${token}` },
    });

    // Not an empty policy: an empty deny-list would read as "nothing is
    // protected here" for an application that does not exist.
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("unknown_app");
  });
});

describe("POST /repo-policy/:appId/protected-paths", () => {
  it("adds a repo pattern and returns the widened list", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/repo-policy/ugurpay/protected-paths",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: "src/ledger/**" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().protectedPaths.repoAdditions).toEqual([
      "src/payment-core/**",
      "src/ledger/**",
    ]);
  });

  it("keeps the addition visible on the NEXT read", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    await app.app.inject({
      method: "POST",
      url: "/repo-policy/ugurpay/protected-paths",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: "src/ledger/**" },
    });

    // The write goes to the parameter store and the read comes from the run
    // column; if the two are not joined, the operator adds a path, the list
    // re-renders without it, and a failed write is indistinguishable from a
    // refused one.
    const one = await app.app.inject({
      method: "GET",
      url: "/repo-policy/ugurpay",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(one.json().protectedPaths.repoAdditions).toContain("src/ledger/**");

    const all = await app.app.inject({
      method: "GET",
      url: "/repo-policy",
      headers: { authorization: `Bearer ${token}` },
    });
    const ugurpay = all
      .json()
      .policies.find((policy: { appId: string }) => policy.appId === "ugurpay");
    expect(ugurpay.protectedPaths.repoAdditions).toContain("src/ledger/**");
  });

  it("refuses a pattern the matcher cannot compile", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/repo-policy/ugurpay/protected-paths",
      headers: { authorization: `Bearer ${token}` },
      // Brace expansion is not in the supported subset. A pattern that compiled
      // to a literal `{sql,ddl}` would match no file and read as protection.
      payload: { path: "db/*.{sql,ddl}" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_path_pattern");
  });

  it("refuses an absolute path", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/repo-policy/ugurpay/protected-paths",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: "/etc/passwd" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a duplicate", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/repo-policy/ugurpay/protected-paths",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: "src/payment-core/**" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("protected_path_exists");
  });

  it("refuses a repo-owned COPY of a platform default", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/repo-policy/ugurpay/protected-paths",
      headers: { authorization: `Bearer ${token}` },
      // Accepting this would create an addition the DELETE path would happily
      // remove, leaving the operator believing they removed the default.
      payload: { path: "**/migrations/**" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("protected_path_is_default");
  });

  it("refuses while the kill switch is on (M58)", async () => {
    const app = await policyApp();
    const token = await adminToken(app);
    await app.killSwitch.set({
      level: "intake_only",
      actor: "ops@corp",
      reason: "incident",
      at: "2026-08-09T09:00:00.000Z",
    });

    const response = await app.app.inject({
      method: "POST",
      url: "/repo-policy/ugurpay/protected-paths",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: "src/ledger/**" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("kill_switch");
  });

  it("refuses a developer", async () => {
    const app = await policyApp();
    await app.addUser({ username: "dev", roles: ["developer"] });
    const token = await app.login("dev");

    const response = await app.app.inject({
      method: "POST",
      url: "/repo-policy/ugurpay/protected-paths",
      headers: { authorization: `Bearer ${token}` },
      payload: { path: "src/ledger/**" },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("DELETE /repo-policy/:appId/protected-paths/:path", () => {
  it("removes a repo addition", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "DELETE",
      url: `/repo-policy/ugurpay/protected-paths/${encodeURIComponent("src/payment-core/**")}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().protectedPaths.repoAdditions).toEqual([]);
  });

  it("keeps the removal visible on the NEXT read", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    await app.app.inject({
      method: "DELETE",
      url: `/repo-policy/ugurpay/protected-paths/${encodeURIComponent("src/payment-core/**")}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const after = await app.app.inject({
      method: "GET",
      url: "/repo-policy/ugurpay",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.json().protectedPaths.repoAdditions).toEqual([]);
  });

  it("REFUSES to remove a platform default", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    for (const path of ["**/migrations/**", "**/.git/**", "**/*.pem", "**/.maestro.y*ml"]) {
      const response = await app.app.inject({
        method: "DELETE",
        url: `/repo-policy/ugurpay/protected-paths/${encodeURIComponent(path)}`,
        headers: { authorization: `Bearer ${token}` },
      });

      // A 409 naming the path, never a silent no-op: a caller that believes it
      // removed a guard and did not is worse off than one that was told no.
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("protected_path_is_default");
    }

    // And the floor is intact afterwards.
    const after = await app.app.inject({
      method: "GET",
      url: "/repo-policy/ugurpay",
      headers: { authorization: `Bearer ${token}` },
    });
    expect([...after.json().protectedPaths.platformDefaults].sort()).toEqual(
      [...DEFAULT_PROTECTED_PATHS].sort(),
    );
  });

  it("refuses a path that is not in the list", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "DELETE",
      url: `/repo-policy/ugurpay/protected-paths/${encodeURIComponent("src/never-added/**")}`,
      headers: { authorization: `Bearer ${token}` },
    });

    // Answering 200 would confirm a deletion that never happened.
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("protected_path_unknown");
  });

  it("refuses while the kill switch is on", async () => {
    const app = await policyApp();
    const token = await adminToken(app);
    await app.killSwitch.set({
      level: "all",
      actor: "ops@corp",
      reason: "incident",
      at: "2026-08-09T09:00:00.000Z",
    });

    const response = await app.app.inject({
      method: "DELETE",
      url: `/repo-policy/ugurpay/protected-paths/${encodeURIComponent("src/payment-core/**")}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("kill_switch");
  });

  it("writes an audit record naming who removed what", async () => {
    const app = await policyApp();
    const token = await adminToken(app);

    await app.app.inject({
      method: "DELETE",
      url: `/repo-policy/ugurpay/protected-paths/${encodeURIComponent("src/payment-core/**")}`,
      headers: { authorization: `Bearer ${token}` },
    });

    const events = await app.auditStore.read();
    const entry = events.find((event) => event.subject === "repo-policy:ugurpay");
    expect(entry).toBeDefined();
    expect(entry?.meta).toMatchObject({
      change: "PROTECTED_PATH_REMOVED",
      path: "src/payment-core/**",
    });
  });
});
