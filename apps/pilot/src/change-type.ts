/**
 * B11 — special change types.
 *
 * Not every change is "write a module + its test". A DB migration, a feature
 * flag, a config change or a dependency bump each carry a class of risk the
 * generic engineer prompt does not name — and a bank's release process treats
 * them very differently (a migration needs a reversible/idempotent script; a
 * dependency bump needs a pinned version and a lockfile; a flag ships OFF; a
 * config change needs validation and a documented default). The frozen
 * `AnalysisDoc` cannot grow a field for this, so instead of changing the
 * contract we DETECT these types from the ticket + analysis text and inject the
 * matching guardrails into the engineer's rules and the human-facing notes.
 *
 * Detection is deliberately conservative and keyword-based (TR + EN, banking
 * vernacular): it can only ADD guardrails, never remove a section or block the
 * flow, so a false positive costs one extra rule, not a wrong outcome.
 */

export type ChangeType = "migration" | "feature_flag" | "config" | "dependency";

export interface ChangeTypeMatch {
  type: ChangeType;
  /** Turkish label for the log / Jira comment / PR note. */
  label: string;
  /** Extra engineer rules (kurallar) that apply when this type is present. */
  rules: readonly string[];
  /** One-line reviewer-facing note for the analysis comment + PR description. */
  note: string;
}

interface ChangeTypeSpec extends Omit<ChangeTypeMatch, "type"> {
  type: ChangeType;
  /** Lower-cased substrings that signal this change type. */
  signals: readonly string[];
}

const SPECS: readonly ChangeTypeSpec[] = [
  {
    type: "migration",
    label: "veritabanı göçü (migration)",
    signals: [
      "migration",
      "göç",
      "goc",
      "şema değişik",
      "sema degisik",
      "schema change",
      "alter table",
      "add column",
      "drop column",
      "create table",
      "veri taşı",
      "veri tasi",
      "backfill",
      "ddl",
    ],
    rules: [
      "Bu bir VERİTABANI GÖÇÜ (migration): göç scriptini idempotent yaz (tekrar çalıştırılınca hata vermesin) ve mutlaka bir geri-alma (down/rollback) adımı üret.",
      "Büyük tablolarda kilitlemeyi önle; mümkünse toplu/aşamalı (batched) güncelleme öner ve testte küçük bir örnekle doğrula.",
    ],
    note: "⚠️ Veritabanı göçü içerir — idempotent script + geri-alma planı gerekir; DBA gözden geçirmeli.",
  },
  {
    type: "feature_flag",
    label: "özellik bayrağı (feature flag)",
    signals: [
      "feature flag",
      "feature-flag",
      "özellik bayra",
      "ozellik bayra",
      "toggle",
      "flag ile aç",
      "flag ile ac",
      "kademeli açıl",
      "kademeli acil",
      "canary",
      "rollout",
    ],
    rules: [
      "Bu bir ÖZELLİK BAYRAĞI (feature flag) değişikliği: yeni davranış VARSAYILAN OLARAK KAPALI gelsin; bayrak kapalıyken eski davranış birebir korunsun.",
      "Bayrağın açık ve kapalı iki halini de testle; bayrak okunamazsa güvenli (kapalı) tarafa düş.",
    ],
    note: "🚩 Özellik bayrağı içerir — varsayılan KAPALI; kademeli açılış için açık/kapalı iki yol da test edilmeli.",
  },
  {
    type: "config",
    label: "yapılandırma (config) değişikliği",
    signals: [
      "config",
      "yapılandırma",
      "yapilandirma",
      "ayar dosya",
      "environment variable",
      "ortam değişken",
      "ortam degisken",
      "env var",
      ".env",
      "parametre değer",
      "parametre deger",
    ],
    rules: [
      "Bu bir YAPILANDIRMA (config) değişikliği: yeni ayarların güvenli varsayılanları olsun ve eksik/geçersiz değerde açık bir hata ver (sessizce yanlış davranma).",
      "Değiştirilen her ayarı ve örnek değerini özet bölümünde belgele; sır (secret) değerleri koda gömme.",
    ],
    note: "⚙️ Yapılandırma değişikliği içerir — güvenli varsayılan + değer doğrulaması; sırlar koda gömülmemeli.",
  },
  {
    type: "dependency",
    label: "bağımlılık (dependency) değişikliği",
    signals: [
      "dependency",
      "bağımlılık",
      "bagimlilik",
      "paket sürüm",
      "paket surum",
      "kütüphane sürüm",
      "kutuphane surum",
      "upgrade",
      "yükselt",
      "yukselt",
      "package.json",
      "npm install",
      "pnpm add",
      "version bump",
      "sürüm yükselt",
    ],
    rules: [
      "Bu bir BAĞIMLILIK (dependency) değişikliği: sürümü tam olarak sabitle (aralık değil), lockfile ile birlikte gelsin ve kırıcı değişiklik (breaking change) olup olmadığını özet bölümünde belirt.",
      "Yeni/yükseltilen bağımlılığın gerçekten kullanıldığını gösteren en az bir test ekle.",
    ],
    note: "📦 Bağımlılık değişikliği içerir — sürüm sabit + lockfile; kırıcı değişiklikler gözden geçirilmeli.",
  },
];

/**
 * Detect which special change types a ticket + analysis touch. Scans the ticket
 * text and the analysis's own words (scope, UI/API changes, risk) so a type is
 * caught whether the reporter named it or the analyst surfaced it.
 */
export function classifyChangeTypes(haystacks: readonly string[]): ChangeTypeMatch[] {
  const blob = haystacks.join("\n").toLowerCase();
  const matches: ChangeTypeMatch[] = [];
  for (const spec of SPECS) {
    if (spec.signals.some((s) => blob.includes(s))) {
      matches.push({ type: spec.type, label: spec.label, rules: spec.rules, note: spec.note });
    }
  }
  return matches;
}
