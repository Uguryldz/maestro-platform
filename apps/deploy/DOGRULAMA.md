# DOĞRULAMA — `apps/bff` (Dalga 4 eklemeleri) + `apps/deploy`

**Denetçi:** bağımsız doğrulayıcı ajan · **Tarih:** 2026-08-09
**Çalışma yeri:** `/home/ubuntu/coder/maestro` (salt-okunur; tüm geçici değişiklikler geri alındı)

## Karar

| Paket | Karar |
|---|---|
| `apps/bff` (Dalga 4 yüzeyi) | **KALDI** — 1 kritik, 2 yüksek |
| `apps/deploy` | **KALDI** — 1 kritik, 1 yüksek |

Testler yeşil ve mimari disiplin gerçek; ama üretim yolunda **kalıcı olmayan
güvenlik durumu** ve **kill switch'i atlayan bir yazma yolu** var.

---

## Doğrulanmış iddialar (kanıtla)

Rapordaki her iddiayı körlemesine kabul etmedim; aşağıdakiler **kanıtlandı**:

- **Testler:** `apps/bff` 336/336 yeşil (rapordaki 336 doğru). `apps/deploy` **201** test yeşil.
- **`/studio/gates` salt-okunur:** POST/PUT/PATCH/DELETE hepsi **404** (oturumlu ve oturumsuz). Doğrulandı.
- **`MaestroPlatform`'da kapı kapatan metot yok:** çalışan sunucudan metot listesi çekildi — 18 metot, hiçbiri kapı kararı/verdict/merge değil. Doğrulandı.
- **Sayfalama tavanı:** `limit=201/1000/0/-1/abc/1e9/50.5` hepsi **400 `invalid_page`**. Sessiz kırpma yok. Doğrulandı.
- **Fail-closed açılış (gerçekten çalıştırıldı):** `worker`/`bff`/`migrate` boş ortamla → **exit 1** + anlamlı mesaj.
- **Sır sızıntısı (kendim denedim):** DB parolası ve `VAULT_SECRET_ID` ortamda iken 4 ayrı açılış hatası tetiklendi; **hiçbirinde düz sır geçmiyor**.
- **Worker reddi gerçek:** dev profili tam ortamla çalıştırıldı; port tablosu basıldı (9 port, raporla birebir), sonra 6 eksik store adıyla sayılarak **exit 1**.
- **M44 clean-room:** sürücü importları yalnızca `apps/deploy/src/{registry,boot}.ts`'te. `packages/*` çekirdeğinde sürücü importu yok.
- **Compose güvenliği:** root yok (`user: "10001:10001"`), `network_mode: host` yok, `privileged` yok, **docker soketi mount edilmiyor**, `cap_drop: ALL` + `read_only: true` + `no-new-privileges`. `docker compose config` → exit 0.
- **Migration kilidi:** `pg_try_advisory_lock` + poll + timeout; bloklayan varyant kullanılmıyor.

### Mutasyon testleri — 8 adet, **8'i de öldürüldü**

Her biri: boz → testleri çalıştır → kırıldığını gör → geri al. Sonrasında `git status` temiz.

| # | Mutasyon | Sonuç |
|---|---|---|
| 1 | `UNLABELLED_CLASS` `gizli` → `acik` | **3 test kırıldı** |
| 2 | `MAX_PAGE_SIZE` 200 → 100000 | **2 test kırıldı** |
| 3 | `canSeeProject` → `return true` | **11 test kırıldı** |
| 4 | `decodeCursor` `indexOf` → `lastIndexOf` (raporun anlattığı hata) | **2 test kırıldı** |
| 5 | `assertWritable` kill switch kontrolü devre dışı | **2 test kırıldı** |
| 6 | Guard'da pasif/silinmiş hesap kontrolü devre dışı | **2 test kırıldı** |
| 7 | `assertProfileMatchesNodeEnv` devre dışı (dev profili prod'da) | **1 test kırıldı** |
| 8 | Migrate lock timeout kaldırıldı (sonsuz döngü) | **OOM ile kırıldı** — timeout testi gerçek |
| 9 | `prod` profili `secret: vault` → `env-file` | **3 test kırıldı** |

Testler totolojik değil; kaldırılan güvenlik davranışı gerçekten yakalanıyor.

---

# BULGULAR

## K-1 (KRİTİK) — Dağıtılan BFF'te kill switch her yeniden başlatmada **sessizce kapanıyor**

**Dosya:** `apps/deploy/src/bin/bff.ts:57-63`

```ts
sessions: new InMemorySessionStore(),
params:   new InMemoryParamStore(),
killSwitch: new InMemoryKillSwitchStore(),   // ← süreç-yerel, kalıcı değil
bindings: new StaticJiraProjectBindings([]),
```

`InMemoryKillSwitchStore` parametresiz kurulunca `KILL_SWITCH_OFF` ile başlar
(`apps/bff/src/stores/memory.ts:78-82`, `KILL_SWITCH_OFF` = `level: "off"`).

**Kanıtladım** (probe testi, çalıştırıldı):
```
fresh store            → {"level":"off", ...}
operatör "all" yapıyor → {"level":"all","reason":"incident", ...}
YENİDEN BAŞLATMA       → {"level":"off", ...}   ← switch kendiliğinden açıldı
```

**Neden kritik:** Kill switch bir olay anında çekilen acil durum frenidir (M58).
Compose'da `bff` servisi `restart: unless-stopped` ile çalışıyor — yani
konteyner çöktüğünde/yeniden dağıtıldığında **fren kendiliğinden bırakılıyor**,
üstelik operatöre hiçbir şey söylemeden. Platform "durduruldu" sanılırken
yazma uçları yeniden açılır. Bu, raporun kendi savunduğu fail-closed ilkesinin
tam tersi: `read` modelleri "boş sayfa yerine reddet" diye özenle
`unbridgedReadModels()` ile kapatılmışken, **kill switch aynı özeni görmemiş** —
o sessizce "güvenli olmayan" varsayılana düşüyor.

Aynı kalıcılık sorunu `sessions` (yeniden başlatmada tüm oturumlar düşer —
zararsız), `params` (M71 yönetim parametreleri + bekleyen 4-göz önerileri
kaybolur — ciddi) ve `bindings: []` (aşağıda Y-2) için de geçerli.

**Raporun ifadesi eksik:** `deploy/RAPOR.md` "BFF'in bazı store'ları hâlâ
in-memory" diyor ve bunu bir *tamamlanmamışlık* olarak sunuyor. Ama `read`
modelleri için "boş sayfa = sakin sistem yalanı" gerekçesiyle **reddetme**
tercih edilmişken, kill switch için aynı mantık uygulanmamış. Tutarsızlık
raporda tartışılmamış.

**Öneri:** `killSwitch` (ve `params`) ya Postgres destekli olmalı, ya da
`unbridgedReadModels()` kalıbıyla **reddetmeli** — açılışta `off` varsaymamalı.

---

## K-2 (KRİTİK) — `notifyGateOwner` kill switch'i **atlıyor**: platform durdurulmuşken Jira'ya yazıyor

**Dosya:** `apps/bff/src/platform/operate.ts:166-210`

`operate` yarısındaki 7 metottan **6'sı** `await assertWritable(deps)` çağırıyor
(satır 44, 65, 95, 110, 119, 133). **`notifyGateOwner` çağırmıyor** — satır
170-171'de doğrudan `scopeOf` + `runOf`, `assertWritable` yok.

**Kanıtladım** (probe testi, çalıştırıldı):
```
killswitch: {"level":"all","reason":"incident", ...}
notifyGateOwner SUCCEEDED with killswitch=all: {"runId":"run-UGURPAY-501","step":"5","notified":"tech-leads"}
jira comments before/after: 0 → 1
  body: "UGURPAY-501 4 gündür 5 kapısında bekliyor"
```

Kill switch `all` seviyesindeyken bile **dış sisteme (Jira) yazma gerçekleşti**
ve audit'e `MCP_TOOL_CALL` yazıldı.

**Neden kritik:** `RAPOR-dalga4.md` §5 açıkça şunu iddia ediyor:

> "`assertWritable` her operate metodunda; **tek bir boğaz noktası değil, çünkü
> unutan metot olay anında çalışan metot olurdu.**"

Rapor tam olarak bu riski adlandırmış ve tam olarak o hatayı yapmış — unutulan
metot var, ve o metot dış sisteme yazan metot. Kill switch'in anlamı "platform
hiçbir yere dokunmasın"dır; bir olay sırasında MCP üzerinden bir AI hâlâ banka
Jira'sına yorum yazdırabiliyor.

**Test boşluğu:** `test/platform-operate.test.ts:274-312` `notifyGateOwner` için
3 test var, **hiçbiri kill switch'i denemiyor**. Diğer 6 metodun kill switch
testi var; bu metodunki yok. Testler iddiayı doğrulamıyor, iddiayı taklit ediyor.

**Düzeltme:** satır 171'den önce `await assertWritable(deps);` + kill switch testi.

---

## Y-1 (YÜKSEK) — `MaestroPlatform`'un `runId` çözümü **200 satırlık ufukla sınırlı**: kendi projesindeki koşu görünmez oluyor

**Dosya:** `apps/bff/src/platform/read.ts:264-283` (`runOf`)

`runOf`, `runId` → kayıt eşlemesini **tek bir 200 satırlık sayfayı tarayarak**
yapıyor (`limit: PLATFORM_MAX_LIMIT, cursor: null`), sonra bulamazsa
`notFound("no_run")` atıyor. Sayfa `updatedAt` azalan sırada; yani **201. ve
sonraki koşular hiçbir zaman görülmüyor**.

**Kanıtladım** (probe testi — 250 koşu, hepsi çağıranın KENDİ projesinde):
```
L getRun run#250  THREW: no_run     ← kullanıcının kendi projesindeki koşu
L getRun run#1    SUCCEEDED         ← sanity: ufuk içindeki koşu çalışıyor
M pauseRun run#250 THREW: no_run    ← admin bile duraklatamıyor
```

**Neden yüksek:** `runOf`'a bağlı **6 metot** var — `getRun`, `getJournal`,
`setWorkMode`, `pauseRun`, `resumeRun`, `retryStep`, `notifyGateOwner`. Yani
200'den fazla koşu olan bir kurulumda:

- Bir operatör/AI **eski bir koşuyu duraklatamaz veya devam ettiremez**.
- Hata mesajı `no_run` — "yetkin yok" değil, "böyle bir koşu yok". Operatör
  koşunun silindiğini/bittiğini sanır. **Yanlış teşhise yönlendiren bir yalan.**
- 200 koşu bir banka SDLC'sinde küçük bir sayı; bu üretimde kesin isabet eder.

Ayrıca `listRuns` aynı ufku sessizce uyguluyor: **250 koşudan 200'ünü döndürdü**,
`MaestroPlatform` arayüzünde cursor olmadığı için çağıran eksiği **anlayamıyor**.
Bu, sayfalamayı özenle kuran (§6) bir pakette tutarsız: REST tarafı tavan aşımını
400 ile reddederken, MCP tarafı sessizce kırpıyor.

**Raporda yok:** §4 "limit tavanı 200'e sıkıştırılır" diyor ama bunun bir
**arama ufku** haline geldiğini ve doğruluk kaybı ürettiğini söylemiyor.

---

## Y-2 (YÜKSEK) — `apps/deploy` raporu test sayısını yanlış veriyor; bir test dosyası tabloda **hiç yok**

**Dosya:** `deploy/RAPOR.md` ("Testler" bölümü)

Rapor **"102 test"** diyor ve 6 dosyalık bir tablo veriyor. Gerçek:

```
compose-file.test.ts   34      (rapor: 37)
compose.test.ts        20      (rapor: 20)
migrate.test.ts         8      (rapor:  8)
profile.test.ts        23      (rapor: 23)
read-models.test.ts    99      (rapor: TABLODA YOK)
secret-names.test.ts    5      (rapor:  5)
users.test.ts          12      (rapor:  9)
TOTAL                 201      (rapor: 102)
```

**Neden yüksek:** Denetlenebilirlik sorunu. `read-models.test.ts` **99 test**
ile paketin en büyük test dosyası (`unbridgedReadModels`'ı doğruluyor —
denetlediğim en önemli fail-closed davranışlardan biri) ve raporun tablosunda
adı bile geçmiyor. Bir doğrulayıcı raporu okuyup "102 test" beklerken 201
buluyor; hangi sayının hangi iddiaya ait olduğu takip edilemiyor. `compose-file`
(37→34) ve `users` (9→12) da tutmuyor.

Testlerin **kendisi gerçek** — `read-models.test.ts`'i inceledim: 10 `it`, 25
`expect`, gerçek davranış doğruluyor (sır sızdırmama, model/metot adının hatada
geçmesi). Sorun testlerde değil, **raporun kodu doğru tarif etmemesinde**.

---

## O-1 (ORTA) — Dağıtılan BFF'te `bindings: []`: her Jira webhook'u sessizce düşer

**Dosya:** `apps/deploy/src/bin/bff.ts:60`

```ts
bindings: new StaticJiraProjectBindings([]),   // boş liste
```

`StaticJiraProjectBindings.resolve()` bilinmeyen projeye `null` döner
(`apps/bff/src/stores/memory.ts:111-114`) ve intake yolu bunu düşürür. Boş liste
= **hiçbir proje bağlı değil** = gelen her Jira webhook'u kabul edilip hiçbir
şey yapmadan atılır.

**Neden orta (kritik değil):** Yön doğru — fail-closed, yanlışlıkla run
başlamıyor. Ama davranış **sessiz**: operatör "Jira entegrasyonu çalışmıyor,
neden?" sorusuna cevap veren hiçbir log/hata görmez. `read` modelleri için
seçilen "adıyla reddet" kalıbı burada da uygulanmalıydı. Raporda "bindings
in-memory" deniyor ama **boş liste = tam işlevsizlik** olduğu söylenmiyor.

---

## O-2 (ORTA) — `.env.example` yanlış değişken adı belgeliyor (kendi kendini çürütüyor)

**Dosya:** `deploy/.env.example:178`

```
# ... `kv/jira#token` → MAESTRO_SECRET_KV_JIRA_TOKEN.     ← YANLIŞ (tek alt çizgi)
```

5 satır sonra, 183-187'de **aynı dosya kendini düzeltiyor**:

```
# Note the DOUBLE underscore ... `kv/jira#token` is MAESTRO_SECRET_KV_JIRA__TOKEN
# and not MAESTRO_SECRET_KV_JIRA_TOKEN. A name that differs by that one
# underscore looks set to an operator and unset to the driver.
```

**Sürücüden doğruladım** (`@maestro/secrets`'ı çağırarak, çalıştırıldı):
```
kv/jira#token   -> MAESTRO_SECRET_KV_JIRA__TOKEN
kv/llm#api-key  -> MAESTRO_SECRET_KV_LLM__API__2D_KEY
```

Doğru ad **çift** alt çizgili. Satır 178 hatalı.

**Neden önemli:** Dosyanın kendi uyarısının anlattığı tuzağa düşürüyor —
"operatöre set edilmiş, sürücüye edilmemiş görünür". `secret-names.test.ts`
compose ve `.env.example`'daki **değişken tanımlarını** doğruluyor ama bu satır
bir **yorum** olduğu için testin kapsamı dışında.

---

## D-1 (DÜŞÜK) — Temel imajlar digest ile pinlenmemiş

`deploy/compose.yaml:92,119,148` — `postgres:17-alpine`, `temporalio/auto-setup:1.25.2`,
`temporalio/ui:2.32.0`. `Dockerfile.node:21` — `node:24-bookworm-slim`.

Tarayıcı imajları için digest **zorunlu** tutulmuş (M27, `SCAN_IMAGE_*` şeması
tag'i reddediyor) ve gerekçesi rapora yazılmış: "tag hareketli hedeftir". Aynı
gerekçe `postgres:17-alpine` için de geçerli — bugünkü ile yarınki aynı binary
değil. Sürüm numaraları en azından `latest` değil; bu yüzden düşük.

## D-2 (DÜŞÜK) — Bilgi sızıntısı: `/studio/apps` proje kapsamına alınmamış

`apps/bff/src/routes/studio-catalog.ts:25-49` — `/studio/apps`, `/studio/apps/:appId`,
`/studio/apps/:appId/repo-card` yalnızca oturum istiyor, proje üyeliği istemiyor.

**Kanıtladım:** yalnızca `maestro-ugurpay` grubundaki bir `developer`,
`/studio/apps` çağırınca `["ugurpay","ugurweb"]` — yani başka projenin
uygulamasını — görüyor; `/studio/apps/ugurweb` de **200** dönüyor.

Bu **bilinçli ve belgelenmiş** bir karar (satır 21-24: "kayıt hiçbir sır
taşımaz — repo yolu zaten her PR bağlantısında"). Gerekçe savunulabilir, bu
yüzden düşük; ama `/studio/scans` "bir bulgu birinin deposundaki dosyayı ve
satırı adlandırır" diye kapsama alınmışken, `repoCard` (modül özeti, iç mimari)
kapsam dışı bırakılmış — ikisi arasındaki sınır tartışılmamış.

`/studio/knowledge` de proje kapsamına alınmamış; orada koruma **yalnızca**
`dataClass` süzgeci. `dahili` sınıflı bir belge her oturuma açık. Veri sınıfı
politikası fail-closed çalışıyor (mutasyon 1 doğruladı), ama sınıf ile proje
ayrı eksenler.

---

# Kontrol listesi (§5) — madde madde

| # | Kontrol | Sonuç |
|---|---|---|
| 1 | **Ölü yol** | Temiz. `assertHumanChannel` gerçekten silinmiş (`actor-scope.ts:54-66` yerine gerekçe yorumu var); `isHumanChannel` hâlâ `routes/killswitch.ts`+`runs.ts`'te kullanılıyor. Yazılıp çağrılmayan modül bulamadım. |
| 2 | **Fail-open** | **K-1** (kill switch restart'ta `off`) ve **K-2** (`notifyGateOwner` kill switch'i atlıyor). Açılış fail-closed'ı ise gerçek (çalıştırarak doğrulandı). |
| 3 | **Halüsinasyon entegrasyon** | Temiz. Port metotları gerçek (rapor bunu test yazarken düzeltmiş: `openPr`, `generateObject`). Compose servis adları/portları/env değişkenleri kodun beklediğiyle uyuşuyor (`temporal:7233`, `postgres:5432`, `BFF_PORT=7001`). Sır değişken adları sürücüden türetiliyor. |
| 4 | **Test gerçek mi** | 8/8 mutasyon öldürüldü. Testler totolojik değil. **Ama** `notifyGateOwner` kill switch testi yok (K-2) ve rapor test sayılarını yanlış veriyor (Y-2). |
| 5 | **ID/anahtar tutarlılığı** | Temiz. `workflowIdFor` üretiyor, `queryRunState` tüketiyor; cursor fingerprint üreten/tüketen aynı; sır anahtar kodlaması sürücüyle aynı (doğrulandı). |
| 6 | **Auth** | Guard her istekte dizinden rol/grup okuyor, pasif hesabı reddediyor (mutasyon 6 doğruladı). Proje üyeliği gerçek (mutasyon 3: 11 test). 404-vs-403 sızıntısı `runOf`'ta bilinçli kapatılmış. **Boşluk:** `/studio/apps*` ve `/studio/knowledge` proje kapsamsız (D-2, bilinçli). |
| 7 | **Spec dışına taşma** | Yok. Dondurulmuş `contracts`/`ports` değiştirilmemiş (doğruladım). Yazma uçları bilinçli olarak yapılmamış ve gerekçelendirilmiş. |

## BFF'e özel öncelikli kontroller

- **Kapı kararı yazma yüzeyi:** ✅ Temiz. 4 metot da 404; platformda kapı kapatan metot yok (18 metot listelendi).
- **`dataClass` fail-closed:** ✅ Temiz. Etiketsiz/tanınmayan → `gizli`; `acik`'e düşen yol yok (mutasyon 1: 3 test).
- **Sayfalama:** ✅ REST tarafı sağlam (tavan 400 ile reddediliyor, cursor fingerprint'e bağlı, yabancı cursor **yetki atlatmıyor** — offset 0'a düşüyor). ⚠️ MCP tarafı sessizce kırpıyor (Y-1).
- **Kill switch:** ❌ **K-2** — 7 operate metodundan 1'i atlıyor.
- **Bağlanmamış proje:** ✅ `startWorkflow`/`assignApp` `runIntake`'ten geçiyor → `intake_unbound` 409.
- **Bilgi sızıntısı:** ✅ Ham hata metni istemciye gitmiyor (`HttpError.code` makine kimliği). ⚠️ Y-1'deki `no_run` yanlış teşhise yönlendiriyor.

## Deploy'a özel öncelikli kontroller

- **M44 clean-room:** ✅ Doğrulandı.
- **Compose güvenliği:** ✅ Root yok, host network yok, docker soketi yok, `cap_drop: ALL`, `read_only`.
- **Sır yönetimi:** ✅ Compose'da düz sır yok; `.env.example`'da gerçek kimlik bilgisi yok; **4 ayrı hata yolunda parola kurtarılamadı** (kendim denedim). ⚠️ O-2 belge hatası.
- **Migration kilidi:** ✅ Advisory lock + timeout gerçek (mutasyon 8 OOM ile öldü).
- **Healthcheck:** ✅ Anlamlı — `bff` `/readyz` (Temporal+kill switch yokluyor), `postgres` `pg_isready -U -d`, `temporal` `tctl cluster health`. `exit 0` yok. Bağımlılık sırası gerçek (`service_healthy` + `service_completed_successfully`).
- **Fail-closed açılış:** ✅ Üç giriş noktası da **exit 1** (çalıştırarak doğrulandı).
- **Reddedilen bağlantılar:** ✅ `unbridgedScanRunner` reject ediyor, `unbridgedReadModels` 12 modelin her metodunu reject ediyor (99 test), worker eksik store'ları sayarak exit 1 (**çalıştırarak doğrulandı** — sessizce boş dönmüyor).
- **Imaj digest'leri:** ⚠️ D-1 — tarayıcılar pinli, temel imajlar değil.

---

## Geçici değişiklikler — hepsi geri alındı

9 mutasyon uygulandı ve **hepsi geri alındı**; ayrıca 4 geçici probe test dosyası
(`apps/bff/probe*.test.ts`, `apps/deploy/enc.test.ts`) oluşturulup **silindi**.
Son durum: `git status --short -- apps/ packages/ deploy/` → **boş**;
`apps/bff` 336/336 yeşil. Hiçbir dosya kalıcı değiştirilmedi, commit yapılmadı.

*(Bu rapor dosyası tek yazma iznimdi.)*

---

## Kapatma için gereken

**`apps/bff`:**
1. **K-2** — `notifyGateOwner`'a `assertWritable` ekle + kill switch testi yaz.
2. **Y-1** — `runOf`'u `runId` ile doğrudan arayan bir okuma modeline çevir (200 satırlık tarama yerine); `listRuns`'ın sessiz kırpmasını en azından logla.

**`apps/deploy`:**
3. **K-1** — `killSwitch` ve `params` ya kalıcı olsun ya da `unbridgedReadModels()` kalıbıyla reddetsin; `off` varsayma.
4. **Y-2** — `RAPOR.md`'nin test tablosunu gerçek sayılarla düzelt, `read-models.test.ts`'i ekle.
5. **O-1/O-2/D-1** — `bindings: []`'i sessiz düşürme yerine reddet; `.env.example:178`'i düzelt; temel imajları digest'le.
