# `@maestro/cache` — Redis + atomik kota/rate limit (Dalga 5, M4 + M19)

## Özet

M4'ün "Redis" kararı bugüne kadar koda dönmemişti. Dört sonucu vardı:
rate limit süreç içiydi (M19 atomik istiyor), kapasite semaforu yoktu,
dağıtık kilit yoktu, cache katmanı yoktu. Bu paket dördünü de yazar.

**Paket adı: `packages/cache`** — `packages/redis` değil. Gerekçe: paket
*sağladığı şeyle* adlandırılır, arkasındaki teknolojiyle değil. `@maestro/storage`
içinde S3 sürücüsü barındırdığı halde `s3` adını taşımaz; aynı kural. Ayrıca
`cache.*` M4'ün UI'ında zaten kullanılan katalog önekidir (`cache.layers`,
`cache.workspaces`). Redis bir *sürücüdür*: `RedisClient` dikiştir,
`SocketRedisClient` ve `FakeRedisClient` iki uygulamadır.

## Dosyalar

| Dosya | Satır | Ne yapar |
|---|---|---|
| `src/scripts.ts` | 199 | **Lua script'leri — paketin varlık sebebi** |
| `src/socket-client.ts` | 232 | RESP üzerinden tek soket, pipeline, yeniden bağlanma |
| `src/fake-client.ts` | 279 | Bellek içi istemci (test + dev profili) |
| `src/lua-sim.ts` | 165 | Lua script'lerinin TS aynaları, gövdeye göre eşlenir |
| `src/resp.ts` | 146 | RESP2 kodlama/çözme, saf fonksiyonlar |
| `src/token-bucket.ts` | 133 | **Atomik token bucket (M19)** |
| `src/semaphore.ts` | 175 | Kiralı kapasite semaforu |
| `src/lock.ts` | 148 | Dağıtık kilit (fencing token'lı) |
| `src/cache.ts` | 128 | TTL'li anahtar/değer cache |
| `src/client.ts` | 108 | Bağlantı seçenekleri, `REDIS_URL` ayrıştırma |
| `src/config.ts` | 85 | Mod seçimi (redis / memory) |
| `src/script-runner.ts` | 51 | EVALSHA + NOSCRIPT geri düşüşü |
| `src/errors.ts` | 82 | Hata tipleri |

Hepsi ≤300 satır. TypeScript strict, ESM (`.js` uzantılı import'lar).

Üçüncü parti bağımlılık: **sadece `zod`**. `ioredis` alınmadı — bu paket altı
fiil kullanıyor (EVAL, EVALSHA, SCRIPT, GET/SET/DEL, HMGET/HSET, Z*) ve bir
bankada bağımlılık incelemesi paket başına gerçek bir maliyet. Depo zaten aynı
sebeple kendi tel formatlarını yazıyor: `@maestro/storage` S3'ü ham HTTP + kendi
SigV4'üyle, `@maestro/runners` Docker'ı ham unix soketiyle konuşuyor.

## Atomiklik kanıtı

Tek Lua script'te "oku, hesapla, yaz". Redis script'i **tek birim** olarak
çalıştırır; başka bir istemcinin komutu araya girmez. Başka yolu yok: Redis'te
hash alanı için compare-and-swap yok, WATCH/MULTI ise her çekişmeli isteği,
başarısızlık oranı tam da hayatta kalması gereken eşzamanlılıkla birlikte artan
bir yeniden deneme döngüsüne çevirirdi.

### Eşzamanlı test sonuçları (`test/atomicity.test.ts`, sahte istemci)

| Senaryo | Beklenen | Ölçülen |
|---|---|---|
| 100 eşzamanlı istek, kapasite 10 | 10 | **10** |
| Aynısı kapasite 1 / 3 / 7 / 25 | 1 / 3 / 7 / 25 | **1 / 3 / 7 / 25** |
| 20 eşzamanlı `take(cost=3)`, kapasite 12 | 4 | **4** |
| 10 eşzamanlı semafor talebi, kapasite 3 | 3 | **3** |
| Semafor churn (10 işçi × 5 tur), kapasite 3 | zirve ≤ 3 | **zirve 3, sızıntı 0** |
| 50 eşzamanlı kilit talebi | 1 | **1** |
| Kilit altında 20 eşzamanlı read-modify-write | 20 | **20** |

Hepsi `Promise.all` ile, sırayla değil. `FakeRedisClient.send` state'e dokunmadan
önce bir mikrogörev bekler — bu yüzden yüz `take` gerçekten iç içe geçer.

### Gerçek Redis (`test/redis-integration.test.ts`, 21 test)

`docker run --rm -d -p 56379:6379 redis:7-alpine` ile koşturuldu, **21/21 yeşil**.
Aynı senaryolar, gerçek `EVALSHA`, gerçek Lua. Sahte istemcinin TS aynaları elle
yazıldığı için üretimdeki Lua'dan sapabilirdi — bu dosya o kontrolü yapar.

Çalıştırma:

```
docker run --rm -d -p 56379:6379 --name maestro-redis redis:7-alpine
MAESTRO_REDIS_URL=redis://127.0.0.1:56379 pnpm --filter @maestro/cache test
```

`MAESTRO_REDIS_URL` yoksa **`describe.skipIf` ile atlanır** (erken `return`
değil — atlanan süit "atlandı" diye raporlanır, "0 test koştu" yanlışlıkla
"hepsi geçti" okunamaz). Kapı bir konteynerin ayakta olmasına bağlı olmamalı.
Bu dosyayı "hiç koşmayan test"e çevirmeyen şey: kapsadığı mantık **sahte
istemciyle de** kapsanıyor; bu dosya üstüne tel ve Lua seviyesinde doğrulama
ekliyor, tek kanıt yeri değil.

### Mutasyon kanıtı (`test/mutation.test.ts` — kalıcı, 7 test)

"100'de tam 10" iddiası, bozuk bir uygulamada da geçseydi değersiz olurdu. Bu
dosya bozuk uygulamayı **kurar** ve `atomicity.test.ts`'in yaptığı iddiaların
çöktüğünü doğrular:

| Mutant | Atomik sürüm | Mutant sonucu |
|---|---|---|
| Bucket → HMGET / hesapla / HSET (3 komut) | 10 | **100** (hepsi dolu kova gördü) |
| Aynısı kapasite 1/3/7/25 | tam | **hepsi > kapasite** |
| Semafor → ZCARD / karar / ZADD | 3 | **10** (hepsi ZCARD=0 gördü) |
| Kilit release → GET / karşılaştır / DEL | halefin kilidi durur | **halefin kilidi silinir** |

Ayrıca `redis-integration.test.ts` içinde **gerçek Redis'e karşı** aynı iki
mutant koşuyor — sahte istemcinin `await Promise.resolve()`'unun yarışı
uydurmadığını göstermek için.

Bu mutantlar kalıcı olarak duruyor: eğer bir gün `naiveTake` tam 10 vermeye
başlarsa, bu dosya kırmızıya döner ve bu **sahte istemcinin iç içe geçirmeyi
bıraktığı** anlamına gelir — o an paketteki her atomiklik iddiası sessizce
doğrulanmamış hale gelmiş olurdu. Yani bunlar bir kereye mahsus deney değil,
test koşumunun kendisi üzerinde canlı bir kontrol.

### Semafor TTL (sahibi çökerse)

Her izin **kiralıdır**. Çöken bir sahip release çalıştıramaz; kirasız izin
kimse fark edene kadar kaybolurdu ve her çökmede bir izin sızdıran semafor
sıfır kapasiteye yakınsar — bu tam olarak "kilitlenmiş sistem" gibi görünür.

Sayaç (INCR/DECR) **tek bir** sahibi süresi dolmuş sayamaz. Bu yüzden sıralı
küme (zset) kullanılıyor: üye = sahip token'ı, skor = bitiş zamanı. Her acquire
önce süresi dolmuş üyeleri düşürür, dolayısıyla çöken sahibin izni kendiliğinden
havuza döner — yüksek erişilebilir olması gereken bir toplayıcı süreç olmadan.

Kanıtlanan davranışlar: süresi dolan izin geri alınır (hem sahte hem gerçek
Redis); kira **tam** süresi kadar tutar (4999 ms'de hâlâ dolu, 5001 ms'de boş);
`renew` canlı izni uzatır; **süresi dolmuş izin `renew` edilemez** (`ZADD XX` —
takılmış bir sahip, semaforun çoktan başkasına verdiği izni diriltemez); geç
gelen `release` sayacı ikinci kez düşürmez, `false` döner.

## Redis'siz çalışma (dev profili)

`FakeRedisClient` **desteklenen bir yapılandırma**, düşmüş bir geri düşüş değil:
tek BFF, tek worker, konteyner yığını olmayan geliştirici makinesi. Yalnızca
tek süreç *olduğu için* doğru, o yüzden açıkça seçilir ve `Coordination.distributed`
gerçekte ne alındığını raporlar. İkisi için de "rate limiting: on" yazan bir boot
banner'ı sorunun ta kendisi olurdu.

`resolveCacheMode(env)`:
- `REDIS_URL` varsa → `redis`
- yoksa ve `NODE_ENV !== production` → `memory`
- yoksa ve `NODE_ENV === production` → **`CacheConfigError` fırlatır**

Üretimde sessiz geri düşüş yok. Sebebi düzen değil: `REDIS_URL` olmadan her
replika kendi token bucket'ını tutar, N replika yapılandırılan LLM hızının ve
sandbox kapasitesinin N katını verir. Bu bir bozulma değil, bir fatura ve bir
kesinti — bir sağlayıcının faturasıyla keşfedilir.

`buildCoordination({ requireDistributed: true })` `memory` modunu tümden reddeder.

## `packages/config` değişikliği

`EnvSchema`'ya `REDIS_URL` eklendi (opsiyonel). `z.url()` **değil** `z.string()`:
Zod'un URL kontrolü tanıdığı bir şema istiyor ve `redis://` / `rediss://` reddediliyor.
Asıl doğrulamayı `parseRedisUrl` yapıyor — şema, host, veritabanı indeksi — ve
bunu **boot'ta** yapıyor, yani hatalı değer yine operatörün önünde patlıyor.

**`REQUIRED_IN_PROD` listesine EKLENMEDİ** — bilinçli. Bu liste `apps/deploy`'un
prod profil testleri dahil düzinelerce testin dayandığı çapraz kesen bir
sözleşme ve paralel ajanlar orada çalışıyor olabilir. Aynı fail-closed garantisi
`resolveCacheMode` içinde, composition root'un çağırdığı yerde duruyor.
**Öneri:** dalga birleştikten sonra `REDIS_URL` `REQUIRED_IN_PROD`'a taşınsın ve
`packages/config/test/config.test.ts` ile deploy'un prod profil fixture'ları
birlikte güncellensin.

## compose.yaml değişikliği (minimal)

Paralel ajanlar da compose'a dokunuyor olabileceği için değişiklik dar tutuldu:

1. `redis` servisi (`redis:7-alpine`, `REDIS_IMAGE` ile digest'lenebilir)
2. `x-node-env` içine `REDIS_URL: redis://redis:6379`
3. `bff` ve `worker` için `depends_on: redis: service_healthy`
4. Başlıktaki bağımlılık şemasına bir satır

Servis kararları:
- **Kalıcılık yok** (`--save ""`, `--appendonly no`, volume yok). Tuttuğu her
  şey türetilebilir: kovalar dolar, izinler süresi dolar, cache'in TTL'i var.
  Rate limit kontrolü başına disk yazımı istek yolundaki en yavaş şey olurdu —
  en kötü kayıp bir dolmuş kova.
- **`--maxmemory-policy volatile-ttl`**. Varsayılan `noeviction` dolu bir Redis'i
  yazma reddeden bir şeye çevirir — yani limitleyen değil **hata veren** bir rate
  limiter. Buradaki her anahtarın TTL'i var, bitişe en yakını atmak doğru cevap.
- **Host'a yayınlanmıyor** (`expose`, `ports` değil). Host portundaki kimliksiz
  bir Redis, bir makineyi kaybetmenin bilinen yolu.
- `no-new-privileges`, `cap_drop: ALL`.

`deploy/.env.example`: `REDIS_URL`, `REDIS_IMAGE`, `REDIS_MAXMEMORY` belgelendi
(compose testi her interpolasyonun belgelenmesini şart koşuyor — doğru şekilde
yakaladı). `apps/deploy/test/compose-file.test.ts`'e redis için 8 assert eklendi
(238 test, önceki 230).

## Composition root'a eklenmesi gereken satırlar

`apps/deploy/src/registry.ts`'e **DOKUNULMADI** — paralel ajanlar orada
çalışıyor olabilir. Ayrıca koordinasyon bir *port* değil, `PortRegistry` port→
sürücü tablosu; `Coordination` oraya doğal olarak oturmuyor.

Önerilen bağlama, `apps/deploy/src/boot.ts` içinde (`bootPlatform`, `buildRegistry`
çağrısından **önce**, çünkü LLM gateway'in bucket'ı buna bağlanacak):

```ts
// apps/deploy/src/boot.ts — import bloğuna
import { buildCoordination, resolveCacheMode, RedisTokenBucket, RedisSemaphore, RedisCache, RedisLock } from "@maestro/cache";

// bootPlatform içinde, `const work = buildWorkPort(...)` satırından önce:
const coordination = buildCoordination({
  mode: resolveCacheMode({ REDIS_URL: env.base.REDIS_URL, NODE_ENV: env.base.NODE_ENV }),
  url: env.base.REDIS_URL,
  // prod profili tek süreçli koordinasyonu kabul etmez
  requireDistributed: env.profile === "prod",
});
```

`apps/deploy/package.json` → `dependencies` içine `"@maestro/cache": "workspace:*"`.

`logWiring`'e bir satır (boot banner'ı gerçekte ne alındığını söylemeli):

```ts
`[maestro] coordination: ${deployment.coordination.mode} (distributed=${deployment.coordination.distributed})\n`
```

### LLM gateway'in bucket'ının değiştirilmesi (M19'un asıl amacı)

`packages/llm-gateway/src/gateway.ts:96` bugün `new TokenBucket(cfg.rateLimit, this.now)`
kuruyor. **Mevcut süreç-içi `TokenBucket` silinmedi** — yerinde duruyor ve tek
süreç için doğru. İkisi çağrı yerinde birbirinin yerine geçecek şekilde
tasarlandı (`take()` → bekleme milisaniyesi), yani composition root birini seçer
ve hiçbir çağıran dallanmaz.

Bunun için `LlmGatewayDeps`'e opsiyonel bir `bucket` alanı gerekiyor — bkz.
**ARAYÜZ İSTEĞİ 1**. Gateway `packages/llm-gateway`'de, `packages/ports`'ta değil,
yani bu donmuş bir dosya değil; ama başka bir ajan orada çalışıyor olabileceği
için ben dokunmadım.

## ARAYÜZ İSTEKLERİ

**1. `LlmGatewayDeps` (`packages/llm-gateway/src/*`) — DONMUŞ DEĞİL ama başkasının alanı**

M19'un tamamlanması için gateway'in bucket'ı enjekte edilebilir olmalı:

```ts
export interface LlmGatewayDeps {
  // ...mevcut alanlar
  /**
   * Rate limiter. Verilmezse süreç-içi TokenBucket kurulur — tek süreçte
   * doğru, çok replikalı dağıtımda her replikaya tam kota verir (M19).
   * Prod'da composition root buraya RedisTokenBucket bağlar.
   */
  readonly bucket?: { take(): number | Promise<number> };
}
```

Dikkat: `RedisTokenBucket.take()` **async**. Bugünkü `TokenBucket.take()` senkron
ve `http.ts:91` `const wait = ctx.bucket.take()` diyor. `postJson` zaten `async`
olduğu için `await ctx.bucket.take()` tek satırlık bir değişiklik, ama arayüzün
`number | Promise<number>` dönmesi gerekiyor. Bu değişikliği ben yapmadım.

**2. `packages/ports` — DONMUŞ, ekleyemem**

Koordinasyon için bir port arayüzü **istemiyorum**. Gerekçe: `PortRegistry` "bu
dağıtım hangi somut teknolojiyi konuşabilir" tablosu ve sürücüler profil
tarafından seçiliyor. Koordinasyon bir sürücü seçimi değil, bir altyapı
gerçeği — `redis` ya da `memory`, ve ikincisi yalnızca tek süreçte doğru. Port
soyutlamasına sokmak, üretimde `memory` sürücüsünün seçilebilir görünmesine yol
açardı; asıl önlenmek istenen şey bu. `packages/ports`'ta **hiçbir değişiklik
istenmiyor.**

## Yapmadıklarım

- **`registry.ts`'e dokunmadım.** Paralel ajanlar orada. Gereken satırlar yukarıda.
- **`llm-gateway`'e dokunmadım.** Süreç-içi `TokenBucket` yerinde; Redis'li olan
  yanında. Bağlama ARAYÜZ İSTEĞİ 1'e bağlı.
- **`IdempotencyGuard`'a dokunmadım.** Paralel ajan tablo destekli sürümü yazıyor;
  ben yalnızca kilidi sunuyorum (`RedisLock`). `packages/workflows/src/impl/idempotency.ts`
  açılmadı bile.
- **`REDIS_URL`'i `REQUIRED_IN_PROD`'a eklemedim.** Gerekçe ve öneri yukarıda.
- **Katalog anahtarı eklemedim.** Bu paket kullanıcıya görünen metin üretmiyor —
  hataları operatöre/geliştiriciye giden teknik mesajlar (mevcut `packages/*`
  hata sınıflarıyla aynı desen). tr/en **1337'şer** anahtar, bozulmadı.
- **Cluster/Sentinel desteği yok.** `RedisLock` tek düğüm kilididir ve dosyada
  bunu açıkça söylüyor: failover sırasında iki sahip olabilir. İki hedef çağıran
  (idempotency guard, denetim zinciri) veritabanı kısıtıyla destekli — kilit
  çekişmeyi kaldırır, kısıt doğruluğu sağlar. Böyle bir dayanağı **olmayan** bir
  çağıran bunu yeterli saymamalı. Redlock gerekiyorsa ayrı bir iş.
- **RESP3 yok.** RESP2 her Redis'in varsayılan cevabı ve gönderdiğim hiçbir
  komutun RESP3 biçimi ek bilgi taşımıyor.
- **`RedisCache.getOrSet` single-flight değil.** İki eşzamanlı miss ikisi de
  hesaplar. Bilinçli: single-flight her miss'te kilit almak demek, yani asıl işi
  önündekinden hızlı olmak olan bir cache'in sıcak yoluna bir Redis gidiş-dönüşü
  ve bir hata modu koymak. Gerçekten mükerrer hesaplamayı kaldıramayan çağıran
  `RedisLock`'u açıkça kullanmalı.

## Fail-open / fail-closed asimetrisi

Yalnızca `RedisCache` **fail-open** olabilir ve sebebi özel: çağıran açısından
cache miss'i ile cache kesintisi aynı doğru cevabı gerektirir — yeniden hesapla.
Kesintiyi fırlatmaya çevirmek, hâlâ yavaşça çalışabilecek bir servisi durdurmak
olurdu. Gözlemlenebilir: `onError` geri çağrısı yutulan her hatayı bildirir,
yoksa kalıcı olarak ölü bir cache kalıcı olarak soğuk bir cache gibi görünür.

Bu gerekçe rate limiter, semafor ve kilide **uzanmaz**. Orada fail-open =
sağlayıcının hız limitini aşmak, filonun kaldıramayacağı kadar sandbox
çalıştırmak, iki worker'ın aynı denetim halkasını yazması. Onlar fırlatır.
`failOpen` yalnızca `RedisCache`'te var, başka yerden erişilemesin diye.

## Test özeti

```
test/atomicity.test.ts          22  eşzamanlılık, TTL, kira
test/mutation.test.ts            7  mutantlar (kalıcı)
test/lua-sim.test.ts            24  ayna/script eşliği + sahte mağaza semantiği
test/config.test.ts             22  URL ayrıştırma, mod seçimi, EnvSchema entegrasyonu
test/primitives.test.ts         22  yapılandırma reddi, hold/withLock sarmalayıcıları
test/resp.test.ts               21  RESP2 kodek
test/socket-client.test.ts      13  gerçek soket (loopback), pipeline, yeniden bağlanma
test/cache.test.ts              16  cache + ScriptRunner
test/redis-integration.test.ts  21  GERÇEK Redis (opt-in)
                               ───
                               168  (Redis'siz 147, 21 atlanır)
```

Ağ çağrısı yok. `socket-client.test.ts` 127.0.0.1'de kendi `net.createServer`'ını
kurar — mock'lanmış bir taşıma katmanı, parçalı okuma/pipeline/yeniden
bağlanma/timeout hakkında kodun değil kendimizin doğru olduğunu iddia ettirirdi.

## Kapı durumu ve rastladığım iki mevcut flake

`pnpm run gate` → **exit 0, 58/58 görev**. (56 değil 58: yeni paket bir
`typecheck` ve bir `test` görevi ekliyor.)

Kapıyı üç kez koşturdum. Üçüncüsü temiz geçti; ilk ikisinde **dokunmadığım iki
pakette** birer test düştü. İkisi de yüke duyarlı, ikisi de tek başına koşunca
geçiyor — `scripts/gate.mjs`'in başlığındaki "yüklü kapıda zamanlama varsayımı
olan testler yarışı kaybediyor" notunun tarif ettiği şey:

1. **`@maestro/pii` → `test/egress-gate.test.ts`** — "keeps raw PII the model
   wrote out of the copy that is persisted". Hata `iban` tespiti, oysa test
   TCKN üzerine. Maskeleme token'ı `[TCKN_2.<8 hex>]` biçiminde ve **rastgele**
   hex üretiyor; bu hex ara sıra IBAN dedektörünü tetikliyor. Yani gerçek bir
   flake, benimle ilgisiz. Tek başına 1/1 geçti.
2. **`@maestro/storage` → `test/s3-response.test.ts`** — "stops at the page
   ceiling instead of looping forever". 5 sn vitest timeout'unda düştü. Test
   10.000'e kadar XML sayfası ayrıştırıyor ve **tek başına bile 2.3 sn** sürüyor;
   yüklü kapıda 5 sn'yi aşıyor. Tek başına 12/12 geçti.

İkisi de benim paketimde değil ve paralel ajanlar oralarda çalışıyor olabilir,
bu yüzden **dokunmadım**. Sahiplerine not: (1) maskeleme token'ı dedektöre
yakalanmayacak bir alfabe kullanmalı ya da `assertNoPii` maskelenmiş bölgeleri
atlamalı; (2) o test için `testTimeout` yükseltilmeli ya da tavan 10.000'den
küçük bir sayıyla kanıtlanmalı.

Kendi paketimin determinizmi ayrıca ölçüldü: **Redis'siz 10/10 koşu**
(147 passed | 21 skipped), **gerçek Redis'le 5/5 koşu** (168 passed). Sapma yok.

## Bulunan ve düzeltilen hata

`SocketRedisClient.close()` uçuştaki komutları reddediyordu, ama `send`'in
yeniden deneme döngüsü bunu bir bağlantı hatası sanıp yeniden bağlanıyordu —
çağıran "closed" yerine bir timeout görüyordu. Ayrıca `socket.end()`'in
tetiklediği `close` olayı aynı bekleyenleri **ikinci kez** reddediyor ve bu
işlenmemiş bir promise reddi olarak süreci düşürüyordu. İkisi de düzeltildi
(`socket-client.ts`, `close()` içinde dinleyicilerin sökülmesi + `#closed`
kontrolü); `socket-client.test.ts` ikisini de kilitliyor.
