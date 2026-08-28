# @maestro/workflows — Dalga 3 aktivite gerçeklemeleri (RAPOR)

Dal: `wave3/workflows-activities` · Kapsam: `MaestroActivities` arayüzünün gerçeklenmesi,
Temporal worker kompozisyon kökü ve zaman-atlatmalı workflow testleri.

> **Bölüm 0 (aşağıda) bu raporun en güncel kısmıdır.** Bağımsız doğrulama turu
> `src/ticket-workflow.ts`'te dört kritik bulgu çıkardı; o tur kapatıldı ve
> workflow dosyası artık orkestratörün ilk hâli değil. 1-6. bölümler ilk teslimi
> anlatıyor ve tarihsel kayıt olarak duruyor.

---

## 0. Doğrulama turu — 20 bulgu kapatıldı (2026-08-09)

Bulguların çoğu **workflow'un kendisindeydi**, aktivitelerde değil. Hepsi canlı
`TestWorkflowEnvironment` koşumuyla doğrulandı: her düzeltmenin **önce kırılan bir
testi** yazıldı ve düzeltmeden önce eski kodda gerçekten kırıldığı ölçüldü.

### K1-K4 · Kritik

| # | Neydi | Ne yapıldı |
|---|---|---|
| **K1** | Kill-switch **merge'i durdurmuyordu**: son kapı onayı alındıktan sonra `mergePullRequest` → `buildEvidencePackage` → `closeTicket` kontrolsüz koşuyordu. Sistemdeki tek geri alınamaz eylem acil durdurmayı dinlemiyordu. | 13. adımdan **hemen önce** `assertNotKilled()`. Negatif iddialı test: kill gate-12 kararı yazılırken gönderiliyor, `mergePullRequest` sahtesi **hiç çağrılmıyor**. |
| **K2** | Kill sonrası **tüm adım zinciri** koşmaya devam ediyordu (taramalar, inceleme, testler) çünkü kontrol yalnız döngü başlarındaydı. | Kontrol `goto()` **içine** taşındı — her adım geçişinde koşuyor. Merkezî ve tek noktadan. Test: kill 6a sırasında geliyor, `calls === ["ENGINEERING"]` (sonrası hiç başlamıyor). |
| **K3** | `intake_only` (M58 seviye ①) **tamamen ölüydü** — yazılıyor, hiç okunmuyordu. Sessiz fail-open. | Artık okunuyor: adım 0'daysa koşu **durur**; başlamış koşuda **deftere yazılır** ("seviye ① — başlamış koşu etkilenmez"). Sessizlik yok (M14). |
| **K4** | `ticketWorkflowContinue` → `ticketWorkflow(input)` **aynı execution içinde özyineleme**. Tüm yerel durum sıfırlanıyordu: kapı sayacı (M54 hiç ateşlenmiyordu — 5 ret → kapı 6 kez açıldı), `resumeToken` (**M30 ikinci rette kayboluyordu**), geçmiş 703 olaya şişiyordu. | Gerçek **`continueAsNew`** (M29). Ayrıntı için aşağıdaki bölüm. |

### `continueAsNew` geçişinde tam olarak ne değişti

Özyineleme iki ayrı şeyi aynı anda bozuyordu ve ikisi de sessizdi:

1. **Tek execution, şişen geçmiş.** Her ret aynı koşunun geçmişine ekleniyordu.
   Temporal'ın olay limiti sert; uzun yaşayan bir ticket burada istisna değil kural.
2. **Durum yeniden doğuyordu.** Özyineleme `input`'la giriyordu, dolayısıyla her yerel
   `let` varsayılanına dönüyordu — sayaç sıfır (M54 ölü), `resumeToken` `null`
   (M30 ölü), `risk` yeniden `"orta"`.

Çözüm, taşınması gereken durumu **açıkça input'a** koymak:

```ts
export interface TicketWorkflowInput {
  ticket: TicketKey; appId: string; mode: WorkMode; dataClass: DataClass;
  rejectionCounts?: Record<string, number>;  // M54 sayacı
  resumeToken?: string | null;               // M30 oturumu
  risk?: RiskTier;                           // analizin belirlediği kademe
}
```

- **Sayaç** `run-state.ts`'teki `countRejection()` ile kapı bazında tutuluyor; aynı
  kapıda 3 rette `handOver` (M54). Analiz kapıları (4/5) ve PR kapıları (11/12) için
  ayrı ayrı sayılıyor, ikisi de test edildi.
- **`resumeToken`** her devirde taşınıyor: artık **yalnız bir** tur `resumeToken === null`
  ile başlıyor (ilk tur), sonrası hep aynı oturum.
- **`risk`** ret sonrası yeniden yazılan analizden **güncelleniyor** (eski kod
  `redone.risk`'i atıyordu — O3) ve devre taşınıyor, yoksa devam eden koşu yanlış kapı
  setinden geçerdi.
- **CI döngüsü de sınırlandı**: aynı kırmızı build 3 kez düzeltilemezse devir (M54).
  Eskiden sınırsızdı.

**Testlerdeki etki:** ret senaryolarında artık iki ayrı execution var. `runTicket`
`handle.result()` beklediği için devir zinciri şeffaf — testler koşunun *sonucunu*
görüyor, `opened` gibi sayaçlar ise sahte aktivitede biriktiği için devirden etkilenmiyor.

### Y1-Y5, O1-O4 · Yüksek ve orta

| # | Neydi | Ne yapıldı |
|---|---|---|
| **Y1** | Kapı açılmadan **önce** gelen karar sessizce siliniyordu (`inbox.decision = undefined`). Onaylayan `/approve` yazıyordu, kapı yine 30 hatırlatıcı bekliyordu. Onayların ana yolu Jira yorumu (M51) olduğu için **sık** yaşanacaktı. | **Kuyruk**: `decisions: GateDecision[]`. Handler `push`, döngü `shift`. Toplu temizleme kaldırıldı. Yanlış kapıya ait karar zaten `canCloseGate`'in `wrong_step` kontrolüyle reddediliyor. |
| **Y2** | Aynı kapıya arka arkaya iki karar → koşu **kilitleniyordu** (test 180 sn timeout'a düşüyordu). | Aynı kuyruk düzeltmesi + döngü **bir turda kuyruğu boşaltıyor**. Test: reddedilecek karar + geçerli karar aynı kuşakta → koşu `done`, **sıfır hatırlatıcı**. |
| **O1** | CI döngüsü başındaki `inbox.ci = undefined`, saatler süren `runEngineering` sırasında gelen **yeşil sonucu siliyordu**. Gerçek ADO bir kez gönderir. | `ciResults` kuyruğu, döngü başında temizleme yok. Test harness'ı da düzeltildi (aşağıda). |
| **Y3** | Idempotency anahtarları **sonuçtan** türetiliyordu (`scan:gitleaks=fail,...`). Üç tarama turu → **1 defter kaydı**. Denetim ekibine sunulan kanıt paketi eksik oluyordu. | Anahtarlara **tur ayırt edicisi** eklendi: `runScans/reviewDiff/reviewTests/designTests/runTests/runEngineering` artık `attempt` alıyor (`MaestroActivities` imzasında opsiyonel). İçerikten türeyen `journal` ve `writeAnalysis` anahtarları ise **`Activity.info().activityId`** kullanıyor — bir aktivitenin *yeniden denemesi* aynı id'yi taşır (çakışır, doğru), *sonraki tur* yeni id alır (ayrı kayıt, doğru). |
| **Y5** | `modeChangeSignal` ölüydü; BFF `/ai-takeover` ucu **200 dönüyor**, workflow yok sayıyordu. Halüsinasyon entegrasyon. | **Açıkça reddediliyor** (M14): mod ilk `await`'ten önce okunduğu için koşu ortasında değiştirilemez, ve bu karar deftere yazılıyor ("mod değişikliği reddedildi · … koşu ortasında değiştirilemez (M46)"). *Seçim gerekçesi:* modu gerçekten değiştirmek `human_lead` dalının tüm adımlarını yeniden tanımlamayı gerektiriyor — bu bir **ürün kararı**, sessizce kod düzeltmesi değil. Sessiz kalmak kabul edilemezdi; yanlış yönlendirmek de. |
| **O2** | `thinkActs` üst sınırı ~50 saat; **haftalık** kotası dolmuş hesapta koşu düşerdi. | `maximumAttempts: Number.POSITIVE_INFINITY` (sınırsız). Sonsuz retry riski yok: kota hatası `nextRetryDelay` ile pencerenin gerçek açılma anını taşıyor, koşu o ana kadar uyuyor ve hiçbir maliyeti yok; kota dışı hatalar zaten `nonRetryable`. **Dikkat:** doğrulayıcının önerdiği `maximumAttempts: 0` bu SDK'da sınırsız *demek değil* — `compileRetryPolicy` onu reddediyor ve koşu **ilk düşünme çağrısında** (`runIntake`, adım 2) ölüyor. Bunu uçtan uca test yakaladı; SDK'nın "sınırsız" yazımı `POSITIVE_INFINITY` (alanı düşürüyor). |
| **O3** | Ret sonrası `redone.risk` atılıyordu; özyineleme yüzünden 3. adım boşuna koşuyordu (ölü iş). | K4 ile birlikte: `state.risk` güncelleniyor ve devre taşınıyor. |
| **O4** | `blocked` dalında kalıcı hata atıldığı için `status="handover"` **hiç atanmıyordu**; devir kayıtları yazılmış olmasına rağmen koşu `fail` kapanıyor, Studio "başarısız" gösteriyordu. | `finishTurn`'ün `blocked` dalı artık **`handoverReason` döndürüyor**. Uyumluluk kararı yine kayıt altında (`handOver` çağrısı duruyor), ama workflow karar verebiliyor ve ticket doğru şekilde `handover` kapanıyor. |

### D1-D7 · Düşük

- **D1** `updatedAt` artık her adım geçişinde ilerliyor (eskiden hep `startedAt`'ti).
- **D2** Sorgu `workflowInfo().runId` döndürüyor (eskiden `workflowId`'yi runId diye raporluyordu).
- **D3** `ticket-workflow.ts`'teki gereksiz `export { isApprovalGate }` kaldırıldı (`index.ts` zaten `gates.js`'i re-export ediyor).
- **D4** Ölü `nextStep`/`blocksOnHuman` **silindi**; onları canlı gösteren testler de. Yerine risk kademesi kapı setini doğrudan doğrulayan testler kondu.
- **D5** `secrets` hâlâ kullanılmıyor ama **neden durduğu** yazıldı (push credential dikişi).
- **D6** `createMaestroWorker` artık süreç-içi idempotency guard'ıyla ayağa kalkarken **uyarıyor**: çok worker'lı dağıtımda tablo destekli guard gerekiyor. Atmıyor — bu bir dağıtım hatası, kod hatası değil — ama sessiz de kalmıyor.
- **D7** `GATE_OWNER`'ın parametrik **olmadığı** ve ne zaman olması gerektiği (ikinci proje onboard edilmeden önce, `ParamReader.gateOwners`) dosyada yazılı.

### Y4 · M51 netleştirmesi (orkestratör kararı)

`kritik` kapı seti **5 doğru**: `["4","5","9","11","12"]`. Eski masterplan metnindeki "6"
clarification beklemesini (2b) de sayıyordu; **2b bir onay kapısı değil**, her kademede
bulunan süresiz insan beklemesidir. Onay kapısı sayısı 2/4/5, insan teması 3/5/6.
`packages/contracts` **değişmedi** ve değişmeyecek.

### Test kalitesi — yapısal kör noktalar kapatıldı

Doğrulayıcının işaret ettiği dördü de düzeltildi; her biri bir bulguyu **görünmez
kılıyordu**:

1. **`test/scenario.ts` — `openGate` stub'ı kararı yalnız kendi içinden gönderiyordu**,
   yani her zaman kapı açıldıktan *sonra*. Y1'in yarışı bu tasarımla test edilemez
   hâldeydi. Artık `earlyDecision` kancası var: workflow adımı **duyurduğu anda**
   (`adım <step>` defter satırı, `openGate`'ten önce) karar gönderilebiliyor.
2. **`test/workflow-loops.test.ts` tarama kayıtlarını sahte aktivitenin kendi
   listesinden sayıyordu**, gerçek `record()` çağrısından değil — Y3 bu yüzden
   görünmüyordu. Y3 testi artık `fakes.journalStore.entries` üzerinden, yani gerçek
   idempotency guard'ından geçerek sayıyor.
3. **Kill-sonrası-merge için negatif iddia yoktu** (K1 bu yüzden görünmedi). Eklendi.
4. **`test/harness.ts` `ciGateOpen` iken sinyali sonsuz döngüde yeniden gönderiyordu**;
   gerçek ADO bir kez gönderir, bu O1'i maskeliyordu. Artık **build başına tek gönderim**
   (`takeCiSend()` mandalı), ve mandal yalnız yeni bir build sonucu güncel olduğunda
   yeniden kuruluyor.

### Sayılar

**122 test, 10 dosya, tamamı yeşil** (tur öncesi 111/9). Eklenen 11 testin
**7'si düzeltmeden önceki kodda gerçekten kırıldı** ve bu ölçüldü — üçü
(Y1, O1, K4-sayaç) 180 sn timeout'a düşerek, yani doğrulayıcının bildirdiği
kilitlenme semptomunu birebir üreterek. Kalan dördü (Y3 ×2, O4, D6) aktivite
seviyesinde yeni davranışı pinliyor.

İlk yazımda iki test eski kodda da geçiyordu, yani hiçbir şey kanıtlamıyordu;
ikisi de **bulguyu gerçekten hedefleyecek şekilde sertleştirildi**: Y2 artık önce
reddedilecek bir karar gönderiyor (tek yuvalı kod bunu işlerken arkasındaki
geçerli kararı siliyordu), M30 testi ise reti **12. kapıya** taşıyıp devrin
`resumeToken`'ı taşıdığını doğruluyor.

### Dosya bölünmesi

`ticket-workflow.ts` düzeltmelerle 585 satıra çıkmıştı (≤300 kuralı). Anlamlı sınırlardan
bölündü — davranış değişmeden:

| Dosya | Sorumluluk |
|---|---|
| `src/ticket-workflow.ts` (288) | Adım dizisi ve devir kararı. |
| `src/run-state.ts` (118) | Koşunun hatırladığı her şey + sinyal kuyrukları + M54 sayacı. Temporal'a bağımlı değil. |
| `src/gate-loop.ts` (136) | Kapı bekleme döngüsü, kill-switch, mod isteği yanıtı. |
| `src/engineering-loop.ts` (155) | 6a-10 döngüsü ve 10b CI bekleme döngüsü. |

---

## 1. Ne yazıldı

### `src/impl/` — aktivite gerçeklemeleri

| Dosya | İçerik |
|---|---|
| `deps.ts` | `ActivityDeps` ve dikişler: `RunContextStore`, `GateStore`, `ParamReader`, `DirectoryReader`, `AgentTurnRunner`, `IdempotencyGuard`, `Translate`. Hepsi **arayüz** — hiçbir somut sürücü import edilmiyor (M44). |
| `record.ts` | Her aktivitenin bıraktığı üç iz: defter (`appendJournal`, M82 maskeleme sınırından geçer), hash-zincirli denetim kaydı (M33), bildirim (`routeNotification`, M45/M104). Susturulan olay defterde "susturuldu" olarak görünür — sessizce kaybolmaz. |
| `outcome.ts` | `LlmOutcome`'ın dört ucu (M18/M55/M97): `ok` → değer; `queued` → **yeniden denenebilir** `ApplicationFailure` + `nextRetryDelay` (Temporal bekler); `degraded` → work mode `ai_assist`'e düşer, akış sürer; `blocked` → insana devir + **kalıcı** hata. `switch` tüketici (beşinci durum derlemeyi kırar). |
| `intake.ts` | `resolveWorkMode`, `matchApplication` (M99 üç kademe: kural → AI önerisi (eşik 0.5, kapıda doğrulanır) → `null` = akış durur), `runIntake`, `askClarification`. |
| `analysis.ts` | `discoverRepo` (3ö: salt-okunur ajan oturumu, `resumeToken` saklanır — M30), `writeAnalysis` (AnalysisDoc şeması + **M83 şablon sürümü** ve **M59 dil** kontrolü, risk **belgeden**), `publishAnalysis`, `fanOutChildren` (M100 etki matrisi). |
| `gate.ts` | `openGate` (idempotent — çapa oynamaz), `recordGateDecision` (dizinden üyelik doğrulaması; onay **insan aktöre** yazılır — M32/M101), `escalateGate` (M88 merdiveni; **tek kaynak DB'deki `escalation.ladder`**), `journal`, `handOverToHuman`. |
| `engineering.ts` | `runEngineering` (`@maestro/execution` turu; `resumeToken` **workflow'unki** kazanır), `reviewDiff`/`reviewTests`/`designTests`, `runTests`. |
| `scan.ts` | `runScans` — çekirdek üçlü, **fail-closed**; sürücü **istisna atarsa bile** `error` sonucu üretilir (aktivite hata verip 3 denemede koşuyu düşürseydi tarama kaydı hiç oluşmazdı). |
| `delivery.ts` | `openPullRequest`, `activatePullRequest`, `verifyCiOrigin` (**M106**), `mergePullRequest` (yalnız `completed` PR'ın merge sha'sı), `buildEvidencePackage` (**audit zinciri önce doğrulanır**, kırıksa paket üretilmez), `closeTicket`. |
| `idempotency.ts` | `InMemoryIdempotency` — süreç içi tekrar-koruması; **başarısızlık hatırlanmaz** (yeniden deneme zaten amaç). |
| `index.ts` | `createActivities(deps): MaestroActivities` — arayüzün tek bağlama noktası. |

**Idempotentlik**: her yazan aktivite `IdempotencyGuard.once(key, fn)` üzerinden geçer.
Anahtar `runId` + aktivite + ayırt edici. Testlerde iki kez çağrılan aktiviteler tek yorum,
tek etiket, tek denetim kaydı üretiyor.

### `src/worker.ts` — kompozisyon kökü

`resolvePorts(registry, selection)` her portu **isimle** çözer; `PORT_NAMES` sabitleri sürücü
paketlerinden **import edilmez** (M44), ama `test/worker.test.ts` bu paketlerin kendi
sabitleriyle karşılaştırır — sürüklenme derlemede değil testte yakalanır.
`createMaestroWorker` workflow paketini `workflowsPath()` ile ayrı sandbox'ta bundle eder;
`runMaestroWorker` SIGINT/SIGTERM'de `shutdown()` çağırır ve **handler'ları temizler**
(bırakılsa aynı süreçteki bir sonraki worker'ı kapatırdı). `shutdownGraceTime: 5 dakika`.

---

## 2. Zaman-atlatmalı testlerde ne kanıtlandı

`@temporalio/testing`'in `TestWorkflowEnvironment`'ı + gerçek `ticketWorkflow` bundle'ı +
sahte aktiviteler. **111 test, 9 dosya, tamamı yeşil; tüm paket ~33 sn.**

| Kanıt | Test |
|---|---|
| Risk kademesine göre **doğru kapı seti** açılıyor; kademe dışı kapı hiç açılmıyor (otomatik onay değil) | `workflow-gates` × 4 |
| **16 gün bekleyen kapı**: 384 saatlik hatırlatıcı tetiklendi, **otomatik onay yok**, kapıyı yalnız insan kapattı — gerçek süre ~9 sn | `workflow-gates` |
| Hatırlatıcılar yalnız açık kapıda; kapanınca duruyor | `workflow-gates` + `gate-activities` |
| **Yanlış grup / doğrulanmamış onay / SoD ihlali** → kapı **kapanmıyor**, açık kalıyor, sebep defterde ve ticket'ta | `workflow-gates` × 3 |
| **Kill-switch `all`** → akış duruyor **ama açık kapı terk edilmiyor** (kapı cevaplandıktan sonra duruyor) | `workflow-gates` |
| `human_only` → hiç kapı açmadan devir (M73) | `workflow-gates` |
| **Analiz reddi** → adım 3'e dönüş → analiz yeniden yazılıyor → yeniden onay | `workflow-loops` |
| **Tarama bloke** (`fail` ve `error`) → 6a'ya dönüş, **3 turdan sonra insana devir** (M54) | `workflow-loops` × 2 |
| **Yabancı CI sinyali reddediliyor** ve akış beklemeye devam ediyor (M106) | `workflow-loops` |
| **CI kırmızı** → aynı oturumla düzeltme (`resumeToken` aynen taşınıyor — M30) | `workflow-loops` |
| **PR reddi** → 12b → aynı oturum → yeniden onay | `workflow-loops` |
| Korumalı yol ihlali **ilk turda** devir (M52); onaylamayan gözden geçiren 3 turda devir | `workflow-loops` × 2 |

Aktivite birim testleri (`intake`, `analysis`, `gate-activities`, `engineering`, `delivery`,
`worker`): 82 test — M99 kural önceliği ve deterministik eşitlik bozumu, M83/M59 belge
reddi, M55 kuyruk/M18 blok/M97 degrade dalları, M88 merdiven adımlarının **tam bir kez**
tetiklenmesi, M106'nın dört ret nedeni, M34 kanıt paketinin zincir doğrulaması,
idempotentlik ve M44 port çözümü.

---

## 3. Testlerin çevrimdışılığı — bir kayıt

Testler ağ çağrısı yapmıyor: tüm aktiviteler sahte, workflow kaynaktan bundle ediliyor.
**Tek istisna**: `@temporalio/testing`'in zaman-atlatmalı sunucusu varsayılan olarak
`cached-download` ile ilk çalıştırmada ikiliyi internetten indiriyor. Hava boşluklu CI için
`test/harness.ts` içindeki `createTestEnv()` **`MAESTRO_TEST_SERVER`** ortam değişkenini
okuyup diskteki ikiliyi kullanıyor (`executable: { type: "existing-path" }`). CI imajına
bu ikilinin konması gerekiyor — **operasyon maddesi, kod maddesi değil.**

---

## 4. Arayüz talepleri (orkestratör karar verir)

> **Güncelleme (doğrulama turu):** 1, 2, 4 ve 6 numaralı maddeler **kapatıldı** —
> sırasıyla O2 (sınırsız kota proxy'si), verdict dönen `recordGateDecision`
> (zaten kapanmıştı), O4 (`blocked` artık `handoverReason` döndürüyor) ve K4
> (gerçek `continueAsNew`). 3 ve 5 hâlâ açık.

1. **`proxyActivities` retry bütçesi kotayı taşımıyor.** `ticket-workflow.ts` `maximumAttempts: 3`
   diyor. M55'te kota beklemesi aktiviteyi *yeniden denenebilir* hatayla bitiriyor
   (`nextRetryDelay` = kotanın açılma anı), ama 3 denemede pencere açılmazsa koşu düşüyor.
   Öneri: kota hatası için ayrı bir proxy (`maximumAttempts: 0` = sınırsız) ya da
   `retry.nonRetryableErrorTypes` dışında kalan `LlmQuotaWait` için ayrı politika.
2. **`recordGateDecision` bir verdict döndürmeli.** Bugün `Promise<void>`. Dizin üyeliği
   tutmayan bir karar (sinyalin iddia ettiği grup ≠ gerçek üyelik) ancak *kalıcı hata*
   atarak reddedilebiliyor ve bu koşuyu düşürüyor. `Promise<GateRejection>` dönseydi
   workflow kapıyı açık tutup kişiye sebebi bildirebilirdi — `canCloseGate` ile aynı desen.
3. **`writeAnalysis` degrade dalı.** M97'de "yapan rol ai-assist'e düşer" akışı sürdürüyor;
   ama analiz belgesi olmadan 4/5 kapıları açılamıyor. Bugün `AiAssistRequired` kalıcı
   hatasıyla duruyoruz. İnsanın analizi yazmasını bekleyecek bir adım (2b benzeri bir
   `human_wait`) gerekiyorsa bu `ticket-workflow.ts` değişikliğidir.
4. **`handOverToHuman` aktivite içinden çağrılamıyor.** `blocked`/M52 dallarında devrin yan
   etkilerini (defter + denetim + bildirim) `outcome.handOver` içinde yapıp sonra hata
   atıyoruz; workflow'un `status = "handover"` ataması bu yolda gerçekleşmiyor.
5. **`ScmPort`/`CiPort` sürücü kaydı yok.** `@maestro/adapter-ado` `PortRegistry`'ye kayıt
   olmuyor (sürücüleri ek bağımlılık istiyor), bu yüzden `PORT_NAMES.scm` için sürücü
   paketinden karşılaştırılacak bir sabit yok. ADO paketine `registerAdoDrivers(registry, deps)`
   eklenirse `worker.test.ts`'teki sürüklenme testi `scm`/`ci`'yi de kapsar.
6. **`ticketWorkflowContinue` gerçek `continueAsNew` değil.** Ret döngüsünde workflow kendini
   özyinelemeli çağırıyor; testler bu davranışı olduğu gibi pinliyor (kapı iki kez açılıyor).
   `continueAsNew`'e geçilirse `workflow-loops` testlerindeki "iki kez açıldı" iddiaları
   `continueAsNew` sonrası yeni koşuya taşınmalı.

## 5. Bağımlılıklar

Yeni **harici** runtime bağımlılığı yok. Eklenenler: `@temporalio/common` ve
`@temporalio/worker` (zaten depoda), ve workspace paketleri `@maestro/{audit, execution,
memory, notify, publish, scanners, storage, ports}`. Test-only: `@maestro/{pii, adapter-jira,
llm-gateway, secrets, test-kit}` — `adapter-jira`/`llm-gateway`/`secrets` **yalnız**
port-adı sürüklenme testi için, `src/` içinden hiçbiri import edilmiyor.

`@maestro/db` **kullanılmadı**: parametreler (`escalation.ladder`, `notify.routing`,
publish hedefleri, routing kuralları) `ParamReader` dikişinden okunuyor; Prisma'yı
kompozisyon kökünün üstüne çıkarmamak için. DB'ye bağlama işi worker'ı ayağa kaldıran
uygulamanın (Dalga 3 `bff`/`apps/worker`).

## 6. Dosya/satır durumu

Tüm dosyalar ≤ 300 satır (en büyüğü `test/workflow-gates.test.ts`, 288 · üretimde
`src/ticket-workflow.ts`, 288). Doğrulama turunda `ticket-workflow.ts` 585 satıra
çıkmıştı; yukarıdaki tabloya göre dört dosyaya bölündü ve `workflow-gates.test.ts`'ten
kill-switch testleri `workflow-kill-switch.test.ts`'e ayrıldı.

Paket, inşa planındaki "~1200 satır üretim kodu" tavanının biraz üstünde — 23 aktivitenin
tamamı burada olduğu için bölmedim; istenirse `impl/` iki pakete ayrılabilir
(`workflow-activities-core` / `-delivery`).
