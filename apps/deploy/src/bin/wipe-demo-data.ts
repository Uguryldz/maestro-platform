/**
 * TEK SEFERLİK "sıfır prod" temizliği.
 *
 * Kullanıcı isteği: "tüm data temizle, ayarlar bağlantılar hariç" + "default
 * kurum ayarı ise kalsın, değilse sil — sıfır prod kurmuşum gibi" + "ajanları
 * doğru düzgün yeniden ekle".
 *
 * KURAL: bir taze kurulumun (migrate.ts) seed ettiği kurum-varsayılanları KALIR;
 * demo/iş çalışmasından üretilmiş her şey SİLİNİR.
 *
 * KORUNANLAR (silinmez):
 *   Connection, ConnectorSecret        → bağlantılar (açık istek)
 *   User, Session                      → giriş yapabilmek için
 *   Param, ParamVersion, KillSwitch    → sistem ayarları
 *   AnalysisTemplateVersion            → installer seed + append-only (denetim zinciri)
 *   AuditLog, JournalEntry             → append-only (zaten boş; DB reddeder)
 *
 * SİLİNENLER:
 *   İş akışı zinciri + çıktılar + AI trafiği + demo bağlamalar/kurallar.
 *   Variant/VariantVersion → SİLİNİR, ardından zenginleştirilmiş varsayılanlarla
 *   YENİDEN seed edilir (seed idempotent; var olanı atlar, o yüzden önce sil).
 *
 * Silme sırası FK'lara göre (ilişkiler onDelete: Restrict → çocuk ÖNCE).
 */
import { createDb, seedDefaultVariants, DEFAULT_VARIANT_MODEL } from "@maestro/db";
import { isEntrypoint } from "./lifecycle.js";

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} tanımlı değil`);
  return value;
}

async function main(): Promise<void> {
  const url = required(process.env["DATABASE_URL"], "DATABASE_URL");
  const db = createDb(url);

  const KEEP = [
    "connection", "connectorSecret", "user", "session",
    "param", "paramVersion", "killSwitch", "analysisTemplateVersion",
  ] as const;

  // Silinecekler, FK-güvenli sırada (çocuk → ebeveyn).
  // NOT: auditLog/journalEntry append-only (DB DELETE reddeder) — zaten boş,
  // listeye ALINMADI. analysisTemplateVersion installer seed → KORUNUR.
  const wipeInOrder = [
    "stepEvent", "journalEntry_SKIP", // journalEntry append-only — atla
    "gate", "strikeCounter",
    "repoCard", "workflowRun",
    "idempotencyKey", "publishState", "llmCall",
    "evidencePackageRow", "docTemplateOutputRow", "docTemplateVersion",
    "jiraProjectBinding", "routingRule", "listeningRule",
    "pendingParamChange", "subscriptionAccount", "knowledgeDoc", "analysisGuidance",
    "application",
    // Ajan tanımları: sil → aşağıda yeniden seed.
    "variantVersion", "variant",
  ].filter((k) => !k.endsWith("_SKIP")) as string[];

  const client = db as unknown as Record<string, {
    count: () => Promise<number>;
    deleteMany: () => Promise<{ count: number }>;
  }>;

  const delegate = (k: string): { count: () => Promise<number>; deleteMany: () => Promise<{ count: number }> } => {
    const d = client[k];
    if (d === undefined) throw new Error(`bilinmeyen tablo delegate'i: ${k}`);
    return d;
  };

  const countAll = async (keys: readonly string[]): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const k of keys) out[k] = await delegate(k).count();
    return out;
  };

  console.log("── SİLİNECEK (önce) ──");
  const before = await countAll(wipeInOrder);
  for (const k of wipeInOrder) if ((before[k] ?? 0) > 0) console.log(`  ${k.padEnd(22)} ${before[k] ?? 0}`);

  console.log("\n── KORUNAN (dokunulmaz) ──");
  const kept = await countAll(KEEP);
  for (const k of KEEP) console.log(`  ${k.padEnd(22)} ${kept[k]}`);

  console.log("\n→ Siliniyor…");
  await db.$transaction(async (tx) => {
    const t = tx as unknown as Record<string, { deleteMany: () => Promise<{ count: number }> }>;
    for (const k of wipeInOrder) {
      const del = t[k];
      if (del === undefined) throw new Error(`bilinmeyen tablo delegate'i: ${k}`);
      const res = await del.deleteMany();
      if (res.count > 0) console.log(`  ✓ ${k}: ${res.count} silindi`);
    }
  });

  // Ajanları zenginleştirilmiş varsayılanlarla YENİDEN kur.
  console.log("\n→ Varsayılan ajanlar yeniden kuruluyor…");
  const model = process.env["PILOT_MODEL"] ?? DEFAULT_VARIANT_MODEL;
  const seed = await seedDefaultVariants(db, { model });
  console.log(`  ✓ seed: [${seed.seeded.join(", ")}]  (atlanan: [${seed.skipped.join(", ")}])  model=${model}`);

  console.log("\n── SONUÇ ──");
  const after = await countAll([...wipeInOrder, ...KEEP]);
  const dirty = wipeInOrder.filter((k) => k !== "variant" && k !== "variantVersion" && (after[k] ?? 0) > 0);
  for (const k of [...wipeInOrder, ...KEEP]) console.log(`  ${k.padEnd(22)} ${after[k] ?? 0}`);

  const keptChanged = KEEP.filter((k) => kept[k] !== after[k]);
  await db.$disconnect();

  if (dirty.length > 0) {
    console.error(`\n✗ Hâlâ dolu: ${dirty.join(", ")}`);
    process.exit(1);
  }
  if (keptChanged.length > 0) {
    console.error(`\n✗ Korunması gereken tablo değişti: ${keptChanged.join(", ")}`);
    process.exit(1);
  }
  console.log("\n✅ Sıfır-prod temizliği tamam. Bağlantılar + ayarlar + kullanıcılar + kurum şablonu korundu; ajanlar tazelendi.");
}

if (isEntrypoint(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
