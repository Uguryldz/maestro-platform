import { describe, expect, it } from "vitest";
import {
  bearerToken,
  InMemorySessionStore,
  isExpired,
  issueSession,
  newSessionToken,
  SESSION_TTL_MS,
} from "../src/auth/sessions.js";
import { isHumanChannel, sessionActor, toActor } from "../src/actor.js";
import { TestClock } from "./helpers.js";

const USER = {
  userId: "ayse.kaya@ugurbank.local",
  username: "ayse.kaya",
  groups: ["tech-leads"],
  roles: ["admin"],
};

describe("sessions", () => {
  it("expires exactly eight hours after issue (M8)", () => {
    const clock = new TestClock();
    const session = issueSession(USER, { clock });

    expect(Date.parse(session.expiresAt) - Date.parse(session.issuedAt)).toBe(SESSION_TTL_MS);
    expect(isExpired(session, clock.now())).toBe(false);

    clock.advance(SESSION_TTL_MS);
    // The boundary counts as expired: a token valid "up to and including" its
    // last instant is a token that outlives its window.
    expect(isExpired(session, clock.now())).toBe(true);
  });

  it("treats an unparseable expiry as expired", () => {
    const session = { ...issueSession(USER, { clock: new TestClock() }), expiresAt: "soon" };
    expect(isExpired(session, new Date())).toBe(true);
  });

  it("mints unpredictable tokens", () => {
    const tokens = new Set(Array.from({ length: 64 }, () => newSessionToken()));
    expect(tokens.size).toBe(64);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it("stores, finds and drops a session", async () => {
    const store = new InMemorySessionStore();
    const session = issueSession(USER, { clock: new TestClock() });

    await store.create(session);
    expect(await store.get(session.token)).toMatchObject({ userId: USER.userId });
    expect(await store.get(`${session.token}x`)).toBeNull();

    await store.delete(session.token);
    expect(await store.get(session.token)).toBeNull();
  });

  it("purges expired sessions", async () => {
    const clock = new TestClock();
    const store = new InMemorySessionStore();
    await store.create(issueSession(USER, { clock }));

    clock.advance(SESSION_TTL_MS + 1);
    expect(store.purgeExpired(clock.now())).toBe(1);
  });

  it("reads a bearer header and nothing else", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer abc123")).toBe("abc123");
    expect(bearerToken("Basic abc123")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe("audit actors (M33/M101)", () => {
  it("qualifies a bare Jira login with the corporate domain", () => {
    expect(toActor("mert.demir", "ugurbank.local")).toBe("mert.demir@ugurbank.local");
  });

  it("leaves an already-qualified account alone", () => {
    expect(toActor(" mert.demir@ugurbank.local ", "elsewhere")).toBe("mert.demir@ugurbank.local");
  });

  it("refuses an actor the audit chain could not classify", () => {
    expect(() => toActor("iki kelime", "ugurbank.local")).toThrow();
  });

  it("keeps the delegating human visible for an AI session", () => {
    const clock = new TestClock();
    const delegated = issueSession(USER, { clock, delegated: true });

    expect(sessionActor(delegated)).toBe("ai-via:ayse.kaya@ugurbank.local");
    expect(isHumanChannel(delegated)).toBe(false);
    expect(sessionActor(issueSession(USER, { clock }))).toBe("ayse.kaya@ugurbank.local");
  });
});
