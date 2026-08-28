# RAPOR — Analiz belgesinin Jira'ya otomatik eklenmesi (M103r)

## Amaç

Pilot, analiz belgesini (Word `.docx` + PDF `.pdf`) üretip indirilebilir hale
getiriyordu; ekleme işini bir insan (orkestratör) elle yapıyordu. Bu çalışma,
belgeler üretildikten sonra **her ikisinin de otomatik olarak Jira ticket'ına
ek dosya olarak yüklenmesini** gerçek ve fail-soft biçimde ekler.

## `addAttachment` metodu + Jira endpoint

Sürücüye özgü yetenek olarak eklendi (WorkPort DEĞİL — aşağıya bkz.):

```
JiraCloudWorkPort.addAttachment(
  key: TicketKey,
  filename: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ ids: string[] }>
```

- Endpoint: `POST /rest/api/3/issue/{key}/attachments`
- Header: `X-Atlassian-Token: no-check` (Jira Cloud'un XSRF muafiyeti; olmadan 403)
- Auth: JSON yollarıyla aynı — `Authorization: Basic base64(email:token)`; token
  aynı `SecretPort`/`TokenProvider` üzerinden gelir. Boş çözümlenen token, sessiz
  anonim POST yerine `JiraConfigError` fırlatır (fail-closed).
- Yanıt: 200 + attachment kaynaklarının JSON dizisi
  (`{id, filename, size, mimeType}`). `id`'ler döndürülür.
- Fixture (elde yazıldı, belgelenen şekilden):
  `packages/adapter-jira/fixtures/cloud/attachments-created.json`

### WorkPort FROZEN — neden port metodu değil

`packages/ports` içindeki `WorkPort` dondurulmuştur, dokunulmadı. `addAttachment`
yalnızca **somut** `JiraCloudWorkPort` sürücüsünde yaşar; tıpkı `verifyWebhook`/
`transition`'ın port yüzeyinde `CapabilityNotSupportedError` fırlatıp gerçek
davranışın sürücülerde bulunması gibi. Pilot bu tipe zaten somut olarak
(`createJiraCloudWorkPort` → `JiraCloudWorkPort`) sahip olduğundan doğrudan çağırır.

## Multipart gövdesi bir bağımlılık EKLENMEDEN nasıl kuruluyor

Node 24 yerel `FormData` ve `Blob` taşır — `form-data` gibi bir paket yok.
`JiraCloudClient.postFile(path, field, file, filename)`:

- `new FormData()` + `form.append("file", blob, filename)`
- `content-type` header'ı **elle set edilmez**: `fetch`, FormData'dan
  `multipart/form-data; boundary=…` header'ını türetir; elle bir header boundary'yi
  düşürür ve yüklemeyi bozar.
- Baytlar `bytes.slice()` ile taze bir ArrayBuffer'a kopyalanır (Blob, havuzlanmış
  bir buffer üzerindeki view'a değil tam bu baytlara sahip olsun diye).

Bu yol bilinçli olarak JSON `request()` yolundan ayrıdır; ek dosya JSON olmayan
tek yazma işlemidir. Hata sınıflandırması (401/403/404/429/5xx) JSON yoluyla aynı
`handle()`'ı paylaşır.

Dosya adı `sanitizeAttachmentFilename` ile temizlenir: sadece son yol segmenti
(`../evil` → `evil`), kontrol karakterleri `\x00-\x1f` (CR/LF header-injection
dahil) ve `" * : < > ? |` ile baştaki noktalar atılır; boşa çıkarsa `attachment`.

## Pilot bağlama noktası

`apps/pilot/src/run.ts` → `generateAnalysisDocs()` (analiz adımı ②). Sıra:

1. `analysisToDocs(...)` belgeleri render eder
2. `docs.put(runId, generated)` — indirme için park edilir (`docsReady = true`)
3. **YENİ:** `attachAnalysisDocs(work, ticketKey, generated, log)` çağrılır

Yani ekleme, indirme butonları HAZIR olduktan SONRA, analiz Jira yorumundan sonra
çalışır. Başarılıysa `onJiraChanged?.()` tetiklenir ve şu log düşer:
`✓ analiz belgesi Jira'ya eklendi: 2 dosya`.

Ekleme mantığı, hızlı/offline birim testi için `apps/pilot/src/docs.ts` içindeki
saf `attachAnalysisDocs()` fonksiyonuna ayrıldı (sürücü + logger enjekte edilir).
Sıra deterministik: önce `<KEY>-analiz.docx`, sonra `<KEY>-analiz.pdf`.

## Fail-soft davranışı

`attachAnalysisDocs` **asla fırlatmaz**. Bir yükleme başarısız olursa (kısmi bile —
docx geçer, pdf düşer) warning loglanır ve `{ attached: false }` döner. Analiz
yorumu ve indirme butonları zaten yerinde olduğundan akış aynen devam eder;
inceleyen kişi kalan dosyayı butonla indirir. Yalnızca gerçek jira yolunda çağrılır
(pilot'un `work`'ü zaten gerçek cloud sürücüsüdür; fixture/fake yol yoktur).

## Testler (hepsi offline — gerçek Jira'ya asla gidilmez)

`packages/adapter-jira` (6 yeni, cloud/work-port.test.ts):

- multipart POST doğru URL'e + `X-Atlassian-Token: no-check` + Basic token ile gider;
  `file` part'ı sanitize edilmiş adla FormData'da; content-type elle set edilmez
- path-traversal + CRLF dosya adı part adına ulaşmadan temizlenir
- `sanitizeAttachmentFilename` doğrudan (traversal / CRLF / boş / Windows yolu)
- boş token → `JiraConfigError`, POST atılmaz
- 2xx ama id yok → `JiraResponseError`

`apps/pilot` (3 yeni, docs.test.ts + iki akış testi güçlendirildi):

- her iki dosya (docx sonra pdf) doğru ad/content-type ile eklenir, id'ler döner
- FAIL-SOFT: ekleme hatası fırlatmaz, `attached=false`, warning loglanır
- FAIL-SOFT kısmi: pdf docx'ten sonra düşse de resolve olur, sadece ilk id
- `flow.test.ts` (gerçek-benzeri Jira, E2E): akış sonunda ticket'a tam olarak
  `OPS-6-analiz.docx` + `OPS-6-analiz.pdf` doğru content-type'larla yüklenmiş olur
- `flow-github.test.ts`: attachments endpoint 500 döner; akış yine de tamamlanır
  (fail-soft'un GERÇEK bir koşuda kanıtı)

### Test sayıları

- `@maestro/adapter-jira`: 166 test yeşil (cloud/work-port.test.ts: 28)
- `@maestro/pilot`: 65 test yeşil (docs.test.ts: 14)
- typecheck (her iki paket) temiz; repo `pnpm lint` 0 hata
  (demo-stack'te 3 alakasız, önceden var olan uyarı — bu çalışmada dokunulmadı)

## Bağımlılık

Yeni runtime bağımlılığı YOK. Sadece Node 24 yerel `FormData`/`Blob`/`fetch`.
Contracts/ports dondurulmuş yüzeyi değişmedi.
