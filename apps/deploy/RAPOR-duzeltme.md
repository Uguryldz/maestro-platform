# DÜZELTME RAPORU — `apps/bff` + `apps/deploy`

**Ajan:** düzeltme ajanı · **Tarih:** 2026-08-09
**Girdi:** `apps/deploy/DOGRULAMA.md` (bağımsız doğrulayıcı; her iki pakete de **KALDI**)
**Çalışma yeri:** worktree `agent-a63d50fc4ba753787`, branch `main`

## Özet

| Bulgu | Ağırlık | Durum |
|---|---|---|
| K-1 kill switch yeniden başlatmada kendiliğinden `off` | KRİTİK | **Kapatıldı** (üretimde açılışı reddederek) |
| K-2 `notifyGateOwner` kill switch'i atlıyor | KRİTİK | **Kapatıldı** (yapısal kapı + türetilmiş test) |
| Y-1 `runId` çözümü 200 satırlık ufukla sınırlı | YÜKSEK | **Kapatıldı** (doğrudan arama) |
| Y-2 rapor test sayısını yanlış veriyor | YÜKSEK | **Kapatıldı** |
| O-1 `bindings: []` sessiz düşürme | ORTA | **Kapatıldı** (Prisma destekli store) |
| O-2 `.env.example:178` yanlış değişken adı | ORTA | **Kapatıldı** (+ regresyonu önleyen test) |
| D-1 temel imajlar digest ile pinlenmemiş | DÜŞÜK | **Kısmen** — digest ile pinlenebilir yapıldı, gerekçe aşağıda |
| D-2 `/studio/apps*` proje kapsamsız | DÜŞÜK | **Kapatılmadı** — gerekçe aşağıda |

`pnpm run gate` → **exit 0**, 52/52 turbo görevi, repo genelinde **3467 test**.
`apps/bff` 336 → **361**, `apps/deploy` 201 → **230**.

---

## K-1 — Acil durum freni kendiliğinden bırakılıyordu

### Karar: kalıcı store yazmak yerine **üretim profilinde açılışı reddet**

Üç seçenek vardı ve ilkini eleyen somut bir sebep var: `packages/db`
şemasında kill switch'in **karşılığı yok**. `KILL_SWITCH` yalnızca bir
`AuditAction` değeri (`schema.prisma:144`); durumu tutan bir model yok. Kalıcı
bir store yazmak yeni bir model + migration + Prisma store demekti, yani
`packages/db`'nin alanına girmek — üstelik bu düzeltme dalgasının kapsamı
`apps/bff` + `apps/deploy`.

İkinci seçenek — **açılışta reddetmek** — hem kapsam içinde hem de bu paketin
zaten savunduğu ilke. `unbridgedReadModels()` tam olarak bunu yapıyor: bağlanmamış
bir okuma modeli boş sayfa dönmüyor, **adıyla reddediyor**, çünkü "hiçbir şey
bulunamadı" ile "hiçbir şey bağlı değil" ekranda aynı görünüyor. Doğrulayıcının
işaret ettiği çelişki tam buydu: aynı dosya `read` için bu özeni gösterip kill
switch'i sessizce `off`'a düşürüyordu. Kural artık kill switch için de aynı — ve
daha katısı, çünkü yalan söyleyen bir okuma modeli bir ekranı yanlış yapar,
yalan söyleyen bir kill switch durdurulmuş sanılan platformu çalıştırmaya devam
ettirir.

**Uygulama** (`apps/deploy/src/stores/durability.ts`, `bin/bff.ts`):

- `assertStoresDurable(profile, stores)` — `prod` profilinde kalıcı olmayan bir
  kill switch ile **soket açılmadan** `DurabilityError` fırlatır. Mesaj store'u,
  `restart: unless-stopped` bağlantısını ve çözümü adıyla söyler.
- `dev` profilinde izin verilir ama **açıkça** belirtilir: `volatileStoreWarning`
  her süreç-yerel store'u ve yeniden başlatmanın neye mal olacağını basar.
- Yalnızca `killSwitch` ölümcül (`FATAL_IF_VOLATILE`). `params` uyarı seviyesinde
  çünkü kaybı telafi edilebilir (varsayılanlar var, öneri tekrar açılabilir);
  kill switch'in kaybı telafi edilemez çünkü kimseye telafi gerektiği
  söylenmiyor. Her volatile store'da reddeden bir kapı, açılabilmek için
  kapatılması gereken bir kapı olurdu — kapılar böyle ölür.

### Çalıştırma kanıtı

```
profile=prod: REFUSED -> DurabilityError
  profile "prod": refusing to start — killSwitch (in-memory — the emergency
  brake reverts to `off` with nobody told (M58)). ...
profile=dev: BOOTED (no refusal)
--- what dev prints instead ---
[maestro] WARNING: these stores are process-local and do NOT survive a restart:
    killSwitch   → the emergency brake reverts to `off` with nobody told (M58)
    sessions     → every logged-in user is signed out
[maestro] the kill switch among them means a restart releases the brake — dev profile only
--- and once killSwitch is durable ---
profile=prod: BOOTED
```

### Mutasyon kanıtı

`assertStoresDurable`'ın reddi devre dışı (`if (true) return;`) →
**3 test kırıldı** (`refuses a prod boot…`, `names the store…`,
`still refuses when the fatal store is listed among harmless ones`). Geri alındı.

Ayrıca `durability.test.ts` reddin **gerekçesini** de doğruluyor, iddia
etmiyor: `InMemoryKillSwitchStore`'a `all` yazılıyor, yeni bir örnek
kuruluyor, `off` döndüğü **gösteriliyor**.

---

## K-2 — `notifyGateOwner` kill switch'i atlıyordu

### Karar: tek tek `assertWritable` yerine **hepsini saran bir kapı**

Doğrulayıcının en sert tespiti buydu: `RAPOR-dalga4.md` §5 riski tam adıyla
yazmış ("unutan metot olay anında çalışan metot olurdu") ve tam o hatayı
yapmıştı. Aynı kalıba bir `assertWritable` daha eklemek, aynı hatanın sekizinci
metotta tekrarlanmasını beklemek olurdu.

**Uygulama** (`apps/bff/src/platform/operate.ts`):

- `KILL_SWITCHED: Record<keyof OperateHalf, true>` — kapının okuduğu liste.
- `killSwitched(deps, half)` her operate metodunu sarar; `assertWritable`
  **gövdeden önce** çalışır, yani durdurulmuş platform bir store okumasından
  fazlasına mal olmaz: oturum aramaz, okuma modeline gitmez, dışarı **hiç**
  çıkmaz.
- Altı metottaki tek tek `assertWritable` çağrıları kaldırıldı — kapı tek
  çağrı noktası.
- `runOf` kendi modülüne alındı (`platform/run-lookup.ts`), `read.ts` 300 satır
  sınırının altında kaldı.

**Neden unutulamaz:** `Record<keyof OperateHalf, true>` sekizinci bir metot
eklendiğinde derlenmez.

### Mutasyon kanıtı 1 — kapıdan bir metodu çıkar

`killSwitched`'de `notifyGateOwner` sarmalanmadan geçirildi →
**2 test kırıldı** (`level=all > refuses notifyGateOwner`,
`level=intake_only > refuses notifyGateOwner`). Geri alındı.

### Mutasyon kanıtı 2 — sekizinci metot ekle

`OperateHalf`'a `proposeParamChange` eklendi → `pnpm typecheck` **exit 2**,
üç ayrı yerde:

```
src/platform/operate.ts(55,7):  Property 'proposeParamChange' is missing in type
  '{...}' but required in type 'Record<"proposeParamChange" | ...>'
src/platform/operate.ts(99,3):  ... but required in type 'OperateHalf'
test/platform-killswitch.test.ts(41,7): ... but required in type 'Record<...>'
```

Yani yeni bir operate metodu **kapıya**, **gövdelere** ve **teste** aynı anda
eklenmeden derlenmiyor. Geri alındı.

### Çalıştırma kanıtı — doğrulayıcının senaryosu tekrar

```
killswitch: {"level":"all","actor":"yonetici@ugurbank.local","reason":"incident",...}
jira comments before: 0
notifyGateOwner with killswitch=all -> REFUSED: status=409 code=kill_switch
jira comments after: 0
gated methods: startWorkflow, assignApp, setWorkMode, pauseRun, resumeRun,
               retryStep, notifyGateOwner
last comment on UGURPAY-501: undefined
```

Doğrulayıcı aynı senaryoda `SUCCEEDED` ve `0 → 1` yorum görmüştü. (Bu probe
geçiciydi ve silindi; kalıcı karşılığı `platform-killswitch.test.ts`.)

### Yeni test — `apps/bff/test/platform-killswitch.test.ts` (17 test)

Vakalar **türetiliyor**, elle listelenmiyor: `OPERATE_METHODS` üzerinden
`level=all` ve `level=intake_only` için her metot ayrı ayrı deneniyor. `CALLS`
tablosu `Record<keyof OperateHalf, …>` tipli, yani yeni bir metot testi de
derlenmez hâle getiriyor. Ayrıca:

- Reddin **etkisiz** olduğu (sinyal yok, Jira yorumu yok) doğrulanıyor.
- Switch **kapalıyken** aynı çağrıların geçtiği doğrulanıyor — yoksa "her şeyi
  reddet" de bu testi geçerdi, ki o durdurulmuş platformdur.
- Kontrolün gövdeden **önce** çalıştığı: var olmayan bir `runId` ile `pauseRun`
  404 değil **409** dönüyor.

---

## Y-1 — `runId` çözümü 200 satırlık ufukla sınırlıydı

### Karar: okuma modeline değil, **motora** doğrudan arama ekle

`runId`'yi mint eden Temporal. `RunCatalog` bilet anahtarıyla kayıtlı ve
`RunRecord`'da `runId` alanı yok — oraya eklemek, motorun ürettiği bir kimliği
bir okuma modeline kopyalamak olurdu. `RunGateway` (`apps/bff/src/gateway.ts`,
donmuş değil) doğru yer: `findByRunId(runId): Promise<RunSummary | null>`.

**Uygulama:**

- `apps/bff/src/gateway.ts` — `findByRunId` arayüze eklendi, gerekçesi yazıldı.
- `apps/bff/src/platform/run-lookup.ts` — `runOf` artık tek bir kesin arama
  yapıyor, sayfa taramıyor. Proje kontrolü **korunuyor**: ucuz arama yetki
  kontrolünü atlamıyor.
- `apps/deploy/src/temporal-gateway.ts` — `RunId='...'` görünürlük sorgusu.
  Sunucu değerlendiriyor, yani maliyet de doğruluk da namespace'in büyüklüğünden
  bağımsız.
- `apps/bff/test/fakes.ts` — fake'te de **sınırsız** arama; yalnızca ilk N
  kaydı tarayan bir fake hatayı test ikizinden geri sokardı.

**Ek bulgu (raporda yoktu):** `listRuns`'ın `ticketKey` süzgeci de **sayfadan
sonra** uygulanıyordu, yani `ticketKey` fiilen "bu bilet, eğer son 200 koşu
arasındaysa" demekti. O da doğrudan aramaya çevrildi.

**Enjeksiyon yüzeyi:** `runId` bir MCP tool argümanından geliyor ve görünürlük
sorgusuna interpolate ediliyor. Kaçırmak yerine Temporal'ın gerçekten ürettiği
şekle (UUID) karşı doğrulanıyor; uymayan bir değer sunucunun mint edemeyeceği
bir kimliktir, dolayısıyla dürüst cevap "böyle bir koşu yok" ve tırnaklanacak
bir şey kalmıyor (`RUN_ID` regexi).

### Hata mesajı

Doğrulayıcı haklıydı: `no_run` "yetkin yok" ile "böyle bir koşu yok"u
birleştiriyor ve operatörü koşunun silindiği teşhisine itiyor. Belirsizlik bir
**güvenlik özelliği** — ayırt edilebilir bir 404 bunu run-id kehanetine
çevirirdi — ama tek başına yanıltıyor. Çözüm belirsizliği korumak, yanlış
kesinliği kaldırmak: `NO_RUN_NOTE = "no such run, or not in a project you can
see"`. Hangi ikisinden biri olduğunu söylüyor, hangisinin olduğunu söylemiyor.

### Mutasyon kanıtı

`runOf` eski sayfa taramasına geri döndürüldü → **4 test kırıldı**
(`reads a run … past the horizon`, `lets an operator pause …`,
`lets an admin resume and retry …`, `serves every runOf-backed method …`).
Geçen 4 test ise koruma bantları: yabancı proje reddi, belirsiz refüze,
yakın koşu. Geri alındı.

### Yeni test — `apps/bff/test/platform-runid.test.ts` (8 test)

250 koşu (`PLATFORM_MAX_LIMIT + 50`), hepsi çağıranın **kendi** projesinde,
`updatedAt` azalan. İlk test dosyanın önermesini kanıtlıyor: tek sayfa
gerçekten 200 satır dönüyor ve uzak koşuyu **içermiyor**. Sonra `getRun`,
`getJournal`, `setWorkMode`, `pauseRun`, `resumeRun`, `retryStep`,
`notifyGateOwner` uzak koşuda çalışıyor; sinyalin **doğru** workflow'a gittiği
(en yakınına değil) doğrulanıyor; yabancı proje hâlâ reddediliyor ve refüze
hâlâ ayırt edilemez.

### Kapatılamayan kısım → **ARAYÜZ İSTEĞİ** (aşağıda)

`listRuns` hâlâ sessizce kırpıyor. Dönüş tipi `readonly WorkflowRunState[]` ve
cursor alanı yok — bu `MaestroPlatform`'da, **donmuş**. Kesin anahtarla yapılan
her şey (lookup) düzeltildi; sayfalama düzeltilemez. `PLATFORM_MAX_LIMIT`'in
üstüne bu ayrım yazıldı: kırpılmış bir **liste** daha küçük bir cevaptır,
kırpılmış bir **arama** yanlış bir cevaptı.

---

## Y-2 — Rapor test sayısını yanlış veriyordu

`deploy/RAPOR.md` "102 test" diyordu; gerçek 201'di ve en büyük dosya
(`read-models.test.ts`, 99 test) tabloda **hiç yoktu**. `compose-file` (37→34)
ve `users` (9→12) da tutmuyordu.

Tablo `pnpm test` çıktısından birebir yeniden yazıldı (şimdi **230**, düzeltme
dalgasının 29 testi dâhil), `read-models.test.ts` eklendi ve neyi doğruladığı
yazıldı. Hatanın kendisi de rapora **not olarak** bırakıldı — bir denetçinin
"102 bekleyip 201 bulma" deneyimini tekrar yaşamaması için düzeltmenin görünür
olması gerekiyor.

Aynı bölümdeki iki sayı daha yuvarlanmıştı ve düzeltildi: "50/50 turbo görevi"
→ **52/52**, "repo genelinde 3000 test" → **3467** (ikisi de çalıştırılarak
alındı).

`### BFF'in bazı store'ları hâlâ in-memory` bölümü de yeniden yazıldı: eski hâli
oturum kaybı ile acil durum freninin bırakılmasını aynı listede eşit ağırlıkta
sunuyordu — doğrulayıcının K-1'de işaret ettiği tam da bu sunum hatasıydı.

---

## O-1 — `bindings: []` her Jira webhook'unu sessizce düşürüyordu

### Karar: reddetmek değil, **gerçek tabloyu okumak**

Burada `unbridgedReadModels` kalıbını uygulamak yanlış olurdu, çünkü bağlamaların
şemada **karşılığı var**: `JiraProjectBinding` modeli mevcut. Reddeden bir store
yazmak, var olan bir tabloyu okumamak için gerekçe üretmek olurdu.

`apps/deploy/src/stores/bindings.ts` — `PrismaJiraProjectBindings`,
`PrismaUserDirectory` ile aynı kalıpta (yapısal delegate, Prisma `apps/bff`'e
sızmıyor). M102 kuralı **korunuyor**: satırı olmayan proje hâlâ `null` ve hâlâ
düşürülüyor — ama artık bu "kimse bu projeyi bağlamamış" demek, "deployment
store'u kablolamayı unutmuş" değil.

**İki daraltma, ikisi de az-yapan tarafa düşüyor:**

- `BindingStateE`'nin beş değeri `active: boolean`'a indiriliyor ve **yalnızca**
  `active` canlı sayılıyor. `dry_run` özellikle değil: prova bağlaması tam da
  koşu başlamadan ne olacağını izlemek için var; canlı saymak provayı bankanın
  biletinde gerçek işe çevirirdi.
- `TriggerModeE` (`auto`/`label`/`command`) iki değerli `triggerMode`'a: yalnızca
  `auto` sorulmadan koşu başlatır. **Tanınmayan** bir değer de `opt_in`'e düşer —
  anlaşılmayan bir tetikleyici "sorulmayı bekle"ye düşmeli, "her şeye koşu
  başlat"a değil.
- `defaultsJson` bir JSON sütunu: okunamayan `mode` → `human_only`, okunamayan
  `dataClass` → `gizli` (etiketsiz belge kalıbının aynısı, M18/M63). Bozuk bir
  sütun bir AI'ya serbestlik veren şey olmamalı.

**Test:** `apps/deploy/test/bindings.test.ts` (17 test) — daraltmaların her biri,
ve literal sözlüklerin kontratın **kendi** enum'larıyla eşleşmesi
(`WorkMode.options` / `DataClass.options` üzerinden), `profile.test.ts`'in
sürücü kimliklerine uyguladığı disiplinin aynısı.

---

## O-2 — `.env.example` kendi kendini çürütüyordu

Satır 178 `kv/jira#token → MAESTRO_SECRET_KV_JIRA_TOKEN` diyordu (tek alt
çizgi), beş satır altında aynı dosya **çift** alt çizgi olduğunu ve bir
underscore farkın "operatöre set edilmiş, sürücüye edilmemiş göründüğünü"
açıklıyordu. Satır düzeltildi.

**Asıl mesele regresyondu:** doğrulayıcı bu satırın `secret-names.test.ts`'in
kapsamı dışında kaldığını, çünkü testlerin yalnızca **değişken atamalarına**
baktığını, hatanın ise **yorumda** olduğunu tespit etmişti. İki test eklendi:

- Dosyadaki **her** `MAESTRO_SECRET_*` token'ı — atama ya da yorum — sürücünün
  gerçekten türeteceği bir ad olmalı. Tek istisna açıkça olumsuzlanan
  karşı-örnek, çünkü uyarısını adlandıramayan bir uyarı daha zayıf bir uyarıdır.
- Karşı-örneğin **varlığını** koruyan bir test: çift alt çizgiyi görünür kılan
  şey o. Kaybolursa yukarıdaki kural sessizce kolaylaşır.

Not metni tek satıra sığacak şekilde yeniden akıtıldı (olumsuzlama ile
karşı-örnek aynı satırda olmalı ki satır-yerel kontrol görebilsin).

**Mutasyon kanıtı:** özgün hata (tek alt çizgi) geri kondu → **2 test kırıldı**.
Geri alındı.

---

## D-1 — Temel imajlar (kısmen)

`postgres:17-alpine`, `temporalio/auto-setup:1.25.2`, `temporalio/ui:2.32.0`
artık `${POSTGRES_IMAGE:-…}` / `${TEMPORAL_IMAGE:-…}` / `${TEMPORAL_UI_IMAGE:-…}`
üzerinden **digest ile pinlenebilir**; `.env.example`'a nasıl çözüleceğiyle
(`docker buildx imagetools inspect`) birlikte yazıldı. `NODE_IMAGE` zaten
override edilebilir bir ARG'dı.

**Neden varsayılan hâlâ tag:** bu ortamda gerçek bir digest **çözülemiyor**
(imaj indirme yok). Uydurulmuş bir digest commit etmek tag'den kötü olurdu —
hiç pull etmez, yani deployment'ı bugün kırar. Tarayıcılarla arasındaki fark da
gerçek ve raporda duruyor: tarayıcı çıktısı bir güvenlik kapısını **kapatan
kanıt**, bu üçü ise veri ve motor; aynı argüman daha az güçle geçerli.
`docker compose config` → **exit 0** (değişiklikten sonra doğrulandı).

---

## Kapatılmayanlar

### D-2 — `/studio/apps*` ve `/studio/knowledge` proje kapsamsız

**Kapatılmadı.** Bu **bilinçli ve belgelenmiş** bir ürün kararı
(`studio-catalog.ts:20-24`): kayıt hiçbir sır taşımıyor, repo yolu zaten her PR
bağlantısında, ve M100 etki analizi bir analistin **başka** uygulamaların repo
kartlarını görmesini gerektiriyor — çapraz-uygulama etkisini göremeyen bir
analist onu değerlendiremez. Doğrulayıcı da bunu DÜŞÜK verdi ve gerekçeyi
"savunulabilir" buldu.

Bunu kapsama almak, bir düzeltme ajanının tek başına vereceği bir karar değil:
M100'ün analiz akışını daraltır. Doğrulayıcının asıl işaret ettiği şey sınırın
**tartışılmamış** olması (`/studio/scans` kapsama alınmışken `repoCard`
alınmamış) — bu bir ürün kararı olarak sahibine bırakılıyor.

### `listRuns`'ın sessiz kırpması

Donmuş arayüz. Aşağıdaki ARAYÜZ İSTEĞİ'ne bakınız.

### `params` / `sessions` / `audit` kalıcılığı

Şemada karşılıkları yok; kalıcı store yazmak `packages/db` alanına girer.
K-1'in kapsamı dışında bırakıldı **ama artık sessiz değil**: üçü de
`VOLATILE_STORES`'ta adıyla duruyor ve `dev` açılışında ne kaybedilecekleriyle
birlikte basılıyorlar. `audit` için `deploy/RAPOR.md` zaten bir ARAYÜZ İSTEĞİ
taşıyor (`AuditStore`'un Postgres implementasyonu yok).

---

## ARAYÜZ İSTEKLERİ

### `MaestroPlatform.listRuns` sayfalanamıyor (Y-1'in kapatılamayan yarısı)

**Paket:** `packages/mcp-servers` (`servers/maestro-platform.ts:132-140`) —
**donmuş**, dokunulmadı.

```ts
listRuns(actingUser, filter): Promise<readonly WorkflowRunState[]>;
```

Dönüş bir dizi; cursor alanı yok. `PLATFORM_MAX_LIMIT`'ten fazla koşu olan bir
kurulumda çağıran ilk 200'ü alır ve **daha fazlası olduğunu anlayamaz**. REST
tarafı tavan aşımını 400 ile reddederken MCP tarafı sessizce kırpıyor — aynı
pakette iki farklı cevap.

**İstenen:** ya bir sayfa şekli (`{ items, nextCursor }`, `Page<T>` ile aynı
kalıp), ya da en azından kırpıldığını söyleyen bir alan. `getRun`/`pauseRun`
gibi **kesin anahtarla** çalışan her şey bu dalgada doğrudan aramaya çevrildi;
geriye yalnızca gerçek sayfalama kaldı ve o donmuş şeklin içinde.

**Geçici durum:** kırpma `PLATFORM_MAX_LIMIT`'in dokümantasyonunda adıyla
yazılı, böylece bilinen bir sınır olarak duruyor.

---

## Değişen dosyalar

**`apps/bff`**
- `src/platform/operate.ts` — kill switch kapısı (K-2)
- `src/platform/run-lookup.ts` — **yeni**, `runOf` + `NO_RUN_NOTE` (Y-1)
- `src/platform/read.ts` — `runOf` çıkarıldı, `ticketKey` doğrudan arama (Y-1)
- `src/platform/index.ts` — export'lar
- `src/gateway.ts` — `findByRunId` (Y-1)
- `test/fakes.ts` — fake `findByRunId`
- `test/platform-killswitch.test.ts` — **yeni**, 17 test (K-2)
- `test/platform-runid.test.ts` — **yeni**, 8 test (Y-1)

**`apps/deploy`**
- `src/stores/durability.ts` — **yeni** (K-1)
- `src/stores/bindings.ts` — **yeni** (O-1)
- `src/bin/bff.ts` — kapı + Prisma bağlamaları (K-1, O-1)
- `src/temporal-gateway.ts` — `findByRunId` + `RUN_ID` (Y-1)
- `test/durability.test.ts` — **yeni**, 10 test (K-1)
- `test/bindings.test.ts` — **yeni**, 17 test (O-1)
- `test/secret-names.test.ts` — yorum-kapsamlı iki test (O-2)

**`deploy/`**
- `.env.example` — O-2 düzeltmesi, D-1 imaj değişkenleri
- `compose.yaml` — D-1 pinlenebilir imajlar
- `RAPOR.md` — Y-2 test tablosu + store kalıcılığı bölümü

Dondurulmuş `packages/contracts` ve `packages/ports` **değiştirilmedi**.
`apps/studio` **elle sürülmedi** (paralel ajan).
