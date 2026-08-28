# DÜZELTME RAPORU — `apps/runner-agent` (doğrulama turu 1)

**Branch:** `fix/runner-agent-verifier-round1`
**Taban:** `451ddd8`
**Kapı:** `pnpm run gate` → **exit 0**, 56/56 görev.
**Test:** runner-agent **99** (önce 88), runners **227** (+3).

Doğrulayıcının üç kritiği ve bir yükseği kapatıldı. Doğrulayıcının teşhisi
doğruydu: üçünün kök nedeni tekti — `runSession` bir iptal sinyali taşımıyordu,
bu yüzden işe *girmiş* bir build'e ulaşacak hiçbir mekanizma yoktu.

---

## Sözleşme değişikliği (orkestratörden geldi, bende değil)

`packages/ports/src/runner.ts` **donmuş** ve değişiklik orkestratöre ait:

```ts
runSession(lease: RunnerLease, job: RunJob, signal?: AbortSignal): Promise<RunResult>;
```

Sözleşme: implementasyon sinyalde oturumu **yıkar ve reddeder**; iptalden sonra
normal `RunResult` dönmek yasak. Kiralamayı bırakmak her yolda çağıranın işi.
Bu dosyaya ben dokunmadım — paylaşılan checkout'taki hâlini birebir aldım.

---

## K-1 — `stop_all` çalışan build'i gerçekten durduruyor

**Ne yapıldı.** `job-runner.ts`'te iş başına bir `AbortController` var. Kill
switch, reddedilen kiralama ve kapanma **aynı** sinyalden iptal ediyor;
`runSession`'a `control.signal` geçiliyor. `runSession` iptalle reddettiğinde
sonuç `cancelled` olarak raporlanıyor (sebep `kill_switch` mi `lease_lost` mu,
abort gerekçesinden ayırt ediliyor). Sandbox yine `finally`'de yıkılıyor.

Sürücü tarafı: `packages/runners/src/docker-runner.ts` sinyali konteynerin
çıkışıyla **yarıştırıyor**; sinyal kazanırsa konteyner `kill`'leniyor ve oturum
**reddediyor**. Zaten iptal edilmiş sinyalle hiçbir şey yaratılmıyor
(`throwIfAborted`). Sinyal/dinleyici plumbing'i `deps.ts:abortRace`'e alındı
(dinleyici sızıntısı olmasın diye `release()` ile).

**Yanlış testi düzelttim.** `job-runner.test.ts:140-153` ("stop_all raised
DURING the session aborts the tracked job") yalnız **etiketi** doğruluyordu ve
işin sonuna kadar koştuğu implementasyonda da geçiyordu. Yerine **asla
bitmeyen** build kullanan üç test kondu; bunlar işin **bitmediğini** assert
ediyor (`FakeRunner.completed` boş). Doğru test, sinyal olmadan **asılır**.

**Mutasyon (MUT-A).** `runSession(lease, toRunJob(job))` — sinyal düşürüldü →
**5 test kırıldı**. Geri alındı.

---

## K-2 — Kiralama iş boyunca yenileniyor; reddedilirse iş kesiliyor

**Ne yapıldı.** `JobRunner.#startRenewals` oturum sürerken `checkLease`'i
periyodik çağırıyor; aralık `leaseRenewMarginSeconds` (marj aralığıyla poll →
kiralama lapse'ten **bir tam marj önce** yeniden doğrulanıyor). Reddedilen
yenileme (`LeaseLostError`) işi **sinyalle** kesiyor.

**Bilinçli ayrım:** ulaşılamayan platform işi **kesmez**. O bir yeniden atama
değil, taşıma arızasıdır; iyi bir build'i onun yüzünden öldürmek kendi başına
bir kesinti olurdu (kiralama zaten kendiliğinden dolar). Bu ayrımın kendi testi
var.

Zamanlayıcı **enjekte edilebilir** (`setTimer`/`clearTimer`), testler `sleep`
kullanmıyor; her yolda temizleniyor ("stops renewing once the session has
ended" testi bunu ölçüyor).

**Mutasyon (MUT-B).** Yenileme döngüsü no-op yapıldı → **3 test kırıldı**.

---

## K-3 — Kapanma **sınırlı**; sızan sandbox yolu kapandı

**Ne yapıldı.** Eski kod grace dolunca `abortAll()` çağırıp **koşulsuz**
`await settle()` yapıyordu — yani aynı bitmeyen promise'i tekrar bekliyordu.
Artık iptalden *sonraki* bekleme de sınırlı (`TEARDOWN_WINDOW_MS = 5 sn`); süre
dolarsa `runner_agent.shutdown_forced` loglanıp kapanma **yine de** tamamlanıyor
— kiralamalar geri veriliyor, `bye` gidiyor. `force: true` yolundaki sınırsız
bekleme de aynı sınırlı yola alındı.

Mantık `src/settle.ts`'e taşındı (agent.ts 300 satır sınırının altına indi:
289).

**Test boşluğu kapatıldı.** Mevcut test `grace: 0` kullandığı için **timer yolu
hiç çalışmıyordu**. İki test eklendi: (1) pozitif grace bir **sınırdır**,
(2) **sinyalini yok sayan** bir sürücü bile kapanmayı açık tutamaz.

> İkincisi olmadan mutasyon **hayatta kalıyordu**: ilk yazdığım test itaatkâr
> bir sürücü kullandığı için, koşulsuz `await settle()` geri konduğunda bile
> 98/98 geçiyordu. Yalnızca sürücü işbirliği yaptığında geçerli olan bir sınır,
> sınır değildir — test bu yüzden **itaatsiz** sürücüyle yazıldı.

**Mutasyon (MUT-C).** Sınırlı teardown → koşulsuz `await settle()` → test
**12 sn asılıp kırıldı**. (İlk, zayıf testle bu mutasyon hayatta kalmıştı;
raporluyorum çünkü testin neden güçlendirildiğini bu açıklıyor.)

---

## Y-1 — İki ölü ayar

- **`workDir` KALDIRILDI.** Zorunlu bir alandı, kodda **hiçbir tüketicisi
  yoktu**. Sandbox'ın deposu runner sürücüsünün işi (linux'ta docker volume'ü,
  win/mac'te ajanın kurulumu); bu süreç dosya yazmıyor. "Bankanın kaynağı buraya
  iner" sözünü veren ama tutmayan bir ayarı **uygulamak** yerine kaldırmak
  doğrusuydu — uydurulacak bir tüketici, operatöre verilen sözü gerçek yapmazdı.
  Dosyada kalmış eski bir `workDir` **yok sayılıyor**, hata vermiyor (testi var).
- **`logLevel` UYGULANDI.** `agent.ts:#log` seviyeye göre süzüyor. Seviyesi
  **tanınmayan** bir satır asla elenmiyor (önemli olan tek satırın kaybolma
  yolu). `error` seçen operatörün `info` gürültüsü görmediğini ve aynı koşunun
  `info`'da o satırları **ürettiğini** iki test ölçüyor.

**Mutasyon (MUT-D).** Seviye süzgeci devre dışı → **1 test kırıldı**.

---

## Raporun yanlış iddiaları düzeltildi

`RAPOR.md` iki şeyi yanlış söylüyordu; ikisi de yerinde **DÜZELTME** notuyla
işaretlendi (silinmedi — sonraki denetim neyin neden değiştiğini görmeli):

- satır ~35 "uzun bir build ortasında durur" → durmuyordu; sinyal yoktu.
- satır ~63-65 "`shutdownGraceSeconds` artık uygulanıyor" + "iptalden sonraki
  bekleme, yıkımın garantisi" → o bekleme **garantiyi yok eden şeydi**.

`README.md`'den `workDir` satırı ve örnek JSON alanı kaldırıldı; `logLevel`'in
artık uygulandığı yazıldı.

---

## Çalıştırma kanıtları (doğrulayıcının üç sondası tekrarlandı)

Sondalar geçici bir dosyada koşturuldu ve **silindi** (kalıcı karşılıkları süite
girdi). Önce/sonra:

| Sonda | ÖNCE (doğrulayıcı) | SONRA |
|---|---|---|
| (a) uzun build ortasında `stop_all` | `ran to completion: true`, outcome `cancelled` | `ran to completion: **false**`, outcome `cancelled`, `released: ["sandbox-1"]` |
| (b) uzun iş + kiralama | **0** renew isteği, `succeeded` | **4** renew isteği; reddedilince `cancelled` / `cancelled_lease_lost`, iş **bitmedi** |
| (c) `grace=1sn` + bitmeyen iş | `HUNG after 2507ms`, `released: []`, `bye: 0` | **`returned after 1007ms`**, `released: ["sandbox-1"]`, `bye: 1` |

---

## Mutasyon tablosu (bu tur)

| # | Mutasyon | Sonuç |
|---|---|---|
| MUT-A | `runSession`'dan `AbortSignal` düşürüldü | ✅ kırıldı (5) |
| MUT-B | Kiralama yenileme döngüsü no-op | ✅ kırıldı (3) |
| MUT-C | Sınırlı teardown → koşulsuz `await settle()` | ✅ kırıldı (1, 12 sn asıldı) |
| MUT-D | `logLevel` süzgeci devre dışı | ✅ kırıldı (1) |
| MUT-E | Docker sürücüsünde abort yarıştan çıkarıldı | ✅ kırıldı (1) |

---

## ARAYÜZ İSTEKLERİ

**Yok.** İhtiyaç duyulan tek arayüz değişikliği (`runSession` + `AbortSignal`)
orkestratör tarafından zaten yapılmıştı. `packages/contracts` ve
`packages/ports`'a dokunmadım.

---

## Kapatmadıklarım

Doğrulayıcının **O-2** ve **D-1** bulguları bu turun görev listesinde yoktu ve
açık bırakıldı:

- **O-2** — `agent.ts:154`'teki kapasite sınırı (`slice(0, free)`) doğru ama
  testi totolojik: `FakePlatform` zaten `max` kadar iş veriyor, dolayısıyla
  aşırı-dağıtım senaryosu hiç kurulmuyor. Kod **doğru**, eksik olan regresyon
  koruması. Kapatmak için `FakePlatform`'a `max`'ı aşan dağıtım seçeneği gerek.
- **D-1** — `authToken`'ın heartbeat'e sızmaması Zod'un `strip` davranışına
  bağlı. Şu an **sızıntı yok**; risk latent (şema bir gün `.passthrough()`
  alırsa sessizce açılır).

İkisi de kritik değil ve ikisi de bu turda istenmedi; bir sonraki tura
bırakıyorum.

## Dokunulan dosyalar

`apps/runner-agent`: `src/job-runner.ts`, `src/agent.ts`, `src/settle.ts`
(**yeni**), `src/errors.ts`, `src/execute-job.ts`, `src/config.ts`,
`test/{job-runner,shutdown,agent,config}.test.ts`, `test/helpers.ts`,
`RAPOR.md`, `README.md`.
`packages/runners`: `src/docker-runner.ts`, `src/provision.ts`, `src/deps.ts`,
`test/docker-runner.test.ts`.
`packages/config/locales/{tr,en}.json`: `runner_agent.shutdown_forced` (tr+en
parite).
`packages/ports/src/runner.ts`: orkestratörün donmuş değişikliği (benim değil).
