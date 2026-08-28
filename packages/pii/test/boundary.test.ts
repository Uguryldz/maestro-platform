import { describe, expect, it } from "vitest";
import {
  compiledProfileFor,
  defaultPiiPolicy,
  guardEgress,
  loadPiiPolicy,
  maskOutbound,
  PiiLeakError,
  unmaskInbound,
  withPiiBoundary,
  type LoadedPiiPolicy,
  type MaskCounts,
  type Masked,
  type OutboundCall,
} from "../src/index.js";
import { SAMPLE_TCKN } from "./synthetic.js";

interface Prompt {
  readonly instruction: string;
  readonly ticket: { readonly description: string };
}

const policy: LoadedPiiPolicy = loadPiiPolicy(defaultPiiPolicy());
const strict = compiledProfileFor(policy, "gizli").profile;

function prompt(): Prompt {
  return {
    instruction: "Ozetle",
    ticket: { description: `Musteri TCKN ${SAMPLE_TCKN} ile ali@banka.com.tr adresinden yazdi.` },
  };
}

/** Stands in for the LLM gateway: it only ever accepts a masked envelope. */
const gateway: OutboundCall<Prompt, string> = (payload) =>
  Promise.resolve(`Cagri gonderildi: ${JSON.stringify(payload)}`);

describe("the boundary a caller cannot skip (v1's fatal defect)", () => {
  it("rejects a raw payload at compile time", async () => {
    // @ts-expect-error only withPiiBoundary/maskOutbound can mint Masked<Prompt>.
    const leaked = await gateway(prompt());
    // Proof the type error is load-bearing: without the gate the value goes out.
    expect(leaked).toContain(SAMPLE_TCKN);
  });

  it("rejects a raw payload at run time even when someone casts past the brand", async () => {
    const guarded = guardEgress<Prompt, string>(
      { profile: strict, boundary: "llm-gateway" },
      gateway,
    );
    const raw = prompt() as unknown as Masked<Prompt>;
    await expect(guarded(raw)).rejects.toBeInstanceOf(PiiLeakError);

    let caught: unknown;
    try {
      await guarded(raw);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PiiLeakError);
    const leak = caught as PiiLeakError;
    expect(leak.boundary).toBe("llm-gateway");
    expect(leak.message).not.toContain(SAMPLE_TCKN);
  });

  it("lets a masked payload through the same guard", async () => {
    const guarded = guardEgress<Prompt, string>({ profile: strict }, gateway);
    const { envelope } = maskOutbound(prompt(), { policy, dataClass: "gizli" });
    await expect(guarded(envelope)).resolves.toMatch(/\[TCKN_1\.[0-9a-f]{8}\]/);
  });
});

describe("withPiiBoundary", () => {
  it("masks on the way out and restores on the way back", async () => {
    let seenByGateway = "";
    const call = withPiiBoundary<Prompt, string>(
      { policy, dataClass: "gizli", boundary: "llm-gateway" },
      (masked) => {
        seenByGateway = JSON.stringify(masked);
        // The model answers in the vocabulary it was given, nonce included.
        const nonce = /\[TCKN_1\.([0-9a-f]+)\]/.exec(seenByGateway)?.[1] ?? "no-nonce";
        return Promise.resolve(
          `[TCKN_1.${nonce}] numarali musteriye [EMAIL_1.${nonce}] adresinden donulmeli.`,
        );
      },
    );

    const result = await call(prompt());

    expect(seenByGateway).not.toContain(SAMPLE_TCKN);
    expect(seenByGateway).not.toContain("ali@banka.com.tr");
    expect(seenByGateway).toMatch(/\[TCKN_1\.[0-9a-f]{8}\]/);
    expect(result.reveal()).toBe(
      `${SAMPLE_TCKN} numarali musteriye ali@banka.com.tr adresinden donulmeli.`,
    );
    expect(result.maskedOutput).toMatch(/\[TCKN_1\.[0-9a-f]{8}\]/);
    expect(result.maskedOutput).not.toContain(SAMPLE_TCKN);
    expect(result.counts.occurrences).toBe(2);
    expect(result.dataClass).toBe("gizli");
  });

  it("never hands the ReverseMap to the callee or to the caller (M20)", async () => {
    let received: unknown;
    const call = withPiiBoundary<Prompt, string>({ policy, dataClass: "gizli" }, (masked) => {
      received = masked;
      return Promise.resolve("ok");
    });
    const result = await call(prompt());
    expect(Object.keys(result).sort()).toEqual([
      "counts",
      "dataClass",
      "fellBack",
      "maskedOutput",
      "outputCounts",
    ]);
    expect(JSON.stringify(received)).not.toContain(SAMPLE_TCKN);
    // The whole result is loggable: no path through it reaches a real value.
    expect(JSON.stringify(result)).not.toContain(SAMPLE_TCKN);
  });

  it("falls back to the strictest profile when the data class is unusable", async () => {
    const seen: MaskCounts[] = [];
    const call = withPiiBoundary<Prompt, string>(
      { policy, dataClass: "who-knows", onMasked: (counts) => seen.push(counts) },
      () => Promise.resolve("ok"),
    );
    const result = await call(prompt());
    expect(result.dataClass).toBe("gizli");
    // One audit line per leg of the exchange: request and answer (B-11).
    expect(seen).toHaveLength(2);
    expect(seen[0]?.occurrences).toBe(2);
  });

  it("gives a session per call, so tokens never cross exchanges", async () => {
    const tokens: string[] = [];
    const call = withPiiBoundary<Prompt, string>({ policy, dataClass: "gizli" }, (masked) => {
      tokens.push(JSON.stringify(masked));
      return Promise.resolve("ok");
    });
    await call(prompt());
    await call(prompt());
    // Same numbering, different session nonce: two exchanges share no token,
    // so neither one's map can ever open the other's text (B-8).
    expect(tokens[0]).toMatch(/\[TCKN_1\.[0-9a-f]{8}\]/);
    expect(tokens[1]).toMatch(/\[TCKN_1\.[0-9a-f]{8}\]/);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("keeps one session for the whole boundary when asked to", async () => {
    const tokens: string[] = [];
    const call = withPiiBoundary<Prompt, string>(
      { policy, dataClass: "gizli", sessionScope: "boundary" },
      (masked) => {
        tokens.push(JSON.stringify(masked));
        return Promise.resolve("ok");
      },
    );
    await call(prompt());
    await call(prompt());
    // Same value, same writer, same token: a journal written twice reads the
    // same way both times, which is what makes re-masking a no-op below.
    expect(tokens[0]).toMatch(/\[TCKN_1\.[0-9a-f]{8}\]/);
    expect(tokens[0]).toBe(tokens[1]);
  });

  it("does not de-fang its own tokens when a masked payload comes back through", async () => {
    const seen: Prompt[] = [];
    const call = withPiiBoundary<Prompt, string>(
      { policy, dataClass: "gizli", sessionScope: "boundary" },
      (masked) => {
        seen.push(masked.value);
        return Promise.resolve("ok");
      },
    );
    await call(prompt());
    const once = seen[0] as Prompt;
    await call(once);
    // The defect this scope exists for: with a session per call the second
    // pass does not recognise `[TCKN_1.<nonce>]` as a token and strips its
    // brackets, so the record stops saying that anything was removed there.
    expect(seen[1]).toEqual(once);
    expect(seen[1]?.ticket.description).toMatch(/\[TCKN_1\.[0-9a-f]{8}\]/);
  });

  it("propagates a callee failure without swallowing it", async () => {
    const call = withPiiBoundary<Prompt, string>({ policy, dataClass: "gizli" }, () =>
      Promise.reject(new Error("gateway 503")),
    );
    await expect(call(prompt())).rejects.toThrow("gateway 503");
  });
});

describe("maskOutbound / unmaskInbound", () => {
  it("is the same gate taken apart, for callers that span two frames", () => {
    const { payload, map, counts, dataClass } = maskOutbound(prompt(), {
      policy,
      dataClass: "dahili",
    });
    const n = map.nonce;
    expect(payload.ticket.description).toBe(
      `Musteri TCKN [TCKN_1.${n}] ile [EMAIL_1.${n}] adresinden yazdi.`,
    );
    expect(counts.fields).toBe(1);
    expect(dataClass).toBe("dahili");
    expect(unmaskInbound({ answer: `[TCKN_1.${n}] kontrol edildi` }, map)).toEqual({
      answer: `${SAMPLE_TCKN} kontrol edildi`,
    });
  });
});
