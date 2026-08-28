# RAPOR — pilot analizi gerçek agent-roles analyst'ine bağlandı (G5)

Uğur'un isteği "analizi hangi AI agent yapacaksa o, knowledge + variant ile"
artık gerçek: pilot'un analiz üretimi, ad-hoc `this.think("analyst", AnalysisDoc,
…)` çağrısı yerine `@maestro/agent-roles`'un gerçek `runAnalyst`'ini kullanıyor —
gerçek bir analiz ŞABLONU (M43/M108/M109), gerçek bir `AnalysisContext` ve gerçek
bir VARYANT ile.

## Ne değişti

- **Yeni modül `apps/pilot/src/analysis.ts`** — pilot'un analiz adımını gerçek
  analyst'e bağlar.
- **`apps/pilot/src/run.ts`** — `stepIntakeAndAnalysis` içindeki elle yazılmış
  `this.think<AnalysisDoc>("analyst", "AnalysisDoc", AnalysisDoc, {…})` çağrısı
  `produceAnalysis({ llm, ticket, variantId: PILOT_VARIANT, dataClass })` ile
  değiştirildi. Aşağı akan her şey (Jira yorumu, Word/PDF, ek dosya, mühendislik
  adımına giren `AnalysisDoc`) aynen çalışıyor. Git/attachment/settings koduna
  DOKUNULMADI.
- **`apps/pilot/package.json`** — `@maestro/agent-roles: workspace:*` bağımlılığı
  eklendi.

## Şablon + bağlam nasıl kuruluyor

- **Şablon**: `pilotAnalysisTemplate()` → agent-roles'un kurumsal varsayılanı
  `DEFAULT_ANALYSIS_TEMPLATE` (`data/analysis-template.tr.json`, `kurumsal-analiz`
  @ `v3`). Bu, M43'ün 7 bölümü (her biri frozen `AnalysisDoc` contract alanına
  bağlı) + M109'un iki bölümü: `Kaynaklar` (source_list) ve `Netleştirilecek açık
  maddeler` (open_items). 7/7 doğrulama artık pilot'ta elle yazılmış bir Zod değil,
  ŞABLONDAN geliyor. Studio'da bir bölüm eklemek pilot'ta kod değişikliği
  gerektirmez.
- **Bağlam**: `buildAnalysisContext(ticket)` canlı Jira ticket'ından (zaten
  `TicketSnapshot`) `AnalysisContext` kurar. Bugün pilotta yalnız ticket var, o
  yüzden analyst yalnız ticket'ı (referans indeksi = ticket key + parent key)
  gösterebiliyor.

## runAnalyst çağrısı ve AnalysisOutput → AnalysisDoc eşlemesi

`produceAnalysis`:

1. `runAnalyst({ llm, template, context, variantId, dataClass })` çağırır.
2. `RoleResult` ok-değilse (queued/degraded/blocked) `AnalysisHaltedError`'a
   çevirir — eski `think` helper'ının ürettiği aynı Türkçe metinle.
3. ok ise: `result.value` MASKELİ `AnalysisOutput`'tur. `toAnalysisDoc(template,
   output)` ile frozen `AnalysisDoc`'a projeksiyon yapar. Şablon bölümleri
   contract alanlarına bağlı olduğundan bu, pilotun zaten tükettiği AYNI
   `AnalysisDoc` şeklini üretir.

### Maskeleme (M20/M82) — display vs masked

`runAnalyst` `LlmPort`'a göre tiplenmiştir; `LlmPort`'un `ok` dalı yalnız MASKELİ
değeri taşır. Gateway bu dalı `unmask` ile genişletir ama `LlmPort` olarak tiplenen
bir çağıran bunu görmez, dolayısıyla `RoleResult` `unmask`'ı düşürür. Pilot ise
insan gözünün okuduğu Jira yorumu ve Word/PDF için GERÇEK değerlere ihtiyaç duyar.
Bunu, frozen port'a dokunmadan çözmek için `captureUnmask` adında ince bir proxy
`LlmPort` her `generateObject` çağrısındaki `unmask`'ı yakalar. `produceAnalysis`
iki `AnalysisDoc` döndürür: `display` (gerçek değerler geri konmuş — yorum + docs)
ve `masked` (maskeli kopya — bir journal/artifact store'un tutabileceği kopya).
Maskeleme yoksa `unmask` kimlik fonksiyonudur, `display === masked`.

Maskeleme SAYACI (`maskedFields`) `boot.ts`'teki `onMasked` kancasıyla, `think`'ten
bağımsız olarak gateway içinde güncellenir — bu yüzden analyst'in gateway'i nasıl
çağırdığından etkilenmez ve akışın PII testi hâlâ yeşil.

## Fail-closed davranışı korundu

Bir şablon-doğrulama ihlali (eksik bölüm, uydurma kaynak, boş/kaçamak gövde) tek
onarım turundan sonra `runAnalyst`'ten `RoleOutputError` olarak fırlar — analiz
kapıya ulaşmadan durur. Eski elle yazılmış Zod'un verdiği garantinin aynısı, artık
gerçek şablon tarafından sürülüyor.

## Wire edilen vs TODO

- **Wire edildi**: ticket (özet/açıklama/reporter/bileşenler/etiketler/parent) →
  `AnalysisContext.ticket`; gerçek şablon; `PILOT_VARIANT`; `runSettings.dataClass`;
  maskeleme round-trip'i (display/masked).
- **TODO (analysis.ts'te net işaretlendi)**: `discovery.files/modules` (adım 3o repo
  keşfi), `knowledge.repoCards` (M100 — impact matrix `repo_card` gösterebilsin),
  `knowledge.knowledgeDocs/codingStandards/exampleAnalyses` (M38 knowledge pack) ve
  `clarifications` (kısaltılmış pilotta netleştirme kapısı yok). Bunlar boş olduğu
  sürece analyst yalnız ticket-kaynaklı iddialar yazabilir — göstermediği bir repo
  dosyasını gösteremeyeceği için dürüst duruş budur.

## Testler (offline, mock LLM — ağ yok)

Yeni `apps/pilot/test/analysis.test.ts` (7 test):

1. Bağlam canlı ticket'tan kurulur; knowledge/repo-kartı/discovery boş (TODO).
2. `runAnalyst` gerçek şablon/varyant/veri sınıfı ile çağrılır (schemaName =
   `AnalysisDoc@kurumsal-analiz@v3`, prompt ticket açıklamasını taşır).
3. Şablon-geçerli çıktı aşağı akan geçerli bir `AnalysisDoc`'a eşlenir.
4. Maskeli çıktının gerçek değerleri `display` kopyasında geri konur; `masked`
   kopya token'ı korur.
5. Eksik bölüm fail-closed reddedilir (`RoleOutputError`, tam 2 deneme).
6. Uydurma kaynak (bağlamda olmayan referans) fail-closed reddedilir.
7. ok-olmayan model durumu (blocked) `AnalysisHaltedError`'a çevrilir.

Mevcut akış testleri (`flow.test.ts`, `flow-github.test.ts`) yeni analyst yoluyla
güncellendi: stub model artık şablon-şeklinde `AnalysisOutput` döndürüyor (her claim
bölümü için ticket'a bağlı bir kaynak satırı). Jira yorumu + Word/PDF ek dosyaları +
PII maskeleme + audit zinciri assert'leri değişmeden yeşil.

**Toplam**: pilot 72 test yeşil (7 yeni), agent-roles 159 test yeşil (dokunulmadı).
`pnpm -F @maestro/pilot typecheck && test`, `pnpm -F @maestro/agent-roles typecheck
&& test` yeşil; repo `pnpm lint` temiz (0 hata; demo-stack'teki 3 uyarı bu işten
önce de vardı, dokunulmadı).
