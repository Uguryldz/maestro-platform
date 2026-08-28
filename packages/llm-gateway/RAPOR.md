# RAPOR — `@maestro/llm-gateway`

Dalga 1 paketi: LLM Gateway — `LlmPort` gerçeklemesi (M16 · M17 · M18 · M19 · M55 · M44).
Tur 1-2'de yalnız `packages/llm-gateway/` altına dokunuldu. **Tur 3'te orkestratör kararıyla
`packages/ports/src/llm.ts` iki değişiklik için açıldı** (§0b); `packages/contracts` ve diğer port
dosyaları **okundu, değiştirilmedi**. Ayrıca `packages/test-kit/src/mock-llm.ts` yeni arayüze taşındı.
`packages/config` değiştirilmedi (yeni mesaj anahtarı talebi §5'te).

> **Tur 2 (doğrulayıcı bulguları kapatıldı).** Paket ilk turda **KALDI** aldı; bağımsız doğrulayıcının
> 8 bloklayıcı bulgusu (B1-B8) bu turda kapatıldı. Ne değişti, hangi test kanıtlıyor ve ilk raporun
> hangi iddiası yanlıştı → **§0**. Sonraki dalgaya bırakılanlar → **§7**.
>
> **Tur 3 — ARAYÜZ TURU (orkestratör onayıyla).** Orkestratör §5 talep #1 ve #2'yi onayladı ve
> `packages/ports/src/llm.ts`'yi **yalnız bu iki değişiklik için** açtı (insa-plani §2 kural 1'in tek
> istisnası). B9 kapandı, B4 kalıcı olarak kapandı → **§0b**. Başka hiçbir port/contract dosyasına
> dokunulmadı.

## 0b. Tur 3 — arayüz turu (B9 kapandı, B4 kalıcı olarak kapandı)

### Ne değişti — `packages/ports/src/llm.ts`

```ts
export type LlmOutcome<T> =
  | { status: "ok"; value: T; log: LlmCallLog }
  | { status: "queued"; resumeAt: string; reason: "subscription_quota" }
  | { status: "degraded"; messageKey: string; dataClass: DataClass }
  | { status: "blocked"; messageKey: string; dataClass: DataClass };

export interface AgentSessionOptions {
  workspacePath: string;
  task: string;
  resumeToken?: string;
  mcpServers: string[];
  dataClass: DataClass;   // YENİ, zorunlu — veri sınıfı çağırandan gelir
  variantId: string;      // YENİ, zorunlu
}

export interface LlmPort {
  generateObject<T>(req: GenerateObjectRequest, schema: z.ZodType<T>): Promise<LlmOutcome<T>>;
  agentSession(opts: AgentSessionOptions): Promise<LlmOutcome<AgentSessionResult>>;
}
```

**Kural:** `queued` / `degraded` / `blocked` artık **istisna değil, dönüş değeri**. Gerçek arızalar
(ağ/taşıma, non-2xx sağlayıcı yanıtı, konfig-wiring, şema ıskası) **istisna olarak kaldı** —
outcome'a çevrilmedi. Bir outcome "gateway karar verdi" demektir; istisna "bir şey bozuldu" demektir.

**B9'un özü:** eskiden `degrade_ai_assist` ile `block` port üzerinde **aynı** `LlmPolicyBlockedError`
oluyordu ve ancak `messageKey` string'i karşılaştırılarak ayrılabiliyordu — `errors.ts`'in kendi
yorumunun yasakladığı şey. M18'in "degrade → akış ai-assist ile sürer (M97)" ile "block → akış durur"
ayrımı artık **iki ayrı `status`**. Kanıt: `test/outcomes.test.ts` → tek fark `onPremMissing` olan iki
gateway, **aynı** isteği `degraded` ve `blocked` olarak döndürüyor ve `decide()` switch'i iki farklı
eyleme çıkıyor.

### Gateway'de ne değişti

| Dosya | Değişiklik |
|---|---|
| `src/policy.ts` | `PolicyDecision` üçüncü dalı aldı: `{kind:"block", dataClass, messageKey}`. `LlmPolicyBlockedError` **fırlatılmıyor**, karar dönülüyor. `UnknownModelError` istisna olarak kaldı (konfig hatası, politika kararı değil) |
| `src/outcomes.ts` | `asError()` **silindi**. Dallar artık port tipinden türetiliyor (`Extract<LlmOutcome<unknown>, {status:"queued"}>` …) — gateway porttan sapamaz, saparsa derlenmez. `haltedFrom(decision)` politika kararını port durumuna birebir çeviriyor |
| `src/gateway.ts` | İkiz `generateObjectOrQueue` / `agentSessionOrQueue` **kaldırıldı**; port metotları tek gerçek yol. Agent turu `opts.dataClass` + `opts.variantId` ile çözülüyor, `ANY_VARIANT` sabiti agent yolundan çıktı; `LlmCallLog.variantId` artık çağıranın variant'ı |
| `src/config.ts` | `agentDataClass` **kaldırıldı** (geri uyum için bile bırakılmadı — bırakmak "sınıf ikinci bir yerden de gelebilir" demek olurdu, B4'ün ta kendisi). `agentRole` kaldı: rolü `AgentSessionOptions` taşımıyor |
| `src/errors.ts` | `LlmPolicyBlockedError` ve `SubscriptionQueuedError` **silindi** — yalnız donmuş imzadan durum sızdırmak için vardılar |
| `src/messages.ts` | `MSG_QUEUED_QUOTA` artık outcome'a binmiyor (`reason` makine-okunur ayrımdır); yeni `MSG_BLOCKED_ROUTE` eklendi: `dahili` sınıflı bir bloğa "gizli veri sınıfı" mesajı göstermek kullanıcının kendi veri sınıflandırması hakkında yanlış bilgi olurdu |
| `packages/test-kit/src/mock-llm.ts` | Aynı arayüze taşındı; agent oturumu artık **çağıranın** sınıfını ve variant'ını log'a yazıyor |

**`unmask` nerede?** Port'un `ok` dalı `unmask` taşımıyor (iki değişiklik dışına çıkmamak için).
Gateway `ok` dalını **yapısal olarak genişletiyor** (`GatewayOutcome<T> = ({status:"ok"; value; log} &
Unmaskable) | …`), bu yüzden `LlmGateway` hâlâ `LlmPort`'u karşılıyor; `LlmPort` tipiyle çağıran
`unmask` görmez. Dalga 3 maskeli çıktıyı port üzerinden açmak isterse → §5 talep #8.

### Dalga 3 (workflows) bunu nasıl kullanacak

```ts
const outcome = await llm.generateObject(req, AnalysisDoc);
switch (outcome.status) {
  case "ok":
    return await journal.write(outcome.value, outcome.log);
  case "queued":
    // M55: sağlayıcıya hiç gidilmedi, kota bekleniyor. Jira'ya "kota bekleniyor"
    // notu (i18n: run.queued_quota) + Temporal timer.
    await workflow.sleepUntil(outcome.resumeAt);
    return await retry();
  case "degraded":
    // M18/M97: akış DURMAZ — work-mode ai_assist'e düşer, işi insan yapar.
    return await setWorkMode("ai_assist", outcome.messageKey);
  case "blocked":
    // M18: hiçbir modele gidilemez — akış durur, uyum kararı beklenir.
    return await halt(outcome.messageKey, outcome.dataClass);
}
```

`agentSession` de aynı switch'tir; `ok` dalında sonuç `outcome.value` içindedir
(`{resumeToken, finalText, log}`) ve `outcome.log` ile `outcome.value.log` **aynı satırdır**.
Agent turu açan her çağıran **veri sınıfını ve variant'ı vermek zorundadır** — gateway'in düşeceği
bir varsayılan yok (M18). `gizli` sınıflı bir "yapan" rol turu on-prem şerit yoksa `degraded` döner,
yani M97'nin "gizli sınıfta yapan rol ai-assist'e düşer" kararı artık **portta uygulanabilir**.

## 0. Tur 2 — doğrulayıcı bulgularının kapatılması

Her bulgu için **önce kırılan regresyon testi** yazıldı, sonra düzeltme yapıldı. Aşağıdaki
"kanıt" sütunu, düzeltme geri alındığında kaç testin kırmızıya döndüğünü gösteriyor (hepsi
canlı koşularak doğrulandı).

| # | Durum | Ne yapıldı | Kanıt (düzeltme geri alınınca) |
|---|---|---|---|
| **B1** | **KAPANDI** | `policy.ts` `masked_cloud` dalı artık `usable.find(b => !isSubscriptionDriver(b.driver))` kullanıyor; ayrıca `parseGatewayConfig` **kurulumda** `routes.gizli`'ye abonelik sürücüsü yazılmasını reddediyor (`routes.N.allowedDrivers.M` yolunda tipli hata). İki bağımsız kapı: konfig kapısı + politika kapısı (elle kurulmuş konfig için) | `confidential-routing.test.ts` → 4 testin **3'ü** kırılıyor |
| **B2** | **KAPANDI** | `SessionRecord` artık `SessionPin` (driver+model+**dataClass**+**masked**) taşıyor; `AgentSessionStore.start(pin, workspacePath)`. Resume turu maskeleme kararını kayıttan geri yüklüyor — maskeleme tek turluk değil, oturum ömürlü | `agent-session-policy.test.ts` → 5 test kırılıyor (B2+B3 birlikte) |
| **B3** | **KAPANDI** | `agentSession` **her turda** `policy.resolve` çağırıyor. Karar `degrade`/`block` ise tur o durumu döner (tur 3'ten beri outcome); karar oturumun sabitlemesiyle çelişirse yeni `SessionPolicyChangedError` ile **fail-closed reddedilir** — sessizce eski sürücüye düşmek yok. M58 kill-switch'i açık oturumlara ulaşıyor | aynı dosya |
| **B4** | **KAPANDI (tur 3'te kalıcı)** | Tur 2'de yama: `agentDataClass` varsayılanı `gizli` (fail-closed). **Tur 3'te yama kaldırıldı:** `AgentSessionOptions.dataClass` zorunlu, `cfg.agentDataClass` **silindi** — sınıf tek bir yerden, çağırandan geliyor. `LlmCallLog` turun gerçekten yönlendirildiği sınıfı ve çağıranın variant'ını yazıyor | `agent-session-policy.test.ts` (aynı gateway'in iki turu, yalnız sınıf farkıyla iki farklı şeride gidiyor) |
| **B5** | **KAPANDI** | `SubscriptionPool.acquire()` seçim anında **rezerve ediyor** (1 çağrılık kotayı yakar, `seat.reserved++`). `record(accountId, calls)` mutabakat yapıyor: rezerve edilen 1 çağrı düşülür, kalan gerçek çağrılar eklenir. Hata yolunda rezervasyon **serbest bırakılmaz**. Paralel-çağrı testi eklendi (20 çağrı / 2 koltuk → 10/10, %50-%50) | `quota-accounting.test.ts` → 7 testin **hepsi** kırılıyor |
| **B6** | **KAPANDI** | Yeni `CallCounter` (http.ts) her **fiziksel** sağlayıcı denemesini sayıyor; `DriverCall.counter` → `RequestContext.counter` → `postJson` zinciriyle dört sürücüye de bağlı. Gateway `finally`'de `pool.record(accountId, max(1, counter.attempts))` çağırıyor. Şema düzeltme turu + HTTP retry artık kotayı yakıyor | aynı dosya + `http.test.ts` (3 yeni test) |
| **B7** | **KAPANDI** | `LlmHttpError.responseBody` artık `enumerable:false` (`JSON.stringify(error)` ve `{...error}` taşımıyor) **ve** saklanmadan önce `redact()`'ten geçiyor: `sk-*`, AWS `AKIA/ASIA`, `ya29.*`, JWT, `Bearer …`, `"password"/"token"/"apiKey"` alanları → `[REDACTED]`; PII için `@maestro/pii`'nin en katı profili. Alt sınıflar (`LlmAuthError`, `LlmRateLimitError`) miras alıyor | `redaction.test.ts` → 4 testin **2'si** kırılıyor |
| **B8** | **KAPANDI** | `deps.mask` imzası `@maestro/pii`'nin `maskOutbound`'una **birebir** uyduruldu: `<T>(payload: T, ctx: {dataClass, boundary}) => {payload, map, counts}`. Composition root adaptörsüz bağlıyor (`test/helpers.ts:piiMask()` bunu gerçek `maskOutbound` ile kanıtlıyor). Yeni `masking.ts` maskeden **sonra `assertNoPii`** koşuyor (maskelemeyen masker → `PiiLeakError`, çağrı yapılmaz) ve ReverseMap'i `unmask` kapanışıyla taşıyor. Dönen nesne **maskeli** kalır (M20/M82: saklanabilir kopya), `unmask()` yalnız insana gösterilecek kopya için | `redaction.test.ts` (B8 bloğu) |

**Kotanın anlamı değişti (B5+B6, dikkat):** artık `costPctPerCall` **fiziksel sağlayıcı çağrısı**
başınadır, mantıksal gateway çağrısı başına değil. Bir `generateObject` şema düzeltme turu +
2 retry yaparsa 4 çağrılık kota yakar. Konfigdeki yüzdeler buna göre okunmalı.

**`postJson` neden değer döndürmek yerine sayaç alıyor?** Deneme sayısının en kritik olduğu yer
**hata yolu**: 3 kere 503 alıp fırlatan bir çağrı 3 kota yakmıştır ama dönüş değeri hiç oluşmaz.
Sayaç bir out-parametre olduğu için `finally` bloğu doğru sayıyı her iki yolda da görüyor.

**İlk rapordaki YANLIŞ iddia düzeltildi:** §1'de `policy.ts` satırı ve §2'de `policy.test.ts` satırı
"abonelik sürücüsü `gizli`'ye asla girmez" diyordu. Bu **yalnız on-prem arama dalı için** doğruydu;
`masked_cloud` dalı hiçbir dışlama yapmıyordu ve `gizli` sınıflı bir çekirdek-bankacılık ticket'ı
`claude-sub` koltuğuyla `api.anthropic.com`'a çıkabiliyordu. Testin kendisi de yalnız varsayılan
(degrade) dalı kapsadığı için bunu yakalamamıştı. Artık iddia **iki kapıyla** doğru: konfig kapısı
böyle bir rotayı kurmaya izin vermiyor, politika kapısı elle kurulmuş konfigde bile seçmiyor.

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/config.ts` | Zod'lu tüm gateway konfigü: 4 sürücü (ayrımlı birleşim), abonelik havuzu, rol/variant→model bağlamaları, veri sınıfı→sürücü rotaları, `onPremMissing` (M18), rate-limit + retry, `agentRole` (tur 3: `agentDataClass` **silindi**). `superRefine`: tanımsız sürücüye bağlanan binding, havuzu olmayan abonelik sürücüsü, konfigürasyonsuz `transport`, eksik veri sınıfı rotası, **`routes.gizli`'ye yazılmış abonelik sürücüsü (B1)** → **kurulumda hata** (fail-closed) |
| `src/pool.ts` | **`SubscriptionPool` (M55, paketin kalbi)**: hesap başına 5h/weekly pencere takibi, pencere dolunca **tam periyot** ileri sarma + sıfırlama, kota-farkında seçim (en çok boşluk → en az yakında kullanılan → id), dolu/cooling/disabled hesabı pas geçme, **havuzun tamamı doluysa `{ok:false, resumeAt}`** (hata değil), **`acquire()` seçim anında rezerve eder (B5)**, **`record(accountId, calls)` gerçek fiziksel çağrı sayısıyla mutabakat yapar (B6)**, `snapshot()` ile `SubscriptionAccount` şemasıyla doğrulanmış kota görünümü (M62) |
| `src/policy.ts` | `LlmPolicy`: veri sınıfı → izinli sürücü kümesi, rol+variant → model (tam variant önce, `*` sonra), `gizli` sınıfı **yalnız on-prem** (abonelik sürücüsü on-prem etiketlense bile asla), on-prem yoksa `degrade_ai_assist \| block \| masked_cloud` (varsayılan degrade) — **`masked_cloud` dalı da abonelik sürücüsünü dışlar (B1)**. Binding yoksa `UnknownModelError` (M19: sessiz fallback yok) |
| `src/http.ts` | `TokenBucket` (atomik olmayan, süreç-içi; M19'un Redis'i Dalga 3'te) + `postJson`: enjekte fetch, sınırlı retry (429/5xx/taşıma hatası), `Retry-After` (saniye) `maxDelayMs` ile tavanlı, 4xx ve 401/403 **retry edilmez**, JSON olmayan gövde hatası, audit için 500 karakter kırpılmış hata gövdesi + **`CallCounter`**: her fiziksel denemeyi sayar, hata yolunda da okunabilir (B6) |
| `src/redact.ts` | Hata nesnesine binmeden önce sır (`sk-*`, `AKIA/ASIA*`, `ya29.*`, JWT, `Bearer …`, sır adlı JSON alanları) ve PII temizliği; PII tarafı `@maestro/pii`'nin en katı profiliyle, ReverseMap üretilip aynı karede atılıyor (B7) |
| `src/masking.ts` | `MaskFn` (= `pii.maskOutbound` imzası) + `maskForEgress`: maskele → **`assertNoPii` ile kanıtla** → ReverseMap'i `unmask` kapanışıyla taşı. Masker yoksa veya maskeleme fiilen olmamışsa **çağrı yapılmaz** (B8) |
| `src/driver-types.ts` | Dört sürücünün ortak arayüzü (`LlmDriver.complete`), `DriverCall.credentialRef` (abonelik koltuğunun kendi kimliği), `DriverDeps` (secrets, bucket, retry, `signRequest`, `accessToken`) |
| `src/driver-anthropic.ts` | `anthropic-direct` **gerçek istemci**: `POST {baseUrl}/v1/messages`, `x-api-key` + `anthropic-version`, Messages gövdesi; paylaşılan `messagesBody()` / `parseMessagesResponse()` (metin blokları birleştirme, `cache_read`/`cache_creation` → `tokensIn` + `cachePct`) |
| `src/driver-openai.ts` | `openai-compat` **gerçek istemci** (on-prem vLLM şeridi): `POST {baseUrl}/v1/chat/completions`, bearer, system+user mesajları, `prompt_tokens_details.cached_tokens` → `cachePct`. On-prem olup olmadığı **konfigden** (`onPrem`), URL'den tahmin edilmiyor |
| `src/driver-cloud.ts` | `aws-bedrock` ve `google-vertex` **iskeletleri**: doğru uç (`/model/{id}/invoke`, `…:rawPredict`), doğru gövde (`anthropic_version`), VPC endpoint override; kimlik **enjekte** (`signRequest` = SigV4, `accessToken` = OAuth). Enjekte edilmemişse **imzasız istek atmak yerine `LlmConfigError`** |
| `src/structured.ts` | `generateObject` çekirdeği: şema adı + `z.toJSONSchema` + girdi ile prompt, yanıttan JSON çıkarma (fenced/önsözlü tolere), Zod doğrulama, **1 düzeltme turu** (somut hata listesiyle), ikinci turda da tutmazsa `LlmSchemaValidationError` — kısmi nesne asla dönmez |
| `src/session.ts` | `AgentSessionStore` + `AgentRunner` arayüzü: resumeToken üretimi (enjekte `newId`), oturum→**`SessionPin` (sürücü/model/**dataClass**/**masked**)** + workspace sabitleme (B2), tur sayacı, vendor oturum kolunu taşıma. Bilinmeyen token veya workspace değişimi → hata (sessizce yeni oturum yok) |
| `src/outcomes.ts` | Port'un `LlmOutcome` dallarından türetilen `QueuedOutcome`/`DegradedOutcome`/`BlockedOutcome` + `GatewayOutcome`/`SessionOutcome` + `haltedFrom()`; başarılı sonuçta maskeli yolda **opsiyonel `unmask`** (M20 — dönen değer maskeli kalır). Tur 3'te `asError()` silindi |
| `src/gateway.ts` | `LlmGateway implements LlmPort`: politika → maskeleme → havuz → sürücü zinciri (maskeleme **koltuk alınmadan önce**: wiring hatası kota yakmaz), kota `finally` içinde **fiziksel çağrı sayısıyla** yakılır (**başarısız çağrı da kotayı harcar**), agent turunda **her tur politikaya uğrar** ve oturum sabitlemesiyle çelişirse reddedilir (B3), `LlmCallLog` üretimi (contracts şemasıyla `parse`, `usd: null`, **gerçek veri sınıfı**), `onCallLog` yayını, `poolSnapshot()` |
| `src/register.ts` | `registerLlmDrivers(registry, deps)` → `"llm"/"gateway"` (M44 DI; çekirdek bu modülü import etmez) |
| `src/messages.ts` | Yalnız **mesaj anahtarları** (M104) — pakette kullanıcıya dönük tek bir metin yok |

**Kuyruk sözleşmesi (M55'in özü, tur 3'te güncellendi):** `generateObject()` / `agentSession()` havuz
dolduğunda **hata atmaz**, `{status:"queued", resumeAt, reason:"subscription_quota"}` döner ve
sağlayıcıya hiç gitmez. Temporal bu değeri timer'a çevirir. İkiz `*OrQueue` metotlarına artık gerek
yok; port metotları tek gerçek yol (§0b).

## 2. Testler

`pnpm -F @maestro/llm-gateway test` → **15 dosya / 137 test yeşil**
(tur 1: 9 dosya / 101 test · tur 2: 14 dosya / 132 test).

| Dosya | Test | Kapsam |
|---|---|---|
| `config.test.ts` | 6 | varsayılanlar (**`agentDataClass` artık YOK** — sınıf konfigden gelemez), tanımsız sürücüye binding reddi, `transport` doğrulaması, her veri sınıfı için rota zorunluluğu, tipli hata |
| `pool.test.ts` | 14 | boşluğa göre seçim + rotasyon, koltuğun kendi kimliği/transport'u, dolu/cooling/disabled atlama, **havuz dolunca `resumeAt`**, "en son engel" kuralı (5h serbest ama weekly dolu), tam periyot ileri sarma, 5h sıfırlanırken weekly'nin yanmaya devam etmesi, %100 tavanı, sözleşme-geçerli snapshot, sürücü izolasyonu, çift hesap/bilinmeyen hesap |
| `policy.test.ts` | 11 | tam variant > `*`, binding yoksa hata, `gizli` on-prem'e gider, on-prem yoksa degrade / **`kind:"block"` kararı** / masked_cloud, GPU yokken (disabled) degrade, rota hiçbir şeye izin vermezse blok (`llm.blocked_by_route` anahtarıyla), abonelik sürücüsü `gizli`'ye girmez (on-prem dalı) |
| `confidential-routing.test.ts` | 4 | **B1:** konfig kapısı `routes.gizli`'ye abonelik sürücüsünü reddeder (tekil ve karışık liste), diğer rotalar etkilenmez, elle kurulmuş konfigde `masked_cloud` dalı da reddeder, hem koltuk hem API sürücüsü açıkken **API sürücüsü seçilir** |
| `http.test.ts` | 16 | token-bucket burst + bekleme + doldurma, rate-limit beklemesi, 429 retry + `Retry-After` tavanı, maxAttempts tükenmesi, 5xx/taşıma retry'ı, 4xx ve 401/403 retry'sız, son denemeden sonra uyumama, enjekte random ile jitter, boş/JSON olmayan gövde, kırpılmış hata gövdesi, **`CallCounter`: retry'lı başarı / fırlatan çağrı / hiç çağrılmama** |
| `drivers.test.ts` | 16 | anthropic istek/URL/başlık/gövde, metin bloğu birleştirme + `cachePct`, cache raporlanmayınca `null`, **koltuk kimliği override'ı**, system'siz gövde, metinsiz/şekilsiz yanıt reddi, proxy baseUrl; openai istek/parse/system'siz/`null` içerik reddi; bedrock imzasızsa **çağrı yapmadan** hata, imzalı uç + gövde, VPC override; vertex token'sız hata, rawPredict uç + bearer |
| `structured.test.ts` | 10 | ilk turda doğrulama, prompt içeriği, maskeli string girdi, fenced JSON, **düzeltme turu + hata listesinin prompt'a girmesi**, ikinci turda da tutmazsa hata, düzyazı yanıt = şema ıskası, token toplama, `extractJson` birim testleri |
| `session.test.ts` | 7 | token üretimi ve sabitleme, resume + vendor kolu, tur sayacı/`updatedAt`, bilinmeyen token reddi, workspace değişimi reddi, **veri sınıfı + maskeleme kararının sabitlenmesi**, oturum izolasyonu |
| `gateway.test.ts` | 13 | abonelik→transport+kimlik, **sözleşme-geçerli `LlmCallLog` (`usd:null`, driver=`claude-sub`)**, havuz dolunca `queued` + sağlayıcıya gitmeme, **başarısız çağrının kotayı yakması**, `gizli` degrade, `gizli`→on-prem gerçek çağrı, masker yoksa masked_cloud reddi, gerçek `pii` maskesiyle IBAN'ın gövdeye çıkmaması, bağlanmamış rol/bozuk istek, konfig kapısı, fetch yoksa kurulmama, kota snapshot'ı, `LlmPort` uyumu |
| `outcomes.test.ts` | 7 | **B9 (tur 3):** dört `status` dalının her biri için bir test (`ok`/`queued`+ISO `resumeAt`/`degraded`/`blocked`), **`degraded` ile `blocked`'ın ayırt edilebilmesi** (yalnız `onPremMissing` farkıyla aynı istek iki farklı duruma çıkıyor — eski kod ikisini de `LlmPolicyBlockedError` yapıyordu), agent turunda aynı ayrımın **`LlmPort` tipi üzerinden** çalışması, tüketen tarafta **exhaustive switch** (`never` kontrolü), gerçek arızaların (HTTP 400, şema ıskası) hâlâ istisna olması |
| `gateway-agent.test.ts` | 5 | agent oturumu delegasyonu (+ çağıranın variant/sınıfının log'a yazılması, `value.log === log`), resume + vendor kolu, kuyruk, runner yoksa hata, çağıranın sınıfının arka ucu yoksa degrade |
| `agent-session-policy.test.ts` | 10 | **B2:** resume turu da maskeli gider + `unmask` yalnız insana dönen metinde; **B3:** rota daralınca resume `blocked` döner, sabitlemeyle çelişen karar → `SessionPolicyChangedError`, `onPremMissing` → `block`/`degrade` açık oturuma ulaşır; **B4 (kalıcı):** aynı gateway'in iki turu yalnız çağıranın sınıfı yüzünden farklı şeride gider, farklı sınıfla gelen resume reddedilir, GPU yokken degrade, çağıranın variant'ı log'a yazılır |
| `quota-accounting.test.ts` | 7 | **B5:** 20 paralel çağrı 2 koltuğa 10/10 dağılır (%50-%50), rezervasyonlar havuzu doldurunca kuyruk, mutabakat çift saymaz, hata yolunda rezervasyon durur; **B6:** düzeltme turu 2 kota, 3× 503 retry 3 kota, retry+düzeltme birlikte 4 kota |
| `redaction.test.ts` | 7 | **B7:** anahtar/bearer/TCKN/IBAN temizliği, AWS key + JSON sır alanı, `JSON.stringify(error)`/`{...error}` `responseBody` taşımaz, `LlmAuthError`'da da geçerli; **B8:** `pii.maskOutbound` adaptörsüz bağlanır + `unmask` çalışır, maskelemeyen masker → `PiiLeakError` (çağrı yok), masker yoksa `LlmConfigError` |
| `register.test.ts` | 4 | `"llm"/"gateway"` kaydı, fabrika anında konfig doğrulaması, çift kayıt reddi, enjekte bağımlılıkların uçtan uca bağlanması |

**Mutasyon dayanıklılığı (tur 2):** her B-düzeltmesi tek tek geri alınıp testler koşuldu —
B1 → 3 kırmızı, B2+B3 → 5 kırmızı, B5+B6 → 7 kırmızı, B7 → 2 kırmızı, B4 → `config.test.ts` kırmızı.
Yani yeni testler gerçekten bu hataları yakalıyor; kabul-testi değiller.

Tümü **çevrimdışı ve deterministik**: gerçek ağ yok (enjekte `fetch`), gerçek saat yok (enjekte `now`,
sahte clock), gerçek uyku yok (enjekte `sleep`, süreler assert ediliyor), rastgelelik enjekte (`random`),
id üretimi enjekte (`newId`). `Date.now()`/`Math.random()` üretim kodunda yalnız **varsayılan** olarak
duruyor, testlerde hiç kullanılmıyor.

Kapı komutları (tur 3'te yeniden koşuldu): `pnpm install` · `pnpm -F @maestro/llm-gateway typecheck` ·
`pnpm -F @maestro/llm-gateway test` · `pnpm -F @maestro/ports test` · kökten `pnpm lint` ·
kökten `pnpm typecheck` (12 görev) · kökten `pnpm test` (24 görev) → **hepsi yeşil**.

**Boyut (tur 3):** `src/` 1.724 ham satır / **1.244 kod satırı** (boş ve yorum satırları hariç) /
18 dosya, en büyük dosya `gateway.ts` **264** satır — **hiçbir dosya 300 satırı geçmiyor**
(en büyük test dosyası `drivers.test.ts` 241). Tur 3 net olarak birkaç satır **eksiltti**: ikiz
metotlar ve iki hata sınıfı gitti, yerine `haltedFrom()` geldi. Kod satırı ölçüsüyle 1.200 tavanının
~44 satır üstünde — fark B1-B8'in getirdiği iki dosya (`redact.ts`, `masking.ts`) ve
rezervasyon/sayaç mantığı. Ev üslubunu (adapter-jira/adapter-ado) korudum.

## 3. Varsayımlar (denetlenmesi gerekenler)

1. **Abonelik sürücüsü nasıl çağrı yapar?** M55 abonelik hesaplarını ayrı bir sürücü sınıfı yapıyor ama
   fiziksel taşıma katmanını tanımlamıyor. Modelim: her koltuk bir `transport` (API sürücüsü) + kendi
   `credentialRef`'i taşır; log'da sürücü `claude-sub` görünür, HTTP `anthropic-direct` üzerinden gider.
   Gerçek dünyada abonelik oturumu CLI/Agent SDK login'i olabilir — o zaman `transport` yerine Dalga 2
   runner'ı devreye girer, `AgentRunner.credentialRef` bu yüzden zaten arayüzde.
2. **Kota ölçümü tahminidir ve birimi FİZİKSEL çağrıdır (tur 2'de değişti).** Sağlayıcılar pencere
   doluluğunu başlıkla raporlamadığı sürece kota `costPctPerCall` (pencere başına yüzde) ile
   ilerletiliyor: 5h penceresi weekly'den hızlı dolduğu için maliyet **pencere başına** tanımlı.
   **`costPctPerCall` artık mantıksal gateway çağrısını değil, sağlayıcıya giden her fiziksel
   isteği ölçer** (şema düzeltme turu + HTTP retry dahil, B6); ayrıca koltuk `acquire()` anında
   1 çağrılık rezervasyon yakar ve `record()` mutabakat yapar (B5), böylece paralel çağrılar
   kotayı aşamaz. Gerçek başlık/uç bulununca `SubscriptionPool`'a bir `sync(windows)` metodu
   eklemek yeterli (bilerek yazmadım — bkz. §6).
3. **Pencere başlangıcı süreç başlangıcıdır.** Havuz kurulduğunda tüm pencereler "şimdi + uzunluk"
   olarak açılır; süreç yeniden başlarsa kota takibi sıfırlanır. Kalıcılık DB işidir (`db` paketinde
   kota tablosu yok) — bkz. talep #4.
4. **`gizli` sınıfı için "cloud" tanımı = `onPrem !== true`.** Bir sürücüyü on-prem saymak tamamen
   konfig kararıdır; abonelik sürücüleri hiçbir koşulda on-prem sayılmaz **ve `masked_cloud`
   dalında da seçilemez** (kodda sabit + konfig kapısı, B1).
5. **`masked_cloud` maskeleyici olmadan çalışmaz — ve maskeleme DOĞRULANIR.** `pii` paketi ayrı bir
   Dalga 1 paketi olduğu için gateway `deps.mask` bekler; enjekte edilmemişse **maskesiz göndermek
   yerine hata verir**. Tur 2'den beri maskeden sonra `assertNoPii` koşuluyor: maskelemediği hâlde
   başarı bildiren bir masker `PiiLeakError` alır, çağrı hiç yapılmaz (B8). Dönen nesne **maskeli**
   kalır (saklanabilir kopya — M20/M82); gerçek değerler yalnız `outcome.unmask()` ile açılır ve o
   kopya hiçbir yere yazılmamalıdır.
5b. **Agent turunun veri sınıfı ÇAĞIRANDAN gelir (tur 3'te değişti).** `AgentSessionOptions.dataClass`
   zorunlu; gateway'in düşeceği bir varsayılan **yok** (`cfg.agentDataClass` silindi). Resume turu da
   sınıfı çağırandan alır: oturumun açıldığı sınıftan farklı bir sınıfla gelen resume, sabitleme
   karşılaştırmasına takılıp `SessionPolicyChangedError` ile reddedilir (fail-closed).
   Not: rolü hâlâ konfig belirler (`agentRole`), çünkü `AgentSessionOptions` rol taşımıyor.
5c. **Açık bir agent oturumu politika değişikliğine kapalı değildir.** Her tur `policy.resolve`
   koşar; karar oturumun sabitlemesiyle çelişirse tur `SessionPolicyChangedError` ile reddedilir
   (B3). Uyum ekibi rotayı daraltırsa / kill-switch çekilirse (M58) **devam eden oturumlar da
   durur**; oturumu yeniden açıp açmamak workflow'un kararıdır.
6. **`degrade_ai_assist` kararı gateway'de uygulanmaz**, yalnız raporlanır (`{status:"degraded"}`).
   Work-mode'u `ai_assist`'e düşürmek workflow'un (Dalga 3) işi; gateway iş akışı durumu tutmaz.
   `{status:"blocked"}` ise akışın **durması** gerektiğini söyler — ikisi tur 3'ten beri ayrı
   durumlardır, mesaj anahtarı karşılaştırmasıyla ayrılmazlar (B9).
7. **`usd` her zaman `null`.** Abonelikte maliyet kota (M55); API sürücülerinde fiyat tablosu M19'a göre
   konfigde yaşar ve bu pakette yok — uydurma dolar yazmaktansa `null` bırakıldı (bkz. §6).
8. **Retry deterministiktir**; `jitterRatio` varsayılanı 0, jitter istenirse enjekte `random` ile.
   Rate limit süreç-içidir; M19'un atomik Redis token-bucket'ı çok-replikalı BFF için Dalga 3'te gerekir.
9. **`Retry-After` yalnız saniye** olarak okunur (HTTP-date yok sayılır), `maxDelayMs` ile tavanlanır.
10. **Prompt iskeleti İngilizcedir** ve rol promptları içermez; rol/analiz promptları M43'e göre
    knowledge pack'te ve Dalga 3'te. AI çıktı dili (M71) buraya girdi olarak gelir.
11. **Sürücü fikstürleri kayıt değil, belgeye göre yazıldı** (kurum erişimi/anahtar yok): Anthropic
    Messages, OpenAI Chat Completions, Bedrock `invoke`, Vertex `rawPredict` şekilleri. Erişim gelince
    Aşama-0 duman testinde gerçek yanıtlarla değiştirilmeli (insa-plani §6).

## 4. Bağımlılıklar

**Yeni HARİCİ runtime bağımlılığı YOK.** Global `fetch` + `crypto.randomUUID` dışında hiçbir şey.
Tur 2'de tek yeni bağımlılık **workspace içi** `@maestro/pii` (orkestratör onayıyla).

| Bağımlılık | Tür | Gerekçe |
|---|---|---|
| `@maestro/contracts`, `@maestro/ports` | runtime (workspace) | donmuş şemalar ve arayüzler |
| `@maestro/pii` | runtime (workspace) | `deps.mask` imza uyumu (`maskOutbound`), maskeleme sonrası `assertNoPii` doğrulaması, ReverseMap ile `unmask`, hata gövdesi PII temizliği (B7/B8) |
| `zod` | runtime | konfig/yanıt/çıktı doğrulama; `z.toJSONSchema` ile şema promptu |
| `@types/node`, `typescript`, `vitest` | dev | paket sözleşmesindeki standart set |

`@maestro/test-kit` **eklenmedi**: bu pakette JSON fikstür dosyası yok (sürücü yanıtları testlerde
şema-doğrulamalı satır içi nesneler), `loadFixture` gereksizdi — kullanılmayan bağımlılık bırakmadım.

Vercel AI SDK (M17) **eklenmedi**: `generateObject` için tek ihtiyacımız şema + JSON doğrulama, o da
zod ile karşılanıyor; SDK eklemek 4 sürücüyü de onun provider modeline bağlardı ve abonelik/kuyruk
mantığını gizlerdi. Orkestratör M17'yi harfiyen isterse sürücü katmanı SDK ile değiştirilebilir —
`LlmDriver` arayüzü bu yüzden dar tutuldu.

## 5. Arayüz / karar talepleri (orkestratöre)

1. ~~**`LlmPort.generateObject` kuyruk durumunu taşıyamıyor.**~~ **KAPANDI (tur 3).** Port dönüşü
   `Promise<LlmOutcome<T>>` oldu; `queued`/`degraded`/`blocked` dönüş değeri, ikiz `*OrQueue` metotları
   kaldırıldı → §0b.
2. ~~**`AgentSessionOptions` veri sınıfı ve variant taşımıyor.**~~ **KAPANDI (tur 3).** İkisi de
   zorunlu alan oldu; `cfg.agentDataClass` silindi, gateway varsayılana düşmüyor → §0b.
3. **`DriverFactory` yalnız `config` alıyor** (`(config: unknown) => P`), gateway'in `SecretPort`/fetch/
   clock/`AgentRunner` gibi çalışma zamanı ortaklarına ihtiyacı var. adapter-ado ile aynı çözüm:
   `registerLlmDrivers(registry, deps)` kayıt anında bağlıyor. Composition root'un llm deps'ini kayıt
   sırasında hazır etmesi gerekiyor; alternatif `DriverFactory` imzasını değiştirmek.
4. **Kota kalıcılığı DB'de yok.** Süreç yeniden başlayınca pencere kullanımı sıfırlanır ve gerçek kota
   aşılabilir. `db` şemasına `SubscriptionQuotaWindow` (accountId, kind, usedPct, resetsAt) tablosu +
   `SubscriptionPool`'a repository enjeksiyonu öneriyorum (Dalga 2/3 işi, tek dosyalık dokunuş).
5. **Yeni mesaj anahtarları gerekiyor (M104).** `packages/config/locales`'a **ben eklemedim**; kod
   yalnız anahtarı taşıyor. Önerilen üçlü (tur 3'te `llm.blocked_by_route` eklendi):

   | key | tr | en |
   |---|---|---|
   | `llm.degraded_ai_assist` | `Gizli veri sınıfı için on-prem model yok — akış ai-assist moduna düşürüldü` | `No on-prem model for the confidential data class — the flow fell back to ai-assist` |
   | `llm.blocked_confidential` | `Gizli veri sınıfı politika gereği hiçbir modele gönderilemez` | `The confidential data class may not be sent to any model by policy` |
   | `llm.blocked_by_route` | `Bu veri sınıfı için yönlendirme politikası hiçbir modele izin vermiyor` | `The routing policy permits no model for this data class` |

   Üçüncüsü neden gerekli: `dahili` sınıflı bir bloğa "gizli veri sınıfı" metnini göstermek,
   kullanıcıya kendi verisinin sınıfı hakkında yanlış bilgi vermek olurdu.
   `status:"queued"` artık mesaj anahtarı taşımıyor, makine-okunur `reason:"subscription_quota"`
   taşıyor; yüzeyler bunu mevcut `run.queued_quota` anahtarına eşler (`notify.quota_wait` bildirim
   paketinin işi, bu pakette kullanılmadı).
6. **`LlmCallLog` maskeleme/PII alanı taşımıyor.** M19 "maskeli çağrı logu" diyor; şu an log yalnız
   sayaç taşıyor (prompt/yanıt hiç loglanmıyor — en güvenli varsayılan). Prompt örneği saklanacaksa
   `LlmCallLog`'a `maskedPromptRef` gibi bir alan + StoragePort gerekir.
7. **`LlmCallLog.runId`** için gateway `deps.runId()` bekliyor; workflow her run için gateway örneği mi
   kuracak, yoksa `GenerateObjectRequest`'e `runId` mi eklenecek? Bugün varsayılan `null`.
8. **`unmask` port'un `ok` dalında yok (tur 3'te doğan yeni, KÜÇÜK talep).** Orkestratörün verdiği iki
   değişiklik dışına çıkmamak için `LlmOutcome.ok` yalnız `{value, log}` taşıyor; gateway bu dalı
   yapısal olarak genişletip `unmask`'i veriyor, ama `LlmPort` tipiyle çağıran onu görmez (§0b).
   Dalga 3 maskeli bir sonucu insana göstermek isterse `ok` dalına `unmask?: <R>(v:R)=>R` eklenmeli —
   yoksa Studio maskeli metni açamaz. Şimdilik bloklayıcı değil: `masked_cloud` yalnız GPU'suz
   kurulumda ve `gizli` sınıfta devreye giriyor.

## 6. Bilerek eksik bırakılanlar

- **Bedrock SigV4 imzalama ve Vertex OAuth akışı**: sürücü iskeletleri uç/gövde/hata yolunu doğru
  kuruyor, kimlik üretimi enjekte ediliyor; enjekte edilmezse çağrı yapılmıyor. AWS/Google SDK'sı
  eklemek yeni runtime bağımlılığı demekti — orkestratör onayı olmadan eklemedim (M16 "konfigle açılır"
  hedefi için gereken her şey burada, eksik olan yalnız imza fonksiyonu).
- **Gerçek Agent SDK entegrasyonu (Dalga 2)**: `agentSession` sürücü seçimini, oturum kaydını,
  resumeToken akışını ve kota tüketimini yapar; **çalıştırmayı** `AgentRunner` arayüzüne delege eder.
  Runner enjekte edilmemişse `AgentRunnerNotWiredError`. `packages/execution` bu arayüzü gerçekleyecek.
- **Bütçe/fiyat tablosu ve dolar maliyeti (M19)**: fiyat tablosu konfig kararı, aylık bütçe tek doğruluk
  kaynağı olarak DB'de yaşamalı; bu pakete gömmek iki maliyet kaynağı yaratırdı. `usd: null`.
- **Redis atomik token-bucket (M4/M19)**: süreç-içi bucket yazıldı; çok-replikalı dağıtımda Redis Lua
  gerekecek — `TokenBucket` arayüzü aynı kalarak değiştirilebilir.
- **PII maskeleme çekirdeği (M20)**: maskeleyen `@maestro/pii`; gateway `deps.mask` kancasını,
  fail-closed kapısını, **maskeleme sonrası `assertNoPii` doğrulamasını** ve ReverseMap'i taşıyan
  `unmask` kapanışını sağlar (tur 2 / B8). Maskeleme politikası (`PiiPolicy`) composition root'tan
  gelir; verilmezse `pii`'nin en katı varsayılanı kullanılır.
- **Prompt cache yönetimi (M38)**: sürücüler cache oranını **okur** ve log'a yazar; `cache_control`
  işaretlerini koymak rol promptlarıyla birlikte Dalga 3'te anlamlı.
- **Kota senkronizasyonu**: sağlayıcı başlıklarından gerçek pencere doluluğu okuma (§3.2).

## 7. Sonraki dalgaya bırakılanlar (doğrulayıcının B10-B15'i — orkestratör onayıyla açık)

Bunlar **bilinen ve kabul edilmiş** açıklar; kapatma turu değil, planlama kalemi olarak duruyorlar.

| # | Açık | Neden şimdi değil / önerilen çözüm |
|---|---|---|
| **B10** | Tek `TokenBucket` dört sürücünün hepsinde paylaşılıyor — bulut sürücüsünün yoğunluğu on-prem şeridini de kısıyor | Rate limit zaten süreç-içi ve M19 atomik Redis bucket'ını Dalga 3'e bırakıyor. Doğru düzeltme sürücü (hatta hesap) başına bucket + Redis Lua; `TokenBucket` arayüzü aynı kalarak değiştirilebilir |
| **B11** | Havuzdaki **tüm** koltuklar `enabled:false` iken kuyruk yerine sert `LlmConfigError` | Bugünkü davranış "yanlış konfig" varsayımına dayanıyor; ama kill-switch koltukları kapatarak da çalışabilir (M58). Öneri: hiç *etkin* koltuk yoksa `{ok:false, resumeAt}` + ayrı bir `kill-switch` mesaj anahtarı |
| **B12** | Runner istisna atarsa oturum kaydı yetim kalır; `AgentSessionStore`'un `Map`'i sınırsız büyür | Oturum kalıcılığı DB işidir (bkz. §5 talep #4 ile aynı aile). Öneri: TTL + `abandon(resumeToken)` ve Dalga 2'de DB'ye taşınması |
| **B13** | `drivers[].enabled:false` iken konfig kapısı geçiyor (binding "tanımlı" sayılıyor), hata çalışma anına kayıyor | Bilerek: GPU gelmeden on-prem sürücü pasif dursun diye (M18). Yine de `superRefine` "her rotanın en az bir **etkin** sürücüsü olsun" uyarısı verebilir |
| **B14** | Kota süreç belleğinde; saat ileri sıçrarsa pencere affediyor, süreç yeniden başlarsa sıfırlanıyor | §3.3 + §5 talep #4 ile aynı kalem: `SubscriptionQuotaWindow` tablosu + repository enjeksiyonu |
| **B15** | `postJson` `content-type`'ı sürücü başlıklarının **üzerine** yazıyor; imzalı Bedrock isteğinde ilk kırılacak yer burası | Bedrock/Vertex zaten iskelet ve imzalayıcı enjekte (§6). Duman testi öncesi düzeltilmeli: `content-type` sürücüden gelmişse korunmalı, çünkü SigV4 imzası başlıkların üzerinden hesaplanıyor |
| **—** | Vertex `location:"global"` için host `global-aiplatform…` değil `aiplatform.googleapis.com` olmalı | Aynı duman-testi kalemiyle birlikte; bugünkü URL kurgusu bölgesel uçlar için doğru |
