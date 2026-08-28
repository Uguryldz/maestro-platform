# Dalga 5 — Word/PDF doküman üretimi + şablon kaydetme uçları

Branch: `worktree-agent-ad832dc3001fe139b` · temel: `1d9d29f`

## 1. Seçilen kütüphaneler ve gerekçe

| Kütüphane | Sürüm | Ne için | Gerekçe |
|---|---|---|---|
| `docx` | ^9.7.1 | `.docx` üretimi ve **şablon yamalama** | Saf JS/TS, harici ikili yok. `patchDocument` ile kurumun kendi `.docx`'i **yeniden serileştirilmeden** yer tutucuları doldurulur — kapak, logo, üstbilgi/altbilgi ve stiller bize hiç uğramadan korunur. Bizim yeniden yazdığımız her şeyi sessizce kaybedebiliriz; bu API o riski ortadan kaldırıyor. |
| `pdfkit` | ^0.19.1 | `.pdf` üretimi | Saf JS, harici ikili yok. Akış tabanlı, `bufferPages` ile "N / toplam" sayfa numarası mümkün. |
| `dejavu-fonts-ttf` | ^2.37.3 | PDF'e gömülü Unicode font | **Zorunluluk, tercih değil** — aşağıya bakınız. |

### Neden pandoc/LibreOffice yok
İstenmediği gibi kullanılmadı. `.docx → .pdf` dönüşümü LibreOffice veya Word gerektirir; konteynere ~400 MB ofis paketi eklemek operasyonel sürpriz olur. Bunun yerine **tek doküman modelinden iki ayrı render** yapılıyor (`doc-model.ts`). Sonucu gizlemiyorum: `.docx` şablona sadık olan çıktıdır (kapak/logo şablondan gelir), `.pdf` taşınabilir olandır ve kurumsal kapak görselini taşımaz.

### PDF'te Türkçe — ölçülen bir kusur
pdfkit'in yerleşik Helvetica'sı WinAnsi kodlamalıdır. Ölçtüm (`pdftotext` ile doğrulandı):

```
İ → 1     ı,ğ → á     ş → _     Ğ → á_
"Türkçe: İıĞğŞşÖöÜüÇç" → "Turkce: 1áá_ÖöÜüÇç"
```

Dosya açılıyor, makul görünüyor ve **başka bir şey söylüyor**. Bir Türk bankasının onaylanmış dokümanı için bu sessiz bozulmadır. Çözüm: Unicode TTF **gömülüyor**. Font `/usr/share/fonts`'tan değil **npm bağımlılığı** olarak geliyor — bu konteynerde tesadüfen bulunan bir font, bankanın kendi imajında bulunmayabilir. Font çözülemezse `PublishRenderError` atılır; sessizce bozuk karakterle üretmez.

Gömülü fontla doğrulandı: `Türkçe: İıĞğŞşÖöÜüÇç — Kapsam Dışı` tam olarak geri okunuyor.

## 2. Yazılan sürücüler

- **`src/doc-template.ts`** — şablon veri modeli. Studio'nun `Doctemplate.tsx` ekranının gösterdiği şekle uyar: `placeholders` (token/descriptionKey/location/found), `sectionMapping` (index/title/token/mapped), `outputs`. `TemplateWarning` **döndürülür**, fırlatılmaz ve yutulmaz.
- **`src/doc-model.ts`** — kanonik markdown → başlık + **künye** + numaralı bölümler. Künye satırları (`- **Ticket:** …`) tabloya taşınır, iki kez basılmaz — referans PDF ile basılmış markdown arasındaki fark tam olarak budur.
- **`src/docx-blocks.ts`** — blok → `docx` nesnesi eşlemesi (koyu lacivert başlıklı tablo, kod bloğu satır satır, güvenli olmayan link düz metne düşer).
- **`src/docx-render.ts`** — iki mod: kurumsal şablon **yamalanır**, yoksa sade yedek düzen + `no_template` uyarısı.
- **`src/pdf-render.ts`** — aynı modelden PDF; künye tablosu, numaralı bölümler, her sayfada ticket ve `N / toplam`.
- **`src/drivers/binary-doc.ts`** — `docx` ve `pdf` hedefleri. Üretilen dosyayı enjekte edilen `sink`'e (`StoragePort.put` şekilli) yazar, makbuz depolama anahtarını taşır.
- **`src/drivers/confluence-attach.ts`** — üretilen dosyayı sayfaya **ek** olarak yükler.

### Mimari karara uyum
Doküman **platform tarafında** üretiliyor; sandbox'a hiçbir şey gitmiyor. Sandbox'ın ağ çıkışı yalnız egress proxy'ye açık (M26), kurumsal şablon platform verisi, ve PII maskesi zaten yayın sınırında (`port.ts` `redact` → tüm sürücüler aynı maskeli baytları alır). Üretilen dosya bu sınırdan **sonra** doğar, dolayısıyla maskeyi atlayamaz.

## 3. Kompozisyon anındaki ret disiplini — korundu

`register.ts` artık `docx`/`pdf` için `CapabilityNotSupportedError` atmıyor, **ama ret anı değişmedi**:

```ts
if (!deps.sink) {
  throw new PublishConfigError(`the ${target} target needs deps.sink (StoragePort) …`);
}
```

Ret sebebi "bu hedef yok"tan "bu hedef dosyasını saklayamaz"a döndü; **momenti** aynı. `jira+pdf` projesi hâlâ Jira yorumunu atıp sonra ikinci hedefte düşemez. `register.test.ts` bunu ayrıca doğruluyor: sette kurulamayan bir hedef varsa `FakeWorkPort.calls` **sıfır**.

## 4. Şablon kaydetme uçları (M108) ve M83 pinleme

Studio'nun `Template.tsx` ekranı zaten `GET /template` ve `POST /template/versions` çağırıyordu; uçlar o sözleşmeye **birebir** yazıldı.

| Uç | Davranış |
|---|---|
| `GET /template` | `{template, history, projects}` — ekranın beklediği şekil |
| `GET /template/versions/:version` | **Pinlenmiş koşunun** ve denetçinin eski sürümü okuma yolu |
| `POST /template/versions` | `latest + 1` **yayınlar**, 201 döner; hiçbir sürümü düzenlemez |

**M83 pinleme yaklaşımı:** pinleme bu uçlarda *yapılmaz*, **mümkün kılınır**. Koşu şablonunu başlangıçta bir kez çözer (`RunContext.templateVersion`, `workflows/impl/analysis.ts` uyuşmazlıkta koşuyu durdurur). Bu uçların M83'e borcu üç şey:

1. **Yayınlanmış sürüm değişmez** — kayıt append-only; v5 yayınlamak v4'ü yerinde düzenlemez. `InMemoryTemplateStore.publish` `latest + 1` dışındaki her şeyi reddeder (iki yazarın aynı anda v5 olup birinin taslağını kaybetmesi engellenir).
2. **Eski sürüm okunabilir kalır** — `GET /template/versions/:version` bu yüzden var.
3. **Açık koşulara dokunulmaz** — bu dosyalarda koşuyu yeni sürüme taşıyan tek satır yok; `projects()` kaç koşunun hâlâ eski sürümde olduğunu (`pinnedRuns`) rapor eder.

Test `publishes the NEXT version instead of editing the current one` v1'in bayt bayt aynı kaldığını doğruluyor.

### 4-göz: neden gerekmiyor (gerekçeli)
`putParam` guarded parametrelerde 4-göz uyguluyor çünkü o parametreler **kimin neyi onaylayacağına ve akışın nerede duracağına** karar veriyor (M71/M32) — yani kontrolün kendisini değiştiriyorlar; ikinci imza olmadan yürürlüğe girmemeleri gerekir.

Şablon sürümü ise **analistten ne isteneceğini** değiştirir. Ürettiği doküman 3→4 kapısında bir insan tarafından okunur, yargılanır ve onaylanır; **dört göz zaten orada** ve asıl önemli olan onlar. Buraya ikinci onaycı koymak *cevabı* değil *soruyu* kapılamak olurdu — üstelik şablon hatası bir sonraki analizde görünür ve yeni sürümle düzeltilir, geri alınamaz bir yan etkisi yoktur. Bunun yerine M83'ün geri kalanı (değişmezlik + tam denetim kaydı + açık koşulara dokunmama) uygulandı.

Bölüm anahtarı (`slugify`/`uniqueKey`) **sunucuda yeniden türetilir**, istemciden gelen anahtara güvenilmez: anahtar üretilen Zod şemasının property adıdır; çakışan iki anahtar şemada tek property üretir ve **her analizden bir bölüm sessizce düşer**. `Kapsam`/`kapsam`/`KAPSAM` → `kapsam`, `kapsam_2`, `kapsam_3` (test edildi).

## 5. Confluence'a yükleme

`confluence.ts` okundu — **ek yükleme yolu yoktu**, eklendi (`confluence-attach.ts`). Orkestratör kararına uyuldu: sayfa zaten **ticket başına tek yaşayan sayfa** (state key `publish:confluence:${ticketKey}:${doc}`, id ile bulunur), üretilen dosya o sayfaya **ek** olarak yüklenir — kendi sayfası olsaydı onaylanan dokümanı çatallardı.

Aynı adla tekrar yükleme **mevcut eki günceller** (`…/child/attachment/{id}/data`), ikinci kopya açmaz: Confluence aksi halde `analiz.docx` ve `analiz(1).docx`'i birlikte tutar ve denetimde hangisinin onaylandığı belirsizleşir. `X-Atlassian-Token: nocheck` gönderilir; `content-type` **elle yazılmaz** (multipart boundary'yi fetch'in üretmesi gerekir).

## 6. Üretilen örnek dosyanın kanıtı

Dosyalar testte üretiliyor (`test/evidence-artifacts.test.ts`), yani her kapıda yeniden doğrulanıyor.

```
$ file /tmp/maestro-analiz.docx /tmp/maestro-analiz.pdf
/tmp/maestro-analiz.docx: Microsoft Word 2007+
/tmp/maestro-analiz.pdf:  PDF document, version 1.3, 3 page(s)

$ unzip -l /tmp/maestro-analiz.docx
  word/document.xml, word/styles.xml, word/numbering.xml,
  [Content_Types].xml, docProps/core.xml, _rels/.rels …
```

`word/document.xml` içinde: `KURUMSAL USTBILGI` (şablonun kendi metni **korunmuş**), `Kart limit artırım akışını otomatikleştirmek.` (analiz metni **yerleşmiş**), `{{bolum:1}}` **yok** (yer tutucu tüketilmiş).

PDF'ten `pdftotext -layout` ile geri okunan metin — künye tablosu, numaralı bölümler, Türkçe ve madde işaretleri:

```
UGURPAY-123 — Analiz
 Hazırlayan    Maestro (AI)
 Tarih         2026-08-09
 Versiyon      analysis-template@1.4.0
 Kapsam        UGURPAY-123
1. Amaç
Kart limit artırım akışını otomatikleştirmek.
2. Kapsam
 •   Limit artırım servisi
 •   Mobil ekran
3. Risk ve geri dönüş
…
UGURPAY-123                                    1/1
```

Çok sayfalı belgede altbilgi (`test/pdf-pagination.test.ts`, poppler ile): `1/5, 2/5, 3/5, 4/5, 5/5` — her sayfada ticket + doğru toplam.

### Bu iş sırasında yakalanan iki gerçek kusur
1. **Madde işaretleri üst üste biniyordu.** pdfkit'in `continued: true` zinciri `doc.y`'yi sarmalanmış metnin *sonuna* bırakmaz. Çıktı `Mobil artırım / Limit ekran servisi` şeklinde okunuyordu — okunamaz ve onaylanmış bir analizde **yanlış**. Yükseklik önceden ölçülüp `doc.y` açıkça konumlandırılarak düzeltildi. Sadece dosyayı geri okuyarak yakalandı.
2. **Bozuk şablonda yanlış hata.** "Gövde yuvası yok" reddi, dosyanın okunabilir bir `.docx` olup olmadığından **önce** çalışıyordu; yüklenmiş ama artık `.docx` olmayan bir dosya için yayını hatalı reddediyordu. Okunabilirlik (`PK\x03\x04`) artık önce doğrulanıyor.

## 7. Mutasyon kanıtları (fail-closed)

| Senaryo | Beklenen | Test |
|---|---|---|
| Şablon yok | Üretim **durmaz**, `no_template` uyarısı döner ve çağırana iletilir | `warns when the institution has no template…`, `reports template warnings to the caller…` |
| Yer tutucu yok | Bölüm **sona eklenir** ve **raporlanır** (başlığıyla) | `appends a section the template has no slot for and REPORTS it` |
| Bölümün gidecek yeri yok | **Reddedilir** — tam görünen eksik doküman yayınlanmaz | `refuses when sections have nowhere to go rather than dropping them` |
| Şablon bozuk | Yedek düzen + `template_unreadable` uyarısı | `falls back with a warning when the uploaded template is not a .docx` |
| Boş içerik | `PublishRenderError` | `refuses a document with no renderable content` |
| 0 baytlık dosya | Yayın reddedilir (sürücüde ve ek yüklemede ayrı ayrı) | `refuses a zero-byte file rather than uploading a corrupt document` |
| Sink yok | **Kompozisyonda** ret, yan etki yok | `refuses docx and pdf at COMPOSITION time when they cannot be built` |
| Aynı belge tekrar | Nesne **yeniden yazılmaz** (WORM sürümü yakılmaz) | `does not rewrite an immutable object when the document is unchanged` |
| Çakışan bölüm anahtarı | Benzersizleştirilir, bölüm kaybolmaz | `makes colliding keys unique rather than losing a section` |
| Bölümsüz/başlıksız şablon | 400, hiçbir sürüm yayınlanmaz | `refuses a template with no sections`, `refuses a section without a title…` |
| `__proto__` başlıklı bölüm | Anahtar `proto`'ya katlanır; şema property'si olamaz | `constrains derived keys to plain identifiers` |

## 8. Testler

- `packages/publish`: **+22** test (`binary-doc.test.ts` 12, `confluence-attach.test.ts` 6, `evidence-artifacts.test.ts` 2, `pdf-pagination.test.ts` 2); `register.test.ts` içindeki 2 test yeni sözleşmeye güncellendi. Hepsi çevrimdışı; Confluence `fakeFetch` ile sahtelendi.
- `apps/bff`: **+13** test (`template.test.ts`).
- `packages/config` katalog testleri tr+en paritesini ve **her yayılan anahtarın katalogda var olduğunu** doğruluyor (bu kapı benim eksik `publish.doc.placeholder` anahtarımı yakaladı).

Katalog: **1349 / 1349** (tr/en), alfabetik sıralı, 13 yeni anahtar çifti. `apps/studio/` altına **yazılmadı** (yalnız okundu).

### Kompozisyon köklerine dokunma zorunluluğu
`BffDeps.templates` zorunlu alan olduğu için **üç** kompozisyon kökü güncellendi — kapının yakaladığı gerçek bir kırılmaydı:

- `apps/bff/test/helpers.ts` — test koşumu
- `apps/demo-stack/src/deps.ts` — iki sürümlü demo tohumu (`seed/template.ts`); tek sürüm M83'ü göstermezdi
- `apps/deploy/src/bin/bff.ts` — **üretim** kökü. Store süreç-içi olduğu için `VOLATILE_STORES` listesine dürüst bir kayıt eklendi: yeniden başlatmada yayınlanmış her şablon sürümü kaybolur ve pinlenmiş bir koşu neye göre yargılandığını okuyamaz. Bu, operatörün *okuduğu* bir maliyet; keşfettiği değil.

`templates` alanını isteğe bağlı yapmak daha kolaydı ama yanlış olurdu: şablonsuz bir BFF `GET /template`'e 404 döner ve tasarımcı ekranı sessizce boş açılırdı.

## 9. ARAYÜZ İSTEKLERİ

1. **`AuditAction` üyesi: `TEMPLATE_VERSION_PUBLISHED`.** `packages/contracts/src/audit.ts` donmuş durumda ve şablon yayınlamayı karşılayan bir eylem yok. Şimdilik `PARAM_CHANGED` + `template:` subject öneki + `meta.kind = "analysis_template"` kullanıldı — doğru bir ifade (Studio'dan yapılan, sürümlenmiş, denetlenen yapılandırma değişikliği) ama tam değil. Enum'a üye eklenince `template-service.ts` içindeki tek satır güncellenmeli.

2. **`PublishReceipt` için içerik türü/uyarı alanı (düşük öncelik).** `PublishReceipt` yalnız `{target, ref}` taşıyor. `docx`/`pdf` makbuzu bir depolama anahtarı taşıyor ama üretimin **uyarılı** olduğunu (şablon yok, bölüm sona eklendi) taşıyamıyor. Şimdilik `deps.onTemplateWarnings` geri çağrımıyla çözüldü; makbuza `warnings?: string[]` eklenirse kanıt paketi bunu kendi başına taşıyabilir.

3. **`StoragePort` bağımlılığı enjekte edildi, import edilmedi.** `@maestro/publish` depolama paketine bağımlı olmasın diye `DocumentSink` yapısal olarak tanımlandı (`put` imzası `StoragePort.put` ile birebir). Kompozisyon kökü `StoragePort`'u doğrudan geçebilir. Bu bir istek değil, kaydedilen bir karar.

## 10. Yapmadıklarım ve nedeni

- **Şekil/SVG üretimi (etki matrisi, akış şeması).** `DOKUMAN-STANDARDI.md` bunu açıkça **"Dalga 4 kalemi"** olarak işaretliyor ve bu görevin kapsamında sayılmadı. Bugün etki matrisi tablo/madde olarak dokümanda var, şekil olarak yok.
- **"Kaynaklar" ve "Netleştirilecek açık maddeler" bölümlerinin varsayılan şablona eklenmesi.** Sunucu tarafı şablon (`packages/agent-roles/src/template.ts`) bu iki formatı (`source_list`, `open_items`) ve `DEFAULT_ANALYSIS_TEMPLATE`'i **zaten taşıyor** (M109, Dalga 4'te yapılmış). Doküman üretimi bunları normal bölüm olarak render eder; ayrıca bir şey yapmadım.
- **Şablon `.docx` yükleme ucu (`POST /doc-template`).** `Doctemplate.tsx` bugün yalnız `GET /doc-template` çağırıyor; yükleme ekranı yok. Sürücü tarafındaki tüketici sözleşme (`DocTemplateSource`) hazır — yükleme ucu istenirse ayrı bir kalem.
- **Sunucu şablon modeli ile Studio modelinin birleştirilmesi.** `agent-roles` sekiz formatlı zengin bir `TemplateSection` taşıyor; Studio'nun istemci aynası dördünü gösteriyor. Uçlar **Studio'nun gönderdiği sözleşmeye** yazıldı (görev böyle diyordu). İkisinin tek şemada birleştirilmesi ayrı bir karar ve `agent-roles`'u da değiştirmeyi gerektirir.
- **`main`'e merge edilmedi**, istendiği gibi.
