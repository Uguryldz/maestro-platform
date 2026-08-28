import type { EvalSeed, VariantSeed } from "@maestro/bff";

/**
 * The variant catalogue and the golden-ticket eval, seeded (M38/M43/M78).
 *
 * A reviewer opening the agent screens sees a real catalogue with version
 * history, and an eval run whose LAST golden ticket regressed — so the M78
 * justified-pass gate has something true to gate. The regression is the point:
 * a demo where every candidate improved would never show why the decision
 * exists.
 */

const AT_V1 = "2026-07-01T09:00:00.000Z";
const AT_V2 = "2026-07-20T09:00:00.000Z";

export const DEMO_VARIANTS: readonly VariantSeed[] = [
  {
    variantId: "analyst-web",
    role: "analyst",
    platform: "web",
    versions: [
      {
        version: 1,
        model: "claude-opus-5",
        persona:
          "Sen bir bankacılık analistisin. Ticket'ı analiz şablonuna göre doldurur, " +
          "regülasyon (BDDK) etkisini ayrı bir başlıkta belirtirsin.",
        knowledgeRefs: ["bddk-uyum.md", "analiz-sablonu.md"],
        note: "İlk yayın",
        publishedBy: "ayse.kaya@ugurbank.local",
        publishedAt: AT_V1,
        evalScore: 88,
      },
      {
        version: 2,
        model: "claude-opus-5",
        persona:
          "Sen bir bankacılık analistisin. Ticket'ı analiz şablonuna göre doldurur, " +
          "regülasyon (BDDK) etkisini ve müşteri iletişim gereksinimini ayrı başlıklarda " +
          "belirtirsin.",
        knowledgeRefs: ["bddk-uyum.md", "analiz-sablonu.md", "musteri-iletisim.md"],
        note: "Müşteri iletişim başlığı eklendi",
        publishedBy: "ayse.kaya@ugurbank.local",
        publishedAt: AT_V2,
        evalScore: 91,
      },
    ],
  },
  {
    variantId: "engineer-web",
    role: "engineer",
    platform: "web",
    versions: [
      {
        version: 1,
        model: "claude-opus-5",
        persona:
          "Sen bir yazılım mühendisisin. Analizi koda dönüştürür, korumalı yolları " +
          "değiştirmez, testleri birlikte yazarsın.",
        knowledgeRefs: ["kod-standartlari.md"],
        note: "İlk yayın",
        publishedBy: "mehmet.demir@ugurbank.local",
        publishedAt: AT_V1,
        evalScore: 84,
      },
    ],
  },
  {
    variantId: "intake-default",
    role: "intake",
    platform: "default",
    versions: [
      {
        version: 1,
        model: "claude-haiku-5",
        persona: "Sen giriş ajanısın. Ticket'ı sınıflandırır, eksik bilgiyi sorarsın.",
        knowledgeRefs: [],
        note: "İlk yayın",
        publishedBy: "ayse.kaya@ugurbank.local",
        publishedAt: AT_V1,
        // Never evaluated — null, not zero.
        evalScore: null,
      },
    ],
  },
];

export const DEMO_EVAL: EvalSeed = {
  pool: [
    {
      goldenId: "golden-1",
      sourceTicket: "UGURPAY-88",
      kind: "analiz",
      expectation: "BDDK etkisi başlığı dolu ve doğru",
      lastScore: 92,
    },
    {
      goldenId: "golden-2",
      sourceTicket: "UGURPAY-102",
      kind: "analiz",
      expectation: "Kapsam dışı maddeler ayrı listelenmiş",
      lastScore: 95,
    },
    {
      goldenId: "golden-3",
      sourceTicket: "UGURWEB-51",
      kind: "analiz",
      expectation: "Müşteri iletişim gereksinimi yakalanmış",
      lastScore: 79,
    },
  ],
  runs: [
    {
      runId: "eval-analyst-web-2",
      variantId: "analyst-web",
      baselineVersion: 1,
      candidateVersion: 2,
      at: "2026-07-19T18:00:00.000Z",
      results: [
        { goldenId: "golden-1", baselineScore: 90, candidateScore: 92 },
        { goldenId: "golden-2", baselineScore: 95, candidateScore: 95 },
        // The regression: adding the customer-communication section cost a point
        // on a ticket that never needed it. This is what the M78 gate decides.
        { goldenId: "golden-3", baselineScore: 82, candidateScore: 79 },
      ],
      // Pending: a human has not yet decided whether to ship despite the
      // regression on golden-3. The screen surfaces the decision.
      decision: { status: "pending", justification: "", decidedBy: null, decidedAt: null },
    },
  ],
};
