import { describe, expect, it } from "vitest";
import {
  compileProfile,
  createSession,
  defaultPiiPolicy,
  DETECTOR_TYPES,
  DETECTORS,
  loadPiiPolicy,
  maskText,
  PiiPolicyError,
  resolveProfile,
  STRICTEST_CLASS,
  type PiiBoundaryOptions,
  type PiiPolicy,
} from "../src/index.js";

const ACCOUNT_PATTERN = { name: "customer-no", pattern: "\\bMST-[0-9]{8}\\b" };

function policyWithAccounts() {
  const base = defaultPiiPolicy();
  return loadPiiPolicy({
    profiles: {
      acik: base.profiles.acik,
      dahili: { ...base.profiles.dahili, accountPatterns: [ACCOUNT_PATTERN] },
      gizli: { ...base.profiles.gizli, accountPatterns: [ACCOUNT_PATTERN] },
    },
  });
}

describe("detector registry", () => {
  it("has exactly one detector per declared type", () => {
    expect(Object.keys(DETECTORS).sort()).toEqual([...DETECTOR_TYPES].sort());
    for (const type of DETECTOR_TYPES) expect(DETECTORS[type].type).toBe(type);
  });
});

describe("policy loading", () => {
  it("accepts the shipped default", () => {
    expect(() => loadPiiPolicy(defaultPiiPolicy())).not.toThrow();
  });

  it("refuses a strictest profile that does not cover every detector", () => {
    const weak = structuredClone(defaultPiiPolicy()) as PiiPolicy;
    weak.profiles.gizli.types = ["email"];
    expect(() => loadPiiPolicy(weak)).toThrow(PiiPolicyError);
    expect(() => loadPiiPolicy(weak)).toThrow(/must enable every detector/);
  });

  it("refuses a malformed document instead of masking nothing", () => {
    expect(() => loadPiiPolicy({})).toThrow(PiiPolicyError);
    expect(() => loadPiiPolicy({ profiles: { acik: { types: [] } } })).toThrow(PiiPolicyError);
  });

  it("compiles account patterns eagerly so a broken regex fails at load", () => {
    const broken = structuredClone(defaultPiiPolicy()) as PiiPolicy;
    broken.profiles.dahili.accountPatterns = [{ name: "bad", pattern: "MST-([0-9]" }];
    broken.profiles.gizli.accountPatterns = [{ name: "bad", pattern: "MST-([0-9]" }];
    expect(() => loadPiiPolicy(broken)).toThrow(PiiPolicyError);
  });
});

describe("a loaded policy is the only policy (B-7)", () => {
  it("cannot be replaced by a hand-written object at the boundary", () => {
    const handWritten = {
      profiles: {
        acik: { types: ["email"], accountPatterns: [], fieldRules: [] },
        dahili: { types: ["email"], accountPatterns: [], fieldRules: [] },
        gizli: { types: ["email"], accountPatterns: [], fieldRules: [] },
      },
    } as const;
    // @ts-expect-error only loadPiiPolicy mints a LoadedPiiPolicy — a literal
    // that skips its fail-closed rules must not compile.
    const options: PiiBoundaryOptions = { policy: handWritten, dataClass: "gizli" };
    expect(options.dataClass).toBe("gizli");
  });

  it("is frozen, so gizli cannot be weakened after it was checked", () => {
    const loaded = loadPiiPolicy(defaultPiiPolicy());
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.profiles.gizli)).toBe(true);
    expect(Object.isFrozen(loaded.profiles.gizli.types)).toBe(true);
    expect(() => {
      (loaded.profiles.gizli as { types: string[] }).types = ["email"];
    }).toThrow(TypeError);
  });

  it("ships a default that is already loaded and frozen", () => {
    expect(Object.isFrozen(defaultPiiPolicy())).toBe(true);
  });
});

describe("a looser class may never mask more than a stricter one (B-6)", () => {
  function withProfiles(mutate: (draft: PiiPolicy) => void) {
    const draft = structuredClone(defaultPiiPolicy()) as PiiPolicy;
    mutate(draft);
    return () => loadPiiPolicy(draft);
  }

  it("refuses a policy where dahili masks less than acik", () => {
    const load = withProfiles((d) => {
      d.profiles.dahili.types = ["email"];
    });
    expect(load).toThrow(PiiPolicyError);
    expect(load).toThrow(/acik/);
  });

  it("refuses a policy where gizli masks less than dahili", () => {
    const load = withProfiles((d) => {
      d.profiles.dahili.fieldRules = ["customerName"];
    });
    expect(load).toThrow(PiiPolicyError);
  });

  it("refuses a class that drops an account pattern a looser class carries", () => {
    const load = withProfiles((d) => {
      d.profiles.acik.accountPatterns = [ACCOUNT_PATTERN];
    });
    expect(load).toThrow(PiiPolicyError);
  });

  it("accepts a policy that only ever masks more as the class gets stricter", () => {
    const load = withProfiles((d) => {
      d.profiles.dahili.fieldRules = ["customerName"];
      d.profiles.gizli.fieldRules = ["customerName", "address"];
    });
    expect(load).not.toThrow();
  });
});

describe("operator patterns are checked for catastrophic backtracking (B-18)", () => {
  function loadWith(pattern: string) {
    const draft = structuredClone(defaultPiiPolicy()) as PiiPolicy;
    const rule = { name: "operator", pattern };
    draft.profiles.acik.accountPatterns = [rule];
    draft.profiles.dahili.accountPatterns = [rule];
    draft.profiles.gizli.accountPatterns = [rule];
    return () => loadPiiPolicy(draft);
  }

  it.each(["(a+)+b", "(MST-[0-9]*)*", "([a-z]+)+@", "(?:[0-9]+)+X"])(
    "refuses the nested quantifier in %s",
    (pattern) => {
      expect(loadWith(pattern)).toThrow(PiiPolicyError);
    },
  );

  it("refuses a pattern long enough to hide anything", () => {
    expect(loadWith(`MST-${"[0-9]".repeat(60)}`)).toThrow(PiiPolicyError);
  });

  it("still accepts the shapes an institution actually declares", () => {
    expect(loadWith("\\bMST-[0-9]{8}\\b")).not.toThrow();
    expect(loadWith("\\b(?:HSP|MST)-[0-9]{6,10}\\b")).not.toThrow();
  });
});

describe("profile resolution is fail-closed (M18/M63)", () => {
  const policy = policyWithAccounts();

  it("uses the declared class when it is one we know", () => {
    expect(resolveProfile(policy, "acik")).toMatchObject({ dataClass: "acik", fellBack: false });
    expect(resolveProfile(policy, "dahili")).toMatchObject({ dataClass: "dahili", fellBack: false });
  });

  it.each([undefined, null, "", "top-secret", 7, {}])(
    "falls back to the strictest profile for %o",
    (input) => {
      const resolved = resolveProfile(policy, input);
      expect(resolved.dataClass).toBe(STRICTEST_CLASS);
      expect(resolved.fellBack).toBe(true);
    },
  );

  it("makes the fallback actually mask more than the public profile", () => {
    const text = "Musteri MST-12345678 kaydi";
    const acik = maskText(text, createSession(resolveProfile(policy, "acik").profile, "t1"));
    const unknown = maskText(text, createSession(resolveProfile(policy, "bilinmiyor").profile, "t1"));
    expect(acik.text).toBe(text);
    expect(unknown.text).toBe("Musteri [ACCT_1.t1] kaydi");
  });
});

describe("profile compilation", () => {
  it("selects only the enabled detectors, in priority order", () => {
    const compiled = compileProfile({ types: ["email", "iban"], accountPatterns: [], fieldRules: [] });
    expect(compiled.detectors.map((d) => d.type)).toEqual(["iban", "email"]);
  });

  it("lower-cases field rules so field matching is case-insensitive", () => {
    const compiled = compileProfile({ types: ["email"], accountPatterns: [], fieldRules: ["Customer_Name"] });
    expect(compiled.fieldRules.has("customer_name")).toBe(true);
  });
});
