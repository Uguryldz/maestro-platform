# RAPOR — Dalga 5 düzeltmesi (K-1 / Y-1 / Y-2 / O-1 / O-2)

**Dal:** `main` (worktree `agent-acd20a71190a264da`)
**Temel commit:** `920ce6c` (wave-5: Postgres-backed core stores)
**Kaynak denetim:** `apps/deploy/DOGRULAMA-dalga5.md` — karar **KALDI**
**Tarih:** 2026-08-09

---

## 0. Özet

| Bulgu | Durum | Kanıt |
|---|---|---|
| 🔴 **K-1** `GateStore.open` idempotent değil | **KAPATILDI** | Gerçek PG: **94 hata → 0 hata** (20×6 soğuk) |
| 🟠 **Y-1** Yarış testi hatayı yeşil gösteriyor | **KAPATILDI** | Mutant altında test kırmızı: `expected 95 to be +0` |
| 🟠 **Y-2** Lua mutasyonları hayatta kalıyor | **KAPATILDI** | 3/3 mutasyon artık yakalanıyor |
| 🟢 **D-1** `ZADD XX` ölü yol | **KAPATILDI** | `XX` kaldırıldı; asıl guard teste bağlandı |
| 🟡 **O-1** `params` fake `orderBy`'ı yok sayıyor | **KAPATILDI** | Yön **tip sistemiyle** korunuyor (aşağıda) |
| 🟡 **O-2** `AgentTurnRunner` yok | **GÖRÜNÜR YAPILDI** (kapatılmadı — kapsam dışı) | `DEGRADED_CAPABILITIES` + boot uyarısı |
| 🟡 **O-3** `AuditChain` kilit atomikliği | **KAPATILMADI** — gerekçe §6 | Arayüz değişikliği gerekiyor (DONMUŞ paket) |

**Kapı:** `pnpm run gate` → **exit 0, 60/60 görev başarılı.**

---

## 1. K-1 — `GateStore.open` (KRİTİK, bloke edici)

### Kök neden doğrulandı

Doğrulayıcının iddiası birebir doğrulandı. Prisma, **bileşik birincil anahtarda `upsert` için `ON CONFLICT` üretmiyor**; `SELECT` sonra düz `INSERT` yapıyor. Kodun kendi yorumu ("`upsert` with an EMPTY update is the whole trick") gerçek dışıydı.

### Gerçek Postgres kanıtı — ÖNCE

Geçici konteyner (`postgres:18-alpine`, port 55436), 0001→0004 migration'ları sırayla uygulandı (dördü de temiz). Soğuk satır probu, her turda **yeni `runId`**:

```
COLD rows: 20 rounds x 6 concurrent = 120 calls -> 94 ERRORS
rounds with at least one error: 19/20
error kinds: {"P2002":94}
HOT row: 6 calls -> 0 ERRORS
```

`HOT row: 0 ERRORS` satırı, sevk edilen testin bunu neden kaçırdığını tek başına açıklıyor: test satırı önceden sıcak bırakıyordu.

### Düzeltme

`apps/deploy/src/stores/gates.ts` — `upsert` kaldırıldı, `idempotency.ts:225-228` deseni birebir uygulandı:

```sql
INSERT INTO "Gate" ("runId", "step", "ownerGroup", "openedAt", "firedStepIds", "closedAt")
VALUES ($1, $2, $3, $4, ARRAY[]::text[], NULL)
ON CONFLICT ("runId", "step") DO NOTHING
```

Ardından **koşulsuz** `findUnique`. Koşulsuz olması önemli: kazanan da kaybeden de tablodaki satırı okur, dolayısıyla altı çağrının hepsi **aynı `openedAt` çapasını** döndürür — kendi taşıdığı anı değil.

Yapısal notlar:
- `GateDelegate`'ten `upsert` **tamamen silindi** — yanlış aracın erişilebilir kalmaması için.
- Yeni `GateClaim` arayüzü + `sqlGateClaim()`; çevrimdışı süit ham SQL'i ikame edebilsin diye seam olarak duruyor.
- `buildCoreStores` (`stores/core.ts`) zaten elinde olan `options.sql`'i geçiriyor — yeni bağımlılık yok.
- **Yanlış yorum düzeltildi**: yeni yorum ölçülen sayıları (94/120) ve bankadaki sessiz-bekleme sonucunu yazıyor.

### Gerçek Postgres kanıtı — SONRA

Aynı prob, aynı şekil:

```
COLD rows: 20 rounds x 6 concurrent = 120 calls -> 0 ERRORS
rounds with at least one error: 0/20
error kinds: {}
rows != 1 in 0 rounds; divergent openedAt anchors in 0 rounds
HOT row: 6 calls -> 0 ERRORS
```

### Postgres'in gerçekten aldığı SQL (`log_statement=all`)

```
execute s22: INSERT INTO "Gate" ("runId", "step", "ownerGroup", "openedAt", "firedStepIds", "closedAt")
             VALUES ($1, $2, $3, $4, ARRAY[]::text[], NULL)
             ON CONFLICT ("runId", "step") DO NOTHING
DETAIL: Parameters: $1 = 'run-race-19', $2 = '4', $3 = 'product-owners', ...
```

120 çağrının **120'sinde** `ON CONFLICT` satırı log'da, değerler parametreli (adım kimliği SQL metnine hiç girmiyor).

---

## 2. Y-1 — Yarış testi (YÜKSEK)

`apps/deploy/test/live-stores.test.ts` — gate yarış testi baştan yazıldı. Doğrulayıcının saydığı üç zayıflığın üçü de giderildi:

1. **Reddedilenler sayılıyor** — `Promise.allSettled` + açık `rejected` sayımı, `expect(rejections).toBe(0)`.
2. **Çok turlu** — 20 tur × 6 yazıcı = 120 çağrı (`expect(calls).toBe(120)`).
3. **Soğuk satır** — her tur **yeni `runId`** ile seed ediliyor.

Ek olarak altı yazıcı **kasıtlı olarak farklı `openedAt`** taşıyor ve test hepsinin **tek çapada** buluştuğunu doğruluyor (`expect([...anchors]).toEqual([rows[0].openedAt])`) — merdivenin sessizce yeniden başlamasını yakalayan asıl assert bu.

### Mutasyon kanıtı (Y-1)

`open`'ı sevk edilen şekle geri döndürdüm (SELECT-sonra-çıplak-INSERT):

```
FAIL  live-stores.test.ts > GateStore > opens one gate with no failed caller when six cold workers race
AssertionError: expected 95 to be +0
```

Eski test aynı mutantta **yeşil kalıyordu**. Yeni test ilk turda yakalıyor. Mutasyon geri alındı, 11/11 yeşil.

---

## 3. Y-2 — `packages/cache` çift Lua uygulaması (YÜKSEK)

### Önce: sorun yeniden üretildi

Gerçek Redis (`redis:7-alpine`) bağlıyken, doğrulayıcının üç mutasyonu **birebir hayatta kaldı**:

```
MUT sem-sweep  -> Tests  168 passed (168)
MUT zadd-xx    -> Tests  168 passed (168)
MUT clock-back -> Tests  168 passed (168)
baseline       -> Tests  168 passed (168)
```

**Neden simülatör guard'ı çalışmıyor:** `lua-sim.ts` mirror'ları script gövdesine göre aranıyor, ama arama anahtarı **mutasyona uğramış sabitin kendisi**. Lua düzenlendiğinde anahtar da onunla birlikte değişiyor, yani "mirror yok" hatası **hiç tetiklenmiyor**. Guard yalnızca elle yazılmış bir ayrışmayı yakalıyor, gerçek script'e yapılan bir düzenlemeyi asla.

### Düzeltme: kritik davranışlar gerçek Redis'e bağlandı

Üç davranış için `redis-integration.test.ts`'e gerçek-Redis testi eklendi. Üçü de **enjekte edilen saat** kullanıyor (duvar saati uykusu değil) — böylece hem deterministik hem hızlı:

| Test | Neyi pinliyor |
|---|---|
| `sweeps an expired holder out of the zset, not merely out of the count` | `ZREMRANGEBYSCORE` süresi-dolmuş-sahip temizliği |
| `refuses to renew a permit whose lease expired, and leaves the successor alone` | Sweep + `ZSCORE` guard'ı (eski yanlış adlı testin yerine) |
| `mints no tokens when the clock goes backwards` | `if elapsed < 0 then elapsed = 0` |

Kritik ayrıntı — **eski testler neden yakalamıyordu:**
- Semafor testi 1,2 sn gerçek uyku sonrası `holders()` (yani `ZCOUNT ... now +inf`) bakıyordu. Süresi dolmuş üye zaten `ZCOUNT`'a girmez, dolayısıyla sweep silinse de **aynı yeşil** çıkıyordu. Yeni test `ZCARD`'a bakıyor (süresi dolmuş üyeyi de sayar) — fark ancak böyle görünüyor.
- Saat-geri testi hiç yoktu. Clamp silindiğinde görünür etki "daha çok token" değil, **kaydedilen zaman damgasının geriye yürümesi**; sonraki her çağrı bu bayat andan ölçüp aynı token'ı iki kez basıyor. Yeni test doğrudan değişmezi ölçüyor: 5 limiti, saat hangi yöne giderse gitsin 5 kalmalı.

### Mutasyon kanıtı (Y-2) — sonra

```
MUT sem-sweep    -> Tests  2 failed | 168 passed (170)   ✔ yakalandı
MUT clock-back   -> Tests  1 failed | 169 passed (170)   ✔ yakalandı
MUT renew-guard  -> Tests  1 failed | 169 passed (170)   ✔ yakalandı
baseline         -> Tests  170 passed (170)
```

`zadd-xx` mutasyonu artık **uygulanamıyor** — `XX` kaldırıldığı için (D-1, aşağıda). Yerine, refüzü gerçekten taşıyan satır (`ZSCORE` guard'ı) mutasyona uğratıldı ve **yakalandı**.

---

## 4. D-1 — `ZADD XX` ölü yol

Gerçek Redis'te doğruladım: `ZREMRANGEBYSCORE key -inf now` **`now` dahil** siliyor. Dolayısıyla `ZADD` satırına ulaşan bir üye zorunlu olarak canlıdır ve `XX` ("yalnız var olan üyeyi güncelle") sonucu **hiçbir koşulda değiştiremez**.

Doğrulayıcının önerdiği ikilemde ikinci şıkkı seçtim: **`XX` kaldırıldı** (hem `scripts.ts` hem mirror'ı). Gerekçe: "gerçekten gerekli olduğunu gösteren bir test" yazılamaz, çünkü böyle bir yol yok — testi yazmaya çalışmak, var olmayan bir davranışı kanıtlıyormuş gibi görünen üçüncü bir yanlış test üretirdi.

Ayrıca **yanıltıcı test adı düzeltildi**: `"refuses to renew an expired permit (ZADD XX)"` → `"refuses to renew a permit whose lease expired, and leaves the successor alone"`. Yorum da düzeltildi; eski yorum `XX`'i "the load-bearing flag" diye tanımlıyordu — yanlış satırı öven bir yorum, sonraki okuyucuya yanlış satırı korumayı öğretir.

---

## 5. O-1 — `params.ts` sürüm sıralaması

Doğrulayıcı MUT-14'ün (desc→asc) hayatta kaldığını bildirmişti. **Ölçtüm: mutasyon aslında derlenmiyor.**

```
src/stores/params.ts(179,18): error TS2322: Type '"asc"' is not assignable to type '"desc"'.
```

`ParamVersionDelegate.orderBy.version` **literal `"desc"`** olarak tiplenmiş. Yani yön testle değil **tip sistemiyle** korunuyor — testten daha güçlü bir garanti. (MUT-14'ün hayatta kalmış görünmesi, mutasyonun `tsc`'den geçmeden yalnızca vitest ile koşulmuş olmasıyla açıklanıyor; vitest transpile eder, tip denetlemez.)

Yapılan: fake'in koşulsuz sıralaması **korundu** (dallanacak ikinci bir değer yok), ama artık aldığı argümanı **assert ediyor** (`expect(args.orderBy).toEqual({ version: "desc" })`) ve yorum bu akıl yürütmeyi — korumanın tipte olduğunu — açıkça yazıyor. Böylece dosya, gerçekte denetlemediği bir yön için kefil olmayı bırakıyor.

---

## 6. Kapatılmayanlar ve nedenleri

### O-2 — `AgentTurnRunner` (kapsam dışı; **görünür yapıldı**)

Kapatılması istenmedi. İstenen "operatör imajda neyin eksik olduğunu bilmeli" şartı karşılandı:

`boot.ts`'e **`DEGRADED_CAPABILITIES`** eklendi — `MISSING_CORE_DEPS`'ten **ayrı** bir liste olması kasıtlı: buradaki bir girdi worker'ı **durdurmamalı**. On dokuz adımın on ikisi bu seam'e hiç uğramıyor; boot'u reddetmek, korumaya çalıştığı adıma hiç ulaşmayan adımları da yere indirirdi.

`bin/worker.ts` artık "polling" satırından **sonra**, `console.warn` ile:

```
[maestro] worker: RUNNING WITH 1 DEGRADED CAPABILITY — it polls, but a run that
reaches one of these stops there with a named error:
  - AgentTurnRunner (M30/M52/M54): the engineering turn — the code-writing and
    verification loop at packages/workflows/src/impl/engineering.ts:107 and :220 —
    REFUSES with a named error. ...
```

İki test bunu bağlıyor (`test/worker-boot.test.ts`), biri **sürüklenmeye karşı**: gerçek bir `AgentTurnRunner` bağlandığı anda seam reddetmeyi bırakır ve `declared === refuses` assert'i kırmızıya döner — yani liste, artık var olmayan bir boşluğu ilan etmeye devam edemez. Bir kez yanlış çıkan uyarı, sonsuza kadar yok sayılır.

**Değerlendirme değişmedi:** imaj "Dalga 5 tamam, worker çalışıyor" diye etiketlenmemeli. Worker iş alır; mühendislik turuna ulaşan koşu orada net hatayla durur. Artık bu, boot log'unda yazıyor.

### O-3 — `AuditChain` kilit atomikliği

**Kapatılmadı.** Doğru çözüm `ChainLock.withLock`'un transaction handle'ı geçirmesi, ama `withLock` `packages/audit` içindeki bir arayüz ve doğru düzeltme `packages/ports`/`contracts` sınırına dokunuyor — **DONMUŞ** paketler. Doğrulayıcının kendi ölçümü riski düşük buluyor (8 havuz / 48 eşzamanlı append: boşluksuz, `verify().ok === true`) ve `seq`/`hash`/`prevHash` unique index'leri son savunma olarak duruyor.

> **ARAYÜZ İSTEĞİ:** `ChainLock.withLock` callback'i sıfır argümanla çağırıyor (`packages/audit/src/chain.ts:25`). Kilit transaction'ının içinden yazabilmek için `withLock<T>(key, fn: (tx: SqlExecutor) => Promise<T>)` şekline ihtiyaç var. Bu değişmeden INSERT kilit transaction'ının dışında, havuzdaki başka bir bağlantıdan commit oluyor.

---

## 7. Değişen dosyalar

| Dosya | Değişiklik |
|---|---|
| `apps/deploy/src/stores/gates.ts` | `upsert` → `ON CONFLICT DO NOTHING`; `GateClaim` + `sqlGateClaim`; yanlış yorum düzeltildi |
| `apps/deploy/src/stores/core.ts` | `sqlGateClaim(options.sql)` bağlandı; `sql` yorumu güncellendi |
| `apps/deploy/src/boot.ts` | `DEGRADED_CAPABILITIES` eklendi |
| `apps/deploy/src/bin/worker.ts` | Boot'ta degraded-capability uyarısı |
| `apps/deploy/test/live-stores.test.ts` | Yarış testi: soğuk satır, 20 tur, red sayımı, tek-çapa assert'i |
| `apps/deploy/test/gates.test.ts` | Fake `ON CONFLICT` semantiğini modelliyor |
| `apps/deploy/test/worker-boot.test.ts` | Degraded-capability + sürüklenme testleri |
| `apps/deploy/test/params.test.ts` | `orderBy` argümanı assert ediliyor |
| `packages/cache/src/scripts.ts` | `ZADD XX` kaldırıldı; yorum düzeltildi |
| `packages/cache/src/lua-sim.ts` | Mirror eşitlendi |
| `packages/cache/test/redis-integration.test.ts` | 3 gerçek-Redis testi; yanlış adlı test düzeltildi |

Kaynak dosyaların hepsi ≤300 satır (en büyüğü `boot.ts`, 272).

---

## 8. Doğrulama hijyeni

- Geçici konteynerler `maestro-fix-pg` (55436) ve `maestro-fix-redis` (56398) **durduruldu ve silindi**. `uinfra-postgres`'e **dokunulmadı**.
- Bütün mutasyonlar geri alındı; geçici prob dosyaları silindi. `git status` altında yalnızca yukarıdaki 11 dosya + bu rapor.
- Paylaşılan checkout `/home/ubuntu/coder/maestro` **değiştirilmedi**.

---

## 9. PROD İMAJINA GİREBİLİR Mİ

**Evet — K-1 ve Y-1 kapatıldı, bloke edici kalmadı.**

Doğrulayıcının bloke edici olarak işaretlediği tek somut şey `gates.ts`'teki `open` implementasyonuydu. Aynı ölçüm aracıyla, aynı şekilde, gerçek Postgres'te: **94/120 hata → 0/120 hata**. Hatayı yeşil gösteren test de aynı imajda düzeltildi ve mutasyonla kanıtlandı — doğrulayıcının "Y-1 aynı imajda gitmeli, yoksa hata geri gelir" uyarısı karşılandı.

Y-2 bugünü bozmuyordu ama bir sonraki dalgada koruma sağlamıyordu; artık üç kritik Lua davranışı gerçek Redis'e bağlı ve üçü de mutasyonla yakalanıyor.

**İmajın sürüm notunda yazması gereken tek şey:** bu imaj **mühendislik turunu koşamaz** (O-2). Worker iş alır, intake/analiz/kapılar/merdiven/bildirim/yayın çalışır; kod yazma-doğrulama döngüsüne ulaşan koşu orada net bir hata mesajıyla durur. Bu artık boot log'unda `DEGRADED_CAPABILITY` uyarısı olarak görünüyor — operatörün imaja bakıp "worker çalışıyor" demesi artık "koşu bitebilir" anlamına gelmiyor, ve bunu log'dan öğreniyor.

O-3 backlog'da (ARAYÜZ İSTEĞİ §6).

**Kapı:** `pnpm run gate` → **exit 0 · 60/60**.
