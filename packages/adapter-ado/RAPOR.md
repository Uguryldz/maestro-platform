# RAPOR — `@maestro/adapter-ado`

Dalga 1 paketi: ADO çift-mod adaptörü (`ScmPort` + `CiPort` sürücüleri, M11-M13, M48/M49).
Yalnız `packages/adapter-ado/` altına dokunuldu; `contracts` ve `ports` **okundu, değiştirilmedi**.

> **Durum:** bağımsız doğrulama "KOŞULLU GEÇTİ" verdi; §0'daki bulgular bu turda kapatıldı.
> Testler **10 dosya / 120 test yeşil** (önceki tur: 7 dosya / 80 test).

## 0. Doğrulama bulguları — kapatma turu

### K1 · CI kapısı sahte build ile geçirilebiliyordu (KRİTİK) — KAPANDI

Eskiden tek kapı `eventType === "build.complete"` + triggerInfo'dan PR/ticket çıkarımıydı: elle
kuyruğa atılmış "her zaman yeşil" bir pipeline ya da başka bir projedeki build, branch policy hiç
koşmadan 10b kapısını geçiyordu.

Yapılan:
- `schemas.ts` → `BuildCompleteResource`'a `reason`, `definition.id`, `project.name`,
  `repository.name` eklendi. Şemada **opsiyonel** (yabancı payload şema hatasıyla patlamasın),
  kapıda **zorunlu** (alan yoksa olay yok sayılır) — fail-closed.
- `config.ts` → `ci.prValidationBuilds`: `{project, repository, definitionId}` üçlülerinden oluşan
  **allow-list**. `.min(1)` — boş liste "hepsine izin ver" değil, **yapılandırma hatası**.
  `parseBuildCompleteEvent` boş listeyle çağrılırsa da `AdoConfigError` atar (ikinci savunma hattı).
- `ci.ts` → provenance kapısı: `reason === "pullRequest"` **ve** proje/repo/definition allow-list'te.
  Definition id yalnız proje içinde tekil olduğu için anahtar üçlü; sadece definition id ile eşleşme
  başka projenin pipeline'ının bu PR adına konuşmasına izin verirdi. Proje/repo karşılaştırması
  ADO'daki gibi büyük/küçük harf duyarsız, definition id birebir.
- `project`/`repository`/`definitionId` ayrıştırma sonucunda taşınıyor: sürücünün kendi dönüş tipi
  `AdoBuildEvent { signal, project, repository, definitionId }`. `CiResultSignal` **donuk**, ona
  alan eklenmedi; porttan yalnız `signal` geçiyor, provenance'ı uç (BFF) korelasyon/audit için alır.
  Orkestratöre kalan karar: bkz. §5.2.

Kanıt (`test/ci.test.ts` → "build provenance gate (K1: no forged green)"):
`reason` = manual/individualCI/schedule/batchedCI/eksik → `null` (+ aynı payload `pullRequest` ile
sinyal üretiyor kontrolü) · allow-list dışı definition (99) ve definition alanı yok → `null` ·
başka proje (`UgurSandbox`), başka repo (`ugurpay-fork`), **çapraz eşleşme** (UgurWeb'in
definition 33'ü UgurPay payload'ında) → `null` · proje/repo alanları eksik → `null` ·
boş allow-list → `AdoConfigError`. Ayrıca provenance'ın taşındığı ayrı test.

### K3 · `getPrStatus` aktif PR için sahte merge SHA döndürüyordu (KRİTİK) — KAPANDI

ADO `lastMergeCommit`'i kaynak dal her değiştiğinde **önizleme merge**'i ile doldurur; PR
tamamlanmadan da doludur. Sürücü bunu doğrudan `mergeSha` yapıyordu ve **mevcut test yanlış
davranışı çiviliyordu**.

Yapılan: `scm.ts` → `mergeSha` yalnız `state === "completed"` iken okunur; diğer tüm durumlarda
`null`. Bozuk commit id kontrolü (`AdoResponseError`) korundu ama artık yalnız completed PR'da
anlamlı. Kod yorumu mekanizmayı açıklıyor.

Kanıt (`test/scm.test.ts` → "AdoScmDriver.getPrStatus merge sha (K3)"): `pr-get-active` fikstürü
**`lastMergeCommit` dolu bırakıldı** (gerçekçi) ama beklenti `mergeSha: null`; test ayrıca
fikstürde alanın gerçekten dolu olduğunu assert ediyor — asıl kanıt bu. draft → `null` ·
abandoned → `null` (merge commit'i elle eklenmiş varyantla birlikte) · completed → SHA dolu.

### O1 · Service Hook kimlik doğrulaması hiçbir yerden çağrılmıyordu — KAPANDI

`assertServiceHookAuth` temizdi ama ölü yoldu; `AdoConfig`'de sır için alan bile yoktu.

Yapılan (port imzasına **dokunulmadan**):
- `config.ts` → **zorunlu** `ci` bloğu: `webhookSecretRef` (NonEmpty), `webhookUsername`
  (varsayılan `""` — ADO boş kullanıcı adına izin verir), `prValidationBuilds`.
  Sırsız/allow-list'siz konfig hiç parse olmaz → sürücü kaydı hata verir.
- `register.ts` → `createAdoCiDriver(config, deps)` sırrı sürücüye bağlar
  (`deps.resolveToken(config.ci.webhookSecretRef)`; `resolveToken` = SecretPort.get, yeni dep yok).
  Sır **her istekte** çözülür → rotasyon anında etkili.
- `ci.ts` → sürücü doğrulanmamış gövdeyi ayrıştırmayı reddediyor:
  - `parseAuthenticatedBuildEvent(headers, rawBody)` — önce `assertServiceHookAuth`, sonra ayrıştırma.
  - `parseBuildEvent(rawBody)` (CiPort) **bunun üstüne oturuyor**: `rawBody` bir
    `AdoWebhookRequest` (`{ headers, body }`) olmak zorunda; çıplak Service Hook gövdesi
    `AdoWebhookAuthError("missing")` ile reddediliyor. "Başlık yok" asla "kimlik doğrulama
    gerekmiyor" anlamına gelmiyor. Sarmalayıcıyı BFF **gerçek HTTP başlıklarından** kurmalı,
    gövdenin içindeki alanlardan değil.

Kanıt (`test/ci-auth.test.ts`, 9 test): çıplak gövde/`null`/`body` alanı olmayan sarmalayıcı →
`AdoWebhookAuthError` · yanlış sır, yanlış kullanıcı adı, başlık yok, `Bearer` → sırasıyla
`mismatch/mismatch/missing/malformed` · **yanlış sırla gelen bozuk gövde parser'a hiç ulaşmıyor**
(auth hatası, `AdoResponseError` değil) · sır boşsa `AdoConfigError` · başlık adı büyük/küçük harf
duyarsız + tekrarlı başlıkta ilk değer · her istekte sır yeniden çözülüyor.
Ayrıca `test/register.test.ts` → "wires the webhook secret into the ci driver it builds (O1)":
registry'den çözülen sürücü konfigdeki sırla **gerçekten** doğruluyor.

### O5 · `getPushCredential` M31'in kısa ömürlülüğünü zorlamıyordu — KAPANDI

10 yıllık TTL kabul ediliyor, `expiresAt: 2020-01-01` (çoktan dolmuş) kimlik olduğu gibi dönüyordu.

Yapılan (`src/credential.ts` — scm.ts 300 satır tavanını aşmasın diye ayrı dosya):
- `maxPushTtlSeconds` yapılandırmadan gelir: varsayılan **3600 sn (1 saat)**, mutlak tavan
  **86 400 sn** (konfig bunun üstünü isteyemez). `createAdoScmDriver` konfigdeki değeri sürücüye bağlar.
- İstek tarafı: `ttlSeconds > tavan` → `AdoResponseError`, **issuer hiç çağrılmadan**.
- Dönüş tarafı: `expiresAt` ISO olmalı, `expiresAt > now` olmalı, ve
  `expiresAt - now <= ttlSeconds + 60 sn` (saat kayması toleransı) olmalı; ihlalde hata.
- Saat enjekte edilebilir (`now?: () => number`) — testler duvar saatinden bağımsız.

Kanıt (`test/scm-credential.test.ts`, 10 test): 10 yıllık TTL → `/ceiling/` · tavan+1 red, tavan
kabul · **tavan aşımında issuer çağrı sayısı 0** · konfigden düşük tavan (300 sn) · `2020-01-01`
→ `/already-expired/` · tam şimdi dolan → red · 60 sn için 1 günlük kimlik → `/outlives its 60s ttl/` ·
30 sn kayma kabul, 61 sn kayma red. `register.test.ts` konfigdeki tavanın sürücüye bağlandığını
uçtan uca kanıtlıyor.

### O6 · `baseUrl` https'e zorlanmıyordu — KAPANDI

`z.url()` `ftp:`/`javascript:` kabul ediyordu; `http://` ile PAT basic auth başlığında düz metin
ağa çıkıyordu.

Yapılan (`config.ts`): protokol açıkça kontrol ediliyor (desen değil, `URL().protocol`).
`https:` zorunlu; tek istisna **açıkça** `allowInsecureHttp: true` verilmiş `http:` (yalnız yerel
geliştirme). Varsayılan `false`. Opt-in yalnız `http:`'yi açar — `ftp:`/`javascript:`/`file:` her
durumda reddedilir. **Konsola hiçbir şey yazılmıyor** (log yolu yok); ihlal bir konfig hatası
olarak patlıyor, uyarı olarak geçilmiyor.

Kanıt (`test/config.test.ts` → "AdoConfig transport security (O6)"): http red (mesajda
`baseUrl … https`) · `javascript:`/`ftp:`/`file:` red · Services tarafında da http red ·
`allowInsecureHttp` ile http kabul + aynı opt-in'le `ftp:` yine red · varsayılan `false`.

### Test kalitesi — DÜZELTİLDİ

- `register.test.ts` tautolojik `instanceof AdoCiDriver` assert'i kaldırıldı; yerine sürücünün
  konfigdeki sırla gerçekten doğrulayıp doğrulamadığını sınayan davranış testi kondu (yukarıda).
- `ci.test.ts`'deki "falls back to the merge ref…" testi davranışın tersini anlatıyordu; adı
  "returns null when the merge ref is the only ref and carries no ticket key" oldu.
- `config.ts`'deki "Server 2022 does not serve the 7.x surface" yorumu **olgusal olarak yanlıştı**
  (MS 7.0/7.1 monikerlerini Server 2022 için de yayımlıyor). Seçim (Server 6.0 / Services 7.1)
  korundu, gerekçe düzeltildi: sürüm bir **kurulum olgusu**, çağrı yerinde tahmin edilmez; her mod
  için adaptörün okuduğu tüm alanları taşıyan en düşük sürüm pinlenir, kurulum başına override var.
- `event-build-complete-no-ticket.json` fikstürüne `definition` eklendi ki testin `null` dönüşü
  gerçekten **ticket key kapısından** kaynaklansın, provenance kapısından değil.

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/config.ts` | Zod'lu sürücü konfigü (`mode: server \| services`), **api-version tablosu** (Server `6.0` / Services `7.1`, opsiyonel override), mod-bazlı `_apis` kök URL üretimi, **https zorunluluğu + `allowInsecureHttp`** (O6), **zorunlu `ci` bloğu** (webhook sırrı + PR-validation allow-list, K1/O1), **`maxPushTtlSeconds` tavanı** (O5) |
| `src/client.ts` | `AdoClient` — çift-mod URL, PAT basic auth (enjekte `TokenProvider`), enjekte `fetch`, tipli hata eşleme |
| `src/errors.ts` | `AdoError` ağacı: `AdoConfigError` · `AdoHttpError` · `AdoAuthError` · `AdoNotFoundError` · `AdoResponseError` · `AdoWebhookAuthError` |
| `src/schemas.ts` | Tükettiğimiz ADO yanıtlarının Zod şemaları (loose); `build.complete` kaynağında artık **provenance alanları** da var |
| `src/branch.ts` | M49 dal sözleşmesi: `feature/<TICKET-KEY>-*` → ticket key; `refs/pull/<id>/merge` → PR id; ref/branch normalizasyonu; `GitSha` doğrulama |
| `src/credential.ts` | **(yeni)** `SecretIssuer` tipi · `pushScope` · TTL tavanı ve verilen kimliğin ömür doğrulaması (M31/O5) |
| `src/scm.ts` | `AdoScmDriver` — `resolveRepo` · `createBranch` · `getPushCredential` (tavan + ömür zorlamalı) · `openPr` · `activatePr` · `listPrThreads` · `replyThread` · `getPrStatus` (**mergeSha yalnız completed'da**) |
| `src/ci.ts` | `AdoCiDriver` — `parseAuthenticatedBuildEvent` (kimlik doğrulama + ayrıştırma) ve üstüne oturan `parseBuildEvent`; provenance kapısı; `AdoBuildEvent` dönüş tipi |
| `src/webhook.ts` | Service Hook paylaşılan-sır kontrolü: basic auth başlığı, sabit-zamanlı karşılaştırma (`node:crypto`), **fail-closed** — artık `ci.ts` tarafından çağrılıyor, ölü yol değil |
| `src/register.ts` | `registerAdoDrivers(registry, deps)` → `"scm"/"ado"` ve `"ci"/"ado"`; konfig kayıt anında doğrulanır; webhook sırrı ve TTL tavanı sürücülere bağlanır |
| `test/fixtures/*.json` | repo GET · refs list · refs update (başarılı + `success:false` reddi) · PR create (draft) / get (active, completed, abandoned) · threads list · thread comment created · `build.complete` (services + server) · PR'sız CI build · ticket key'siz build · build dışı olay (`git.push`) |

## 2. Testler

`pnpm -F @maestro/adapter-ado test` → **10 dosya / 120 test yeşil.**

| Dosya | Test | Kapsam |
|---|---|---|
| `config.test.ts` | 21 | iki modun URL kökü, api-version pinleme/override, çok segmentli collection · **O6 taşıma güvenliği** · **K1/O1 ci bloğu fail-closed** · **O5 TTL tavanı** |
| `client.test.ts` | 10 | Server/Services URL, query, PAT basic auth, her istekte token, 401/403/404 eşleme, 203 sign-in sayfası → auth hatası, 204/boş gövde |
| `branch.test.ts` | 8 | M49 ticket key çıkarımı (+ negatifler), PR merge ref, SHA doğrulama |
| `scm.test.ts` | 19 | resolveRepo · createBranch · PR açma/aktifleme · **K3 merge sha durum matrisi** · server modunda aynı akış |
| `scm-threads.test.ts` | 5 | thread status eşleme, sistem/silinmiş thread eleme, yorum cevabı |
| `scm-credential.test.ts` | 10 | **O5**: TTL tavanı, issuer'ın hiç çağrılmaması, dolmuş/uzun ömürlü kimlik reddi, saat kayması toleransı |
| `ci.test.ts` | 22 | services + server `build.complete`; null yolları; `partiallySucceeded/canceled` → `failed`; resourceVersion 1.0; zaman damgası fallback'leri · **K1 provenance kapısı (6 test)** |
| `ci-auth.test.ts` | 9 | **O1**: doğrulanmamış gövde reddi, yanlış/eksik/bozuk kimlik, auth'un ayrıştırmadan önce koşması, boş sır, sır rotasyonu, başlık normalizasyonu |
| `webhook.test.ts` | 9 | eksik/bozuk/yanlış kimlik reddi, boş kullanıcı adı biçimi, sır tanımsızsa çalışmayı reddetme, sırrın hata mesajına sızmaması |
| `register.test.ts` | 7 | iki portun kaydı, **webhook sırrının uçtan uca bağlanması**, konfig doğrulama, sırsız/allow-list'siz CI sürücüsü reddi, **TTL tavanının bağlanması**, token provider, çift kayıt reddi |

Tümü **çevrimdışı ve deterministik**: enjekte edilen sahte `fetch` fikstür döndürür, ağ yok,
saat enjekte (`NOW_MS`). Çıktılar `@maestro/contracts` şemalarıyla doğrulanıyor.

Kapı komutları: `pnpm install` · `pnpm -F @maestro/adapter-ado typecheck` ·
`pnpm -F @maestro/adapter-ado test` · kökten `pnpm lint` → **hepsi yeşil**
(kökten `pnpm typecheck` + `pnpm test` de yeşil). Hiçbir dosya 300 satırı geçmiyor
(en büyüğü `src/ci.ts`, 274).

## 3. Varsayımlar (denetlenmesi gerekenler)

1. **Fikstürler kayıt değil, belgeye göre yazıldı.** Kurum erişimi yok; şekiller Azure DevOps REST
   (Server 2022 + Services) ve Service Hooks dokümante edilmiş payload'larından türetildi. Erişim
   geldiğinde Aşama-0 duman testinde gerçek yanıtlarla değiştirilmeli (insa-plani §6).
2. **api-version:** Server `6.0`, Services `7.1` — tek tablo (`ADO_API_VERSIONS`). Bu bir sürüm
   *yeteneği* iddiası değil, kurulum başına pinleme kararıdır; farklı sürüm gereken kurulumda
   `apiVersion` override'ı var.
3. **Kimlik doğrulama her iki modda da PAT basic auth.** M11 Services için "Entra ID service
   principal" diyor; pakette bearer/OAuth akışı **yok** (spec PAT dedi). Bkz. talep §5.1.
4. **`build.complete` → sinyal yalnız allow-list'teki PR validation build'lerinde üretilir.**
   Sıra: provenance kapısı (reason + proje/repo/definition) → PR id (`triggerInfo["pr.number"]` →
   `refs/pull/<id>/merge`) → ticket key (`triggerInfo["pr.sourceBranch"]` → `sourceBranch` →
   `sourceGetVersion`). Herhangi biri yoksa `null` (olayı yok say).
5. **`null` = "bu webhook'u yok say", istisna = "bu bizim build'imiz ama bozuk".** Provenance
   kapısında `null` seçildi çünkü paylaşılan uca başka takımların/projelerin olayları da düşer;
   her birine 500 dönmek ADO'da yeniden deneme fırtınası yaratırdı. **Yan etki:** allow-list'e
   yazılmayı unutmuş gerçek bir PR-validation definition'ı sessizce yok sayılır ve 10b kapısı
   zaman aşımına kadar bekler (yanlış-yeşil yerine bekleme — fail-closed yön). Kurulum kontrol
   listesine "definition id'leri allow-list'e ekle" maddesi girmeli; uçta bir "yok sayıldı"
   sayacı/metriği tutmak orkestratörün kararı.
6. **Fail-closed CI eşlemesi:** `succeeded` dışındaki her sonuç (`partiallySucceeded`, `canceled`,
   tanınmayan) → `failed`.
7. **Thread status eşlemesi:** `active`/`pending`/`unknown`/(alan yok) → `active`; `fixed` →
   `fixed`; `closed`/`wontFix`/`byDesign` → `closed`.
8. **Sistem thread'leri elenir** (`commentType: "system"`) ve silinmiş thread/yorumlar atılır.
9. **`replyThread` `parentCommentId: 1` kullanır** — ADO'da thread'in ilk yorumu daima `id: 1`'dir.
10. **`getPushCredential` ADO'ya çağrı yapmaz**; enjekte `SecretIssuer`'ın ürettiği kimliği geçirir,
    ama artık ömrünü **doğrular** (§0/O5). Scope anahtarı sabit: `ado/<project>/<repo>/push`.
11. **Service Hooks payload imzalamaz** (HMAC yok). Tek kimlik doğrulama basic auth + TLS + IP
    allowlist; bu yüzden fail-closed ve sürücü doğrulanmamış gövdeyi ayrıştırmıyor.
12. **`parseBuildEvent`'e verilen sarmalayıcı BFF'te gerçek HTTP başlıklarından kurulmalıdır.**
    Gövdenin içinden gelen bir `headers` alanı asla kullanılmamalı. (Kullanılsa bile saldırganın
    yine de doğru sırrı bilmesi gerekir; yine de sözleşme budur.)
13. **Zaman damgaları:** ADO 7 haneli saniye kesiri gönderir; zone'suz on-prem damgası **UTC**
    kabul edilir, çıktı `toISOString()` ile normalize edilir.
14. **203 Non-Authoritative Information** (sign-in HTML'i) auth hatası sayılır.
15. `resolveRepo` kayıttaki repo'yu **GET ile doğrular**.
16. **`allowInsecureHttp` yalnız yerel geliştirme içindir.** Kurulum dokümanına "üretimde bu alan
    konfigde bulunmamalı" maddesi girmeli; adaptör bunu log'lamaz, sessizce kabul eder.

## 4. Bağımlılıklar

**Yeni runtime bağımlılığı YOK.** Sadece global `fetch` + `node:crypto` + `Buffer`.

| Bağımlılık | Tür | Gerekçe |
|---|---|---|
| `@maestro/contracts`, `@maestro/ports` | runtime (workspace) | donmuş arayüzler ve şemalar |
| `zod` | runtime | monorepo'da zaten standart; yanıt/konfig doğrulama |
| `@types/node`, `typescript`, `vitest` | dev | paket sözleşmesindeki standart set |
| `@maestro/test-kit` | dev (workspace) | ortak `loadFixture` düzeni |

## 5. Arayüz / karar talepleri (orkestratöre)

1. **Services modunda Entra ID.** M11 "service principal" diyor; bugün sürücü PAT basic auth
   kullanıyor. İstenirse `config.authScheme: "pat" | "bearer"` + `TokenProvider`'ın bearer token
   dönmesi yeterli — `AdoClient`'ta tek satırlık başlık değişimi. Karar senin.
2. **`CiResultSignal` repo/proje taşımıyor.** K1 sonrası korelasyon için gereken
   `project`/`repository`/`definitionId` sürücünün kendi dönüş tipinde (`AdoBuildEvent`) taşınıyor;
   porta yalnız `signal` geçiyor. Sinyali alan workflow'un "bu sinyal benim repo'muma mı ait"
   sorusunu sorabilmesi için ya `CiResultSignal`'e opsiyonel `adoProject`/`adoRepo` eklenmeli, ya
   da **BFF sinyali workflow'a gönderirken `AdoBuildEvent.project/repository`'yi kendisi
   doğrulamalı**. Bugünkü kod ikincisini mümkün kılıyor; birincisi arayüz değişikliği — dokunmadım.
3. **`CiPort.parseBuildEvent` imzası.** Port `rawBody: unknown` diyor; sürücü doğrulanmamış gövdeyi
   ayrıştırmayı reddedebilmek için `{ headers, body }` sarmalayıcısı bekliyor. Bu, tip düzeyinde
   görünmeyen bir sözleşme. Temizi `CiPort.parseBuildEvent(request: { headers, body })` olurdu —
   **donuk arayüz değişikliği, senin kararın.** O güne kadar BFF'in sarmalayıcıyı kurması şart
   (unutulursa uç 200 değil, `AdoWebhookAuthError` verir — sessiz kalmaz).
4. **`PrThread.status` üç değerli.** `wontFix` ile `closed` aynı kovaya düşüyor; 12b'de ayrım
   gerekirse `PrThread`'e ham status alanı eklenmeli.
5. **`PortRegistry.DriverFactory` yalnız `config` alıyor**; sürücünün ihtiyaç duyduğu
   `resolveToken`/`issueSecret`/`fetch` bu yüzden `registerAdoDrivers(registry, deps)` ile kayıt
   anında bağlanıyor. Webhook sırrı da aynı `resolveToken` üzerinden çözülüyor (yeni dep eklenmedi).
6. **`ci` bloğu her iki port için de zorunlu.** Tek "ado" sürücü konfigü hem SCM hem CI'ya
   hizmet ettiği için `ci` alanı SCM-only bir kurulumda da isteniyor. Ayrıştırmak istersen
   `ci`'yi opsiyonel yapıp yalnız `createAdoCiDriver`'da zorunlu kılmak tek satırlık değişiklik —
   ama o zaman "sırsız kayıt" hatası kayıt anından ilk webhook'a kayar. Bugünkü seçim fail-closed.
7. **`ScmPort.getPushCredential` dönüşü `{ token, expiresAt }`**, `SecretPort.issueShortLived`
   dönüşü `{ secret, expiresAt }`. İsim farkı sürücüde çevriliyor.
