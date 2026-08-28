# Maestro — Güvenlik Mimarisi ve Kontrol Envanteri

*Tehdit modeli · uygulanan kontroller · kapatılan açıklar · bilinen sınırlar*

| Hazırlayan | Tarih | Versiyon | Kapsam |
|---|---|---|---|
| Maestro doküman ajanı | 09.08.2026 | v1.0 | Sandbox izolasyonu · korumalı yollar · onay ve SoD kontrolleri · kill switch · sır yönetimi · MCP kapsamları · webhook ve yetkilendirme · denetim izi. Kapsam dışı: kurum ağ/firewall tasarımı, SIEM kural yazımı |

> **Kime:** güvenlik ekibi, uyum/compliance, iç denetim, ARB.
> **Ön koşullar:** [`mimari.md`](mimari.md) okunmuş olmalı.
> **Bu dokümanın farkı:** her kontrolün yanında **neden var olduğu** yazılıdır.
> Kontrollerin birçoğu, bağımsız doğrulama turlarında **gerçekten bulunan
> açıklardan** doğdu; o açıklar da burada anlatılıyor. Bir güvenlik dokümanı,
> yakalanmış hataları saklarsa işe yaramaz.

---

## 1. Tehdit modeli — neye karşı korunuyoruz

Maestro, bir bankanın kaynak kodunu **yazan** bir AI'ye yetki verir. Tehditler bu
gerçekten türer:

| # | Tehdit | Ana kontrol |
|---|---|---|
| T1 | AI'ın ürettiği kod kontrolsüz merge olur | 5 onay kapısı + SoD + ADO branch policy |
| T2 | AI, izinli olmadığı dosyalara dokunur | `protected_paths` deny-list (M52) |
| T3 | Sandbox'tan kaçış → build makinesinde kod çalıştırma | Sertleştirilmiş konteyner profili (M23/M24) |
| T4 | Gizli/kişisel veri buluta sızar | PII sınırı + veri sınıfı politikası + `Internal` ağ |
| T5 | Sahte onay / başkası adına onay | Komut grameri (M105) + üyelik doğrulaması + 4 göz |
| T6 | Sahte CI yeşili | Köken doğrulaması (M106) |
| T7 | Denetim izi silinir/değiştirilir | Hash zinciri + günlük anchor + SIEM dış kopya |
| T8 | Kötü niyetli repo, ajan ortamını ele geçirir | Repo ayar dosyalarının yüklenmemesi |
| T9 | Sır sızıntısı (log, hata mesajı, alt süreç) | Vault + hata metni disiplini + env miras kesme |
| T10 | Acil durumda kontrollerin gevşetilmesi | Break-glass **insan-only** (M73) |

---

## 2. Üst ilke: fail-closed (M35)

> **Her doğrulama noktasında: doğrulanamıyorsa akış DURUR. Sessiz geçiş yoktur.**

Bu ilkenin uygulandığı noktalar:

| Nokta | Doğrulanamazsa |
|---|---|
| Webhook imzası | **401** — gövde ayrıştırılmadan önce |
| Güvenlik taraması | Akış durur (**hata versе bile**) |
| Grup üyeliği | Kapı **açık kalır** |
| CI kökeni | Sinyal kabul edilmez |
| Analiz şablonu | Analiz kapıya **gelmeden** reddedilir |
| Kaynak referansı | Bağlamda yoksa = uydurma → ret |
| Eksik secret | Süreç **başlamaz** (M6) |
| Eksik i18n anahtarı | Servis **açılmaz** |
| Egress ağı `Internal` değil | İş **hiç başlamaz** |
| Boş CI allow-list | **Yapılandırma hatası** — "hepsine izin ver" değil |
| Audit zinciri kırık | Kanıt paketi **üretilmez** |

> [!IMPORTANT]
> Fail-closed'un maliyeti kabul edilmiştir: Maestro şüphe duyduğunda **durur** ve
> bir insana sorar. "Devam etsin, sonra bakarız" davranışı bilinçli olarak yoktur.

---

## 3. Sandbox izolasyonu (M23/M24)

### 3.1 Varsayılan profil — hiçbir şey söylemeyen bir yapılandırmanın ürettiği konteyner

| Ayar | Değer | Ne engeller |
|---|---|---|
| `ReadonlyRootfs` | `true` | Kök dosya sistemine yazma |
| `CapDrop` | `["ALL"]`, `CapAdd: []` | Tüm Linux capability'leri |
| `no-new-privileges` | `true` | setuid ile yetki yükseltme |
| `User` | `10001:10001` | Root olarak çalışma |
| `Memory` / `MemorySwap` | **eşit** | Swap'a taşma — *swap'layabilen limit, limit değildir* |
| `NanoCpus`, `PidsLimit`, `nofile` | sınırlı | Kaynak tüketimi, fork bombası |
| `/tmp` | tmpfs `rw,noexec,nosuid,nodev,size=…` | Geçici dizinden kod çalıştırma |
| `Init` | `true` | Zombi süreçler |
| `RestartPolicy` | `no`, `AutoRemove: false` | Kontrolsüz yeniden başlama |
| **`NetworkMode`** | **`"none"`** | Ağ erişimi (yapılandırılmadıysa) |
| İmaj | **`repo@sha256:…` zorunlu** | Tag ele geçirme / imaj sürüklenmesi |

### 3.2 Gevşetme açıkça istenir ve üretimde hiç mümkün değildir

Bir anahtarı kapatmak, `sandbox.allowUnsafeProfile` listesine **adını yazmayı**
gerektirir (`readonly-rootfs`, `no-new-privileges`, `cap-add`, `seccomp`,
`direct-egress`). **`NODE_ENV` üretimse kaçış anahtarı da çalışmaz.**

> [!WARNING]
> **`NODE_ENV` tanımsız, boş veya tanınmayan bir değerse ÜRETİM sayılır.** Yalnız
> `development` ve `test` kapıyı gevşetir.
>
> Bu ters çevrilmiş varsayılan bir düzeltmedir: `NODE_ENV` çoğu konteyner
> dağıtımında hiç set edilmez, ve eski "tanımsız = üretim değil" davranışı **üretim
> host'unda tüm gevşetmeleri sessizce açıyordu**. Aynı kalıp `@maestro/secrets`'ta da
> uygulanır: **ortam yalnız sertleştirebilir.**

### 3.3 Root her koşulda reddedilir

`uid 0` ve `gid 0` için **kaçış anahtarı yoktur**. Karşılaştırma **sayısaldır** ve
kapı hem Zod şemasında hem `buildContainerSpec` içinde koşar — kodda elle kurulan bir
profil de kapıyı atlayamaz.

> [!WARNING]
> **Gerçek bulgu:** kullanıcı kimliği **metin olarak** karşılaştırılıyordu ve
> `"00:0"` kontrolü atlatıyordu. Docker için `00:0` ve `000000:0` da root'tur.
> Doğrulayıcı **sandbox'tan gerçekten root oldu**. Bugün karşılaştırma sayısaldır ve
> şema `uid:gid`'i baştaki sıfırsız ondalık olarak sınırlar.

### 3.4 Ağ izolasyonu — enjeksiyon bir kontrol değildir

> [!WARNING]
> **Gerçek bulgu:** sandbox **host ağını görebiliyordu**. Konteynerden sunucudaki
> MySQL, Redis ve DNS listelendi.
>
> **İkinci gerçek bulgu:** "yalnız vekil üzerinden çıkılır" kuralı **sadece bir
> tavsiyeydi**. Sandbox'a `HTTP_PROXY`/`HTTPS_PROXY` enjekte ediliyordu ve iş bunları
> ezemiyordu — ama iş bu değişkenleri **okumak zorunda değildi**. Canlı kanıt: sıradan
> bridge ağında `nc -w 3 -z 1.1.1.1 443` başarılıydı.

Bugünkü kontroller:

1. **Ham TCP'yi kapatan tek şey ağın `Internal: true` olmasıdır** ve bu, ilk konteyner
   başlamadan **önce** daemon'a sorulur. Değilse iş hiç başlamaz.
2. Ağ adı dilbilgisi `^[a-z0-9][a-z0-9_.-]*$` ile sınırlıdır. **`host`, `none`,
   `bridge`, `default`, `container:<id>` her aşamada reddedilir** — bunlar operatörün
   kurduğu ağ değil, namespace seçicisidir. `host`, işe runner host'unun
   loopback'indeki **tüm servisleri** verirdi.
3. Ağ tanımlı ama proxy tanımsızsa yapılandırma reddedilir (`direct-egress`).
4. Proxy değişkenleri iş tarafından **ezilemez** (`ALL_PROXY`/`all_proxy` dahil
   rezerve). `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `NODE_OPTIONS`, `BASH_ENV`
   **yasaktır**.

### 3.5 Docker yetkisi (M24)

> **Docker yetkisi yalnız Runner Servisi'ndedir. Worker'da `docker.sock` asla bulunmaz.**

Docker istemcisi Engine API'sinin **dar bir dilimini** kullanır: create/start/wait/
kill/remove, logs, volume create/remove, image inspect, ping. **`exec`, image push ve
swarm bilinçli olarak yoktur.**

### 3.6 Zaman aşımı gerçekten öldürür

`runSession`, konteynerin çıkışını zamanlayıcıyla yarıştırır. Bütçe kazanırsa konteyner
**SIGKILL** ile öldürülür, loglar yine çekilir ve kısmi çıktı `exitCode = 124` ile
döner. **Sessizce takılma yoktur.** Bütçe tavanın üstündeyse **kırpılmaz, reddedilir**.

### 3.7 Kaçış bataryası — 23 test

`MAESTRO_DOCKER_IT=1` ile koşan bu testler **gerçek bir konteynerin içinden** şunları
dener: root olmak, ağa çıkmak, salt-okunur kökü aşmak, docker soketine ulaşmak.

> [!IMPORTANT]
> Bu bataryanın var olma sebebi şudur: bulunan açıkların **neredeyse tamamı testlerin
> taklit ettiği sınırın ötesinde** yaşıyordu — gerçek konteynerin içinde, gerçek
> aracın çıktısında, gerçek Docker motorunda. Taklit, sertleştirmeyi doğrulayamaz.

### 3.8 mac/Windows telafisi (M25) — kabul edilen risk

macOS ve Windows runner'larında konteyner izolasyonu **yoktur**. Telafi seti:

- İş başına **ephemeral kullanıcı + workspace**
- Dar yerel haklar
- MDM / EDR
- Aynı egress kuralları
- İş sonu **audit'li temizlik**

> [!WARNING]
> Bu bir **kabul edilmiş risktir** ve risk kaydına yazılmıştır. Linux seviyesinde
> izolasyon sağlanmamaktadır. (Ayrıca bu runner'ların sürücüleri ve daemon'u
> **HENÜZ YOK**.)

---

## 4. Korumalı yollar (M52)

### 4.1 İki seviye

**Okunamaz** (`DEFAULT_UNREADABLE_PATHS`) — ajan **içeriğini göremez**:

```
**/.env          **/.env.*        **/*.pem       **/*.key
**/*.p12         **/*.pfx         **/*.jks       **/id_rsa*
**/id_ed25519*   **/secrets/**    **/.npmrc      **/.netrc     **/.pgpass
```

> [!WARNING]
> **Gerçek bulgu (B6):** sır dosyaları **ham içerikle okunabiliyordu**.

**Yazılamaz** (`DEFAULT_WRITE_ONLY_PROTECTED_PATHS`) — ajan okuyabilir ama
değiştiremez:

| Desen | Neden |
|---|---|
| `**/migrations/**`, `**/*.sql` | M52 lafzı — şema değişikliği insan işidir |
| `**/.git/**` | Git hook'ları **merge beklemeden** build makinesinde kod çalıştırır |
| `**/.github/**`, `**/.gitlab-ci.yml`, `**/Jenkinsfile` | CI tanımları |
| `**/azure-pipelines*.y*ml`, `**/.azuredevops/**` | **Bizim hedeflediğimiz CI** (M12) |
| `**/.husky/**` | Başka adla git hook'u |
| `**/.vscode/**` | Klasör açılışında çalışan görev dosyası |
| `**/.claude/**` | Ajan yapılandırması |
| `**/.maestro.y*ml` | **Her iki YAML yazımı** — birini koruyup diğerini korumamak, saldırgana hangi dosya adını kullanacağını söylemektir |

> [!WARNING]
> **Gerçek bulgu (B3):** desenler **kök-çapalıydı** (`.git`, `.github`,
> `Jenkinsfile`) ve bir monorepo'da ya da submodule'lü bir repo'da —ki bu kural,
> istisna değil— `sub/.git/hooks/post-checkout` **yazılabilir kalıyordu**. Oradaki bir
> hook, kapı olmadan ve merge olmadan çalışır. M52'nin var olma sebebi tam olarak
> budur. Bugün hepsi `**/` ile derinlik-bağımsız çapalıdır.

> [!WARNING]
> **Gerçek bulgu (B4):** liste Jenkins ve GitLab'ı sayıyor, **ADO'yu — yani bizim
> kendi pipeline'ımızı** yazılabilir bırakıyordu.

### 4.2 Bilerek listede olmayanlar

| Ne | Neden korunmuyor |
|---|---|
| **Lockfile'lar** | M53'ün kontrolü "onaylı liste dışı paket = TL onay kapısı"dır, yani **insan kapısında işaretlenir**, oturum ortasında bloke edilmez. Bloke etseydik sıradan bir sürüm yükseltmesi imkânsız olurdu |
| `package.json`, `Dockerfile` | Bunları düzenlemek **ajanın işidir**. Build davranışı dosyaları oldukları için, lockfile gibi **insan kapısında işaretlenmeleri** istenmiştir |

### 4.3 Glob derleyicisi bir güvenlik bileşenidir

İzin verilen karakter kümesi bilinçli olarak bir **beyaz listedir**.

> [!WARNING]
> Eski derleyici anlamadığı her şeyi kaçışlıyordu: `**/*.{sql,ddl}` deseni, **literal
> `{sql,ddl}`** arayan bir regex'e derleniyordu ve **hiçbir `.sql` dosyasıyla
> eşleşmiyordu**.
>
> Hiçbir şeyle eşleşmeyen bir deny-list girdisi, bu dosyanın üretebileceği **en
> tehlikeli şeydir**: incelemede koruma gibi okunur, çalışma zamanında hiçbir koruma
> sağlamaz.

### 4.4 İhlal olursa

Korumalı yola diff üretilirse akış **ilk turda** durur ve insana devrolur. Üç deneme
hakkı **yoktur** — diğer başarısızlıklardan farklı olarak.

---

## 5. Onay kontrolleri

### 5.1 Komut grameri bir güvenlik kontrolüdür (M105)

> [!WARNING]
> **Gerçek bulgu:** Jira'da **"`/approve` etmiyorum"** yazınca **kapı geçiyordu.**
> Türkçede olumsuzlama sonda gelir ve analiz/yorum dili Türkçedir (M59). Bu, pilotun
> ilk haftasında olacak bir hataydı.

Bugünkü kural: argüman almayan komutlar (`/approve`, `/status`, `/ai-explain`,
`/ai-start`, `/ai-takeover`) **yorumun tamamı** olmak zorundadır. Satırda veya alt
satırlarda ek metin varsa komut işlenmez ve kullanıcıya uyarı yazılır.

> [!WARNING]
> **İkinci gerçek bulgu:** **yorum düzenleyip başkası adına onay verilebiliyordu.**
> Düzenleyen ≠ yazar, yani görev ayrılığı (4 göz) tamamen atlanıyordu.
>
> Bugün: yalnız **düzenlenmemiş** `comment_created` olayları komut üretir.

### 5.2 Üyelik doğrulaması iddiaya güvenmez

Kapı kararındaki `actorGroup` alanı bir **iddiadır**. Doğrulama, Jira'nın
`group/member` ucundan **gerçek üyelik** okunarak yapılır ve `recordGateDecision`
`GATE_OWNER`'a karşı **yeniden kontrol eder** — sahte bir `actorGroup` geçemez.

Bu yüzden servis hesabının **global "Browse users and groups" izni** gerekir
([`jira-baglama.md`](jira-baglama.md) §2.3). Bu izin yoksa **hiçbir onay kabul
edilemez** — fail-closed.

### 5.3 Onaylayan oturumdan alınır, gövdeden asla

Studio yolunda `signatureSeq` ve `actorUserId` istek gövdesine yazılırsa **yok
sayılır**. Testlidir.

### 5.4 AI kapı kapatamaz

Üç bağımsız katman:

1. **`GateDecision.source`** yalnız `jira` | `studio` alabilir; bir MCP oturumu
   ikisini de üretemez.
2. **BFF**: `ai-via:` oturumu kapı ucunda **403** alır.
3. **Audit zinciri**: `GATE_APPROVE`/`GATE_REJECT` için insan olmayan aktörü reddeder.

Ayrıca `maestro-mcp`'nin `MaestroPlatform` arayüzünde **kapı kararı veren bir metot
yoktur** — var olmayan bir şey çağrılamaz.

> [!WARNING]
> `mcp-servers` paketinde bir **isim emniyet ağı** vardır (`forbidden-tools.ts`) ama
> rapor bunun bir **garanti olmadığını açıkça geri alır**: doğrulayıcı 48 eşdeğer
> addan **47'sini** ağdan geçirdi (`close_gate`, `sign_off`, `set_run_status`,
> `signal_workflow`…). Gerçek garanti yukarıdaki **yapısal** iki maddedir. Emniyet
> ağının satın aldığı tek şey, o adlardan birine uzanan bir bakımcının erken uyarı
> almasıdır.

### 5.5 4-göz, parametre değişikliklerinde de geçerlidir

`guarded` parametreler (`scan.block_level`, `killswitch.state`, `merge.mode`…) **tek
imzayla uygulanmaz**:

1. Birinci kişi öneri bırakır → **202 `pending`**
2. **Farklı** ikinci kişi **aynı değeri** onaylar → **200 `applied`**
3. Aynı kişinin ikinci basışı hâlâ `pending`; farklı değerle onay **409**

Değer karşılaştırması `canonicalize` ile yapılır (anahtar sırası fark yaratmaz).

> [!WARNING]
> **Gerçek bulgu (B1):** "farklı kişi" karşılaştırması naif yapılıyordu ve **4-göz
> tek kişiyle atlatılabiliyordu** — delegasyon token'ıyla verilen onay ikinci göz
> sayılıyordu. Bugün karşılaştırma `humanBehind()` üzerindendir: `ugur@corp` ile
> `ai-via:ugur@corp` **tek çift gözdür**.

---

## 6. Kill switch (M58)

| Seviye | Ne durur | Ne durmaz |
|---|---|---|
| `intake_only` | Yeni iş alımı | Başlamış koşular |
| `all` | **Her şey** — sandbox'lar güvenli söndürülür | **Kapılar bekler kalır** |

Erişim: rol `admin` + **insan kanalı** + **audit**. `killswitch.state` **guarded**'dır:
`off`'a dönmek çift onay ister.

> [!WARNING]
> **Gerçek bulgu (K1 — kritik):** kill switch **merge'i durdurmuyordu.** Son kapı
> onayı alındıktan sonra `mergePullRequest` → `buildEvidencePackage` → `closeTicket`
> zinciri kontrolsüz koşuyordu. Sistemdeki **tek geri alınamaz eylem** acil
> durdurmayı dinlemiyordu.
>
> **Gerçek bulgu (K2 — kritik):** kill sonrası **tüm adım zinciri** koşmaya devam
> ediyordu (taramalar, incelemeler, test koşumları — hepsi yeni sandbox işi), çünkü
> kontrol yalnız döngü başlarındaydı.
>
> **Gerçek bulgu (K3):** `intake_only` **tamamen ölüydü** — yazılıyor, hiç
> okunmuyordu. Sessiz fail-open.
>
> Üçü de kapatıldı. Bugün kontrol `goto()` içindedir (her adım geçişinde) ve 13.
> adımdan hemen önce ayrıca koşar; negatif iddialı testlerle çivilenmiştir.

`all` seviyesinde bile `/approve` ve `/reject` **kabul edilir**: açık bir kapıda
bekleyen insanı ortada bırakmak olayı büyütür.

---

## 7. Sır yönetimi (M6/M80)

### 7.1 Vault birincil, `env-file` yalnız dev

| Sürücü | Üretimde |
|---|---|
| `vault` (KV v2 + AppRole) | ✅ varsayılan |
| `env-file` | ❌ **kurucuda reddedilir** |
| `cyberark`, `azure-keyvault` | **HENÜZ YOK** (M80 — kurum ürünü belli olunca) |

### 7.2 Fail-closed davranışlar

| Durum | Sonuç |
|---|---|
| İzin listesi dışı mount | **İstek yapılmadan** `SecretPermissionDeniedError` |
| Bozuk anahtar/kapsam | **İstek yapılmadan** `SecretKeyError` |
| Alan yok **veya boş string** | `SecretNotFoundError` — *boş secret = yer tutucu = yok* |
| TTL tavanın üstünde | **Reddedilir**, kırpılmaz |
| Vault'un verdiği lease tavanın üstünde | `SecretTtlError` — **tavan verilen lease'i de bağlar** |
| `lease_duration` yok | `VaultResponseError` — **tahmin edilmez** |
| `lease_duration <= 0` | `SecretExpiredError` — süresi dolmuş kimlik asla dönmez |
| `addr` https değil | Yapılandırma reddedilir; üretimde kaçış anahtarı **çalışmaz** |
| Login yanıtında `client_token` yok | `VaultResponseError`; iptal edilmiş token **yeniden benimsenmez** |

İzin listesi **tam eşleşmeyle** uygulanır: `["kv"]` izni `kvault/…`, `kv-root/…` veya
`KV/…` için geçerli **değildir**.

### 7.3 Sır sızıntısını engelleyen disiplinler

| Yol | Kontrol |
|---|---|
| Hata metinleri | Hata ne sorulduğunu (konteyner adı, imaj, durum kodu) söyler; işin `env`'ini veya komut yükünü **asla taşımaz** |
| Yanıt gövdeleri | Hiçbir tipli hata Vault yanıt gövdesini taşımaz |
| Alt süreçler | Üretilen test süreci ortam değişkenlerini **miras almaz** — API anahtarı çocuk sürece geçmez |
| Bellek | Önbellek değerleri `#private` alanda |
| PII maskeleme | Sır kalıpları da maskelenir |

> [!WARNING]
> **Gerçek bulgu:** **SMTP parolası hata mesajından geri çözülebiliyordu** — base64
> biçimi maskelenmiyordu.

### 7.4 Kısa ömürlü git kimlikleri (M31)

`SecretPort.issueShortLived(scope, ttl)` ile push kimliği TTL'li verilir. Tavan hem
istenen TTL'e hem **Vault'un verdiği lease'e** uygulanır.

### 7.5 Parola politikası (MVP lokal kimlik — M8)

| Kural | Değer |
|---|---|
| Minimum uzunluk | 12 |
| Karmaşıklık | Büyük + küçük + rakam + simge |
| Kullanıcı adı içeremez | ✅ |
| **Maksimum 72 bayt** | bcrypt 72 bayttan sonrasını **sessizce yok sayar** — "kabul edildi" ile "kontrol ediliyor" aynı cümle kalsın diye |
| Oturum | 256-bit token, **mutlak 8 saat** (kayan değil) |
| Eşzamanlı oturum | Hesap başına 5; sınırda **en eski** düşer (kullanıcı kendi hesabından kilitlenemez) |
| Çıkış | O kullanıcının **TÜM** oturumlarını sonlandırır |

> [!WARNING]
> **Gerçek bulgu (B4 — zamanlama oracle'ı TERSİNE):** bilinmeyen hesapta bir bcrypt
> karşılaştırması "yakılıyordu", ama **sabit cost 10**'a sabitlenmişti; üretim
> `rounds` ise 12. Yani oracle kapanmıyor, **büyütülüyordu**: olmayan hesap var
> olandan **~4 kat hızlı** dönüyordu (390.9 ms / 98.1 ms). Ayrılan bir çalışanın
> hesabının silinip silinmediği ölçülebiliyordu.
>
> Düzeltme sonrası ölçüm: var olan hesap **321.8 ms**, olmayan hesap **310.3 ms** →
> **1.04x**. Oracle kapandı ve `rounds` değişince kırılan bir test var.

> [!WARNING]
> **Gerçek bulgu (B2):** **hesap kapatma ve rol iptali görülmüyordu** — `active:false`
> yapılmış bir hesap `GET /runs`'a 200 alıyordu. Bugün rol/grup üyeliği **her
> istekte** dizinden tazelenir; oturum yalnız bir önbellektir.

---

## 8. MCP kapsamları ve yasaklı araçlar

### 8.1 Ajan MCP'leri yetki filtrelidir

`jira-mcp`, `ado-mcp` ve `workspace-mcp` ajanlara sunulur ve hepsi **yetki
filtrelidir**.

| Kontrol | Ne yapar |
|---|---|
| Kapsam mühürleme | Kapsam dizisi bağlandıktan sonra **`push` ile genişletilemez** (`sealCaller`) |
| Yol kapısı | `search_workspace` dahil **tüm** dosya erişimi korumalı yol kapısından geçer |
| Sır dosyaları | Okunamaz listesi uygulanır |
| Audit sırası | **Etki, audit yazımından SONRA gerçekleşir** |
| Kapsam dışı çağrı | Audit satırı **yazılır** (sessizce SDK'da ölmez) |
| PII sınırı | `maestro-mcp` çıktıları PII sınırından geçer |

> [!WARNING]
> Bunların hepsi bulunmuş açıklardır:
> - **B1** — audit **fail-open**: etki, audit yazımından **önce** gerçekleşiyordu.
> - **B2** — kapsam dizisi canlı referanstı; bağlandıktan sonra `push` ile
>   **genişliyordu**.
> - **B5** — `search_workspace` yol kapısından **hiç geçmiyordu**.
> - **B8** — kapsam dışı çağrı SDK'da ölüyordu, **audit satırı yoktu**.
> - **B9** — `maestro-mcp` çıktıları **PII sınırından geçmiyordu**.

### 8.2 Ajan ortamının izolasyonu

> [!WARNING]
> **Gerçek bulgu:** **müşteri repo'sunun ayar dosyaları ajan ortamında
> yükleniyordu.** Repo'ya kötü bir yapılandırma koyan biri, banka sunucusunda kod
> çalıştırabilirdi.

> [!WARNING]
> **Gerçek bulgu (ters yön):** **ajan kendi çalışma alanına yazamıyordu.** Kaçış
> yolu açıkken asıl işini yapamıyordu. Güvenlik, işlevi bozarak sağlanmaz.

### 8.3 Ajan oturumunun veri sınıfı çağırandan gelir

`AgentSessionOptions.dataClass` **zorunlu** bir alandır ve varsayılana düşmez.

> Yanlış sınıf = veri sızıntısıdır, bir yönlendirme tercihi değil.

---

## 9. Denetim izi ve kanıt (M33/M34/M56)

### 9.1 Özellikler

| Özellik | Değer |
|---|---|
| Zincir | SHA-256, **tek yazarlı** (yalnız worker aktivitesi) |
| Anchor | **Günlük** — zincir başı ayrı bir yere imzalanır |
| Dış kopya | **CEF/syslog → SIEM** (sistem-bağımsız format) |
| Saklama | **10 yıl** |
| WORM | Opsiyonel — `object_lock: compliance` (M57) |

### 9.2 Ne yakalanır

| Saldırı | Tespit |
|---|---|
| Kayıt silme | `sequence_gap` (kaç kayıt eksik dahil) |
| Kayıt değiştirme | `prev_hash_mismatch` |
| Baştan silme | Yakalanır |

> [!WARNING]
> **Gerçek bulgu:** **denetim izinin ilk kayıtları silinince "iz bütün" deniyordu.**
> Zincirin tek işi bunu yakalamaktı.

### 9.3 Kanıt paketi bütünlüğü

`buildEvidencePackage` **zinciri önce doğrular**; kırıksa **paket üretilmez**.

> [!WARNING]
> **Gerçek bulgu:** **"yayınlandı" makbuzu, belge hiç yazılmamışken de
> üretiliyordu** — kanıt paketinde sahte kayıt.

> [!WARNING]
> **Gerçek bulgu:** **değiştirilemez arşiv, bir ayar kaldırılınca silinebiliyordu.**
> 2036'ya kadar korumalı olması gereken kanıt tek komutla gidiyordu.

### 9.4 `signatureSeq` zincirden gelir

Kapı kararı önce zincire yazılır, dönen `seq` imza numarası olur. İmza, denetçinin
göremediği bir sayaçtan değil **zincirin kendisinden** gelir.

---

## 10. Webhook güvenliği (M15)

| Kontrol | Uygulama |
|---|---|
| İmza | **HMAC-SHA256, ham gövde üzerinde**, sabit zamanlı karşılaştırma |
| Sıra | Doğrulama, gövde **ayrıştırılmadan önce** |
| Başarısızlık | **401** — imzasız da, bozuk gövde de |
| Ham gövde korunması | Webhook rotaları kendi kapsülleme bağlamında buffer parser kullanır |
| Replay | Timestamp-nonce koruması |
| IP | Kısıt |
| Ortam | **Her ortamda fail-closed** |

> [!IMPORTANT]
> `JSON.parse` → `JSON.stringify` turundan geçmiş bir gövde **bir daha asla
> doğrulanamaz**. Ayrı bir test bunu çiviler.

Ek sertleştirmeler:

- **Gövde boyutu limiti** testlidir (eskiden Fastify varsayılanına bırakılmıştı).
- **Doğrulanmamış Jira `author` alanı 500 üretemez** (B6): eşlenemeyen aktörde 202 +
  katalog mesajı döner. Gerekçe: Jira **5xx'i yeniden dener**, yani tek bozuk bir
  yorum sonsuz teslimat fırtınasına dönerdi; ayrıca 500/202 farkı ayrıştırıcının iç
  durumunu sızdırıyordu.
- **Bağlanmamış projede hiçbir şey yazılmaz** (B5): `/status` bile bilgi sızdırmaz,
  yazım hatası düzeltilmez — yoksa hangi projeleri izlediğimiz sızardı.

---

## 11. Yetkilendirme (BFF)

| Uç | Yetki |
|---|---|
| `GET /runs`, `GET /runs/:ticket`, sinyaller | **Proje üyeliği**: `maestro-<projectkey>` grubu ya da `admin`/`tech-lead` |
| `GET/PUT /params` | `admin` veya `tech-lead` — **rolsüz hesap okuyamaz da** |
| `POST /killswitch` | `admin` + insan kanalı + audit |
| `/healthz`, `/readyz` | Auth **yok** (probe'un kimliği yoktur, iş verisi taşımazlar) |
| Diğer tüm REST uçları | Auth **zorunlu** |

`GET /runs` **süzülür** (başkasının koşusu listede görünmez); `GET /runs/:ticket`
üyelik yoksa **403** döner ve **üyelik kontrolü koşu aramasından ÖNCE** yapılır —
aksi halde 404/403 farkı bir ticket oracle'ına dönerdi.

> [!WARNING]
> **Gerçek bulgu (B3):** **yetkilendirme katmanı hiç yoktu.** Rolsüz bir "stajyer"
> hesabı başkasının ticket'ını `full_auto` yapabiliyordu.

### 11.1 Sinyal beyaz listesi

`POST /runs/:ticket/signals/:name` yalnız üçünü kabul eder: `gateDecision`,
`clarificationAnswered`, `modeChange`.

| Dışarıda bırakılan | Neden |
|---|---|
| `ciResult` | Build kararı yalnız imzalı Service Hook'tan gelir ve kökenini taşır (M106). **Giriş yapmış herkesin yeşil CI üretebilmesi kabul edilemez** |
| `killSwitch` | Kendi ucu, kendi rol kontrolü, kendi audit aksiyonu var |
| `prChangesRequested` | PR yorumu bir **ADO olayıdır**; bir Studio düğmesi uyduramaz |

### 11.2 Her yeni uç korumalıdır

Testte rota listesi **sabittir**: token'sız ve sahte token'la her uç 401 döner. Yeni
bir uç korumasız geçemez.

---

## 12. Ağ konumu ve dış bağlantılar

| Yön | Kural |
|---|---|
| **İçeri** | Windows/macOS runner'ları için **port açılmaz** — makineler outbound bağlanır (M22) |
| **Dışarı** | Tek çıkış: egress proxy, allow-list'li, **tüm çıkışlar loglu** (M26) |
| Kurum proxy'si | Maestro'nunki ona **zincirlenebilir** (M64) |
| Kullanıcı erişimi | Ters vekil arkasından, dışarıya yalnız 443 |

---

## 13. Uyum ve denetim için hızlı referans

| Denetim sorusu | Cevap | Nerede |
|---|---|---|
| "Bu kodu kim onayladı?" | İmzalı kapı kararları, zincirdeki sıra numarasıyla | Audit zinciri + kanıt paketi |
| "AI kendi kendine onayladı mı?" | **İmkânsız** — üç bağımsız katman | §5.4 |
| "Aynı kişi hem yazıp hem onayladı mı?" | **İmkânsız** — SoD hard-check | §5.5, [`mimari.md`](mimari.md) §3.3 |
| "Kişisel veri buluta gitti mi?" | PII sınırı + veri sınıfı politikası; journal maskeli | §Bilinen sınırlar |
| "Kayıtlar değiştirilebilir mi?" | Hash zinciri + günlük anchor + SIEM dış kopya | §9 |
| "Ne kadar saklanıyor?" | **10 yıl** (M56); WORM opsiyonel | §9.1 |
| "Acil durumda kontroller gevşiyor mu?" | **Hayır** — break-glass Maestro **dışındadır** (M73) | §14 |
| "Prod'a çıkabilir mi?" | **Hayır** — Maestro merge'e kadar gelir | [`../README.md`](../README.md) §1 |

---

## 14. Break-glass = insan-only (M73)

> [!IMPORTANT]
> Acil işler **Maestro DIŞINDA**, normal ADO yoluyla yapılır. Maestro yalnız olay
> sonrası **retro-kayıt** üretir.
>
> "Tek onaylı hızlı AI yolu" teklif edildi ve **reddedildi**. Gerekçe: acil durumda
> kontrolü gevşetmek, kontrolün kendisini anlamsız kılar — ve saldırganın hedefi tam
> olarak "acil durum" senaryosunu üretmektir.

---

## 15. Bilinen sınırlar — dürüst liste

Bunlar gizlenmemiştir; raporlarda yazılıdır ve burada tekrarlanır:

| Sınır | Detay |
|---|---|
| **Gömülü PII kodlamaları** | base64, HTML-entity, sıfır-genişlik ve fullwidth karakterlerle gömülü PII bugün **yakalanmaz** (B-14/B-15) |
| **mac/Windows izolasyonu** | Konteyner izolasyonu yok; M25 telafi seti + **kabul edilen risk kaydı** |
| **`GATE_OWNER` parametrik değil** | Kapıyı farklı **türde** bir sahibe yönlendirmek bugün mümkün değil; ikinci proje onboard edilmeden önce yazılmalı (D7) |
| **Proje üyeliği adlandırma kuralı koda gömülü** | `maestro-<projectkey>` kuralı; doğrusu `JiraBinding`'e `memberGroups` alanı eklemek (B3'ün geçici kısmı). Kurumun AD şeması uyuşmuyorsa bu bulgu **yeniden açılır** |
| **Çok worker'lı idempotency** | Bugün süreç-içi guard; çok worker'lı dağıtım tablo destekli guard ister. Worker açılışta **uyarır** (D6) |
| **S3 WORM hata eşlemesi** | Gerçek uç 403 + `AccessDenied` döner, kilide özgü kod yoktur; uydurma kod yazılmadı |
| **Gerçek sistem sınırı** | Kurum proxy'si, sertifikalar ve sürüm farkları **erişim günü** Aşama-0 duman testinde kapanır. Bugünkü doğrulama, kayıtlı gerçek yanıt fikstürleriyle **%95 sınırındadır** |
| **AD/LDAP kimlik yok** | MVP lokal hesap; arayüz hazır, sürücü **HENÜZ YOK** |
| **Redis yok** | M4 kararı var, hiçbir pakette Redis istemcisi **yazılmadı** |

---

## 16. Doğrulama modeli — bu bulgular nasıl bulundu

Her paketi, **onu yazmayan bağımsız bir ajan** denetledi. Doğrulayıcı önce spec'i
okur, sonra kodu derler, testleri **kendi koşar** ve v1 hata listesiyle düşmanca
inceler:

- Ölü yol var mı — yazılmış ama hiçbir yerden çağrılmayan kod?
- **Fail-open var mı** — doğrulama hatasında sessiz geçiş?
- Halüsinasyon entegrasyon — çağrılan uç/alan gerçekten fikstürde var mı?
- Test gerçek mi — assert'süz/tautolojik test, gevşetilmiş assertion?
- ID/anahtar tutarlılığı — üreten ile tüketen aynı anahtarı mı kullanıyor?
- Auth — her yeni uç kimlik doğruluyor mu?
- Spec dışına taşma?

**Sonuç: 14 paketin 14'ü bulgu aldı. 7'si "kaldı" verdi. Hepsi testleri yeşilken.**

> [!IMPORTANT]
> **Ortak nokta:** bulguların neredeyse tamamı **testlerin taklit ettiği sınırın
> ötesinde** yaşıyordu — gerçek konteynerin içinde, gerçek aracın çıktısında, gerçek
> Docker motorunda, gerçek Postgres'te.
>
> Bu yüzden kritik yerlerde artık taklit değil **gerçek koşum** vardır: 23 testlik
> sandbox kaçış bataryası, 10 gerçek-araç tarama duman testi, çapraz paket sözleşme
> testleri ve gerçek Postgres'e karşı koşan testler.

Ayrıca her düzeltmenin **önce kırılan bir testi** yazıldı ve düzeltmeden önce eski
kodda **gerçekten kırıldığı ölçüldü**. Bir düzeltme turunda iki test eski kodda da
geçiyordu, yani hiçbir şey kanıtlamıyorlardı — ikisi de bulguyu gerçekten hedefleyecek
şekilde sertleştirildi.

---

## 17. Netleştirilecek açık maddeler

1. **Gizli veri sınıfı politikası** — `dataclass.policy` kurulumda **kurumun uyum
   ekibi** tarafından doldurulacak (M63). `degrade_ai_assist` / `block` /
   `masked_cloud` seçimi yapılmadı.
2. **WORM kullanılacak mı?** — kurumun S3-uyumlu ürünü `object_lock: compliance`
   destekliyor mu (M57)?
3. **SIEM hedefi** — CEF/syslog üretiliyor, ama hangi toplayıcıya, hangi dosya
   yoluna/porta düşeceği kurumla netleşmeli.
4. **Kurum AD grup adları** — `product-owners`, `tech-leads`, `qa` varsayılan
   adlarıdır; kurumun gerçek grup adları ve `maestro-<projectkey>` üyelik kuralının
   AD şemasıyla uyumu doğrulanmalı.
5. **İki ek Jira izni** — M102 listesinde yoktu, kurumun izin talebine eklenmeli:
   **global "Browse users and groups"** (verilmezse **hiçbir kapı doğrulaması
   yapılamaz**) ve **"Edit Own Comments"** (verilmezse ticket yorum spam'ine döner).
   Verilemezse alternatif tasarım gerekir — karar orkestratörde.
6. **Egress proxy allow-list'inin son hâli** — hangi LLM uçları, hangi paket
   registry'leri, ADO Services modda mı?
7. **Gömülü PII kodlamaları** (base64 vb.) ne zaman kapatılacak — kabul edilen risk
   mi, backlog kalemi mi?
8. **mac/Windows izolasyon riski** — M25 telafi seti kurumun güvenlik ekibince
   **resmen kabul edilmeli** (bugün "kabul edilen risk kaydı" olarak duruyor).
9. **Penetrasyon testi / bağımsız güvenlik denetimi** planlanmadı.

---

## 18. Kaynaklar

| Bölüm | Kaynak |
|---|---|
| §2 fail-closed | masterplan M35 · `packages/config/src/env.ts` · ilgili paket RAPOR'ları |
| §3 sandbox | `packages/runners/RAPOR.md` §1-2 · `src/sandbox.ts` · `src/provision.ts` · `src/config.ts` · masterplan M21-M27 |
| §3.8 mac/win telafi | masterplan M25 |
| §4 korumalı yollar | `packages/execution/src/protected-paths.ts` (dosya yorumları: B3, B4, B6) · masterplan M52/M53 |
| §5.1 komut grameri | `packages/adapter-jira/src/commands.ts` · `RAPOR.md` §8 · masterplan M105 |
| §5.2-5.4 onay kontrolleri | `packages/workflows/src/gates.ts` · `apps/bff/RAPOR.md` §Komut yolu · `packages/mcp-servers/RAPOR.md` §0 |
| §5.5 4-göz | `apps/bff/RAPOR.md` §B1 · `packages/audit` (`humanBehind`) |
| §6 kill switch | `packages/workflows/RAPOR.md` §0 (K1-K3) · `packages/db/src/params-defaults.ts` · masterplan M58 |
| §7 sır yönetimi | `packages/secrets/RAPOR.md` §1 · `apps/bff/RAPOR.md` §Kimlik + B4 · masterplan M6/M8/M80 |
| §8 MCP | `packages/mcp-servers/RAPOR.md` §0 (B1-B9) · masterplan M37/M101 |
| §9 denetim | `packages/audit/RAPOR.md` · masterplan M33/M34/M56/M57 |
| §10 webhook | `packages/adapter-jira/src/webhook.ts` · `apps/bff/RAPOR.md` §Webhook uçları + B5/B6/B7 · masterplan M15 |
| §11 yetkilendirme | `apps/bff/src/routes/*.ts` · `apps/bff/RAPOR.md` §REST + B2/B3 · masterplan M86 |
| §14 break-glass | masterplan M73 |
| §15 bilinen sınırlar | `packages/pii/RAPOR.md` §7 · `packages/storage/RAPOR.md` §5 · `packages/workflows/RAPOR.md` §D6/D7 · `apps/bff/RAPOR.md` §3b |
| §16 doğrulama modeli | `plan/insa-plani.md` §5 · `plan/GECE-RAPORU.md` |

---

## 19. Doküman kontrolü

| Versiyon | Tarih | Değişiklik |
|---|---|---|
| v1.0 | 09.08.2026 | İlk yayın — Dalga 1-3 doğrulama turlarının bulguları ve kapatma durumları dahil edildi |

| Rol | Ad / Ekip | Tarih | İmza |
|---|---|---|---|
| Hazırlayan | Maestro doküman ajanı | 09.08.2026 | |
| Kontrol eden | | | |
| Onaylayan | | | |
