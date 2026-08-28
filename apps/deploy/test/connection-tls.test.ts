import { describe, expect, it } from "vitest";
import type { ConnectionModelRow } from "../src/stores/connection-model.js";
import { tlsSkipFlagFrom } from "../src/stores/connection-tls.js";

/**
 * The per-URL "did an admin flag this host?" lookup the TLS-aware transports
 * consult (`tlsAwareFetchWith`). What is pinned here is the SHAPE of the rule
 * — hostname matching, any kind, enabled rows only — and above all that every
 * unclear case answers `false`: TLS verification fails closed, never open.
 */

function row(overrides: Partial<ConnectionModelRow> = {}): ConnectionModelRow {
  return {
    id: "ado",
    kind: "ado",
    baseUrl: "https://tfs.ugurbank.example/DefaultCollection",
    secretRef: null,
    enabled: true,
    onPrem: true,
    isDefault: false,
    configJson: { skipTlsVerify: "true" },
    ...overrides,
  };
}

function db(rows: ConnectionModelRow[]): { connection: { findMany: () => Promise<ConnectionModelRow[]> } } {
  return { connection: { findMany: () => Promise.resolve(rows) } };
}

describe("tlsSkipFlagFrom", () => {
  it("answers true for every URL on a flagged connection's HOST, whatever the path", async () => {
    const flag = tlsSkipFlagFrom(db([row()]));
    // The flag is an assertion about the SERVER: the probe URL, an API
    // sub-path and a run's endpoint all inherit it.
    expect(await flag("https://tfs.ugurbank.example/DefaultCollection/_apis/connectionData")).toBe(true);
    expect(await flag("https://tfs.ugurbank.example/other/path")).toBe(true);
    // A different host — even a sibling — is somebody else's certificate.
    expect(await flag("https://jira.ugurbank.example/rest/api/2/myself")).toBe(false);
  });

  it("is not a model-kind specialty — a Jira DC row's flag counts the same", async () => {
    const flag = tlsSkipFlagFrom(db([row({ kind: "jira_dc", baseUrl: "https://jira.ugurbank.example" })]));
    expect(await flag("https://jira.ugurbank.example/rest/api/2/myself")).toBe(true);
  });

  it("fails CLOSED on every unclear case", async () => {
    // Disabled row: an admin who switched the connection off switched its
    // assertions off with it.
    expect(await tlsSkipFlagFrom(db([row({ enabled: false })]))("https://tfs.ugurbank.example/x")).toBe(false);
    // Only the exact string "true" counts; junk reads as off.
    expect(
      await tlsSkipFlagFrom(db([row({ configJson: { skipTlsVerify: "yes" } })]))("https://tfs.ugurbank.example/x"),
    ).toBe(false);
    // An unreadable table (outage, pre-migration stack) must not open TLS.
    const broken = { connection: { findMany: () => Promise.reject(new Error("db down")) } };
    expect(await tlsSkipFlagFrom(broken)("https://tfs.ugurbank.example/x")).toBe(false);
    // Junk URL: nothing to match, nothing to skip.
    expect(await tlsSkipFlagFrom(db([row()]))("not a url")).toBe(false);
  });
});
