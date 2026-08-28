import { describe, expect, it } from "vitest";
import type { LogLevel } from "../src/state.js";
import {
  commentCarriesMarker,
  detectOrphans,
  ORPHAN_MARKER,
  orphanCommentText,
  orphanJql,
  type OrphanWork,
} from "../src/orphan.js";

/**
 * Yetim iş görünürlüğü (v1) — "hiç kapanmayan worker" paketi.
 *
 * Restart, onay kapısında bekleyen işi yetim bırakır. Bu testler v1 sözleşmesini
 * sabitler: bulunan yetime günlük satırı + BİR KEZ yorum; işaret zaten varsa
 * yorum atlanır; arama/yorum hatası asla dışarı taşmaz (boot sürer). Hepsi
 * çevrimdışı — iş portu sahtedir, ağ yoktur.
 */

const MANAGER = "712020:manager-account-id";
const REVIEW = "İNCELEMEDE";

interface FakeWorkOptions {
  issues?: unknown[];
  comments?: Record<string, unknown[]>;
  searchError?: Error;
  commentError?: Error;
}

function fakeWork(options: FakeWorkOptions = {}): {
  work: OrphanWork;
  searches: { jql: string; maxResults?: number }[];
  added: { key: string; body: unknown }[];
  listed: string[];
} {
  const searches: { jql: string; maxResults?: number }[] = [];
  const added: { key: string; body: unknown }[] = [];
  const listed: string[] = [];
  const work: OrphanWork = {
    searchIssues(request) {
      searches.push({ jql: request.jql, ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }) });
      if (options.searchError) return Promise.reject(options.searchError);
      return Promise.resolve({ issues: options.issues ?? [] });
    },
    listComments(key) {
      listed.push(key);
      return Promise.resolve(options.comments?.[key] ?? []);
    },
    addComment(key, body) {
      if (options.commentError) return Promise.reject(options.commentError);
      added.push({ key, body });
      return Promise.resolve({ commentId: `c-${added.length}` });
    },
  };
  return { work, searches, added, listed };
}

function collectLog(): { log: (level: LogLevel, text: string) => void; lines: { level: LogLevel; text: string }[] } {
  const lines: { level: LogLevel; text: string }[] = [];
  return { log: (level, text) => lines.push({ level, text }), lines };
}

function issue(key: string): unknown {
  return { key, fields: { summary: `${key} özeti`, status: { name: REVIEW } } };
}

describe("orphanJql", () => {
  it("keşif deseniyle aynı sınırları taşır: proje adlı, statü ve accountId tırnaklı", () => {
    expect(orphanJql(MANAGER, REVIEW)).toBe(
      'project = OPS AND labels = maestro AND status = "İNCELEMEDE" ' +
        `AND assignee = "${MANAGER}" ORDER BY created DESC`,
    );
  });
});

describe("detectOrphans", () => {
  it("bulunan yetime warn günlüğü yazar ve ticket'a işaretli TEK yorum bırakır", async () => {
    const { work, searches, added } = fakeWork({ issues: [issue("OPS-7")] });
    const { log, lines } = collectLog();

    const report = await detectOrphans({ work, managerAccountId: MANAGER, reviewStatusName: REVIEW, log });

    // Arama: kapı-durumu JQL'i, sınırlı sayfa.
    expect(searches).toHaveLength(1);
    expect(searches[0]?.jql).toBe(orphanJql(MANAGER, REVIEW));
    expect(searches[0]?.maxResults).toBe(20);

    // (a) günlük: sessiz kayıp olmasın — operatör panelde görür.
    const warn = lines.find((l) => l.level === "warn");
    expect(warn?.text).toContain("yetim iş: OPS-7 kapıda bekliyordu");
    expect(warn?.text).toContain("Maestro Bot'a atayın");

    // (b) ticket'a bir yorum, işaret metni içinde.
    expect(added).toHaveLength(1);
    expect(added[0]?.key).toBe("OPS-7");
    expect(String(added[0]?.body)).toContain(ORPHAN_MARKER);
    expect(report).toEqual({ found: ["OPS-7"], commented: ["OPS-7"], skippedExisting: [] });
  });

  it("işaret yorumu zaten varsa yeniden yorum YAZMAZ (çift-yorum engeli)", async () => {
    // Cloud yorumları ADF taşır — işaret bir metin düğümünün içindedir.
    const existing = {
      id: "100",
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: orphanCommentText() }] }],
      },
    };
    const { work, added, listed } = fakeWork({
      issues: [issue("OPS-7")],
      comments: { "OPS-7": [existing] },
    });
    const { log, lines } = collectLog();

    const report = await detectOrphans({ work, managerAccountId: MANAGER, reviewStatusName: REVIEW, log });

    expect(listed).toEqual(["OPS-7"]); // yorumlar kontrol edildi (listComments)
    expect(added).toHaveLength(0); // ama yenisi yazılmadı
    expect(report.skippedExisting).toEqual(["OPS-7"]);
    // Günlük satırı yine düşer — görünürlük yorumdan bağımsızdır.
    expect(lines.some((l) => l.level === "warn" && l.text.includes("OPS-7"))).toBe(true);
  });

  it("arama hatası dışarı taşmaz: warn günlüğü düşer, boot sürer", async () => {
    const { work, added } = fakeWork({ searchError: new Error("jira 503") });
    const { log, lines } = collectLog();

    // Reddetmemesi sözleşmenin kendisi — await patlarsa test patlar.
    const report = await detectOrphans({ work, managerAccountId: MANAGER, reviewStatusName: REVIEW, log });

    expect(report.found).toEqual([]);
    expect(added).toHaveLength(0);
    expect(lines.some((l) => l.level === "warn" && l.text.includes("yetim iş taraması başarısız"))).toBe(true);
  });

  it("yorum hatası da yutulur: günlük görünürlüğü kalır, kalan yetimler işlenir", async () => {
    const { work } = fakeWork({
      issues: [issue("OPS-7"), issue("OPS-9")],
      commentError: new Error("comment 403"),
    });
    const { log, lines } = collectLog();

    const report = await detectOrphans({ work, managerAccountId: MANAGER, reviewStatusName: REVIEW, log });

    expect(report.found).toEqual(["OPS-7", "OPS-9"]); // ikisi de görüldü
    expect(report.commented).toEqual([]); // yorum yazılamadı
    expect(lines.filter((l) => l.text.includes("yetim iş yorumu yazılamadı")).length).toBe(2);
    expect(lines.filter((l) => l.text.includes("kapıda bekliyordu")).length).toBe(2);
  });

  it("yönetici accountId boşken taramayı atlar (onay devri reassign yapmaz — yetim oluşmaz)", async () => {
    const { work, searches } = fakeWork({ issues: [issue("OPS-7")] });
    const { log, lines } = collectLog();

    const report = await detectOrphans({ work, managerAccountId: "  ", reviewStatusName: REVIEW, log });

    expect(searches).toHaveLength(0); // arama hiç çıkmadı
    expect(report.found).toEqual([]);
    expect(lines.some((l) => l.text.includes("yetim iş taraması atlandı"))).toBe(true);
  });
});

describe("commentCarriesMarker", () => {
  it("işareti ADF gövdesinin derinliğinde de bulur; işaretsiz yorumda false", () => {
    const marked = {
      body: { content: [{ content: [{ type: "text", text: `not: ${ORPHAN_MARKER} — devam` }] }] },
    };
    expect(commentCarriesMarker(marked)).toBe(true);
    expect(commentCarriesMarker({ body: "sıradan yorum" })).toBe(false);
    expect(commentCarriesMarker(undefined)).toBe(false);
  });
});
