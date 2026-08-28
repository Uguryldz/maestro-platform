import type { TemplateProjectBinding, TemplateVersionRecord } from "@maestro/bff";

/**
 * The analysis template designer's seed (M108).
 *
 * Two published versions rather than one, because the interesting behaviour is
 * only visible with history: version 1 is what the older runs were pinned to
 * (M83), version 2 is what a new run resolves today. A reviewer opening the
 * designer can therefore see that publishing does not rewrite the past, and the
 * `pinnedRuns` counter has something true to report.
 *
 * The section set is the corporate default trimmed to what the screen shows
 * well; the real seven-section standard lives in
 * `packages/agent-roles/src/data/analysis-template.tr.json`.
 */

const V1_SECTIONS: TemplateVersionRecord["sections"] = [
  {
    key: "amac",
    title: "Amaç",
    description: "Bu değişikliğin neden yapıldığı.",
    aiInstruction: "Ticket'ın çözdüğü iş problemini iki cümleyle yaz; teknik çözümü burada anlatma.",
    required: true,
    format: "free_text",
    example: "Kart limit artırım talepleri bugün manuel işleniyor ve ortalama 2 iş günü sürüyor.",
  },
  {
    key: "kapsam",
    title: "Kapsam",
    description: "Nelerin dahil olduğu.",
    aiInstruction: "Kapsama giren servis, ekran ve entegrasyonları madde madde listele.",
    required: true,
    format: "bullet_list",
    example: "Limit artırım servisi",
  },
  {
    key: "kabul_kriterleri",
    title: "Kabul kriterleri",
    description: "Ne zaman bitmiş sayılır.",
    aiInstruction: "Her kriteri ölçülebilir yaz; 'iyi çalışmalı' gibi ifadeler kullanma.",
    required: true,
    format: "bullet_list",
    example: "Limit artırımı 5 saniyeden kısa sürede sonuçlanır.",
  },
];

/**
 * Version 2 adds the traceability section the reference document leads with
 * (`plan/referans/DOKUMAN-STANDARDI.md`): an AI-written analysis has to say
 * where each claim came from, or an auditor cannot tell a read fact from an
 * invented one.
 */
const V2_SECTIONS: TemplateVersionRecord["sections"] = [
  ...V1_SECTIONS,
  {
    key: "etki_matrisi",
    title: "Etki matrisi",
    description: "Hangi uygulama etkileniyor.",
    aiInstruction: "Her uygulama için etkilenip etkilenmediğini ve gerekçesini yaz.",
    required: true,
    format: "impact_matrix",
    example: "ugurpay — etkileniyor (birincil repo keşfi): limit servisi değişiyor",
  },
  {
    key: "kaynaklar",
    title: "Kaynaklar",
    description: "Hangi iddia neye dayanıyor.",
    aiInstruction: "Her teknik iddiayı bir dosyaya, repo kartına veya ticket cümlesine bağla.",
    required: false,
    format: "table",
    example: "Kabul kriteri 2 — UGURPAY-123 açıklaması, 3. paragraf",
  },
];

export const DEMO_TEMPLATE_VERSIONS: readonly TemplateVersionRecord[] = [
  {
    name: "Analiz şablonu",
    version: 1,
    sections: V1_SECTIONS,
    publishedBy: "ayse.kaya@ugurbank.local",
    publishedAt: "2026-06-14T08:30:00.000Z",
  },
  {
    name: "Analiz şablonu",
    version: 2,
    sections: V2_SECTIONS,
    publishedBy: "mert.demir@ugurbank.local",
    publishedAt: "2026-07-28T13:05:00.000Z",
  },
];

/**
 * UGURPAY resolves to version 2 today but still has one run finishing on the
 * version it started with — the M83 pin, visible in the designer as an amber
 * badge rather than as a footnote.
 */
export const DEMO_TEMPLATE_BINDINGS: readonly TemplateProjectBinding[] = [
  { projectKey: "UGURPAY", version: 2, pinnedRuns: 1 },
  { projectKey: "UGURCRM", version: 2, pinnedRuns: 0 },
];
