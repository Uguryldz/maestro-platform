import { ObjectNotFoundError } from "@maestro/storage";
import { describe, expect, it } from "vitest";
import { SESSION_KEY_BYTES } from "../src/crypto.js";
import { SessionCryptoError } from "../src/errors.js";
import {
  listSessionKeys,
  loadSessionFile,
  saveSessionFile,
  sessionArchiveKey,
  sessionFileName,
  tryLoadSessionFile,
  type SessionArchiveDeps,
} from "../src/session.js";
import { fakeStorage } from "./fakes/storage.js";
import { RUN_ID, TICKET_KEY } from "./fakes/support.js";

const KEY = new Uint8Array(SESSION_KEY_BYTES).fill(5);
const AT = "2026-08-08T10:00:00+03:00";
const SESSION = new TextEncoder().encode('{"sessionId":"s-1","turns":42}');

function deps(): SessionArchiveDeps & { storage: ReturnType<typeof fakeStorage> } {
  return { storage: fakeStorage(), key: KEY };
}

describe("session archive keys", () => {
  it("uses the storage package's M65 archive layout", () => {
    expect(sessionArchiveKey({ ticketKey: TICKET_KEY, runId: RUN_ID, at: AT })).toBe(
      `archive/2026/${TICKET_KEY}/${sessionFileName(RUN_ID)}`,
    );
  });

  it("rejects a key that could not be parsed back", () => {
    expect(() => sessionArchiveKey({ ticketKey: "not a key", runId: RUN_ID, at: AT })).toThrow();
  });
});

describe("saveSessionFile / loadSessionFile", () => {
  it("stores ciphertext and reads the session back", async () => {
    const d = deps();
    const saved = await saveSessionFile(d, { ticketKey: TICKET_KEY, runId: RUN_ID, at: AT }, SESSION);

    const stored = d.storage.objects.get(saved.key);
    expect(stored).toBeDefined();
    expect(Buffer.from(stored as Uint8Array).toString("utf8")).not.toContain("sessionId");
    expect(saved.bytes).toBe((stored as Uint8Array).length);
    expect(await loadSessionFile(d, saved.key)).toEqual(SESSION);
  });

  it("cannot be read with another instance's key", async () => {
    const d = deps();
    const saved = await saveSessionFile(d, { ticketKey: TICKET_KEY, runId: RUN_ID, at: AT }, SESSION);
    const wrong = { ...d, key: new Uint8Array(SESSION_KEY_BYTES).fill(6) };
    await expect(loadSessionFile(wrong, saved.key)).rejects.toBeInstanceOf(SessionCryptoError);
  });

  it("reports a missing session as absence, not as failure (M65)", async () => {
    const d = deps();
    const key = sessionArchiveKey({ ticketKey: TICKET_KEY, runId: RUN_ID, at: AT });
    expect(await tryLoadSessionFile(d, key)).toBeNull();
    await expect(loadSessionFile(d, key)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("never treats a damaged session as a fresh start", async () => {
    const d = deps();
    const saved = await saveSessionFile(d, { ticketKey: TICKET_KEY, runId: RUN_ID, at: AT }, SESSION);
    const blob = d.storage.objects.get(saved.key) as Uint8Array;
    blob[blob.length - 1] = (blob[blob.length - 1] as number) ^ 0xff;
    await expect(tryLoadSessionFile(d, saved.key)).rejects.toBeInstanceOf(SessionCryptoError);
  });

  it("survives a workspace that is gone: the archive is the only copy needed", async () => {
    const d = deps();
    const saved = await saveSessionFile(d, { ticketKey: TICKET_KEY, runId: RUN_ID, at: AT }, SESSION);
    // The runner disk is wiped; nothing but the bucket remains.
    const restored = await tryLoadSessionFile({ ...d, storage: d.storage }, saved.key);
    expect(restored).toEqual(SESSION);
  });

  it("refuses a session copied onto another ticket's key (Y-1)", async () => {
    const d = deps();
    const mine = await saveSessionFile(
      d,
      { ticketKey: "UGURPAY-1111", runId: "run-UGURPAY-1111", at: AT },
      SESSION,
    );
    // Anyone who can write to the bucket can copy the object; the seal is
    // bound to the key, so the copy cannot be resumed into another ticket.
    const stolen = `archive/2026/UGURPAY-2222/${sessionFileName("run-UGURPAY-2222")}`;
    await d.storage.put(stolen, d.storage.objects.get(mine.key) as Uint8Array);

    await expect(loadSessionFile(d, stolen)).rejects.toBeInstanceOf(SessionCryptoError);
    await expect(tryLoadSessionFile(d, stolen)).rejects.toBeInstanceOf(SessionCryptoError);
    // The original still opens: the binding is not a blanket refusal.
    expect(await loadSessionFile(d, mine.key)).toEqual(SESSION);
  });

  it("asks for Object Lock when the caller wants the archive immutable (M5/M57)", async () => {
    const calls: { key: string; opts: unknown }[] = [];
    const storage = fakeStorage();
    const spy = {
      ...storage,
      put: async (key: string, data: Uint8Array, opts?: unknown) => {
        calls.push({ key, opts });
        await storage.put(key, data);
      },
    };
    await saveSessionFile(
      { storage: spy, key: KEY, objectLock: true },
      { ticketKey: TICKET_KEY, runId: RUN_ID, at: AT },
      SESSION,
    );
    expect(calls[0]?.opts).toEqual({
      contentType: "application/octet-stream",
      objectLock: true,
    });
  });

  it("does not ask for Object Lock unless the caller does", async () => {
    const calls: unknown[] = [];
    const storage = fakeStorage();
    await saveSessionFile(
      {
        storage: {
          ...storage,
          put: async (key: string, data: Uint8Array, opts?: unknown) => {
            calls.push(opts);
            await storage.put(key, data);
          },
        },
        key: KEY,
      },
      { ticketKey: TICKET_KEY, runId: RUN_ID, at: AT },
      SESSION,
    );
    expect(calls[0]).toEqual({ contentType: "application/octet-stream" });
  });
});

describe("listSessionKeys", () => {
  it("finds this package's session files and ignores everything else", async () => {
    const d = deps();
    await saveSessionFile(d, { ticketKey: TICKET_KEY, runId: RUN_ID, at: AT }, SESSION);
    await saveSessionFile(
      d,
      { ticketKey: TICKET_KEY, runId: "run-UGURPAY-1234-b", at: AT },
      SESSION,
    );
    await d.storage.put(`archive/2026/${TICKET_KEY}/notes.txt`, new Uint8Array([1]));
    await d.storage.put(`archive/2026/OTHER-1/${sessionFileName(RUN_ID)}`, new Uint8Array([1]));

    const keys = await listSessionKeys(d.storage, TICKET_KEY, 2026);
    expect(keys).toEqual([
      `archive/2026/${TICKET_KEY}/${sessionFileName("run-UGURPAY-1234-b")}`,
      `archive/2026/${TICKET_KEY}/${sessionFileName(RUN_ID)}`,
    ]);
  });

  it("is empty for a year with no archive", async () => {
    const d = deps();
    expect(await listSessionKeys(d.storage, TICKET_KEY, 2025)).toEqual([]);
  });

  it("scans a year range, so a ticket that went idle over new year is found (D-12)", async () => {
    const d = deps();
    await saveSessionFile(
      d,
      { ticketKey: TICKET_KEY, runId: RUN_ID, at: "2025-12-20T10:00:00+03:00" },
      SESSION,
    );
    expect(await listSessionKeys(d.storage, TICKET_KEY, 2026)).toEqual([]);
    expect(await listSessionKeys(d.storage, TICKET_KEY, 2025, 2026)).toEqual([
      `archive/2025/${TICKET_KEY}/${sessionFileName(RUN_ID)}`,
    ]);
  });

  it("refuses a range that runs backwards", async () => {
    const d = deps();
    await expect(listSessionKeys(d.storage, TICKET_KEY, 2026, 2025)).rejects.toThrow();
  });
});
