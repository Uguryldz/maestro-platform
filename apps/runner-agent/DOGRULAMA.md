# DOĞRULAMA — `apps/runner-agent` (Dalga 4, bağımsız denetim)

**Denetleyen:** bağımsız doğrulayıcı ajan
**Tarih:** 2026-08-09
**Çalışma yeri:** `/home/ubuntu/coder/maestro` (salt-okunur; tüm mutasyonlar geri alındı)
**Test durumu:** 88 test / 8 dosya — **doğrulandı**, rapordaki sayı doğru.
**Mutasyon testi:** 16 yapıldı, **3'ü hayatta kaldı** (aşağıda).

---

## KARAR ÖZETİ

Rapor "kill switch iki noktada", "kiralama reddedilen ajan işi bitiremez",
"sandbox her yolda yıkılır" ve "`shutdownGraceSeconds` artık uygulanıyor"
diyor. **Dördü de kâğıt üzerinde doğru, çalıştırınca üçü yanlış.**

Kök neden tek ve yapısal: `RunnerPort.runSession()` bir `AbortSignal`
**taşımıyor** (`packages/ports/src/runner.ts:30`). Ajanın "iptal" mekanizması
(`kill-switch.ts:18-20`) yalnızca bir **boolean bayrak** kuruyor; bu bayrak
sadece `await`'ler **arasında** okunuyor. Dolayısıyla bir iş `runSession`'a
girdiği anda **durdurulamaz hale geliyor**. Rapordaki "uzun bir build ortasında
durur" iddiası bu yüzden gerçekleşmiyor.

---

## BULGULAR

### K-1 — `stop_all` çalışan bir build'i GERÇEKTEN durdurmuyor; yalnız etiketi değiştiriyor
**Dosya:** `src/job-runner.ts:139-145`, `src/kill-switch.ts:17-20,75-78`

`runner.runSession()` çağrıldıktan sonra kill switch'in işe ulaşacağı **hiçbir
mekanizma yok**. `abort()` sadece `aborted` değişkenini yazıyor; `runSession`
bu değişkeni okumuyor ve okuyamaz — imzasında sinyal yok. Bayrak ancak
`runSession` **kendiliğinden bittikten sonra** (satır 143) kontrol ediliyor.

**Neden önemli:** M58'in tanımı budur. Dört saatlik bir Xcode build'inin
ortasında operatör `stop_all` bastığında, iş dört saat daha çalışmaya devam
ediyor, banka kaynak kodu ephemeral olmayan bir makinede işlenmeye devam
ediyor; ajan sonunda sadece sonucu `cancelled` diye raporluyor. Rapor
(`RAPOR.md:35`) bunun tersini iddia ediyor: "uzun bir build ortasında durur."

**Nasıl kanıtladım:** `runSession` içinden `stop_all` uygulayan bir sonda
testi. Çıktı:
```
entered session: true | build ran to completion: true
reported outcome: cancelled  stoppedAt: collect
```
Yani iş **sonuna kadar koştu**, sadece "cancelled" etiketi aldı. Mevcut
`job-runner.test.ts:140-153` testi tam da bu yanlış davranışı "doğru" diye
sabitliyor — yorumu ("the session had already been handed to the sandbox, so it
ran") kusuru kabulleniyor ama başlığı (`stop_all raised DURING the session
aborts the tracked job`) "abort" olduğunu iddia ediyor. Hiçbir şey abort
edilmiyor.

---

### K-2 — Uzun iş sırasında kiralama HİÇ yenilenmiyor; süresi dolan kiralamayla iş bitiriliyor ve BAŞARILI raporlanıyor (çift koşum)
**Dosya:** `src/job-runner.ts:121-137` (tek `checkLease` çağrısı), `src/execute-job.ts:49`

`checkLease` yalnızca `runSession`'dan **önce, bir kez** çağrılıyor. `runSession`
sırasında ve sonrasında kiralama ne doğrulanıyor ne yenileniyor. `LeaseManager`
tam ve doğru yazılmış (yenileme, marj, red, süre dolması) ama **onu periyodik
çağıran hiçbir şey yok** — ne `JobRunner` içinde bir zamanlayıcı, ne
`main.ts`'te bir renew timer'ı. `main.ts:84-93` sadece heartbeat ve pull
timer'ı kuruyor.

**Neden önemli:** Kiralamanın varlık sebebi çift koşumu engellemek. İş
kiralamadan uzun sürerse: platform kiralamayı başka ajana devrediyor, bu ajan
bundan **habersiz** işi bitiriyor ve `succeeded` raporluyor. İki sandbox aynı
workspace'i yazıyor, iki PR açılıyor. Rapor (`RAPOR.md:38-40`) "yenilemesi
reddedilen ajan işi bitiremeden durur" diyor — reddi **soracak** bir çağrı
olmadığı için bu koruma hiç devreye girmiyor.

**Nasıl kanıtladım:** 60 saniyelik kiralama + 10 dakika süren build sondası.
Platform kiralamayı reddetmeye ayarlandı (`refuseRenewal`). Çıktı:
```
renew requests during whole build: 0
completion reported: [{... "outcome":"succeeded" ...}]
```
**Sıfır** yenileme isteği; kiralama 9 dakika önce ölmüşken iş `succeeded`
olarak raporlandı.

---

### K-3 — `shutdownGraceSeconds` uygulanmıyor: zarif kapanma SONSUZA KADAR asılı kalıyor
**Dosya:** `src/agent.ts:223-245` (`#settleWithin`), özellikle **satır 240**

Mantık şu: grace timer'ı dolunca `abortAll()` çağrılıyor (satır 239), **sonra
`await this.settle()` yapılıyor** (satır 240). Ama `abortAll` yalnız bayrak
kuruyor (K-1) — takılı `runSession`'ı bitirmiyor. `settle()` aynı bitmeyen
promise'i tekrar bekliyor. Sonuç: **sınır yok**.

Rapor (`RAPOR.md:63-65`) bunu düzelttiğini, hatta "iptalden sonraki bekleme,
yıkımın gerçekten koştuğunun garantisi" diye açıkça savunuyor. Gerçekte o
bekleme **garantiyi yok eden şeyin ta kendisi**.

**Neden önemli:** SIGTERM alan servis kapanmıyor → launchd/nssm bekleme süresi
dolunca **SIGKILL** gönderiyor → `release()` hiç çalışmıyor → **sandbox
sızıyor**. Bu, raporun "her yolda yıkılır" invaryantını gerçek dünyada
bozan yol. Denetim listesindeki "sızan sandbox bırakan bir yol var mı?"
sorusunun cevabı: **evet, bu.**

**Nasıl kanıtladım:** `shutdownGraceSeconds: 1`, hiç bitmeyen iş:
```
outcome: HUNG   after ms: 2507      (1 sn grace'e rağmen)
sandbox released? []
bye sent? 0
```
İzleme sondası kök nedeni doğruladı: 1.5 sn sonra grace timer **ateşlemiş**
(`runner_agent.shutdown` logu var), `abortAll` koşmuş, ama durum hâlâ
`draining`, `activeJobs: 1`, `released: []`. İşi elle serbest bırakınca
kapanma tamamlandı.

**Mutasyon kanıtı (MUT-9):** `shutdownGraceSeconds` yerine sabit 999999999 sn
yazdım → **88/88 test geçti**. Ayar tamamen ölü; hiçbir test onu ölçmüyor.
Mevcut `shutdown.test.ts:22` testi `shutdownGraceSeconds: 0` kullanıyor, bu da
`#settleWithin`'in `graceMs <= 0` erken-dönüş dalına giriyor — **timer yolu hiç
test edilmiyor.**

---

### Y-1 — İki ölü ayar daha: `workDir` ve `logLevel`
**Dosya:** `src/config.ts:46` (`workDir`), `src/config.ts:47` (`logLevel`)

Rapor bir ölü ayar (`shutdownGraceSeconds`) bulup düzelttiğini söylüyor
(`RAPOR.md:63`). **İki tanesi daha var** ve raporda geçmiyorlar:

- `workDir` — **zorunlu** alan (varsayılanı yok, eksikse ajan açılmıyor), ama
  şema ve env okuması dışında **kodda hiçbir yerde okunmuyor**.
- `logLevel` — okunuyor, doğrulanıyor, hiçbir zaman **uygulanmıyor**;
  `#log` (`agent.ts:283-285`) seviyeye bakmadan her şeyi geçiriyor.

**Neden önemli:** `workDir` operatöre "ajanın çalışma alanını buraya kur"
sözü veriyor; ajan o dizini kullanmıyor. Sandbox'ın nereye yazdığına dair
operatör güvencesi **sahte**. `logLevel: "error"` ayarlayan operatör de debug
gürültüsünü kesemez. Kontrol listesi §1'in tam olarak sorduğu şey.

**Nasıl kanıtladım:** `grep -rn "workDir\|logLevel" src/` → yalnızca
`config.ts` içindeki şema + env satırları; tüketen yok.

---

### O-1 — `mayContinueRunning()` mutasyonu testlerce yakalanmıyor (K-1'in test tarafı)
**Dosya:** `src/kill-switch.ts:75-78`

**MUT-10:** `#abortAll` gövdesini tamamen boşalttım
(`for (...) job.abort(reason)` → `void reason;`) → **88/88 geçti**.

**Neden önemli:** Kill switch'in "çalışan işe ulaşma" yeteneği hiçbir testle
korunmuyor. Biri bu döngüyü silse süit yeşil kalır. Bu, K-1'in neden fark
edilmediğini de açıklıyor: abort mekanizması gözlemlenebilir bir etki
üretmediği için testler onu ölçemiyor.

---

### O-2 — Platform aşırı iş dağıtırsa kapasite sınırı testlerce korunmuyor
**Dosya:** `src/agent.ts:154`

**MUT-12:** `reply.jobs.slice(0, free)` → `reply.jobs` → **88/88 geçti**.

Kod doğru, ama `agent.test.ts:119-135` başlığı "never starts more jobs than the
free capacity, whatever the platform sends" olan test bunu **ölçmüyor**:
`FakePlatform` zaten `max` kadar veriyor (`fake-platform.ts:84`), dolayısıyla
aşırı-dağıtım senaryosu hiç kurulmuyor. Test yalnız `max: 1` gönderildiğini
doğruluyor. Ele geçirilmiş/bozuk bir platforma karşı savunmanın regresyon
koruması yok — totolojik test (§4).

---

### D-1 — `authToken`'ın heartbeat'e sızmaması Zod'un `strip` davranışına bağlı, koda değil
**Dosya:** `src/platform-client.ts:68-69,109`

**MUT-15:** `heartbeat`'in `withToken` bayrağını `false`→`true` yaptım →
**88/88 geçti**, token yine tele çıkmadı.

Sebep: `AgentHeartbeat` şeması `authToken` alanı tanımlamıyor, Zod varsayılan
`strip` modunda bilinmeyen anahtarı **sessizce atıyor**. Doğruladım:
```
parse ok: true | authToken present after parse: false
```
Şu an **sızıntı yok** (bu yüzden D). Ama koruma tesadüfi: şema bir gün
`.passthrough()` alırsa ya da mesaj `#post`'a şemadan geçmeden verilirse
(`sendLog`/`completeJob` yolları `#send`'i kullanmıyor) sızıntı sessizce
açılır. `platform-client.test.ts:50`'deki assert doğru ama mutasyonu
yakalayamıyor.

---

## DOĞRULANAN (gerçekten sağlam olanlar)

Aşağıdakileri kırmaya çalıştım ve **kıramadım** — rapordaki iddia doğru:

- **Maskeleme sırası (§ öncelikli kontrol).** Sıra gerçekten ① literal sır →
  ② PII. Ters çevirdim (**MUT-6**) → test kırıldı. Hesap numarasına benzeyen
  20 haneli bir token'ı denedim: çıktı `token=[REDACTED]`, geri çevrilebilir
  `[ACCOUNT_n]` **değil**. Literal katmanı kapattım (**MUT-16**) → 7 test
  kırıldı. Bu katman sağlam.
  *Küçük not:* 8 karakterden kısa iş-env sırları bilerek maskelenmiyor
  (`MIN_REDACTABLE_LENGTH`); gerekçesi kodda yazılı ve makul, bulgu saymadım.
- **Fail-closed açılış.** Boş env ile `loadRunnerAgentConfig` **açılmadı**,
  yedi eksik alanı da isimlendirdi. Hatalı URL ile de açılmadı. Hata
  metinlerini taradım: **token/parola sızmıyor**, yalnız değişken **adı**
  geçiyor.
- **M22 — dışa doğru bağlantı.** `listen` / `createServer` / `bind` /
  `WebSocketServer` taraması: `src/` ve `scripts/` içinde **sıfır** eşleşme
  (tek hit `platform-client.ts:24`'teki yorum satırı). Sunucu/port yok.
- **Protokol tutarlılığı (§3).** `src/protocol.ts` gerçekten sadece yeniden-ihracat;
  `packages/runners/src/agent-protocol.ts` ile karşılaştırdım — `PullGranted`,
  `LeaseRenewed`, `LeasedJob`, `AgentLogChunk`, `AgentJobCompleted` alan alan
  **birebir** uyuyor, iki isim (`PullReply`/`LeaseRenewReply`) doğru alias'lanmış.
  Halüsinasyon API yok: `RunnerPort.acquire/runSession/release` imzaları
  `packages/ports/src/runner.ts` ile uyuşuyor.
- **Kiralama muhasebesi.** `expire()` (**MUT-13**), `assertHeld` süre kontrolü
  (**MUT-14**), reddedilen yenileme (**MUT-5**) — üçü de mutasyonla kırıldı.
  Sınıf doğru; kusur onu **çağırmayan** tarafta (K-2).
- **Rapor iddiası "önce raporla, sonra unut" (§ öncelikli kontrol).**
  `execute-job.ts:67-78` sırası **gerçekten öyle**. Ters çevirdim (**MUT-7**)
  → test kırıldı. Bu düzeltme doğrulandı.
- **Sandbox yıkımı — `finally` yolu.** `release`'i sildim (**MUT-4**) → 9 test
  kırıldı. Başarı/hata/iptal/lease-kaybı yollarında yıkım gerçekten koşuyor.
  *Ama* kapanma yolunda K-3 nedeniyle koşmuyor.
- **Kısa token reddi.** (**MUT-11**) → test kırıldı.
- **Zaman bağımlılığı (§ öncelikli kontrol).** Testler `FakeClock` ile
  enjekte edilmiş saat kullanıyor; `helpers.ts:7-23`. Süitte `sleep` yok,
  1.26 sn'de bitiyor. **Flake gözlemlemedim** — 5 tam koşuda 88/88 kararlı.
  Zamanlama hassasiyeti değil, gerçek sonuç.

---

## MUTASYON TESTİ TABLOSU (16 mutasyon)

| # | Mutasyon | Sonuç |
|---|---|---|
| MUT-1 | `job-runner` checkpoint-1 (acquire öncesi) silindi | ✅ kırıldı (1) |
| MUT-2 | `checkLease` sonrası **yeniden** kill kontrolü silindi | ✅ kırıldı (1) |
| MUT-3 | checkpoint-3 (collect) silindi | ✅ kırıldı (1) |
| MUT-4 | `runner.release()` (sandbox yıkımı) atlandı | ✅ kırıldı (9) |
| MUT-5 | Reddedilen yenileme yoksayıldı (`granted:false` throw etmiyor) | ✅ kırıldı (1) |
| MUT-6 | Maskeleme sırası ters çevrildi (önce PII) | ✅ kırıldı (1) |
| MUT-7 | `forget()` rapordan **önce**e alındı | ✅ kırıldı (1) |
| MUT-8 | `pause_intake` yeni iş almaya izin verdi | ✅ kırıldı (1) |
| **MUT-9** | **`shutdownGraceSeconds` yoksayıldı (sonsuz bekleme)** | ❌ **HAYATTA (88/88)** → K-3 |
| **MUT-10** | **`#abortAll` gövdesi boşaltıldı** | ❌ **HAYATTA (88/88)** → O-1 |
| MUT-11 | Kısa token reddi kaldırıldı | ✅ kırıldı (1) |
| **MUT-12** | **Kapasite sınırı (`slice(0, free)`) kaldırıldı** | ❌ **HAYATTA (88/88)** → O-2 |
| MUT-13 | `expire()` no-op yapıldı | ✅ kırıldı (1) |
| MUT-14 | `assertHeld` süre kontrolü kaldırıldı | ✅ kırıldı (1) |
| **MUT-15** | **`authToken` heartbeat'e de eklendi** | ❌ **HAYATTA (88/88)** → D-1 |
| MUT-16 | Literal maskeleme katmanı kapatıldı | ✅ kırıldı (7) |

**Öldürme oranı: 12/16 (%75).** Hayatta kalan 4 mutasyonun 3'ü doğrudan bir
gerçek kusura karşılık geliyor (K-3, O-1, O-2), 1'i latent risk (D-1).

---

## ÖNERİLEN DÜZELTMELER

1. **`RunnerPort.runSession`'a `AbortSignal` ekle** (arayüz isteği — `ports`
   donmuş). K-1, K-2 ve K-3'ün **ortak** kök nedeni budur; sinyal olmadan
   üçü de app katmanında tam çözülemez. Ajanın `abort()`'u bu sinyali
   tetiklemeli.
2. **Ara çözüm (K-3 için, `ports` beklenmeden):** `#settleWithin`'de
   `abortAll()` sonrası `settle()`'ı da **süreli** yarıştır; süre dolarsa
   tutulan sandbox'lar için `release()`'i doğrudan çağırıp kapanmayı
   tamamla. Şu anki koşulsuz `await settle()` (agent.ts:240) sınırı yok ediyor.
3. **Kiralama yenileme döngüsü (K-2):** `main.ts`'e bir renew timer'ı ya da
   `JobRunner.run` içine `runSession` ile yarışan periyodik `assertHeld`
   çağrısı ekle; `LeaseLostError` gelince işi iptal et. `LeaseManager` hazır,
   sadece çağrılmıyor.
4. **`workDir` / `logLevel` (Y-1):** ya uygula (workDir'i sandbox köküne geçir,
   logLevel'i `#log`'da süz) ya da şemadan kaldır. Zorunlu ama kullanılmayan
   bir ayar operatöre yanlış güvence veriyor.
5. **Test boşlukları:** grace timer yolunu `shutdownGraceSeconds > 0` ile test
   et; `FakePlatform`'a `max`'ı **aşan** dağıtım seçeneği ekle (O-2);
   `#abortAll`'un gözlemlenebilir etkisini assert et (O-1).

---

## AĞAÇ TEMİZLİĞİ

Tüm mutasyonlar ve sonda test dosyaları geri alındı/silindi.
`git status --short apps/runner-agent/` → **boş** (bu rapor dosyası hariç).
Denetim öncesi mevcut olan `eslint.config.mjs` ve `package.json` değişiklikleri
**bana ait değil** (başka bir ajanın gate-runner çalışması); onlara dokunmadım.
Denetim sonrası süit: **88/88 yeşil.**

---

# KARAR

# KALDI

**Gerekçe:** Üç **kritik** bulgu var ve üçü de bu paketin var oluş sebebi olan
güvenlik özelliklerini vuruyor:

- **K-1** `stop_all` çalışan işi durdurmuyor → M58 karşılanmıyor.
- **K-2** Kiralama uzun işte hiç yenilenmiyor, süresi dolmuş kiralamayla iş
  `succeeded` raporlanıyor → **çift koşum**, yani kiralama modelinin
  engellemek için var olduğu tam senaryo.
- **K-3** `shutdownGraceSeconds` uygulanmıyor, kapanma asılı kalıyor →
  SIGKILL → **sızan sandbox**.

Ayrıca raporun kendi "düzelttim" iddialarından ikisi (#1'in çalışan-iş ayağı ve
#3 `shutdownGraceSeconds`) **doğrulanamadı** — kod o niyetle yazılmış ama
çalışmıyor. Kaliteli olan çok şey var (maskeleme, fail-closed config, M22
yönü, protokol uyumu, `LeaseManager`'ın kendisi, 12/16 mutasyonu öldüren
testler) ama kritik bulgular varken karar `GECTI` olamaz.
