# Jira Webhook Kurulumu — "Ticket açılsın, analiz kendiliğinden başlasın"

*İmza sırrı · webhook kaydı · dışarıdan erişim · doğrulama*

| Kapsam | Hedef |
|---|---|
| Jira Cloud (`*.atlassian.net`) ve Jira Data Center | Bağlı projede bir ticket açıldığında Maestro'nun analizi **elle başlatmadan** koşması |

> **Kime:** Jira site admin + Maestro'yu işleten platform ekibi.
> **Ön koşul:** Maestro çalışıyor, Jira bağlantısı (`JIRA_CLOUD_BASE_URL` ya da
> DC'de `JIRA_BASE_URL`, bot kimliği, jeton) yapılandırılmış ve `/settings`
> ekranında "Jira ● yapılandırıldı" görünüyor.

Bugün ticket'lar `POST /studio/runs/:ticket/start` ile **elle** başlatılıyor. Bu
belge o adımı ortadan kaldırır. Üç iş var ve **üçü de yapılmadan akış otomatik
başlamaz**:

1. Platformda **imza sırrını** tanımlamak (§1)
2. Jira'da **webhook'u kaydetmek** (§2; Data Center için §5)
3. Webhook ucunu Jira'nın **erişebileceği** bir adrese açmak (§3)

Sonra §4 ile test edilir.

**Kanonik webhook adresi** (bu belgede baştan sona tek adres kullanılır):

```
https://<host>/webhooks/jira
```

`<host>`, Maestro panelinin dışarıdan göründüğü alan adıdır (bu kurulumda
`coder.uguryildiz.tech`). `https://<host>/api/webhooks/jira` yolu da çalışır —
nginx `/api/` önekini soyup BFF köküne geçirir — ama kanonik olan **öneksiz**
yoldur: Jira kaydı, BFF logu ve bu belge aynı tek yolu (`/webhooks/jira`)
göstersin; önek soymaya dayanmayan yol, öndeki proxy değişse de anlamını korur.

---

## 0. Neden imza? — atlanamaz

`POST /webhooks/jira` ucu **fail-closed**'dır: gövde ayrıştırılmadan **önce**
imza doğrulanır. Doğrulanamayan teslimat `401` alır ve **hiçbir koşu
başlatmaz**. Bu, uca kimin POST edebileceğini bilmediğimiz için böyledir —
internete açık bir uç, imzasız kabul ederse herkes istediği ticket için koşu
başlatabilir.

> [!WARNING]
> **Sır tanımlanmazsa uç REDDEDER, sessizce geçmez.** Sürücü bu durumu
> `missing_secret` diye adlandırır. Yani "sırrı sonra tanımlarım, şimdilik
> çalışsın" diye bir mod **yoktur** — §1 atlanırsa §2'deki webhook kurulsa bile
> her teslimat 401 alır.

**İmza şeması** (Atlassian'ın kendi dokümanı,
[developer.atlassian.com/cloud/jira/platform/webhooks](https://developer.atlassian.com/cloud/jira/platform/webhooks)
→ *"Validating webhook deliveries"*):

- Jira, ham gövdenin **HMAC-SHA256**'sını kayıt sırasında verdiğin `secret` ile hesaplar
- Sonucu `X-Hub-Signature: sha256=<hex>` başlığında gönderir
- Gövde **UTF-8** olarak işlenir

Data Center ile **aynı** şemadır; bu yüzden Maestro'da tek bir doğrulayıcı iki
sürücüye birden hizmet eder (`packages/adapter-jira/src/webhook.ts`).

---

## 1. Platformda imza sırrını tanımla

### 1.1 Sır üret

Tahmin edilemez, uzun bir dize üret. **Bunu bir yere kaydet** — Jira'ya da aynısı
girilecek ve Jira kaydettikten sonra sırrı bir daha göstermez.

```bash
openssl rand -hex 32
# örnek çıktı: 4f8c1e...  (64 karakter)
```

### 1.2 Ortama yaz

Maestro sırları **referansla** okur: yapılandırmada sırrın *değeri* değil,
*adresi* durur. Varsayılan adres `kv/jira#webhook`'tur ve env-dosyası sürücüsü
bunu şu değişkene çevirir — compose kurulumunda `.env` dosyasına yazılır:

```bash
MAESTRO_SECRET_KV_JIRA__WEBHOOK="<1.1'de ürettiğin dize>"
```

| Değişken | Ne işe yarar | Varsayılan |
|---|---|---|
| `MAESTRO_SECRET_KV_JIRA__WEBHOOK` | İmza sırrının **değeri** | yok — **sen yazacaksın** |
| `JIRA_WEBHOOK_SECRET_REF` | Sırrın **adresi** | `kv/jira#webhook` — dokunma |

Vault kullanan bir kurulumda `MAESTRO_SECRET_KV_JIRA__WEBHOOK` yerine aynı sır
`kv` mount'unun `jira` yolundaki `webhook` alanına yazılır; `JIRA_WEBHOOK_SECRET_REF`
değişmez. Sırrın adını böyle yazmanın amacı tam olarak budur.

### 1.3 BFF'i yeniden başlat

Sır süreç başlarken okunur. Compose kurulumunda:

```bash
docker compose up -d --force-recreate bff
```

> [!CAUTION]
> Canlı sistemde BFF'i yeniden başlatmak açık oturumları düşürür. Kullanıcılara
> önce haber ver.

---

## 2. Jira Cloud'da webhook'u kaydet

*(Data Center kullanıyorsan §5'e geç; alanlar aynıdır, ekran yolu farklıdır.)*

### 2.1 Ekrandan (önerilen)

**Ayarlar → Sistem → WebHooks** (`https://<site>.atlassian.net/plugins/servlet/webhooks`)
→ **Create a WebHook**.

| Alan | Değer |
|---|---|
| **Name** | `Maestro` |
| **Status** | Enabled |
| **URL** | `https://<host>/webhooks/jira` |
| **Secret** | §1.1'de ürettiğin dize — **birebir aynısı** |
| **Issue related events (JQL)** | `project = OPS` |
| **Issue** | ☑ **created**, ☑ **updated** |
| **Comment** | ☑ **created** |
| Diğer her şey | boş bırak |

**Neden bu üç olay:**

| Olay | Ne sağlar |
|---|---|
| `jira:issue_created` | **Ticket açılınca analiz başlar** — bu belgenin asıl amacı |
| `jira:issue_updated` | Ticket sonradan bota atanınca / durumu değişince akış başlar |
| `comment_created` | Kapı onayları (`/approve`) yorumdan gelir |

**JQL filtresi** (`project = OPS`) Jira'nın gönderdiği trafiği daraltır. Zorunlu
değildir — Maestro bağlanmamış bir projenin ticket'ını zaten sessizce düşürür —
ama gereksiz trafiği kaynağında kesmek doğrusudur.

> [!NOTE]
> `Exclude body` kutusunu **işaretleme**. Gövde olmadan hangi ticket olduğu
> anlaşılmaz.

### 2.2 REST ile (alternatif)

```bash
curl -u "$MAESTRO_BOT_EMAIL:$JIRA_API_TOKEN" \
  -X POST "$JIRA_CLOUD_BASE_URL/rest/webhooks/1.0/webhook" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Maestro",
    "url": "https://<host>/webhooks/jira",
    "events": ["jira:issue_created", "jira:issue_updated", "comment_created"],
    "filters": { "issue-related-events-section": "project = OPS" },
    "excludeBody": false,
    "secret": "<1.1'"'"'de ürettiğin dize>"
  }'
```

Cevapta **`"isSigned": true`** görmelisin. Görmüyorsan sır kaydedilmemiştir ve
her teslimat 401 alacaktır.

### 2.3 Kaydı doğrula

```bash
curl -s -u "$MAESTRO_BOT_EMAIL:$JIRA_API_TOKEN" \
  "$JIRA_CLOUD_BASE_URL/rest/api/3/webhook" | head
```

Kayıt öncesi bu uç **0 kayıt** döner. Sonrasında webhook'unu görmelisin.

---

## 3. Webhook ucuna dışarıdan erişim

### 3.1 Docker (compose) kurulumu — önerilen

Compose yığınında dışarıya açılan **tek** port studio'dur (nginx, varsayılan
`STUDIO_PORT=7000`). BFF (`bff:7001`) yalnızca compose ağındadır ve dışarıdan
görünmez — `BFF_HOST` / `BFF_PORT` ayarlamak gerekmez ve gerekmediği gibi
**yapılmamalıdır** (README: "`.env`'de `BFF_PORT` varsa silin").

Webhook'u BFF'e ulaştıran şey studio nginx'indeki geçittir
(`deploy/*/studio-nginx.conf`):

```nginx
location /webhooks/ {
    proxy_pass http://bff:7001/webhooks/;   # önek SOYULMAZ
    ...
}
```

Bu blok olmadan `POST /webhooks/jira` SPA fallback'ine düşer ve Jira'ya
`index.html` döner — webhook "çalışıyor gibi görünüp" hiçbir koşu başlatmaz.
Blok pakette hazırdır; ekstra bir şey yapman gerekmez.

**TLS:** Jira Cloud yalnız `https` adres kabul eder. Studio portunun önünde TLS
sonlandıran bir proxy olmalı — bu kurulumda **NPM (Nginx Proxy Manager)**:
`https://<host>` → `127.0.0.1:7000` (STUDIO_PORT). Webhook için **ayrı bir
proxy yolu tanımlamak gerekmez**; panelin geçtiği aynı host yeter, `/webhooks/`
yolunu içerideki nginx ayırır.

> [!IMPORTANT]
> Aradaki **hiçbir** katman gövdeyi değiştirmemeli. İmza **ham baytlar**
> üzerindedir; JSON'u yeniden biçimlendiren, sıkıştırmayı değiştiren ya da
> gövdeye dokunan bir kural imzayı bozar ve her teslimat 401 alır. NPM'in ve
> nginx `proxy_pass`'ın varsayılanı gövdeye dokunmaz — "beautify"/"rewrite"
> kuralı ekleme.

### 3.2 Geliştirme ortamı — çıplak süreç (compose'suz)

*Bu bölüm yalnız BFF'i doğrudan koşturan geliştirme kurulumları içindir; compose
kullanıyorsan §3.1 yeter, buradaki hiçbir değişkene dokunma.*

Çıplak süreçte BFF varsayılan olarak **`127.0.0.1:7001`**'e bağlanır
(`apps/deploy/src/env.ts` — varsayılan port **7001**'dir). Loopback'e
internetten ulaşılamaz.

> Loopback varsayılanı **bilerek** böyledir: bir değişken unutulduğu için
> `0.0.0.0`'a bağlanan servis, ağa **ihmalle** açılmış olur. Açmak, birinin
> yazdığı bir karar olmalıdır.

```bash
export BFF_HOST=0.0.0.0     # bilinçli karar — yukarıyı oku
# BFF_PORT'un varsayılanı 7001; değiştirmek gerekmiyorsa hiç yazma.
```

Sonra BFF'i yeniden başlat ve doğrula:

```bash
ss -ltn | grep 7001     # 0.0.0.0:7001 görmelisin, 127.0.0.1:7001 değil
```

Öndeki TLS proxy'si bu durumda `/webhooks/jira` yolunu `127.0.0.1:7001`'e
geçirmelidir (compose'daki nginx geçidi burada yoktur). Gövdeye dokunmama
kuralı (§3.1'deki IMPORTANT) burada da aynen geçerlidir.

---

## 4. Test

### 4.1 Uç ayakta mı

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://<host>/webhooks/jira \
  -H 'Content-Type: application/json' -d '{}'
```

**Beklenen: `401`.** Bu bir başarıdır — uca ulaşıldı ve imzasız teslimat
reddedildi. `502`/`504` alıyorsan §3; `404` ya da `200` ile HTML (index.html)
alıyorsan istek BFF'e değil SPA'ya gidiyor — studio-nginx.conf'ta `/webhooks/`
geçidi olan sürümü kullandığından emin ol (§3.1).

### 4.2 İmzalı teslimat kabul ediliyor mu

```bash
SECRET='<§1.1 dizesi>'
BODY='{"webhookEvent":"jira:issue_created","issue":{"key":"OPS-99","fields":{"labels":[]}}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/.* //')"

curl -s -X POST https://<host>/webhooks/jira \
  -H 'Content-Type: application/json' -H "X-Hub-Signature: $SIG" -d "$BODY"
```

**Beklenen: `202`** ve bir JSON cevabı. `401` alıyorsan sır Jira'daki ile aynı
değildir, ya da BFF sırrı okumadan başlatılmıştır (§1.3).

> `printf` kullanılıyor çünkü `echo` sona bir satır sonu ekler ve imza **ham
> baytlara** aittir — tek fazladan bayt imzayı bozar. Bu bir kurulum hatası
> değil, şemanın kendisidir.

### 4.3 Gerçek test — asıl doğrulama

Jira'da OPS projesinde **"Görev"** tipinde bir ticket aç ve **Maestro botuna
ata**. Elle hiçbir şey başlatma.

Beklenen:

1. Studio panosunda ticket birkaç saniye içinde **kendiliğinden** belirir
2. Akış ilerler: intake → repo keşfi → analiz → **kapı 4**
3. Kapıda Jira ticket'ına yorum olarak `/approve` yaz → akış devam eder

Olmuyorsa sırasıyla bak:

| Belirti | Nerede |
|---|---|
| Jira'da webhook "Failed" gösteriyor | §3 — erişim yok |
| BFF logunda 401 | §1 / §2 — sır uyuşmuyor |
| 202 ama `"accepted": false, "reason": "unbound"` | OPS projesi bağlanmamış — `jira-baglama.md` |
| 202 ama koşu başlamıyor | Dinleme kuralı eşleşmiyor — Studio → Dinleme Kuralları |

### 4.4 Dinleme kuralı

Hangi ticket'ın **hangi akışı** koşacağına Studio'daki dinleme kuralları karar
verir. Canlıda çalışan kural:

> **OPS** projesi + issue tipi **"Görev"** + **bota atanmış** → analiz akışı

Webhook bu kuralı **değiştirmez**; sadece kuralın değerlendirileceği anı ticket
açılışına taşır. Ticket'ın durumu, tipi ve atanan kişisi teslimatın gövdesinden
okunur.

---

## 5. Jira Data Center

DC'de imza şeması **Cloud ile aynıdır** (§0): `X-Hub-Signature`, ham gövde
üzerinde HMAC-SHA256. Sır da aynı yerden okunur —
`MAESTRO_SECRET_KV_JIRA__WEBHOOK` (§1). Değişen yalnızca kayıt ekranı ve
erişimin yönüdür.

**Kayıt:** **Yönetim (⚙) → Sistem → WebHooks**
(`https://<jira-dc-host>/plugins/servlet/webhooks`) → **Create a WebHook**.
Alanlar §2.1'deki tabloyla aynıdır: URL `https://<host>/webhooks/jira`, Secret
§1.1'deki dize, olaylar issue **created/updated** + comment **created**, JQL
`project = OPS`. REST alternatifi de aynı gövdeyle `POST
<jira-dc>/rest/webhooks/1.0/webhook`'tur (kimlik doğrulama `Bearer <PAT>`).

**Erişim:** DC çoğu zaman kurum ağının içindedir; Maestro'ya internet üzerinden
değil, iç ağdan ulaşır. §3.1'deki nginx geçidi aynen geçerlidir — DC'nin
erişeceği adres yine studio portunun önündeki `https://<host>`'tur. Kurum içi
CA ile imzalı sertifika kullanılıyorsa DC'nin o CA'ya güvendiğinden emin ol;
güvenmiyorsa teslimatlar TLS aşamasında düşer ve webhook ekranında "Failed"
görünür.

> [!NOTE]
> **DC sürücüsünde belge eki ve pano taşıma henüz yok.** Analizin Word/PDF'i
> ticket'a **eklenmez** ve ticket panoda **taşınmaz** — analiz **yorum olarak
> teslim edilir**; belgeler yine üretilir, Maestro tarafında saklanır ve
> günlük "ticket'a konmadı / taşıma atlandı" diye kaydeder
> (`apps/deploy/src/bin/worker.ts`, `docAttacher`/`statusMover` DC'de
> tanımsız kalır). Bu bir kurulum hatası değil, sürücünün bugünkü yetenek
> sınırıdır — webhook kurulumun doğru olsa da DC'de eki ticket'ta arama.

---

## 6. Aynı teslimat iki kez gelirse

Jira başarısız saydığı bir teslimatı **yeniden gönderir**. Bu güvenlidir: intake
yolu ticket başına tek koşu açar (`signalWithStart`, koşu kimliği ticket'tan
türetilir). İkinci teslimat var olan koşuya katılır, **yeni koşu açmaz** —
cevaptaki `"started": false` bunu söyler. Yarışı çözen motorun kendisidir, BFF
değil.

---

## 7. Özet — kontrol listesi

- [ ] `MAESTRO_SECRET_KV_JIRA__WEBHOOK` tanımlı, BFF yeniden başlatıldı
- [ ] Jira'da webhook kayıtlı, `isSigned: true`, aynı sır girilmiş
- [ ] URL kanonik yol: `https://<host>/webhooks/jira`
- [ ] Olaylar: issue created + updated, comment created
- [ ] Compose: studio portu TLS'li olarak dışarı açık, nginx `/webhooks/` geçidi olan conf kullanılıyor (§3.1) — `BFF_HOST`/`BFF_PORT` YOK
- [ ] (Yalnız çıplak-süreç geliştirme: `BFF_HOST=0.0.0.0`, `ss -ltn` 7001'i doğruluyor — §3.2)
- [ ] §4.1 `401` veriyor, §4.2 `202` veriyor
- [ ] §4.3 gerçek ticket ile uçtan uca geçti
- [ ] (DC ise: analiz yorum olarak gelir; ek/pano taşıma beklenmez — §5)
