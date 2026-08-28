# Studio'nun koşu listesi gerçek veri kaynağına bağlandı

Studio'nun akış ekranları Temporal'ı okuyan `/runs` yerine Postgres'i okuyan
`/studio/runs`'a taşındı. Bu, prod pilotunun son bütünleşme boşluğuydu:
veritabanında 22 koşu varken pano "Henüz iş akışı yok" yazıyordu.

## Değiştirilen çağrılar

| Ekran / hook | Önce | Sonra |
|---|---|---|
| `useRuns` (dash, tickets, live, clarify, fanout) | `GET /runs` → `{runs: RunSummary[]}` | `GET /studio/runs` → `{items, nextCursor}` |
| `useRunState` → `useRunDetail` (detail) | `GET /runs/:ticket` → `WorkflowRunState` | `GET /studio/runs/:ticket` → `{run, state, application}` |

`/studio/runs/:ticket/journal` ve `/evidence` zaten doğruydu; dokunulmadı.
Sinyaller (`/runs/:ticket/signals/*`) BFF'in yazma yolu — değişmedi.

## Şekil dönüşümü

İki ayrı tuzak vardı ve ikisi de **sessiz** boş liste üretir:

1. **Zarf**: `/runs` düz `{runs: [...]}`, `/studio/runs` sayfalı
   `{items, nextCursor}`. `body.runs` okumak boş liste verir, hata vermez.
2. **İç içe durum**: her öğe `{...RunRecord, state: WorkflowRunState | null}`.
   `row.status` doğrudan okunursa `undefined` gelir — rozet boş çıkar.

Çözüm `shared/runs.ts` içindeki iki saf fonksiyon (test edilebilir olsun diye
dışa açıldı):

- `toRunRow(item)` — `state` içindeki `runId/status/step`'i üste taşır;
  `risk`/`startedAt`/`updatedAt` için state yoksa kayda düşer.
- `toRunList(body)` — zarfı açar, `items` dizi değilse boş liste döner
  (ErrorBoundary'ye düşüp ekranı karartmak yerine).

`useRuns` bunları `select` ile uygular, böylece hiçbir ekran zarfı bilmez.

## Durum sözlüğü — bilerek tek

Eski liste Temporal'ın sözlüğünü konuşuyordu (`running/completed/failed`).
Yeni liste **iş akışının** sözlüğünü konuşuyor (`gate/queued/fail/handover/
done/cancelled/running`, donmuş `WorkflowRunStatus`), çünkü `state.status` bu.
Hiçbir yerde çeviri yapılmıyor: kapıda bekleyen bir koşu artık "çalışıyor"
değil "kapıda" diyor. `RUN_STATUS_PREFIX` `run.exec` → `run.status` oldu.

**`status: null` yükte taşınan bir bilgi.** BFF, iş akışı henüz başlamamış
kataloğ kaydını `state: null` ile listeliyor (gizlemiyor — gizlese kuyruk boş
görünürdü). Bu satırlar listeleniyor ve `run.status.unknown` ("başlamadı")
olarak gösteriliyor; ona "queued" demek atanmamış bir kuyruk sırası uydurmak
olurdu.

## Zenginleşen veriyle iyileştirilen ekranlar

- **tickets** — `title`, `appId`, `step`, `risk`, `mod` sütunları eklendi.
  **"Kapıda" filtresi eklendi** — Temporal'ın sözlüğü kapıyı sıradan bir
  "running" yürütmeden ayıramadığı için bu yetenek daha önce hiç yoktu.
- **dash** — KPI'lar gerçek `state.status`'tan sayılıyor; "Kapıda bekleyen"
  KPI'sı eklendi. "Dikkat isteyenler" artık önce hatalı/devredilen, sonra
  **kapıda bekleyenler** (insan kararı bekleyen iş) — eski liste sadece "en
  eski çalışan"ı sunabiliyordu. Satırlarda adım adı ve risk rozeti var.
- **fanout** — **gerçek ağaç**. `parentTicketKey` + `childTicketKeys`
  kayıttan okunuyor. Eski ekran "ağacı bilmiyorum" deyip aynı Jira
  projesindeki kardeşleri gösteriyordu; bu hem **farklı projedeki alt işi
  kaçırıyordu** (M100'ün asıl amacı) hem de alt iş olmayan aynı-proje
  koşularını listeliyordu. Ana ticket'ın saydığı ama sayfada görünmeyen alt
  işler "Görünmeyen alt ticket'lar" olarak **adıyla** raporlanıyor — sessizce
  düşürülmüyor, yoksa ağaç kendi kapsamını eksik bildirir.
- **detail** — `useRunDetail` üç parçayı birden getiriyor. Kenar çubuğunda
  artık uygulama (+ADO repo yolu), bildiren, atanan, PR, tüketim (USD +
  token), mod, veri sınıfı ve **fan-out bağı** (ana/alt ticket linkleri) var.
  Eski "bu alanlar bu uçta yok" notu kaldırıldı çünkü boşluk kapandı.
  `state: null` olan ticket için künye gösteriliyor, adım listesi yerine
  "iş akışı henüz başlamadı" deniyor — eski uç bunu sadece 404 ile, yani
  "böyle ticket yok" diye ifade edebiliyordu ki bu farklı ve yanlış bir cümle.
- **clarify** — **gerçek 2b kuyruğu**. `step === "2b"` süzülüyor; eski ekran
  her çalışan koşuyu listeliyordu ve operatör bekleyeni bulmak için satırları
  açmak zorundaydı.
- **live** — "uçuşta" artık `running` **veya** `gate`; adım sütunu eklendi.

**Uydurma veri yok.** `reporter` (`""`) ve `title` (ticket anahtarı) alanları
`read-runs.ts`'in dürüstçe söylediği gibi Jira'dan gelmiyor; ekranda da öyle
görünüyorlar — boş hücre ve anahtar olarak.

## Tarayıcı kanıtı

Kendi yığınım: Postgres `55439` (kendi konteynerim, **kaldırıldı**), Temporal
`7233`, BFF `7101`, Studio `7100`. `seedDemo` ile projenin **kendi** 22
ticket'lık demo veri seti yüklendi (uydurma satır değil).

Kullanıcının ölçümü aynen tekrarlandı:

```
GET /runs              → {"runs":[]}          (Temporal boş)
GET /studio/runs?limit=30 → items: 22          (Postgres)
```

Giriş yapıldı (`ayse.kaya@ugurbank.local`) ve tarayıcıda görüldü:

- **Pano: "Toplam 22"** — "Henüz iş akışı yok" gitti.
- Temporal'da 6 gerçek koşu açıldıktan sonra pano: Aktif 1, **Kapıda 2**,
  Tamamlanan 1, Toplam 22; dikkat listesi hatalı→devredilen→kapıda sırasında.
- tickets: 22 satır, zengin sütunlarla; **"Kapıda" filtresi tam 2 satır**
  ("2b Clarification", "12 PR onayı").
- clarify: tam 1 satır (UGURPAY-712) — gerçek 2b kuyruğu.
- fanout: UGURPAY-500'ün **4 gerçek alt işi**.
- detail: adım listesi 12'de, kapı paneli (Onayla/Reddet), zengin künye,
  fan-out bağı.

Ekran görüntüleri: `dash-22-runs.png`, `dash-live-states.png`,
`tickets-gate-filter.png`, `fanout-real-tree.png`, `detail-enriched.png`,
`detail-gate-live.png`.

## Testler

Studio: **202 → 217** (flow-screens 15 → 39). Yeni testler zarfı, iç içe
durumu, `null` state'i, kapı filtresini, gerçek fan-out ağacını (farklı
projedeki alt iş dahil), görünmeyen alt işleri ve 2b kuyruğunu kapsıyor.

**Bozuk kodda kırıldığı kanıtlandı** — üç mutasyon:

| Mutasyon | Kırılan test |
|---|---|
| `body.runs` oku (eski zarf) | 14 |
| `status`/`step`'i `state` yerine kayıttan oku | 9 |
| Yolu `/runs`'a geri al | 14 |

Tümü geri alındı; `pnpm run gate` **exit 0, 60/60**,
`pnpm --filter @maestro/studio build` exit 0.

## ARAYÜZ İSTEKLERİ

1. **`RunRecord.title` ve `reporter`/`assignee` gerçek olsun.** `read-runs.ts`
   `title`'a ticket anahtarını, `reporter`'a `""` yazıyor çünkü `WorkflowRun`
   tablosunda Jira alanı yok. Liste ve clarify ekranları bunları gösteriyor
   ama içerik boş. Jira özeti/bildiren için ya bir sütun ya bir join gerekli.
2. **`GET /studio/runs` durum sözlüğüyle sunucu tarafında süzme.** Uç
   `?status=` kabul ediyor ama süzme sayfalamadan SONRA yapıldığı için
   (`studio-runs.ts:51`) filtreli sayfa tam sayfa olmuyor. Şu an 200 satır
   çekip istemcide süzüyoruz; koşu sayısı büyüyünce bu sürmez.
3. **Sayfalama arayüzü.** `nextCursor` taşınıyor ama hiçbir ekran "daha
   fazla" sunmuyor; 200'ün üstünde koşu olan bir kurulumda liste sessizce
   kesilir.
4. **`GET /activity`** — panonun "son 24 saat" kartı hâlâ boş.
5. **Etki matrisi ucu** — fan-out ağacı artık gerçek ama matrisin kendisi
   analiz belgesinde ve ucu yok.

## Yapmadıklarım

- `apps/bff/` altına hiç yazmadım (sadece okudum); `contracts`/`ports` donmuş.
- `Workmode` ekranına dokunmadım: `useRuns` kullanmıyor — statik matris +
  sinyal, kapsam dışıydı.
- Sayfalama arayüzü eklemedim (yukarıda istek olarak yazıldı); `nextCursor`
  taşınıyor ama tüketilmiyor.
- `runners`/`scans` read model'leri hâlâ üretici olmadığı için reddediyor —
  bu bilinçli ve bu görevin kapsamı dışı.
- main'e merge etmedim.
