# Sürüm notu — pilot imajı

**Kapsam:** Bu imajda ne çalışıyor, ne çalışmıyor. Dürüst liste; pazarlama metni değil.
Bir şeyin "çalışıyor" yazması, canlı bir kurulumda uçtan uca doğrulandığı anlamına gelir.

---

## 1. Çalışan zincir (pilotun asıl işi)

Ticket → analiz → **PO/TL onayı** → Word/PDF üretimi → Jira'ya geri yazma.

| Yetenek | Durum | Not |
|---|---|---|
| Jira webhook alımı (imza doğrulamalı) | Çalışıyor | İmzasız istek 401 |
| Proje bağlama sihirbazı (`/onboard`) | Çalışıyor | Bağlama **öneri** olarak dosyalanır: 4-göz, 202 döner |
| Kuru koşum (dry-run) | Çalışıyor | Projenin **gerçek** koşu geçmişini okur, sabit metin üretmez |
| Analiz şablonu tasarımcısı (`/template`) | **Çalışıyor** | Bu sürümde eklendi — aşağıya bak |
| Analiz üretimi ve 3→4 kapısı | Çalışıyor | Onay/ret Jira komutlarıyla da verilebilir |
| Word/PDF üretimi (kurum şablonuyla) | Çalışıyor | Şablon Postgres'te, sürümlü (M83) |
| Denetim izi (hash zincirli) | Çalışıyor | `/audit` zinciri yeniden hesaplayıp doğruluyor |
| Parametreler, 4-göz, kill switch | Çalışıyor | Değerler DB'de, sürümlü |
| LDAPS kimlik doğrulama | Çalışıyor | Aşağıdaki uyarıyı oku |
| Maliyet / kota / LLM yönlendirme | Çalışıyor | Veri sınıfına göre backend seçimi dahil |

---

## 2. Bu sürümde düzelenler

**Analiz şablonu artık kalıcı.** Önceden şablon BFF sürecinin belleğinde tutuluyordu:
her yeniden başlatmada kayboluyor, `GET /template` yeniden `404 no_template` dönüyor ve
ekran "🚧 henüz yayında değil" gösteriyordu. Artık `AnalysisTemplateVersion` tablosu var
(migration **0007**), tablo **append-only** (trigger'la zorlanıyor — onaylanmış bir analizin
neye göre değerlendirildiği sonradan değiştirilemez, M83).

**Varsayılan şablon geliyor.** Migration çalıştığında installer **v1 analiz şablonunu**
yayınlar: amaç/gerekçe, kapsam, etki analizi, veri ve gizlilik, riskler ve önlemler, geri
alma planı, test ve kabul kriterleri, bağımlılıklar. Sekiz bölüm, her birinde gerçek bir AI
talimatı. Banka kendi sürümünü yayınlarsa (v2, v3…) installer **dokunmaz**.

**Türkçe sızıntıları kapatıldı.** `/routing` notları, `/yaml` yer tutucusu, `/issues` ham
enum'ları (`GATE_OPEN · maestro-worker`), `/audit` eylem sütunu, `/pii` tip ve strateji
sütunları, ve `mode.*` (`full_auto` → "Tam otomatik"). Kural: BFF **cümle göndermez**,
katalog anahtarı gönderir; ekran operatörün dilinde yazar.

**Hata mesajları artık anlamlı.** Onboarding'de zaten bağlı bir projeyi bağlamayı denemek
"Beklenmeyen bir hata oluştu" yerine "Bu Jira projesi zaten bağlı…" diyor. Studio'nun hata
kataloğuna **51 kod** eklendi ve artık BFF'in `throw` noktalarını tarayıp kapsama zorlayan
bir test var — eskisi kendi tablosunu kendisiyle doğruluyordu ve hiçbir eksiği yakalayamazdı.

---

## 3. ÇALIŞMAYAN — kapsam dışı

### Windows ve macOS runner'ları — **kapsam dışı**
Bu imajda **yalnız Linux** sandbox'ı vardır (`RUNNER_IMAGE_LINUX`). `RUNNER_IMAGE_WINDOWS`
veya `RUNNER_IMAGE_MACOS` diye bir değişken **yoktur**; koysanız da hiçbir şey yapmaz.
`.maestro.yaml`'ında Linux dışı platform bildiren bir depo, mühendislik turunda **adıyla
reddedilir** — sessizce yanlış yerde çalıştırılmaz. .NET Framework ve iOS derlemeleri bu
pilotun kapsamında değildir.

### 503 `capability_not_wired` dönen uçlar
Bunlar **bozuk değil**; arkalarında veri üreten hiçbir şey olmadığı için **kasıtlı olarak
reddediyorlar**. Boş liste dönmüyorlar, çünkü boş liste "her şey yolunda" diye okunur:

| Uç / ekran | Neden 503 |
|---|---|
| `/cache` — Cache & çalışma alanı | Şemada `runner` diye bir şey yok: filo tablosu da, `WorkflowRun.runnerId` de yok. `packages/cache` Redis koordinasyonudur (token bucket, kilit, semafor) — ne kayıt ne bayt sayar. Ekranı doldurmak için runner kimliği, bayt sayısı ve oturum durumu **uydurmak** gerekirdi. |
| `/eval` — Golden ticket / eval | Golden ticket'ı kaydeden, aday variant'a karşı koşan ve skor saklayan hiçbir şey yok. Boş sayfa, hiç ölçüm yapmamış bir platformda "regresyon yok" diye okunurdu. |
| `/greenfield` — Yeni proje sihirbazı | Deposu henüz olmayan bir ticket için mimari önerisi/adım durumu yazan bir iş akışı yok. Boş adım listesi "başlamamış sihirbaz" gibi görünürdü. |
| `/runners` — Runner havuzları | `RunnerPort` filo listesi/boyut probu sunmuyor; filo tablosu yok. Boş tablo "sağlıklı ve boş filo" diye okunurdu. |
| `/scans` — Güvenlik bulguları | Tarama sonuçları iş akışının içinde üretiliyor ve **kalıcı bir tabloya yazılmıyor**. Boş liste "bulgu yok" diye okunur; gerçek "tarama sonucu saklanmıyor". |

> Bu ekranlarda gördüğünüz kırmızı kutu bir **arıza değil, bir beyandır**. Pilot
> değerlendirmesinde "bu ekranlar boş" değil, "bu yetenekler bu sürümde yok" diye not edin.

### Mühendislik turu (adım 6a) — koşullu
`RUNNER_IMAGE_LINUX` **set edilmezse** adım 6a adıyla reddeder ve ona bağlı 12 adım
çalışmaz. Platform yine de başlar; analiz ve onay kapıları (19 adımın 7'si) çalışır.
Uçtan uca kod üretimi denemek istiyorsanız bu değişkeni **doldurmanız gerekir**.

---

## 4. Pilot ekibi için sıra

Bu sırayla yapın. Her adım bir öncekine bağlı.

### Adım 1 — `.env` doldur
```bash
cp deploy/.env.example deploy/.env
```
`deploy/.env.example` her değişkenin **nereden alınacağını** yazar. En az şunlar gerekir:

- `JIRA_BASE_URL`, `ADO_BASE_URL`, `ADO_ORG`, `ADO_PROJECT`
- `ADO_PR_VALIDATION_BUILDS` — **varsayılanı yok ve boş liste reddedilir**: bu olmadan
  organizasyondaki herhangi bir pipeline bu deponun CI kapısına cevap verebilirdi (M12).
- `LLM_BASE_URL`, `LLM_MODEL`, `LLM_ON_PREM` — `LLM_ON_PREM` **kozmetik değil**: `false`
  iken `gizli` veri maskelenir ya da reddedilir. Bulut uca "on-prem" demek, gizli veriyi
  maskesiz dışarı yollar.
- `SCAN_IMAGE_*` — **digest zorunlu, tag reddedilir**.
  `docker buildx imagetools inspect <imaj>:<tag>` ile çözün.
- Prod profilinde: `VAULT_ADDR`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID`, `VAULT_MOUNTS`
  (`git` listede kalmalı — push kimlik bilgisi oradan alınır).
- İsteğe bağlı ama pilotun tam akışı için gerekli: `RUNNER_IMAGE_LINUX` (digest'li).

> `MAESTRO_SECRET_*` değişkenleri **yalnız dev profilinde** doldurulur. Prod profilinde
> bunlar hiç var olmamalıdır; değerler Vault'tadır.

Doğrula:
```bash
cd deploy && docker compose config > /dev/null && echo "compose geçerli"
```

### Adım 2 — Migration
```bash
make -C deploy migrate
```
Şemayı uygular **ve** analiz şablonu v1'i yayınlar. Log'da şunu görmelisiniz:
```
[maestro] migrations applied
[maestro] analysis template v1 published (8 sections)
```
İkinci kez çalıştırırsanız `analysis template already published, leaving it alone` yazar —
bu doğrudur, banka kendi şablonunu yayınladıysa üzerine yazılmaz.

### Adım 3 — LDAPS testini yap
Kimlik en kritik parçadır; **proje bağlamadan önce** doğrulayın.

`IDENTITY_DRIVER=ldaps-bind` yapın ve `LDAP_URL` (`ldaps://`, düz `ldap://`
**NODE_ENV=production altında reddedilir**), `LDAP_USER_BASE_DN`, `LDAP_GROUP_BASE_DN`,
`LDAP_BIND_DN`, `LDAP_BIND_PASSWORD_REF`, `LDAP_CA_CERT_PATH` ve `LDAP_ROLE_MAPPINGS`
doldurun.

Kontrol listesi:
- Gerçek bir AD hesabıyla giriş yapın. Platform **parolayı hiçbir zaman kendisi
  doğrulamaz** — dizine kullanıcı olarak bind eder, parola hash'i alınmaz ve saklanmaz.
- **Kapalı bir hesapla** giriş deneyin: reddedilmelidir (varsayılan filtre
  `userAccountControl` bit 2'yi dışlar, sürücü ayrıca kendi kontrolünü yapar).
- Rol eşlemesini doğrulayın: `LDAP_ROLE_MAPPINGS`'te olmayan bir grup **yetki vermez ama
  düşürülmez** — oturumda taşınır ve denetlenir. Herkese taban olarak `viewer` verilir.
- Grup DN'i virgül içerdiği için **JSON dizi biçimini** kullanın; kısa biçim (`grup:rol`)
  DN'i bölerdi.

### Adım 4 — İlk projeyi bağla
Studio → **Uygulama ekle** (`/onboard`). Jira projesini ve ADO deposunu seçin, **kuru
koşum** yapın (gerçek geçmişi okur), sonra bağlamayı dosyalayın.

Bağlama **202** döner, 201 değil: bu bir **öneri**dir ve **ikinci bir kişinin** onayını
bekler (4-göz). Aynı kişi kendi önerisini onaylayamaz. Zaten bağlı bir projeyi seçerseniz
409 ve ekranda "Bu Jira projesi zaten bağlı…" görürsünüz.

Tetikleme modu varsayılan olarak **`label`**'dır: yeni bağlanan bir proje, bağlantı aktif
olur olmaz her ticket'ı yutmaya başlamaz. `maestro` etiketi ya da `/ai-start` gerekir.

### Adım 5 — İlk ticket
Etiketli bir ticket açın ve şunu izleyin:
1. Webhook alınır, koşu başlar.
2. Analiz üretilir — **v1 şablonundaki bölümlere göre**.
3. Studio → **İş akışları** → satıra tıklayın; künye ve adım görünmeli.
4. 3→4 kapısında PO/TL onayı bekler. Studio'dan ya da Jira'da `/approve` ile onaylayın.
5. Word/PDF üretilir ve Jira'ya eklenir.
6. **Denetim izi** (`/audit`) — zincirin yeniden hesaplandığını doğrulayın.

`RUNNER_IMAGE_LINUX` set etmediyseniz akış adım 6a'da **adıyla durur**. Bu beklenen
davranıştır, arıza değil.

---

## 5. Bilinmesi gereken sınırlar

- **Oturumlar süreç-yereldir.** BFF yeniden başladığında herkes çıkış yapmış olur. Tek
  replika için sorun değil; çok replikada sticky session gerekir.
- **4-göz önerileri süreç-yereldir.** Uygulanmış parametre değerleri DB'dedir ve kalıcıdır;
  **açık öneriler** yeniden başlatmada kaybolur. Maliyeti ilk onaycının bir tıkı — değer
  hiç uygulanmamıştır.
- **Kill switch süreç-yereldir** ve prod profilinde bu yüzden **boot'ta reddedilir**
  (`assertStoresDurable`). Yani prod profilinde bu bir sürpriz değil, bir hata mesajıdır.
- **Redis çok replikada zorunludur.** Onsuz her süreç kendi token bucket'ını tutar; N
  replika, ayarlanan LLM hızının N katını verir.
- Bu imaj **build edilmemiştir** bu doğrulamada — `docker compose config` geçerliliği ve
  kaynak-üstü uçtan uca testler yapılmıştır. İlk build'i pilot ortamında yapın.
