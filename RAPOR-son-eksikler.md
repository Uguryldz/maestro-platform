# RAPOR — prod pilotu öncesi son dört eksik

**Branch:** `agent-a8839b66c5f789c5e` (main'e **merge edilmedi**)
**Taban commit:** `69022c6`
**Kapı:** `pnpm run gate` → **exit 0, 60/60 görev, 4635 test** (tabanda 4028 idi → **+607**)

Dört madde de kapatıldı. Hepsi canlı bir Postgres + Temporal + BFF + Studio üzerinde,
tarayıcıda tek tek doğrulandı — aşağıda kanıtlarıyla.

---

## 1. Şablon tasarımcısı — tek "yayında değil" kalan ekran

### Ne yapıldı

**Kalıcı depo.** `AnalysisTemplateVersion` tablosu (migration **0007**), `PrismaTemplateStore`
(`apps/deploy/src/stores/template.ts`, `PrismaDocTemplateStore` kalıbında). BFF artık
`InMemoryTemplateStore` kullanmıyor. `templates` **`VOLATILE_STORES` listesinden çıkarıldı** —
artık kalıcı olduğu için orada yeri yok.

Tablo **append-only**, ve bu niyet değil zorlama: 0002'nin `maestro_append_only()` fonksiyonu
yeniden kullanıldı (ikinci bir fonksiyon yazmak yerine), UPDATE/DELETE **ve TRUNCATE** için
trigger'lar kuruldu. Onaylanmış bir analizin neye göre değerlendirildiği (M83) sonradan
değiştirilemez. CHECK kısıtları: sürüm > 0, bölüm listesi boş olamaz, ad boş olamaz.

**Varsayılan şablon.** `packages/db/src/template-defaults.ts` — **8 bölüm**: amaç ve gerekçe,
kapsam, etki analizi, veri ve gizlilik, riskler ve önlemler, geri alma planı, test ve kabul
kriterleri, bağımlılıklar. Her bölümde M108'in altı alanı da dolu (başlık, açıklama, AI
talimatı, zorunlu/opsiyonel, beklenen biçim, örnek).

Bunlar **örnek metin değil**: her `aiInstruction` gerçek bir talimat ve "bilgi yoksa uydurma,
şunu yaz" kuralını da içeriyor. Test bunu zorluyor (`aiInstruction.length > 80`) — "TODO"
ya da "Örnek bölüm 1" geçemez.

`seedAnalysisTemplate` (`packages/db/src/seed-template.ts`) **migrate binary'sinde** çağrılıyor,
seed CLI'da değil: migrate her kurulumun çalıştırdığı yol, seed CLI opsiyonel ve demo yarısı bir
bankanın veritabanına asla dokunmamalı. Advisory lock'un **içinde** (N replika aynı anda başlar).
Yalnız tablo boşken yazar; banka v4 yayınladıysa **dokunmaz**.

### Kanıt

```
$ tsx src/bin/migrate.ts
[maestro] migrations applied
[maestro] analysis template v1 published (8 sections)

$ tsx src/bin/migrate.ts          # ikinci koşum — idempotent
[maestro] analysis template already published, leaving it alone
```

```
$ curl -s /template -H "authorization: Bearer $T"     →  HTTP 200
name    : Standart analiz şablonu v1
version : 1     by: installer     sections: 8
  - amac_ve_gerekce         | Amaç ve gerekçe          | required=True | free_text
  - kapsam                  | Kapsam                   | required=True | bullet_list
  - etki_analizi            | Etki analizi             | required=True | impact_matrix
  - veri_ve_gizlilik        | Veri ve gizlilik         | required=True | free_text
  - riskler_ve_onlemler     | Riskler ve önlemler      | required=True | table
  - geri_alma_plani         | Geri alma planı          | required=True | free_text
  - test_ve_kabul_kriterleri| Test ve kabul kriterleri | required=True | bullet_list
  - bagimliliklar           | Bağımlılıklar            | required=False| bullet_list
```

**Kalıcılık kanıtı** — BFF öldürüldü (`curl` → HTTP 000, connection refused), yeniden başlatıldı:

```
$ curl -s /template   →  HTTP 200   (şablon HÂLÂ orada, 8 bölüm)
```

**Yazma yolu** (`POST /template/versions` → **201**), ve M83 pinlemesi:

```
current: v3 "Banka analiz sablonu v3"
history: [(3,'ayse.kaya@bank','2'), (2,'u-ayse','1'), (1,'installer','8')]
/template/versions/1 → 200    /template/versions/2 → 200    /template/versions/3 → 200
```

**Append-only trigger canlı doğrulandı:**
```
psql> UPDATE "AnalysisTemplateVersion" SET name='hacked' WHERE version=1;
ERROR: maestro_append_only: public.AnalysisTemplateVersion is append-only, UPDATE is refused
psql> DELETE FROM "AnalysisTemplateVersion" WHERE version=1;
ERROR: ... DELETE is refused (M30/M33)
```

**`projects()` gerçek sayım** — sabit sıfır değil. Kasıtlı kurulum: v1'de `running`, v2'de `gate`,
v3'te `running` (güncel → sayılmaz), UGURWEB'de v1 ama `done` (bitmiş → sayılmaz):
```
{'projectKey': 'UGURPAY', 'version': 3, 'pinnedRuns': 2}
{'projectKey': 'UGURWEB', 'version': 3, 'pinnedRuns': 0}
```

**Tarayıcı:** `/template` artık **"yayında değil" demiyor**. Bölüm listesi (↑↓ sırala, ✕ çıkar),
bölüm düzenleyici (altı alanın hepsi), sürüm geçmişi tablosu (v3/v2/v1) ve
`UGURPAY · v3 · 2 akış pinli` görünüyor. Bir bölüme tıklanıp düzenleyici açıldı — önceki
raporun "yapılamadı" dediği test **yapıldı**.

---

## 2. Türkçe eksikleri

Kural: BFF **cümle göndermez**, katalog anahtarı gönderir. Üç örnek verilmişti; **taradım, dokuz
sızıntı buldum**.

| # | Nerede | Neydi | Ne oldu |
|---|---|---|---|
| 1 | `/routing` NOT sütunu | `every ticket starts a run`, `draft: not yet bound` | `noteKey` + `noteParams` (7 anahtar) |
| 2 | `/routing` KOŞUL sütunu | `component = odeme`, `every ticket` | `conditionKey` + `conditionParams` (5 anahtar) |
| 3 | `/routing` politika koşulu | `dataClass = gizli` | `routing.policy.condition.*` (2 anahtar) |
| 4 | `/yaml` yer tutucusu | 6 satır İngilizce YAML yorumu | `yamlPresent` bayrağı + `yaml.absent.*` |
| 5 | `/issues` KARAR sütunu | `GATE_OPEN · maestro-worker` | `action`+`actor` **ayrı alanlar**, ekran birleştiriyor |
| 6 | `/issues` DURUM sütunu | ham `decided`/`approved` | `issues.status.*` (4 anahtar) |
| 7 | **`/audit` EYLEM sütunu** (listede yoktu) | ham `PARAM_CHANGED`, 76 satır | `audit.action.*` (**26 anahtar**) |
| 8 | **`/pii` tip ve strateji** (listede yoktu) | ham `regex`, `hash` | `pii.kind.*`, `pii.strategy.*` (5 anahtar) |
| 9 | **`mode.*` katalogda ham enum'du** | `"mode.full_auto": "full_auto"` | "Tam otomatik" vb. |

**9 numara kök nedendi.** Ekranlar doğru çalışıyordu — `t()` çağrılıyordu ama katalog anahtarı
kendi enum'una eşliyordu. Bu yüzden risk sütunu Türkçe, mod sütunu İngilizceydi: aynı tabloda.

Tarayıcıda ayrıca **4 sızıntı daha** yakalandı (statik taramada görünmeyen, prose içine gömülü):
`llm.outcome_hint.degraded`, `help.command_desc.mode_change`, `commands.effect.ai_takeover`,
`workmode.handover.{handoff,takeover}` — hepsi düzeltildi.

**Toplam: ~60 katalog metni eklendi/düzeltildi** (51'i hata mesajı, 9'u enum ailesi + prose).
tr/en **1523 anahtar, tam parite**, alfabetik sıralı.

> Bilerek bırakılan tek yer: `help.analysis_step.after` içindeki `/mode-change human_lead` —
> bu kullanıcının **yazdığı literal komut**, çevrilemez.

### Kanıt (tarayıcı)

```
/routing  → "taslak: henüz bağlanmadı" · "\"maestro\" etiketini ya da /ai-start komutunu bekler"
            "her ticket bir iş akışı başlatır" · "veri sınıfı = acik"
/issues   → Karar: "Parametre değişti · ayse.kaya@bank"   Durum: "Karara bağlandı"
/audit    → Eylem: "Parametre değişti"   (ham PARAM_CHANGED değil)
/tickets  → Risk "orta" · Mod "AI destekli"   ← aynı tabloda tek dil
/workmode → regex /full_auto|ai_assist|human_lead|human_only/ → EŞLEŞME YOK
/yaml     → ".maestro.yaml görülmedi" + Türkçe açıklama (İngilizce blok gitti)
```
Uygulama geneli son tarama: `/hash|redact|partial|GATE_|_auto|not yet bound|every ticket starts/`
→ **eşleşme yok**.

---

## 3. Onboarding hata mesajı

`RAPOR-onboarding.md` 10 kod listeliyordu; koda bakınca **eksikti** — `unknown_app`,
`invalid_app_id`, `invalid_page`, `kill_switch` de atılıyor ama raporda yok. 14 kod eksikti.

**Asıl bulgu:** `errors.ts`'teki yorum "eksik kod `test/api-client.test.ts` ile yakalanır"
diyordu. **Yakalamıyordu.** Test `knownErrorCodes()` ile tablonun kendi anahtarlarını dönüp
tabloyu kendisiyle doğruluyordu — totoloji. BFF'ten kod silseniz de yüzlerce eklseniz de geçerdi.

Yerine **gerçek** bir test yazıldı: `apps/bff/src` altındaki `.ts` dosyalarını gezip
`badRequest("…")` / `conflict("…")` / `notFound("…")` / `forbidden("…")` / `unauthenticated("…")` /
`unavailable("…")` çağrılarını tarıyor, çıkan kümenin `ERROR_KEYS`'in **alt kümesi** olduğunu
doğruluyor. Testin kendisi de korunuyor (`files.length > 20`, `thrown.size > 20`) — yanlış yol
verilirse "hiçbir şey bulamadım" diye geçmesin.

Bu test ilk koşumda **kırmızı yandı ve 37 kod daha buldu** (doc-template, params, settings,
variants, runs, identity…). Hepsi ekranda "Beklenmeyen bir hata oluştu" oluyordu.

**Sonuç: `ERROR_KEYS`'e 51 kod eklendi**, her biri için tr+en metin yazıldı.

### Kanıt (tarayıcı)

`/onboard` → UGURPAY (zaten bağlı) + odeme-api → "Kuru koşum yap":

> **"Bu Jira projesi zaten bağlı (ya da bir kuru koşum sürüyor). Önce mevcut bağlantıyı
> kaldırman gerekir."**

Eskiden: "Beklenmeyen bir hata oluştu."

---

## 4. Prod imajı

**`docker compose config` → exit 0.** (İmaj build edilmedi — kullanıcı uyardı.)

### Bulunan gerçek hata: `RUNNER_IMAGE_LINUX` worker'a hiç ulaşmıyordu

`.env.example`'da yoktu **ve** `compose.yaml`'ın paylaşılan env anchor'ında da yoktu. Yani pilot
ekibi `.env`'e yazsa, dosya kabul edilse, konteynere **hiçbir zaman geçmezdi** — ve adım 6a
"sandbox fleet yok" diye reddederken sebebi görünmezdi. `RUNNER_COMMAND_TIMEOUT_SECONDS` ve
`DOCKER_SOCKET_PATH` de aynı durumdaydı. Üçü de eklendi.

### İkinci hata (birinciyi düzeltirken çıktı): boş string boot'u düşürüyordu

compose `${RUNNER_IMAGE_LINUX:-}` yazıyor — bu **boş string** yollar, "değişken yok" değil.
Şema `z.string().min(1).optional()` idi: absent'i kabul eder, **boş string'i reddeder**. Yani
değişkeni eklemek, set etmeyen her kurulumda **worker'ı boot'ta çökertecekti** — oysa tasarım
"sandbox fleet olmadan da başla, yalnız 6a'yı reddet".

`optionalSetting()` yazıldı (trim eder, boşu `undefined` sayar). Scanner imajları da aynı
tuzaktaydı, onlar da geçirildi. `test/env-runner-image.test.ts` bu üç durumu kilitliyor.

Bu hatayı **test yazarken buldum** — düzeltmeyi doğrulamak için yazdığım test kırmızı yandı.

### `.env.example`

Zaten kapsamlıydı (322 satır, LDAPS/Jira/ADO/LLM/Vault/Redis hepsi yorumlu ve "bu bilgi nereden
alınır" yazılı). Eklenen:
- **Sandbox runner bölümü**: `RUNNER_IMAGE_LINUX` (digest zorunlu, nereden alınacağı yazılı),
  `RUNNER_COMMAND_TIMEOUT_SECONDS`, ve Windows/macOS'un **kapsam dışı** olduğu açık notu.
- Redis bölümünün **başlık çerçevesi kırıktı** (LDAP bölümüne yapışmıştı) — düzeltildi.

### `deploy/SURUM-NOTU.md`

Yazıldı. İçinde: çalışan zincir tablosu, bu sürümde düzelenler, **çalışmayanlar** (Windows/Mac
runner'ları kapsam dışı; `cache`/`eval`/`greenfield`/`runners`/`scans` neden 503 — her biri için
gerçek sebep, "boş liste 'her şey yolunda' diye okunur" argümanıyla), ve pilot ekibi için
**5 adımlı sıra**: env doldur → migration → LDAPS testi → proje bağla → ilk ticket. Her adımda
ne göreceklerini de yazdım.

---

## Değişen dosyalar

**Yeni:** `packages/db/prisma/migrations/0007_analysis_template/migration.sql` ·
`packages/db/src/{template-defaults,seed-template}.ts` · `apps/deploy/src/stores/template.ts` ·
`apps/deploy/test/{template-store,env-runner-image}.test.ts` ·
`packages/db/test/template-defaults.test.ts` · `deploy/SURUM-NOTU.md` · bu rapor

**Değişen (öne çıkanlar):** `packages/db/prisma/schema.prisma` · `apps/deploy/src/bin/{bff,migrate}.ts` ·
`apps/deploy/src/env.ts` · `apps/deploy/src/stores/{routing,read-governance}.ts` ·
`apps/bff/src/{deps,read-studio,routing-service,repo-policy-service}.ts` ·
`apps/bff/src/routes/{repo-policy,studio-governance}.ts` · `apps/studio/src/api/errors.ts` ·
`apps/studio/src/screens/{Routing,Issues,Audit,Pii,Yaml}.tsx` ·
`apps/studio/src/screens/common/{label,admin-api}.ts` · `apps/studio/src/app/ErrorBoundary.tsx` ·
`packages/config/locales/{tr,en}.json` · `deploy/{compose.yaml,.env.example}`

---

## ARAYÜZ İSTEKLERİ

**Yok.** `packages/contracts` ve `packages/ports` **hiç değiştirilmedi**. Değiştirdiğim wire
şekilleri (`RoutingProjectView`, `RoutingRuleView`, `PolicyRuleView`, `DecisionRecord`,
`PolicyBody`) hepsi `apps/bff/src` içinde — donmuş paketlerde değil.

Not: `template-service.ts`'te **var olan** bir ARAYÜZ İSTEĞİ duruyor (`AuditAction`'da
`TEMPLATE_VERSION_PUBLISHED` yok, `PARAM_CHANGED` kullanılıyor). Bunu değiştirmedim — donmuş
enum, ve mevcut çözüm `template:` öneki ile net. Denetim izinde böyle görünüyor:
`Parametre değişti · template:Banka analiz sablonu v3`.

---

## Yapmadıklarım ve nedeni

1. **Docker imajı build etmedim.** Kullanıcı açıkça uyardı (uzun sürüyor). `docker compose config`
   geçerliliği ve kaynak-üstü uçtan uca doğrulama yapıldı.
2. **Windows/Mac runner'ları** — görev tanımında kapsam dışı. `SURUM-NOTU.md`'de açıkça yazıldı.
3. **`/pii`, `/studio/decisions` tarayıcıda veri ile görülmedi** — bu uçlar audit-backed reader
   istiyor ve benim küçük fixture'ımda o zincir yoktu (404). Enum çevirileri Studio birim
   testleriyle kapsanıyor; `/audit` aynı `audit.action.*` ailesini canlı olarak gösterdi.
4. **`cache`/`eval`/`greenfield`/`runners`/`scans` bağlanmadı.** Kapsam dışı ve kasıtlı: arkalarında
   veri üreten hiçbir şey yok. Bağlamak, uydurma veri göstermek olurdu — fail-closed kuralına aykırı.
5. **`u-ayse` aktörlü v2 satırı DB'de duruyor.** Kendi test hatam (kullanıcı `id`'sini
   e-posta şeklinde vermemiştim; audit `user@corp` istiyor). Silemedim çünkü **append-only
   trigger reddediyor** — ki bu tam olarak istenen davranış. Yalnız benim doğrulama veritabanımda.
6. **main'e merge etmedim** — talimat gereği.

## Temizlik

`maestro-son-eksik` (Postgres) ve `maestro-son-eksik-temporal` konteynerleri kaldırıldı.
`uinfra-postgres`'e **dokunulmadı**. `deploy/.env` geçici kopyası silindi.
