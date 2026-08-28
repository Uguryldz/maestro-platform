# Maestro — Registry Kurulumu

**Paket sürümü: 2026-08-27**
*(Bu tarih `.env.example` içindeki `BUNDLE_VERSION` ve `install.sh` başlığıyla
aynı olmalıdır. Üçü tutmuyorsa elinizdeki paket karışıktır — kurmayın.)*

İmajlar **registry'den çekilir** (`docker compose pull`); bu paket hiçbir şey
build etmez, hiçbir tar dosyası beklemez. Depoları registry tarafında siz
yönetirsiniz — paket yalnızca imajın **tam adresini** ister.

**Doldurulacak alan: 4.** Jira jetonu, GitHub jetonu ve model anahtarı bu
dosyada **durmaz** — kurulumdan sonra panelden girilir (§4). `.env.example`
bilerek kısadır: orada olmayan her ayarın varsayılanı doğrudur (§8).

---

## 1. Ön koşullar

| Gereklilik | Değer |
|---|---|
| Docker Engine + Compose v2 | `docker compose version` çalışmalı |
| CPU / RAM | 4 CPU / 16 GB önerilir (asgari 2 CPU / 8 GB) |
| Disk | imajlar ~2,7 GB + veritabanı büyümesi |
| Açık port | yalnızca panel portu (varsayılan 7000) |
| Ağ | sunucudan **registry**'ye, **Jira**'ya ve **LLM uç noktasına** erişim |

İmajları registry'ye siz push edersiniz. **Depo adı ve etiket, `.env.example`
içindeki `MAESTRO_NODE_IMAGE` / `MAESTRO_STUDIO_IMAGE` satırlarıyla birebir
aynı olmalıdır** — burada başka bir ad kullanırsanız `install.sh` "imaj
çekilemedi" der ve sebebi listelemediği için aramak zaman alır.

Kaynaktan üretiyorsanız (`deploy/banka/README.md` §3 aynı komutları taşır):

```bash
# depo kökünde
docker build -f deploy/docker/Dockerfile.node   -t uguryldz/maestro-node:1.0.7   .
docker build -f deploy/docker/Dockerfile.studio -t uguryldz/maestro-studio:1.0.7 .
```

Kurum registry'sine aynarken:

```bash
docker tag uguryldz/maestro-node:1.0.7   <registry>/maestro-node:1.0.7
docker tag uguryldz/maestro-studio:1.0.7 <registry>/maestro-studio:1.0.7
docker push <registry>/maestro-node:1.0.7
docker push <registry>/maestro-studio:1.0.7
```

**Beş imajın hepsi aynalanmalıdır.** Uygulamanın iki imajının yanında
`POSTGRES_IMAGE`, `REDIS_IMAGE` ve `TEMPORAL_IMAGE` de `.env.example`'da
`docker.io/uguryldz/*` adresini gösterir; yalnız ikisini aynalayan bir kurulum,
kapalı ağda kalan üçüne erişemez.

---

## 2. Kurulum

```bash
cd deploy/ugurdocker
cp .env.example .env
chmod 600 .env
```

`.env`'de **dört alan** doldurulur. Her biri `DEGISTIR` yazar; `install.sh`
biri bile kalmışsa hiçbir konteyner başlatmadan durur.

| Alan | Nasıl üretilir | Neden panele taşınmadı |
|---|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | Süreç, veritabanına nasıl bağlanacağını öğrenmek için veritabanını okuyamaz. |
| `REDIS_PASSWORD` | `openssl rand -hex 16` | Aynı sebep. Parolasız Redis ağa açık bir kuyruktur. |
| `CONNECTOR_MASTER_KEY` | `openssl rand -base64 32` | Panelin jetonlarını **bu** şifreler; koruduğu deponun içinde duramaz. Tam 32 bayt olmalı. |
| `MAESTRO_SECRET_KV_JIRA__WEBHOOK` | `openssl rand -hex 32` | **Dışarıdan gelen, henüz doğrulanmamış** bir isteği doğrular (§5.4). |

Ayrıca **bir Jira adresi** (Cloud mu, Data Center mı — hangisini doldurursanız
o sürücü çalışır) ve kurum registry'si kullanacaksanız **imaj adresleri**.
İmajlar Docker Hub'dan doğrudan çalışır hâlde gelir; mirror'lıyorsanız satırın
tamamını değiştirin:

```bash
MAESTRO_NODE_IMAGE="<registry>/maestro-node:1.0.7"
MAESTRO_STUDIO_IMAGE="<registry>/maestro-studio:1.0.7"

# İKİSİNDEN YALNIZCA BİRİ — hangisini doldurursanız o sürücü çalışır:
JIRA_CLOUD_BASE_URL="https://kurum.atlassian.net"   # Jira Cloud
# JIRA_BASE_URL="https://jira.kurum.local"          # Jira Data Center
```

> **Etiketi sabitleyin, `latest` kullanmayın.** Hangi sürümün kurulu olduğu
> belirsizleşir, geri alma imkânsızlaşır ve bir dahaki `pull` sessizce başka
> bir imaj getirir.

Sonra:

```bash
docker login <registry>     # özel depo ise şart; genel depoda gerekmez
docker compose pull         # imajları çeker
./install.sh                # ön kontroller → migrate → başlat → sağlık bekle
./install.sh --yes          # otomasyon için (soru sormaz)
```

`install.sh` **önce doğrular, sonra çalıştırır.** Şunlardan biri varsa hiçbir
konteyner başlatmadan durur: `.env`'de `DEGISTIR` kalması · zorunlu bir
değişkenin boş olması · `CONNECTOR_MASTER_KEY`'in 32 bayt olmaması · iki Jira
adresinin birlikte dolu olması · `LLM_BASE_URL` sonunda `/v1` bulunması ·
imajın çekilememesi · imajda migration ya da Prisma istemcisinin eksik olması ·
**imajın içinde doldurulmuş bir `.env` bulunması** · ortamın uygulamanın kendi
açılış şemasından geçememesi.

Son madde ötekilerden farklı bir iş yapar. Diğerleri belirli bir değişkeni
adıyla kontrol eder ve böyle bir liste ancak yazıldığı günkü kadar günceldir;
nitekim bir kez betik yirmi dört değişkeni doğruladı, hepsi yeşil geçti ve
`migrate` konteyneri listede adı hiç geçmeyen değişkenler yüzünden öldü. Bu
yüzden `install.sh` yığını başlatmadan önce `bff` servisinin ortamını
compose'un kurduğu **hâliyle** ayağa kaldırıp uygulamanın açılışta çalıştırdığı
doğrulamanın **aynısını** çalıştırır (`docker compose run --rm --no-deps`).
Elle tutulan bir liste yoktur; doğrulayan şey şemanın kendisidir, dolayısıyla
bayatlayamaz.

---

## 3. Kurulum sonrası doğrulama

```bash
docker compose ps                    # hepsi healthy/running olmalı
docker compose logs migrate          # "migrations applied" görmelisiniz

# BFF hazır mı — /readyz Temporal ve kill-switch deposunu da yoklar
docker compose exec bff node -e "fetch('http://127.0.0.1:7001/readyz').then(async r=>console.log(r.status, await r.text()))"

# Panelin nginx'i ayakta mı
docker compose exec studio wget -qO- http://127.0.0.1:8080/healthz

# Panel üzerinden BFF'e (tarayıcının gittiği yol — /api öneki soyulur)
curl -s http://localhost:7000/api/healthz   # {"status":"ok","env":"development"}
curl -s http://localhost:7000/api/readyz    # {"status":"ready","checks":{...}}
```

**Panel:** `http://<SUNUCU_IP>:7000`
**İlk giriş:** `admin` + kurulum sırasında migrate adımının **bir kez** bastığı
`GEÇİCİ PAROLA` (install.sh çıktısındaki `GEÇİCİ PAROLA` satırı). İlk oturumda
sistem yeni bir parola belirlemenizi **zorunlu** tutar. Parolayı not etmediyseniz:
`./reset-admin.sh admin` yenisini üretir.

---

## 4. Sırada ne var: KURULUM PANELDE BİTER

`install.sh` yeşil bitti diye sistem **iş yapmaya** hazır değildir. Jira
jetonu, GitHub jetonu ve model anahtarı `.env`'de **yoktur** — panelden
girilir, veritabanına `CONNECTOR_MASTER_KEY` ile şifreli yazılır ve koşular
oradan okur. Aşağıdaki adımları sırayla uygulayın.

### 4.1 `admin` hesabıyla girin, kalıcı parolanızı belirleyin

İlk kurulumda migrate, `admin` hesabını **rastgele üretilmiş geçici bir
parolayla** oluşturur ve bu parolayı **yalnızca bir kez**, kurulum çıktısında
basar (`GEÇİCİ PAROLA` satırı). Sabit bir kurulum parolası **yoktur** — hiçbir
paketin kaynağında yazılı değildir.

Panele `admin` + geçici parola ile girin; sistem kendi parolanızı belirlemenizi
**zorunlu** tutar (o ana kadar hesap yalnızca parola değiştirme/çıkış uçlarına
erişebilir).

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

### 4.2 Jira bağlantısını ekleyin

**Ayarlar & bağlantılar → yeni bağlantı → Jira → jetonu girin → "Test et".**

Test yalnızca "çalışıyor mu" demez: `/rest/api/3/myself` çağrısıyla jetonun
**gerçek sahibini** öğrenir ve bağlantıya kendisi yazar. `.env`'deki
`MAESTRO_BOT_ACCOUNT_ID` bu yüzden boş bırakılabilir (önerilen budur) —
doldurup yanlış yazarsanız panel iki kimliği karşılaştırıp uyarır.

> **Jetonu değiştirmek için yeniden başlatmak GEREKMEZ.** Panelden girilen
> jetonlar her çağrıda yeniden okunur; "Test et" yeşil olduğu anda koşular da
> o jetonu kullanır.

### 4.3 GitHub bağlantısını ekleyin

**Ayarlar & bağlantılar → yeni bağlantı → GitHub → jetonu girin → "Test et".**

Kod yazan akışlar (hata düzeltme, yeni özellik) bir kod deposu bağlantısı
ister. Bağlantı tanımlı değilse kurulum sihirbazı o akışları **gerekçesiyle
birlikte, daha ilk adımda** kapatır; onaylanmış bir analizden sonra ölen koşu
diye bir şey yoktur. Yalnızca analiz hattını kullanacaksanız bu adım isteğe
bağlıdır.

### 4.4 Kurulum sihirbazını çalıştırın: `/setup`

Panelde **`http://<SUNUCU_IP>:7000/setup`** — proje, dinleme kuralı ve akış
seçimlerini buradan yaparsınız. Hangi ticket'ın hangi akışla koşacağı sunucu
yapılandırmasıyla değil, buradan belirlenir.

### 4.5 Jira webhook'unu kaydedin

Webhook olmadan Maestro talepleri **anında** görmez. `.env`'deki
`MAESTRO_SECRET_KV_JIRA__WEBHOOK` değeri ile Jira'daki webhook kaydının
`secret` alanı **aynı** olmalıdır.

Webhook adresi panelin kendisiyle **aynı host**'tur:
`https://<host>/webhooks/jira`. İstek, dışarı açılan tek port olan studio'dan
girer ve `studio-nginx.conf`'taki `/webhooks/` geçidiyle `bff:7001`'e geçer —
BFF için ayrı bir port **açılmaz**, `BFF_HOST`/`BFF_PORT` ayarlanmaz.

**→ [`docs/jira-webhook-kurulum.md`](../../docs/jira-webhook-kurulum.md)**

`POST /webhooks/jira` ucu fail-closed'dır: sır tanımlı değilse gövde
ayrıştırılmadan reddedilir. "Sırrı sonra tanımlarım" diye bir mod yoktur — ve
bu sır tam olarak bu yüzden panele taşınmadı. Bu uç, isteğin gerçekten
Jira'dan geldiği **henüz bilinmiyorken** okunur; sırrı veritabanından
okusaydık, imza kontrolünün önüne bir veritabanı sorgusu koymuş olurduk:
adresi bilen herkesin sahte istekle sorgu yaptırabildiği, hız sınırı da olmayan
bir uç nokta.

### 4.6 Bot hesabı `maestro-admins` grubunda OLMASIN

Korumalı parametreleri değiştirmek **dört-göz kuralına** tabidir: öneren ve
onaylayan farklı kişiler olmalıdır. Bot hesabı da bu gruptaysa kural **tek
başına sağlanabilir** hâle gelir — bot önerir, bot onaylar. Kural teknik olarak
çalışır, denetim kaydı düzgün görünür, ama ikinci göz diye bir şey kalmaz.

### 4.7 Jira'da onay gruplarını eşleyin (`GATE_GROUPS`)

Onay kapıları (analiz onayı, teknik onay, test onayı) `/approve` yazan kişinin
**Jira grup üyeliğiyle** doğrulanır. Eşleme verilmediğinde rol adının kendisi
grup adı sayılır: Jira'nızda `product-owners`, `tech-leads` ve `qa` adında
gruplar yoksa **her onay "üye değil" diye reddedilir** — kapı fail-closed'dır
ve koşu onay adımında bekler kalır.

İki seçenekten birini yapın:

- Jira'da bu adlarla (`product-owners`, `tech-leads`, `qa`) grup açıp
  onaycıları üye yapın, **ya da**
- `.env`'de rolleri kendi gruplarınıza eşleyin:
  `GATE_GROUPS="product-owners=<JIRA-GRUBU>,tech-leads=<JIRA-GRUBU>,qa=<JIRA-GRUBU>"`
  — tek onaycı grubu varsa `GATE_GROUP_DEFAULT="<JIRA-GRUBU>"` tek başına
  yeter.

Eşleme **hem `bff` hem `worker`** tarafından okunur (biri üyeliği doğrular,
öteki kapı kaydına sahibi yazar); `.env` değiştiği için ikisini birden
yenileyin: `docker compose up -d --force-recreate bff worker`

---

## 5. Sessiz arızalar — belirtiye göre teşhis

| Belirti | Sebep | Çözüm |
|---|---|---|
| `pull access denied` / `manifest unknown` | Registry oturumu yok, ya da `.env`'deki adres/etiket registry'de yok. Kimliği olmayan bir istemciye çoğu registry deponun **varlığını** da söylemez — iki hata ayırt edilemez. | `docker login <registry>` · adresi ve etiketi registry'de doğrulayın |
| Açılışta `JIRA_BASE_URL ve JIRA_CLOUD_BASE_URL birlikte dolu` | İki adres iki **ayrı sürücü** besler; hangisinin kazanacağı tahmin edilmez. Yanlış tahmin, ticket'ları yanlış Jira'ya yazmak demektir. | Yalnızca kullandığınız Jira'nın adresini bırakın, ötekini yorumlayın |
| Panel açılır, "Jira henüz tanımlanmadı" | İki adres de boş. Bu **ölümcül değil**: yığın bilerek açılır ki kurulumu panelden yapabilesiniz. | `.env` §5'e adresi yazın → `docker compose up -d --force-recreate bff worker` |
| `CONNECTOR_MASTER_KEY ... 32 bayt olmalı, N bayt çıktı` | Anahtar base64 çözüldüğünde 32 bayt değil (çoğu zaman `openssl rand -hex 32` kullanılmıştır — o 64 karakter üretir). | `openssl rand -base64 32` |
| Panel açılır, her istek 502 | `bff` healthy değil ya da hiç başlamamış. `studio` ona bağımlıdır. | `docker compose logs bff` · `.env`'de `BFF_PORT` varsa **silin** (port 7001'de sabittir) |
| Dinleme kuralları hiçbir talebi yakalamıyor, hata da yok | `.env`'deki `MAESTRO_BOT_ACCOUNT_ID` ile bağlantının kimliği ayrışmış: kural asla eşleşmeyen bir atanana bakıyor. | Satırı **boşaltın**, panelde bağlantıyı tekrar test edin — kimliği panel bulur |
| Model çağrıları 404 | `LLM_BASE_URL` sonunda `/v1` var; sürücü de ekleyince `/v1/v1/...` olur. | Sondaki `/v1`'i silin (`install.sh` bunu zaten yakalar) |
| Analiz "elle tamamlayın" diye bitiyor | `LLM_ON_PREM` `true` değil: `gizli` sınıflı işlerde on-prem model yok sayılır. Hata değil, **eksik çıktı**. | `LLM_ON_PREM="true"` |
| Her dış çağrı `unable to verify the first certificate` | Jira/TFS sertifikası kurum CA'sıyla imzalı. | CA dosyasını `certs/` içine koyun, `.env`'de `NODE_EXTRA_CA_CERTS` satırını açın |
| `secret not found`, ama `.env`'de değer dolu görünüyor | Sır değişkeninin adı elle yazılmış. Ad referanstan **türetilir**: `kv/jira#webhook` → `MAESTRO_SECRET_KV_JIRA__WEBHOOK` (`#` → **çift** alt çizgi, `-` → `__2D_`). | `.env.example`'daki adları birebir kullanın |
| Her `/approve` "üye değil" diye reddediliyor | Rol adları (`product-owners`/`tech-leads`/`qa`) Jira'da grup olarak yok ve `GATE_GROUPS` eşlenmemiş — kapı fail-closed'dır. | §4.7 — `GATE_GROUPS`'u kendi Jira gruplarınıza eşleyin |

---

## 6. Güncelleme (veri korunarak)

```bash
# .env'de MAESTRO_NODE_IMAGE / MAESTRO_STUDIO_IMAGE etiketlerini yeni sürüme çekin
docker compose pull
docker compose run --rm migrate     # şema güncellemesi (veri korunur)
docker compose up -d
```

> ⚠ **ASLA `docker compose down -v` çalıştırmayın.** `-v` volume'leri siler,
> yani veritabanını. `down` (bayraksız) konteynerleri durdurur, veri kalır.

Aynı sunucuya **ikinci bir kurulum** (kabul/test) yapacaksanız `.env`'de
`COMPOSE_PROJECT_NAME` ve `STUDIO_PORT`'u mutlaka değiştirin. Aynı adla kurulan
ikinci bir yığın compose için yeni bir kurulum değil, **mevcudun
güncellenmesidir**: çalışan kurulumun volume'üne bağlanır.

---

## 7. Yedekleme

```bash
docker compose exec -T postgres pg_dump -U maestro maestro | gzip > yedek-$(date +%F).sql.gz
```

`CONNECTOR_MASTER_KEY`'i **ayrıca** yedekleyin. Veritabanı yedeği tek başına
yetmez: panelden girilen jetonlar onunla şifrelenmiştir ve anahtar
kaybolduğunda hepsi çözülemez hâle gelir — hepsini panelden yeniden girmek
gerekir.

---

## 8. `.env`'de OLMAYAN ayarlar — ve neden yok

`.env.example` yalnızca bir operatörün gerçekten **karar vermesi gereken**
satırları taşır. Aşağıdakiler dosyadan çıkarıldı: her birinin varsayılanı
`docker-compose.yml` içinde yazılıdır ve kodun kendi varsayılanıyla **birebir
aynıdır** (`apps/deploy/src/env.ts`). Yani bunları `.env`'e yazmak sistemin
davranışını değiştirmez — yalnızca değiştirilebilirmiş izlenimi verir.

| Değişken | Sabit varsayılan | Neden `.env`'de değil |
|---|---|---|
| `JIRA_TOKEN_REF` | `kv/jira#token` | Sır **adresi**, sır değeri değil. Değiştirirseniz `MAESTRO_SECRET_*` adlarını da yeni referanstan yeniden türetmeniz gerekir — ve bir harf kayarsa sürücü "secret not found" der, siz `.env`'de değeri dolu görürsünüz. |
| `JIRA_WEBHOOK_SECRET_REF` | `kv/jira#webhook` | Aynı. `MAESTRO_SECRET_KV_JIRA__WEBHOOK` adı **bundan** türetilir. |
| `GITHUB_TOKEN_REF` | `kv/github#token` | Aynı. |
| `LLM_API_KEY_REF` | `kv/llm#api-key` | Aynı. |
| `ADO_TOKEN_REF` · `ADO_WEBHOOK_SECRET_REF` | `kv/ado#token` · `kv/ado#webhook` | Aynı; ayrıca scm portu GitHub olduğu için bugün hiç okunmaz. |
| `LDAP_BIND_PASSWORD_REF` | `kv/ldap#service-password` | Aynı; yalnızca `IDENTITY_DRIVER="ldaps-bind"` ise okunur. |
| `LDAP_GROUP_BASE_DN` · `LDAP_USER_FILTER` · `LDAP_GROUP_FILTER` · `LDAP_CA_CERT_PATH` | boş | LDAP'ın **zorunlu** üçlüsü (`LDAP_URL`, `LDAP_USER_BASE_DN`, `LDAP_BIND_DN`) `.env.example`'ın opsiyonel bölümünde durur. Bunlar yalnızca şeması alışılmadık bir dizin için gerekir; gerekirse aynı bölüme elle ekleyin. |
| `STORAGE_BUCKET` · `STORAGE_REGION` | `maestro-evidence` · `us-east-1` | Yalnızca `NODE_ENV="production"` ile okunur ve o hâlde asıl karar `STORAGE_ENDPOINT`'tir; kova adı değiştirilecekse buraya eklenir. |
| `VAULT_MOUNTS` | `kv,git` | `git` listede olmak **zorundadır**: Vault sürücüsü kısa ömürlü push kimlik bilgisini o mount'tan üretir. Listeden düşürmek her push'u ilk mühendislik adımında reddettirir. |
| `BFF_PORT` | `7001` (compose sabitler) | Aynı sayı `healthcheck`'te ve `studio-nginx.conf`'ta da sabit durur. Değişken hâlindeyken değiştiren kurulum, hiç `healthy` olmayan bir `bff` ve hiç başlamayan bir `studio` ile kaldı. |
| `BUNDLE_VERSION` | paketle gelir | Paket sürümü üç yerde birden durur — `install.sh`, `.env.example` ve `docker-compose.yml` başlığı — ve `install.sh` uyumu denetler. Üçlü bir kez sessizce ayrıştı (18 ≠ 19) ve hiçbir şey yakalamadı; artık eşitliği test kilitler, elle değiştirilmez. |
| `MAESTRO_BOOTSTRAP_PASSWORD` | boş | Boşken ilk `admin` parolası rastgele üretilir ve migrate çıktısına **bir kez** basılır (§4.1) — önerilen budur; bir parolanın diskte bir dosyada durmaması gerekir. Runbook'u sabit ilk parola isteyen saha `.env.example`'ın opsiyonel bölümündeki yorumlu satırı açabilir: parola o zaman hiç basılmaz, ilk girişte değişim yine zorunludur ve değişkeni **yalnız migrate** görür. |

Bir sahanın gerçekten ihtiyacı olursa: değişkeni `.env`'e yazmak yeterlidir,
compose zaten `${DEGISKEN:-varsayılan}` biçiminde iletir ve yazdığınız değer
varsayılanı ezer. Compose'da ayrıca bir şey değiştirmek gerekmez.
