import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { CONNECTION_NOTE_MAX, noteWithParams } from "../src/connection-note.js";
import type { ConnectorFetch } from "../src/connection-service.js";
import { auth, harness, type Harness, type HarnessOptions } from "./helpers.js";

/**
 * The connector-management surface: outbound connections made admin-editable,
 * their tokens stored enciphered and read back only as a mask.
 *
 * The behaviours under test are the security properties a leak would breach: a
 * GET never carries a token; a POST stores the reference, not the raw value;
 * the live test uses the STORED credential and reports its HONEST result; and
 * every write/test/delete is admin-only.
 */

const TOKEN = "ghp_supersecrettokenvalue1234";

async function admin(h: Harness): Promise<string> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  return h.login("ayse.kaya");
}

async function techLead(h: Harness): Promise<string> {
  await h.addUser({ username: "mehmet.demir", roles: ["tech-lead"] });
  return h.login("mehmet.demir");
}

async function viewer(h: Harness): Promise<string> {
  await h.addUser({ username: "can.yilmaz", roles: ["developer"] });
  return h.login("can.yilmaz");
}

function get(h: Harness, url: string, token: string): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "GET", url, headers: auth(token) });
}
function post(h: Harness, url: string, token: string, payload?: object): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "POST", url, headers: auth(token), ...(payload ? { payload } : {}) });
}
function put(h: Harness, url: string, token: string, payload: object): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "PUT", url, headers: auth(token), payload });
}
function del(h: Harness, url: string, token: string): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "DELETE", url, headers: auth(token) });
}

const GITHUB = {
  id: "github",
  kind: "github",
  displayName: "GitHub",
  baseUrl: "https://api.github.com",
  authKind: "bearer",
} as const;

async function createGithub(h: Harness, token: string, over: Record<string, unknown> = {}): Promise<LightMyRequestResponse> {
  return post(h, "/studio/connections", token, { ...GITHUB, token: TOKEN, ...over });
}

describe("POST /studio/connections", () => {
  it("stores the token ENCIPHERED — the raw token is never in the connection row", async () => {
    const h = await harness();
    const admToken = await admin(h);

    const response = await createGithub(h, admToken);
    expect(response.statusCode).toBe(201);

    // The stored connection row carries only a reference + a mask, never the token.
    const record = await h.connections.get("github");
    expect(record?.secretRef).not.toBeNull();
    expect(JSON.stringify(record)).not.toContain(TOKEN);
    expect(record?.secretMask).toBe("1234");

    // The token lives ONLY in the secret store, under the reference.
    expect(h.connectorSecrets.has(record!.secretRef!)).toBe(true);
    expect(await h.connectorSecrets.get(record!.secretRef!)).toBe(TOKEN);
  });

  /**
   * Found by reading the probe against the form: `jira_cloud` authenticates
   * with `basicAuth(config.email, token)`, and the Studio form had no box for
   * `email`. Every Jira Cloud row created from Studio therefore sent
   * `basicAuth("", token)` and came back 401 — which reads as a bad token and
   * sends the operator off to re-issue a credential that was fine.
   *
   * The kind's required fields are now refused HERE, by the same table the form
   * marks them from, so the row cannot be saved in a state its own test is
   * guaranteed to fail.
   */
  it("refuses a Jira Cloud row with no account e-mail, naming the field", async () => {
    const h = await harness();
    const admToken = await admin(h);

    const response = await h.app.inject({
      method: "POST",
      url: "/studio/connections",
      headers: { authorization: `Bearer ${admToken}` },
      payload: {
        id: "jira",
        kind: "jira_cloud",
        displayName: "Jira",
        baseUrl: "https://sirket.atlassian.net",
        authKind: "basic",
        config: {},
        token: TOKEN,
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error?: string; details?: { fields?: string[] } };
    expect(body.error).toBe("missing_config");
    // Names the field, so the form can mark the box the operator must fill.
    expect(body.details?.fields).toEqual(["email"]);
    // Refused means NOT stored: a half-configured row is worse than none.
    expect(await h.connections.get("jira")).toBeNull();
  });

  it("accepts the same row once the e-mail is there", async () => {
    const h = await harness();
    const admToken = await admin(h);

    const response = await h.app.inject({
      method: "POST",
      url: "/studio/connections",
      headers: { authorization: `Bearer ${admToken}` },
      payload: {
        id: "jira",
        kind: "jira_cloud",
        displayName: "Jira",
        baseUrl: "https://sirket.atlassian.net",
        authKind: "basic",
        config: { email: "bot@sirket.com" },
        token: TOKEN,
      },
    });

    expect(response.statusCode).toBe(201);
    expect((await h.connections.get("jira"))?.config["email"]).toBe("bot@sirket.com");
  });

  it("never returns the token in the create RESPONSE — only a mask + set flag", async () => {
    const h = await harness();
    const admToken = await admin(h);

    const response = await createGithub(h, admToken);
    expect(response.body).not.toContain(TOKEN);
    const body = response.json() as { connection: { secretMask: string; secretSet: boolean; token?: string } };
    expect(body.connection.secretMask).toBe("1234");
    expect(body.connection.secretSet).toBe(true);
    expect(body.connection.token).toBeUndefined();
  });

  it("refuses a tech lead and a viewer — writing a connector is admin-only (M86)", async () => {
    const h = await harness();
    expect((await createGithub(h, await techLead(h))).statusCode).toBe(403);
    expect((await createGithub(h, await viewer(h))).statusCode).toBe(403);
  });

  it("refuses the write while the kill switch is on (M58)", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await h.killSwitch.set({ level: "all", actor: "ayse.kaya@ugurbank.local", reason: "olay", at: "2026-08-09T10:00:00.000Z" });
    expect((await createGithub(h, admToken)).statusCode).toBe(409);
  });

  it("rejects an invalid body (a non-URL base)", async () => {
    const h = await harness();
    const admToken = await admin(h);
    const response = await createGithub(h, admToken, { baseUrl: "not-a-url" });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /studio/connections", () => {
  it("lists connections masked — no token in the body, ever", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await createGithub(h, admToken);

    const response = await get(h, "/studio/connections", admToken);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(TOKEN);
    const body = response.json() as { connections: { id: string; secretMask: string; secretSet: boolean }[] };
    expect(body.connections[0]?.id).toBe("github");
    expect(body.connections[0]?.secretMask).toBe("1234");
    expect(body.connections[0]?.secretSet).toBe(true);
  });

  it("is readable by a tech lead but not a viewer", async () => {
    const h = await harness();
    expect((await get(h, "/studio/connections", await techLead(h))).statusCode).toBe(200);
    expect((await get(h, "/studio/connections", await viewer(h))).statusCode).toBe(403);
  });
});

describe("PUT /studio/connections/:id", () => {
  it("keeps the stored token when the update omits one (a config-only edit)", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await createGithub(h, admToken);
    const before = await h.connections.get("github");

    const response = await put(h, "/studio/connections/github", admToken, {
      ...GITHUB,
      displayName: "GitHub (prod)",
    });
    expect(response.statusCode).toBe(200);

    const after = await h.connections.get("github");
    expect(after?.displayName).toBe("GitHub (prod)");
    // Same secret ref — the token was untouched.
    expect(after?.secretRef).toBe(before?.secretRef);
    expect(await h.connectorSecrets.get(after!.secretRef!)).toBe(TOKEN);
  });

  it("replaces the token (and its ref) when a new one is supplied", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await createGithub(h, admToken);
    const before = await h.connections.get("github");

    await put(h, "/studio/connections/github", admToken, { ...GITHUB, token: "ghp_rotated5678" });
    const after = await h.connections.get("github");
    expect(after?.secretRef).not.toBe(before?.secretRef);
    expect(after?.secretMask).toBe("5678");
    expect(await h.connectorSecrets.get(after!.secretRef!)).toBe("ghp_rotated5678");
  });
});

describe("POST /studio/connections/:id/test", () => {
  it("calls the right URL for the kind with the STORED token and reports ok", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const connectorFetch: ConnectorFetch = (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization") });
      return Promise.resolve(new Response(JSON.stringify({ login: "ugurbank-bot" }), { status: 200 }));
    };
    const h = await harness({ connectorFetch });
    const admToken = await admin(h);
    await createGithub(h, admToken);

    const response = await post(h, "/studio/connections/github/test", admToken);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; messageKey: string; messageParams?: { who: string } };
    expect(body.ok).toBe(true);
    // GitHub's identity probe is /user, and the token is the STORED one — proving
    // the test does not take a caller-supplied credential.
    expect(calls[0]?.url).toBe("https://api.github.com/user");
    expect(calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(body.messageParams?.who).toBe("ugurbank-bot");

    // The honest result — and its secret-free note — are recorded on the row.
    const record = await h.connections.get("github");
    expect(record?.lastTestOk).toBe(true);
    expect(record?.lastTestedAt).not.toBeNull();
    // The note is the outcome's catalog KEY, never raw text or a token.
    // The note now carries its params (`key?who=...`) so the panel can render
    // them after a reload; the KEY is what this test is about.
    expect(record?.lastTestNote?.split("?")[0]).toBe("connections.test.ok_as");
  });

  it("reports a failure honestly and never fakes green", async () => {
    const connectorFetch: ConnectorFetch = () => Promise.resolve(new Response("nope", { status: 401 }));
    const h = await harness({ connectorFetch });
    const admToken = await admin(h);
    await createGithub(h, admToken);

    const body = (await post(h, "/studio/connections/github/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
    };
    expect(body.ok).toBe(false);
    expect(body.messageKey).toBe("connections.test.http_error");
    const failed = await h.connections.get("github");
    expect(failed?.lastTestOk).toBe(false);
    // The failure note is the catalog key — it explains WHY without leaking the
    // token, the URL's credentials, or a raw driver message.
    expect(failed?.lastTestNote?.split("?")[0]).toBe("connections.test.http_error");
    // The status travels with it — without this the panel renders "HTTP {status}".
    expect(failed?.lastTestNote).toContain("status=");
    expect(JSON.stringify(failed)).not.toContain(TOKEN);
  });

  it("never leaks the token, even when the transport throws", async () => {
    const connectorFetch: ConnectorFetch = () => Promise.reject(new Error(`connect failed to ${TOKEN}`));
    const h = await harness({ connectorFetch });
    const admToken = await admin(h);
    await createGithub(h, admToken);

    const response = await post(h, "/studio/connections/github/test", admToken);
    expect(response.body).not.toContain(TOKEN);
    const body = response.json() as { ok: boolean; messageKey: string };
    expect(body.ok).toBe(false);
    expect(body.messageKey).toBe("connections.test.unreachable");
  });

  it("refuses a viewer — a crafted test must not be a token-exfiltration path", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await createGithub(h, admToken);
    expect((await post(h, "/studio/connections/github/test", await viewer(h))).statusCode).toBe(403);
  });
});

/**
 * The bot-identity check.
 *
 * A Jira connection carries `config.botAccountId` — the account Maestro acts as.
 * It used to be free text, so an operator could store their OWN account id and
 * nothing would ever contradict them: comments, transitions and four-eyes
 * exemptions would then be attributed to a person instead of the bot. The live
 * test knows better, because `/rest/api/3/myself` names the token's real owner.
 *
 * No network here — `connectorFetch` is a fixture returning a canned `/myself`.
 */
describe("POST /studio/connections/:id/test — the bot account it claims", () => {
  // The real shape of a Jira Cloud `/myself` answer, email included, so the PII
  // assertions below are testing against a body that genuinely contains one.
  const REAL_OWNER = "712020:b836c135-c9d3-499a-a665-aed43d362cfd";
  const OPERATORS_OWN = "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1";
  const BOT_EMAIL = "uyildiz2054@gmail.com";

  function myselfFetch(over: Record<string, unknown> = {}): ConnectorFetch {
    return () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            accountId: REAL_OWNER,
            displayName: "maestro",
            emailAddress: BOT_EMAIL,
            ...over,
          }),
          { status: 200 },
        ),
      );
  }

  const JIRA = {
    id: "jira",
    kind: "jira_cloud",
    displayName: "Jira Cloud",
    baseUrl: "https://ugurbank.atlassian.net",
    authKind: "basic",
  } as const;

  async function createJira(
    h: Harness,
    token: string,
    config: Record<string, string>,
  ): Promise<LightMyRequestResponse> {
    return post(h, "/studio/connections", token, { ...JIRA, config, token: TOKEN });
  }

  it("catches a botAccountId that is NOT the token's owner and corrects it", async () => {
    const h = await harness({ connectorFetch: myselfFetch() });
    const admToken = await admin(h);
    // The live bug: the operator's personal account id stored as the bot's.
    await createJira(h, admToken, { email: "operator@ugurbank.local", botAccountId: OPERATORS_OWN });

    const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
      messageParams?: Record<string, string>;
      botAccountCorrected?: { from: string; to: string };
    };

    // The connection genuinely works, so `ok` stays true — but it does NOT get
    // to say a plain "connection succeeded" over a wrong identity.
    expect(body.ok).toBe(true);
    expect(body.messageKey).toBe("connections.test.ok_bot_fixed");
    expect(body.messageParams?.["was"]).toBe(OPERATORS_OWN);
    expect(body.messageParams?.["now"]).toBe(REAL_OWNER);
    expect(body.botAccountCorrected).toEqual({ from: OPERATORS_OWN, to: REAL_OWNER });

    // And the stored config is actually repaired, so the next rule read is right.
    expect((await h.connections.get("jira"))?.config["botAccountId"]).toBe(REAL_OWNER);
  });

  it("accepts a matching botAccountId quietly — no false alarm", async () => {
    const h = await harness({ connectorFetch: myselfFetch() });
    const admToken = await admin(h);
    await createJira(h, admToken, { email: "bot@ugurbank.local", botAccountId: REAL_OWNER });

    const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
      botAccountCorrected?: unknown;
    };
    expect(body.ok).toBe(true);
    // The ordinary success key, and no correction claimed.
    expect(body.messageKey).toBe("connections.test.ok_as");
    expect(body.botAccountCorrected).toBeUndefined();
    expect((await h.connections.get("jira"))?.config["botAccountId"]).toBe(REAL_OWNER);
  });

  it("never says 'verified' when the identity could not be read — fail closed", async () => {
    // The network is down: nothing was learned, so nothing may be asserted.
    const h = await harness({ connectorFetch: () => Promise.reject(new Error("ECONNREFUSED")) });
    const admToken = await admin(h);
    await createJira(h, admToken, { email: "bot@ugurbank.local", botAccountId: OPERATORS_OWN });

    const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
      botAccountCorrected?: unknown;
    };
    expect(body.ok).toBe(false);
    expect(body.messageKey).toBe("connections.test.unreachable");
    expect(body.botAccountCorrected).toBeUndefined();

    // A failed reach must NOT overwrite the stored id — a wrong value is still
    // better than a value silently replaced on the strength of no evidence.
    expect((await h.connections.get("jira"))?.config["botAccountId"]).toBe(OPERATORS_OWN);
  });

  it("leaves the id alone when the probe answers 200 with no accountId", async () => {
    const h = await harness({ connectorFetch: myselfFetch({ accountId: undefined }) });
    const admToken = await admin(h);
    await createJira(h, admToken, { email: "bot@ugurbank.local", botAccountId: OPERATORS_OWN });

    const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
      messageKey: string;
    };
    // Nothing to compare against, so no claim of a correction is made.
    expect(body.messageKey).toBe("connections.test.ok_as");
    expect((await h.connections.get("jira"))?.config["botAccountId"]).toBe(OPERATORS_OWN);
  });

  it("records the replacement in the audit trail, with both ids and no email", async () => {
    const h = await harness({ connectorFetch: myselfFetch() });
    const admToken = await admin(h);
    await createJira(h, admToken, { email: "operator@ugurbank.local", botAccountId: OPERATORS_OWN });
    await post(h, "/studio/connections/jira/test", admToken);

    const entries = await h.auditStore.read();
    const corrected = entries.find(
      (entry) => (entry.meta as Record<string, unknown> | undefined)?.["verb"] === "test_ok_bot_corrected",
    );
    expect(corrected).toBeDefined();
    const meta = corrected?.meta as Record<string, unknown>;
    expect(meta["botAccountIdWas"]).toBe(OPERATORS_OWN);
    expect(meta["botAccountIdNow"]).toBe(REAL_OWNER);
    expect(JSON.stringify(entries)).not.toContain(BOT_EMAIL);
  });

  it("keeps the bot's EMAIL out of every output — it is PII, the accountId is not", async () => {
    const h = await harness({ connectorFetch: myselfFetch() });
    const admToken = await admin(h);
    await createJira(h, admToken, { email: "operator@ugurbank.local", botAccountId: OPERATORS_OWN });

    const test = await post(h, "/studio/connections/jira/test", admToken);
    // The `/myself` body carried an email; neither the test response...
    expect(test.body).not.toContain(BOT_EMAIL);
    // ...nor the connection read that follows it may echo one.
    expect((await get(h, "/studio/connections", admToken)).body).not.toContain(BOT_EMAIL);
    // The stored note is a catalog key, never the probe's prose or its email.
    expect((await h.connections.get("jira"))?.lastTestNote?.split("?")[0]).toBe(
      "connections.test.ok_bot_fixed",
    );
  });

  it("does not resurrect a wrong id when a later edit omits it", async () => {
    // How the bad value survived: the panel round-trips `config`, so a rename
    // after a correction would write the operator's id straight back.
    const h = await harness({ connectorFetch: myselfFetch() });
    const admToken = await admin(h);
    await createJira(h, admToken, { email: "operator@ugurbank.local", botAccountId: OPERATORS_OWN });
    await post(h, "/studio/connections/jira/test", admToken);

    // A config-only edit that carries no botAccountId at all.
    const edit = await put(h, "/studio/connections/jira", admToken, {
      ...JIRA,
      displayName: "Jira (production)",
      config: { email: "operator@ugurbank.local" },
      enabled: true,
    });
    expect(edit.statusCode).toBe(200);
    expect((await h.connections.get("jira"))?.config["botAccountId"]).toBe(REAL_OWNER);
  });

  /**
   * The identity SPLIT — the failure the check above cannot see.
   *
   * The correction above asks "does the stored field match this token?". A
   * deployment can answer yes and still be broken: the connection holds a
   * human's personal token and faithfully learns the human's accountId, while
   * the engine is assigned work as the bot (`MAESTRO_BOT_ACCOUNT_ID`). Nothing
   * is self-contradictory, so nothing complains — and every rule the wizard
   * builds from that connection compares a human's id against a bot's assignee
   * and matches nothing, silently, forever.
   *
   * This is the live incident these tests were written from: connection
   * `jira` authenticated as the operator (`0uguryldz94@…`) while the pilot ran
   * as `uyildiz2054@…`, and three SAM1 rules were dead on arrival with a green
   * connection test above them.
   */
  describe("when the connection and the engine are different accounts", () => {
    /** The engine's own account — what `MAESTRO_BOT_ACCOUNT_ID` names. */
    const ENGINE = REAL_OWNER;
    /** A human's account: the connection's token really does belong to them. */
    const HUMAN = OPERATORS_OWN;
    /**
     * The address the CONNECTION is configured with. Operator-entered config,
     * not probe output — a connection read legitimately echoes it back, so it
     * is not what the PII assertions below chase.
     */
    const HUMAN_EMAIL = "0uguryldz94@gmail.com";
    /**
     * The address the `/myself` BODY carries. THIS is the PII that must never
     * escape: it comes from the probe, not from anything an operator typed.
     */
    const PROBE_EMAIL = "probe-only@gmail.com";

    function humanFetch(): ConnectorFetch {
      return () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ accountId: HUMAN, displayName: "Uğur Yıldız", emailAddress: PROBE_EMAIL }),
            { status: 200 },
          ),
        );
    }

    async function splitHarness(fetchImpl: ConnectorFetch): Promise<Harness> {
      return harness({
        connectorFetch: fetchImpl,
        deps: { config: { actorDomain: "ugurbank.local", engineBotAccountId: ENGINE } },
      });
    }

    it("warns and NAMES both identities when the token is not the engine's account", async () => {
      const h = await splitHarness(humanFetch());
      const admToken = await admin(h);
      // Internally consistent: the stored id IS this token's real owner. The
      // older check has nothing to correct — which is exactly the blind spot.
      await createJira(h, admToken, { email: HUMAN_EMAIL, botAccountId: HUMAN });

      const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
        ok: boolean;
        messageKey: string;
        messageParams?: Record<string, string>;
        engineMismatch?: { connection: string; engine: string };
        botAccountCorrected?: unknown;
      };

      // A warning, NOT a failure: the credential works, and a test that refused
      // would block the screen an operator fixes this on.
      expect(body.ok).toBe(true);
      expect(body.messageKey).toBe("connections.test.ok_engine_mismatch");
      // Both halves named, so the operator can see WHICH two accounts split.
      expect(body.messageParams?.["connection"]).toBe(HUMAN);
      expect(body.messageParams?.["engine"]).toBe(ENGINE);
      expect(body.engineMismatch).toEqual({ connection: HUMAN, engine: ENGINE });
      // Nothing was "corrected" — the stored value was never inconsistent.
      expect(body.botAccountCorrected).toBeUndefined();
      // And the stored id is left exactly as it was: it is not wrong ABOUT the
      // token, so overwriting it would replace a true value with another one.
      expect((await h.connections.get("jira"))?.config["botAccountId"]).toBe(HUMAN);
    });

    it("stays quiet when the connection IS the engine's account", async () => {
      const h = await splitHarness(myselfFetch());
      const admToken = await admin(h);
      await createJira(h, admToken, { email: "bot@ugurbank.local", botAccountId: ENGINE });

      const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
        ok: boolean;
        messageKey: string;
        engineMismatch?: unknown;
      };
      expect(body.ok).toBe(true);
      // The ordinary success message — no warning invented over a healthy pair.
      expect(body.messageKey).toBe("connections.test.ok_as");
      expect(body.engineMismatch).toBeUndefined();
    });

    it("says nothing when the deployment configured no engine account", async () => {
      // An install predating the assignment-based flow: there is no second
      // identity to disagree with, so an absent id must not read as a mismatch.
      const h = await harness({ connectorFetch: humanFetch() });
      const admToken = await admin(h);
      await createJira(h, admToken, { email: HUMAN_EMAIL, botAccountId: HUMAN });

      const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
        messageKey: string;
        engineMismatch?: unknown;
      };
      expect(body.messageKey).toBe("connections.test.ok_as");
      expect(body.engineMismatch).toBeUndefined();
    });

    it("does not fabricate a verdict when /myself could not be reached", async () => {
      // No live answer means the connection's real owner is UNKNOWN. An
      // unreachable probe must not be read as "it disagrees" — the check needs
      // evidence, and a failed reach is not evidence of a split.
      const h = await splitHarness(() => Promise.reject(new Error("ECONNREFUSED")));
      const admToken = await admin(h);
      await createJira(h, admToken, { email: HUMAN_EMAIL, botAccountId: HUMAN });

      const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
        ok: boolean;
        messageKey: string;
        engineMismatch?: unknown;
      };
      expect(body.ok).toBe(false);
      expect(body.messageKey).toBe("connections.test.unreachable");
      expect(body.engineMismatch).toBeUndefined();
      expect((await h.connections.get("jira"))?.config["botAccountId"]).toBe(HUMAN);
    });

    it("warns on TOP of a correction — the two checks are independent", async () => {
      // Stored id wrong about its own token AND the token is not the engine's:
      // both are true, and reporting only the first would leave the operator
      // fixing a field while the real split went unmentioned.
      const h = await splitHarness(humanFetch());
      const admToken = await admin(h);
      await createJira(h, admToken, { email: HUMAN_EMAIL, botAccountId: "712020:stale-hand-typed-id" });

      const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
        messageKey: string;
        engineMismatch?: { connection: string; engine: string };
        botAccountCorrected?: { from: string; to: string };
      };
      expect(body.messageKey).toBe("connections.test.ok_bot_fixed");
      expect(body.botAccountCorrected).toEqual({ from: "712020:stale-hand-typed-id", to: HUMAN });
      // The correction happened, and the split is still reported beside it.
      expect(body.engineMismatch).toEqual({ connection: HUMAN, engine: ENGINE });
    });

    it("records the split in the audit trail, with both ids and no email", async () => {
      const h = await splitHarness(humanFetch());
      const admToken = await admin(h);
      await createJira(h, admToken, { email: HUMAN_EMAIL, botAccountId: HUMAN });
      await post(h, "/studio/connections/jira/test", admToken);

      const entries = await h.auditStore.read();
      // The TEST row, not the create that precedes it on the same subject.
      const row = entries.find(
        (entry) => (entry.meta as Record<string, unknown> | undefined)?.["verb"] === "test_ok",
      );
      const meta = row?.meta as Record<string, unknown>;
      expect(meta["engineMismatchConnection"]).toBe(HUMAN);
      expect(meta["engineMismatchEngine"]).toBe(ENGINE);
      // Account ids are opaque; the probe's `/myself` email never reaches the trail.
      expect(JSON.stringify(entries)).not.toContain(PROBE_EMAIL);
    });

    it("keeps the token and the email out of the warning entirely", async () => {
      const h = await splitHarness(humanFetch());
      const admToken = await admin(h);
      await createJira(h, admToken, { email: HUMAN_EMAIL, botAccountId: HUMAN });

      const test = await post(h, "/studio/connections/jira/test", admToken);
      // The warning names two account ids and nothing else that identifies a
      // person — and never the credential that produced them.
      expect(test.body).not.toContain(PROBE_EMAIL);
      expect(test.body).not.toContain(TOKEN);
      // The connection read that follows may echo the operator's own config, but
      // still never the probe's email or the token.
      const read = await get(h, "/studio/connections", admToken);
      expect(read.body).not.toContain(PROBE_EMAIL);
      expect(read.body).not.toContain(TOKEN);
    });
  });
});

describe("DELETE /studio/connections/:id", () => {
  it("removes the connection and its secret", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await createGithub(h, admToken);
    const record = await h.connections.get("github");

    const response = await del(h, "/studio/connections/github", admToken);
    expect(response.statusCode).toBe(204);
    expect(await h.connections.get("github")).toBeNull();
    expect(h.connectorSecrets.has(record!.secretRef!)).toBe(false);
  });

  it("refuses a viewer", async () => {
    const h = await harness();
    const admToken = await admin(h);
    await createGithub(h, admToken);
    expect((await del(h, "/studio/connections/github", await viewer(h))).statusCode).toBe(403);
  });

  it("404s on a connection that does not exist", async () => {
    const h = await harness();
    expect((await del(h, "/studio/connections/nope", await admin(h))).statusCode).toBe(404);
  });
});

describe("when the store is not wired", () => {
  it("refuses by name (503) rather than answering an empty list", async () => {
    // A deployment that injects no connection store: the route refuses.
    const opts: HarnessOptions = { deps: { connections: undefined, connectorSecrets: undefined } };
    const h = await harness(opts);
    const admToken = await admin(h);
    const response = await get(h, "/studio/connections", admToken);
    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: string }).error).toBe("capability_not_wired");
  });
});

/**
 * The Jira bot's own MAESTRO account.
 *
 * The connection knows who the bot is — `/myself` is probed on every test, and
 * `config.botAccountId` is healed from it. But nothing ever created a directory
 * ROW for that identity, and every surface that resolves an actor goes through
 * `UserDirectory.find`. On the pilot the row was made BY HAND, in
 * `maestro-admins`, which is both a deployment that cannot be reproduced and an
 * audit finding: that group is the one self-approval exemption in the system, so
 * a bot inside it can close four-eyes on its own.
 *
 * These tests pin the replacement: the row is provisioned from the LIVE identity,
 * with the LEAST privilege that works, and an operator's later adjustments to it
 * are never silently undone.
 */
describe("the Jira bot's Maestro account", () => {
  const BOT_ACCOUNT = "712020:b836c135-c9d3-499a-a665-aed43d362cfd";
  /** The username provisioning derives — from the CONNECTION id, not the GUID. */
  const BOT_USERNAME = "jira-bot-jira";

  function myself(over: Record<string, unknown> = {}): ConnectorFetch {
    return () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            accountId: BOT_ACCOUNT,
            displayName: "maestro",
            emailAddress: "bot@ugurbank.local",
            ...over,
          }),
          { status: 200 },
        ),
      );
  }

  const JIRA = {
    id: "jira",
    kind: "jira_cloud",
    displayName: "Jira Cloud",
    baseUrl: "https://ugurbank.atlassian.net",
    authKind: "basic",
  } as const;

  async function createJira(
    h: Harness,
    token: string,
    config: Record<string, string> = { email: "bot@ugurbank.local" },
  ): Promise<LightMyRequestResponse> {
    return post(h, "/studio/connections", token, { ...JIRA, config, token: TOKEN });
  }

  it("provisions the bot's user row when the connection is CREATED", async () => {
    const h = await harness({ connectorFetch: myself() });
    const admToken = await admin(h);

    // Nothing exists before — this is the gap on every deployment but the pilot.
    expect(await h.users.find(BOT_USERNAME)).toBeNull();

    const response = await createJira(h, admToken);
    expect(response.statusCode).toBe(201);

    const bot = await h.users.find(BOT_USERNAME);
    expect(bot).not.toBeNull();
    expect(bot?.active).toBe(true);
  });

  it("provisions it on a successful TEST too — the operator may never press create again", async () => {
    // Created while the target was unreachable, so the create path provisioned
    // nothing: this is the connection that predates the feature, repaired by an
    // ordinary test. The fetch is switchable so ONE harness can live through
    // both conditions — the point of the test is that the second call repairs
    // what the first could not do, which two harnesses could not show.
    let reachable = false;
    const h = await harness({
      connectorFetch: (...args) =>
        reachable ? myself()(...args) : Promise.reject(new Error("ECONNREFUSED")),
    });
    const admToken = await admin(h);
    await createJira(h, admToken);
    expect(await h.users.find(BOT_USERNAME)).toBeNull();

    // The network comes back and the operator tests the connection.
    reachable = true;
    const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
      ok: boolean;
      botUser?: { username: string; displayName: string; created: boolean };
    };
    expect(body.ok).toBe(true);
    expect(body.botUser).toEqual({ username: BOT_USERNAME, displayName: "maestro", created: true });
    expect(await h.users.find(BOT_USERNAME)).not.toBeNull();
  });

  it("uses the display name the OPERATOR supplied on the connection form", async () => {
    const h = await harness({ connectorFetch: myself() });
    const admToken = await admin(h);
    await createJira(h, admToken, {
      email: "bot@ugurbank.local",
      botDisplayName: "maestro (Jira bot)",
    });

    // The operator's name wins over Jira's own "maestro" — this is what makes
    // the row read clearly in "Kullanıcılar & roller".
    expect((await h.users.find(BOT_USERNAME))?.displayName).toBe("maestro (Jira bot)");
  });

  it("falls back to Jira's own displayName when the operator supplied none", async () => {
    const h = await harness({ connectorFetch: myself({ displayName: "Maestro Otomasyon" }) });
    const admToken = await admin(h);
    await createJira(h, admToken);

    expect((await h.users.find(BOT_USERNAME))?.displayName).toBe("Maestro Otomasyon");
  });

  it("gives the bot NO groups — it must not be able to satisfy four-eyes alone", async () => {
    const h = await harness({ connectorFetch: myself() });
    const admToken = await admin(h);
    await createJira(h, admToken);

    const bot = await h.users.find(BOT_USERNAME);
    // The assertion is on the EXACT set, not merely "not admin": this is the
    // decision the pilot got wrong, so a future change to it must be deliberate
    // enough to come and edit this line.
    expect(bot?.groups).toEqual([]);
    // `maestro-admins` is what `isMasterApprover` reads (BFF and workflows
    // alike). A bot in it approves its own work.
    expect(bot?.groups).not.toContain("maestro-admins");
    // The floor, and nothing above it: read-only.
    expect(bot?.roles).toEqual(["viewer"]);
  });

  it("has no usable password — the row is an identity, not a login", async () => {
    const h = await harness({ connectorFetch: myself() });
    const admToken = await admin(h);
    await createJira(h, admToken);

    const bot = await h.users.find(BOT_USERNAME);
    // Not a bcrypt hash, so no password can ever verify against it.
    expect(bot?.passwordHash.startsWith("$2")).toBe(false);
    expect(bot?.mustChangePassword).toBe(false);
  });

  it("does not duplicate or clobber the row when the connection is tested TWICE", async () => {
    const h = await harness({ connectorFetch: myself() });
    const admToken = await admin(h);
    await createJira(h, admToken, {
      email: "bot@ugurbank.local",
      botDisplayName: "maestro (Jira bot)",
    });

    // An operator then adjusts the account by hand — the exact thing a
    // re-provision must not undo. They put it in a group and deactivate it.
    const before = await h.users.find(BOT_USERNAME);
    await h.users.upsert({ ...before!, groups: ["developers"], roles: ["viewer", "developer"], active: false });

    const second = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
      botUser?: { created: boolean };
    };
    // Recognised as existing, not minted again.
    expect(second.botUser?.created).toBe(false);

    const after = await h.users.find(BOT_USERNAME);
    // The operator's group survives — provisioning never rewrites authority.
    expect(after?.groups).toEqual(["developers"]);
    expect(after?.roles).toEqual(["viewer", "developer"]);
    // And a deliberately disabled bot stays disabled: a test is not a
    // re-enablement.
    expect(after?.active).toBe(false);
    // Still exactly one row for this connection.
    expect((await h.users.list(100)).filter((u) => u.username === BOT_USERNAME)).toHaveLength(1);
  });

  it("DOES update the display name on an existing row — a rename must take effect", async () => {
    const h = await harness({ connectorFetch: myself() });
    const admToken = await admin(h);
    await createJira(h, admToken);
    expect((await h.users.find(BOT_USERNAME))?.displayName).toBe("maestro");

    // The operator edits the connection and names the bot properly.
    await put(h, "/studio/connections/jira", admToken, {
      ...JIRA,
      config: { email: "bot@ugurbank.local", botDisplayName: "maestro (Jira bot)" },
    });
    await post(h, "/studio/connections/jira/test", admToken);

    expect((await h.users.find(BOT_USERNAME))?.displayName).toBe("maestro (Jira bot)");
    // The rename changed presentation and nothing else.
    expect((await h.users.find(BOT_USERNAME))?.groups).toEqual([]);
  });

  it("provisions NOTHING when /myself fails — no identity, no row", async () => {
    const h = await harness({ connectorFetch: () => Promise.reject(new Error("ECONNREFUSED")) });
    const admToken = await admin(h);
    await createJira(h, admToken);

    const body = (await post(h, "/studio/connections/jira/test", admToken)).json() as {
      ok: boolean;
      botUser?: unknown;
    };
    expect(body.ok).toBe(false);
    expect(body.botUser).toBeUndefined();
    // A row invented without a live identity behind it would be worse than none.
    expect(await h.users.find(BOT_USERNAME)).toBeNull();
  });

  it("provisions nothing when the probe answers 200 but names no account", async () => {
    const h = await harness({ connectorFetch: myself({ accountId: undefined }) });
    const admToken = await admin(h);
    await createJira(h, admToken);

    expect(await h.users.find(BOT_USERNAME)).toBeNull();
  });

  it("provisions nothing for a non-Jira connection — a key is not an identity", async () => {
    const h = await harness({ connectorFetch: myself() });
    const admToken = await admin(h);
    await createGithub(h, admToken);

    expect(await h.users.find("jira-bot-github")).toBeNull();
  });

  it("records the minted account in the audit trail", async () => {
    const h = await harness({ connectorFetch: myself() });
    const admToken = await admin(h);
    await createJira(h, admToken, {
      email: "bot@ugurbank.local",
      botDisplayName: "maestro (Jira bot)",
    });

    const entries = await h.auditStore.read();
    const created = entries.find(
      (entry) => (entry.meta as Record<string, unknown> | undefined)?.["verb"] === "created",
    );
    // An account that can appear as an actor came into existence; the trail says
    // so, and names it.
    const meta = created?.meta as Record<string, unknown>;
    expect(meta["botUser"]).toBe(BOT_USERNAME);
    expect(meta["botUserState"]).toBe("created");
    expect(meta["botUserDisplayName"]).toBe("maestro (Jira bot)");
  });

  it("names the bot in the users table the panel reads", async () => {
    const h = await harness({ connectorFetch: myself() });
    const admToken = await admin(h);
    await createJira(h, admToken, {
      email: "bot@ugurbank.local",
      botDisplayName: "maestro (Jira bot)",
    });

    const body = (await get(h, "/studio/users", admToken)).json() as {
      items: readonly { username: string; displayName: string; groups: readonly string[] }[];
    };
    const bot = body.items.find((item) => item.username === BOT_USERNAME);
    expect(bot?.displayName).toBe("maestro (Jira bot)");
    expect(bot?.groups).toEqual([]);

    // A human account still reads by its username — the field is a fallback,
    // not a second thing every account has to fill in.
    const human = body.items.find((item) => item.username === "ayse.kaya");
    expect(human?.displayName).toBe("ayse.kaya");
  });
});

/**
 * The on-premise model server (`openai_compat`).
 *
 * The kind exists because an operator installing this stack behind a bank's
 * firewall runs their own OpenAI-shaped endpoint — vLLM, llama.cpp, Ollama —
 * and the panel had no way to represent one: both LLM kinds were cloud vendors
 * and both demanded a credential. Two things are genuinely different about a
 * self-hosted server, and both are what these tests pin down. Its API key is
 * OPTIONAL, so an empty token has to survive the whole path rather than being
 * refused at the schema; and the operator needs to know WHICH MODEL it serves,
 * because a reachable server that does not load the configured model is the
 * failure that otherwise only appears at the first real inference call.
 *
 * No network anywhere — `connectorFetch` returns a canned `/v1/models`.
 */
describe("on-premise model server (openai_compat)", () => {
  const ONPREM = {
    id: "llm-onprem",
    kind: "openai_compat",
    displayName: "Kurum içi model",
    baseUrl: "http://10.0.0.5:8000",
    authKind: "bearer",
  } as const;

  /** The real shape a vLLM/Ollama `/v1/models` answer has. */
  function models(...ids: readonly string[]): ConnectorFetch {
    return () =>
      Promise.resolve(
        new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }), {
          status: 200,
        }),
      );
  }

  async function createOnPrem(
    h: Harness,
    admToken: string,
    over: Record<string, unknown> = {},
  ): Promise<LightMyRequestResponse> {
    return post(h, "/studio/connections", admToken, { ...ONPREM, ...over });
  }

  it("round-trips through create, update and test like any other kind", async () => {
    const h = await harness({ connectorFetch: models("gpt-oss-120b") });
    const admToken = await admin(h);

    expect((await createOnPrem(h, admToken, { config: { model: "gpt-oss-120b" }, token: TOKEN })).statusCode).toBe(201);

    // An edit that changes only the display name keeps the stored credential
    // and the learned config — the same contract every other kind has.
    const updated = await put(h, "/studio/connections/llm-onprem", admToken, {
      ...ONPREM,
      displayName: "Kurum içi model (yeni ad)",
      config: { model: "gpt-oss-120b" },
    });
    expect(updated.statusCode).toBe(200);
    const row = await h.connections.get("llm-onprem");
    expect(row?.displayName).toBe("Kurum içi model (yeni ad)");
    expect(row?.secretMask).toBe(TOKEN.slice(-4));

    const body = (await post(h, "/studio/connections/llm-onprem/test", admToken)).json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("accepts an EMPTY token — a server that needs no key is a real configuration", async () => {
    const h = await harness({ connectorFetch: models("gpt-oss-120b") });
    const admToken = await admin(h);

    // The empty string is SENT, not omitted: it means "this endpoint wants no
    // key", which is a different instruction from "leave the token alone".
    expect((await createOnPrem(h, admToken, { token: "" })).statusCode).toBe(201);

    // It reached the encipher path and came back out — a stored, decryptable
    // empty secret rather than a row with no credential at all.
    const row = await h.connections.get("llm-onprem");
    expect(row?.secretRef).not.toBeNull();
    expect(row?.secretMask).toBe("");
    expect(await h.connectorSecrets.get(row!.secretRef!)).toBe("");
  });

  it("PROBES a keyless server instead of refusing it with 'no token'", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const connectorFetch: ConnectorFetch = (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization") });
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "gpt-oss-120b" }] }), { status: 200 }));
    };
    const h = await harness({ connectorFetch });
    const admToken = await admin(h);
    await createOnPrem(h, admToken, { token: "", config: { model: "gpt-oss-120b" } });

    const body = (await post(h, "/studio/connections/llm-onprem/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
    };
    // The old behaviour would have short-circuited to `no_token` and never
    // dialled a server that answers perfectly well.
    expect(body.ok).toBe(true);
    expect(body.messageKey).not.toBe("connections.test.no_token");
    expect(calls).toHaveLength(1);
    // No `Authorization: Bearer ` with nothing after it — some servers 401 on
    // an empty bearer, so the header is omitted entirely.
    expect(calls[0]?.auth).toBeNull();
  });

  it("reports the MODELS the server serves — the fact the operator came for", async () => {
    const h = await harness({ connectorFetch: models("gpt-oss-120b", "qwen2.5-7b") });
    const admToken = await admin(h);
    await createOnPrem(h, admToken, { token: TOKEN, config: { model: "gpt-oss-120b" } });

    const body = (await post(h, "/studio/connections/llm-onprem/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
      messageParams?: { models: string; count: string };
    };
    expect(body.ok).toBe(true);
    expect(body.messageKey).toBe("connections.test.ok_models");
    expect(body.messageParams?.models).toContain("gpt-oss-120b");
    expect(body.messageParams?.count).toBe("2");
  });

  it("FAILS when the configured model is not among the ones served", async () => {
    // The silent killer: the server is up, the key is fine, and every run will
    // still die at the first inference call because this model is not loaded.
    const h = await harness({ connectorFetch: models("qwen2.5-7b") });
    const admToken = await admin(h);
    await createOnPrem(h, admToken, { token: TOKEN, config: { model: "gpt-oss-120b" } });

    const body = (await post(h, "/studio/connections/llm-onprem/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
      messageParams?: { model: string; models: string };
    };
    expect(body.ok).toBe(false);
    expect(body.messageKey).toBe("connections.test.model_missing");
    expect(body.messageParams?.model).toBe("gpt-oss-120b");
    // It names what IS served, so the operator can fix the id rather than guess.
    expect(body.messageParams?.models).toContain("qwen2.5-7b");

    const row = await h.connections.get("llm-onprem");
    expect(row?.lastTestOk).toBe(false);
    expect(row?.lastTestNote?.split("?")[0]).toBe("connections.test.model_missing");
  });

  it("says so plainly when a 200 carries no readable model list", async () => {
    const connectorFetch: ConnectorFetch = () => Promise.resolve(new Response("not json", { status: 200 }));
    const h = await harness({ connectorFetch });
    const admToken = await admin(h);
    await createOnPrem(h, admToken, { token: TOKEN });

    const body = (await post(h, "/studio/connections/llm-onprem/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
    };
    // Reachable and authenticated, but nothing learned about the model — not
    // dressed up as a green that implies more than was actually checked.
    expect(body.ok).toBe(true);
    expect(body.messageKey).toBe("connections.test.ok_no_models");
  });

  it("strips a trailing /v1 so the probe and the driver dial the SAME path", async () => {
    const calls: string[] = [];
    const connectorFetch: ConnectorFetch = (url) => {
      calls.push(url);
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "gpt-oss-120b" }] }), { status: 200 }));
    };
    const h = await harness({ connectorFetch });
    const admToken = await admin(h);
    // What every vendor's console prints, and what an operator will paste. The
    // driver appends `/v1` itself, so left alone this becomes `/v1/v1/...`.
    await createOnPrem(h, admToken, { baseUrl: "http://10.0.0.5:8000/v1", token: TOKEN });

    await post(h, "/studio/connections/llm-onprem/test", admToken);
    expect(calls[0]).toBe("http://10.0.0.5:8000/v1/models");
    expect(calls[0]).not.toContain("/v1/v1");
  });

  it("reports 401, 404 and an unreachable host as three DISTINCT honest outcomes", async () => {
    for (const [status, key] of [
      [401, "connections.test.http_error"],
      [404, "connections.test.http_error"],
    ] as const) {
      const h = await harness({ connectorFetch: () => Promise.resolve(new Response("no", { status })) });
      const admToken = await admin(h);
      await createOnPrem(h, admToken, { token: TOKEN });
      const body = (await post(h, "/studio/connections/llm-onprem/test", admToken)).json() as {
        ok: boolean;
        messageKey: string;
        messageParams?: { status: string };
      };
      expect(body.ok).toBe(false);
      expect(body.messageKey).toBe(key);
      expect(body.messageParams?.status).toBe(String(status));
    }

    const down = await harness({ connectorFetch: () => Promise.reject(new Error("ECONNREFUSED")) });
    const admToken = await admin(down);
    await createOnPrem(down, admToken, { token: TOKEN });
    const body = (await post(down, "/studio/connections/llm-onprem/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
    };
    expect(body.ok).toBe(false);
    expect(body.messageKey).toBe("connections.test.unreachable");
  });

  it("keeps the API key out of every message, row and audit entry", async () => {
    // The transport throws with the token in its message — the same trap the
    // GitHub case guards, re-asserted for the kind that has a new probe path.
    const h = await harness({ connectorFetch: () => Promise.reject(new Error(`connect failed ${TOKEN}`)) });
    const admToken = await admin(h);
    await createOnPrem(h, admToken, { token: TOKEN });

    const response = await post(h, "/studio/connections/llm-onprem/test", admToken);
    expect(response.body).not.toContain(TOKEN);

    const row = await h.connections.get("llm-onprem");
    expect(JSON.stringify(row)).not.toContain(TOKEN);

    const listed = await get(h, "/studio/connections", admToken);
    expect(listed.body).not.toContain(TOKEN);
  });
});

/**
 * A stored test note has to survive a page reload with its meaning intact.
 *
 * Six of the most useful diagnostics interpolate a value — "Sunucu adı
 * çözülemedi (DNS): {host}" — and the panel re-renders `lastTestNote` from the
 * database. Storing the key alone meant the operator's best clue turned into
 * the literal string `{host}` the moment they refreshed: correct on the first
 * test, broken forever after, and looking like a product bug rather than a
 * missing value.
 */
describe("noteWithParams", () => {
  it("keeps the bare key when there is nothing to interpolate", () => {
    expect(noteWithParams("connections.test.ok", undefined)).toBe("connections.test.ok");
    expect(noteWithParams("connections.test.ok", {})).toBe("connections.test.ok");
  });

  it("carries the params so the panel can render them after a reload", () => {
    expect(noteWithParams("connections.test.dns", { host: "jira.banka.local" })).toBe(
      "connections.test.dns?host=jira.banka.local",
    );
  });

  it("encodes values that would otherwise break the encoding", () => {
    const note = noteWithParams("connections.test.refused", { host: "a b&c=d", port: "8000" });
    const query = new URLSearchParams(note.slice(note.indexOf("?") + 1));
    expect(query.get("host")).toBe("a b&c=d");
    expect(query.get("port")).toBe("8000");
  });

  /**
   * The column is `VarChar(128)`. A note that renders with `{host}` still beats
   * a note that fails to write, so the params are dropped rather than the key
   * truncated into something that resolves to nothing.
   */
  it("drops the params rather than overflowing the column", () => {
    const note = noteWithParams("connections.test.dns", { host: "x".repeat(200) });
    expect(note).toBe("connections.test.dns");
    expect(note.length).toBeLessThanOrEqual(CONNECTION_NOTE_MAX);
  });
});
