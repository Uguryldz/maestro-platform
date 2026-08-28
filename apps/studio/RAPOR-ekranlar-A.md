# Akış ekranları (Dalga 4, küme A) — rapor

**Branch:** `main` (worktree `agent-a1e2ba7bfbd71ef91`)
**Taban commit:** `78783a7`
**Commit:** aşağıda "Commit" başlığında.

9 ekran: `dash`, `tickets`, `detail`, `live`, `clarify`, `workmode`, `fanout`,
`evidence`, `jira`.

`pnpm run gate` → **exit 0** (50/50 görev). `pnpm --filter @maestro/studio build`
→ **exit 0** (461 kB JS / 137 kB gzip).

---

## 1. Yön veren tek karar: uydurma veri yok

Maket (`mock/index.html`) bitmiş bir üründen çekilmiş gibi görünür; içindeki
sayıların tamamı `TICKETS`, `RUNNERS`, `AUDIT` gibi **sabit JS dizileridir**.
BFF'in bugün sunduğu tek koşum verisi ise şu ikisi:

| Uç | Dönen | Durum sözlüğü |
|---|---|---|
| `GET /runs` | `{ runs: RunSummary[] }` | **Temporal** (`running`/`completed`/`failed`/…) |
| `GET /runs/:ticket` | `WorkflowRunState` | **Alan** (`gate`/`fail`/`done`/…) |

`RunSummary` yalnızca `workflowId, ticketKey, runId, status, startedAt, closedAt`
taşıyor. Makette listede görünen **uygulama, mod, risk, adım, tüketim, yaş
metni, kapı sahibi** alanlarının hiçbiri bu uçta yok.

Bu yüzden kural şu oldu: **bir alan sunucudan gelmiyorsa ekranda hiç yok.**
Yerine "bu bölüm için uç yok" durumu basılıyor (`NotAvailable`), ve uç isteği
§5'e yazılıyor. Maketteki düzen, kart yapısı, boşluk ve renk korunuyor; yalan
olan sayı korunmuyor.

İki durum sözlüğü **birleştirilmedi**. Liste "çalışıyor" derken koşum aslında
kapıda bekliyor olabilir — bu, o ucun söylediği gerçektir. `/runs`'ta olmayan
kapı bilgisini uydurup listeye "kapıda" yazmak, doğru renkli bir yalan olurdu.
`runStatusTone` zaten iki sözlüğü de kapsıyor.

---

## 2. Ekranlar

### `dash` — Panel
KPI'ların **dördü de** `/runs`'tan sayılıyor (aktif / tamamlanan / hatalı /
toplam). "Dikkat isteyenler" listesi türetilmiş: önce hatalı koşumlar, sonra en
uzun süredir açık olanlar; satıra tıklayınca `detail/:ticket`. Maketteki runner
havuzu kartı ve "son 24 saat" akışı **konmadı** — ikisi de olmayan uçlara
dayanıyor, yerlerine uç isteği notu var.

### `tickets` — İş akışları
`/runs` listesi; durum çipleri (Tümü / Çalışıyor / Tamamlandı / Hatalı) ve proje
seçici. **Çip sayıları veriden sayılıyor**, sabit değil. Çipler maketin
`kapıda/kuyrukta` sözlüğünü değil `/runs`'ın gerçekten gönderdiği sözlüğü
kullanıyor — filtrelenecek veri olmayan bir çip koymadım. Satır → detay.

### `detail/:ticket` — Ticket detayı
Maketteki `DKEY` global'i yerine **rota parametresi**: ekran derin bağlanabilir,
kapı hatırlatıcısı doğrudan karar verilecek koşuma işaret edebilir.
6 sekme: Adımlar (dolu), Ticket defteri (uç yok → hata durumu), Analiz /
Değişiklik / Testler / Tüketim (uç yok → `NotAvailable`).
Sağ sütun: açık kapı varsa `GatePanel`, altında künye (`WorkflowRunState`'in
gerçekten taşıdığı alanlar).
Adım listesi `STEP_IDS`'ten üretiliyor — ekran kendi kopyasını tutmuyor.
Risk → kapı sayısı `GATES_BY_RISK`'ten okunuyor.

### `live` — Akışın tamamı
Maket burada 40 saniyelik **senaryolu sahte bir animasyon** oynatıyor (uydurma
log satırları, uydurma PR numaraları). Bunu kopyalamadım: operatörün karar
verdiği konsola üretilmemiş koşum çıktısı basmak, brifingin açıkça yasakladığı
şey. Ekranın öğretme işi korundu, kurgu atıldı:
- boru hattı **gerçek adım tablosundan** (`STEP_IDS` + `STEP_META`) çiziliyor,
  her adım türüyle (sistem / AI / insan kapısı / insan bekleme / otomatik kapı);
- "şu an çalışanlar" tablosu operatörün **kendi gerçek koşumları**, 15 saniyede
  bir yenilenen `/runs` ile. Sahte canlı yerine gerçek canlı.

### `clarify` — Clarification döngüsü (2b)
Yanıt `clarificationAnswered` **sinyali** olarak gidiyor (Jira yorumuyla aynı
kanal). Ticket + yanıt dolu olmadan buton pasif; boş yanıt sinyali gitmiyor.
Sağda döngü kuralları: süresiz bekleme, otomatik ret **yok** (M14), hatırlatıcı
merdiveni, 3. turdan sonra insana atama.

### `workmode` — Work mode & devir
Matris `WorkMode` enum'undan üretiliyor (4 mod × 5 aşama). Mod değişimi
`modeChange` sinyali; **onay modalı zorunlu** — akış ortasında modu değiştirmek,
üzerinde insan onayı bulunan bir işte kimin çalıştığını değiştirir.

### `fanout` — Ana ticket / alt ticket
**Bilinçli olarak zayıf ve dürüst.** Parent→child bağını sunan hiçbir uç yok
(`RunSummary`'de `parentTicket` alanı yok, etki matrisi analiz belgesinde ve
onun da ucu yok). Bu yüzden ekran ağacı **bildiğini iddia etmiyor**: etki matrisi
kartı "uç yok" diyor, altında ana ticket'ın **aynı Jira projesindeki** koşumları
listeleniyor. Maketin iddiasından zayıf, ama doğru olan bu.

### `evidence` — Kanıt paketi
`EvidencePackage` sözleşmesinden: dosya listesi (sha256 + boyut), künye ve
**imzalı onay zinciri**. İki şeyi bilerek yapmıyor:
- **indirme butonu yok** — arşivi sunan uç yok, 404'e giden buton butonsuzluktan
  kötüdür;
- **kendi "SoD ✓" özetini üretmiyor.** Her `GateDecision` kendi `sodVerified`
  alanını taşıyor; tablo o alanı gösteriyor. İstemcinin uydurduğu yeşil tik,
  arkasında hiçbir şey olmayan bir denetim iddiası olurdu. (Test bunu pinliyor:
  `sodVerified:false` gelince "doğrulanmadı" basılmak zorunda.)

### `jira` — Jira'da nasıl görünüyor
Referans belgesi; **bilerek statik** — komut seti ve yetkiler ürün kuralı, sunucu
durumu değil. Maketteki örnek yorum akışı ve "komutu dene" kutusu **konmadı**:
istemciye gömülü bir transkript ekranda gerçeğinden ayırt edilemez, ve hiçbir
iş akışına ulaşmadan "çalışan" bir komut kutusu operatöre üründe olmayan bir
davranış öğretir. Gerçek kapı kararı `detail` ekranında, sinyal ucu üzerinden.

---

## 3. Kapı kararı, yetki ve güvenlik

**Kapı kararı REST ile verilmiyor.** `useGateDecision` →
`POST /runs/:ticket/signals/gateDecision` `{ decision, reason? }`.

- **Gövdede aktör alanı yok.** Kimlik sunucuda oturumdan alınıyor; kendi
  onaylayanını yazan bir gövde, herkesin taklit edebileceği bir imza olurdu.
  Test bunu doğruluyor (`actorUserId`/`actor` gövdede olmamalı).
- **Ret gerekçesi zorunlu**: hem `GatePanel` (buton pasif) hem
  `useGateDecision` (istek çıkmadan `MissingReasonError`). BFF de 400
  `reject_needs_reason` döndürüyor — asıl kontrol orada.
- **Onay ve ret ikisi de onay modalı istiyor**: karar hash zincirli denetim
  izine yazılıyor ve geri alınamıyor.
- `canDecideGate(session, step)` ile buton **pasifleştiriliyor**; koda yorum
  olarak yazıldığı gibi **bu güvenlik değildir** — bundle herkese açık, roller
  istemcinin doğrulayamadığı bir yanıttan geliyor, URL elle yazılabilir. Gerçek
  kontrol BFF'te (`decideGate` + grup üyeliği) ve iş akışında (`actorGroup`).
- `delegated: true` (AI oturumu) kapı kararını **veremiyor** — contract'taki
  `canDecideGate` zaten `false` dönüyor, BFF de `403 human_channel_only`.
- Studio'nun gönderebildiği sinyaller BFF'in izin listesiyle sınırlı:
  `gateDecision`, `clarificationAnswered`, `modeChange`. `ciResult`,
  `prChangesRequested`, `killSwitch` **yok** ve olmamalı.

Hata gösterimi: her yerde `t(messageKeyOf(error))`. Sunucudan gelen ham kod
hiçbir ekrana basılmıyor; iki test bunu ayrıca doğruluyor
(`project_access` ve `no_run` ekranda görünmemeli).

---

## 4. Katalog ve testler

- **320 yeni anahtar**, `tr.json` ve `en.json`'a **birlikte** eklendi.
  Parite korunuyor: her iki dosya da 248 → **568** anahtar.
- Gömülü kullanıcı metni yok; tüm dinamik anahtarlar (`steps.*`, `mode.*`,
  `risk.*`, `run.status.*`, `run.exec.*`, `step.kind.*`, `step.state.current.*`,
  `journal.actor.*`, …) tam kümesiyle eklendi — eksik anahtar render'da
  fırlattığı için bu kritikti.
- **23 test**, `test/flow-screens.test.tsx`. Ağ yok: her test kendi fetch
  stub'ını enjekte ediyor, global `fetch` fırlatıyor.

**Testler gerçekten kırılıyor mu?** Dört mutasyonla doğrulandı:

| Mutasyon | Kırılan test |
|---|---|
| Ret gerekçesi zorunluluğunu kaldır | `refuses to send a rejection without a reason` |
| `mayDecide` → `return true` (yetki joker) | `disables ... does not own the gate` + `... delegated (AI) session` |
| KPI'yı sabit `"12"` yap | `counts the KPIs from the run list rather than showing constants` |
| SoD rozetini her zaman yeşil bas | `reports an unverified SoD rather than showing a green tick anyway` |

Ölü kod taraması yapıldı: kullanılmayan 4 export (`isOpen`, `stepTitleKey`,
`riskLabelKey`, `currentStateKey`) tespit edilip **silindi**.

Dosya başına satır: en büyük kaynak 187 (`Evidence.tsx`), hepsi ≤300.

---

## 5. UÇ İSTEKLERİ (detaylı)

Aşağıdakilerin **hiçbiri bugün yok**. Ekranlar yazıldı, veri katmanı yazıldı;
uç gelene kadar ilgili bölüm hata/uygun-değil durumu gösteriyor. Hiçbir yerde
uydurma veriyle "çalışıyor" gösterilmiyor.

### 5.1 `GET /runs` zenginleştirmesi — **en yüksek öncelik**
Bugün dönen: `workflowId, ticketKey, runId, status, startedAt, closedAt`.

İstenen ek alanlar (hepsi `WorkflowRunState`'te zaten var, sadece listeye
taşınması gerekiyor):
```
step:      StepId          // hangi adımda
runStatus: WorkflowRunStatus  // gate|running|queued|fail|handover|done|cancelled
risk:      RiskTier | null
updatedAt: IsoDateTime
```
İsteğe bağlı ama çok değerli:
```
appId:        AppId | null      // hangi uygulama
mode:         WorkMode          // work mode
gateOwnerGroup: string | null   // kapı açıksa sahibi
gateSince:    IsoDateTime | null // kapı ne zamandır açık
parentTicket: TicketKey | null  // fan-out ana ticket'ı
```
**Neden:** `dash` "bekleyen onay" sayısını, `tickets` "kapıda" filtresini,
`clarify` 2b'de bekleyenler listesini, `fanout` alt ticket ağacını bunlarsız
üretemiyor. Şu an bu bilgi yalnızca satır başına bir `GET /runs/:ticket` ile
gelebilir ki 200 satırda 200 istek demek.
Sorgu parametreleri: mevcut `limit`'e ek olarak `status`, `project`, `step`
filtreleri.

### 5.2 `GET /runs/:ticket/journal`
```
-> { entries: JournalEntry[] }   // packages/contracts/src/journal.ts
```
Sorgu: `?actor=ai|human|system`, `?sinceSeq=<n>`, `?limit=<n>`.
Kullanan: `detail` → Ticket defteri sekmesi. Şu an 404 alıp çevrilmiş hata
gösteriyor. **PII notu:** `detail` alanı sunucuda maskelenmiş gelmeli; Studio
maske çözmüyor ve çözmeyecek.

### 5.3 `GET /runs/:ticket/evidence`
```
-> EvidencePackage   // packages/contracts/src/evidence.ts
```
Kullanan: `evidence` ekranı (dosya listesi + onay zinciri + künye).
Ek olarak arşivin kendisi için bir indirme ucu gerekiyor:
`GET /runs/:ticket/evidence/archive` → `application/zip` (ya da imzalı geçici
URL). **O uç gelene kadar indirme butonu konmadı.**

### 5.4 `GET /runs/:ticket/analysis`
```
-> { templateVersion, sections: [{ key, title, format, content }], risk, impactMatrix }
```
Kullanan: `detail` → Analiz sekmesi. Etki matrisi `fanout` ekranının da
ihtiyacı olan şey (§5.6).

### 5.5 `GET /runs/:ticket/diff` ve `GET /runs/:ticket/tests`
```
diff  -> { branch, prId|null, files: [{ path, added, removed }], totalAdded, totalRemoved }
tests -> { unit: {planned, passed, failed}, integration: {...}, coveragePct, flaky, scenarios: [...] , ran: boolean }
```
Kullanan: `detail` → Değişiklik / Testler sekmeleri.
`tests.ran` alanı önemli: "planlandı" ile "gerçekten koştu" ekranda ayrılmalı.

### 5.6 `GET /runs/:ticket/children` (fan-out)
```
-> { parent: TicketKey, children: [{ ticketKey, appId, platform, module, change, status, step }] }
```
Kullanan: `fanout`. Bu uç olmadan ekran parent→child ağacını **gösteremiyor**;
şu an yalnızca aynı projedeki koşumları listeliyor ve bunu ekranda açıkça
söylüyor.

### 5.7 `GET /runs/:ticket/cost`
```
-> { tokensIn, tokensOut, usd|null, cachePct, bySteps: [{ step, role, model, sharePct }] }
```
Kullanan: `detail` → Tüketim sekmesi. `usd` abonelik sürücülerinde `null`
olabilir (M55) — sözleşmedeki `JournalEntry.cost` ile aynı kural.

### 5.8 `GET /activity`
```
?limit=&since=  -> { events: [{ at, ticketKey, kind, titleKey|title, tone }] }
```
Kullanan: `dash` → "son 24 saatte akış" kartı. Şu an kart "uç yok" diyor.

### 5.9 Not: `/runs/:ticket` 404 davranışı iyi
`no_run` + `project_access` ayrımı doğru kurulmuş (proje göremeyen için
404 yerine 403, ticket oracle'ı engelliyor). Ekran ikisini de çevrilmiş
mesajla gösteriyor; değişiklik istemiyorum.

---

## 6. Ortak alana yazdıklarım

| Dosya | Ne | Neden kaçınılmazdı |
|---|---|---|
| `packages/config/locales/tr.json` | +320 anahtar | Kural gereği tüm metin katalogdan |
| `packages/config/locales/en.json` | +320 anahtar | Parite zorunlu |

`src/app/screens.ts`, `src/app/routes.tsx`, `src/app/screen-components.ts`,
`src/ui/*`, `src/api/*`, `src/auth/*` **hiç değiştirilmedi**. Başka ekranların
dosyalarına dokunulmadı.

Kendi alanımda yeni klasörler: `src/screens/shared/` (veri katmanı, sinyaller,
durum sarmalayıcıları, `GatePanel`, biçimlendirme, `screens.css`) ve
`src/screens/detail/` (adım listesi, defter sekmesi, künye sütunu).

> **Not:** `src/screens/shared/` diğer ekran ajanlarının da işine yarar
> (`QueryState`, `GatePanel`, `format.ts`). Ortak alan ilan edilmemişti, kendi
> ekran klasörümün altında; isteyen import edebilir.

---

## 7. Yapmadıklarım ve nedeni

- **Maketteki sahte canlı demo** (`live`) — üretilmemiş koşum çıktısını gerçek
  gibi göstermek olurdu. Yerine gerçek adım tablosu + gerçek çalışan işler.
- **Maketteki Jira yorum transkripti ve komut kutusu** (`jira`) — gömülü
  transkript ekranda gerçeğinden ayırt edilemez; hiçbir workflow'a ulaşmayan
  "çalışan" komut kutusu üründe olmayan davranış öğretir.
- **Kanıt paketi indirme butonu** — arşiv ucu yok.
- **Runner havuzu kartı** (`dash`) — `/runners` ucu yok (küme B'nin `runners`
  ekranıyla da çakışırdı).
- **Fan-out ağacı** — parent/child bağı hiçbir uçtan gelmiyor (§5.6).
- **Analiz/diff/test/tüketim sekme içerikleri** — uçları yok (§5.4, §5.5, §5.7).
- **Word/PDF dışa aktarma** (`evidence`, maketteki `docExport`) — uç yok; küme
  C'nin doküman şablonu ekranıyla da ilişkili, oraya bırakıldı.
- **Kapı kararı sonrası iyimser güncelleme** — karar sinyali asenkron;
  `invalidateQueries` ile yeniden çekiliyor. İyimser güncelleme, iş akışının
  reddedebileceği bir kararı onaylanmış göstermiş olurdu.
- **E2E testi** — birim/entegrasyon seviyesinde kalındı; BFF'in hâlâ `listen()`'ı
  yok (iskelet raporu §9.2).
