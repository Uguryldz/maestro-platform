# Maestro — canlı Jira pilotu (`@maestro/pilot`) · RAPOR

Bu uygulama, `apps/demo`'nun **kısaltılmış teslim akışının** birebir kardeşidir;
tek fark **Jira kenarının GERÇEK** olmasıdır. Demo'nun sahte Jira'sı yerine
`@maestro/adapter-jira`'nın **`jira-cloud`** sürücüsü kullanılır ve akış canlı
`https://uyildiz.atlassian.net` sitesine (proje **OPS**) karşı koşar. Azure
DevOps hâlâ sahtedir (demo'nun `fake-ado.ts` + wiring'i birebir); model, PII
maskeleme, tarayıcı ve denetim izi gerçektir — tıpkı demo'daki gibi.

```
ticket okundu → analiz → [İNSAN: gerçek Jira'ya /approve] → kod → tarama →
test → PR (sahte ADO) + CI → [İNSAN: gerçek Jira'ya /approve] → merge + denetim izi
```

## Ne gerçek, ne sahte?

| Parça | Durum |
|---|---|
| **Jira** | **GERÇEK** — `jira-cloud` sürücüsü → uyildiz.atlassian.net, proje OPS |
| Azure DevOps | **SAHTE** — yerel taklit sunucu (demo ile aynı prop) |
| Model | **GERÇEK** — OpenRouter (`openai/gpt-4o-mini`) |
| Analiz, kod, testler | **GERÇEK** — model üretir, testler gerçekten koşar |
| PII maskeleme | **GERÇEK** — `@maestro/pii`, gidiş yolunda yeniden taranır |
| Denetim izi | **GERÇEK** — `@maestro/audit` hash zinciri, sonunda doğrulanır |
| Temporal, sandbox, gerçek git push | **YOK** — sonraki dalgalar |

## Webhook yok — yoklama (poll) var

Atlassian Cloud yerel makineye (localhost) ulaşamaz, dolayısıyla demo'daki
imzalı Jira webhook'u burada **yoktur**. Yerine `src/poll.ts` iki şeyi yoklar:

- **Keşif:** `searchIssues({ jql: "project = OPS AND labels = maestro ORDER BY
  created DESC", maxResults: 20 })` ile Maestro'ya dahil edilmiş ticket'lar
  bulunur (sürücünün **sınırlı-JQL** koruması korunur — JQL bir proje adlandırır).
  Sonuçlar UI'daki "▶ Ticket seç ve başlat" listesine düşer; operatör birini
  seçip başlatır. Çalışan uygulamada bu döngü `main.ts`'te periyodik döner;
  testlerde `refreshDiscovery()` elle çağrılır, hiçbir zamanlayıcı ateşlenmez.
- **Komut yoklaması (kapı açıkken):** `listComments(ticketKey)` birkaç saniyede
  bir okunur, her yorum sürücünün `parseCommandFromComment`'inden geçirilir; ilk
  geçerli `/approve` veya `/reject <sebep>` işlenir. **De-dup**, yorum id'siyle
  yapılır (`seen` kümesi) ve **M105** kuralları sürücüde korunur: yalnız hiç
  düzenlenmemiş (`updated == created`), üst düzey düz bir komut sayılır — bir
  alıntı/kod bloğu içindeki `/approve` kapıyı açmaz. Kapı çözülünce yoklama
  durur (her kapı kendi taze `seen` kümesiyle çalışır).

## Gerçek Jira'ya yazılan yorumlar

Analiz yorumu, ilerleme (M75 tek canlı yorum düzenlenerek), kapı sonuçları ve
kapanış yorumu — hepsi sürücünün `addComment`/`updateComment`'i ile **gerçek
siteye** gider. Çalışan uygulamada bu, canlı REST v3 çağrılarıdır; testlerde
`jiraFetch` enjekte edilir (kayıtlı fixture'larla beslenen durum bilgili bir
stub), böylece hiçbir istek ağa çıkmaz.

## Sırların (secret) ele alınışı

Canlı Jira token'ı `JIRA_CLOUD_API_TOKEN` ortam değişkeninden okunur ve
**doğrudan SecretPort'a** (demo'nun bellek-içi `env-file` deseni) tohumlanır;
hiçbir yerde loglanmaz/serileştirilmez. Sürücü token'ı `apiTokenRef` üzerinden
çözer (M44/M80). E-posta config'te, token yalnız SecretPort'ta. OpenRouter
anahtarı da aynı şekilde ele alınır. Sahte ADO sırları atılabilir yerel
dizelerdir.

## SoD (görevler ayrılığı) — M71 gevşetmesi

Canlı site **tek kullanıcılıdır**: operatör aynı anda PO, TL ve QA'dir. Kapıyı
başlatan kişiden **farklı** birine veremeyiz. Bu pilot SoD'yi **config ile
gevşetir**, kuralı **silmez**:

- Onay grubu `APPROVER_GROUP` bir **config değeridir**
  (`PILOT_APPROVER_GROUP`, varsayılan **`jira-users-uyildiz`**). Bu grup,
  operatörün sitede gerçekten üyesi olduğu bir gruptur — kayıtlı kanıt:
  `packages/adapter-jira/fixtures/cloud/group-member-by-name.json` (son üye,
  operatörün accountId'si `712020:7ee7a2ab-…`).
- `verifyMembership` çağrısı **her onayda çalışır** ve grupta olmayan bir
  onaylayanı **fail-closed** reddeder (`run.ts` → `awaitApproval`). Yani
  gevşetme yalnız "hangi grup" seçimindedir; kontrol atlanmaz, kod içine gömülü
  bir bypass yoktur.
- Denetim izi bir onaylayanı `user@corp` biçiminde ister; Cloud yorumcusu ise
  opak bir `accountId`'dir. `config.ts` → `corpAccountOf` bunu kurumsal hesaba
  eşler (varsayılan `PILOT_OPERATOR_ACCOUNT`), böylece kapı **atfedilebilir** bir
  aktörle kaydedilir — insan zincirde görünür kalır.

Gerçek çok-kullanıcılı bir kurulumda `PILOT_APPROVER_GROUP` gerçek onaylayan
grubuna işaret eder ve başlatan ≠ onaylayan tekrar sağlanır; kod değişmez.

## Çevrimdışı doğrulanabilirlik

Gerçek `fetch` boot'ta enjekte edilir (demo'nun `llmFetch`'i gibi): `jiraFetch`
ve `llmFetch`. Testler her ikisini de stub'lar; canlı akış orkestratör
tarafından gerçek ortamla ayrıca koşulur.

- `test/poll.test.ts` (7 test) — keşif + komut yoklaması, kayıtlı Cloud
  fixture'larına karşı (de-dup, kabul listesi, düzenlenmiş yorum reddi, /reject).
- `test/flow.test.ts` (3 test) — uçtan uca: durum bilgili sahte-Jira-Cloud
  (canlı REST v3 rotalarını fixture şekliyle yanıtlar) + gerçek loopback sahte
  ADO + stub model; iki kapı yalnızca **yoklanan** `/approve` ile çözülür,
  maskeleme + denetim zinciri + merge doğrulanır. **10/10 yeşil, ağa çıkmaz.**

## Canlı başlatma (orkestratör)

`maestro/.env` içinde şunlar bulunmalı (zaten var):
`OPENROUTER_API_KEY`, `JIRA_CLOUD_BASE_URL`, `JIRA_CLOUD_EMAIL`,
`JIRA_CLOUD_API_TOKEN`. Sonra:

```
pnpm -F @maestro/pilot start
# → http://localhost:7020  (canlı Jira: uyildiz.atlassian.net · sahte ADO: 7021)
```

Tarayıcıda soldaki listeden `maestro` etiketli bir OPS ticket'ı seçip başlatın;
kapı açıldığında o ticket'a **gerçek Jira'da** `/approve` yorumu yazın.

## Bilinen sınırlar

- Sürücünün `verifyMembership`'i için canlı fixture yalnız `group-member-by-name`
  şeklindedir; grup adı `PILOT_APPROVER_GROUP` operatörün üye olduğu bir grupla
  eşleşmezse onay fail-closed reddedilir (beklenen davranış).
- Keşif tek sayfadır (`maxResults: 20`); OPS'ta 20'den fazla `maestro` ticket'ı
  olması pilot için beklenmez.
- Kod yalnız `apps/pilot` altındadır; `packages/*` ve `apps/demo` değişmedi.

## pdf+word üretimi

Pilot artık **gerçek analizi** indirilebilir **`.docx` (Word)** ve **`.pdf`**
dosyası olarak üretir. Bu, analizin ikinci bir özeti değildir: reviewer'ın Jira
yorumunda okuduğu **aynı `AnalysisDoc`**, `@maestro/publish` paketinin gerçek
render motorlarından geçirilir. Yeni bir renderer YAZILMADI.

### Kullanılan gerçek publish fonksiyonları

Zincir (`apps/pilot/src/docs.ts` → `analysisToDocs`):

1. `renderAnalysisMarkdown(analysis, ctx)` — `AnalysisDoc` → kanonik markdown
   (7 zorunlu bölüm + clarifications). Çeviri fonksiyonu olarak `@maestro/config`
   `t` (gerçek Türkçe katalog) enjekte edilir.
2. `buildDocumentModel({ markdownSource, translate, locale, ticketKey, runId,
   templateVersion, date })` — markdown → nötr `DocumentModel` (künye + numaralı
   bölümler). Her iki renderer da bu **tek** modeli tüketir.
3. `renderDocx({ model, template: null, templateBytes: null })` — Word baytları
   (kurumsal şablon yok → dahili düzen; `no_template` uyarısı pilotta gösterilmez).
4. `renderPdf(model)` — PDF baytları (Unicode DejaVu fontu gömülü → Türkçe güvenli).

Türkçe (İ, ş, ğ, ı, ç, ö, ü) her iki dosyaya da bozulmadan taşınır — publish
paketi bunu garanti eder; bu glue yalnızca analizi olduğu gibi geçirerek
bozmamakla yükümlüdür.

### Nerede üretilir, nerede saklanır

- Üretim: analiz adımından (step "2") sonra, Jira yorumu yazıldıktan HEMEN sonra
  (`run.ts` → `generateAnalysisDocs`). Bir render hatası akışı bloke etmez;
  loglanır ve butonlar gösterilmez (dosyalar bir kolaylıktır).
- Saklama: bellek içi `DocStore` (`docs.ts`), `runId` ile anahtarlı. Pilot tek
  akış çalıştırır; sayfa yalnız güncel koşunun belgelerini sunar. Diske yazılmaz.

### İndirme rotası + UI

- `GET /api/doc/pdf` ve `GET /api/doc/docx` (`server.ts`): doğru `Content-Type`
  (`application/pdf` / OOXML wordprocessingml), `Content-Disposition: attachment;
  filename="OPS-7-analiz.pdf"` (ticket'a göre). Belge henüz üretilmediyse **404**.
- UI (`ui.html`): analiz hazır olunca (`state.docsReady`) **"📄 Analizi PDF indir"**
  ve **"📝 Word indir"** butonları görünür. Mevcut SSE/state deseni korundu
  (`state.ts`'e `docsReady: boolean` eklendi).

### Canlı görmek

`pnpm -F @maestro/pilot start` → `http://localhost:7020`. Bir OPS ticket'ı seçip
başlatın; **step 2 (Analiz üretildi)** tamamlanınca KPI'ların altındaki kartta
iki indirme butonu belirir. Butonlar gerçek `.pdf` ve `.docx` dosyalarını indirir.

### Offline testler

- `apps/pilot/test/docs.test.ts` (11 test): 7 zorunlu bölümün model'e eşlenmesi,
  docx'in `PK` zip başlığı + `word/document.xml` içermesi, pdf'in `%PDF`/`%%EOF`
  ile başlaması-bitmesi, Türkçe karakterlerin docx metnine ulaşması (yerinde
  `node:zlib` ile `word/document.xml` açılıp aranır), `DocStore` davranışı.
- `apps/pilot/test/server-doc.test.ts` (4 test): üretimden önce 404, bilinmeyen
  kind için 404, pdf/docx rotalarının doğru `Content-Type` + attachment filename
  ile bayt akıtması. Ağa çıkılmaz.

Yeni çalışma zamanı npm bağımlılığı eklenmedi; yalnız iki workspace paketi
(`@maestro/publish`, `@maestro/config`) pilot'a bağlandı — renderer'lar ve
katalog bunlarda zaten mevcuttu.

## ayarlar paneli (env→UI)

M71 ruhu ("bir çok şey env yerine UI'dan çalışmalı"): pilotun operasyonel
ayarları artık yalnız env ile değil, çalışma anında UI'dan düzenlenebilir. Env
hâlâ TOHUM'dur — panele hiç dokunulmazsa hiçbir şey değişmez.

### UI'dan düzenlenebilir olan 6 ayar
- `approverGroup` (PILOT_APPROVER_GROUP) — kapı onayının üyeliği doğrulandığı grup
- `model` (PILOT_MODEL) — düşünme rollerinin modeli
- `commandPollMs` (PILOT_COMMAND_POLL_MS) — kapı yorumu yoklama aralığı
- `discoveryPollMs` (PILOT_DISCOVERY_POLL_MS) — keşif yoklama aralığı
- `dataClass` (PILOT_DATA_CLASS) — yük veri sınıfı (PII maskeleme sıkılığı)
- `operatorAccount` (PILOT_OPERATOR_ACCOUNT) — denetimdeki `user@corp` yedeği

Gizli değerler (OpenRouter/Jira jetonları) ve yapısal sabitler (ADO_*, portlar,
sabit URL'ler, keşif JQL'i) BİLEREK dışarıda: ayar ≠ sır. GET /api/settings
yalnız bu 6 alanı döndürür; hiçbir jeton sızmaz.

### Mağaza / rota / koruma tasarımı
- `src/settings.ts` — `SettingsStore`: env'den TOHUM'lanan bellek-içi mağaza.
  Yazımda doğrulama: poll aralıkları pozitif tam sayı ve 1000–120000 ms;
  dataClass ∈ {acik,dahili,gizli}; model ve grup boş olamaz; operatör boş olamaz.
  Geçersiz yazım net Türkçe mesajla reddedilir ve mağaza eski değerini korur —
  asla çöp saklanmaz. Bellek-içi bilinçli: pilot tek makine/tek akış; DB'li,
  denetimli ayar mağazası Studio/Dalga-3 işidir. Yeniden başlatınca env'den
  yeniden tohumlanır (belgelenmiş davranış, hata değil).
- `GET /api/settings` — güncel 6 değer (sır yok).
- `POST /api/settings` — doğrula + güncelle; yeni değerleri veya doğrulama
  mesajıyla 400 döndürür.
- Her kullanım yerinin env sabitini MODÜL YÜKÜNDE değil KULLANIM anında
  mağazadan okuması sağlandı: `run.ts` ayarları start()'ta bir kez
  snapshot'lar (`runSettings`); `boot.ts` keşif döngüsü aralığını her turda
  mağazadan yeniden okur (sabit setInterval yerine kendini yeniden zamanlayan
  setTimeout). `corpAccountOf` artık operatör hesabını parametre olarak alır.

### Akış-sürerken koruma kararı (mid-run guard)
Karar: bir akış sürerken ayar değişikliği 409 `akış sürerken değiştirilemez`
ile REDDEDİLİR (uygula-sonraki-koşuda yerine reddet). Neden: en güvenli seçim.
Akış start()'ta ayarları snapshot'lar; böylece bir kapı bir grup için açılıp
başka bir gruba karşı kapanamaz, veri sınıfı akış ortasında kaymaz. UI'da da
Kaydet düğmesi akış sürerken kilitlenir (yalnız sunucuda değil, ekranda da
görünür). Not: `model` gateway binding'ine boot'ta bağlanır (@maestro/llm-gateway
donuk); model değişikliği bir sonraki BOOT'ta geçerli olur — diğer beş ayar
sonraki koşu/yoklamada canlı olarak geçerli olur.

### Denetim/log
Ayar değişikliği pilot log'una yazılır: `⚙ ayarlar güncellendi (operatör): <alanlar>`
(değişen alan yoksa "değişiklik yok").

### UI
`ui.html`'e "⚙ Ayarlar" paneli eklendi: 6 alan güncel değerleriyle, Türkçe
etiketler, Kaydet düğmesi POST eder ve başarı/doğrulama geri bildirimi gösterir.
Sayfanın mevcut stiline uyumlu.

### Testler (çevrimdışı, ağ yok)
`test/settings.test.ts` (21) + `test/server-settings.test.ts` (5) = 26 yeni test:
her sınır (0/negatif/devasa/ondalık poll red, kötü dataClass, boş model/grup red,
geçerli kabul), env haritasından tohumlama, snapshot'ın kopya olması, geçersiz
yazımın mağazayı DEĞİŞTİRMEMESİ; GET sır alanı döndürmez; POST geçersizi 400 ile
reddeder; akış-sürerken 409 koruması. Pilot toplam: 51 test yeşil.
