import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  PII_TYPES,
  PiiReverseMapLeakError,
  ReverseMap,
  TOKEN_PREFIX,
  WHOLE_TOKEN_PATTERN,
} from "../src/index.js";
import { SAMPLE_TCKN, tcknSeries } from "./synthetic.js";

describe("token vocabulary is single-sourced", () => {
  it("mints a token for every declared type that the reader can read back", () => {
    for (const type of PII_TYPES) {
      const map = new ReverseMap("t1");
      const token = map.tokenFor(type, `value-of-${type}`, `value-of-${type}`);
      expect(token).toBe(`[${TOKEN_PREFIX[type]}_1.t1]`);
      // Minter and reader must agree, or unmask silently stops working.
      expect(WHOLE_TOKEN_PATTERN.test(token)).toBe(true);
      expect(map.unmask(`x ${token} y`)).toBe(`x value-of-${type} y`);
    }
  });
});

describe("ReverseMap token assignment", () => {
  it("gives one value one token for the whole session", () => {
    const map = new ReverseMap("t1");
    const first = map.tokenFor("tckn", SAMPLE_TCKN, SAMPLE_TCKN);
    const again = map.tokenFor("tckn", SAMPLE_TCKN, SAMPLE_TCKN);
    expect(first).toBe("[TCKN_1.t1]");
    expect(again).toBe(first);
    expect(map.size).toBe(1);
  });

  it("numbers each type independently and readably", () => {
    const map = new ReverseMap("t1");
    expect(map.tokenFor("tckn", "a", "a")).toBe("[TCKN_1.t1]");
    expect(map.tokenFor("tckn", "b", "b")).toBe("[TCKN_2.t1]");
    expect(map.tokenFor("email", "c", "c")).toBe("[EMAIL_1.t1]");
    expect(map.tokenFor("account", "d", "d")).toBe("[ACCT_1.t1]");
  });

  it("keeps the first spelling of a value as the one it restores", () => {
    const map = new ReverseMap("t1");
    map.tokenFor("iban", "TR330006", "TR33 0006");
    map.tokenFor("iban", "TR330006", "TR330006");
    expect(map.unmask("hesap [IBAN_1.t1]")).toBe("hesap TR33 0006");
  });

  it("restores double-digit tokens without prefix confusion", () => {
    const map = new ReverseMap("t1");
    const values = tcknSeries(11);
    for (const v of values) map.tokenFor("tckn", v, v);
    expect(map.unmask("[TCKN_11.t1] ve [TCKN_1.t1]")).toBe(`${values[10]} ve ${values[0]}`);
  });

  it("leaves a token it never minted untouched", () => {
    const map = new ReverseMap("t1");
    map.tokenFor("tckn", SAMPLE_TCKN, SAMPLE_TCKN);
    // A model that invents a token must get no answer, not someone else's value.
    expect(map.unmask("[TCKN_9.t1] bilinmiyor")).toBe("[TCKN_9.t1] bilinmiyor");
    expect(map.has("[TCKN_9.t1]")).toBe(false);
    expect(map.has("[TCKN_1.t1]")).toBe(true);
  });
});

describe("ReverseMap never leaves the process (M20/M82)", () => {
  function loaded(): ReverseMap {
    const map = new ReverseMap("t1");
    map.tokenFor("tckn", SAMPLE_TCKN, SAMPLE_TCKN);
    map.tokenFor("email", "ali@banka.com.tr", "ali@banka.com.tr");
    return map;
  }

  it("refuses to be serialised to JSON", () => {
    const map = loaded();
    expect(() => JSON.stringify(map)).toThrow(PiiReverseMapLeakError);
    expect(() => JSON.stringify({ audit: "PII_MASKED", map })).toThrow(PiiReverseMapLeakError);
  });

  it("exposes no enumerable property that holds a value", () => {
    const map = loaded();
    expect(Object.keys(map)).toEqual([]);
    expect(JSON.stringify(Object.entries(map))).not.toContain(SAMPLE_TCKN);
    expect(JSON.stringify(structuredClone({ ...map }))).toBe("{}");
  });

  it("survives the three ways a value usually reaches a log line", () => {
    const map = loaded();
    expect(String(map)).toBe("ReverseMap(size=2)");
    expect(`${map}`).not.toContain(SAMPLE_TCKN);
    expect(inspect(map, { depth: 10 })).toBe("ReverseMap { size: 2 }");
    expect(inspect(map, { depth: 10 })).not.toContain("ali@banka.com.tr");
  });
});
