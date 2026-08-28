# @maestro/db — paket raporu (Dalga 1, 2. tur: doğrulayıcı bulgularının kapatılması)

Dokunulan alan: `maestro/packages/db/**` + `maestro/pnpm-lock.yaml` (yalnız bu paketin
bağımlılıkları). `packages/contracts` ve `packages/ports` **okundu, değiştirilmedi**;
`packages/audit` yalnız **kullanıldı** (workspace bağımlılığı olarak eklendi).

Bu rapor gerçek kodun aynasıdır: aşağıdaki her dosya, her sayı ve her komut depodaki
hâliyle doğrulanmıştır.

---

## 1. Ne var — dosya dosya

| Dosya | Satır | İş |
| --- | --- | --- |
| `prisma/schema.prisma` | 463 | 17 model, 15 enum |
| `prisma/migrations/0001_init/migration.sql` | 339 | `prisma migrate diff` çıktısı — **elle yazılmaz** |
| `prisma/migrations/0002_append_only_and_guards/migration.sql` | 72 | **Tek elle yazılan migration**: trigger + CHECK + kısmi unique index (§3) |
| `prisma/migrations/migration_lock.toml` | 3 | sağlayıcı kilidi |
| `src/client.ts` | 60 | `createDb(url)` + fail-closed URL denetimi |
| `src/index.ts` | 106 | paketin tek dışa açık yüzeyi |
| `src/append-only.ts` | 61 | `AuditLog`/`JournalEntry` için daraltılmış yazma yüzeyi |
| `src/mappers.ts` | 275 | satır → sözleşme dönüştürücüleri (BigInt/Decimal/Date geçiş noktası) |
| `src/routing-map.ts` | 45 | `RoutingRule.projectKey`: sözleşmedeki `"*"` ↔ kolondaki `NULL` |
| `src/params-defaults.ts` | 243 | 17 `ParamDefinition` (M71) |
| `src/params-write.ts` | 117 | `writeParamVersion()` — 4-göz kuralının tek yazıcısı |
| `src/seed.ts` | 82 | `seedParams()` — idempotent parametre tohumu |
| `src/seed-demo.ts` | 134 | demo veri setinin birleştirilmesi + tek transaction'lı yazıcı |
| `src/seed-cli.ts` | 36 | `pnpm -F @maestro/db seed` girişi |
| `src/schema-facts.ts` | 110 | şema metni ayrıştırıcıları (sapma testleri için) |
| `src/demo/clock.ts` | 27 | `DEMO_NOW`, `ago`, `ist`, `demoRunId` |
| `src/demo/ticket-data.ts` | 174 | UGURPAY projesinin 10 ticket'ı (veri) |
| `src/demo/ticket-data-other.ts` | 177 | UGURWEB/UGURMOB/UGURDESK + greenfield: 12 ticket (veri) |
| `src/demo/tickets.ts` | 61 | 22 ticket → `WorkflowRun` satırı + **zamansal değişmezler** |
| `src/demo/registry.ts` | 124 | uygulamalar, repo kartları, knowledge, kullanıcılar |
| `src/demo/routing.ts` | 116 | Jira bağlamaları + yönlendirme kuralları |
| `src/demo/gates.ts` | 157 | imzalı kapı kararlarının **niyeti** + SoD doğrulaması |
| `src/demo/audit-ambient.ts` | 93 | başka tablodan türetilemeyen audit kayıtları |
| `src/demo/decisions.ts` | 209 | **tek hikâye**: audit zinciri + imza no + kapı kararları |
| `src/demo/params.ts` | 149 | parametre sürüm geçmişi (v2…v4) |
| `src/demo/journal.ts` | 173 | ticket defteri (M30) |
| `src/demo/step-events.ts` | 46 | adım olayları — `kind = STEP_META[step].kind` |
| `src/demo/evidence.ts` | 63 | kanıt paketleri (M34/M56), şablon sürümü pinli (M83) |
| `src/demo/gateway.ts` | 63 | LLM çağrı logu, varyantlar, abonelik havuzu |

Kural gereği **hiçbir TypeScript kaynak/test dosyası 300 satırı geçmiyor** (en büyüğü
`src/mappers.ts`, 275). Bunun dışında kalan iki dosya TypeScript değil ve bölünmeleri
zarar verirdi:

- `prisma/migrations/0001_init/migration.sql` (339) — **Prisma üretiyor**, elle
  düzenlenmesi yasak, bölünemez;
- `prisma/schema.prisma` (463) — tek şema dosyası; çok dosyalı şema klasörüne geçmek
  `migration:build`'in `--to-schema-datamodel` yolunu, `PRISMA_SCHEMA_RELATIVE_PATH`
  sabitini ve şema metnini okuyan üç sapma testini birden değiştirir. Bu turun konusu
  bulguları kapatmaktı; öneri olarak §8.3'e yazıldı.

Komutlar (`pnpm -F @maestro/db <script>`):

- `postinstall` / `generate` — `prisma generate`. Soğuk klonda `typecheck`'in
  çalışmasını sağlayan şey budur.
- `migration:build` — `0001_init`'i tamamen çevrimdışı yeniden üretir:
  `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`.
  **`0002` bu komutla üretilmez, elle bakılır** (§3).
- `seed` — `tsx src/seed-cli.ts` (parametreler + demo veri seti; `--params-only`
  yalnız parametreleri yazar).
- `typecheck`, `test`.

---

## 2. Bulgu bazında ne yapıldı

### B-1 · Org-wide yönlendirme kuralı saklanamıyordu — KAPANDI
`RoutingRule.projectKey` üzerindeki `JiraProjectBinding` yabancı anahtarı **kaldırıldı**,
kolon **nullable** oldu: `NULL = tüm projeler`. Sözleşmenin `"*"` değeri ile kolonun
`NULL`'ı arasındaki çeviri tek yerde, `src/routing-map.ts`'te yaşıyor
(`toColumnProjectKey` / `toContractProjectKey`), fail-closed: ne `"*"` ne de geçerli
bir `ProjectKey` olan değer saklanmadan reddediliyor.

Maketteki **kural 7** (`label=musteri-verisi` → `human_lead` + `gizli`) org-wide olarak
geri kondu. FK'nın kaldırılmasının ikinci gerekçesi M102'nin `unbind` davranışı:
"geçmiş korunur" diyorsa, bağlama silindiğinde kurallar FK yüzünden ölmemeli.

`test/seed-demo.test.ts:122`'deki dar `ProjectKey` doğrulaması (bulguyu gizleyen
assertion) kaldırıldı; artık her kural **tam `RoutingRule` sözleşmesine** parse
ediliyor, ayrıca org-wide satırın `NULL` saklanıp `"*"` okunduğu ayrı test ediliyor.

### B-2 + B-3 + B-5 · Kapı kararı ↔ audit ↔ kanıt paketi — KAPANDI
Üçü tek diziden türüyor (`src/demo/decisions.ts`):

1. her tablo kendi audit niyetini üretir — 22 `RUN_STARTED`, kapıdaki 7 run için
   `GATE_OPEN`, hatalı run için `CI_RESULT`, her imzalı karar için
   `GATE_APPROVE`/`GATE_REJECT`, kapanan 5 run için `PR_MERGED` + `RUN_CLOSED`,
   her parametre sürümü için `PARAM_CHANGED`, artı türetilemeyen 10 ortam kaydı;
2. dizi zamana göre sıralanır (`Array.prototype.sort` kararlı olduğu için veri seti
   byte-byte tekrarlanabilir kalır) ve tek zincir olarak mühürlenir;
3. bir kararın `signatureSeq`'i **ürettiği audit satırının `seq`'idir**.

Sonuçlar: 76 audit satırı, 18 imzalı karar, 5 kanıt paketi. `EvidencePackage.approvals`
artık boş değil; her kapanmış run'ın onay kümesi tam olarak `GATES_BY_RISK[risk]`.
Defterdeki `imza #…` metinleri de artık `signatureSeqOf(...)`'tan geliyor — maketten
kopyalanan `#81390` gibi sabitler kalmadı, defter ile audit tablosu çelişemez.

Zamansal ters dönme (5 adet) kalmadı: dizi tek sıralamadan geçtiği için mümkün değil,
ayrıca test var.

### B-4 · İkinci hash zinciri implementasyonu — SİLİNDİ
`chainAuditEvents()` ve `auditPayload()` kaldırıldı. Zincir artık `@maestro/audit`'in
`sealEvent` + `GENESIS`'i ile üretiliyor; aktör dilbilgisi `assertActor` ile,
"yalnız insan imzalayabilir" kuralı `actionInfo(...).humanOnly` ile aynı pakete
sorularak uygulanıyor (maketteki `system` aktörü bu yüzden `maestro-worker` oldu:
`system` audit paketinin kabul ettiği bir aktör değil).

Yalnızca **döngü** yerel: `AuditChain` bir store etrafında asenkron, veri seti ise saf
ve senkron bir fikstür olmak zorunda. Bunun bir kopya olmadığını kanıtlamak için
`test/audit-chain.test.ts` zinciri **`@maestro/audit`'in kendi `verifyChain`'i** ile
doğruluyor (satırlar `toAuditEvent` mapper'ından geçirilerek) ve `rehash` ile satır
satır yeniden hash'liyor. Audit paketi meta'yı da hash'lediği için her satırın
`metaJson`'ı zincire giren kanonik meta ile aynı.

`seq` artık 1'den başlıyor. Maketin `#81408–81422` sayacı korunmadı: o sayılar
"uzun süredir çalışan bir kurulum" hissi için uydurulmuştu ve `signatureSeq`'in
gerçek satır numarası olması şartıyla bağdaşmıyordu. Demo zinciri dürüstçe
`genesis`'ten başlayan yeni bir zincirdir.

### B-6 · Zamansal değişmezler — KAPANDI
- `updatedAt >= startedAt`: `assertTicketInvariants()` veri üretilirken atıyor
  (`idleHours <= ageHours`); UGURPAY-504 düzeltildi (386/384 → 388/386).
- Defter kayıtları monoton ve `[startedAt, updatedAt]` aralığında — `journal.ts`
  aralığı ihlal eden satırda `JournalWindowError` atıyor, `seq` zamandan türüyor.
- `StepEvent` run başlangıcından önce olamaz (test).
- LLM çağrıları da run penceresinin içinde (yeni değişmez; eskiden UGURPAY-504'ün
  analiz çağrısı run kapandıktan 16 gün sonraydı).

Maketin kendi çelişkileri bu sırada karara bağlandı ve koda yorum olarak yazıldı:
UGURPAY-501'in yaşı 144s→198s (defteri 31 Tem'de başlıyordu), UGURPAY-500 çocuklarından
sonra başlıyordu (390s oldu), UGURPAY-123'ün kapısı "1s 10dk" diyordu ama maketin audit
satırı 8 dakika önce açıldığını söylüyordu (audit'e uyuldu).

### B-7 · `StepEvent.kind` — KAPANDI
`kind` artık **`STEP_META[step].kind`**; run durumundan türetilmiyor. Maketin üç yanlışı
düzeldi: `2b` → `human_wait` (onay kapısı değil, insan beklemesi), `6b` → `system`,
`10b` → `auto_gate`. Test hem tüm olayları sözleşmeyle karşılaştırıyor hem de bu üç
adımı ayrıca çiviliyor. Kolon ayrıca Postgres enum'una terfi etti (`StepKindE`).

### B-8 · BigInt/Decimal geçiş noktası — BELGELENDİ
BigInt kaldı; dönüşüm `src/mappers.ts`'te tek yerde:

| Mapper | Ne dönüştürüyor |
| --- | --- |
| `toAuditEvent` | `seq: bigint → number`, `at: Date → ISO`, `metaJson → meta` (NULL → `{}`) |
| `toLlmCallLog` | `usd: Decimal → number` (`.toNumber()`), `at → ISO` |
| `toJournalEntry` | `costJson` NULL ise alan hiç konmaz |
| `toWorkflowRunState` / `toParamChange` | `Date → ISO`, `scopeRef: "" → null` |
| `toRoutingRule` / `toJiraProjectBinding` | `NULL → "*"`, `ruleIds` sırası (B-22) |
| `toApplicationRecord` / `toEvidencePackage` | manifest ve kayıt biçimi |

`bigIntToNumber` **taşmayı yuvarlamaz, atar** (`BigIntRangeError`): bir audit sırasında
sessiz hassasiyet kaybı, bu platformun önlemek için var olduğu türden bir bozulmadır.

### B-9 · Guarded parametrelerde 4-göz — KAPANDI
- `ParamVersion.guarded` denormalize kolonu eklendi (CHECK içinde alt sorgu olamaz).
- `0002` migration'ında `CHECK (NOT "guarded" OR "approvedBy" IS NOT NULL)`.
- `writeParamVersion()` tek yazıcı: tanım yoksa reddeder (M14), `guarded`'ı **tanımdan**
  okur (çağıran veremez), guarded'da onaylayan zorunlu **ve** değiştirenden farklı olmalı.
- `seedParams` guarded varsayılanları `approvedBy: SEED_ACTOR` ile yazıyor
  (`bootstrapParamVersionData`): kurulum anında ikinci bir insan yoktur, satır kurulumu
  hem yazar hem onaylayan olarak dürüstçe kaydeder. Sonraki her değişiklik
  `writeParamVersion`'dan geçer ve kendi kendini onaylayamaz.

Testler: guarded + `approvedBy` NULL reddedilir (hem birim testinde hem canlı veritabanında).

### B-10 · Eksik parametreler — KAPANDI
5 parametre eklendi, toplam **17**: `stuck.threshold` (M54), `quota.warn_pct` (M19),
`scan.block_level` (M27), `build.timeout_min` (M85), `trigger.mode` (M48a/M102).
`test/seed.test.ts`'teki totolojik `length === 12` yerine iki kaynaktan türeyen kontrol
geldi: (a) maketin `PARAMS` ekranındaki 12 anahtarın hepsi tohumda olmalı, (b) tohumdaki
her anahtar ya makette olmalı ya da bir M-kararına bağlı olmalı, (c) küme tam olarak
bu ikisinin birleşimi olmalı. Ayrıca guarded kümesi artık maketin "4-göz" rozetinden
türetiliyor.

### B-11 · Parametre sürüm geçmişi — KAPANDI
`src/demo/params.ts` 8 sürüm satırı yazıyor: `gates.risk_tiers` v2/v3/v4,
`escalation.ladder` v2/v3, `coverage.ratchet` v2, `trigger.mode` (UGURPAY kapsamı) v1/v2.
v1 satırları her zaman kurulumun varsayılanıdır (`seedParams`); demo geçmişi onun
üstüne binen operatör kararlarıdır. `gates.risk_tiers` v4 bilerek `GATES_BY_RISK`'e geri
döner — çünkü kapanmış run'ların onay kümeleri o değerle tutarlı olmak zorunda.
Her satır bir `PARAM_CHANGED` audit kaydı üretir, dolayısıyla "audit v4 diyor, tabloda
yalnız v1 var" durumu yapısal olarak imkânsız hâle geldi.

### B-12 · `WorkflowRun.ticketKey @unique` — KAPANDI
`@unique` kaldırıldı, yerine index + `0002`'de **kısmi unique index**:
`WHERE "status" NOT IN ('done','cancelled')`. Yani bir ticket yeniden başlatılabilir
(kill-switch, devir, ikinci `/ai-start`) ama aynı anda iki canlı run olamaz.
`EvidencePackageRow.ticketKey` de `@unique` yerine index oldu: yeniden koşan bir
ticket'ın ikinci paketini reddetmek kanıt kaybıdır (M34/M56).

### B-13 · `KnowledgeDoc` sürümlenemiyordu — KAPANDI
`@@id([id, version])` (RepoCard kalıbı). Demo `analiz-sablonu` v2+v3 ve `api-tasarim`
v4+v5 satırlarını yazıyor. Kanıt paketinin `templateVersion`'ı artık **run'ın
`startedAt`'inde geçerli olan** sürümden hesaplanıyor: UGURPAY-478 → `v3`,
UGURMOB-166 → `v2`. M83'ün "akış başladığı şablon sürümüyle biter" kuralı böylece
veriyle kanıtlanıyor.

### B-14 · Append-only DB düzeyinde — KAPANDI
`0002` migration'ı `maestro_append_only()` plpgsql fonksiyonunu ve dört trigger'ı
kuruyor: `JournalEntry` ve `AuditLog` için `BEFORE UPDATE OR DELETE` (satır) +
`BEFORE TRUNCATE` (deyim). TRUNCATE ayrı olmalı, aksi hâlde `TRUNCATE "AuditLog"`
tek bir satır trigger'ı tetiklemeden "append-only" tabloyu boşaltırdı.
`AuditLog.prevHash` üzerine `@unique` geldi: iki satır aynı öncülü gösteremez, dolayısıyla
zincir çatallanamaz ve genesis tektir.

Tip düzeyinde ikinci hat: `appendOnly(db)` yalnız okuma/ekleme metotlarını taşıyan
**yeni ve donmuş** bir nesne döndürüyor, yani `deleteMany` ne tipte ne çalışma
zamanında erişilebilir. İkisi de gerekli — tip tek başına tavsiye niteliğindedir
(cast onu bozar), trigger tek başına hatanın üretime çıkmasına izin verir.

**Testler:** çevrimdışı tarafta migration metni denetleniyor; davranış
`test/live-guards.test.ts`'te gerçek Postgres'e karşı doğrulanıyor (§4).

### B-15 · UGURPAY-500'ün appId/matchJson çelişkisi — KAPANDI
Koordinasyon parent'ına `appId: "ugurpay"` verildi. M100 zaten "keşif oturumu BİRİNCİL
uygulamanın repo'sunda çalışır" diyor, dolayısıyla `{via:"rule", appId:"ugurpay"}` ile
`appId: null` çelişkisi vardı. Yeni test: `MatchResult.appId === run.appId` (onboarding
hariç, o kademede uygulama yoktur).

### B-16 · Transaction + sessiz `skipDuplicates` — KAPANDI
`seedDemo` tek `$transaction` içinde çalışıyor. Ana veri (`Application`, `User`, …)
hâlâ `skipDuplicates: true` — gerçek bir kurulumun satırlarının üstüne yazılmamalı.
`AuditLog` ve `JournalEntry` için `skipDuplicates` **kaldırıldı**: append-only bir
tabloda çakışma "zincir iki kez yazılıyor" demektir ve bunu yutmak M33'ün yasakladığı
fail-open'dır. Dolu bir veritabanında ikinci koşum yüksek sesle patlar ve transaction
geri alınır (canlı olarak denendi, aşağıya bakınız).

### B-17 · Veri sınıfı temsili — KAPANDI
22 run'ın hepsi `dahili` değil artık: UGURDESK-52 `gizli` (toplu EFT dosyası; org-wide
kural 7'nin `human_lead` + `gizli` etkisi uygulandı, uygulama ataması yine rule-6'dan),
UGURWEB-83 `acik` (halka açık pazarlama sayfalarında WCAG etiketleri). UGURDESK-52'nin
`gizli` LLM çağrısı on-prem sürücüye gidiyor — `dataclass.policy`'nin bu sınıf için
öngördüğü şey tam olarak bu (M18/M63).

### B-18 · `sodVerified` koşulsuz `true` — KAPANDI
`verifyGateSod()` hesaplıyor: bir run'ın 4↔5 ve 5↔12 kapıları aynı kişi tarafından
imzalanmışsa `false` döner. Veri bu kuralı sağladığı için testte `true` bekleniyor —
ama artık bu bir **iddia değil, sonuç**.

### B-19 · Enum'a terfi — KISMEN KAPANDI
`StepEvent.kind` → `StepKindE` (sözleşmedeki `StepKind` aynası) ve
`Application.createdVia` → `CreatedViaE` (`ApplicationRecord.shape.createdVia.options`
aynası) enum oldu; ikisi de `test/schema-enums.test.ts`'in ayna tablosuna girdi.
`KnowledgeDoc.kind` **metin kaldı**: sözleşmelerde karşılığı olan bir enum yok, uydurmak
`contracts`'a dokunmak olurdu (§5 isteği).

### B-20 · `tsx` — KAPANDI
`devDependencies`'ten `dependencies`'e taşındı. `seed` komutu ona bağlı ve bu komut
gerçek kurulumda da koşuyor; dev-only saymak yanlıştı.

### B-22 · `ruleIds` sıra bilgisi — KAPANDI
`toJiraProjectBinding(row, rules)` sözleşmenin sıralı `ruleIds` dizisini üretiyor:
`priority` artan, eşitlikte `ruleId` — yani toplam sıra. Org-wide kurallar (projectKey
`NULL`) her bağlamaya katılıyor; bunu bilen tek yer bu mapper. Test her bağlamanın
`ruleIds`'inin öncelik sırasına uyduğunu ve `rule-7`'yi içerdiğini doğruluyor.

---

## 3. Migration stratejisi (neden iki dosya)

`0001_init` **üretilir**: `pnpm -F @maestro/db migration:build`. Elle düzenlenmesi
yasak; doğrulayıcı byte-byte karşılaştırabilir.

`0002_append_only_and_guards` **elle yazılan tek dosyadır**, çünkü içerdiği üç şeyin
Prisma şema sözdiziminde karşılığı yoktur:

1. satır/deyim trigger'ları (append-only zorlaması),
2. `CHECK` kısıtı (guarded parametrede onaylayan zorunluluğu),
3. kısmi `UNIQUE INDEX` (`WHERE status NOT IN (...)`).

Dosyanın başında bunun neden elle yazıldığı yazılı; `test/migration.test.ts` hem
içeriğini (fonksiyon, dört trigger, CHECK, kısmi index) hem de "Prisma'nın üretebileceği
hiçbir şeyi içermediğini" (`CREATE TABLE`/`CREATE TYPE` yok) denetliyor.

Yabancı anahtar sayısı 7 → **6** düştü (RoutingRule → JiraProjectBinding kaldırıldı);
kalan altısının hepsi `ON DELETE RESTRICT`.

---

## 4. Testler

`pnpm -F @maestro/db test` → **13 dosya, 169 test**. Veritabanı olmadan **162** koşar,
7'si (`test/live-guards.test.ts`) `TEST_DATABASE_URL` yoksa atlanır.

| Dosya | Test | Kapsam |
| --- | --- | --- |
| `test/schema-enums.test.ts` | 27 | her şema enum'u sözleşme enum'unun birebir aynası; `@map` yasağı; timestamptz/Decimal/Restrict/native tip kuralları; ayrıştırıcıların kendi birim testleri |
| `test/migration.test.ts` | 16 | `0001` her modeli/enum'u kapsıyor mu, 6 RESTRICT FK, yıkıcı deyim yok, `prevHash` unique, ticket kilidi kalktı, `KnowledgeDoc` çift anahtarlı; `0002`'de trigger + CHECK + kısmi index var ve Prisma'nın üreteceği hiçbir şey yok |
| `test/prisma-validate.test.ts` | 1 | gerçek Prisma CLI, ağa çıkmadan (`CHECKPOINT_DISABLE=1`) |
| `test/client.test.ts` | 10 | URL fail-closed denetimi, hata mesajında parola sızmıyor, 17 modelin delegate'i |
| `test/param-defaults.test.ts` | 17 | 17 varsayılanın her biri kendi M-kararına çivili (M51/M102/M88/M59/M70/M92/M65/M54/M19/M85/M27/M58/M48/M18/M55/M45) |
| `test/seed.test.ts` | 15 | parametre kümesi maket + M-kararı kaynaklarından türetiliyor; `ParamDefinition` uyumu; `seedParams` davranışı; guarded satırlarda CHECK'in sağlanması |
| `test/params-write.test.ts` | 12 | `writeParamVersion` 4-göz kuralları (onaylayan yok / boş / kendisi), tanımsız anahtar reddi, `guarded`'ın tanımdan kopyalanması; demo sürüm geçmişinin bütünlüğü |
| `test/mappers.test.ts` | 16 | BigInt taşma reddi, Decimal→number, her mapper'ın çıktısının sözleşmeye parse olması, `"*"`↔`NULL`, append-only yüzeyinde tek bir mutasyon metodunun bulunmaması |
| `test/seed-demo.test.ts` | 22 | başlık sayıları, üç veri sınıfının temsili, determinizm, sözleşme doğrulamaları, org-wide kural, `ruleIds` sırası, `StepEvent.kind` = `STEP_META`, referans bütünlüğü |
| `test/temporal.test.ts` | 4 | `updatedAt >= startedAt`, defter penceresi + monotonluk, `StepEvent` penceresi, LLM çağrısı penceresi |
| `test/audit-chain.test.ts` | 17 | zincir `@maestro/audit`'in `verifyChain`'i ile doğrulanıyor; kurcalama/silme tespiti; her kararın audit satırıyla aynı `seq`'i; imza çakışması yok; dizi zamanla monoton; kanıt paketlerinin onay kümesi = `GATES_BY_RISK[risk]`; şablon sürümü pinlemesi |
| `test/seed-demo-writer.test.ts` | 3 | tek transaction, FK sırası, append-only tablolarda `skipDuplicates` yok, hata yutulmuyor |
| `test/live-guards.test.ts` | 9 (7'si canlı) | **gerçek Postgres**: journal UPDATE/DELETE reddi, audit UPDATE/DELETE/TRUNCATE reddi, aynı `prevHash`'e ikinci satır reddi, guarded + `approvedBy` NULL reddi, ikinci canlı run reddi + iptalden sonra yeniden başlatılabilme |

Canlı testleri koşmak için:

```bash
docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=maestro \
  -e POSTGRES_DB=maestro_test --name maestro-pg postgres:16-alpine
TEST_DATABASE_URL=postgresql://postgres:maestro@localhost:55432/maestro_test \
  pnpm -F @maestro/db test
```

Bu tur bunlar **gerçekten koşturuldu**: 169/169 yeşil. Ayrıca aynı veritabanına
`prisma migrate deploy` + `pnpm -F @maestro/db seed` uygulandı ve tohum uçtan uca
yazdı; ikinci koşum beklendiği gibi `Unique constraint failed on the fields:
(runId, seq)` ile patlayıp transaction'ı geri aldı.

Kapı (kökten): `pnpm install` ✔ · `pnpm -F @maestro/db typecheck` ✔ ·
`pnpm -F @maestro/db test` ✔ · `pnpm lint` ✔ · `pnpm typecheck` ✔ · `pnpm test` ✔.

---

## 5. Demo veri seti — gerçek satır sayıları

`buildDemoDataset()` saf ve deterministik; `DEMO_NOW` = maketin 8 Ağu 2026 14:20
İstanbul anı. `pnpm seed` çıktısı (boş veritabanında ölçüldü):

| Tablo | Satır | Not |
| --- | --- | --- |
| `Param` / `ParamVersion` (v1) | 17 / 17 | `seedParams` |
| `ParamVersion` (geçmiş) | 8 | `seedDemo`, v2…v4 |
| `User` | 7 | maketin insanları ve AD grupları, kullanılabilir parola yok |
| `Application` | 5 | her platform profilinden biri |
| `RepoCard` | 5 | 2-3 modül (M100) |
| `JiraProjectBinding` | 5 | 4 `active` + UGURKREDI `draft` |
| `RoutingRule` | 6 | 5 proje kuralı + 1 org-wide (`projectKey IS NULL`) |
| `WorkflowRun` | 22 | 7 gate · 8 running · 1 queued · 1 fail · 5 done |
| `StepEvent` | 40 | run başına "adıma girildi" + 18 imzalı karar |
| `JournalEntry` | 100 | UGURPAY-501'in 23 kayıtlık tam defteri + diğerleri |
| `AuditLog` | 76 | `genesis`'ten seq 1…76, `@maestro/audit` ile doğrulanır |
| `EvidencePackageRow` | 5 | tam onay zinciriyle, 10 yıl saklama |
| `LlmCall` | 5 | biri on-prem `gizli`, biri abonelik (`usd = NULL`) |
| `Variant` / `VariantVersion` | 9 / 9 | maketin varyant tablosu |
| `SubscriptionAccount` | 5 | biri `exhausted`, %100 5s penceresiyle |
| `KnowledgeDoc` | 8 | 6 doküman, ikisi çift sürümlü (M83) |

---

## 6. Bağımlılık gerekçeleri

| Bağımlılık | Tür | Neden |
| --- | --- | --- |
| `@maestro/audit` | dependency (**yeni**) | M33'ün tek zincir implementasyonu. Seed'deki ikinci implementasyon silindi; `sealEvent`/`GENESIS`/`assertActor`/`actionInfo` buradan geliyor, testler `verifyChain`/`rehash` ile doğruluyor. |
| `@maestro/contracts` | dependency | donmuş şemalar |
| `@prisma/client` | dependency | `createDb`'nin döndürdüğü üretilmiş istemci; sürüm ailesi `prisma` CLI ile aynı (ikisi de 6.19.3) |
| `tsx` | dependency (**dev'den taşındı**) | `pnpm seed` buna bağlı ve seed gerçek kurulumda koşuyor (B-20). Node 24'ün yerel tip soyma özelliği yetmiyor: depo `.js` uzantılı belirteçlerle `.ts` dosyalarına işaret ediyor, Node'un çözücüsü bunu izlemiyor. |
| `prisma` | devDependency | CLI (`generate`, `migrate diff`, `validate`) |
| `@types/node`, `typescript`, `vitest` | devDependency | tip tanımları, derleyici, test koşucusu |

Başka bağımlılık eklenmedi.

---

## 7. Varsayımlar ve maket kararları

1. **Parametre anahtar biçimi.** `ParamKey` `^[a-z][a-z0-9_.]+$` olduğu için maketin
   camelCase anahtarları (`gates.riskTiers`) yasal değil; snake_case'e çevrildi,
   ad alanları korundu. Eşleme `test/seed.test.ts`'te tablo hâlinde duruyor.
2. **Maketin "platform" kapsamı** bir `ParamScope` değil; `build.timeout_min` global
   kapsamda, değeri `PlatformProfile` ile anahtarlanmış JSON.
3. **Audit `seq` 1'den başlar** (B-4). Maketin 81408+ sayacı korunmadı.
4. **Maketin kendi çelişkileri** koda yorum olarak yazılıp veri lehine karara bağlandı
   (B-6 listesi). Değişen alanlar yalnız `ageHours`/`idleHours`; ticket'ların içeriği,
   sahipleri ve durumları makete sadık.
5. **UGURPAY-501'in defteri** makette "alt ticket'lar açıldı" satırını taşır, yani
   maket bu defteri hem parent hem child gibi kullanmış. Defter olduğu gibi 501'de
   bırakıldı; parent UGURPAY-500 kısa defterle temsil ediliyor.
6. **UGURPAY-501'in kapı kümesi** risk tier'ından (orta) bir fazla kapı içeriyor
   (adım 9, QA senaryo onayı). Bu makette var ve M51 "PO tier'ı yükseltebilir" dediği
   için korundu; testler yalnız **kapanmış** run'ların kümesini `GATES_BY_RISK` ile
   birebir karşılaştırıyor.
7. **`0001_init` 339 satır** ve 300 satır tavanını aşıyor; üretilmiş dosya olduğu için
   bölünemez.

---

## 8. İSTEKLER (bu pakette hiçbir şey dışarıya dokunmadı)

### 8.1 `packages/config` mesaj kataloğu — 14 eksik anahtar

Mevcut: `params.description.gate_set`, `.escalation_ladder`, `.output_language`.
Eksik olanlar (TR / EN önerisi):

| Anahtar | tr | en |
| --- | --- | --- |
| `params.description.coverage_ratchet` | "Kapsam mandalı: düşüş yasak, yeni satırlarda alt sınır" | "Coverage ratchet: no decrease, floor for new lines" |
| `params.description.sod_qa_split` | "QA görev ayrılığı: senaryo onaylayan ≠ sonuç onaylayan" | "QA separation of duties: scenario approver ≠ result approver" |
| `params.description.workspace_max_age_days` | "Hareketsiz workspace'in arşivlenme süresi (gün)" | "Idle workspace archive age (days)" |
| `params.description.kill_switch_state` | "Kill-switch durumu: kapalı / yalnız yeni iş durdu / her şey durdu" | "Kill switch state: off / intake stopped / everything stopped" |
| `params.description.merge_mode` | "Merge modu: insan-merge veya auto-merge" | "Merge mode: human merge or auto merge" |
| `params.description.dry_run_sample_size` | "Aktivasyon öncesi kuru koşumda incelenen ticket sayısı" | "Ticket count sampled by the pre-activation dry run" |
| `params.description.data_class_policy` | "Veri sınıfı → LLM arka ucu eşlemesi ve on-prem yoksa davranış" | "Data class → LLM backend mapping and the no-on-prem fallback" |
| `params.description.subscription_queue` | "Abonelik havuzu tükendiğinde işi kuyruğa al" | "Queue the run when the subscription pool is exhausted" |
| `params.description.reminder_channel` | "İlk hatırlatıcının gönderileceği kanal" | "Channel used for the first reminder" |
| `params.description.trigger_mode` | "Proje tetikleme modu: otomatik / etiket / komut" | "Project trigger mode: automatic / label / command" |
| `params.description.stuck_threshold` | "Takılma eşiği: kaç ret veya CI hatasından sonra insana devredilir" | "Stuck threshold: rejections or CI failures before handover" |
| `params.description.quota_warn_pct` | "Kota penceresinde uyarı eşiği (%)" | "Quota window warning threshold (%)" |
| `params.description.build_timeout_min` | "Platform başına build zaman aşımı (dakika)" | "Per-platform build timeout (minutes)" |
| `params.description.scan_block_level` | "Akışı durduran en düşük tarama önem derecesi" | "Lowest scan severity that stops the flow" |

Testler yalnız `params.description.` önekini denetliyor, bu yüzden katalog paketi
gelene kadar süit yeşil kalır; katalog tarafında bir eşleşme testi bu 17 anahtarı
kapsamalı.

### 8.2 `packages/contracts` (donuk — yalnız dilek)

1. **`ParamChange.scopeRef` `string | null`, ama kolon birincil anahtarın parçası**;
   Postgres PK'da NULL kabul etmez. DB `""` kullanıyor (`GLOBAL_SCOPE_REF`), mapper
   `null ↔ ""` çeviriyor. Temizi: sözleşmede `.default("")`.
2. **`KillSwitchState` enum'u yok.** Tohum `off | intake_only | all`'ı satır içi
   tanımlıyor; sözleşmeye eklenirse kolon Postgres enum'u olabilir.
3. **`MergeMode` enum'u yok** (M48) — aynı gerekçe.
4. **`ScanBlockLevel` / `TriggerMode` kapsamı**: `scan.block_level` `ScanSeverity`'yi,
   `trigger.mode` `TriggerMode`'u yeniden kullanıyor; bunlar iyi. Eksik olan,
   json tipli parametrelerin **değer şemaları**: `ParamDefinition.defaultValue`
   `unknown`, dolayısıyla `gates.risk_tiers`, `escalation.ladder`, `coverage.ratchet`,
   `dataclass.policy`, `stuck.threshold`, `build.timeout_min` Studio'dan
   düzenlendiğinde hiçbir şey doğrulamıyor. Öneri: `ParamKey` ile anahtarlanmış bir
   şema kaydı ya da `ParamDefinition.valueSchemaName`.
5. **`LlmCallLog.usd` `number`, kolon `Decimal`.** Dönüşüm noktası artık
   `toLlmCallLog` (§2 B-8); llm-gateway paketi bunu kullanmalı.
6. **`GATES_BY_RISK` iki yerde**: sabit ve `gates.risk_tiers` parametresi. Testler
   ikisini birbirine çiviliyor; workflow paketi çalışma anında hangisinin yetkili
   olduğuna karar vermeli (öneri: parametre; sabit yalnız tohum değeri).
7. **`KnowledgeDoc.kind` için enum yok** (`template | example_analysis | standard |
   app_intro | policy`). Sözleşmeye eklenirse kolon enum'a terfi eder (B-19'un
   kalan kısmı).
8. **`MatchResult` tek `ruleId` taşıyor.** Demo'da UGURDESK-52'nin uygulaması
   rule-6'dan, veri sınıfı + modu org-wide rule-7'den geliyor; sözleşme bunu
   kaydedemiyor. Öneri: `ruleIds: string[]` ya da `appliedRuleIds`.

### 8.3 Orkestratör kararı bekleyen

1. **Çok dosyalı Prisma şeması.** `prisma/schema.prisma` 463 satır ve 300 satır
   tavanının üstünde. Prisma 6 `prismaSchemaFolder`'ı destekliyor; geçiş
   `migration:build` argümanını, `PRISMA_SCHEMA_RELATIVE_PATH`'i ve `schema-facts`
   tabanlı üç testi etkiler. Ayrı, küçük bir tur olarak yapılması önerilir.
2. Kök `package.json`: Wave-0'da `@prisma/client` `pnpm.onlyBuiltDependencies`'e
   eklendi; `pnpm install` artık uyarı vermiyor. Ek istek yok.

---

## 9. TAKILDIM

Yok.

Kapatılamayan tek şey B-19'un `KnowledgeDoc.kind` kısmı: sözleşmelerde karşılığı olan
bir enum yok ve `packages/contracts` bu turda dokunulmaz. §8.2/7'ye istek olarak yazıldı.
