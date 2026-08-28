import type { JournalEntry, JournalKind, JournalActor } from "@maestro/contracts";
import { STEP_IDS } from "@maestro/contracts";
import { demoRunId } from "../fakes/run-gateway.js";
import type { DemoRun } from "./runs.js";
import { stampBefore } from "./runs.js";

/**
 * The ticket journal (M30), generated from each run's own progress rather than
 * written out per ticket.
 *
 * Generated on purpose: a hand-written journal for eighteen runs would drift
 * from the runs themselves the first time a step changed, and a journal
 * describing an analysis for a run still sitting at intake is exactly the
 * incoherence `seed.test.ts` checks for. Here the entries stop at the step the
 * run has actually reached, so the history and the state agree by construction.
 *
 * Every entry keys off `demoRunId(ticketKey)` — the same id the run state and
 * the evidence package use — so `/studio/runs/:ticket/journal` (which resolves
 * the run id from the live execution) finds the right history.
 */

/** What each step writes into the journal when it completes. */
interface StepNote {
  readonly actor: JournalActor;
  readonly kind: JournalKind;
  readonly title: string;
  readonly detail: string;
}

const STEP_NOTES: Readonly<Partial<Record<(typeof STEP_IDS)[number], StepNote>>> = {
  "0": {
    actor: "system",
    kind: "intake",
    title: "Çalışma modu belirlendi",
    detail: "Jira etiketi ve proje bağlaması okundu; iş akışı bu modda başlatıldı.",
  },
  "2": {
    actor: "ai",
    kind: "intake",
    title: "Talep bütünlüğü kontrolü",
    detail: "Ticket açıklaması kabul kriterleri açısından incelendi.",
  },
  "2b": {
    actor: "ai",
    kind: "clarification",
    title: "Belirsizlik soruldu",
    detail: "Eksik kabul kriteri için ticket'a soru yorumu bırakıldı; yanıt bekleniyor.",
  },
  "3o": {
    actor: "ai",
    kind: "discovery",
    title: "Repo keşfi (salt okunur)",
    detail: "İlgili modüller ve mevcut testler çıkarıldı; hiçbir dosya değiştirilmedi.",
  },
  "3": {
    actor: "ai",
    kind: "analysis",
    title: "Değişiklik analizi üretildi",
    detail: "Şablon doğrulandı, etki matrisi ve risk seviyesi çıkarıldı.",
  },
  "4": {
    actor: "system",
    kind: "gate",
    title: "PO analiz kapısı açıldı",
    detail: "Analiz onayı için Product Owner grubuna bildirim gitti.",
  },
  "5": {
    actor: "system",
    kind: "gate",
    title: "Tech Lead analiz kapısı açıldı",
    detail: "Görevler ayrılığı gereği PO'dan farklı bir onaycı bekleniyor.",
  },
  "6a": {
    actor: "ai",
    kind: "engineering",
    title: "Mühendislik oturumu",
    detail: "Sandbox'ta ajan oturumu açıldı; değişiklik dalı üzerinde çalışıldı.",
  },
  "6b": {
    actor: "system",
    kind: "scan",
    title: "Güvenlik taramaları koştu",
    detail: "gitleaks, semgrep ve trivy digest-pinli imajlarla çalıştırıldı (M27).",
  },
  "6c": {
    actor: "ai",
    kind: "review",
    title: "Geliştirici gözden geçirmesi",
    detail: "Gerçek diff üzerinden inceleme yapıldı.",
  },
  "7": {
    actor: "ai",
    kind: "test_design",
    title: "Test senaryoları tasarlandı",
    detail: "Kabul kriterlerinden senaryo seti çıkarıldı.",
  },
  "8": {
    actor: "ai",
    kind: "test_review",
    title: "Test gözden geçirmesi",
    detail: "Kapsam ve senaryo yeterliliği ikinci bir rolce denetlendi.",
  },
  "9": {
    actor: "system",
    kind: "gate",
    title: "QA senaryo kapısı açıldı",
    detail: "Senaryo onayı için QA grubuna bildirim gitti.",
  },
  "10": {
    actor: "ai",
    kind: "test_run",
    title: "Testler koşturuldu",
    detail: "Test paketi sandbox içinde çalıştırıldı ve sonuçlar toplandı.",
  },
  "10b": {
    actor: "system",
    kind: "ci",
    title: "CI kapısı",
    detail: "ADO derleme doğrulama sonucu bekleniyor (M13).",
  },
  "11": {
    actor: "system",
    kind: "gate",
    title: "QA sonuç kapısı açıldı",
    detail: "Test sonuçlarının onayı için QA grubuna bildirim gitti.",
  },
  "12": {
    actor: "system",
    kind: "gate",
    title: "PR onay kapısı açıldı",
    detail: "Pull request Tech Lead onayı bekliyor; ADO en az bir insan gözden geçirici istiyor.",
  },
  "13": {
    actor: "system",
    kind: "closure",
    title: "Kanıt paketi üretildi ve iş kapandı",
    detail: "Analiz, diff, test raporu ve onay zinciri paketlendi (M56).",
  },
};

/** The models the seeded costs are attributed to, alternating by step index. */
const MODELS = ["claude-sonnet-4-6", "claude-opus-4-1"] as const;

/**
 * The journal for one run: one entry per step it has reached, in order, with
 * the last entry describing where it is now.
 *
 * Costs are attached only to `ai` entries, because only an AI turn spends
 * tokens — a system entry carrying a token count would be inventing consumption
 * that no gateway call produced. The per-run totals are split across those
 * entries so the journal's arithmetic agrees with the catalog's `costUsd`.
 */
export function journalFor(run: DemoRun, now: Date): readonly JournalEntry[] {
  const runId = demoRunId(run.ticketKey);
  const reached = stepsUpTo(run.step);
  const aiSteps = reached.filter((step) => STEP_NOTES[step]?.actor === "ai");
  const span = Math.max(run.startedHoursAgo - run.updatedHoursAgo, 1);

  const entries: JournalEntry[] = [];
  for (const [index, step] of reached.entries()) {
    const note = STEP_NOTES[step];
    // Not every canonical step writes a journal entry — `12b` is a loop back
    // into engineering, not an event. Those steps are skipped, which is why
    // `seq` counts ENTRIES rather than reusing the step index: a journal
    // numbered 1,2,4 would look like a record had been deleted, and the
    // journal is append-only evidence (M30).
    if (note === undefined) continue;

    // Spread the entries evenly between the run's start and its last update, so
    // the timeline reads as work done over time rather than all at once.
    const hoursAgo = run.startedHoursAgo - (span * index) / Math.max(reached.length - 1, 1);
    const entry: JournalEntry = {
      runId,
      seq: entries.length + 1,
      at: stampBefore(now, hoursAgo),
      actor: note.actor,
      kind: note.kind,
      title: `${step} · ${note.title}`,
      detail: note.detail,
      ...(note.actor === "ai" && aiSteps.length > 0
        ? {
            cost: {
              usd: round2(run.costUsd / aiSteps.length),
              tokensIn: Math.round(run.tokensIn / aiSteps.length),
              tokensOut: Math.round(run.tokensOut / aiSteps.length),
              model: MODELS[index % MODELS.length] ?? MODELS[0],
            },
          }
        : {}),
    };
    entries.push(entry);
  }
  return entries;
}

/**
 * The living summary (M30) — one paragraph derived from the run's own facts.
 * Derived rather than authored so it cannot describe a run that does not exist.
 */
export function summaryFor(run: DemoRun): string {
  const where =
    run.status === "gate"
      ? `${run.step} numaralı kapıda insan kararı bekliyor`
      : run.status === "done"
        ? "kapandı"
        : run.status === "fail"
          ? `${run.step} numaralı adımda hata aldı`
          : run.status === "queued"
            ? "abonelik kotası nedeniyle kuyrukta"
            : run.status === "handover"
              ? "insana devredildi; Maestro yalnız izliyor ve kanıt topluyor"
              : `${run.step} numaralı adımda çalışıyor`;
  const pr = run.prId === null ? "" : ` · PR #${run.prId}`;
  return (
    `${run.ticketKey} — ${run.title}. Risk ${run.risk}, mod ${run.mode}${pr}. ` +
    `Şu an ${where}. Bugüne kadarki tüketim ${run.costUsd.toFixed(2)} USD ` +
    `(${run.tokensIn.toLocaleString("tr-TR")} giriş / ${run.tokensOut.toLocaleString("tr-TR")} çıkış token).`
  );
}

/** Every canonical step up to and including the one the run sits on. */
function stepsUpTo(step: DemoRun["step"]): readonly (typeof STEP_IDS)[number][] {
  const end = STEP_IDS.indexOf(step);
  return end < 0 ? [] : STEP_IDS.slice(0, end + 1);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
