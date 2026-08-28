# Sık sorulan sorular

> **Kime:** herkes. Sorular role göre gruplanmıştır.
> **Ön koşullar:** yok. Daha derin cevaplar için her sorunun altındaki bağlantıları
> izleyin.

---

## A. Temel sorular

### Maestro tam olarak ne yapar?

Jira'da açılan bir ticket'tan başlar; analiz yazar, kodu izole bir sandbox'ta üretir,
testleri gerçekten koşturur, Azure DevOps'ta PR açar ve merge'e kadar getirir. Her
kritik noktada bir **insan onayı** bekler.

### Prod'a bir şey çıkarır mı?

**Hayır.** Maestro merge'e kadar gelir. Release kurumun kendi sürecidir.

### İnsanın yerini mi alıyor?

Hayır — insanın **onay noktalarını** koruyarak ara işi yapıyor. Risk kademesine göre
2 ile 5 arası **onay kapısı** vardır ve hiçbiri atlanamaz. AI kendi işini onaylayamaz;
bu yapısal olarak imkânsızdır.

### Bugün çalışıyor mu?

Kısmen. 22 paket ve 2 uygulama yazıldı, **2898 test yeşil**. Ama **Studio arayüzü,
Temporal worker uygulaması, deploy dosyaları ve BFF'in çalıştırıcı kökü HENÜZ YOK**.
Bugün uçtan uca çalışan tek yol `apps/demo`'dur.

Tam liste: [`../README.md`](../README.md) § "Bugün ne çalışıyor, ne çalışmıyor".

### Nasıl deneyebilirim?

```bash
cd maestro
pnpm install
pnpm -F @maestro/demo start   # maestro/.env içinde OPENROUTER_API_KEY gerekir
# http://localhost:7010
```

Ayrıntı: [`ilk-kosu.md`](ilk-kosu.md) § 2.

---

## B. İş tarafı (PO, iş analisti)

### Jira'dan çıkmam gerekiyor mu?

**Hayır.** Ticket yazarsınız, gelen analiz yorumuna `/approve` veya
`/reject <sebep>` dersiniz. Studio'ya girmeniz gerekmez.

### Ticket'ta doldurmam gereken zorunlu alan var mı?

**Hayır** (M98). Özel alan yok, form yok, şablon zorunluluğu yok. Serbest metin
yeterlidir. Eksik bir şey varsa Maestro **yorumla sorar**.

### Analizi beğenmezsem ne olur?

`/reject <sebep>` yazarsınız. Gerekçeniz ajana **aynı oturumda** iletilir — sıfırdan
başlamaz, kaldığı yerden düzeltir. İlk haftalarda ret **normaldir**.

### Sonsuza kadar ret döngüsüne girebilir mi?

Hayır. Aynı kapıdan **3 ret** olursa iş otomatik olarak insana devrolur (M54), tüm
bağlam ve defter kayıtlarıyla. Eşik `stuck.threshold` parametresiyle ayarlanır.

### `/approve` yazdım ama kapı geçmedi. Neden?

Dört sebepten biri:

| Sebep | Anlamı |
|---|---|
| Yorumda **başka metin** var | Argümansız komutlar yorumun tamamı olmalı (M105) |
| `wrong_group` | O kapının sahip grubunda değilsiniz |
| `sod_violation` | Önceki kapıyı **siz** imzaladınız; ikinci imza farklı kişiden gelmeli |
| `not_verified` | Üyelik doğrulaması yapılamadı |

Her durumda size **sebep yazılır**; sessizce yutulmaz.

### "`/approve` etmiyorum" yazsam ne olur?

Komut **sayılmaz** ve size neden sayılmadığı yazılır. Bu bir güvenlik kuralıdır:
Türkçede olumsuzlama sonda geldiği için, naif bir ayrıştırıcı bu yorumu onay sayardı.
Bu gerçek bir bulguydu ve kapatıldı.

### Kapıyı ne kadar bekletebilirim?

**Süresiz.** 15-20 gün doğal bir süredir. Hiçbir şey otomatik onaylanmaz, hiçbir zaman
aşımı bir karara dönüşmez. Yalnız hatırlatıcılar eskale eder: 24s Jira → 72s Teams →
7g vekile devir.

### İzne çıkacağım, işler bekler mi?

Studio'da tarih aralıklı bir **delegasyon kaydı** tanımlanır (audit'li). 7 günde
otomatik delegasyon da bu kaydı kullanır. *(Delegasyon ekranı **HENÜZ YOK**.)*

### Mobilden onaylayabilir miyim?

Evet — **Jira mobil** uygulamasından yorumla `/approve` (M61). Studio responsive
olacak ama mobil-öncelikli değil.

### Analiz belgesinde ne var?

Amaç, kapsam, etki matrisi, kabul kriterleri, ekran/API değişiklikleri, test yaklaşımı,
risk ve geri dönüş planı — artı iki zorunlu bölüm:

- **Kaynaklar** — her iddianın dayanağı (hangi dosya, hangi repo kartı, hangi
  doküman, ticket'ın hangi cümlesi)
- **Netleştirilecek açık maddeler** — cevaplanmamış/ertelenmiş sorular

Şablon kurumunuzundur ve Studio'dan tasarlanır (M108).

### AI uydurabilir mi?

Uydurma **yapısal olarak reddedilir**. Her iddianın Kaynaklar bölümünde bir dayanağı
olmalı ve o dayanak, modele **gerçekten gösterilen** bağlamda geçmelidir. Bağlamda
olmayan referans = uydurma → analiz **kapıya bile gelmez**.

Ayrıca yer tutucu metin (`TODO`, `TBD`, `...`, `-`) ve içeriksiz bölümler de
reddedilir.

### Word veya PDF olarak alabilir miyim?

**HENÜZ YOK.** M103r birinci sınıf bir gereksinimdir (kurum kendi `.docx` şablonunu
yükler, Maestro analizi onun içine yerleştirir), ama `docx`/`pdf` sürücüsü
yazılmamıştır ve **kurulum anında reddedilir** — sessizce boş dosya üretmez.

---

## C. Geliştirici ve Tech Lead

### Kodu ben yazmak istersem?

`/mode-change human_lead` — analiz sizde kalır, kodu insan yazar, Maestro izlemeye
geçer.

> ⚠️ Bu komut **bugün koşu ortasında reddedilir** (açıkça, deftere yazılarak). Work
> mode koşunun başında çözülür.

### Dört work mode nedir?

| Mod | Ne demek |
|---|---|
| `full_auto` | Maestro analiz + kod + test yapar; insan onaylar |
| `ai_assist` | AI yardım eder, insan sürer |
| `human_lead` | İnsan kodlar, Maestro izler ve kanıt toplar |
| `human_only` | Maestro **hiç kapı açmaz**, yalnız kanıt kaydı üretir (M73) |

### AI hangi dosyalara dokunamaz?

`.maestro.yaml`'daki `protected_paths` listesine — artı varsayılan olarak korunanlar:
migration'lar ve `.sql` dosyaları, `.git/`, CI tanımları (**ADO dahil**), `.husky/`,
`.vscode/`, `.claude/`, `.maestro.y*ml`. Sır dosyaları ise **okunamaz** bile.

İhlal olursa akış **ilk turda** durur — üç deneme hakkı yoktur.

### Lockfile'ı değiştirebilir mi?

Evet, ama PR kapısında **işaretlenir** (M53). Bloke edilmiyor çünkü aksi halde sıradan
bir sürüm yükseltmesi imkânsız olurdu. `package.json` ve `Dockerfile` de aynı
mantıkla: düzenlemek ajanın işidir, insan kapısında işaretlenir.

### Dallanma modeli ne?

**Trunk-based**: `main` + `feature/UGURPAY-123-kisa-ad`, **squash merge**, sürüm
tag'i. Mobil store sürümleri için repo bazında `release/x.y` istisnası tanımlanabilir.
GitFlow reddedildi (AI'ın uzun ömürlü `develop` ile rebase savaşı).

### Merge'i kim yapar?

Proje bazlı parametre (`merge.mode`):

- `insan-merge` (**varsayılan**) — TL basar
- `auto-merge` — tüm kapılar + CI yeşilse Maestro

Hangi modda olunduğu **analizde yazılır**.

### Maestro CI pipeline'ı tetikliyor mu?

**Hayır.** ADO branch policy tetikler; `build.complete` Service Hook'u Maestro'ya
sinyal olarak gelir. Bankanın kendi kontrolü otorite kalır (M12).

### Sahte bir "yeşil build" ile kapı geçilebilir mi?

Hayır. Bir `build.complete` olayı kabul edilmek için **üçünü birden** sağlamalıdır:
`reason === "pullRequest"`, `{proje, repo, definitionId}` üçlüsü allow-list'te, ve
sinyalin kökeni koşunun uygulama kaydıyla eşleşmeli (M106).

Bu tam olarak kapatılmış **kritik** bir açıktı: elle kuyruğa atılmış "her zaman yeşil"
bir pipeline kapıyı geçiyordu.

### Testleri gerçekten koşturuyor mu?

Evet. Üretilen test **gerçekten çalıştırılır**; çıkış kodu 0 değilse hata metni
yazılır ve düzeltme turu başlar. Başarı taklit edilmez.

### Coverage kuralı var mı?

Sabit eşik **yok**. Kural: PR sonrası coverage **düşemez** + yeni satırlarda min %80
(M70). `coverage.ratchet` parametresiyle ayarlanır.

### Testleri zayıflatabilir mi?

Mevcut test dosyası değişiklikleri üç kategoriye ayrılır (yeni / güncelleme / silme);
**güncelleme ve silme** PR'da ayrı bir bölümde listelenir ve TL onayında açıkça
gösterilir. Assertion zayıflatma tespiti dev-reviewer promptundadır (M69).

### Bug ticket'ları farklı mı akıyor?

Evet — **repro-first** (M67): analiz yerine kısa teşhis raporu, **önce hatayı üreten
başarısız test**, sonra fix. Test yeşile dönünce kanıt hazırdır. Kapı seti otomatik
düşük/orta.

### Refactor kapsamda mı?

Evet, **davranış-koruma şartıyla** (M68): kabul kriteri "mevcut testler yeşil +
davranış değişmez". Düşük coverage'da önce karakterizasyon testi yazılır. Kapı seti
orta başlar.

### Bir işim birden çok uygulamaya dokunuyorsa?

Analizin etki matrisi birden çok uygulamaya dokunuyorsa Maestro **alt ticket'lar
açar** (M41). Her alt ticket kendi repo/runner/kapı/PR'ıyla **bağımsız bir akıştır**.
Bağımlılık sırası analizden gelir. Tüm alt işler Done olunca birleşik kanıt paketiyle
PO kapatır.

### Yeni bir proje (greenfield) başlatabilir mi?

Evet (M42): AI mimari önerisi → **insan mimari onayı** (yeni repo açma yetkisi
insanda) → otomatik kurulum → iskelet oturumu → ilk PR = iskelet, normal kapılardan
geçer.

---

## D. QA

### QA'nın kaç kapısı var?

Risk kademesine göre:

| Risk | QA kapıları |
|---|---|
| `dusuk` | yok |
| `orta` | 11 (QA sonuç onayı) |
| `kritik` | 9 (senaryo onayı) + 11 (sonuç onayı) |

### Senaryoyu onaylayan sonucu da onaylayabilir mi?

Varsayılan olarak **evet**. Ayırmak isterseniz `sod.qa_split` parametresini açın
(M92) — o zaman kapı 9'u imzalayan kapı 11'i imzalayamaz.

---

## E. Platform ve operasyon

### Ne kurmam gerekiyor?

Bugün: Node ≥ 24, pnpm 10.33.0, git. Opsiyonel: Docker (sandbox testleri), Postgres
(canlı migration testleri).

Üretim hedefi: Temporal, PostgreSQL 16+, Redis, Vault, S3-uyumlu depolama, egress
proxy. Ayrıntı: [`kurulum.md`](kurulum.md).

### Kaç ortam değişkeni var?

**Sekiz** (`packages/config/src/env.ts`), altısı üretimde zorunlu. Bunun dışındaki
her ayar ya DB parametresidir ya da paket yapılandırmasıdır. Yüzlerce env değişkeni
yoktur — bu bilinçli.

### Ayarlar nerede yaşıyor?

**Veritabanında**, Studio'dan yönetilir, versiyonlu ve audit'li (M71). 17 varsayılan
parametre vardır. `.maestro.yaml`'da yalnız repo'nun doğası gereği repo'da durması
gerekenler kalır: build/test/lint komutları, `protected_paths`, platform ipuçları.

### Eksik secret ile ayağa kalkar mı?

**Hayır.** `NODE_ENV=production` iken zorunlu bağlantı değerlerinden biri eksikse
süreç **başlamaz** (M6). "Dokümante ama yok" secret'la çalışma hatası sınıfça
kapalıdır.

### Kill switch nasıl çalışıyor?

İki seviye (M58): `intake_only` (yeni iş alınmaz, koşanlar devam eder) ve `all` (her
şey durur, sandbox'lar söndürülür, **kapılar bekler kalır**). Rol `admin` + insan
kanalı + audit gerekir; geri açmak **çift onay** ister.

Ayrıntı: [`operasyon-runbook.md`](operasyon-runbook.md) § 4.

### Kill switch merge'i de durdurur mu?

**Evet.** Bu tam olarak kapatılmış kritik bir açıktı: sistemdeki tek geri alınamaz
eylem acil durdurmayı dinlemiyordu. Bugün 13. adımdan hemen önce ayrıca kontrol edilir
ve negatif iddialı bir test bunu çiviler.

### LLM maliyeti nasıl kontrol ediliyor?

- **Abonelik havuzu** birincildir (M55/M107): maliyet dolar değil **kota/pencere**
  bazlı. Havuz doluysa iş kuyrukta bekler — maliyetsiz.
- API sürücülerinde per-workflow + aylık bütçe, %80 uyarı, **%100 stop**.
- **Bilinmeyen model = hata.** Sessiz fallback yoktur (v1'in 3× fiyat hatası buradan
  geliyordu).

### Kota bitince koşu düşer mi?

Hayır. Kota hatası `nextRetryDelay` ile **pencerenin gerçek açılma anını** taşır; koşu
o ana kadar uyur ve hiçbir maliyeti olmaz. Haftalık kota bile beklenir — "pazartesi
gel" denen bir koşu cumartesi düşürülmez.

### Yedekleme nasıl?

PostgreSQL (günlük dump + WAL), StoragePort (kurumun kendi depolama yedeği), Vault
(snapshot). Audit ve kanıt paketleri **10 yıl** saklanır.

> ⚠️ **Restore tatbikatı henüz yapılmamıştır** (Aşama 1 çıkış kriteri, M66).

### Sürüm çıkışı çalışan işleri keser mi?

Hayır. Temporal versioning ile çalışan workflow'lar **eski koduyla biter**. Sürüm
ritmi: 2 haftada bir, mesai dışı (M94).

### Kaç ticket/gün kaldırır?

Pilot hedefi 10-30 ticket/gün; mimari 100+ eşzamanlı için tasarlandı (M39).
Backpressure'da Jira'ya "queued" bildirimi gider.

---

## F. Güvenlik ve uyum

### AI kendi işini onaylayabilir mi?

**Hayır — yapısal olarak imkânsız.** Üç bağımsız katman: `GateDecision.source` yalnız
`jira`|`studio` alabilir; BFF `ai-via:` oturumuna 403 döner; audit zinciri
`GATE_APPROVE` için insan olmayan aktörü reddeder. Ayrıca `maestro-mcp`'nin
arayüzünde kapı kararı veren bir metot **yoktur**.

### Aynı kişi hem üretip hem onaylayabilir mi?

Hayır (M32). Kapı 4'ü imzalayan kapı 5'i imzalayamaz; reviewer ≠ üreten; ve
delegasyon token'ı ikinci gözü sağlayamaz (`ugur@corp` ile `ai-via:ugur@corp` **tek
çift gözdür**).

### Kişisel veri buluta gidiyor mu?

Maskelenmeden gitmez. PII sınırı LLM sınırındadır; journal ve yaşayan özet de
**maskeli yazılır** (10 yıllık kayıtta açık PII kalmaz). ReverseMap yalnız anlık
gösterimde kullanılır.

**Bilinen sınır:** base64/HTML-entity/sıfır-genişlik/fullwidth ile **gömülü** PII
bugün yakalanmaz.

### Gizli veri sınıfı ne yapıyor?

`dataclass.policy` parametresi karar verir (kurumun uyum ekibi doldurur):
`degrade_ai_assist` (varsayılan — yapan rol ai-assist'e düşer), `block` (akış durur),
veya `masked_cloud`.

### Sandbox'tan kaçılabilir mi?

Doğrulama turunda **kaçıldı** ve açıklar kapatıldı: root olunabiliyordu (metin
karşılaştırması `00:0`'ı kaçırıyordu), host ağı görülebiliyordu, doğrudan dışarı
çıkılabiliyordu. Bugün 23 testlik bir **kaçış bataryası** gerçek bir konteynerin
içinden bunları tekrar tekrar dener.

### Denetim kaydı silinebilir mi?

Silinirse **yakalanır**: SHA-256 hash zinciri `sequence_gap` ve
`prev_hash_mismatch` üretir, günlük anchor zincir başını ayrı bir yere imzalar ve
CEF/syslog kopyası SIEM'e akar. Ayrıca kanıt paketi zinciri **önce doğrular** — kırıksa
paket üretilmez.

### Acil durumda kontroller gevşer mi?

**Hayır.** Break-glass **insan-only**'dir (M73): acil işler Maestro **dışında**, normal
ADO yoluyla yapılır. "Tek onaylı hızlı AI yolu" teklif edildi ve reddedildi.

### Jira'ya eklenti kurmam gerekiyor mu?

**Hayır.** Workflow değişikliği, özel alan ve eklenti **istenmez** (M72/M98). Yalnız
tek bir global webhook ve bir servis hesabı gerekir.

> ⚠️ İki istisna: kapı yetkisini doğrulamak için servis hesabının **global "Browse
> users and groups"** iznine, tek düzenlenen durum yorumu için de **"Edit Own
> Comments"** iznine ihtiyacı vardır. İkisi de M102 listesinde yoktu; doğrulama
> turunda tespit edildi ve kurumun izin listesine eklenmelidir.

### Denetim için ne sunabilirim?

**Kanıt paketi** (M34): analiz + diff + test raporu + tarama sonuçları + imzalı onay
zinciri + maliyet → tek arşiv. Change yönetimi bağlantısı Jira üzerindendir.

---

## G. Model ve AI

### Hangi model kullanılıyor?

Konfigürasyona bağlı. Dört API sürücüsü (`anthropic-direct`, `aws-bedrock`,
`gcp-vertex`, `openai-compat`) ve bir abonelik sürücüsü (`claude-sub`) yazıldı.
Rol → model eşlemesi **tamamen konfigürasyondur**; geçiş kod değişikliği değildir.

### `claude-sub` nasıl çalışıyor?

API anahtarı **kullanmaz**: makinede kurulu **Claude Code CLI**'yi non-interaktif
modda sürer ve `--resume` ile oturumu devam ettirir (M107).

### Model kurumu nereden öğreniyor?

**Knowledge kütüphanesinden** — siz ne yüklerseniz o: analiz şablonu, 2-3 örnek geçmiş
analiz, kodlama standartları, repo kartları, güvenlik/süreç dokümanları. Hepsi
versiyonlu.

### Retlerimden öğreniyor mu?

**Hayır — otomatik öğrenme yoktur** (bilinçli kapsam dışı). Kalıcı iyileşme
Knowledge'a içerik eklemekle olur. Feedback portu veri toplar, işleme v2'dedir.

### Model değiştirmek için ne gerekiyor?

Admin önerir + **ikinci yetkili onaylar (4 göz)** + **zorunlu eval koşumu** (M78).
Regresyonda gerekçe şarttır; sürüm geçmişi ve audit tutulur.

### Ajan bağlamı kayboluyor mu?

Hayır. Üç katman: append-only ticket defteri, her adımda güncellenen yaşayan özet, ve
ajan oturum dosyaları (dönüşte `--resume`). Workspace yoksa journal + özetten
bootstrap yapılır: ~5 dk kayıp, **bağlam kaybı yok**.

Her ret ve her CI döngüsü **önceki oturumun devamıdır**.

---

## H. Dil

### Hangi dilde çalışıyor?

| Ne | Dil |
|---|---|
| Analiz, Jira yorumları, kapı özetleri | **Türkçe** (parametrik) |
| Kod, commit mesajı, PR başlığı, test adları | **İngilizce** — parametrik değil |
| Studio arayüzü | TR / EN |

### Yeni bir dil eklenebilir mi?

Evet — kullanıcıya dönük **tüm** metinler merkezi mesaj kataloğundadır
(`packages/config/locales/`). Yeni dil = katalog dosyası eklemek, kod değişikliği yok
(M104).

---

## I. "Bu neden böyle?"

### Neden bu kadar çok "HENÜZ YOK" yazıyor?

Çünkü bu doküman bir bankaya sunulacak. Var olmayan bir özelliği var göstermek,
dokümanı **zararlı** yapar. Selefimiz (Orkestra v1) tam da bu yüzden öldü: parçalar
tek tek makuldü, dokümanlar özellikleri anlatıyordu, bütün hiç çalışmadı.

### Neden bulunan güvenlik açıkları dokümanda yazıyor?

Çünkü bir kontrolün **neden** var olduğunu bilmek, o kontrolü yanlışlıkla kaldırmayı
engeller. "Bu kontrol gereksiz görünüyor, kaldıralım" cümlesinin panzehiri, o
kontrolün hangi gerçek açığı kapattığını yazmaktır.

### Neden her şey fail-closed?

Çünkü alternatifi, şüphe anında **devam etmektir** — ve bir bankanın kaynak kodunu
yazan bir sistemde şüphe anında devam etmek kabul edilemez. Maliyeti kabul edilmiştir:
Maestro durur ve bir insana sorar.

### Neden `contracts` ve `ports` donuk?

Çünkü v1'in ölüm sebebi **arayüz kaymasıydı**: üreten ile tüketen farklı anahtarlar
kullanıyordu. Donuk sözleşme bu hata sınıfını derleme zamanında kapatır. Değişiklik
yalnız orkestratör kararıyla yapılır.

### Neden `pnpm run gate` ayrı bir komut?

Çünkü turbo önbelleği bir kez gerçek bir hatayı sakladı. `gate` `--force` ile koşar ve
**asla önbellekten okumaz**.

---

## J. Nereye bakmalıyım?

| Soru | Doküman |
|---|---|
| Nasıl kurarım? | [`kurulum.md`](kurulum.md) |
| Jira'yı nasıl bağlarım? | [`jira-baglama.md`](jira-baglama.md) |
| İlk analizimi nasıl alırım? | [`ilk-kosu.md`](ilk-kosu.md) |
| Bir şey ters gitti | [`operasyon-runbook.md`](operasyon-runbook.md) |
| Nasıl çalışıyor? | [`mimari.md`](mimari.md) |
| Bu güvenli mi? | [`guvenlik.md`](guvenlik.md) |
| Neden bu karar verildi? | [`../plan/masterplan.md`](../plan/masterplan.md) |
| Bugün ne çalışmıyor? | [`RAPOR.md`](RAPOR.md) |
