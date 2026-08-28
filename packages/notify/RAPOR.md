# RAPOR — `@maestro/notify` (Dalga 2)

`NotifyPort` (M45) eklenti sürücüleri: **teams** · **smtp** · **jira** · **slack**, artı
tamamen parametrik **eskalasyon merdiveni** (M88) ve kanal seçimi (M71/M87).
Kod/yorum/test adları İngilizce (M59); bu rapor Türkçe.

> **Sürüm 2 (düzeltme turu).** Bağımsız doğrulamanın 19 bulgusu (B1–B19) kapatıldı;
> her düzeltmenin önce kırmızı olan bir testi var (`test/hardening.test.ts`,
> `test/smtp-hardening.test.ts`, `test/escalation-hardening.test.ts`,
> `packages/db/test/notify-params.test.ts`). Bulgu bazında durum §7'de.
> **Davranış değişiklikleri** (çağıranı ilgilendirir): `SocketLike` sözleşmesi
> genişledi (§5.2), `EscalationStep.id` zorunlu oldu, `DEFAULT_LADDER` kaldırıldı
> (varsayılan artık DB'de), `NotifyRouting.byEvent` anahtarları tipli.

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/deps.ts` | Enjekte edilen çalışma zamanı ortakları: `FetchLike`, `Clock`, `Sleep`, **`SocketLike` + `SocketFactory` + `TlsInfo`** (SMTP taşıması). `startTls()` artık el sıkışma gerçeklerini **döndürmek zorunda**; sürücü doğrulamadan devam etmez (B9). Tüm testler bunlar sayesinde çevrimdışı ve deterministik. |
| `src/errors.ts` | Tipli hatalar: `NotifyConfigError`, `NotifyMessageError`, `NotifyRecipientError`, `NotifyTransientError` (yeniden denenir), `NotifyPermanentError` (denenmez), `NotifyDeliveryError` (teslim edilemedi — çağırana ulaşır) ve **`NotifyFanoutError`** (çok hedefli başarısızlık; `attempts` her zaman *deneme sayısı*, hedef sayısı değil — B17). `redact()`/`safeMessage()` sır maskeleme. |
| `src/config.ts` | Zod yapılandırmaları (hepsi Studio/DB parametresi — M71): `RetryPolicy`, `WebhookDriverConfig` (hedef adı → SecretPort anahtarı), `SmtpDriverConfig` (`host`/`ehloName` artık `SmtpHostName` — CR/LF ile SMTP komut enjeksiyonu kapalı, B8), `JiraDriverConfig`, `NotifyRouting` (olay→kanal; anahtarlar **`NotifyEventKey`**, serbest string değil — B14), `EmailAddress`. Port/sürücü kimlikleri. |
| `src/message.ts` | **M104 çekirdeği**: `renderMessage()` metni `@maestro/config`'in `t()`'siyle katalogdan çözer; eksik parametre kontrolü **şablon üzerinde** yapılır (parametre DEĞERİ süslü parantez içerebilir — B11); `requireNotification()` donuk sözleşmeye göre fail-closed doğrular; `routeNotification()` olay→kanal yönlendirmesi. |
| `src/retry.ts` | Teslim garantisi: `sendWithRetry` (sınırlı deneme, üstel+tavanlı backoff, `Retry-After` desteği), `sendToEachTarget` (tekrarlı hedefler ayıklanır — B18; her hedef denenir, hatalar tek `NotifyFanoutError`'da toplanır, iç hata **ikinci kez sarmalanmaz** — B17). |
| `src/webhook.ts` | İki Incoming-Webhook kanalının ortak makinesi: sırdan URL çözümü (`Object.hasOwn` — prototip anahtarı hedef değildir, B7), `to` içinde `://` geçen değer **yankılanmadan** reddedilir (B6), https zorunluluğu, durum kodu sınıflandırması, gövde/URL maskeleme. |
| `src/teams.ts` | Teams Incoming Webhook — `message`/`attachments` zarfı içinde **Adaptive Card** (1.4). 2xx gövde denetimi **beyaz liste**: yalnız boş gövde veya `1` başarıdır (B1). Kart metninde `[ ] ( )` etkisizleştirilir — onay kartında tıklanabilir oltalama bağlantısı üretilemez (B12). |
| `src/slack.ts` | Slack Incoming Webhook — `text` + `mrkdwn` blok; `&<>` kaçışlaması **`text` alanına da** uygulanır (B12). 2xx gövde denetimi beyaz liste: yalnız boş gövde veya `ok` başarıdır (B1). |
| `src/jira.ts` | Jira yorumu — **enjekte `WorkPort` üzerinden** (M44 temiz oda: `@maestro/adapter-jira` import edilmez). `to` = ticket key'leri; hata sınıflandırması yapısal (`status` alanı). |
| `src/smtp-protocol.ts` | El yazımı SMTP tel katmanı: çok satırlı yanıt okuyucu (`SmtpReplyReader`; kod ayrıştırma `/^\d{3}$/` + 4. karakter `" "`/`"-"` — `Number()` değil, B16), EHLO yetenek ayrıştırma, RFC 5322 tarih, RFC 2047 encoded-word, dot-stuffing, base64 MIME gövdesi, **CR/LF başlık enjeksiyonu reddi** (`fromName` dahil, açık kontrol — B19). |
| `src/smtp-client.ts` | SMTP oturumu: EHLO → STARTTLS → AUTH (PLAIN/LOGIN) → MAIL → RCPT → DATA → QUIT. İlan edilmiş STARTTLS **her modda** alınır (B10); TLS oturumu doğrulanır (B9); AUTH adımlarında sunucu yanıt METNİ hataya konmaz ve parolanın **tel biçimleri** (base64 SASL belirteci dahil) maskelenir (B2); `close()` hiçbir koşulda hata fırlatmaz (B3). Fail-closed kurallar §3'te. |
| `src/smtp.ts` | `NotifyPort` SMTP sürücüsü: SecretPort'tan parola, katalog metninden gövde, tek işlemde çok alıcı. |
| `src/calendar.ts` | Çalışma takvimi (M88): sabit UTC ofseti, çalışma günleri, mesai penceresi, tatiller; `workingMinutesBetween` ve tersi `addWorkingMinutes`. |
| `src/escalation.ts` | Merdiven şeması + **saf fonksiyon `escalationDueAt(ladder, {openedAt, now, firedStepIds})`** ve `planEscalation()` (bildirim üretimi + delegasyon listesi; ürettiği her bildirim donuk `Notification` sözleşmesine göre ayrıştırılır — B15). `EscalationStep.id` **zorunlu ve kalıcı** (B13). **`DEFAULT_LADDER` KALDIRILDI** — varsayılan merdivenin tek kaynağı DB'dir (B4, §5.1). |
| `src/register.ts` | `registerNotifyDrivers(registry, deps)` (M44) + `CompositeNotifier` (`multi` sürücüsü): çekirdek tek `NotifyPort` tutar, `notification.channel`'a göre dağıtım yapılır. |

**Boyut:** üretim kodu **1309 satır** (yorum/boşluk hariç), en büyük dosya 231 satır (tavan 300).
Düzeltme turu 1192 → 1309 satır ekledi; **1200 satırlık paket tavanı aşıldı** — eklenen 117 satırın
tamamı bulguların karşılığı (TLS doğrulaması, beyaz liste gövde denetimi, sır tel biçimleri,
CR/LF kontrolleri, fan-out muhasebesi). Tavanı kaldırma/koruma kararı orkestratörün (§5.5).
Test: **15 dosya, 157 test**, tamamı çevrimdışı; ayrıca `@maestro/db` içinde 7 test (§5.1).

## 2. Kararlar ve gerekçeleri

### 2.1 SMTP istemcisini kendimiz yazdık (nodemailer EKLENMEDİ) — karar: YAZ
Görev "riskli görüyorsan gerekçelendir ve minimal arayüz bırak" diyordu; **yazmayı seçtim**. Gerekçe:
1. **Kapsam gerçekte küçük**: gönderim akışı 1982'den beri sabit; oturum mantığı 231 satır, tel katmanı 188 satır.
2. **Enjekte edilebilirlik şart**: nodemailer'ın soketi enjekte edilemez; onunla her SMTP testi ya canlı sunucu
   ya da kütüphane iç mock'u ister — "çevrimdışı + deterministik" kuralı sınıfça ihlal olurdu. Bizim
   `SocketLike`'ımızla senaryolu sahte sunucu 30 satır (bkz. `test/helpers.ts`).
3. **Banka tedarik yüzeyi**: bir kod yolu için büyük geçişli bağımlılık ağacı (ve onun CVE takibi) girmiyor.
4. **İhtiyacımız dar**: gönderim (submission), düz metin gövde, tek MIME parçası. Eklenti yok, ek yok,
   HTML yok, DKIM imzalama yok (relay'in işi), havuzlama yok.
**Kabul edilen sınırlar (dürüst kapsam):** AUTH yalnız PLAIN + LOGIN (CRAM-MD5/XOAUTH2 yok — kurum
relay'inde ikisi de yaygın değil, gerekirse ~20 satır eklenir); ek/HTML gövde yok; SMTPUTF8 yok
(adresler ASCII; başlıklar RFC 2047 ile kodlanır, gövde base64/UTF-8 — Türkçe metin sorunsuz);
bağlantı havuzu yok (bildirim hacmi buna değmez).

### 2.2 Gerçek soket adaptörü (`node:net`/`node:tls`) bu pakette YOK — talep §5.2
Arayüz (`SocketFactory`) tanımlı ve sürücü, adaptör verilmeden **kurulum anında gürültülü hata verir**
(test edilmiştir). Adaptörün kendisi kompozisyon kökünün işi: paket içinde kalsaydı ya ağ isteyen bir test
gerektirirdi ya da test edilmemiş ölü yol olarak kalırdı (§5 kontrol listesi). Sözleşme + iskelet §5.2'de.

### 2.3 Takvim sabit UTC ofseti kullanır, IANA bölgesi değil
Türkiye 2016'dan beri kalıcı UTC+3; sabit ofset hesabı tam, bağımlılıksız ve konteynerin `TZ` değişkeninden
bağımsız olarak tekrarlanabilir yapar (Temporal replay determinizmi için önemli). Ofset parametredir;
DST uygulayan bir ülke için ileride bölge adı gerekirse §5.3'teki talep açılır.

### 2.4 Jira sürücüsü düz metin gönderir
`WorkPort.addComment(key, body)` "ADF belgesi **veya** düz metin" kabul ediyor ve `@maestro/adapter-jira`
dönüşümü kendi `adf.ts`'inde yapıyor. Burada ikinci bir renderer yazmak, sessizce sapan iki biçimlendirme
demekti. Temiz oda korunuyor: bu paket Jira'nın HTTP API'si olduğunu bilmiyor.

### 2.5 Teslim semantiği: at-least-once
Yeniden deneme (ve Temporal'ın dayanıklı yeniden denemesi) **kopya bildirim** üretebilir; SMTP'de tek işlemde
çok alıcı olduğu için yeniden deneme hepsine yeniden gönderir. Bilinçli tercih: *kaybolan* bir kapı bildirimi
işi sessizce öldürür, *tekrarlanan* bir hatırlatma öldürmez. Idempotency anahtarı talebi §5.4.

## 3. Fail-closed davranışlar

- **Katalog (M104):** olmayan anahtar → `NotifyMessageError` (sessiz geçiş YOK). ŞABLONDAKİ `{param}`
  doldurulmamışsa da hata — "{ticket} kapıda bekliyor" metnini onaycıya göndermek sessiz bozulmadır.
  Kontrol şablona bakar, üretilen gövdeye değil: parametre DEĞERİ içindeki süslü parantez (ticket
  özeti, log satırı) kapı bildirimini öldürmez (B11).
- **Sözleşme:** her sürücü gelen bildirimi donuk `Notification` şemasıyla doğrular; kanalı kendisine ait
  olmayan bildirimi reddeder (`multi` sürücüsü de etkin olmayan kanalı reddeder, sessizce düşürmez).
- **Webhook URL'i:** `to` yalnız **hedef adı** taşır; URL SecretPort'tan gelir ve `https://` değilse
  gönderim yapılmaz (URL'in yolu bearer kimliğidir). Bilinmeyen hedef → hata, sessiz atlama yok.
- **STARTTLS:** ilan edilmiş STARTTLS **her modda** alınır (`plaintext` dahil — B10); `security: "starttls"`
  iken sunucu ilan etmiyorsa **açık metne düşülmez**, hata verilir. El sıkışma öncesi sunucudan veri
  gelirse (STARTTLS komut enjeksiyonu) oturum reddedilir.
- **TLS doğrulaması (B9):** yükseltme sonrası taşımanın bildirdiği oturum denetlenir — sertifika zinciri
  doğrulanmış (`authorized`), protokol ≥ TLS 1.2, SNI = yapılandırılan `host`. Biri tutmazsa **kalıcı**
  hata: doğrulanmamış bir relay'e yeniden denemek parolayı bir kez daha sızdırmaktır. `implicit` modda
  aynı denetim ilk bayt yazılmadan önce yapılır.
- **Komut enjeksiyonu (B8):** `host`/`ehloName` DNS-adı biçimine zorlanır ve `SmtpSession.command()`
  herhangi bir argümanda CR/LF görürse satırı yazmadan reddeder.
- **Sır sızıntısı (B2):** AUTH adımlarında sunucu yanıt metni hataya hiç konmaz (yalnız kod) ve parolanın
  tel biçimleri (`b64(pw)`, `b64("\0user\0pw")`, `b64(user)`, dolgusuz varyantları) maskelenir.
- **Kapanış (B3):** `close()` hiçbir koşulda hata fırlatmaz; teslim sonucu (250 queued ya da kalıcı 5xx)
  kapanış hatasıyla ne silinir ne değiştirilir — aksi mükerrer e-posta ya da kaybolan kalıcı hata demekti.
- **Kimlik bilgisi:** şifreli olmayan kanalda AUTH gönderilmez (`allowInsecureAuth` yalnız laboratuvar kaçışı,
  varsayılan kapalı). Desteklenen AUTH mekanizması yoksa hata.
- **Alıcı reddi:** bir `RCPT TO` reddedilirse mesaj **hiç kimseye** gönderilmez (kısmi teslim = sessizce
  eksik onaycı). Jira'da geçersiz ticket key'i gönderim başlamadan reddedilir.
- **Hata yutulmaz:** her başarısız yol `NotifyDeliveryError` ile çağırana çıkar; kaç deneme yapıldığı ve
  hangi hedeflerin düştüğü mesajın içindedir.
- **Merdiven:** alıcısı boş çıkan eskalasyon adımı hata verir; ulaşılamaz eşik (takvim yüzünden) hata verir.

## 4. Test özeti (157 test / 15 dosya, ağ YOK)

| Dosya | Test | Ne kanıtlıyor |
|---|---|---|
| `message.test.ts` | 9 | Katalogdan TR/EN gövde, olmayan anahtar/parametre hatası, konu satırı sınırı, sözleşme doğrulaması, olay→kanal yönlendirme + bilinçli susturma |
| `teams.test.ts` | 12 | Adaptive Card zarfı, sırdan URL çözümü, bilinmeyen hedef, http reddi, 500/429/408 yeniden deneme + backoff değerleri, 400 denenmez, tükenince hata, "200 ama failed" gövdesi, çok hedefli kısmi hata raporu, kanal uyuşmazlığı, taşıma hatası |
| `slack.test.ts` | 4 | Blok yapısı, mrkdwn kaçışı, gövde başarısızlık okuması, 403 |
| `jira.test.ts` | 8 | WorkPort'a katalog metni, çok ticket, geçersiz key, 503 denenir / 403 denenmez, `CapabilityNotSupportedError`, soket hatası denenir, kısmi hata raporu |
| `smtp-protocol.test.ts` | 14 | Tek/çok satırlı yanıt, parçalı chunk birleştirme, kopan bağlantı, bozuk kod, kod değişimi, tampon kontrolü, yetenek ayrıştırma, RFC 5322 tarih, encoded-word (75 kar. sınırı), CR/LF enjeksiyon reddi, dot-stuffing, base64 gövde |
| `smtp.test.ts` | 13 | Tam komut sırası + TLS yükseltme + kapanış, AUTH PLAIN/LOGIN, STARTTLS yokluğunda ret, açık metinde kimlik göndermeme, implicit TLS, alıcı reddinde iptal, 4xx yeni bağlantıda yeniden deneme, 5xx denenmez, TLS öncesi veri enjeksiyonu, geçersiz e-posta, gövde/tarih içeriği, eksik username |
| `calendar.test.ts` | 10 | ISO gün eşlemesi, mesai penceresi, akşam/hafta sonu/tatil atlama, `addWorkingMinutes` tam tersinir, Cuma akşamı + 24 iş saati = Çarşamba, Pazar–Perşembe haftası, geçersiz pencere, ulaşılamaz eşik |
| `escalation.test.ts` | 14 | DB'de saklanan merdivenin **alan alan** ayrıştığı (artık `not.toThrow()` değil, tam değer karşılaştırması), eşik altı/üstü tetikleme, tekrar tetiklememe, determinizm, başa adım eklemede TÜM kimliklerin kararlılığı, mesai-içi modu, sonraki tetik anı, ters zaman reddi, plan → bildirim/delegasyon/alıcısız adım/`notify.delegated` |
| `retry.test.ts` | 7 | Başarıda tek deneme, geçici hatada backoff dizisi, kalıcı hatada deneme yok, bilinmeyen hata yutulmaz, backoff tavanı/Retry-After, çok hedefte hepsinin denenmesi ve toplu rapor |
| `register.test.ts` | 7 | 5 sürücü kaydı, registry üzerinden çalışan port, eksik bağımlılıkta gürültülü hata, geçersiz config reddi, composite dağıtımı, etkin olmayan kanal reddi, boş composite reddi |
| `leak.test.ts` | 6 | Webhook URL'i ve SMTP parolası; taşıma hatası, sunucu yankısı (**gerçekçi biçim: base64 SASL belirteci**), hata gövdesi, `String`/`inspect`/`JSON.stringify`/`stack` yüzeylerinin hiçbirinde sır yok; `redact()` yüzde-kodlu biçimi de maskeler |
| `hardening.test.ts` | 30 | B1 gerçek Teams/Slack ret gövdeleri kalıcı hata + sağlıklı gövdeler hâlâ başarı · B6 `to`'daki URL yankılanmaz · B7 beş prototip anahtarı bilinmeyen hedef · B11 parametre değerindeki süslü parantez · B12 Slack `text` kaçışı + Teams kart markdown'ı · B16 beş bozuk yanıt kodu · B17/B18 tekrarlı hedef bir kez, deneme muhasebesi, çift sarmalama yok · B19 `fromName` CR/LF |
| `smtp-hardening.test.ts` | 11 | B2 base64 SASL belirteci ve base64 parola hiçbir yüzeyde yok (çıktıdaki her base64 parça çözülüp denetleniyor) · B3 250-queued + close hatası → başarı, 552 + close hatası → 552 korunur · B8 config reddi + tel seviyesinde ret · B9 doğrulanmamış sertifika / TLS 1.0 / yanlış SNI / implicit TLS yokluğu · B10 `plaintext` modda ilan edilmiş STARTTLS alınır |
| `escalation-hardening.test.ts` | 11 | B13 eşik 72s→48s düzenlemesi gönderilmiş adımı yeniden tetiklemez, `id` zorunlu, çakışan `id` reddi · B15 `now`/`openedAt` `IsoDateTime` doğrulaması (`"2026-08-02"` reddedilir) · B5 delegasyon adımı `notify.delegated` yayar · B14 `kill_swich` yazım hatası ve tanımsız kanal reddedilir |

Kapılar: `pnpm install` ✓ · `pnpm -F @maestro/notify typecheck` ✓ · `test` ✓ (157) ·
kökten **`pnpm run gate` (= `lint` + `turbo run typecheck test --force`) ✓ — 38/38 görev, önbelleksiz.**
§5.4'teki `@maestro/config#test` kırığı bu turda artık yok (başka bir pakette kapatılmış).

## 5. Talepler ve bulgular (orkestratör kararı)

### 5.1 Katalog anahtarı ve varsayılan merdiven — KAPANDI (B4/B5)
`notify.delegated` anahtarı katalogda **mevcut** (tr + en). Delegasyon adımı artık onu yayıyor:
`planEscalation()` içinde `action: "delegate"` olan bir adımın varsayılan anahtarı `notify.delegated`
(açık `messageKey` verilmişse o kazanır) ve DB'deki tohum değer de `messageKey: "notify.delegated"` yazıyor.
Raporun eski hâli "eksik" diyordu; bu iddia bayattı ve düzeltildi.

**Varsayılan merdivenin tek kaynağı DB'dir (M71).** `DEFAULT_LADDER` sabiti paketten KALDIRILDI.
Tohum değer `packages/db/src/params-defaults.ts` → `escalation.ladder`:

| id | afterHours | kanal | olay | action | messageKey |
|---|---|---|---|---|---|
| `reminder-24h` | 24 | jira | gate_reminder | notify | (varsayılan `notify.gate_reminder`) |
| `escalation-72h` | 72 | teams | escalation | notify | (varsayılan `notify.escalation`) |
| `delegate-7d` | 168 | smtp | escalation | **delegate** | **`notify.delegated`** |

İki yarının sapmasını `packages/db/test/notify-params.test.ts` engelliyor: tohum değer ve demo
geçmişindeki HER sürüm, bu paketin `EscalationLadder` şemasıyla ayrıştırılıyor ve `resolveSteps()`'ten
geçiriliyor. Bunun için `packages/db`'ye **workspace devDependency** olarak `@maestro/notify` eklendi
(yeni npm bağımlılığı yok, döngü yok — notify `db`'ye bağlı değil).

**Demo tohumu da düzeltildi:** yorum "7g delegasyon" diyordu ama üretmiyordu; artık `delegate-7d` adımı
gerçekten `action: "delegate"` + `notify.delegated` taşıyor, 14 günlük adım `management-report-14d`.

**Öneri (zorunlu değil, hâlâ açık):** e-posta konu satırı gövdenin ilk satırından türetiliyor. Kanal başına
ayrı başlık istenirse bu, `notify.subject.<event>` ailesi olarak merkezî katalogda tanımlanmalı — paket
içinde asla. Karar orkestratörün.

### 5.1b `notify.routing` parametresi eklendi (B14 — M87 artık gerçekten bağlı)
`NotifyRouting.byEvent` serbest string anahtar kabul ediyordu: `kill_swich` yazım hatası sessizce
varsayılana düşüyordu ve haritanın DB'de karşılığı **yoktu**, yani M87 ("ops kanalı Studio parametresi")
kâğıt üstündeydi. İki değişiklik:
1. Şema `z.partialRecord(NotifyEventKey, z.array(NotifyChannel))` — bilinmeyen olay/kanal reddedilir.
2. `packages/db`'ye `notify.routing` parametresi eklendi (global, json, 4-göz değil), katalog anahtarı
   `params.description.notify_routing` (tr + en). Varsayılan: kapı trafiği `jira`, eskalasyon
   `teams+smtp`, `runner_health`/`quota_wait` `teams` (M87), `kill_switch` `teams+smtp`.

### 5.2 Bağımlılık/kod talebi: `SocketFactory` gerçeklemesi
**Yeni npm bağımlılığı EKLENMEDİ** (nodemailer dahil). Üretimde SMTP'yi çalıştırmak için kompozisyon kökünün
`node:net`/`node:tls` üzerinde şu sözleşmeyi karşılayan ~60 satırlık bir adaptör vermesi gerekiyor:

- `read()`: sıradaki baytlar; bağlantı kapandıysa `null`. (Stream'in async iterator'ı birebir uyar.)
- `write(bytes)`: yazma tamponu boşalınca çözülen promise.
- `startTls(): Promise<TlsInfo>`: **aynı** bağlantıyı `tls.connect({ socket, servername: host })` ile
  yerinde yükseltir; yükseltme sonrası okuma yeni TLS soketinden yapılır. (İstemci, yükseltme öncesi
  tamponda bayt kalmadığını zaten doğruluyor.) **Dönüş zorunlu** ve doğrudan `tls.TLSSocket`'ten alınır:
  `{ authorized, authorizationError, protocol: getProtocol(), servername }`.
- `tlsInfo(): Promise<TlsInfo | null>`: bağlantının şu anki TLS durumu; açık metinse `null`. Implicit TLS
  (465) bu yolla doğrulanır — ilk bayt yazılmadan önce.
- `close()`: soketi kapatır. Ayrıca `timeoutMs` taşıma katmanında uygulanmalı (`socket.setTimeout`),
  çünkü istemci okuma zaman aşımını taşımaya devrediyor.

**Neden dönüş zorunlu (B9):** eski sözleşmede `startTls(): Promise<void>` idi. Hiçbir şey yapmayan bir
gerçekleme ile parola DÜZ METİNDE gitti ve `send()` başarıyla çözüldü — yani sözleşme, adaptörün
yalanını yakalayamıyordu. Artık sürücü zinciri, protokol sürümünü ve SNI'yı denetliyor; adaptör yazılırken
`servername` **yapılandırılan `host` ile birebir aynı** olmalı, aksi hâlde gönderim kalıcı hata verir.

İsterseniz bu adaptörü ayrı bir düzeltme turunda ben yazarım (ya da adaptör `packages/deploy`/kompozisyon
köküne konur — §5.5'teki satır tavanı kararına bağlı).

### 5.3 Arayüz notları (contracts/ports'a DOKUNULMADI)
1. **`Notification.to` anlamı kanala göre değişiyor**: teams/slack → yapılandırılmış *hedef adı*,
   smtp → e-posta adresi, jira → ticket key. Sürücüler bunu doğruluyor ama sözleşmede yazılı değil;
   `packages/contracts/src/notify.ts` yorumuna tek cümle eklenmesi (davranış değişikliği yok) yararlı olur.
2. **Port adı tutarsızlığı**: bu paket `"notify"` kullanıyor (adapter-jira `"work"`, secrets `"secret"`,
   llm-gateway `"llm"` ile aynı kalıp). `packages/storage` ise `"StoragePort"` kullanıyor — kompozisyon
   kökü karışmadan önce tek kalıba çekilmeli.
3. **Idempotency**: `NotifyPort.send` bir idempotency anahtarı taşımıyor; teslim at-least-once (§2.5).
   Kopya bildirimi kabul etmiyorsak sözleşmeye alan eklenmesi gerekir — tek elden karar sizin.
4. **DST'li ülke**: takvim sabit ofsetli (§2.3); ileride bölge adı gerekirse `BusinessCalendar`'a
   `timeZone` alanı eklenmeli (bu pakette geriye dönük uyumlu olur).

### 5.4 Bu paketin DIŞINDA bulunan kırık — KAPANDI
Önceki tur `@maestro/config#test`'i kırmızı bulmuştu (`llm.blocked_by_route` katalogda yoktu). Bu turda
`pnpm -F @maestro/config exec vitest run` **yeşil** (12 test) ve kökten `pnpm run gate` 38/38 görev yeşil
(önbelleksiz, `--force`). Bayat iddia kaldırıldı.

### 5.5 Karar bekleyen: paket satır tavanı
Üretim kodu 1192 → **1309 satır**. Artışın tamamı bulgu karşılığı güvenlik/doğruluk kodu; hiçbir yeni
özellik eklenmedi ve dosya başına 300 satır tavanı korunuyor (en büyük dosya 231). 1200 satırlık paket
tavanı korunacaksa `smtp-client.ts`/`smtp-protocol.ts` ayrı bir `packages/smtp`'ye çıkarılabilir —
**karar orkestratörün**, kendi başıma bölmedim.

### 5.6 `packages/db` ve `packages/config` neden düzenlendi
Yetki B4/B14 içindi ve dokunuş onunla sınırlı:
- `packages/db/src/params-defaults.ts`: `escalation.ladder` tohumuna `id` + delegasyon (B4), yeni
  `notify.routing` parametresi (B14).
- `packages/db/src/demo/params.ts`: saklanan sürümlere `id` + gerçek delegasyon adımı (B4).
- `packages/db/package.json`: test için `@maestro/notify` workspace devDependency (§5.1).
- `packages/db/test/`: `param-defaults.test.ts` + `seed.test.ts` güncellendi, `notify-params.test.ts` eklendi.
- `packages/config/locales/{tr,en}.json`: `params.description.notify_routing` — yeni parametrenin
  açıklaması M104 gereği katalogda olmak zorunda (`catalog-usage.test.ts` bunu zaten zorluyor).
`packages/contracts` ve `packages/ports`'a **DOKUNULMADI**.

## 6. Varsayımlar
- Teams "Incoming Webhook" (klasik connector veya Power Automate uç noktası) kullanılacak; Graph API/bot
  senaryosu kapsam dışı. Klasik connector başarıda `1` döndürür, Power Automate boş gövdeyle 202 döner —
  **yalnız bu ikisi** başarı sayılıyor; 2xx dönen başka her gövde ret kabul edilip kalıcı hata veriyor
  (B1: kara liste, gerçek ret cümlelerini kaçırıyordu). Beklenmedik ama başarılı bir gövde biçimi çıkarsa
  bu, gürültülü bir hata olarak görünür — sessiz bir kayıp olarak değil.
- SMTP taşıma adaptörü (`SocketFactory`) `TlsInfo` döndürmek zorunda (§5.2); bu paket kendi başına
  `node:tls` kullanmıyor, dolayısıyla sertifika doğrulamasının gerçekten yapıldığı varsayımı **adaptörün
  test edilmesine** bağlı — sürücü yalnız adaptörün bildirdiğini denetleyebilir.
- Kurum SMTP relay'i submission portu (587 STARTTLS veya 465 implicit) sunuyor; DKIM/SPF relay tarafında.
- Eskalasyon merdivenini yürüten zamanlayıcı Temporal'dır: bu paket "şu an hangi adım" sorusunu saf
  fonksiyonla yanıtlar, `next.dueAt` doğrudan timer'a verilebilir; hangi adımların tetiklendiğini
  (`firedStepIds`) çağıran kalıcı tutar (workflow durumu ya da `StepEvent`).
- `runner_health` (M87) ayrı bir kod yolu gerektirmiyor: ops kanalı `NotifyRouting.byEvent.runner_health`
  parametresiyle seçilir; sürücüler olaydan bağımsızdır.

## 7. Doğrulama bulguları — bulgu bazında durum

Hepsi **KAPANDI**. Her satırdaki test önce kırmızıydı (bulguyu üretti), sonra düzeltme yeşile çevirdi.

| # | Bulgu | Ne yapıldı | Kanıt testi |
|---|---|---|---|
| **B1** | Teams/Slack "200 ama başarısız" denetimi kara listeydi → gerçek ret gövdeleri sessizce "gönderildi" sayılıyordu | Beyaz listeye çevrildi: Teams başarı = boş gövde veya `1`; Slack = boş veya `ok`. Diğer her şey `NotifyPermanentError` | `hardening.test.ts` "B1" (10 test; `"Bad payload received by generic incoming webhook."`, `"Summary or Text is required."`, `channel_not_found`, `action_prohibited`) |
| **B2** | SMTP parolası base64 biçimiyle hata mesajına sızıyordu | AUTH adımlarında sunucu yanıt METNİ hataya konmuyor (yalnız kod) **ve** parolanın tel biçimleri maskeleniyor (`b64(pw)`, `b64("\0user\0pw")`, `b64(user)` + dolgusuz varyantları) | `smtp-hardening.test.ts` "B2" (2 test; çıktıdaki her base64 parça çözülüp denetleniyor) + `leak.test.ts` gerçekçi biçime çevrildi |
| **B3** | `close()` hatası gerçek sonucu eziyordu (mükerrer e-posta / kaybolan kalıcı 552) | `finally`'de `close()` yutuluyor; `SmtpSession.close()` da soket kapanış hatasını yutuyor | `smtp-hardening.test.ts` "B3" (2 test) |
| **B4** | M88 merdiveninin iki kaynağı vardı (`DEFAULT_LADDER` + DB) | `DEFAULT_LADDER` KALDIRILDI; tek kaynak `packages/db` tohumu; 7 günlük adıma `action:"delegate"` + `messageKey:"notify.delegated"`; demo tohumu da düzeltildi | `packages/db/test/notify-params.test.ts` (7 test; tohum ve demo sürümleri notify şemasıyla ayrıştırılıyor) |
| **B5** | Delegasyon adımı `notify.escalation` yayıyordu | `action:"delegate"` adımının varsayılan anahtarı `notify.delegated`; DB tohumunda da açıkça yazılı; RAPOR §5.1/§5.4 bayat iddiaları düzeltildi | `escalation-hardening.test.ts` "B5", `escalation.test.ts` |
| **B6** | `to`'ya webhook URL'i yazılırsa hata mesajında sızıyordu | `://` içeren hedef, **fan-out'tan önce** ve değeri yankılamadan reddediliyor | `hardening.test.ts` "B6" |
| **B7** | Prototip anahtarıyla hedef sorgulama (`__proto__` vb.) | `Object.hasOwn` | `hardening.test.ts` "B7" (5 anahtar) |
| **B8** | `ehloName` CRLF ile SMTP komut enjeksiyonu (`host` de korumasızdı) | `SmtpHostName` regex'i (`host` + `ehloName`) **ve** `SmtpSession.command()` her argümanda CR/LF reddediyor | `smtp-hardening.test.ts` "B8" (2 test: config seviyesi + tel seviyesi) |
| **B9** | `SocketFactory` sözleşmesi TLS doğrulamasını zorunlu kılmıyordu | `startTls()` → `TlsInfo`, ayrıca `tlsInfo()`; sürücü zinciri/protokolü/SNI'yı doğruluyor, implicit TLS ilk bayttan önce denetleniyor | `smtp-hardening.test.ts` "B9" (5 test) |
| **B10** | `security:"plaintext"` ilan edilmiş STARTTLS'i denemiyordu | İlan edilmiş STARTTLS her modda alınıyor; `plaintext` yalnız "yokluğu ölümcül değil" demek | `smtp-hardening.test.ts` "B10" (2 test) |
| **B11** | Yer tutucu kontrolü yerine konmuş gövde üzerindeydi | Kontrol ŞABLON üzerinde; regex `t()` ile birleştirildi (`/\{(\w+)\}/`) | `hardening.test.ts` "B11" (2 test) |
| **B12** | Slack `text` kaçışsız, Teams kart metni markdown işliyordu | `text` de `escapeMrkdwn`'den geçiyor; Teams kart metninde `[ ] ( ) \` etkisizleştiriliyor (`summary` dahil) | `hardening.test.ts` "B12" (2 test) |
| **B13** | Adım kimliği içerikten türetiliyordu → eşik düzenlemesi her açık kapıyı yeniden eskale ediyordu | `EscalationStep.id` zorunlu; `resolveSteps` çakışan id'yi reddediyor; DB tohumunda ve demo geçmişinde id'ler var | `escalation-hardening.test.ts` "B13" (3 test) |
| **B14** | `NotifyRouting.byEvent` serbest string + DB'de karşılığı yok → M87 gerçekte bağlı değildi | Şema `z.partialRecord(NotifyEventKey, …)`; `notify.routing` DB parametresi + katalog açıklaması eklendi | `escalation-hardening.test.ts` "B14" (3 test) + `packages/db/test/notify-params.test.ts` |
| **B15** | `planEscalation` donuk sözleşmeyi doğrulamadan `Notification` üretiyordu | Planlayıcıda `Notification.parse`; `openedAt`/`now` `IsoDateTime` ile doğrulanıyor | `escalation-hardening.test.ts` "B15" (4 test) |
| **B16** | `Number()` ile yanıt kodu ayrıştırma (`"2500 weird"` → 250) | `/^\d{3}$/` + 4. karakter `" "`/`"-"` + aralık kontrolü | `hardening.test.ts` "B16" (6 test) |
| **B17** | `attempts` iki farklı anlam taşıyordu, hatalar iki kez sarmalanıyordu | `NotifyFanoutError`: `attempts` = toplam deneme, `failures[]` = hedef başına `{target, attempts, cause}`; iç hata yeniden sarmalanmıyor | `hardening.test.ts` "B17/B18" |
| **B18** | `to` tekrarları ayıklanmıyordu (3× POST) | `sendToEachTarget` hedefleri `Set` ile ayıklıyor | `hardening.test.ts` "B17/B18" |
| **B19** | `fromName` CR/LF kontrolü tesadüfen güvenliydi | `buildMimeMessage` açıkça `assertHeaderSafe("From (display name)", …)` çağırıyor | `hardening.test.ts` "B19" |

### Test kalitesi bulguları
- `leak.test.ts` gerçekçi olmayan sızıntı biçimi kullanıyordu → sunucu artık **base64 SASL belirtecini** yankılıyor, ham parolayı değil.
- `escalation.test.ts` "DB değeri aynen ayrışıyor" iddiası `not.toThrow()` ile kanıtlanmıyordu → tam alan karşılaştırması (`id`, `afterHours`, `channel`, `action`, `messageKey`, `businessHoursOnly`, artı "şema `action` dışında hiçbir alan uydurmuyor").
- `escalation.test.ts` yalnız araya-ekleme sınıyordu → artık eklemeden sonra **tüm** kimlik listesi karşılaştırılıyor; B13'ün düzenleme senaryosu ayrı test.
- `smtp.test.ts` STARTTLS ilan ETMEYEN relay kullandığı için B10'u sınamıyordu → o testin sınırı yoruma yazıldı ve ilan EDEN relay için ayrı testler eklendi.
