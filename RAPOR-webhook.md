# RAPOR — Jira webhook ile otomatik analiz başlatma

**Dal:** `worktree-agent-a9d86843e1892b2b8` (temel: `96520de`)
**Kapsam:** Jira Cloud webhook imza doğrulaması + kurulum belgesi

---

## İmza şemasının kaynağı

Kodu yazmadan **önce** Context7 üzerinden Atlassian'ın kendi dokümanı okundu:

- Kütüphane: `/websites/developer_atlassian_cloud_jira_platform`
- Sayfa: `developer.atlassian.com/cloud/jira/platform/webhooks` →
  **"Validating webhook deliveries"**

Dokümanın söyledikleri (tahmin değil, alıntı):

> "Jira Cloud uses your secret token to generate an HMAC signature, which is sent
> in the **X-Hub-Signature** header. To validate, calculate the HMAC of the
> payload using the specified hash algorithm and compare it to the header value.
> Ensure your implementation handles payloads as **UTF-8**."

> "Jira webhooks currently utilize the **sha256** hash algorithm for HMAC
> verification."

Kayıt gövdesinde `secret` alanı vardır (`POST /rest/webhooks/1.0/webhook`), cevapta
`"isSigned": true` döner. Dokümandaki Python örneği `hmac.compare_digest`
kullanıyor — yani sabit-zamanlı karşılaştırma Atlassian'ın da tarif ettiği yol.

**Bulgunun kendisi:** Bu şema Data Center'ınkiyle **birebir aynı**. Yani ortada
"Cloud'a özgü yeni bir şema" yok; `packages/adapter-jira/src/webhook.ts`
içindeki mevcut `verifyWebhookSignature` zaten doğru algoritmayı, doğru başlığı
(`x-hub-signature`) ve `timingSafeEqual`'ı uyguluyordu. Doğru iş, ikinci bir
doğrulayıcı yazmak değil, Cloud sürücüsünü **var olana bağlamaktı**.

---

## Yapılan

### 1. Cloud `verifyWebhook` gerçekten uygulandı

`packages/adapter-jira/src/cloud/work-port.ts:547` — eskiden
`CapabilityNotSupportedError` fırlatıyordu; artık DC ile aynı doğrulayıcıyı
çağırıyor:

```ts
if (this.webhookSecret === null) {
  throw new JiraWebhookVerificationError("missing_secret");
}
const header = Object.entries(headers).find(
  ([name]) => name.toLowerCase() === JIRA_SIGNATURE_HEADER,
)?.[1];
verifyWebhookSignature(rawBody, header, await this.webhookSecret());
```

**Fail-closed korundu, iki katmanda:**

- Sır **yapılandırılmamışsa** → `missing_secret` ile **reddeder**. Eski davranış
  da reddediyordu ama *yanlış sebeple* ("bu sürücü webhook bilmez"). Yenisi doğru
  sebebi söylüyor: platform eksik yapılandırılmış. İkisi arasındaki fark
  operasyoneldir — biri "özellik yok", diğeri "sırrı tanımla".
- Sır **varsa** → imza tutmazsa `mismatch`, başlık yoksa `missing_signature`,
  hex değilse `malformed_signature`. Hiçbir yol boolean döndürmüyor.

Sabit-zamanlı karşılaştırma DC'nin kullandığı `timingSafeEqual` üzerinden geliyor
(paylaşılan yardımcı), ham baytlar üzerinden — BFF gövdeyi `JSON.parse` etmeden
önce doğruluyor (`apps/bff/src/routes/webhooks.ts:34`), o yol zaten doğruydu.

### 2. Sır yapılandırması uçtan uca bağlandı

Kopuk halka buradaydı: `apps/deploy/src/driver-config.ts:77` **zaten**
`webhookSecretRef: env.JIRA_WEBHOOK_SECRET_REF` gönderiyordu, ama
`JiraCloudConfig` şemasında böyle bir alan yoktu — Zod bilinmeyen anahtarı
sessizce **düşürüyordu**. Yani ortam değişkeni doğru ayarlansa bile sürücüye
hiç ulaşmıyordu.

- `cloud/config.ts` — `webhookSecretRef: NonEmpty.optional()` eklendi.
  **Opsiyonel**, çünkü webhook kaydetmemiş bir kurulum (pilot yorumları
  poll ediyor) kullanmayacağı bir sır uydurmak zorunda kalmamalı. Opsiyonel olması
  doğrulamayı **atlamak** demek değil — sır yoksa sürücü reddediyor.
- `register.ts` — `webhookSecretRef` bildirilmişse `webhookSecret` çözücüsü
  geçiliyor, bildirilmemişse hiç geçilmiyor (var olmayan bir referansı çözmeye
  çalışıp SecretPort hatası üretmek yerine, sürücü teslimatı adıyla reddediyor).

Zincir artık tam: `MAESTRO_SECRET_KV_JIRA__WEBHOOK` → `JIRA_WEBHOOK_SECRET_REF`
(`kv/jira#webhook`) → `jiraCloudConfig` → `JiraCloudConfig` → sürücü.

### 3. Ticket oluşturma olayının akışı başlatması — DOĞRULANDI, kod değişmedi

Görevde "doğrula ve eksikse tamamla" deniyordu. Doğruladım; **eksik değildi**:

- `apps/bff/src/routes/webhooks.ts:80` → `runIntake` çağrılıyor
- `apps/deploy/src/work-events.ts:17` → `parseWebhookEvent` ile ayrıştırıyor;
  `packages/adapter-jira/src/webhook.ts:107` `jira:issue_` ile başlayan olayları
  `kind: "issue"` olarak sınıflıyor — `jira:issue_created` dahil
- Dinleme kuralı için gereken `status` / `issueType` / `assignee` teslimatın
  gövdesinden okunup `runIntake`'e geçiriliyor (`webhooks.ts:84-88`), yani
  mevcut `ListeningRule` (OPS + "Görev" + bota atanmış → analiz) aynen çalışıyor

Tek engel imza doğrulamasıydı; o kalkınca bu yol kendiliğinden açılıyor.
**Gereksiz kod yazmadım.**

### 4. Yeniden oynatma (replay) — DOĞRULANDI, kod değişmedi

`runIntake` → `deps.runs.signalWithStart` → `apps/deploy/src/temporal-gateway.ts:219`.
Koşu kimliği ticket'tan türetiliyor (`workflowIdFor`), ve
`WorkflowExecutionAlreadyStartedError` yakalanıp `{ started: false }` dönüyor.
Yarışı **motor** çözüyor, BFF değil. Jira aynı teslimatı yeniden gönderirse
ikinci koşu açılmıyor. `apps/bff/test/webhooks-jira.test.ts:89` bunu zaten
test ediyor ve geçiyor.

---

## Testler

**Yeni/değiştirilen: 8 test** (hepsi ağ çağrısız — fikstür yerinde imzalanıyor)

`packages/adapter-jira/test/cloud/work-port.test.ts` (6):

| Test | Kanıtladığı |
|---|---|
| geçerli imza kabul ediliyor | mutlu yol |
| başlık büyük/küçük harf duyarsız | Node başlıkları küçültür |
| yeniden serileştirilmiş gövde reddediliyor | doğrulama **ham baytlar** üzerinde |
| sahte/eksik/bozuk imza reddediliyor (4 vaka) | `mismatch`, `missing_signature` ×2, `malformed_signature` |
| **sır yapılandırılmamışsa reddediliyor** | `missing_secret`, ve `CapabilityNotSupportedError` **değil** |
| sır boş dizeye çözülürse reddediliyor | boş sır geçerli sır sayılmıyor |

`packages/adapter-jira/test/cloud/register.test.ts` (2):

| Test | Kanıtladığı |
|---|---|
| sır SecretPort **referansıyla** çözülüyor | referansın *değeriyle* doğruluyor, literaliyle değil |
| sırsız kurulan sürücü teslimatı reddediyor | opsiyonellik ≠ doğrulamayı atlama |

Eski `"refuses webhook verification — the pilot polls"` testi **silindi** (artık
yanlış bir gerçeği savunuyordu), yerine yukarıdakiler geldi.

**Görevde istenen dört kanıt:**

| İstenen | Nerede |
|---|---|
| geçerli imza kabul | cloud/work-port ✅ + `apps/bff/test/webhooks-jira.test.ts:69` (koşu başlıyor) |
| bozuk imza reddediliyor | cloud/work-port ✅ + `webhooks-jira.test.ts:22` (401, koşu yok) |
| sır yoksa reddediliyor | cloud/work-port ✅ + cloud/register ✅ |
| aynı teslimat iki kez → ikinci koşu yok | `webhooks-jira.test.ts:89` ✅ |

**Paket sonuçları:** adapter-jira 146/146 · bff 783/783 · workflows 162/162.

---

## Mutasyon kanıtı

`verifyWebhook` gövdesi `return;` ile değiştirildi (imza kontrolü tamamen kaldırıldı):

```
Tests  6 failed | 47 passed (53)
FAIL  refuses when the secret resolves to an empty string
      AssertionError: expected null to be an instance of JiraWebhookVerificationError
```

Geri alındı → 53/53 yeşil. Testler kontrolün **varlığına** bağlı, şekline değil.

Ayrıca belgedeki `curl` tarifi koda karşı doğrulandı — ikisi de aynı digest'i
üretiyor (`sha256=64dc13ee…`), yani §4.2'deki test komutu gerçekten çalışıyor.

---

## Kurulum belgesi

`maestro/docs/jira-webhook-kurulum.md` — Türkçe, adım adım, 6 bölüm:

1. **İmza sırrı** — `openssl rand -hex 32`, `MAESTRO_SECRET_KV_JIRA__WEBHOOK`,
   referans (`JIRA_WEBHOOK_SECRET_REF`) ile değerin farkı, Vault karşılığı
2. **Jira kaydı** — ekrandan ve REST ile; URL, üç olay (`jira:issue_created`,
   `jira:issue_updated`, `comment_created`) ve her birinin **niçin** gerektiği,
   JQL filtresi (`project = OPS`), `isSigned: true` kontrolü
3. **Dışarıdan erişim** — `BFF_HOST=0.0.0.0`, `ss -ltn` doğrulaması, NPM/TLS, ve
   proxy'nin gövdeye **dokunmaması** uyarısı (imza ham bayta ait)
4. **Test** — imzasız `401` beklenir (başarı göstergesi), `openssl` ile imzalı
   `202`, sonra gerçek ticket ile uçtan uca; belirti→sebep tablosu
5. **Replay** — aynı teslimat iki kez gelirse ne olur
6. **Kontrol listesi**

`§0` neden imzanın atlanamayacağını anlatıyor: sır yoksa uç reddeder, "şimdilik
açık bırak" modu yok.

---

## ARAYÜZ İSTEKLERİ

**Yok.** `packages/contracts` ve `packages/ports` değişmedi. `verifyWebhook`
zaten `WorkPort` üzerinde tanımlıydı — Cloud sürücüsü sözleşmeyi karşılamıyordu,
sözleşme eksik değildi.

---

## Yapmadıklarım

- **Webhook'u Jira'ya kaydetmedim.** Kayıt kullanıcının işi (belge §2); canlı
  Jira'ya yazmadım.
- **`BFF_HOST`/NPM'i değiştirmedim.** Yapılandırma işi, kod işi değil; ayrıca
  canlı BFF'i yeniden başlatmak açık oturumları düşürür — belgede uyarı var.
- **Canlı ortama dokunmadım.** `/home/ubuntu/coder/maestro`'ya yazılmadı, canlı
  DB'ye yazılmadı.
- **`packages/storage` / `apps/deploy/src/compose.ts` / `registry.ts`'ye
  dokunmadım** (paralel ajan orada).
- **`main`'e merge etmedim.**

## Kapı durumu

Kapı bu makinede **yük altında flake yapıyor** — HANDOFF "Tuzaklar" bunu zaten
yazıyor ve düşen testlerin **tam olarak orada adı geçenler** olması bunu
doğruluyor ("bff/password, studio/users, studio/params"). Paralel ajan koşarken
load average 8 çekirdekte 15–27 arasında gezdi.

Dört kapı koşusu yapıldı; yük düştükçe düşen test sayısı da düştü:

| Koşu | Yük | Düşenler |
|---|---|---|
| 1 | ~19 | studio · bff · workflows · deploy:typecheck |
| 2 | ~27 | studio · bff · workflows · deploy:typecheck |
| 3 | ~18 | storage/s3-response |
| 4 | **7.4** | **studio/screens-users (tek)** |

**Düşenlerin hepsi tek başına yeşil:**

| Düşen | Tek başına |
|---|---|
| `apps/bff` | 783/783 ✅ |
| `packages/workflows` | 162/162 ✅ |
| `apps/studio` (tüm paket, seri) | **326/326** ✅ |
| `apps/studio` `screens-users` | 7/7 ✅ |
| `packages/storage` `s3-response` | 12/12 ✅ |
| `apps/deploy` `typecheck` | temiz ✅ |
| `packages/adapter-jira` | 146/146 ✅ |

Studio paketi `--poolOptions.forks.singleFork=true` ile **tamamen** yeşil
(326/326) — yani kod sağlam, düşen şey eşzamanlılık.

Düşenlerin **hiçbiri** benim diff'imle ilgili değil: değişikliğim yalnızca
`packages/adapter-jira` + iki yeni markdown dosyası; `apps/studio`'ya hiç
dokunmadım. `storage` testi zaten paralel ajanın bölgesi.
