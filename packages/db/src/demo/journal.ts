import type { Prisma } from "@prisma/client";
import type { JournalActor, JournalKind } from "@maestro/contracts";
import { ago, demoRunId, ist } from "./clock.js";
import { decisionsOfRun, signatureSeqOf } from "./decisions.js";
import { DEMO_TICKETS, type DemoTicket } from "./tickets.js";

/** Ticket journal (M30) — append-only, and here also strictly time-ordered. */

export interface DemoJournalEntry {
  at: Date;
  actor: JournalActor;
  kind: JournalKind;
  title: string;
  detail: string;
  cost?: { usd: number; model: string };
}

/**
 * The mock's full journal for UGURPAY-501 — the ticket the detail screen opens.
 *
 * The three approval lines quote `signatureSeqOf(...)` rather than a literal
 * `#81390`: the signature is whatever number the audit chain actually issued,
 * so the journal text and the audit table can no longer disagree.
 */
function ugurpay501Journal(): DemoJournalEntry[] {
  const sig = (step: string): string => `imza #${signatureSeqOf("UGURPAY-501", step)}`;
  return [
    { at: ist("2026-07-31T09:02:00"), actor: "system", kind: "intake", title: "Ticket alındı", detail: "UGURPAY-501 webhook ile geldi · imza doğrulandı · work mode: full_auto (label: mode:full-auto)" },
    { at: ist("2026-07-31T09:03:00"), actor: "ai", kind: "intake", title: "Intake — eksik bilgi", detail: "Kabul kriteri ve limit üst sınırı belirtilmemiş. Reporter'a 2 soru soruldu.", cost: { usd: 0.01, model: "claude-haiku-4-5" } },
    { at: ist("2026-07-31T11:40:00"), actor: "human", kind: "clarification", title: "Reporter yanıtı (Can Ö.)", detail: "Üst sınır risk ekibince belirlenen değerden okunacak; kriterler ticket'a eklendi." },
    { at: ist("2026-07-31T11:41:00"), actor: "ai", kind: "intake", title: "Intake — tamam", detail: "Ticket tam. Analiz adımına geçiliyor.", cost: { usd: 0.01, model: "claude-haiku-4-5" } },
    { at: ist("2026-07-31T11:44:00"), actor: "ai", kind: "discovery", title: "Repo keşfi", detail: "Agent SDK salt-okunur oturum · 214 dosya tarandı · etkilenen 3 modül tespit edildi.", cost: { usd: 0.34, model: "claude-opus-5" } },
    { at: ist("2026-07-31T11:58:00"), actor: "ai", kind: "analysis", title: "Analiz üretildi", detail: "Şablon v3 · 7/7 bölüm dolu · doğrulama geçti · etki matrisi: 4 platform.", cost: { usd: 1.12, model: "claude-opus-5" } },
    { at: ist("2026-07-31T12:02:00"), actor: "system", kind: "analysis", title: "Alt ticket'lar açıldı", detail: "Etki matrisinden: UGURPAY-501/502/503/504 · bağımlılık: 501 → diğerleri" },
    { at: ist("2026-07-31T14:20:00"), actor: "human", kind: "gate", title: "PO onayı — Ayşe K.", detail: `/approve · grup: product-owners ✓ · ${sig("4")}` },
    { at: ist("2026-08-01T09:15:00"), actor: "human", kind: "gate", title: "Tech Lead onayı — Mert D.", detail: `/approve · SoD ✓ (PO ≠ TL) · not: 'limit sabit kodlanmasın' · ${sig("5")}` },
    { at: ist("2026-08-01T09:16:00"), actor: "ai", kind: "engineering", title: "Engineer oturumu #1 başladı", detail: "lnx-01 · workspace oluşturuldu · klon + install 2dk 51sn" },
    { at: ist("2026-08-01T09:41:00"), actor: "ai", kind: "engineering", title: "Kod yazıldı", detail: "7 dosya · +388/−74 · lint ✓ build ✓ 24 test ✓ coverage %79", cost: { usd: 2.41, model: "claude-opus-5" } },
    { at: ist("2026-08-01T09:44:00"), actor: "system", kind: "scan", title: "Güvenlik taraması", detail: "gitleaks 0 · semgrep 0 · trivy 0 · imajlar dijest-pinli" },
    { at: ist("2026-08-01T09:52:00"), actor: "ai", kind: "review", title: "Dev-reviewer: CHANGES", detail: "2 bulgu: (1) limit üst sınırı sabit kodlanmış (2) hata mesajı yerelleştirilmemiş", cost: { usd: 0.62, model: "claude-opus-5" } },
    { at: ist("2026-08-01T09:53:00"), actor: "ai", kind: "engineering", title: "Engineer oturumu #2 (resume)", detail: "Aynı oturum sürdü · 2 bulgu düzeltildi · +26/−13", cost: { usd: 0.71, model: "claude-opus-5" } },
    { at: ist("2026-08-01T10:07:00"), actor: "ai", kind: "review", title: "Dev-reviewer: APPROVE", detail: "Bulgular giderildi.", cost: { usd: 0.48, model: "claude-opus-5" } },
    { at: ist("2026-08-01T10:20:00"), actor: "ai", kind: "test_design", title: "Test senaryoları", detail: "9 senaryo (5 pozitif · 3 negatif · 1 sınır) · Gherkin", cost: { usd: 0.55, model: "claude-sonnet-5" } },
    { at: ist("2026-08-01T10:31:00"), actor: "ai", kind: "test_review", title: "Test-reviewer: APPROVE", detail: "Piramit uygun · eksik: eşzamanlı istek senaryosu eklendi.", cost: { usd: 0.22, model: "claude-sonnet-5" } },
    { at: ist("2026-08-01T13:05:00"), actor: "human", kind: "gate", title: "QA senaryo onayı — Deniz Y.", detail: `/approve · grup: qa ✓ · ${sig("9")}` },
    { at: ist("2026-08-01T13:06:00"), actor: "ai", kind: "test_run", title: "Test-engineer oturumu", detail: "Senaryolar koda çevrildi · 27 birim + 6 entegrasyon GERÇEKTEN koştu · coverage %84 · flaky 0", cost: { usd: 0.94, model: "claude-opus-5" } },
    { at: ist("2026-08-01T13:29:00"), actor: "system", kind: "pr", title: "PR açıldı", detail: "ADO PR #1841 (draft → active) · branch feature/UGURPAY-501" },
    { at: ist("2026-08-01T13:52:00"), actor: "system", kind: "ci", title: "CI gate", detail: "ADO build validation #4821 ✓ (4dk 12sn)" },
    { at: ist("2026-08-01T14:02:00"), actor: "human", kind: "gate", title: "QA sonuç onayı — Deniz Y.", detail: `Studio · grup: qa ✓ · ${sig("11")}` },
    { at: ist("2026-08-04T16:11:00"), actor: "human", kind: "pr", title: "PR yorumu — Ayşe K.", detail: `Thread: 'limit üst sınırı konfigden okunmalı, env değil' → changes requested · ${sig("12")}` },
    { at: ist("2026-08-06T14:02:00"), actor: "ai", kind: "engineering", title: "Engineer oturumu #4 (resume)", detail: "2 gün sonra aynı oturum · workspace cache'ten · klon/install atlandı · düzeltildi, thread yanıtlandı", cost: { usd: 0.79, model: "claude-opus-5" } },
  ];
}

/** Short, honest journal for the remaining runs: how it started, where it is. */
function shortJournal(ticket: DemoTicket): DemoJournalEntry[] {
  const entries: DemoJournalEntry[] = [
    {
      at: ago(ticket.ageHours),
      actor: "system",
      kind: "intake",
      title: "Ticket alındı",
      detail: `${ticket.key} webhook ile geldi · imza doğrulandı · work mode: ${ticket.mode}`,
    },
    {
      at: ago(ticket.ageHours - 0.5),
      actor: "ai",
      kind: "intake",
      title: "Intake — tamam",
      detail: "Ticket tam. Akış başlatıldı.",
      cost: { usd: 0.01, model: "claude-haiku-4-5" },
    },
  ];

  // A closed run's approvals are journal entries too, otherwise the evidence
  // package would cite decisions the ticket's own history never mentions.
  for (const decision of decisionsOfRun(ticket.key)) {
    entries.push({
      at: new Date(decision.at),
      actor: "human",
      kind: "gate",
      title: `Kapı ${decision.step} — ${decision.decision === "approve" ? "onaylandı" : "reddedildi"}`,
      detail: `${decision.source === "jira" ? "/approve" : "Studio"} · grup: ${decision.actorGroup} ✓ · imza #${decision.signatureSeq}`,
    });
  }

  if (ticket.status === "queued") {
    entries.push({
      at: ago(ticket.idleHours),
      actor: "system",
      kind: "quota",
      title: "Abonelik kotası bekleniyor",
      detail: "Havuzdaki tüm hesaplar dolu · pencere açılınca kaldığı yerden devam edecek (M55).",
    });
  } else if (ticket.status === "fail") {
    entries.push({
      at: ago(ticket.idleHours),
      actor: "system",
      kind: "ci",
      title: "CI kırmızı",
      detail: "ADO build validation başarısız · ajan aynı oturumda düzeltiyor.",
    });
  } else if (ticket.status === "done") {
    entries.push({
      at: ago(ticket.idleHours),
      actor: "system",
      kind: "closure",
      title: "Kanıt paketi hazırlandı",
      detail: "Analiz + diff + test raporu + onay zinciri arşivlendi (M56).",
    });
  } else if (ticket.status === "gate") {
    entries.push({
      at: ago(ticket.idleHours),
      actor: "system",
      kind: "gate",
      title: `Kapı açıldı — adım ${ticket.step}`,
      detail: "Onay bekleniyor · hatırlatıcı merdiveni işletiliyor (M88).",
    });
  } else {
    entries.push({
      at: ago(ticket.idleHours),
      actor: "ai",
      kind: "engineering",
      title: `Adım ${ticket.step} çalışıyor`,
      detail: "Ajan oturumu sürüyor.",
    });
  }

  return entries;
}

export class JournalWindowError extends Error {
  constructor(ticketKey: string, detail: string) {
    super(`journal of ${ticketKey}: ${detail}`);
    this.name = "JournalWindowError";
  }
}

/**
 * `seq` follows time, and time is checked against the run's own window: an
 * entry before `startedAt` or after `updatedAt` describes something that
 * happened outside the run it belongs to.
 */
export const JOURNAL: Prisma.JournalEntryCreateManyInput[] = DEMO_TICKETS.flatMap((ticket) => {
  const startedAt = ago(ticket.ageHours).getTime();
  const updatedAt = ago(ticket.idleHours).getTime();
  const entries = (ticket.key === "UGURPAY-501" ? ugurpay501Journal() : shortJournal(ticket)).sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );

  return entries.map((entry, index) => {
    const at = entry.at.getTime();
    if (at < startedAt || at > updatedAt) {
      throw new JournalWindowError(
        ticket.key,
        `entry ${index} at ${entry.at.toISOString()} falls outside [startedAt, updatedAt]`,
      );
    }
    return {
      runId: demoRunId(ticket.key),
      seq: index,
      at: entry.at,
      actor: entry.actor,
      kind: entry.kind,
      title: entry.title,
      detail: entry.detail,
      // Left unset (SQL NULL) when the step cost nothing — e.g. human actions.
      ...(entry.cost === undefined
        ? {}
        : { costJson: { usd: entry.cost.usd, model: entry.cost.model } }),
    };
  });
});
