import { describe, expect, it } from "vitest";
import {
  assertNoPii,
  compileProfile,
  createSession,
  defaultPiiPolicy,
  maskText,
  maskValue,
  PiiArgumentError,
  PiiLeakError,
  unmaskValue,
  type MaskProfile,
  type MaskSession,
} from "../src/index.js";
import { groupIban, makeTckn, SAMPLE_CARD, SAMPLE_TCKN, SAMPLE_TR_IBAN } from "./synthetic.js";

const STRICT: MaskProfile = {
  ...defaultPiiPolicy().profiles.gizli,
  accountPatterns: [{ name: "customer-no", pattern: "\\bMST-[0-9]{8}\\b" }],
  fieldRules: ["customerName"],
};

function session(): MaskSession {
  return createSession(STRICT, "t1");
}

describe("maskText", () => {
  it("replaces every supported type with a readable, typed token", () => {
    const text =
      `TCKN ${SAMPLE_TCKN}, IBAN ${SAMPLE_TR_IBAN}, kart ${SAMPLE_CARD}, ` +
      `tel 0532 111 22 33, e-posta ali@banka.com.tr, musteri MST-12345678`;
    const { text: masked, counts } = maskText(text, session());
    expect(masked).toBe(
      "TCKN [TCKN_1.t1], IBAN [IBAN_1.t1], kart [CARD_1.t1], " +
        "tel [PHONE_1.t1], e-posta [EMAIL_1.t1], musteri [ACCT_1.t1]",
    );
    expect(counts.occurrences).toBe(6);
    expect(counts.byType).toEqual({ iban: 1, card: 1, tckn: 1, phone: 1, email: 1, account: 1 });
  });

  it("gives one value one token however often and however it is spelled", () => {
    const s = session();
    const { text } = maskText(
      `${SAMPLE_TR_IBAN} ve ${groupIban(SAMPLE_TR_IBAN)} ve ${SAMPLE_TR_IBAN}`,
      s,
    );
    expect(text).toBe("[IBAN_1.t1] ve [IBAN_1.t1] ve [IBAN_1.t1]");
    expect(s.map.size).toBe(1);
  });

  it("numbers distinct values so the model can tell them apart", () => {
    const other = makeTckn("987654321");
    const { text } = maskText(`${SAMPLE_TCKN} ile ${other} ayni degil`, session());
    expect(text).toBe("[TCKN_1.t1] ile [TCKN_2.t1] ayni degil");
  });

  it("does not let a phone match chop an IBAN in half", () => {
    const { text, counts } = maskText(`Hesap: ${SAMPLE_TR_IBAN}`, session());
    expect(text).toBe("Hesap: [IBAN_1.t1]");
    expect(counts.occurrences).toBe(1);
  });

  it("leaves text without PII exactly as it was", () => {
    const text = "Kullanici girisinde 500 hatasi aliniyor, log ekte.";
    expect(maskText(text, session()).text).toBe(text);
    expect(maskText(text, session()).counts.fields).toBe(0);
  });
});

describe("maskValue over payloads", () => {
  it("walks nested objects and arrays without mutating the input", () => {
    const payload = {
      summary: `Iade ${SAMPLE_TR_IBAN} hesabina`,
      comments: [{ body: `Ara 0532 111 22 33` }, { body: "sorun yok" }],
      meta: { attempts: 3, open: true, at: new Date(0) },
    };
    const snapshot = structuredClone(payload);
    const { value, counts } = maskValue(payload, session());
    expect(payload).toEqual(snapshot);
    expect(value.summary).toBe("Iade [IBAN_1.t1] hesabina");
    expect(value.comments[0]?.body).toBe("Ara [PHONE_1.t1]");
    expect(value.comments[1]?.body).toBe("sorun yok");
    expect(value.meta.attempts).toBe(3);
    expect(value.meta.at).toEqual(new Date(0));
    expect(counts.fields).toBe(2);
    expect(counts.occurrences).toBe(2);
  });

  it("masks identifiers stored as numbers instead of letting them through", () => {
    const { value, counts } = maskValue({ tckn: Number(SAMPLE_TCKN) }, session());
    expect(value.tckn).toBe("[TCKN_1.t1]");
    expect(counts.byType.tckn).toBe(1);
  });

  it("applies field rules to the whole value, whatever it contains (M20)", () => {
    const s = session();
    const { value, counts } = maskValue({ customerName: "Ayse Yilmaz", note: "Ayse Yilmaz" }, s);
    expect(value.customerName).toBe("[FIELD_1.t1]");
    // A name in free text is not detectable by pattern; only the field rule covers it.
    expect(value.note).toBe("Ayse Yilmaz");
    expect(counts.byType.field).toBe(1);
    expect(s.map.unmask("[FIELD_1.t1]")).toBe("Ayse Yilmaz");
  });

  it("is idempotent: masking masked data changes nothing", () => {
    const s = session();
    const once = maskValue({ customerName: "Ayse Yilmaz", body: `TCKN ${SAMPLE_TCKN}` }, s);
    const twice = maskValue(once.value, s);
    expect(twice.value).toEqual(once.value);
    expect(twice.counts.occurrences).toBe(0);
  });

  it("refuses payloads it cannot promise to traverse (fail-closed)", () => {
    expect(() => maskValue({ m: new Map([["tckn", SAMPLE_TCKN]]) }, session())).toThrow(
      PiiArgumentError,
    );
    expect(() => maskValue({ s: new Set([SAMPLE_TCKN]) }, session())).toThrow(PiiArgumentError);
    expect(() => maskValue({ f: () => SAMPLE_TCKN }, session())).toThrow(PiiArgumentError);
  });

  it("refuses a circular payload instead of looping", () => {
    const cyclic: Record<string, unknown> = { body: "x" };
    cyclic.self = cyclic;
    expect(() => maskValue(cyclic, session())).toThrow(PiiArgumentError);
  });
});

describe("unmaskValue", () => {
  it("restores values through nested structures", () => {
    const s = session();
    const masked = maskValue({ a: [`TCKN ${SAMPLE_TCKN}`], b: { c: "ali@banka.com.tr" } }, s);
    expect(unmaskValue(masked.value, s.map)).toEqual({
      a: [`TCKN ${SAMPLE_TCKN}`],
      b: { c: "ali@banka.com.tr" },
    });
  });

  it("is a no-op for a session that masked nothing", () => {
    const s = session();
    expect(unmaskValue({ a: "[TCKN_1.t1]" }, s.map)).toEqual({ a: "[TCKN_1.t1]" });
  });
});

describe("assertNoPii — the egress tripwire", () => {
  const compiled = compileProfile(STRICT);

  it("passes for a masked payload", () => {
    const s = session();
    const masked = maskValue({ body: `TCKN ${SAMPLE_TCKN}`, customerName: "Ayse" }, s);
    expect(() => assertNoPii(masked.value, compiled, "llm")).not.toThrow();
  });

  it("throws for a raw payload and names the boundary and the types only", () => {
    let caught: PiiLeakError | undefined;
    try {
      assertNoPii({ body: `TCKN ${SAMPLE_TCKN}, ali@banka.com.tr` }, compiled, "llm");
    } catch (e) {
      caught = e as PiiLeakError;
    }
    expect(caught).toBeInstanceOf(PiiLeakError);
    expect(caught?.boundary).toBe("llm");
    expect(caught?.types).toEqual(["tckn", "email"]);
    expect(caught?.occurrences).toBe(2);
    // The message goes into logs — it must not carry the values it complains about.
    expect(caught?.message).not.toContain(SAMPLE_TCKN);
    expect(caught?.message).not.toContain("ali@banka.com.tr");
  });
});
