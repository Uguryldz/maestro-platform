# Maestro — Banka İçi (İnternetsiz) Kurulum

**Paket sürümü: 2026-08-27**
*(Bu tarih `.env.example` içindeki `BUNDLE_VERSION` ve `install.sh` başlığıyla
aynı olmalıdır. Üçü tutmuyorsa elinizdeki paket karışıktır — kurmayın.)*

Bu paket, Maestro'yu **internete çıkmayan** bir sunucuya kurmak içindir.
Kurulumu yapan kişinin bilmesi gereken her şey bu dosyadadır; sırayla okuyun.

---

## Maestro ne yapar?

Kısaca: **Jira'ya düşen bir talebi alır, analiz dokümanı üretir, onaya sunar.**

1. Bir kullanıcı Jira'da talep açar ve onu Maestro bot hesabına **atar**.
2. Maestro talebi görür (webhook ya da yoklama ile), sınıflandırır.
3. Kurum içi yapay zekâ uç noktasını kullanarak analiz dokümanı yazar.
4. Dokümanı Jira'ya iliştirir ve bir **insan onayına** sunar.

Bu hat her kurulumda uçtan uca çalışır. Kod yazma / PR açma / birleştirme
hattı da **kuruludur**: hangi talebin hangi akışla (yalnızca analiz, hata
düzeltme, yeni özellik) koşacağı panelden, ticket başına seçilir — sunucu
yapılandırmasıyla değil.

Kod yazan akışlar bir **kod deposu bağlantısı** ister. Bağlantı tanımlı
değilse kurulum sihirbazı o akışları **gerekçesiyle birlikte, daha ilk adımda**
kapatır; onaylanmış bir analizden sonra ölen koşu diye bir şey yoktur.

---

## 0. Önce şunu bilin: imajlar DIŞARIDA hazırlanır

İnternetsiz sunucuda **build yapılmaz** (`pnpm install` ve `apt-get` internet
ister). Akış şudur:

```
[İnternetli makine]                    [Banka sunucusu]
  build → docker save → .tar   ──USB/SFTP──→   docker load → docker compose up
```

Ya da bankanın kendi registry'si (Nexus/Harbor) varsa: dışarıda build → push →
sunucuda pull.

---

## 1. Ön koşullar (banka sunucusu)

| Gereklilik | Değer |
|---|---|
| Docker Engine + Compose v2 | `docker compose version` çalışmalı |
| CPU / RAM | 4 CPU / 16 GB önerilir (asgari 2 CPU / 8 GB) |
| Disk | imajlar ~3 GB + veritabanı büyümesi |
| Açık port | yalnızca panel portu (varsayılan 7000) |

**Sunucudan erişilebilmesi gerekenler:**

- **Jira** (Data Center ya da Cloud) — talepleri okur, yorum yazar
- **Kurum içi LLM uç noktası** — analizi bu üretir
- **LDAP/AD** — yalnızca LDAP ile giriş kullanacaksanız
- **Kod deposu (GitHub / GitHub Enterprise)** — yalnızca kod yazan akışlar için;
  bağlantı panelden tanımlanır

> Maestro dışarıya **çıkmaz**. `install.sh` de internete bağlanmaz: imaj
> indirmez, sürüm sorgulamaz, telemetri göndermez.

---

## 2. Dışarıda imaj hazırlama (internetli makinede)

### 2.1 Kaynağı al ve sürümü sabitle

```bash
git clone <maestro-repo> maestro && cd maestro
git checkout <sürüm-etiketi>
export TAG=$(git rev-parse --short HEAD)   # imaj etiketi olacak, not edin
```

### 2.2 İki imajı build et

`node` imajı tek tanedir; **BFF, worker ve migration** rolleri aynı imajdan
`MAESTRO_ENTRYPOINT` env'i ile ayrılır. Bu yüzden üç değil **iki** imaj taşınır.

```bash
docker build -f deploy/docker/Dockerfile.node   -t maestro/node:$TAG   .
docker build -f deploy/docker/Dockerfile.studio -t maestro/studio:$TAG .
```

### 2.3 Build'i DOĞRULA (bu adımı atlamayın)

Geçmişte imaj sessizce bozuk çıktı ve arıza haftalar sonra fark edildi.

```bash
# a) OpenSSL gerçekten kurulu mu (Prisma query engine için şart)
docker run --rm --entrypoint sh maestro/node:$TAG -c "openssl version"
#    Beklenen: OpenSSL 3.x ...

# b) Migration klasörlerinin TAMAMI imajda mı
docker run --rm --entrypoint sh maestro/node:$TAG \
  -c "ls /app/packages/db/prisma/migrations | grep -c '^[0-9]'"
#    Beklenen: 22  (son migration 0021'dir; iki klasör 0011 önekini paylaşır)

# c) Prisma istemcisi üretilmiş mi  ← EN KRİTİK KONTROL
#    (pnpm istemciyi .pnpm deposunun içine koyar; yol sürüme göre değişir,
#     bu yüzden sabit yol yerine arama yapılır)
docker run --rm --entrypoint sh maestro/node:$TAG \
  -c "find /app -path '*/.prisma/client/index.js' -print -quit"
#    Boş çıkarsa imaj KULLANILMAZ. Bayat bir Prisma istemcisi yeni sütunları
#    YOK SAYAR: kod hatasız çalışır, veriyi yazdığını sanır, değer veritabanına
#    hiç ulaşmaz. Sessiz veri kaybıdır.

# d) Studio bundle'ı üretilmiş mi
docker run --rm --entrypoint sh maestro/studio:$TAG \
  -c "ls /usr/share/nginx/html/index.html && echo VAR"

# e) İmajın içinde GERÇEK kimlik bilgisi kalmış mı  ← GÜVENLİK KONTROLÜ
docker run --rm --entrypoint sh maestro/node:$TAG \
  -c "find /app -name '.env' -not -name '*.example'"
#    Beklenen: HİÇBİR ÇIKTI OLMAMASI.
#    Bir yol yazdırıyorsa imajı BANKAYA GÖTÜRMEYİN ve etiketi silin: içinde
#    geliştiricinin gerçek parolaları ve jetonları vardır. Bir kez tam olarak
#    bu oldu — `/app/deploy/.env`, 18 KB, doldurulmuş hâliyle. Sebebi
#    `.dockerignore`'daki `.env` kalıbının eğik çizgi içermemesiydi: böyle bir
#    kalıp yalnızca BAĞLAM KÖKÜNDE eşleşir, `deploy/.env` hiç dışlanmamıştı.
#    Kalıp `**/.env` olarak düzeltildi; bu kontrol, düzeltmenin GEÇERLİ OLDUĞU
#    bir koddan build ettiğinizi doğrular. İmajın içi, build eden makinenin
#    diskiyle aynı şey değildir — tek görme yolu budur.
```

### 2.4 Yan imajları topla ve paketle

```bash
docker pull postgres:17-alpine
docker pull redis:7-alpine
docker pull temporalio/auto-setup:1.25.2

docker save maestro/node:$TAG maestro/studio:$TAG \
  postgres:17-alpine redis:7-alpine temporalio/auto-setup:1.25.2 \
  | gzip > maestro-imajlar-$TAG.tar.gz

sha256sum maestro-imajlar-$TAG.tar.gz > maestro-imajlar-$TAG.sha256
```

Taşınacaklar: `maestro-imajlar-$TAG.tar.gz`, `.sha256` ve bu `banka/` klasörü.

---

## 3. Banka sunucusunda kurulum

### 3.1 İmajları yükle

```bash
sha256sum -c maestro-imajlar-<TAG>.sha256     # bütünlük kontrolü
gunzip -c maestro-imajlar-<TAG>.tar.gz | docker load
docker images | grep maestro                  # iki imaj görünmeli
```

### 3.2 Yapılandır

```bash
cd banka
cp .env.example .env
chmod 600 .env
```

`.env`'i açın ve **`DEGISTIR`** yazan her satırı doldurun. `install.sh` dosyada
`DEGISTIR` kalırsa çalışmayı reddeder.

**Doldurulacak alan sayısı dörttür** ve dördü de altyapıya aittir — Jira jetonu,
GitHub jetonu ve model anahtarı bu dosyada **artık yoktur.** Onlar kurulumdan
sonra panelden girilir (§4). Bu dosya "sisteme nasıl ulaşılır" sorusunu
cevaplar; "hangi hesapla bağlanılır" sorusunu panel cevaplar.

| Alan | Ne için |
|---|---|
| `CONNECTOR_MASTER_KEY` | Panelden girilecek bütün jetonları şifreler. `openssl rand -base64 32` |
| `POSTGRES_PASSWORD` | Veritabanı parolası. `openssl rand -hex 24` |
| `REDIS_PASSWORD` | Kuyruk parolası. `openssl rand -hex 16` |
| `MAESTRO_SECRET_KV_JIRA__WEBHOOK` | Jira webhook imza sırrı. `openssl rand -hex 32` |

Son satır neden panelde değil de burada: bu sır, **dışarıdan gelen ve henüz
doğrulanmamış** bir isteği doğrulamak için okunur. Diğer jetonlar sistemin kendi
başlattığı dış çağrılarda kullanılır; bu ise yabancının başlattığı bir istekte.
Veritabanından okunsaydı, imza kontrolünün önüne bir sorgu koyulmuş olurdu.

Bir de bir görüntü ayarı vardır (`MAESTRO_NODE_IMAGE` / `MAESTRO_STUDIO_IMAGE`):
yüklediğiniz imajların adlarını yazın.

> **Aynı sunucuya ikinci bir kurulum mu yapıyorsunuz?** (kabul ortamı, sürüm
> provası) `.env`'de **`COMPOSE_PROJECT_NAME`** ile **`STUDIO_PORT`**'u
> mutlaka farklı verin. İkisi de varsayılan bırakılırsa compose ikinci kurulumu
> yeni bir yığın olarak değil **mevcudun güncellemesi** olarak görür: çalışan
> kurulumun veritabanı volume'üne bağlanır. "Denemek için yan tarafa kurdum"
> sanılan işlem, üretimin üstüne yapılmış olur ve hiçbir uyarı çıkmaz.

Model adresi ve adı da **bu dosyada değildir**: `LLM_BASE_URL` / `LLM_MODEL`
boş gelir ve boş kalabilir. Model kurulumdan sonra panelden tanımlanır
(Ayarlar & bağlantılar → "Kurum içi model sunucusu"); "Test et" sunucunun o
modeli gerçekten sunduğunu doğrular. Yalnız `.env` üzerinden doldurmayı
seçerseniz iki tuzağı bilin:

| Alan | Neden önemli |
|---|---|
| `LLM_BASE_URL` | Sonuna `/v1` **yazmayın** — sürücü kendisi ekler. |
| `LLM_ON_PREM` | `false` kalırsa `gizli` işlerin analizi eksik biter. |

`MAESTRO_BOT_ACCOUNT_ID` **boş bırakılabilir.** Panelde bağlantıyı test
ettiğinizde sistem jetonun gerçek sahibini kendisi öğrenir ve yazar; yanlış
yazılmış bir değeri de düzeltir. Doldurursanız yalnızca bir karşılaştırma
dayanağı olur.

`MAESTRO_SECRET_*` değişkenlerinin **adlarını değiştirmeyin**. Bu adlar sır
adresinden türetilir (`kv/jira#token` → `MAESTRO_SECRET_KV_JIRA__TOKEN`, `#`
çift alt çizgi olur). Bir harf şaşarsa sistem "sır bulunamadı" der, siz `.env`'de
değeri dolu görürsünüz ve aradaki farkı anlamanın yolu olmaz.

### 3.3 Kur

```bash
./install.sh          # ön kontrolleri yapar, sırayla başlatır, sağlığı bekler
./install.sh --yes    # otomasyon için (soru sormaz)
```

`install.sh` **önce doğrular, sonra çalıştırır.** Şunlardan biri eksikse hiçbir
konteyner başlatmadan durur:

- `.env` yok, ya da içinde `DEGISTIR` kalmış
- Zorunlu değişkenlerden biri boş
- `NODE_ENV=production` ama Vault/S3 değişkenleri boş
- `CONNECTOR_MASTER_KEY` 32 bayt değil
- `.env`'de eski biçimli sır adı (`MAESTRO_SECRET_JIRA_TOKEN`) ya da eski
  referans biçimi (`env:JIRA_TOKEN`) var
- Bir imaj `docker load` ile yüklenmemiş
- İmajda migration eksik ya da **Prisma istemcisi üretilmemiş**
- `LLM_BASE_URL` sonunda `/v1` var
- Kurumsal CA dosyası `.env`'de yazılı ama diskte yok
- **Ortam, uygulamanın kendi açılış şemasından geçemiyor** — bkz. aşağıdaki not

Son maddedeki kontrol, listedeki diğerlerinden farklı bir işi yapar ve bu fark
önemlidir. Yukarıdakilerin her biri belirli bir değişkeni ADIYLA kontrol eder;
böyle bir liste ise ancak yazıldığı günkü kadar günceldir. Nitekim bir kez tam
olarak bu oldu: betik 24 değişkeni doğruladı, hepsi yeşil geçti ve `migrate`
konteyneri açılışta dört satırlık bir şema hatasıyla öldü — çünkü hata, listede
adı hiç geçmeyen değişkenlerdeydi.

Bu yüzden `install.sh` artık yığını başlatmadan önce, `bff` servisinin ortamını
compose'un kurduğu **hâliyle** ayağa kaldırıp uygulamanın açılışta çalıştırdığı
doğrulamanın **aynısını** çalıştırır. Elle tutulan bir değişken listesi yoktur;
doğrulayan şey şemanın kendisidir, dolayısıyla bayatlayamaz. Burada geçen bir
`.env` ile sistem açılır.

> **`.env`'de boş bırakmak = satırı hiç yazmamak.** Compose, isteğe bağlı
> değişkenleri `${DEGISKEN:-}` biçiminde iletir; `.env`'de olmayan bir değişken
> konteynere **boş dize** olarak girer ve uygulama bunu "ayarlanmamış" diye
> okur. Kullanmadığınız isteğe bağlı satırları yorumda bırakın — ama bir adrese
> değer yazacaksanız geçerli bir URL yazın (`https://…`), çünkü dolu bir alan
> artık şemaya göre denetlenir.

---

## 4. Kurulum sonrası doğrulama

```bash
docker compose ps                    # hepsi healthy/running olmalı
docker compose logs migrate          # "migrations applied" görmelisiniz
docker compose exec bff node -e "fetch('http://127.0.0.1:7001/readyz').then(r=>console.log(r.status))"
```

**Panel:** `http://<SUNUCU_IP>:7000`
**İlk giriş:** `admin` + kurulum sırasında migrate adımının **bir kez** bastığı
`GEÇİCİ PAROLA` (install.sh çıktısındaki `GEÇİCİ PAROLA` satırı). İlk oturumda
sistem yeni bir parola belirlemenizi **zorunlu** tutar. Parolayı not etmediyseniz:
`./reset-admin.sh admin` yenisini üretir.

---

## 5. ⚠ KURULUMDAN SONRA MUTLAKA YAPIN

Bu beş maddeyi yapmadan sistem **çalışıyor görünür ama güvenli ya da işlevsel
değildir.** Sırayla uygulayın.

### 5.1 `admin` hesabıyla girin, kalıcı parolanızı belirleyin

Kurulum, ilk girişi mümkün kılmak için `admin` hesabını **rastgele üretilmiş
geçici bir parolayla** ekler ve bu parolayı **yalnızca bir kez**, migrate
adımının çıktısında basar (`GEÇİCİ PAROLA` satırı). Sabit bir kurulum parolası
**yoktur** — hiçbir paketin kaynağında yazılı değildir.

Panele `admin` + geçici parola ile girin; sistem kendi parolanızı belirlemenizi
**zorunlu** tutar. Değiştirene kadar bu hesap yalnızca üç uca erişir, ama yine
de **kurulumun ilk işi** budur.

**Geçici parolayı not etmediyseniz ya da parola unutulduysa** — sunucuda, bu
klasörde:

```bash
./reset-admin.sh              # admin hesabını sıfırlar
./reset-admin.sh ayse.kaya    # başka bir hesabı sıfırlar
```

Betik, uygulama imajının içinde yeni bir rastgele parola üretir, bcrypt'leyip
veritabanına yazar, parolayı ekrana **bir kez** basar, hesabın açık oturumlarını
kapatır ve ilk girişte değişimi yine zorunlu kılar. Parola hiçbir yere
kaydedilmez; not almadıysanız betiği yeniden çalıştırın (her çalıştırma yeni
parola üretir). `psql` ile elle hash yazmak artık gerekmez ve önerilmez.

### 5.2 Bot hesabı `maestro-admins` grubunda OLMASIN

Maestro'da korumalı parametreleri değiştirmek **dört-göz kuralına** tabidir:
öneren ve onaylayan **farklı** kişiler olmalıdır.

Bot hesabı da `maestro-admins` grubundaysa bu kural **tek başına sağlanabilir**
hâle gelir: bot önerir, bot onaylar. Kural teknik olarak çalışır, denetim
kaydı düzgün görünür, ama ikinci göz diye bir şey kalmaz.

AD tarafında kontrol edin — bot hesabı `maestro-admins` içinde **olmamalıdır**.
LDAP kullanmıyorsanız, panelde bot için ayrı bir hesap açmayın; bot Jira
tarafında bir kimliktir, Maestro'da bir yönetici hesabı değildir.

### 5.3 Jira webhook'unu kaydedin

Webhook olmadan Maestro talepleri **anında** görmez. Kayıt adımları ve imza
sırrının nasıl üretileceği ayrı belgede:

**→ [`docs/jira-webhook-kurulum.md`](../../docs/jira-webhook-kurulum.md)**

Webhook adresi panelin kendisiyle **aynı host**'tur:
`https://<host>/webhooks/jira`. İstek, dışarı açılan tek port olan studio'dan
girer ve `studio-nginx.conf`'taki `/webhooks/` geçidiyle `bff:7001`'e geçer —
BFF için ayrı bir port **açılmaz**. Jira Data Center'da belge eki ve pano
taşıma henüz yoktur; analiz **yorum olarak** teslim edilir (ayrıntı belgede).

Özet: `.env`'deki `MAESTRO_SECRET_KV_JIRA__WEBHOOK` değeri ile Jira'daki webhook
kaydının `secret` alanı **aynı** olmalıdır. `POST /webhooks/jira` ucu
fail-closed'dır: sır tanımlı değilse gövde ayrıştırılmadan reddedilir. "Sırrı
sonra tanımlarım" diye bir mod yoktur.

### 5.4 Motor kimliğini doğrulayın

Sistem iki Jira kimliği taşıyabilir:

- **Bağlantının kimliği** — panelden girdiğiniz jetonun sahibi
- **Motorun kimliği** — `.env`'deki `MAESTRO_BOT_ACCOUNT_ID` (artık isteğe bağlı)

Keşif sorgusu motorun kimliğiyle çalışır; panel ise dinleme kuralını
**bağlantının** kimliğiyle doldurur. İkisi farklıysa her kural asla
eşleşmeyecek bir atanana bakar — hiçbir talep işlenmez, hiçbir yerde hata
görünmez.

**Bu arıza artık büyük ölçüde kendiliğinden kapanıyor:** `MAESTRO_BOT_ACCOUNT_ID`
boş bırakıldığında karşılaştırılacak iki değer olmaz; bağlantı testi jetonun
gerçek sahibini `/rest/api/3/myself` ile öğrenip bağlantıya yazar ve kurallar o
kimlikle kurulur. Önerilen kurulum budur.

Yine de doldurmayı seçtiyseniz doğrulayın: panelde **Ayarlar → Bağlantılar →
(Jira bağlantısı) → Test**. Ekran iki kimliği karşılaştırır ve farklıysa
**uyarır**. Uyarı görüyorsanız ya `.env`'deki değeri bağlantının sahibiyle
eşitleyin, ya da satırı boşaltıp panele bırakın. `.env`'i değiştirdiyseniz:

```bash
docker compose up -d --force-recreate bff worker
```

> **Jetonu değiştirmek için yeniden başlatmak GEREKMEZ.** Panelden girilen
> jetonlar her çağrıda yeniden okunur; "Test et" yeşil olduğu anda koşular da o
> jetonu kullanır. Yukarıdaki komut yalnızca `.env` değiştiğinde gerekir.

### 5.5 Jira'da onay gruplarını eşleyin (`GATE_GROUPS`)

Onay kapıları (analiz onayı, teknik onay, test onayı) `/approve` yazan kişinin
**Jira grup üyeliğiyle** doğrulanır. Eşleme verilmediğinde rol adının kendisi
grup adı sayılır: Jira'nızda `product-owners`, `tech-leads` ve `qa` adında
gruplar yoksa **her onay "üye değil" diye reddedilir** — kapı fail-closed'dır
ve koşu onay adımında bekler kalır.

İki seçenekten birini yapın:

- Jira'da bu adlarla (`product-owners`, `tech-leads`, `qa`) grup açıp
  onaycıları üye yapın, **ya da**
- `.env` §6b'de rolleri kendi gruplarınıza eşleyin:
  `GATE_GROUPS="product-owners=<JIRA-GRUBU>,tech-leads=<JIRA-GRUBU>,qa=<JIRA-GRUBU>"`
  — tek onaycı grubu varsa `GATE_GROUP_DEFAULT="<JIRA-GRUBU>"` tek başına
  yeter.

Eşleme **hem `bff` hem `worker`** tarafından okunur (biri üyeliği doğrular,
öteki kapı kaydına sahibi yazar); `.env` değiştiği için ikisini birden
yenileyin: `docker compose up -d --force-recreate bff worker`

---

## 6. Sessiz arızalar — belirtiye göre teşhis

Buradaki arızaların ortak özelliği: **hiçbiri hata vermez.** Sistem açıktır,
loglar temizdir, panel çalışır — ama iş görülmez.

| Belirti | Gerçek sebep | Çözüm |
|---|---|---|
| Kural kurdum, **hiçbir talep yakalanmıyor**, log temiz | Motorun kimliği (`MAESTRO_BOT_ACCOUNT_ID`) ile bağlantının kimliği farklı | §5.4 |
| Talepler işleniyor ama **yanlış kişinin** talepleri | Keşif `currentUser()` ile çalışıyor ve jeton bir insana ait | Panele **bot hesabının** jetonunu girin |
| Analiz **"elle tamamlayın"** diye bitiyor | Talep `gizli` sınıfta, on-prem model yok sayılıyor (`LLM_ON_PREM=false`) | `LLM_ON_PREM="true"` + `docker compose up -d --force-recreate` |
| Panel açılıyor, **her istek 502** | BFF konteyner içinde `127.0.0.1`'e bağlanmış; nginx ulaşamıyor | `.env`'de `BFF_HOST="0.0.0.0"` |
| Panele hiç erişilemiyor | `STUDIO_PORT` yayınlanmamış ya da güvenlik duvarı kapalı | `docker compose ps` ile port eşlemesini kontrol edin |
| `SecretNotFoundError` — ama `.env`'de değer dolu | Sır değişkeninin **adı** yanlış (`MAESTRO_SECRET_JIRA_TOKEN` gibi) | Adları `.env.example`'dan **birebir** kopyalayın |
| Açılışta `SecretKeyError` | Referans biçimi `env:JIRA_TOKEN` gibi; `<mount>/<yol>#alan` olmalı | `JIRA_TOKEN_REF="kv/jira#token"` |
| Açılışta `JIRA_BASE_URL: the work port has no default instance` | Jira **Cloud** kullanıyorsunuz ama Cloud adresi boş; sürücü Data Center'a düşüyor | `.env` §5'te `JIRA_CLOUD_BASE_URL`'i doldurun, `JIRA_BASE_URL`'i yorumlayın |
| Açılışta `JIRA_BASE_URL ve JIRA_CLOUD_BASE_URL birlikte tanımlı` | İki adres birden dolu; hangisinin kullanılacağı tahmin edilmez | Konuştuğunuz Jira hangisiyse **yalnızca** onun adresini bırakın |
| Panel açılıyor ama hiçbir ticket işlenmiyor | Ne `JIRA_BASE_URL` ne `JIRA_CLOUD_BASE_URL` dolu — Jira portu "henüz tanımlanmadı" diyor | `.env` §5'e Jira adresinizi yazıp yeniden başlatın |
| BFF açılmıyor, env-file hatası | `NODE_ENV=production` ama sırlar hâlâ `.env`'de (Vault yok) | `NODE_ENV="development"` (bkz. `.env.example` §2) |
| Yeni bir alan kaydediliyor ama **veritabanına yazılmıyor** | İmajdaki Prisma istemcisi bayat, yeni sütunu yok sayıyor | Güncel koddan yeniden build (§2.3-c) |
| Model çağrıları **404** | `LLM_BASE_URL` sonunda `/v1` var, sürücü de ekliyor | Sondaki `/v1`'i silin |
| `unable to verify the first certificate` | Banka kök CA'sı Node'un listesinde yok | `NODE_EXTRA_CA_CERTS` + CA'yı `certs/` içine koyun |
| Panelde jetonlar bozuk / çözülemiyor | `CONNECTOR_MASTER_KEY` değişti ya da kayboldu | Eski anahtarı geri koyun; yoksa jetonları yeniden girin |
| Her `/approve` **"üye değil"** diye reddediliyor | Rol adları (`product-owners`/`tech-leads`/`qa`) Jira'da grup olarak yok ve `GATE_GROUPS` eşlenmemiş — kapı fail-closed'dır | §5.5 — `GATE_GROUPS`'u kendi Jira gruplarınıza eşleyin |

---

## 7. Güncelleme (veri korunarak)

```bash
# 1) Yeni imaj tar'ını yükleyin
gunzip -c maestro-imajlar-<YENI_TAG>.tar.gz | docker load

# 2) .env'de etiketleri yeni sürüme çevirin
#    MAESTRO_NODE_IMAGE / MAESTRO_STUDIO_IMAGE

# 3) Yeni paketin .env.example'ında EKLENMİŞ alan var mı, karşılaştırın:
diff <(grep -oE '^[A-Z_]+=' .env.example | sort) <(grep -oE '^[A-Z_]+=' .env | sort)

# 4) Uygulayın — migrate otomatik çalışır, veri korunur
./install.sh --yes
```

> Yeni bir sürüm yeni bir **zorunlu** değişken getirebilir. 3. adımı atlamayın:
> eski bir `.env`, yeni pakette eksik kalır. `install.sh`, `.env` ile paketin
> `BUNDLE_VERSION`'ı tutmuyorsa zaten uyarır.

**ASLA `docker compose down -v` çalıştırmayın** — `-v` veritabanı volume'ünü siler.

---

## 8. Yedekleme

```bash
# Veritabanı
docker compose exec -T postgres pg_dump -U maestro maestro | gzip > maestro-$(date +%F).sql.gz

# .env dosyası — CONNECTOR_MASTER_KEY burada. Kaybolursa kayıtlı bağlantı
# jetonlarının hiçbiri çözülemez. Şifreli ve ayrı bir yerde saklayın.
```

---

## 9. Bu kurulumda ÇALIŞMAYAN şeyler

Dürüst liste — sunum değil, kurulum gerçeği:

- **SIEM'e otomatik log akışı yok.** CEF/syslog biçimlendirici hazır, ama
  toplayıcıya ileten taşıyıcı yazılmadı. Denetim kaydı panelden JSON/CSV indirilir.
- **E-posta bildirimi yok.** SMTP sürücüsü yazıldı, taşıma katmanı bağlanmadı.
  Çalışan kanallar: Jira yorumu, Teams, Slack.
- **SAML/OIDC SSO yok.** Kimlik doğrulama LDAP/LDAPS veya yerel hesap.
- **Kod yazma hattı kuruludur ama uçtan uca canlı denenmemiştir.** scm portu
  (GitHub) her kurulumda kuruludur; build doğrulaması ve kod taraması ise
  yapılandırılana kadar "henüz yapılandırılmadı" diye **adıyla** cevap verir —
  sessizce "bulgu yok" DÖNDÜRMEZ.
- **Vault bu pakette varsayılan değil.** `NODE_ENV=development` iken sırlar
  `.env` dosyasındadır (`chmod 600`). Vault'a geçiş `NODE_ENV=production` ile
  yapılır ve ayrıca S3 uyumlu depolama gerektirir.
