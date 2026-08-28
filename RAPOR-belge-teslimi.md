# RAPOR — Word/PDF analiz belgesi teslimi Temporal hattına taşındı

**Branch:** `worktree-agent-af93abf1e6f348491` (temel: `11d5f03`)
**Kapı:** `pnpm run gate --concurrency=1` → **exit 0**, 64/64 görev yeşil.

## Ne yapıldı

`deliverAnalysis()` artık yorum + atamaya ek olarak analiz belgesini **gerçek `.docx` ve `.pdf`
olarak üretiyor ve Jira ticket'ına ek olarak yüklüyor** — pilotun yaptığının aynısı, ama
platformun kendi hattından.

## Mantığı nereye taşıdım + M44 gerekçesi

**Pilotun kodunu kopyalamadım. Kopyalamamak doğru cevaptı.**

Pilot (`apps/pilot/src/docs.ts`) `renderDocx`/`renderPdf`'i **doğrudan** çağırıyor. Bu, tek
operatörlü bir pilot için kabul edilebilirdi ama platformda değil: o yol **publish port'unun PII
kapısını atlıyor** (M20/M82). Yani pilotun Jira'ya yüklediği bayt dizisi hiçbir zaman maskelenmedi.

Platformda bu iş için **zaten bir ev vardı**: `packages/publish/src/drivers/binary-doc.ts`
(`BinaryDocPublisher`) — `docx`/`pdf` birer tam yetkili `PublishTarget`. Pilotun elle yazdığı her
şey orada hazır: kurumsal Word şablonu, M83 pininin markdown'dan geri okunması, sıfır-bayt reddi,
içerik-hash idempotency'si. İkinci bir kopya üretmek tam da kaçınılması gereken şeydi.

Bu yüzden yeni modül **üretmiyor, yönlendiriyor**:

```
deps.publish.publish({ doc: "analysis", targets: ["docx","pdf"] })
  → MaestroPublishPort        (BİR KEZ maskeler — M20/M82)
    → BinaryDocPublisher      (render eder, boş dosyayı reddeder, StoragePort'a yazar)
```

**Yeni dosyalar**

| Dosya | Rol |
|---|---|
| `packages/workflows/src/impl/analysis-docs.ts` (288 satır) | Üretim + ek yükleme + defter + fail-soft raporlama |
| `packages/workflows/src/impl/evidence-file.ts` | `delivery.ts`'ten çıkarılan yardımcı (300 satır sınırı) |
| `apps/deploy/src/stores/doc-attacher.ts` (45 satır) | Bileşim kökü: yeteneği sürücüye bağlar |
| `packages/workflows/test/analysis-docs.test.ts` | 21 test |

**M44 uyumu:** `packages/workflows` **hiçbir sürücü import etmiyor**. Üretim bir *port* çağrısı;
ek yükleme ise çekirdeğin ilan ettiği bir *şekil* (`DocAttacher`). Sürücü adını yalnızca bileşim
kökü biliyor. Testlerin ağa çıkmamasının sebebi de bu.

## Ek yükleme yolu (ARAYÜZ İSTEĞİ **gerekmedi**)

`addAttachment` donmuş `WorkPort`'ta değil, somut `JiraCloudWorkPort`'ta — bu bilinçli ve doğru.
Aktivite katmanından ona şöyle ulaştım:

1. `packages/workflows/src/impl/deps.ts` → **`DocAttacher`** arayüzü (opsiyonel `ActivityDeps` üyesi).
   Çekirdek yalnızca *şekli* ilan ediyor, `@maestro/adapter-jira`'yı import etmiyor.
2. `apps/deploy/src/stores/doc-attacher.ts` → `docAttacherFor(work)`. Tespit **yapısal**
   (`instanceof` değil): sürücü sınıfını buraya import etmek, registry'nin zaten verdiği kararın
   ortasına bir adapter sınıfı koymak olurdu; ayrıca ikinci bir sürücü aynı yeteneği kazandığında
   kırılırdı.
3. `apps/deploy/src/bin/worker.ts` → `CoreDeps`'e ekler (yalnızca sürücü destekliyorsa).

**Opsiyonel olması bilinçli.** DC sürücüsünde ek yükleme API'si yok. O kurulumda belgeler yine
üretilip **saklanıyor**, defter de ticket'a ulaşmadıklarını açıkça yazıyor. Zorunlu yapmak ya o
kurulumları kırardı ya da yalan söyleyen bir no-op stub gerektirirdi. `StoragePort`'a yazma zaten
`BinaryDocPublisher` sayesinde her durumda oluyor.

## Bileşim kökünde düzeltilmesi ZORUNLU olan iki gerçek boşluk

Bunlar olmadan özellik canlıda **çalışmazdı** — ikisi de gerçek hata:

1. **Publish port'u `docx`/`pdf` hedeflerini sunamıyordu.** Üç profil de tek hedefli `jira`
   sürücüsünü kullanıyordu; `MaestroPublishPort` sunamadığı hedefi `CapabilityNotSupportedError`
   ile reddeder. Yani teslim adımının belge isteği **her ticket'ta** hata verirdi.
   → Üç profil `publish: "multi"`, `publishConfig` → `["jira", "docx", "pdf"]`.
   Not: bu **port'un sunabildiği** küme; hangi belgenin nereye yayımlanacağı hâlâ projenin
   `publish.targets` parametresi (`ParamReader.publishTargets`). İkisi farklı sorular.
2. **`sink` (StoragePort) publish deps'ine hiç bağlanmamıştı.** `registerPublishDrivers`
   `docx`/`pdf` için sink'i **kayıt zamanında** şart koşar (doğru davranış).
   → `boot.ts`'te `work` ile aynı desende, registry'den önce `buildStorageSink`. Best-effort:
   sink kurulamazsa alan hiç konmuyor ve publish binary hedefleri **bileşim zamanında** gürültülü
   reddediyor — sessizce atlamak yerine.

## Üretilen dosya kanıtı (gerçek, `/tmp` altında)

Gerçek `MaestroPublishPort` + gerçek `BinaryDocPublisher` üzerinden `deliverAnalysisDocs` koşuldu:

```
$ file /tmp/OPS-9-analiz.docx /tmp/OPS-9-analiz.pdf
/tmp/OPS-9-analiz.docx: Microsoft Word 2007+
/tmp/OPS-9-analiz.pdf:  PDF document, version 1.3, 2 page(s)

$ ls -l
-rw-rw-r-- 11434 OPS-9-analiz.docx
-rw-rw-r-- 25067 OPS-9-analiz.pdf
```

`pdftotext` ile Türkçe geri okuma (bozulma yok):

```
Analiz Dokümanı — OPS-9
Hazırlayan   Maestro (AI) — insan onayına tabidir
Tarih        2026-08-16
Şablon sürümü analysis@1.0.0
1. Amaç ve iş değeri
Ödeme mutabakat ekranında yanlış bakiye gösterilmesi hatasının giderilmesi
2. Kapsam — Kapsam içi: pay-api, pay-web · Kapsam dışı: kart-servisi
...
7. Risk ve geri dönüş planı — Risk katmanı: Orta
8. Kullanılan açıklamalar
```

Sekiz bölümün tamamı, `Dokümanı`/`Hazırlayan`/`Şablon`/`Kapsam dışı`/`Şüpheli` doğru.
`.docx` içeriği de (`word/document.xml`) aynı metni taşıyor. M83 pini belgede: `analysis@1.0.0`.

Ek yükleme ve defter çıktısı:

```
uploaded to Jira: [{"OPS-9-analiz.docx":11434},{"OPS-9-analiz.pdf":25067}]
journal:
  "analiz belgesi üretildi"        → "OPS-9-analiz.docx (11434 B) · OPS-9-analiz.pdf (25067 B) · şablon analysis sürüm 1.0.0"
  "analiz belgesi ticket'a eklendi" → "2 dosya: OPS-9-analiz.docx, OPS-9-analiz.pdf"
```

## Şablon pinleme (M83) — koşarken bulunan gerçek tuzak

Pini deftere ham haliyle (`şablon: analysis@1.0.0`) yazdığımda defter maskeleyicisi onu
**e-posta sanıp** `şablon: [EMAIL_1.e2c05cc8]` olarak sakladı — yani pini, onu koruyan kapı yok
etti. Publish yolu bu sorunu açık bir muafiyetle çözüyor
(`assertTemplatePinSurvived`, `packages/publish/src/pii.ts`); defterin muafiyet listesi yok.
Çözüm: `readablePin()` → `analysis sürüm 1.0.0`. Sürüm hâlâ **birebir** — M83'ün istediği bu.
Testle kilitlendi (`.not.toContain("EMAIL_")`).

## Fail-soft ama sessiz değil

`deliverAnalysisDocs` **asla throw etmiyor** (pilotun `attachAnalysisDocs` davranışı korundu).
Hata olduğunda **iki yere birden** yazıyor:
- **Deftere**: `"analiz belgesi eksik"` + `"(analiz teslimi etkilenmedi)"`
- **Jira'ya**: `jira.analysis_docs_failed` (tr + en, parite korundu)

Ticket yoruma da kapalıysa defter satırı yine duruyor — bu da throw etmiyor.
Gerekçe: yorum ve atama zaten yapıldı; burada patlamak üç Temporal denemesini yakıp
**teslim edilmiş** bir koşuyu FAILED yapardı.

## Idempotency

- `${runId}:publish:analysis-docs` — üretim/saklama bir kez.
- `${runId}:attach:${target}` — **dosya başına**; docx yüklenip pdf denenirken retry olursa
  docx ikinci kez yüklenmiyor.
- Test: iki kez çağır → 2 ek, 1 publish.

## Boş dosya yasağı

`assertRealDocument()`: `byteLength >= 1000` **ve** sihirli bayt (`%PDF-` / `PK`).
İkisi birden, çünkü başlık yazıp ölen bir renderer ne boş ne de belgedir.
Bozuk baytlar ticket'a **hiç ulaşmıyor** (testle kanıtlı).

## PII sınırı

Atlanmadı — aksine **düzeltildi**. Pilotun doğrudan render yolu maskelemeyi atlıyordu; yeni yol
`MaestroPublishPort` üzerinden geçtiği için belge baytları yayımdan önce **bir kez** maskeleniyor.
Üretim sandbox'ta değil, **platform tarafında** (`BinaryDocPublisher`'ın kendi doküman yorumunun
şart koştuğu gibi).

## Testler

- **21 yeni test** (`packages/workflows/test/analysis-docs.test.ts`)
- **2 yeni test** (`apps/deploy/test/compose.test.ts`): publish port'u gerçekten `docx`/`pdf`
  sunuyor mu; attacher yalnızca yetenekli sürücüde bağlanıyor mu (gerçek sürücülerle, stub değil)
- `packages/workflows`: 162 test yeşil · `apps/deploy`: 554 yeşil
- Ağ çağrısı yok; Jira sahtelendi.

## Mutasyon kanıtı (kendi worktree'mde, paylaşılan checkout'a dokunulmadı)

| # | Mutasyon | Sonuç |
|---|---|---|
| 1 | Ek yükleme döngüsünü boşalt (`for (const file of [])`) | **7 test kırmızı** |
| 2 | Boş dosya korumasını devre dışı bırak (`if (false && …)`) | **3 test kırmızı** |

İkisi de geri alındı; 21/21 yeşil, kapı exit 0.

## Yapmadıklarım

- **Pilotu silmedim / değiştirmedim.** `apps/pilot/src/docs.ts` duruyor (emekli, yalnız okundu).
  İki kopya taşınmıyor: Temporal hattı pilotun koduna hiç dokunmuyor, kendi (daha doğru) yolunu
  kullanıyor. Pilot silindiğinde bu dosya da gider; şu an silmek görev kapsamı dışıydı.
- **Kurumsal Word şablonu (`DocTemplateSource`) worker'a bağlanmadı.** `BinaryDocPublisher`
  `deps.docTemplates` destekliyor ama `buildPublishDeps` onu geçmiyor → şu an **yerleşik düzen**
  kullanılıyor (pilotun şablonsuz davranışının aynısı, `PrismaDocTemplateStore` BFF'te mevcut).
  Bağlamak küçük bir iş ama teslim yolunun doğruluğunu değiştirmiyor; ayrı adım olarak bırakıldı.
- **Canlıda yeni ticket'la uçtan uca doğrulama yapmadım** (canlı servisler koşuyor, ticket
  açmadım). Belge üretimi gerçek renderer'larla `/tmp` altında kanıtlandı.
- `WORK_DRIVER` override'ının yalnızca `buildWorkPort`'u etkileyip `buildPortSelection`'ı
  etkilemediğini fark ettim (registry hep profil sürücüsünü çözüyor). **Gerçek bir tutarsızlık**
  ama bu görevin kapsamı dışı — dokunmadım, burada not ediyorum.
