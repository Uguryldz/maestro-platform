/**
 * The agent variants a fresh install starts with (M38).
 *
 * A clean database has NO variant rows, so `GET /variants` renders an empty
 * catalogue and the pilot has no DB record to resolve its analyst/engineer
 * model from — it would fall back to env forever. Seeding one variant per
 * thinking role gives a fresh install working agents an admin can then edit
 * from the UI (a new version with a different model or persona), which is the
 * whole point of the variant designer.
 *
 * The MODEL is a bootstrap default only: `seedDefaultVariants` reads the
 * bootstrap `PILOT_MODEL` env and plants it as version 1's model, and from then
 * on the DB is authoritative — the admin re-versions it from Studio and env is
 * never read again at flow time. The persona is a short, honest default; the
 * real per-role prompt still lives in `packages/agent-roles` and is merged at
 * run time (M38), so this is a starting overlay, not the whole prompt.
 */

/** A default variant's identity and starting version-1 fields. */
export interface DefaultVariant {
  /** Lower-case dash-separated id, the `VarChar(64)` the table stores. */
  readonly variantId: string;
  /** The thinking role this variant configures (`LlmRoleE`). */
  readonly role: "analyst" | "engineer";
  /** The platform overlay (`Variant.name`). `default` = the institution-wide one. */
  readonly platform: string;
  /** A short starting persona overlay; the full prompt lives in agent-roles. */
  readonly persona: string;
}

/**
 * The bootstrap model, read from `PILOT_MODEL` with a sane default.
 *
 * `anthropic/claude-sonnet-4.5` rather than the pilot prop's cheap
 * `openai/gpt-4o-mini`: a fresh BANK install should start on a capable default
 * an admin can downgrade, not the throwaway the local pilot demo uses. Passed
 * in as an arg (not read here) so the seed stays a pure function the offline
 * test drives deterministically.
 */
export const DEFAULT_VARIANT_MODEL = "anthropic/claude-sonnet-4.5";

/** The two thinking roles a fresh install ships a variant for. */
export const DEFAULT_VARIANTS: readonly DefaultVariant[] = [
  {
    variantId: "analyst-default",
    // Studio'da "Ajan tanımları" listesinde görünen ad — jr-admin ne olduğunu
    // adından anlasın: "default" değil, işini söyleyen bir etiket.
    platform: "Analiz ajanı (varsayılan)",
    role: "analyst",
    persona:
      "# Rolün\n" +
      "Sen kurumun ANALİZ ajanısın. Bir Jira talebini alır, kurumun analiz " +
      "şablonunu ve bilgi tabanındaki uyum kurallarını kullanarak, geliştiricinin " +
      "hiç soru sormadan işe başlayabileceği eksiksiz bir analiz belgesi " +
      "hazırlarsın.\n\n" +
      "# Nasıl çalışırsın\n" +
      "1. Talebi ve varsa ekleri, kabul kriterlerini oku.\n" +
      "2. Kurum analiz şablonundaki her bölümü doldur; boş bırakma.\n" +
      "3. Bilgi tabanındaki (uyum, güvenlik, PII) kuralları belgeye yansıt.\n" +
      "4. Etkilenen sistemleri, riskleri ve test edilecek noktaları açıkça yaz.\n\n" +
      "# Kırmızı çizgiler\n" +
      "- Emin olmadığın hiçbir şeyi UYDURMA. Eksik bilgi varsa bölümü " +
      "'NETLEŞTİRME GEREKLİ' diye işaretle ve tam olarak neyin sorulması " +
      "gerektiğini yaz.\n" +
      "- Gizli/PII veriyi belgeye açık yazma; maskele.\n" +
      "- Kısa ve doğrulanabilir yaz; süslü anlatımdan kaçın.",
  },
  {
    variantId: "engineer-default",
    platform: "Geliştirme ajanı (varsayılan)",
    role: "engineer",
    persona:
      "# Rolün\n" +
      "Sen kurumun GELİŞTİRME (mühendislik) ajanısın. ONAYLANMIŞ bir analizi " +
      "alır, onu repo politikasına saygılı, küçük ve gözden geçirilebilir bir kod " +
      "değişikliğine çevirir, testleri koşar ve bir PR açarsın.\n\n" +
      "# Nasıl çalışırsın\n" +
      "1. Yalnızca onaylı analizin kapsamındaki işi yap; kapsam dışına çıkma.\n" +
      "2. Değişikliği mümkün olan en küçük, anlaşılır parçalara böl.\n" +
      "3. Reponun kendi lint/build/test komutlarını çalıştır.\n" +
      "4. Ne yaptığını ve neden yaptığını PR açıklamasına net yaz.\n\n" +
      "# Kırmızı çizgiler\n" +
      "- Korumalı yollara (deny-list, .maestro.yaml) DOKUNMA.\n" +
      "- Testi GEÇMEYEN bir değişikliği asla teslim etme; geçmiyorsa dur ve " +
      "sebebini bildir.\n" +
      "- Analizde olmayan bir işi kendiliğinden ekleme; gerekiyorsa " +
      "'analiz güncellensin' diye geri bildir.",
  },
];
