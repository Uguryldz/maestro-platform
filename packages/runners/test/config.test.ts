import { afterEach, describe, expect, it } from "vitest";
import {
  DockerRunnerConfig,
  ImageRef,
  isProductionStage,
  profileIssues,
  SandboxProfile,
} from "../src/config.js";
import { TEST_CONFIG, TEST_IMAGE } from "./helpers.js";

const AMBIENT = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = AMBIENT;
});

function withStage<T>(stage: string | undefined, body: () => T): T {
  const previous = process.env.NODE_ENV;
  if (stage === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = stage;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

describe("the default profile is the strictest one (M23)", () => {
  it("hardens everything a config that says nothing", () => {
    const sandbox = SandboxProfile.parse({});

    expect(sandbox).toMatchObject({
      readonlyRootfs: true,
      noNewPrivileges: true,
      user: "10001:10001",
      capAdd: [],
      seccomp: "default",
      allowUnsafeProfile: [],
    });
    expect(sandbox.memoryMb).toBe(2_048);
    expect(sandbox.pidsLimit).toBe(256);
    expect(sandbox.cpus).toBe(2);
    expect(sandbox.tmpfsMb).toBe(512);
  });

  it("gives a minimal config a NO-network default — nothing leaves without a proxy (M26)", () => {
    const config = DockerRunnerConfig.parse({ platforms: { "linux-node": { image: TEST_IMAGE } } });

    expect(config.egress.networkName).toBeUndefined();
    expect(config.egress.proxyUrl).toBeUndefined();
    expect(config.workspace.cacheReadOnly).toBe(true);
    expect(config.workspace.maxAgeDays).toBe(60);
    expect(config.maxTimeoutSeconds).toBe(3_600);
    expect(config.platforms["linux-node"]?.capacity).toBe(1);
  });

  it("rejects a config with no platform at all", () => {
    expect(DockerRunnerConfig.safeParse({ platforms: {} }).success).toBe(false);
  });

  it("rejects unknown platforms — mac/win are served by the agent driver (M21)", () => {
    const parsed = DockerRunnerConfig.safeParse({ platforms: { "macos-xcode": { image: TEST_IMAGE } } });

    expect(parsed.success).toBe(false);
  });

  it("caps the limits so a typo cannot hand a job the whole host", () => {
    const over = { platforms: { "linux-node": { image: TEST_IMAGE } }, sandbox: { memoryMb: 999_999 } };

    expect(DockerRunnerConfig.safeParse(over).success).toBe(false);
    expect(SandboxProfile.safeParse({ cpus: 128 }).success).toBe(false);
    expect(SandboxProfile.safeParse({ pidsLimit: 100_000 }).success).toBe(false);
  });
});

describe("digest pinning (M27)", () => {
  it("accepts a repo@sha256 reference and a bare image id", () => {
    expect(ImageRef.safeParse(TEST_IMAGE).success).toBe(true);
    expect(ImageRef.safeParse(`sha256:${"c".repeat(64)}`).success).toBe(true);
    expect(ImageRef.safeParse(`registry.bank:5000/team/img@sha256:${"d".repeat(64)}`).success).toBe(true);
  });

  it("refuses every mutable reference", () => {
    for (const mutable of ["node:22", "node:22-alpine", "node", "registry/team/node:latest", "node@sha256:short"]) {
      expect(ImageRef.safeParse(mutable).success).toBe(false);
    }
  });

  // `repo:tag@sha256:…` is legal and the digest decides, so it is accepted —
  // but on the REPOSITORY, not only where the old pattern happened to read the
  // tag as a registry port.
  it("accepts a tag that is pinned by a digest, wherever the tag sits", () => {
    const digest = `sha256:${"e".repeat(64)}`;

    expect(ImageRef.safeParse(`node:22@${digest}`).success).toBe(true);
    expect(ImageRef.safeParse(`registry.bank:5000/team/img:22-alpine@${digest}`).success).toBe(true);
    expect(ImageRef.safeParse(`registry.bank/team/img:latest@${digest}`).success).toBe(true);
    expect(ImageRef.safeParse(`node:22@sha256:${"E".repeat(64)}`).success).toBe(false);
    expect(ImageRef.safeParse(`node:22:33@${digest}`).success).toBe(false);
  });
});

describe("weakening the profile is explicit, and impossible in production", () => {
  it("refuses a relaxation that is not named in allowUnsafeProfile", () => {
    const config = { ...TEST_CONFIG, sandbox: { readonlyRootfs: false } };

    withStage("test", () => {
      const parsed = DockerRunnerConfig.safeParse(config);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("allowUnsafeProfile");
    });
  });

  it("accepts it once the operator names it, outside production", () => {
    withStage("development", () => {
      const parsed = DockerRunnerConfig.safeParse({
        ...TEST_CONFIG,
        sandbox: { readonlyRootfs: false, allowUnsafeProfile: ["readonly-rootfs"] },
      });
      expect(parsed.success).toBe(true);
    });
  });

  it("closes the escape hatch in production for every switch", () => {
    const relaxations = [
      { sandbox: { readonlyRootfs: false, allowUnsafeProfile: ["readonly-rootfs"] } },
      { sandbox: { noNewPrivileges: false, allowUnsafeProfile: ["no-new-privileges"] } },
      { sandbox: { capAdd: ["SYS_ADMIN"], allowUnsafeProfile: ["cap-add"] } },
      { sandbox: { seccomp: "unconfined", allowUnsafeProfile: ["seccomp"] } },
    ];

    withStage("production", () => {
      for (const relaxation of relaxations) {
        expect(DockerRunnerConfig.safeParse({ ...TEST_CONFIG, ...relaxation }).success).toBe(false);
      }
      expect(DockerRunnerConfig.safeParse(TEST_CONFIG).success).toBe(true);
    });
  });

  it("never allows uid 0 — not even with the escape hatch, not even in dev", () => {
    withStage("development", () => {
      const parsed = DockerRunnerConfig.safeParse({
        ...TEST_CONFIG,
        sandbox: { user: "0:0", allowUnsafeProfile: ["readonly-rootfs", "no-new-privileges", "cap-add", "seccomp"] },
      });

      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("uid/gid 0");
    });
  });

  // Docker parses the user field NUMERICALLY: "00", "000000" and " 0" are all
  // uid 0 to the daemon, so a `startsWith("0:")` string test waves root
  // straight through the gate it was written to close.
  it("refuses every spelling of uid 0 that Docker resolves to root", () => {
    for (const user of ["00:0", "000000:0", "0:0", "00:10001", "0:10001", " 0:0", "+0:0", "0x0:0"]) {
      withStage("production", () => {
        const production = DockerRunnerConfig.safeParse({ ...TEST_CONFIG, sandbox: { user } });
        expect(production.success, `production accepted user "${user}"`).toBe(false);
      });
      withStage("development", () => {
        const development = DockerRunnerConfig.safeParse({
          ...TEST_CONFIG,
          sandbox: { user, allowUnsafeProfile: ["readonly-rootfs", "no-new-privileges", "cap-add", "seccomp"] },
        });
        expect(development.success, `development accepted user "${user}"`).toBe(false);
      });
    }
  });

  it("refuses gid 0 as well — the root group owns the host's device nodes", () => {
    withStage("test", () => {
      expect(DockerRunnerConfig.safeParse({ ...TEST_CONFIG, sandbox: { user: "10001:0" } }).success).toBe(false);
      expect(DockerRunnerConfig.safeParse({ ...TEST_CONFIG, sandbox: { user: "10001:00" } }).success).toBe(false);
      expect(DockerRunnerConfig.safeParse({ ...TEST_CONFIG, sandbox: { user: "10001:10001" } }).success).toBe(true);
    });
  });

  it("refuses a user field Docker would read differently than we do", () => {
    for (const user of ["10001", "10001:", ":10001", "node:node", "10001:10001:10001", "010001:10001", ""]) {
      expect(SandboxProfile.safeParse({ user }).success, `accepted user "${user}"`).toBe(false);
    }
  });
});

describe("the egress network is a name, never a namespace escape (M26)", () => {
  it("refuses the daemon's magic network names in every stage", () => {
    const reserved = ["host", "none", "bridge", "default", "container:9f3a", "container:other-job", "HOST"];

    for (const networkName of reserved) {
      for (const stage of ["production", "development", "test", undefined]) {
        withStage(stage, () => {
          const parsed = DockerRunnerConfig.safeParse({
            ...TEST_CONFIG,
            egress: { networkName, proxyUrl: "http://egress.internal.bank:3128" },
          });
          expect(parsed.success, `stage=${String(stage)} accepted network "${networkName}"`).toBe(false);
        });
      }
    }
  });

  it("refuses a network name that is not a plain docker name", () => {
    for (const networkName of ["maestro egress", "../etc", "maestro:egress", "-leading-dash", "MaestroEgress"]) {
      const parsed = DockerRunnerConfig.safeParse({
        ...TEST_CONFIG,
        egress: { networkName, proxyUrl: "http://egress.internal.bank:3128" },
      });
      expect(parsed.success, `accepted network "${networkName}"`).toBe(false);
    }
  });

  it("accepts an ordinary project network name", () => {
    withStage("production", () => {
      expect(DockerRunnerConfig.safeParse(TEST_CONFIG).success).toBe(true);
    });
  });
});

describe("the container runtime is an allow-list (M23 stage 3)", () => {
  it("accepts only runc and runsc", () => {
    expect(SandboxProfile.safeParse({ runtime: "runsc" }).success).toBe(true);
    expect(SandboxProfile.safeParse({ runtime: "runc" }).success).toBe(true);
    for (const runtime of ["sysbox-runc", "nvidia", "../../bin/sh", ""]) {
      expect(SandboxProfile.safeParse({ runtime }).success, `accepted runtime "${runtime}"`).toBe(false);
    }
  });
});

describe("more gate rules", () => {

  it("refuses a network without an egress proxy — unmonitored egress (M26)", () => {
    withStage("test", () => {
      const parsed = DockerRunnerConfig.safeParse({
        platforms: TEST_CONFIG.platforms,
        egress: { networkName: "maestro-egress" },
      });

      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("direct-egress");
    });
  });

  /**
   * Y1: a container deployment that never sets NODE_ENV must not thereby open
   * the escape hatch. Only the two values that NAME a non-production stage turn
   * the gate off; everything else — unset, empty, misspelt — is production.
   */
  it("treats an unrecognised, unset or empty NODE_ENV as production (fail-closed)", () => {
    expect(withStage("prod", isProductionStage)).toBe(true);
    expect(withStage("staging", isProductionStage)).toBe(true);
    expect(withStage("Production", isProductionStage)).toBe(true);
    expect(withStage(undefined, isProductionStage)).toBe(true);
    expect(withStage("", isProductionStage)).toBe(true);
    expect(withStage("   ", isProductionStage)).toBe(true);
    expect(withStage("development", isProductionStage)).toBe(false);
    expect(withStage("DEVELOPMENT", isProductionStage)).toBe(false);
    expect(withStage("test", isProductionStage)).toBe(false);
    expect(withStage(" test ", isProductionStage)).toBe(false);
  });

  it("closes the escape hatch when NODE_ENV is not set at all (Y1)", () => {
    const escapeKit = {
      ...TEST_CONFIG,
      sandbox: {
        capAdd: ["SYS_ADMIN", "SYS_PTRACE", "DAC_OVERRIDE", "MKNOD"],
        readonlyRootfs: false,
        noNewPrivileges: false,
        seccomp: "unconfined",
        allowUnsafeProfile: ["cap-add", "readonly-rootfs", "no-new-privileges", "seccomp"],
      },
    };

    withStage(undefined, () => {
      expect(DockerRunnerConfig.safeParse(escapeKit).success).toBe(false);
    });
    withStage("", () => {
      expect(DockerRunnerConfig.safeParse(escapeKit).success).toBe(false);
    });
    withStage("development", () => {
      expect(DockerRunnerConfig.safeParse(escapeKit).success).toBe(true);
    });
  });

  it("reports every offending switch at once, not just the first", () => {
    const issues = profileIssues(
      {
        platforms: { "linux-node": {} },
        sandbox: SandboxProfile.parse({ readonlyRootfs: false, noNewPrivileges: false, capAdd: ["SYS_ADMIN"] }),
        egress: { noProxy: [] },
      },
      { NODE_ENV: "test" },
    );

    expect(issues).toHaveLength(3);
  });
});
