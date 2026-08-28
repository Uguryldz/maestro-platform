import { describe, expect, it } from "vitest";
import { CapabilityNotSupportedError, PortRegistry } from "../src/index.js";

describe("PortRegistry (M44 DI)", () => {
  it("registers and resolves a driver factory", () => {
    const reg = new PortRegistry();
    reg.register("notify", "smtp", () => ({ kind: "smtp" }));
    const factory = reg.resolve<{ kind: string }>("notify", "smtp");
    expect(factory({}).kind).toBe("smtp");
  });

  it("rejects duplicate registration", () => {
    const reg = new PortRegistry();
    reg.register("notify", "smtp", () => ({}));
    expect(() => reg.register("notify", "smtp", () => ({}))).toThrow(/duplicate/);
  });

  it("fails loudly with the available driver list", () => {
    const reg = new PortRegistry();
    reg.register("notify", "smtp", () => ({}));
    expect(() => reg.resolve("notify", "teams")).toThrow(/available: smtp/);
    expect(() => reg.resolve("scan", "gitleaks")).toThrow(/\(none\)/);
  });

  it("lists drivers per port", () => {
    const reg = new PortRegistry();
    reg.register("storage", "s3-compat", () => ({}));
    reg.register("storage", "pg-blob", () => ({}));
    expect(reg.drivers("storage").sort()).toEqual(["pg-blob", "s3-compat"]);
  });
});

describe("CapabilityNotSupportedError", () => {
  it("names port and capability (M102 transition case)", () => {
    const err = new CapabilityNotSupportedError("WorkPort", "transition");
    expect(err.message).toContain("WorkPort");
    expect(err.message).toContain("transition");
  });
});
