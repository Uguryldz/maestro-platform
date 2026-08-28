import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  compileProfile,
  compiledProfileFor,
  defaultPiiPolicy,
  guardEgress,
  loadPiiPolicy,
  maskOutbound,
  PiiLeakError,
  withPiiBoundary,
  type LoadedPiiPolicy,
  type Masked,
  type MaskedInfo,
  type OutboundCall,
} from "../src/index.js";
import { makeTckn, SAMPLE_TCKN } from "./synthetic.js";

/**
 * The gate itself (verifier B-5 / B-6 / B-10 / B-11 / B-12). Every test here
 * stands for a way the previous version could be walked around: a cast, a
 * JSON round-trip, a spread, a declared data class, a PII-bearing object key,
 * the return leg, and a logger reaching the revealed output.
 */

interface Prompt {
  readonly instruction: string;
  readonly ticket: { readonly description: string };
}

const policy: LoadedPiiPolicy = loadPiiPolicy(defaultPiiPolicy());
const OTHER_TCKN = makeTckn("765432198");

function prompt(): Prompt {
  return {
    instruction: "Ozetle",
    ticket: { description: `Musteri TCKN ${SAMPLE_TCKN} ile ali@banka.com.tr adresinden yazdi.` },
  };
}

const gateway: OutboundCall<Prompt, string> = (payload) =>
  Promise.resolve(`Cagri gonderildi: ${JSON.stringify(payload)}`);

const strict = compiledProfileFor(policy, "gizli").profile;

describe("the masked envelope is nominal (B-5)", () => {
  it("refuses a raw payload, a webhook body and a JSON round-trip alike", async () => {
    const guarded = guardEgress<Prompt, string>({ profile: strict, boundary: "llm" }, gateway);

    // @ts-expect-error a raw payload is not an envelope — this must not compile.
    await expect(guarded(prompt())).rejects.toBeInstanceOf(PiiLeakError);

    // The two shapes that used to slip past the old intersection brand for
    // free: anything typed `any`. A webhook body, `res.json()` and a Prisma
    // `Json` column all arrive exactly like this.
    const webhookBody: Masked<Prompt> = JSON.parse(JSON.stringify(prompt())) as Masked<Prompt>;
    await expect(guarded(webhookBody)).rejects.toBeInstanceOf(PiiLeakError);
  });

  it("refuses a spread of a real envelope, which used to keep the brand", async () => {
    const guarded = guardEgress<Prompt, string>({ profile: strict }, gateway);
    const { envelope } = maskOutbound(prompt(), { policy, dataClass: "gizli" });
    const spread = { ...envelope } as Masked<Prompt>;
    await expect(guarded(spread)).rejects.toBeInstanceOf(PiiLeakError);
  });

  it("lets a real envelope through and serialises to the masked payload", async () => {
    const guarded = guardEgress<Prompt, string>({ profile: strict }, gateway);
    const { envelope } = maskOutbound(prompt(), { policy, dataClass: "gizli" });
    const sent = await guarded(envelope);
    expect(sent).toMatch(/\[TCKN_1\.[0-9a-f]{8}\]/);
    expect(sent).not.toContain(SAMPLE_TCKN);
    expect(envelope.value.ticket.description).not.toContain(SAMPLE_TCKN);
  });
});

describe("the egress guard uses the profile the masker used (B-6)", () => {
  it("catches PII the weak profile did not mask, whatever class was declared", async () => {
    const weakPolicy = loadPiiPolicy({
      profiles: {
        acik: { types: ["email"] },
        dahili: { types: ["email"] },
        gizli: { types: [...defaultPiiPolicy().profiles.gizli.types] },
      },
    });
    // A caller who believes an attacker-supplied "acik" masks almost nothing…
    const { envelope, profile } = maskOutbound(prompt(), { policy: weakPolicy, dataClass: "acik" });
    expect(envelope.value.ticket.description).toContain(SAMPLE_TCKN);

    // …still cannot ship it past a guard installed with the strict profile.
    const guarded = guardEgress<Prompt, string>({ profile: strict, boundary: "llm" }, gateway);
    await expect(guarded(envelope)).rejects.toBeInstanceOf(PiiLeakError);

    // And the guard the masker's own profile produces agrees with the masker,
    // which is the point: the guard never re-resolves an untrusted class.
    const sameProfile = guardEgress<Prompt, string>({ profile }, gateway);
    await expect(sameProfile(envelope)).resolves.toContain(SAMPLE_TCKN);
  });

  it("names the types and the count but never the values", async () => {
    const guarded = guardEgress<Prompt, string>({ profile: strict, boundary: "llm" }, gateway);
    const weak = compileProfile({ types: ["account"], accountPatterns: [], fieldRules: [] });
    const { envelope } = maskOutbound(prompt(), { policy, dataClass: "gizli" });
    expect(weak.detectors).toHaveLength(1);

    let caught: PiiLeakError | undefined;
    try {
      await guarded({ ...envelope } as Masked<Prompt>);
    } catch (e) {
      caught = e as PiiLeakError;
    }
    expect(caught).toBeInstanceOf(PiiLeakError);
    expect(caught?.message).not.toContain(SAMPLE_TCKN);
  });
});

describe("the tripwire earns its place (B-10)", () => {
  it("fires on PII the masker structurally cannot rewrite: an object key", () => {
    // `{ "12345678950": … }` is an ordinary shape for a per-customer map, and
    // masking rewrites values, not keys. Refusing is the fail-closed answer;
    // deleting the assertNoPii call in maskOutbound makes this test red.
    expect(() => maskOutbound({ [SAMPLE_TCKN]: "bakiye" }, { policy, dataClass: "gizli" })).toThrow(
      PiiLeakError,
    );
  });

  it("fires for the same reason on the way through withPiiBoundary", async () => {
    const call = withPiiBoundary<Record<string, string>, string>(
      { policy, dataClass: "gizli" },
      () => Promise.resolve("ok"),
    );
    await expect(call({ [SAMPLE_TCKN]: "bakiye" })).rejects.toBeInstanceOf(PiiLeakError);
  });

  it("stays quiet for a payload whose keys are ordinary field names", async () => {
    const call = withPiiBoundary<Prompt, string>({ policy, dataClass: "gizli" }, () =>
      Promise.resolve("ok"),
    );
    await expect(call(prompt())).resolves.toBeDefined();
  });
});

describe("the return leg is masked too (B-11 · M82)", () => {
  it("keeps raw PII the model wrote out of the copy that is persisted", async () => {
    const call = withPiiBoundary<Prompt, string>({ policy, dataClass: "gizli" }, () =>
      // The model writes an identifier from its own context, not from ours.
      Promise.resolve(`Ilgili musteri ${OTHER_TCKN} olabilir.`),
    );
    const result = await call(prompt());

    expect(result.maskedOutput).not.toContain(OTHER_TCKN);
    expect(result.maskedOutput).toMatch(/\[TCKN_2\.[0-9a-f]{8}\]/);
    expect(result.outputCounts.occurrences).toBe(1);
    // The human still sees what the model wrote.
    expect(result.reveal()).toContain(OTHER_TCKN);
  });

  it("still restores the tokens the model echoed back", async () => {
    let seen = "";
    const call = withPiiBoundary<Prompt, string>({ policy, dataClass: "gizli" }, (masked) => {
      seen = JSON.stringify(masked);
      const nonce = /\[TCKN_1\.([0-9a-f]+)\]/.exec(seen)?.[1] ?? "none";
      return Promise.resolve(`[TCKN_1.${nonce}] kontrol edildi`);
    });
    const result = await call(prompt());
    expect(result.reveal()).toBe(`${SAMPLE_TCKN} kontrol edildi`);
    expect(result.maskedOutput).toMatch(/\[TCKN_1\.[0-9a-f]{8}\] kontrol edildi/);
  });
});

describe("the result cannot poison a log line (B-12)", () => {
  it("keeps the revealed output off every path a logger walks", async () => {
    const call = withPiiBoundary<Prompt, string>({ policy, dataClass: "gizli" }, () =>
      Promise.resolve(`Ilgili musteri ${OTHER_TCKN} olabilir.`),
    );
    const result = await call(prompt());

    expect(JSON.stringify({ result })).not.toContain(OTHER_TCKN);
    expect(JSON.stringify({ result })).not.toContain(SAMPLE_TCKN);
    expect(inspect(result, { depth: 10 })).not.toContain(OTHER_TCKN);
    expect(Object.keys(result)).not.toContain("output");
    // …and the reveal is still there for the screen the user is looking at.
    expect(result.reveal()).toContain(OTHER_TCKN);
  });
});

describe("the fail-closed fallback is audited, not swallowed", () => {
  it("tells the audit hook that the declared class was unusable", async () => {
    const seen: MaskedInfo[] = [];
    const call = withPiiBoundary<Prompt, string>(
      {
        policy,
        dataClass: "who-knows",
        boundary: "llm",
        onMasked: (_counts, _dataClass, info) => seen.push(info),
      },
      () => Promise.resolve("ok"),
    );
    const result = await call(prompt());

    expect(result.dataClass).toBe("gizli");
    expect(result.fellBack).toBe(true);
    expect(seen.map((i) => i.leg)).toEqual(["request", "response"]);
    expect(seen.every((i) => i.fellBack && i.boundary === "llm")).toBe(true);
  });

  it("does not claim a fallback when the class was declared properly", async () => {
    const seen: MaskedInfo[] = [];
    const call = withPiiBoundary<Prompt, string>(
      { policy, dataClass: "dahili", onMasked: (_c, _d, info) => seen.push(info) },
      () => Promise.resolve("ok"),
    );
    await call(prompt());
    expect(seen.every((i) => i.fellBack)).toBe(false);
  });
});
