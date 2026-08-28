# DOĞRULAMA — Dalga 5 (veri katmanı)

**Denetçi:** bağımsız doğrulayıcı ajan
**Kapsam:** `apps/deploy/src/stores/` (8 dosya) · `packages/db/prisma/migrations/0004_*` · `packages/cache/`
**Yöntem:** kod okuma + **gerçek Postgres 18** ve **gerçek Redis 7** karşısında çalıştırma + **14 mutasyon testi**
**Tarih:** 2026-08-09

---

## 0. Nasıl doğrulandı (rapora değil, koda ve çalışan sisteme bakıldı)

Geçici konteynerler kaldırıldı (iş bitince **silindi**, `uinfra-postgres`'e dokunulmadı):

```
postgres:18-alpine  -> localhost:55434
redis:7-alpine      -> localhost:56399
```

Yapılanlar:

- 0001→0004 migration'ları **sırayla gerçek Postgres'e uygulandı** — dördü de hatasız geçti.
- `apps/deploy/test/live-stores.test.ts` (normalde `TEST_DATABASE_URL` yoksa **atlanır**) gerçek veritabanına karşı koşuldu: **11/11 yeşil**.
- `packages/cache` tüm paket + `redis-integration.test.ts` gerçek Redis'e karşı: **168/168 yeşil**.
- Ajanın eşzamanlılık iddiaları **daha ağır yükle** yeniden sınandı (2 değil, 8–12 bağımsız bağlantı havuzu).
- **14 mutasyon** yapıldı (boz → koş → geri al). Hepsi geri alındı; `git status` temiz.
- Hatalı `DATABASE_URL` / `REDIS_URL` ile parola sızıntısı arandı.
- Redis düşükken rate limiter/semafor/kilit davranışı ölçüldü.

Temel sayılar (doğrulandı, rapordan kopyalanmadı):

| Süit | Sonuç |
|---|---|
| `apps/deploy` (çevrimdışı) | 315 geçti, 11 atlandı (326) |
| `apps/deploy` + gerçek PG | 11/11 (`live-stores`) |
| `packages/db` | 170 geçti, 7 atlandı |
| `packages/cache` + gerçek Redis | 168/168 |
| `tsc --noEmit` (deploy, cache) | temiz |

---

## BULGULAR

### 🔴 K-1 — `GateStore.open` eşzamanlılıkta **idempotent DEĞİL**; belgelenen iddia gerçek dışı

**Dosya:** `apps/deploy/src/stores/gates.ts:105-112` (ve yorum `gates.ts:96-104`)

Kodun kendi yorumu şunu iddia ediyor:

> *"`upsert` with an EMPTY update is the whole trick: two workers racing the same signal both issue it, one inserts, the other's update writes nothing and returns the existing row."*

**Bu iddia yanlış.** Prisma'nın `upsert`'ü bileşik birincil anahtarda **`ON CONFLICT` üretmiyor**; `SELECT` sonra düz `INSERT` yapıyor — yani klasik read-then-write yarışı.

**Kanıt 1 — Postgres'in kendi sorgu logu** (`log_statement=all`):

```sql
s1: SELECT "runId","step" FROM "Gate" WHERE ("runId"=$1 AND "step"=$2) OFFSET $3
s2: INSERT INTO "Gate" ("runId","step","ownerGroup","openedAt","firedStepIds")
    VALUES ($1,$2,$3,$4,$5) RETURNING "runId","step"      -- ON CONFLICT YOK
```

Yarışı kaybedenler:

```
ERROR: duplicate key value violates unique constraint "Gate_pkey"
```

**Kanıt 2 — ölçüm (soğuk satır, yani gate ilk kez açılırken):**

| Senaryo | Sonuç |
|---|---|
| 12 havuz, 10 deneme, her denemede satır silinir | **99 hata / 120 çağrı**; 9/10 denemede en az bir P2002 |
| 3 havuz, 20 deneme | **19/20 denemede hata**, 38 başarısız çağrı / 60 |
| **2 havuz** (sevk edilen testin senaryosu), 30 deneme | **28 hata / 60 çağrı** |
| Satır zaten varsa (sıcak) | 0 hata / 40 çağrı |

**Neden sevk edilen test bunu yakalamıyor:** `live-stores.test.ts:88` ("opens exactly one gate when two workers race the same signal") yalnızca `rows.length === 1` ve `openedAt` eşitliğini doğruluyor; `open()`'ın **fırlattığını** kontrol etmiyor — `Promise.all` içindeki reddi de yakalamıyor çünkü aslında testte satır çoğu kez önceki testlerden sıcak kalıyor. Testi soğuk satırla 30 kez tekrarladığımda **28 kez kırmızı**.

**Neden önemli:** Gate açma sinyali M88 tırmanma merdiveninin çapası. İki worker (ya da bir Temporal activity retry'ı) aynı anda `open` çağırdığında biri **P2002 ile patlıyor**. Bu bir onay kapısının açılmaması, dolayısıyla onaycılara bildirim gitmemesi ve merdivenin hiç başlamaması demek — bankada "kimse onaylamadı" diye bekleyen bir koşu. Üstelik hata `GateNotFoundError` gibi anlamlı bir tip değil, ham Prisma `P2002`.

**Düzeltme:** `open`'ı ham `INSERT ... ON CONFLICT ("runId","step") DO NOTHING` + ardından `findUnique` ile yazmak (idempotency.ts'teki `sqlClaimExecutor` ile **tam olarak aynı** desen — o dosya bunu doğru yapıyor), veya P2002'yi yakalayıp mevcut satırı okumak.

---

### 🟠 Y-1 — Sevk edilen eşzamanlılık testleri yarışı gerçekten kurgulamıyor (yanlış güven)

**Dosya:** `apps/deploy/test/live-stores.test.ts:88-105`

Üç ayrı zayıflık, K-1'in kaçmasının sebebi:

1. **Reddedilen promise sayılmıyor.** Test `open()`'ın çözülmesini varsayıyor; ben `.catch()` ile saydığımda hataların çoğunlukta olduğu ortaya çıktı.
2. **Tek deneme.** Yarış olasılıksal; 1 deneme kanıt değil. 20–30 denemede tablo tersine dönüyor.
3. **Soğuk/sıcak ayrımı yok.** Yarış yalnızca satır **yokken** var; test sırası satırı sıcak bırakabiliyor.

Aynı zayıflık `markFired` testinde de var (satır zaten açılmış olduğu için oradaki `push` gerçekten güvenli — bu testte sorun yok, ama desen aynı).

**Neden önemli:** Bu testler "veritabanı garantileri kanıtlandı" iddiasının dayanağı. Şu hâlleriyle **var olan bir üretim hatasını yeşil gösteriyorlar**.

---

### 🟠 Y-2 — `packages/cache` içinde iki bağımsız Lua uygulaması; mutasyonlar sessizce hayatta kalıyor

**Dosyalar:** `packages/cache/src/scripts.ts` (gerçek Lua) ve `packages/cache/src/lua-sim.ts` (elle yazılmış TypeScript kopyası)

`lua-sim.ts` aynı mantığı ikinci kez uyguluyor (`lua-sim.ts:69-71` refill, `:94`/`:125` `ZREMRANGEBYSCORE`, `:128` `ZADD XX`). Testlerin büyük çoğunluğu `FakeRedisClient` üzerinden **simülatörü** çalıştırıyor; yalnızca `redis-integration.test.ts` gerçek Lua'ya gidiyor.

Sonuç — gerçek Lua'yı bozdum, **tüm 168 test yeşil kaldı**:

| Mutasyon (yalnız `scripts.ts`) | Sonuç |
|---|---|
| MUT-2: semafor acquire'dan `ZREMRANGEBYSCORE` silindi | **168/168 GEÇTİ (hayatta kaldı)** |
| MUT-3: `ZADD XX` → `ZADD` (süresi dolmuş izni dirilt) | **168/168 GEÇTİ (hayatta kaldı)** |
| MUT-5: `if elapsed < 0 then elapsed = 0` silindi (saat geri gidince token basma) | **168/168 GEÇTİ (hayatta kaldı)** |
| MUT-1: token bucket her zaman izin versin | 4 test kırıldı ✔ |
| MUT-4: kilit release'inde sahip karşılaştırması silindi | 1 test kırıldı ✔ |

**Not — MUT-3 özel bir durum:** "refuses to renew an expired permit (**ZADD XX**)" adlı test `XX` kaldırılınca bile geçiyor. Nedenini izole ettim: `SEMAPHORE_RENEW_LUA` içinde önce `ZREMRANGEBYSCORE` süresi dolmuş üyeyi siliyor, ardından `ZSCORE ... == false` erken dönüyor; **`ZADD XX` satırına hiç ulaşılmıyor**. Yani `XX` gerçek koruma değil, ikinci savunma hattı (**ölü yol**, §5.1). Bunu kanıtlamak için hem guard'ı hem `XX`'i birlikte kaldırdım (MUT-6) → test **kırmızıya döndü**. Yani asıl koruma `ZSCORE` guard'ı; testin adı yanıltıcı.

**Neden önemli:** Bu üç davranış (çökmüş sahibin izninin geri dönmesi, saat geri gidince token basılmaması) M4/M19'un çekirdek güvenlik özellikleri ve **gerçek üretim yolunda test edilmiyor**. Bir gelecek düzenleme Lua'yı bozarsa CI yeşil kalır.

**Düzeltme:** `redis-integration.test.ts`'e bu üç senaryo için gerçek-Redis testi eklemek; ya da simülatörü test edilen tek kaynak olmaktan çıkarmak.

---

### 🟡 O-1 — `params.ts` sürüm sıralaması yalnızca sahte nesnenin sabit sıralaması sayesinde doğru görünüyor

**Dosya:** `apps/deploy/test/params.test.ts:37-45`

Sahte `paramVersion.findMany` gelen `orderBy` argümanını **yok sayıp** her zaman `version` azalan sıralıyor:

```ts
return Promise.resolve([...candidates].sort((a, b) => b.version - a.version));
```

MUT-14 ile gerçek sorguyu `orderBy: { version: "asc" }` yaptım → **71/71 test geçti** (mutasyon hayatta kaldı), oysa bu "en eski parametre sürümü kazanır" demek olurdu.

**Ancak:** gerçek Postgres'e karşı kendi testimi yazdım (aynı anahtarın v1=`OLD`, v2=`NEW` sürümleri) → `publishTargets` **`["NEW"]`** döndü. Yani **üretim kodu doğru**; kusur testin kanıtlama gücünde. Bu yüzden K/Y değil, O.

Aynı dosyadaki scope önceliği (uygulama > proje > global) MUT-11 ile sınandı → **3 test kırıldı** ✔ — bu gerçekten korunuyor.

---

### 🟡 O-2 — `AgentTurnRunner` bağlı değil: worker açılıyor ama mühendislik turu çalışmıyor

**Dosyalar:** `apps/deploy/src/stores/execution.ts:23-32`, `apps/deploy/src/bin/worker.ts:44`

`MISSING_CORE_DEPS` gerçekten boş (`boot.ts:244`) — doğruladım, worker artık iş kuyruğuna abone oluyor. Ama `execution.runTurn` **her zaman reddediyor**:

> "execution: no AgentTurnRunner is wired. `AgentExecution` needs a WorkspaceProbe, a VerificationRunner and a StrikeLedger... none of the three is implemented yet"

Çağrı yerleri: `packages/workflows/src/impl/engineering.ts:107` ve `:220` — yani **mühendislik turu (kod yazma/doğrulama döngüsü) tamamen çalışmaz**. `endRun` bilinçli olarak no-op (gerekçesi makul: gerçek hata mesajını gizlememek için).

**Değerlendirme:** Bu bir **kusur değil, bilinçli ve dürüst bir fail-closed seam** — sessizce yanlış iş yapmıyor, net mesajla reddediyor. Ancak "Dalga 5 bitti, worker iş alıyor" ifadesi **yanıltıcı**: worker iş alıyor ama koşunun çekirdek adımı ilk turda hata veriyor. Prod imajı açısından kritik (bkz. son bölüm).

---

### 🟡 O-3 — `AuditChain` INSERT'i kilit transaction'ının dışında commit oluyor (ajanın itirafı) — **ama zincir kırılmadı**

**Dosya:** `apps/deploy/src/stores/audit.ts:100-113`

Ajanın itirafı doğru: `ChainLock.withLock` sıfır argümanlı callback aldığı için (`packages/audit/src/chain.ts:25`) INSERT havuzdaki başka bir bağlantıdan, kilit transaction'ının **dışında** commit oluyor.

**Sınadım — kırılmadı:**

- 8 bağımsız `PrismaClient` havuzu, **48 eşzamanlı append**: 0 hata, `seq` 1..48 **boşluksuz**, `verify()` → `ok: true`, 48 kayıt hash zinciriyle doğrulandı.
- MUT-13 ile `pg_advisory_xact_lock` satırını sildim → **2 test kırıldı** ✔. Yani kilit **gerçekten yük taşıyor**, dekoratif değil.

**Neden hâlâ O:** Sıralama doğru (INSERT `fn` çözülmeden önce, yani kilit bırakılmadan önce olur) ve `seq`/`hash`/`prevHash` üzerindeki unique index'ler son savunma. Ancak atomik olmadığı için teorik bir pencere var: INSERT commit olduktan sonra kilit transaction'ı **rollback** olursa (bağlantı kopması), kilit serbest kalır ama kayıt kalır — bu zararsız; tersi (kayıt yok, kilit commit) de zararsız. Gerçek risk düşük, ama iddia edildiği gibi "tam atomik" değil. Arayüz değişikliği (`withLock`'un handle geçirmesi) doğru çözüm.

---

### 🟢 D-1 — `ZADD XX` ölü yol

`scripts.ts:176` — yukarıda MUT-6 ile kanıtlandı: `ZSCORE` guard'ı yüzünden bu satıra erişilmiyor. Zararsız savunma derinliği, ama test adı (`"...(ZADD XX)..."`) yanlış şeyi test ettiğini iddia ediyor.

### 🟢 D-2 — `firstAvailableDirectory` boş liste ile hata arasındaki ayrım

`directory.ts:69-94` — Bir reader boş dönerse zincir devam ediyor, **hepsi** hata verirse `AggregateError` fırlıyor. Bu doğru fail-closed tasarım (LDAPS kesintisi "bu kapının onaycısı yok"a dönüşmüyor). Kusur değil, teyit.

---

## §5 Kontrol listesi — madde madde

| # | Kontrol | Sonuç |
|---|---|---|
| 1 | **Ölü yol** | `ZADD XX` ulaşılamaz (D-1). Başka ölü tablo/sütun yok — 0004'ün eklediği 11 sütun + 3 tablonun hepsi okunuyor/yazılıyor (`run-context.ts`, `gates.ts`, `idempotency.ts`, `publish-state.ts`). |
| 2 | **Fail-open** | **Yok.** `RunNotFoundError`, `IncompleteRunContextError`, `GateNotFoundError`, `MissingParamError`, `UnknownRunError` — hepsi fırlatıyor. Ölü veritabanıyla denedim: `PrismaClientInitializationError` fırlıyor, sessiz boş nesne dönmüyor. Tek bilinçli fail-open `RedisCache` (belgelenmiş ve doğru gerekçeli); rate limiter/semafor/kilit **fırlatıyor** (ölçtüm). |
| 3 | **Halüsinasyon entegrasyon** | Yok. Migration 0004 ↔ `schema.prisma` **birebir tutarlı**; 4 migration gerçek Postgres'e sırayla uygulandı, `tsc` temiz. Prisma alan adları gerçek (`changedBy`/`at` gibi alanları şemadan doğruladım). |
| 4 | **Test gerçek mi** | **14 mutasyon** yapıldı; **10'u yakalandı, 4'ü hayatta kaldı** (MUT-2/3/5 → Y-2; MUT-14 → O-1). Ayrıntı aşağıda. |
| 5 | **ID/anahtar tutarlılığı** | Tutarlı. `runId_step` bileşik anahtar hem şemada hem kodda aynı; `IdempotencyKey.key` yazan/okuyan aynı; audit `metaJson.ticketKey` ile `ticketOfRun` eşleşiyor; `TERMINAL_STATUSES` hem store'da hem 0002'nin kısmi unique index'inde `('done','cancelled')` — **gerçek veritabanında doğruladım**. |
| 6 | **Auth/yetki** | Depo katmanı yetki atlamıyor — yetki üst katmanda (M32/M51). `PrismaDirectoryReader` pasif kullanıcıları sorguda dışlıyor (`active: true`), böylece ayrılmış onaycıya hatırlatma gitmiyor. `GateStore.decisions` yalnızca `humanOnly` olan `GATE_APPROVE`/`GATE_REJECT` aksiyonlarını okuyor ve **contract şemasıyla parse ediyor** (cast değil) — imzasız onay geçemiyor. |
| 7 | **Spec dışına taşma** | Yok. Store'lar dar delegate arayüzleriyle sınırlı; `publish-state.ts` değeri opak metin olarak tutuyor (sürücü şeklini bilmiyor). |

### Mutasyon tablosu (14)

| # | Mutasyon | Yakalandı? |
|---|---|---|
| 1 | Token bucket her zaman izin verir | ✔ 4 test |
| 2 | Semafor: süresi dolmuş sahip temizliği yok | ✘ **hayatta** |
| 3 | Semafor renew: `ZADD XX` → `ZADD` | ✘ **hayatta** |
| 4 | Kilit release: sahip karşılaştırması yok | ✔ 1 test |
| 5 | Token bucket: saat geri gidince token basar | ✘ **hayatta** |
| 6 | Renew: guard + `XX` birlikte kaldırıldı | ✔ 1 test (D-1'i kanıtlar) |
| 7 | Idempotency: `claim` her zaman kazanır | ✔ 1 test |
| 8 | Idempotency: `undefined` → `null` kodlanır | ✔ 2 test |
| 9 | `patch`: `prId: null` temizleme yolu kapatıldı | ✔ 1 test |
| 10 | `TERMINAL_STATUSES`'tan `done` çıkarıldı | ✔ 2 test |
| 11 | Scope önceliği ters çevrildi | ✔ 3 test |
| 12 | Routing `OR` → yalnız proje (org geneli kaybolur) | ✔ 1 test |
| 13 | `pg_advisory_xact_lock` silindi | ✔ 2 test |
| 14 | Param sürüm sırası `desc` → `asc` | ✘ **hayatta** (O-1) |

---

## Öncelikli kontrollerin sonuçları

**Eşzamanlılık**

- ✅ **`IdempotencyGuard.once`** — **12 bağımsız havuz**, aynı anahtar, `Promise.all`: `fn` **tam 1 kez** çalıştı, 12 çağrının hepsi aynı sonucu (`"ONE"`) döndü. `INSERT ... ON CONFLICT DO NOTHING` (`idempotency.ts:225-228`) gerçek atomik claim; ham SQL doğru yazılmış.
- ✅ **Denetim zinciri** — 8 havuz / 48 eşzamanlı append: boşluksuz, çakışmasız, `verify().ok === true`. Advisory lock yük taşıyor (MUT-13). Ajanın itirafı doğru ama pratikte zinciri **bozamadım** (O-3).
- 🔴 **`GateStore.open` idempotent DEĞİL** — ikinci kapı yaratmıyor (birincil anahtar engelliyor) ama **P2002 fırlatıyor**; %93'e varan başarısızlık (K-1).
- ✅ **Redis token bucket** — 100 eşzamanlı istek / limit 10 → **tam 10** (gerçek Redis). Kapasite 1,3,7,25 için de birebir.
- ✅ **Semafor TTL** — sahibi "çökünce" (release/renew yok) kira dolunca izin **gerçekten** geri döndü.

**Veri bütünlüğü**

- ✅ **`patch` kısmi güncelleme** — gerçek Postgres'te doğruladım: `{branch}` yamalayınca `prId=99` ve `resumeToken="tok"` **korundu**; `{prId: null}` yamalayınca `prId` **temizlendi**, `resumeToken` **korundu**. `"prId" in changes` ayrımı (`run-context.ts:209-210`) doğru çalışıyor.
- ✅ **Migration 0004** — 0001→0004 sırayla temiz uygulandı. NOT NULL sütunlar **DEFAULT'lu** (`branch`, `locale`, `targetBranch`, `templateVersion`, `variantId`, `workspacePath`, `workspacePresent`), dolayısıyla **dolu tabloda patlamaz**. Elle yazılan iki CHECK gerçek veritabanında mevcut ve çalışıyor (`IdempotencyKey_state_valid` testte gerçekten reddetti).
- ✅ **0002'nin guard'ları bozulmamış** — gerçek veritabanında teyit: `WorkflowRun_ticketKey_live_key` kısmi unique index **duruyor** ve tanımı hâlâ `WHERE status NOT IN ('done','cancelled')`; 4 append-only trigger duruyor; `ParamVersion_guarded_needs_approver` duruyor.
- ✅ **`IN (NULL)` başka örneği yok** — tüm `in: [` kullanımlarını taradım: `gates.ts:166` (`action`, nullable değil) ve `params.ts:178` (`scopeRef`, `""` kullanılıyor, null değil). `routingRules` doğru `OR` yazımını kullanıyor ve MUT-12 bunu koruyor.
- ✅ **Scope önceliği doğru** — uygulama > proje > global; MUT-11 ile korunduğu kanıtlandı.

**Sır ve sızıntı**

- ✅ Hatalı parolalı `DATABASE_URL` ile: `message`, `stack`, `toString`, `JSON.stringify(e, getOwnPropertyNames(e))` — **hiçbirinde parola yok**.
- ✅ Erişilemez host ile aynı sonuç: sızıntı yok.
- ✅ Parolalı `REDIS_URL` ile: `RedisConnectionError` yalnızca `host:port` yazıyor — **parola yok**.

**Fail-closed**

- ✅ `MISSING_CORE_DEPS` gerçekten boş; worker `bootPlatform` sonrası kuyruğa abone oluyor.
- ✅ Veritabanı düşerse **fırlatıyor**, sessiz boş sonuç yok.
- ✅ Redis düşerse: bucket/semafor/kilit **`RedisConnectionError` fırlatıyor** (fail-**closed**, rate limit açılmıyor); yalnızca `RedisCache` bilinçli olarak `null` dönüyor.
- ✅ `NODE_ENV=production` + `REDIS_URL` yok → `resolveCacheMode` **reddediyor** (`config.ts:74-83`).

**Ajanın üç itirafı**

1. `ChainLock.withLock` atomik değil → **doğru, ama zincir bozulmadı** (O-3). Gerçek risk düşük; arayüz düzeltmesi haklı.
2. `JournalDeps.masker` `gizli`'ye sabitlenmiş → **fail-closed yönü doğru**. `acik`/`dahili` günlükler gereksiz maskeleniyor (okunabilirlik kaybı), ama bu **veri kaybı değil**: maskeleme token'lı ve idempotent, kayıt yine yazılıyor. Kullanılamaz hâle gelmiyor. Kabul edilebilir geçici durum.
3. `AgentTurnRunner` yok → **O-2**. 19 adımın tamamını değil, ama **mühendislik turunu (kod yazma + doğrulama döngüsü, `engineering.ts:107` ve `:220`) tamamen** engelliyor — yani koşunun çekirdeği.

---

## PROD İMAJINA GİREBİLİR Mİ

**Hayır — K-1 düzeltilmeden girmemeli.**

Girmemesi gereken tek somut şey **`gates.ts:105-112`'deki `open` implementasyonu**. Bu kod bugünkü hâliyle bankada şu senaryoyu üretir: bir onay kapısı açılırken iki worker (veya bir Temporal activity retry'ı ile asıl çağrı) çakışır, çağrılardan biri `P2002` ile patlar. Ölçtüğüm başarısızlık oranı iki yazıcıda bile **%47 (28/60 çağrı)**, üç yazıcıda **19/20 denemede**. Sonuç: kapı açılmaz → onaycılara bildirim gitmez → M88 tırmanma merdiveni hiç başlamaz → koşu, kimsenin haberi olmadan onay bekler. Bu sessiz bir bekleyiş, gürültülü bir çökme değil; operatörün fark etmesi zordur.

Düzeltme küçük ve deseni bu repoda zaten mevcut: `idempotency.ts:225-228`'deki `INSERT ... ON CONFLICT DO NOTHING` yaklaşımı `open` için birebir uygulanabilir (ya da P2002'yi yakalayıp mevcut satırı okumak). Bir dosya, birkaç satır.

**Aynı imajda düzeltilmesi gereken ikinci şey Y-1**: `live-stores.test.ts`'teki gate yarış testi, var olan bu hatayı yeşil gösterdiği için düzeltilmeden bırakılırsa aynı hata tekrar girer. Testin `open()` reddini sayması, denemeyi tekrarlaması ve satırı soğuk başlatması gerekiyor.

**Girmesinde sakınca olmayanlar** (kanıtlanmış, gerçek altyapıya karşı çalıştırılmış): idempotency guard (12 havuzda tam-bir-kez), audit zinciri + advisory lock (48 eşzamanlı append boşluksuz ve doğrulanabilir), migration 0004 (dolu tabloda güvenli, 0002 guard'ları sağlam), `patch` null/undefined ayrımı, Redis token bucket / semafor / kilit (fail-closed, sızıntısız), parola sızıntısı **yok**.

**İmaja girer ama üretimde iş yapamaz:** O-2 — `AgentTurnRunner` bağlanmadan worker gerçek bir mühendislik turu koşamaz. Bu bir kusur değil dürüst bir seam, ancak imajı "Dalga 5 tamam, worker çalışıyor" diye etiketlemek yanıltıcı olur: worker **iş alır, çekirdek adımda net bir hata mesajıyla durur**. Bunun sürüm notunda açıkça yazması gerekir.

**Y-2** (Lua mutasyonlarının hayatta kalması) prod'u bugün bozmuyor — gerçek Lua doğru — ama bir sonraki dalgada bu dosyaya dokunulursa CI koruma sağlamaz. İmajı bloke etmez, backlog'a girmelidir.

---

## KARAR

**KALDI**

*(1 kritik + 2 yüksek bulgu. K-1 tek başına bloke edici: eşzamanlılıkta idempotent olduğu belgelenen bir onay kapısı, ölçülen %47–95 oranında hata fırlatıyor.)*

---

### Ek: doğrulama hijyeni

- Paylaşılan checkout'ta **kalıcı değişiklik yok, commit yok**. 14 mutasyonun tamamı ve tüm geçici test dosyaları geri alındı/silindi; `git status` `maestro/` altında **temiz** (yalnızca denetim öncesinden var olan takipsiz dosyalar ve bu rapor).
- Geçici konteynerler (`maestro-verify-pg`, `maestro-verify-redis`) **durduruldu ve silindi**. `uinfra-postgres`'e dokunulmadı.
