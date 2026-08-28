import { describe, expect, it } from "vitest";
import {
  Connection,
  ConnectionAuthKind,
  ConnectionId,
  ConnectionInput,
  ConnectionKind,
} from "../src/connection.js";

const NOW = "2026-08-10T09:00:00+03:00";

function baseConnection(over: Record<string, unknown> = {}): unknown {
  return {
    id: "jira",
    kind: "jira_cloud",
    displayName: "Jira Cloud",
    baseUrl: "https://ugurbank.atlassian.net",
    authKind: "basic",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe("ConnectionKind / ConnectionAuthKind", () => {
  it("names the ten kinds the connector surface supports", () => {
    expect(ConnectionKind.options).toEqual([
      "jira_cloud",
      "jira_dc",
      "github",
      "ado",
      "openrouter",
      "anthropic",
      // The self-hosted lane. Added deliberately: `openrouter` and `anthropic`
      // are both CLOUD vendors, so an operator running their own OpenAI-shaped
      // server (vLLM, llama.cpp, Ollama) had no kind to pick and no way to test
      // a model. It is a distinct kind rather than a flag because the kind is
      // what `probeFor` and `CONNECTION_KIND_FOR_REF` discriminate on.
      "openai_compat",
      "vault",
      "smtp",
      "storage",
    ]);
  });

  it("names the four auth kinds", () => {
    expect(ConnectionAuthKind.options).toEqual(["basic", "bearer", "pat", "api_key"]);
  });
});

describe("ConnectionId", () => {
  it("accepts a lower-case dash-separated id", () => {
    expect(ConnectionId.safeParse("llm-openrouter").success).toBe(true);
  });

  it("rejects a slash — the id is a URL path segment, not a path", () => {
    expect(ConnectionId.safeParse("jira/cloud").success).toBe(false);
    expect(ConnectionId.safeParse("Jira").success).toBe(false);
  });
});

describe("Connection (read shape)", () => {
  it("parses with defaults and NEVER carries a token field", () => {
    const parsed = Connection.parse(baseConnection());
    expect(parsed.secretSet).toBe(false);
    expect(parsed.secretMask).toBeNull();
    expect(parsed.lastTestOk).toBeNull();
    // The read shape has no `token`: a GET cannot return the secret because the
    // type it is validated against has nowhere to put one.
    expect("token" in parsed).toBe(false);
  });

  it("keeps lastTestOk tri-state — null is not false", () => {
    const never = Connection.parse(baseConnection());
    expect(never.lastTestOk).toBeNull();
    const failed = Connection.parse(baseConnection({ lastTestOk: false, lastTestedAt: NOW }));
    expect(failed.lastTestOk).toBe(false);
  });

  it("caps the mask at four characters", () => {
    expect(Connection.safeParse(baseConnection({ secretMask: "abcde" })).success).toBe(false);
    expect(Connection.safeParse(baseConnection({ secretMask: "abcd" })).success).toBe(true);
  });

  it("rejects a non-URL base", () => {
    expect(Connection.safeParse(baseConnection({ baseUrl: "not a url" })).success).toBe(false);
  });
});

describe("ConnectionInput (write shape)", () => {
  it("accepts a config-only edit with no token", () => {
    const parsed = ConnectionInput.parse({
      kind: "github",
      displayName: "GitHub",
      baseUrl: "https://api.github.com",
      authKind: "bearer",
      config: { owner: "ugurbank", repo: "core" },
    });
    expect(parsed.token).toBeUndefined();
    expect(parsed.config.owner).toBe("ugurbank");
    expect(parsed.enabled).toBe(true);
  });

  it("accepts a token inbound — the one place a raw secret appears", () => {
    const parsed = ConnectionInput.parse({
      kind: "github",
      displayName: "GitHub",
      baseUrl: "https://api.github.com",
      authKind: "bearer",
      token: "ghp_realtokenvalue",
    });
    expect(parsed.token).toBe("ghp_realtokenvalue");
  });

  it("distinguishes an ABSENT token from an EMPTY one — they are two instructions", () => {
    const base = {
      kind: "openai_compat",
      displayName: "Kurum içi model",
      baseUrl: "http://10.0.0.5:8000",
      authKind: "bearer",
    };

    // Absent: "leave whatever is stored alone" (a config-only edit).
    expect(ConnectionInput.parse(base).token).toBeUndefined();

    // Present-but-empty: "this server wants no key". A self-hosted vLLM or
    // Ollama commonly needs none, so the schema must let an operator SAY so —
    // the old `.min(1)` made that unrepresentable and collapsed it into the
    // absent case, which silently kept a stale credential instead.
    expect(ConnectionInput.parse({ ...base, token: "" }).token).toBe("");
  });

  it("refuses a config value that is not a string (no token smuggled as config)", () => {
    const result = ConnectionInput.safeParse({
      kind: "github",
      displayName: "GitHub",
      baseUrl: "https://api.github.com",
      authKind: "bearer",
      config: { nested: { token: "x" } },
    });
    expect(result.success).toBe(false);
  });
});
