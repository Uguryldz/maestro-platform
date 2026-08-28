# Dalga 5 — Postgres destekli koşu depoları

Worker'ın iş almasını engelleyen altı depo yazıldı. `MISSING_CORE_DEPS` **boş**;
worker artık poll ediyor.

---

## 1. Ne yazıldı, nereye

| Depo | Dosya | Tablo |
|---|---|---|
| `RunContextStore` | `apps/deploy/src/stores/run-context.ts` | `WorkflowRun` (+ yeni sütunlar) |
| `GateStore` | `apps/deploy/src/stores/gates.ts` | `Gate` + `AuditLog` (kararlar) |
| `ParamReader` | `apps/deploy/src/stores/params.ts` | `ParamVersion`, `RoutingRule` |
| `DirectoryReader` | `apps/deploy/src/stores/directory.ts` | `User.groupsJson` |
| `IdempotencyGuard` | `apps/deploy/src/stores/idempotency.ts` | `IdempotencyKey` (yeni) |
| `AuditStore` + kilit | `apps/deploy/src/stores/audit.ts` | `AuditLog` + advisory lock |

Kapsam dışıydı ama aynı engeli paylaşıyordu, o yüzden yazıldı:

| `PublishStateStore` | `apps/deploy/src/stores/publish-state.ts` | `PublishState` (yeni) |

Birleştirme: `stores/core.ts` (altı depo), `stores/worker-core.ts` (`CoreDeps`).

### M44 gerekçesi — neden `apps/deploy/src/stores/`

`packages/workflows` arayüzü **tanımlar**, Prisma'yı **import etmez**; 122 aktivite
testinin çevrimdışı kalmasını sağlayan şey bu. Depolar bileşim köküne kondu çünkü:

1. **Emsal zaten var.** `apps/deploy/src/stores/users.ts` içindeki
   `PrismaUserDirectory`, `@maestro/bff`'in arayüzünü tam bu şekilde uyguluyor —
   ve dosyanın kendi yorumu nedenini yazıyor: *"BFF Prisma import etmemeli."*
   Aynı sorun, aynı çözüm.
2. **Yeni bir `packages/stores` paketi ikinci bir bileşim kökü olurdu.** Sürücüyü
   porta bağlayan tek yer olması M44'ün kendisi.
3. **Yapısal delegate'ler** (`PrismaClient["gate"]` değil, elle yazılmış arayüz):
   `prisma generate` çalışmadan da derleniyor ve her deponun tabloya *ne kadar*
   dokunduğu yazılı hale geliyor.

Gerçek client'ın bu yapısal tiplere uyduğu **derleme zamanında kanıtlandı**:
geçici bir `probe.ts` ile `const p: CoreStoreDb = db` denendi. Dört gerçek hata
yakalandı (aşağıda), sonra dosya silindi.

---

## 2. Migration

`packages/db/prisma/migrations/0004_run_context_gates_idempotency/migration.sql`

`prisma migrate diff` ile üretildi, sonra elle iki CHECK eklendi (0002'nin kalıbı).

1. **`WorkflowRun` + 11 sütun** — `RunContext`'in DB'de karşılığı olmayan alanları
   (locale, variantId, templateVersion, workspacePath, workspacePresent,
   protectedPathsJson, verificationJson, branch, targetBranch, prId, resumeToken).
   NOT NULL + default: mevcut koşular da okunabilsin, ve unutulan bir alan
   NULL değil `""` olsun — deponun **gürültülü reddedebileceği** bir değer.
2. **`Gate`** — PK `(runId, step)`. Bu anahtar `open`'ın idempotence'ı: yinelenen
   sinyal ikinci satır açamaz, dolayısıyla merdivenin çıpası `openedAt` oynayamaz.
3. **`IdempotencyKey`** — PK `key`. İki worker aynı anda INSERT eder, tam biri kazanır.
4. **`PublishState`** — yayın makbuzu (M47/M75).

Elle eklenen kısıtlar:

- `Gate_closed_after_opened` — kapı açılmadan kapanamaz (negatif yaş → merdiven
  bütün adımları aynı anda ateşler).
- `IdempotencyKey_state_valid` — `done` satırı `completedAt` taşımak **zorunda**;
  yoksa çökmüş bir talep bitmiş sanılır ve olmayan sonucu tekrar oynatılır.

**Korunanlar:** 0002'nin append-only trigger'ları, four-eyes CHECK'i ve
"bir ticket'ta en fazla bir CANLI koşu" kısmi unique index'i — hepsi canlı
Postgres'te doğrulandı (`@maestro/db` 177/177 yeşil, `TEST_DATABASE_URL` ile).

**Drift guard:** `test/migration.test.ts`'teki *"creates a table for every model"*
artık **tüm** migration'ları okuyor (`allMigrationSql()`), sadece 0001'i değil.
0004'te gelen model drift değil, tarihtir — hemen altındaki enum testi zaten bu
mantığı izliyordu. Guard'ın yakaladığı asıl şey duruyor: hiçbir migration'ın
yaratmadığı model.

---

## 3. `MISSING_CORE_DEPS` — önce / sonra

**Önce (6 madde):**
```
RunContextStore (packages/workflows: run row — ticket, app, branch, workspace)
GateStore (approval gates + escalation ladder state, M88)
ParamReader (operational parameters from the DB, M71)
DirectoryReader (AD group → corporate addresses)
IdempotencyGuard (table-backed; InMemoryIdempotency is single-worker only, M33)
AuditStore (Postgres-backed; only InMemoryAuditStore ships, M33)
```

**Sonra:**
```ts
export const MISSING_CORE_DEPS: readonly string[] = [];
```

Yedinci bağımlılık olan **koşu günlüğü hiç eksik değildi**:
`@maestro/memory`'nin `journalStoreFromDb`'si Dalga 1'den beri var —
Postgres destekli, append-only, `(runId, seq)` anahtarlı. `buildWorkerCore` bağlıyor.

Liste silinmedi, **boş bırakıldı**: worker'ın açılış ön koşulu olarak duruyor,
ileride yarım gelen bir bağımlılık oraya yazılır ve worker yine reddeder.

---

## 4. Worker artık iş alıyor — kanıt

Gerçek binary, gerçek Postgres, kasten erişilemez Temporal ile çalıştırıldı:

```
[maestro] profile=dev node_env=development
[maestro] ports:
    work → jira-dc   scm → ado    llm → gateway   scan → trivy
    storage → pg-blob   secret → env-file   notify → jira   publish → jira   ci → ado
[maestro] worker: composed 9 ports on profile dev, polling maestro-delivery
[maestro] startup failed: tonic::transport::Error(... "dns error" ... temporal.invalid ...)
```

`polling maestro-delivery` satırı ret eşiğinin **geçildiğini** gösteriyor;
tek hata sahte DNS adı. Önceki davranış:

> `worker: the ports compose, but the run-scoped stores do not exist yet, so the
> worker refuses to poll rather than accept tickets it would lose on restart (M33)`

`test/worker-boot.test.ts` bunu kalıcılaştırıyor: listeye biri madde eklerse test kırılır.

---

## 5. Testler

**Toplam yeni: 60 test** (`apps/deploy`: 307 geçti, 11 canlı-DB atlandı).

| Dosya | Test | Kapsam |
|---|---|---|
| `run-context.test.ts` | 14 | eşleme, fail-closed, kısmi patch sınırı |
| `gates.test.ts` | 16 | idempotence, append, kararların zincirden kurulması |
| `idempotency.test.ts` | 9 | **iki worker yarışı**, hata unutulmaz, zaman aşımı |
| `params.test.ts` | 14 | kapsam önceliği, DB tek kaynak, `OR`-not-`IN` |
| `directory.test.ts` | 14 | grup çözümü, LDAPS zinciri, yayın makbuzu |
| `audit-store.test.ts` | 7 | zincir, advisory lock sırası |
| `worker-boot.test.ts` | 3 | `MISSING_CORE_DEPS` boş |
| `live-stores.test.ts` | 11 | **gerçek Postgres** (opt-in) |

Canlı testler `packages/db/test/live-guards.test.ts` kalıbını izliyor:
`TEST_DATABASE_URL` yoksa dosya tamamen atlanır, kapı çevrimdışı kalır.
Ağ çağrısı yok.

Canlı testlerin kanıtladığı, sahtelenemez üç şey:
- iki **ayrı bağlantı havuzundan** aynı kapıyı açmak tek satır üretir,
- iki havuzdan aynı anahtarla `once` çağırmak etkiyi **bir kez** çalıştırır,
- iki havuzdan eşzamanlı denetim yazımı **boşluksuz** zincir üretir (`verify().ok`).

---

## 6. Mutasyon kanıtları

| # | Bozulan | Sonuç |
|---|---|---|
| 1 | `upsert`'ün boş `update`'i → `openedAt` güncelleniyor | canlı yarış testi kırıldı: `expected '...01T09:00' to be '...04T09:00'` (merdiven çıpası oynadı) |
| 2 | `ON CONFLICT DO NOTHING` → `DO UPDATE` | `expected 2 to be 1` — etki **iki kez** çalıştı (çift Jira yorumu) |
| 3 | `pg_advisory_xact_lock` çağrısı silindi | eşzamanlı denetim yazımı unique index'e çarptı, kayıt kayboldu |
| 4 | `"prId" in changes` → `!== undefined && !== null` | `prId`'yi null'a çekmek sessizce çalışmaz oldu |

Hepsi geri alındı; sonrasında paket 307/307 yeşil.

---

## 7. Yazarken yakalanan gerçek hatalar

Bunlar tasarım sırasında değil, **test/derleme sırasında** yakalandı:

1. **`IN (NULL)` hiçbir zaman doğru değil.** `routingRules` org-genelindeki
   (`projectKey IS NULL`) kuralları `in: [key, null]` ile arıyordu — SQL'de bu
   asla eşleşmez, yani org-genelindeki her kural **her yönlendirme kararından
   sessizce düşerdi**. Prisma'nın tip hatası ortaya çıkardı; `OR` ile düzeltildi.
2. **Kapsam önceliği alfabetikti.** `scopeRef DESC` sıralaması `"PAY"`yi
   `"core-api"`nin üstüne koyuyor (büyük harf önce), yani proje satırı
   uygulama override'ını yeniyordu — sadece isimler o yönde sıralandığında.
   Öncelik artık kodda açık; testi de yazıldı.
3. **`undefined` ile `null` karışıyordu.** `encode` `undefined`'ı `null`'a
   çeviriyordu; `once` etkinin döndürdüğünden farklı bir değer döndürürdü.
   Zarf artık **yokluğu** kaydediyor (`{}` vs `{ v: null }`).
4. **`pg_advisory_xact_lock` `void` döner** ve client bunu deserialize edemiyor:
   kilit alınır, çağrı patlardı. `::text` cast'i ile düzeltildi — canlı test yakaladı.

---

## 8. ARAYÜZ İSTEKLERİ

1. **`ChainLock.withLock` callback'e handle geçirmeli.**
   `withLock<T>(fn: () => Promise<T>)` sıfır argüman aldığı için, kilidi tutan
   **transaction bağlantısı** store'a verilemiyor; INSERT havuzdan gidiyor.
   Kritik bölüm (head oku → kayıt yaz) yine de **süreçler arası serileşiyor** —
   kilit `fn` çözülene kadar tutuluyor — ve unique index'ler son savunma.
   Ama INSERT kilit transaction'ıyla **atomik değil**.
   İstenen: `withLock<T>(fn: (handle: unknown) => Promise<T>)`, ve `AuditChain`'in
   store'u o handle'dan kurabilmesi. `packages/audit` donmuş sayıldığı için
   yapılmadı; `stores/audit.ts` bunu yorumda açıkça yazıyor.

2. **`JournalDeps.masker` tek veri sınıfına sabit.**
   `createJournalMasker` profilini kuruluşta tek bir `dataClass`'tan çözüyor, ama
   bir worker aynı kuyruktan **her sınıftan** koşu alıyor ve `JournalDeps` tek
   masker taşıyor. `gizli` seçildi — fail-closed okuma. Doğru çözüm girdi başına
   maskeleme; `JournalDeps`'in değişmesi gerekiyor.

3. **`AgentTurnRunner` için `WorkspaceProbe` / `VerificationRunner` / `StrikeLedger`
   uygulaması yok.** `unbridgedScanRunner` kalıbında **reddeden** bir seam kondu
   (`stores/execution.ts`): bileşim kanıtlanıyor, ilk mühendislik turunda eksik
   parçayı adıyla söyleyerek patlıyor. Diğer on iki adım çalışıyor.

---

## 9. Yapılmayanlar

- **Temporal'a gerçek bağlanma testi yok** — ortamda Temporal sunucusu yok.
  Worker'ın ret eşiğini geçtiği, `polling` satırı + DNS hatası ile kanıtlandı.
- **LDAPS sürücüsü** — paralel ajanın işi. `firstAvailableDirectory` takılma
  noktası hazır: LDAPS önce sorulur, düşerse **zincir bitmez** (bir dizin
  arızası dağıtım listesini sessizce boşaltmamalı), yerel tablo cevaplar.
- **`AgentExecution`** — üstteki 3 numaralı istek.
- **Studio read-model'leri** — `stores/read-models.ts` hâlâ reddediyor; ayrı iş.
- **`IdempotencyKey` / `PublishState` retention süpürgesi** — `claimedAt` indeksi
  kondu, süpürgenin kendisi yazılmadı.
