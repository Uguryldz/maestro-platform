import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/index.js";
import { fakeClock } from "./helpers.js";

describe("TtlCache", () => {
  it("serves an entry inside its TTL", () => {
    const clock = fakeClock();
    const cache = new TtlCache<string>(30, clock.clock);
    cache.set("k", "v");

    clock.advance(29_999);
    expect(cache.get("k")).toBe("v");
  });

  it("treats an entry at or past its deadline as a miss and drops it", () => {
    const clock = fakeClock();
    const cache = new TtlCache<string>(30, clock.clock);
    cache.set("k", "v");

    clock.advance(30_000);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.toJSON().cachedEntries).toBe(0);
  });

  it("stores nothing when the TTL is zero", () => {
    const cache = new TtlCache<string>(0, fakeClock().clock);
    cache.set("k", "v");

    expect(cache.enabled).toBe(false);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.toJSON().cachedEntries).toBe(0);
  });

  it("clears on demand", () => {
    const cache = new TtlCache<string>(30, fakeClock().clock);
    cache.set("k", "v");
    cache.clear();

    expect(cache.get("k")).toBeUndefined();
  });
});
