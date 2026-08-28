# Koşu durumu: başarısız koşular artık veritabanında da başarısız

**Dal:** `run-status-reconciler`
**Kapsam:** `WorkflowRun.status` sütununu Temporal'ın gerçeğiyle hizalamak.

---

## Bulgu: teşhis brifingden farklı çıktı (ölçümle)

Brifingdeki üç kod atıfı bu ağaçta **doğrulanamadı** ve teşhisi değiştirdi:

| Brifing iddiası | Ağaçtaki gerçek |
|---|---|
| `RunContext.status` alanı **var** (`deps.ts:72`, tip `RunLifecycle`) | `RunContext`'te **status alanı yok**; `deps.ts:72` `patch()` imzası |
| `RunLifecycle` tipi var, `fail` eklenmeli | `RunLifecycle` **repoda hiç yok** (`grep` → 0 sonuç) |
| `delivery.ts:297` zaten `status: "done"` yazıyor | `delivery.ts` **219 satır**; hiçbir yerde status yazmıyor |

**Gerçek kök neden, iddia edilenden geniş:** `WorkflowRun.status` sütununa
üretim kodunda **hiçbir şey yazmıyor** (yalnız seed/test). Satır intake'te
`running` açılıyor ve bir daha hiç değişmiyor. Yani sadece çöken koşular değil,
**başarıyla biten koşular da** `running` kalıyor.

`RunLifecycle`'a `fail` eklemek gerekmedi: `WorkflowRunStatus` **zaten donmuş
`packages/contracts`'ta** ve yedi değerin hepsini (`fail` dahil) içeriyor.
Eksik olan tip değil, **yazan kod**tu. → ARAYÜZ İSTEĞİ çıkmadı.

### Canlı ölçüm (kanıt)

Postgres: **16 satırın 16'sı `running`.**
Temporal (`temporal workflow list`, `ticketWorkflow` tipi):

| Temporal | Adet |
|---|---|
| Failed (`RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED`) | **11** |
| Completed | **1** |
| Running (gerçekten canlı) | **4** |

Brifingdeki "13 Failed" sayısı 11 çıktı; ayrıca **4 koşu gerçekten yaşıyor.**
Bu fark kritik: "hepsini fail işaretle" yaklaşımı 4 canlı koşuyu yanlışlıkla
öldürürdü. Ayrıca Temporal'daki 6 `verifyRun` workflow'u DB'de karşılığı olmayan
hayaletler (HANDOFF.md:15) — `list` zaten `WorkflowType='ticketWorkflow'`
filtresiyle onları dışarıda bırakıyor.

Çöküş nedeni (OPS-38 örneği): `runEngineering` aktivitesi →
`ClaudeConfigError: mcpServers were requested but no --mcp-config path was given`.

---

## Seçilen yaklaşım: açılışta bir kez uzlaştırıcı — gerekçe

`bootWorker` açılışında bir kez koşan uzlaştırıcı
(`apps/deploy/src/stores/reconcile.ts`).

- **Workflow kendini işaretleyemez.** Koşu retry'ları tükendiğinde **aktivitenin
  içinde** ölüyor; sonrasında hiçbir workflow kodu çalışmıyor. Son bir "beni fail
  yaz" aktivitesi de az önce çöken aynı yoldan geçerdi.
- **Geriye dönük hizalamayı da tek bu yaklaşım çözüyor** — 16 satır elle SQL ile
  değil, kodun ilk koşuşuyla düzeliyor (istendiği gibi).
- **Açılış anı doğru an:** bu süreç, kendisinden ÖNCE koşan her şeyin artık
  kapandığını bilir. Periyodik `setInterval` yerine açılış seçildi çünkü ek bir
  zamanlayıcı ömrü/kapatma yolu getirmiyor ve bu kod yolu (`MISSING_CORE_DEPS`)
  zaten "açılışta yüksek sesle reddet" deseninin evi.
- **Yeni Temporal bağımlılığı yok:** mevcut `RunGateway.list()` (BFF arayüzü,
  `connectTemporal`) kullanıldı.

**Kapsanmayan:** worker AYAKTAYKEN çöken bir koşu, bir sonraki açılışa kadar
`running` görünür. Bilinçli sınır — dosyada da yazılı.

---

## Değişiklikler

| Dosya | Ne |
|---|---|
| `apps/deploy/src/stores/reconcile.ts` **(yeni, 205 satır)** | Uzlaştırıcı |
| `apps/deploy/src/bin/worker.ts` | `reconcileOnBoot()` — poll'dan hemen önce |
| `apps/deploy/src/stores/run-context.ts` | `TERMINAL_STATUSES` += `fail` |
| `packages/db/prisma/migrations/0011_failed_run_is_terminal/` **(yeni)** | Kısmi unique index `fail`'i de terminal sayar |
| `packages/db/prisma/schema.prisma` | Index yorumu 0011'e işaret ediyor |
| `apps/deploy/test/reconcile.test.ts` **(yeni)** | 12 test |
| `apps/deploy/test/run-context.test.ts` | Yeni terminal kümesi |
| `apps/studio/test/screens-flow.test.tsx` | Kullanılmayan import (main'de kırıktı, kapıyı tıkıyordu) |

### `fail` terminal olmalıydı — yoksa daha kötü bir hata

`TERMINAL_STATUSES` yalnız `("done","cancelled")` idi ve migration 0002'deki
**kısmi unique index** aynı kümeyi kullanıyor. `fail` yazılıp terminal
sayılmasaydı:

1. `PrismaRunContextStore.get` ölü koşunun bağlamını aktivitelere vermeye devam
   ederdi;
2. o ticket'a ikinci `/ai-start` **P2002** ile çakışırdı → ticket kalıcı olarak
   yeniden koşturulamaz olurdu.

Bu yüzden kod sabiti ve DB index'i **aynı commit'te** birlikte genişletildi.
Canlıda değil, geçici `maestro_mig_check` veritabanında doğrulandı:

- 11 migration temiz uygulandı;
- index WHERE'i `('done','cancelled','fail')` oldu;
- `fail` + yeni `running` aynı ticket'ta → **kabul** (yeniden koşu açıldı);
- iki `running` aynı ticket'ta → **reddedildi** (tekillik korunuyor).

Geçici veritabanı silindi. **Canlı DB'ye tek bir yazma yapılmadı** (16 satır hâlâ
`running`; ilk worker açılışında uzlaştırıcı düzeltecek).

---

## Güvenlik özellikleri

- **Fail-closed:** motorun hiçbir şey söylemediği koşu `running` bırakılır.
  Bilinmeyen bir koşuyu `done` yazmak onu panolardan düşürür ve bekleyen bir
  kapıyı görünmez yapardı — bayat `running`'den daha kötü olan tek sonuç.
- **Motor kaynak, DB kopya:** kod hiçbir durumu uydurmaz, yalnız kopyalar.
- **Workflow'un kendi durumları korunur:** `gate`/`queued`/`handover` satırlarına
  dokunulmaz (kapıda bekleyen koşu Temporal'a göre `Running`'dir; düzleştirmek
  "insan bekleniyor" bilgisini silerdi).
- **`terminated`/`timed_out` → `fail`** (`cancelled` değil): `cancelled` bu
  şemada "bir insan bilerek durdurdu" demek; altyapı zaman aşımını insan kararı
  gibi kaydetmek denetim izine kimsenin varmadığı bir sonucu yazardı.
- **İdempotent, iki katmanlı:** okuma zaten kapanmış satırları atlar; yazma aynı
  `notIn` filtresini taşıyan koşullu `updateMany`'dir. Denetim kaydı yalnız
  `count === 1` ise — yani satırı gerçekten bu geçiş taşıdıysa — yazılır.
- **Denetim izi:** `RUN_CLOSED` (donmuş contracts'ta zaten var), aktör
  `maestro-worker`, `meta: { runId, status, source: "temporal", executionStatus,
  temporalRunId, reconciled }`. `at` **motorun kapanış zamanı** — koşunun
  bittiği an, fark edildiği an değil.
- **Asla ölümcül değil:** uzlaştırma çökerse worker yine de poll eder (bayat pano
  ≠ teslimatsız banka); hata yüksek sesle loglanır.

---

## Testler: 12 yeni (`apps/deploy/test/reconcile.test.ts`)

İstenen üç kanıt:

1. **Çökmüş workflow → satır `fail`** + denetim kaydı doğru alanlarla ✓
2. **İkinci koşuş hiçbir şey değiştirmiyor** (satır, yazma sayacı, kayıt sayısı) ✓
3. **Emin olunamayan koşu `running` kalıyor**, denetim kaydı yazılmıyor ✓

Ayrıca: `completed → done`; gerçekten koşan koşuya dokunulmuyor;
`gate/queued/handover` korunuyor; `terminated`/`timed_out` → `fail`; yeniden
koşulan ticket en yeni execution'a çözülüyor; **eşzamanlı ikinci geçiş yazamıyor**
(yarış); ve **16 satırlık gerçek sürüklenmenin tek geçişte hizalanması**
(11 fail + 1 done + 4 dokunulmadan, sonraki geçiş no-op).

Denetim zinciri sahte değil: gerçek `AuditChain` + `InMemoryAuditStore`
(veritabanı index'lerinin dayattığı tekillikleri dayatır).

### Mutasyon kanıtı

| Mutasyon | Sonuç |
|---|---|
| Yalnız yazma guard'ı (`updateMany` `notIn`) kaldırıldı | **1 test kırıldı** (yarış testi) |
| Yalnız okuma filtresi kaldırıldı | Testler geçti — iki guard birbirini yedekliyor |
| **İkisi birden kaldırıldı** (= idempotency guard'ı kaldırmak) | **4 test kırıldı**: idempotency, yarış, korunan durumlar, 16 satırlık hizalama |

İlk mutasyon başta **hiçbir** testi kırmadı; bu bir test boşluğuydu ve mutasyon
denemesi onu buldu → eşzamanlılık yarışını izole eden test eklendi, sonra guard
geri alındı. Her iki guard da şu an yerinde, 12/12 yeşil.

---

## Kapı durumu — dürüst rapor

`pnpm run gate` **exit 0 vermiyor**, ama **sebebi bu değişiklik değil.**

- **Lint:** tüm repo temiz ✓
- **`@maestro/deploy`:** typecheck ✓, 493 test ✓
- **Diğer her şey:** `turbo run typecheck test` → **61/61 görev başarılı** ✓
- **Kırık olanlar:** `@maestro/studio` (11 test) ve `@maestro/adapter-jira`
  (9 test).

Bu 20 hatanın **temiz `main`'de de birebir aynı** olduğu `git stash` ile
doğrulandı. Hepsi M102 Jira-workflow işine ait (`screen.flow.title` ve
`invalid_project` anahtarları `tr` katalogunda yok; `readProjectWorkflow`
normalizasyonu) — yani **paralel ajanların alanı**, dokunmadım.

Kapıyı tıkayan tek lint hatası (`screens-flow.test.tsx`, kullanılmayan
`ReactNode` importu) tek satırlık olduğu için düzeltildi.

**Katalog paritesi bozulmadı:** bu iş hiç yeni mesaj anahtarı eklemedi
(uzlaştırıcının çıktısı operatör logu/denetim kaydı, kullanıcı metni değil).

---

## Yapmadıklarım

- **Canlı DB'ye yazmadım.** 16 satır hâlâ `running`; ilk worker açılışında
  kod düzeltecek.
- **Elle SQL ile hizalama yapmadım** (istendiği gibi).
- `delivery.ts` ve `listening-store.ts`'e **dokunmadım** (paralel ajanların alanı).
- **Donmuş paketleri değiştirmedim** — gerekmedi.
- Worker ayaktayken çöken koşuyu anında işaretlemedim (bir sonraki açılışta
  yakalanır). Sürekli izleme istenirse aynı fonksiyon `setInterval` ile
  koşturulabilir — idempotent olduğu için güvenli.
- Studio/adapter-jira'daki 20 kırık testi düzeltmedim (başka ajanın işi).

## ARAYÜZ İSTEKLERİ

**Yok.** `WorkflowRunStatus` ve `RUN_CLOSED` donmuş `packages/contracts`'ta
zaten mevcuttu.
