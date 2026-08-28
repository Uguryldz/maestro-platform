# RAPOR — Studio'nun okuma tarafı (M7)

**Dal:** `main` (worktree `agent-aaca204dcefc5393d`)
**Taban commit:** `9fcff71`

Studio'nun 12 okuma modelinden **10'u** artık Postgres'ten cevap veriyor. Kalan
**2'si** (`runners`, `scans`) adıyla reddetmeye devam ediyor — çünkü bu
platformda o veriyi **yazan hiçbir şey yok**.

---

## 1. On iki modelin durumu

| # | Model | Durum | Tablo(lar) | Gerekçe |
|---|-------|-------|-----------|---------|
| 1 | `runs` | **Bağlandı** | `WorkflowRun` + `LlmCall` | Sayfa `updatedAt desc`. Proje kapsamı `WHERE`, tüketim `LlmCall`'dan `groupBy` ile toplanıyor, fan-out ailesi `matchJson`'dan türetiliyor. |
| 2 | `journal` | **Bağlandı** | `JournalEntry` | `seq asc`, aktör filtresi. Tablo append-only (migration 0002), bu yüzden offset sayfalama kararlı. `summary()` → `null`. |
| 3 | `gates` | **Bağlandı** | `Gate` (+ `WorkflowRun` ilişkisi) | Yalnız `closedAt IS NULL`. Proje kapsamı, gate'in kendi projesi olmadığı için koşunun ticket'ı üzerinden. |
| 4 | `apps` | **Bağlandı** | `Application`, `RepoCard` | Kayıt defteri bilerek proje kapsamsız (rota da öyle). `repoCard` en yüksek versiyonu döner. |
| 5 | `knowledge` | **Bağlandı** (3 sınırla) | `KnowledgeDoc` | Aşağıda §2. |
| 6 | `runners` | **REDDEDİYOR** | — | Runner filosu tablosu yok, `RunnerPort` filo envanteri sunmuyor. |
| 7 | `quota` | **Bağlandı** | `SubscriptionAccount` | Sayfalamasız (arayüz öyle); havuz satın alınmış koltuk listesi, log değil. |
| 8 | `cost` | **Bağlandı** | `LlmCall` | `at desc`. Abonelik sürücülerinde `usd` null kalır (M55). |
| 9 | `scans` | **REDDEDİYOR** | — | Tarama sonucu hiçbir yere yazılmıyor. |
| 10 | `evidence` | **Bağlandı** | `EvidencePackageRow` | Yalnız manifest; dosyalar storage port'unun arkasında kalır. |
| 11 | `audit` | **Bağlandı** | `AuditLog` | `PrismaAuditStore` + `AuditStoreReader`. Zincir **gerçekten** doğrulanıyor. |
| 12 | `health` | **Bağlandı** | — (prob) | Sağlık saklanan değil, **sorularak** kurulan bir olgu; Postgres ve Temporal gerçekten yoklanıyor. |

### Neden `runners` ve `scans` için tablo eklemedim (migration 0005 YOK)

Görev iki seçenek sundu; **reddetmeyi** seçtim, gerekçesi:

Bir tablo eklemek, **hiçbir üreticinin doldurmadığı** kolonlar yaratırdı. Tarama
sonuçları iş akışının içinde üretilip (`packages/workflows/src/impl/scan.ts`)
onları bloklayan gate tarafından tüketiliyor — hiçbiri saklanmıyor. Runner'lar
kendilerini hiçbir yere bildirmiyor. Sonuç: her okuma **boş sayfa** dönerdi ve
bu, `stores/read-models.ts`'in en başından engellemek için yazıldığı hatanın ta
kendisi — ekranda "filoda runner yok", "bulgu yok" diye görünür, operatör bunu
**sağlıklı bir platform** diye okur. Sessiz yanlış cevap, gürültülü hatadan
tehlikelidir. Bu ikisi, onları **YAZAN** bir şey çıktığında gerçek olur.

İkisi de `DEGRADED_CAPABILITIES`'e eklendi ve BFF açılışta adlarını basıyor.

---

## 2. `knowledge` — üç dürüst sınır

`KnowledgeDoc` tablosunda **`dataClass` kolonu yok**. Arayüz ise sınıflandırma
yapamayan bir indeksin **`gizli`** raporlamasını ZORUNLU kılıyor. Dolayısıyla bu
bir "eksiklik" değil, **etiketsiz bir külliyat için tanımlanmış davranış** —
ve fail-closed. BFF'in `visibleKnowledge`'ı bunları `maestro-gizli` yetkisi
olmayandan gizler ve **kaç tanesinin gizlendiğini söyler**.

1. **`dataClass` her belge için `gizli`** (yukarıdaki sebep).
2. **Vektör arama değil, başlık eşleşmesi** — embedding kolonu yok. `score`
   uydurulmuyor, **0**; sıralama tazelikle. Uydurulmuş bir `0.93` güven diye
   okunurdu.
3. **`appId` filtrelenemiyor** — tabloda uygulama kolonu yok. Uygulama adı
   verilen sorgu tüm külliyatı döner; boş sayfa "bu uygulama için bilgi yok"
   derdi, oysa külliyat uygulamaya göre bölünmemiş sadece.

---

## 3. ARAYÜZ İSTEKLERİ

`apps/bff/src/read-models.ts` bir arayüz tanımı; değiştirmedim. İki gerçek
uyuşmazlık:

**(a) `RunRecord.title` / `.reporter` / `.assignee` — Jira'nın olguları, tabloda yok.**
`WorkflowRun`'da bu üç kolonun karşılığı yok; bunlar Jira'da yaşıyor. Şu an
`title` = ticket anahtarı, `reporter` = `""`, `assignee` = `null` dönüyor.
Uydurma yapmamak için böyle; ama `title`'ın ticket anahtarı olması Studio'nun
liste ekranında **özet yerine anahtarı** gösterir.
*İstek:* ya bu üç alan `RunRecord`'dan çıkarılıp rota katmanında `WorkPort`'tan
(Jira) birleştirilsin, ya da nullable yapılsın (`title: string | null`) — böylece
"bilinmiyor" ile "boş başlık" ayırt edilebilir.

**(b) `RunRecord.risk` zorunlu, kolon nullable.**
`WorkflowRun.risk`, analiz onu belirleyene kadar NULL (M51). Okuma modeli ise
`RiskTier` zorunlu tutuyor. `dusuk` dönmek "düşük riskli değerlendirildi"
iddiası olurdu; **`orta`** dönüyorum (orta kademe). *İstek:* `risk: RiskTier |
null` — "henüz değerlendirilmedi" gerçek bir durum ve ekranda öyle görünmeli.

**(c) `OpenGate.delegatedTo`** — `Gate` tablosu hangi merdiven adımlarının
ateşlendiğini (`firedStepIds`) tutuyor, **kime** gittiğini tutmuyor; adres
gönderim anında bildirim konfigüründen çözülüp geri yazılmıyor. `null`
dönüyorum (gerçek). Sahibi grubu yazmak, "gate başladığı gruba yükseltildi"
demek olurdu.

---

## 4. Çalıştırma kanıtı

Geçici yığın: kendi Postgres'im (`maestro-readmodels-agent`, port 55438) +
mevcut Temporal. BFF **kaynaktan** (`tsx src/bin/bff.ts`), demo tohumu
(22 koşu, 19 parametre, 76 denetim kaydı).

### Açılış (banner)

```
[maestro] bff listening on 127.0.0.1:7052
[maestro] bff: 2 read models NOT wired — the Studio screens backed by them refuse rather than render an empty page:
  - runners (no runner fleet store (RunnerPort reports no fleet-wide inventory, M60))
  - scans (no scan result store, and no ContainerRunner produces results to store (M27))
```

`audit` artık **kalıcı** olduğu için "process-local" uyarı listesinden çıktı.

### Görevdeki iki kırık uç — artık 200

```
POST /auth/login   -> 200  (ayse.kaya@ugurbank.local; roller: viewer, product-owner, tech-lead)

GET /studio/runs?limit=3 -> 200
{"items":[{"ticketKey":"UGURPAY-123","title":"UGURPAY-123","appId":"ugurpay","mode":"full_auto",
"risk":"dusuk","dataClass":"dahili","parentTicketKey":null,"childTicketKeys":[],"reporter":"",
"assignee":null,"prId":null,"costUsd":0.42,"tokensIn":48200,"tokensOut":6100,
"startedAt":"2026-08-07T11:20:00.000Z","updatedAt":"2026-08-08T11:12:12.000Z","state":null}, ...],
"nextCursor":"MzpydW5zOg"}

GET /studio/health -> 200
{"state":"healthy","services":[
 {"service":"postgres","state":"healthy","version":"postgres","checkedAt":"2026-08-10T00:24:07.115Z","note":null},
 {"service":"temporal","state":"healthy","version":"temporal","checkedAt":"2026-08-10T00:24:07.115Z","note":null}]}
```

`costUsd: 0.42` / `tokensIn: 48200` tohumlanmış `LlmCall` satırıyla birebir —
**gerçek veri**, sabit değer değil.

### Tüm okuma yüzeyi

```
/studio/apps?limit=2        -> 200  {"items":[{"appId":"ugurmasaustu","displayName":"ugurmasaüstü",...
/studio/quota               -> 200  {"accounts":[{"accountId":"claude-sub-01","driver":"claude-sub",...
/studio/gates               -> 200  {"items":[],"nextCursor":null}      # gerçekten açık gate yok
/studio/cost?limit=2        -> 200  {"items":[{"runId":"run-ugurpay-123","usd":0.42,...
/studio/audit?limit=2       -> 200  {"items":[{"seq":76,"actor":"maestro-worker","action":"GATE_OPEN",...
/studio/audit/verification  -> 200  {"ok":true,"checked":76,"brokenAtSeq":null}
/studio/knowledge?q=bddk    -> 200  {"items":[{"id":"bddk-uyum@2","score":0,"dataClass":"gizli",...
/studio/runners             -> 500  {"error":"internal_error"}   # kasıtlı ret
/studio/sandboxes           -> 500  {"error":"internal_error"}   # kasıtlı ret
/studio/scans               -> 500  {"error":"internal_error"}   # kasıtlı ret
```

Denetim zinciri **76 gerçek kayıt** üzerinde `ok: true` doğrulandı.

### Fail-closed / yetki kanıtı

`baran.tunc` yalnız `maestro-ugurweb` grubunda:

```
### tüm koşuları ister:        yalnız ['UGURWEB'], 5 koşu (22 değil) — sızıntı yok
### başka projenin ticket'ı:   403 {"error":"project_access","details":{"ticket":"UGURPAY-123"}}
### kendi projesinin ticket'ı: 200 {"run":{"ticketKey":"UGURWEB-91",...
### ops ucu (/studio/health):  403 {"error":"role_required","details":{"anyOf":["admin","tech-lead"]}}
### tech-lead'in cursor'ını çalıp kullanır: yalnız ['UGURWEB'] — sızıntı yok
```

Son satır önemli: **başka kullanıcının cursor'ı kabul edilmiyor**, çünkü kapsam
her istekte oturumdan yeniden türetiliyor; cursor yalnız offset taşıyor.

Sayfalama tavanı: `?limit=5000` → **400** `{"error":"invalid_page"}` (kırpılmıyor,
reddediliyor). Yabancı cursor farklı bir filtreye verildiğinde **baştan başlıyor**
(sessiz atlama yok).

Sır sızıntısı: ret metinlerinde ve açılış logunda bağlantı dizesi/parola **yok**
(tarandı, 0 eşleşme). Sağlık probu hatası yalnız hata **adını** taşır — sürücü
mesajı DSN gömdüğü için bütünüyle atılır.

---

## 5. Testler

- `apps/deploy/test/read-live.test.ts` — **32 test** (çevrimdışı; sahte
  delegeler gerçek `WHERE` semantiğini uyguluyor): proje kapsamı, dolu sayfa,
  boş grup hiçbir şey görmez, cursor yürüyüşü/yabancı cursor/çöp cursor,
  kapsam-içi sayım, tüketim toplamı, fan-out ailesi, `gizli` sınıflandırma,
  prob sağlığı, sır sızdırmayan not, reddeden iki model.
- `apps/deploy/test/live-read-models.test.ts` — **20 test**, **gerçek
  Postgres'e karşı** (`TEST_DATABASE_URL` ile opt-in, kapı çevrimdışı kalır).
  Bunlar sahtenin ispatlayamayacağını ispatlar: elle yazılmış yapısal
  delegelerin üretilmiş Prisma istemcisine **gerçekten bağlandığını**
  (`groupBy`+`_sum`, iç içe `run` ilişkisi filtresi, `mode: "insensitive"`).
- `apps/deploy/test/worker-boot.test.ts` — 3 test eklendi: iki modelin
  bildirimi + **drift önleyici** (bir gün gerçek store gelirse bildirim yanlış
  kalmasın diye ret ile bildirim birbirine bağlandı).

Canlı süit veritabanını `live-stores.test.ts` ile **paylaşıyor** ve vitest
ikisini eşzamanlı çalıştırabiliyor. Bu yüzden hem temizlik hem iddialar
`live-` önekiyle **kendi satırlarına** kapsanmış durumda: blanket `deleteMany`
komşu süitin satırlarını silmeye çalışıp `onDelete: Restrict`'e çarpıyordu.
İki süit artık her sırada, birlikte veya tek başına yeşil.

- `TEST_DATABASE_URL` ile: **383 test, 19 dosya, hepsi yeşil.**
- Değişkensiz (kapının gördüğü hâl): canlı süitler atlanır, kapı çevrimdışı.

`pnpm run gate` → **yeşil, 60/60, exit 0**.

---

## 6. Yapmadıklarım

- **Migration 0005 yazmadım** (§1'deki gerekçe).
- `journal.summary()` **`null`** dönüyor: yaşayan özet günlükten yeniden
  üretiliyor ve hiçbir yere yazılmıyor. Girdi başlıklarını birleştirip özet
  uydurmak, bankanın ekranına hiçbir özetleyicinin yazmadığı metni koyardı.
- **BFF'in hata logu kapalı** (`apps/bff/src/server.ts:78`, `logger: false` —
  benim değişikliğim değil, mevcut durum). Ret sebebi `request.log.error`'a
  gidiyor ama hiçbir yere basılmıyor; operatör 500 görüp *nedenini* göremiyor.
  Açılış banner'ı iki modeli de adıyla saydığı için tanı yine mümkün, ama
  **öneri: BFF'te üretim profilinde logger açılsın** — bu kompozisyon kökünün
  değil, `apps/bff`'in kararı olduğu için dokunmadım.
- `read-memory.ts`'i kompozisyon köküne bağlamadım (kasıtlı: boş ama "sağlıklı"
  görünen ekranlar üretirdi).
- Studio'nun kendi arayüzünü (React) çalıştırmadım; kanıt HTTP seviyesinde.
