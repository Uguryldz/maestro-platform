# Gece Raporu — Dalga 1 ve Dalga 2 tamamlandı

> 2026-08-08 gecesi → 2026-08-09 sabahı. Uğur uyurken yapılanlar.
> Tek cümle: **iki dalga da kapıdan geçti, 19 paket, 2195 test yeşil.**

## Nerede duruyoruz

| Dalga | Durum |
|---|---|
| 0 — Temel (sözleşmeler, portlar, dil kataloğu) | ✅ bitti, arayüzler donuk |
| 1 — Çekirdek (db, Jira, ADO, LLM geçidi, depolama, secret, PII, denetim izi) | ✅ **kapı geçti** |
| 2 — Yürütme (sandbox, ajan koşucusu, hafıza, bildirim, yayınlama, tarama) | ✅ **kapı geçti** |
| 3 — Beyin (Temporal akışı, BFF, MCP'ler, ajan rolleri) | sırada |
| 4 — Yüzey (Studio ekranları, runner daemon'ları, kurulum) | bekliyor |

**Rakamlar:** 19 paket + demo uygulaması · ~28.000 satır üretim kodu · **2195 test** · `pnpm gate` 40/40 (önbelleksiz) · 88 commit.

## Sabah ilk iş: demoyu izle

```bash
cd /home/ubuntu/coder/maestro
pnpm -F @maestro/demo start      # sonra tarayıcıda http://localhost:7010
```

Solda Jira görünümü ve `/approve` kutusu, sağda Maestro'nun iç işleyişi. Ticket yaz →
analiz gelsin → onayla → kod yazılsın → PR açılsın → onayla → merge.

Jira ve ADO **sahte** (yerel sunucular, gerçek adaptörlerimizin konuştuğu uçlar),
model **gerçek**. Kurum erişimi gerekmiyor.

## Doğrulama bilançosu — asıl haber bu

Her paketi, onu yazmayan bağımsız bir ajan denetledi.
**14 paketin 14'ü bulgu aldı. 7'si "kaldı" verdi. Hepsi testleri yeşilken.**

Bulunan ve düzeltilen gerçek kusurlardan bir seçki:

| Ne bulundu | Neden önemliydi |
|---|---|
| Jira'da "`/approve` etmiyorum" yazınca kapı geçiyordu | Türkçede olumsuzlama sonda gelir; pilotun ilk haftasında olacak hata |
| Yorum düzenleyip başkası adına onay verilebiliyordu | Görev ayrılığı (4 göz) tamamen atlanıyordu |
| **Sandbox'tan root olunabiliyordu** | Kullanıcı kimliği metin karşılaştırılıyordu; `00:0` kontrolü atlatıyordu |
| **Sandbox host ağını görebiliyordu** | Konteynerden sunucudaki MySQL, Redis, DNS listelendi |
| Sandbox dışarıya doğrudan çıkabiliyordu | "Yalnız vekil üzerinden" kuralı sadece tavsiyeydi |
| Ajan kendi çalışma alanına yazamıyordu | Kaçış açıkken asıl işi yapamıyordu |
| **Müşteri repo'sunun ayar dosyaları ajan ortamında yükleniyordu** | Repo'ya kötü yapılandırma koyan biri banka sunucusunda kod çalıştırabilirdi |
| **Gizli veri 3 ayrı yoldan buluta çıkabiliyordu** | Biri: ajanın ikinci denemesi maskesiz gidiyordu |
| **Sır tarayıcısı gerçek araçla hiç çalışmıyordu** | Her tarama hata dönecekti; güvenlik kapısı hiçbir işi geçirmeyecekti |
| **Boş klasör taranınca 3 tarayıcı da "temiz" diyordu** | Mount yanlışsa kapı sıfır kapsamla açılıyordu |
| Denetim izinin ilk kayıtları silinince "iz bütün" deniyordu | Zincirin tek işi bunu yakalamaktı |
| "Yayınlandı" makbuzu, belge hiç yazılmamışken de üretiliyordu | Kanıt paketinde sahte kayıt |
| Analizdeki ham kişisel veri git geçmişine kalıcı commit ediliyordu | Git'ten silmek neredeyse imkânsız |
| Boşluklu TCKN ve küçük harfli IBAN maskelenmiyordu | "TC: 123 456 789 50" insanların gerçekten yazdığı biçim |
| SMTP parolası hata mesajından geri çözülebiliyordu | base64 biçimi maskelenmiyordu |
| Değiştirilemez arşiv, bir ayar kaldırılınca silinebiliyordu | 2036'ya kadar korumalı kanıt tek komutla gidiyordu |

**Ortak nokta:** bulguların neredeyse tamamı **testlerin taklit ettiği sınırın ötesinde**
yaşıyordu — gerçek konteynerin içinde, gerçek aracın çıktısında, gerçek Docker
motorunda. Bu yüzden artık kritik yerlerde taklit değil gerçek koşum var:

- `runners`: 23 testlik **kaçış bataryası** (gerçek konteyner içinden root olmayı, ağa
  çıkmayı, salt-okunur kökü aşmayı, docker soketine ulaşmayı dener)
- `scanners`: 10 **gerçek-araç duman testi** (gerçek gitleaks/semgrep/trivy imajları)
- `publish` ↔ `adapter-jira`: **çapraz paket sözleşme testi**
- `db`: gerçek Postgres'e karşı koşan testler

## Gece verdiğim kararlar

| Karar | Gerekçe |
|---|---|
| **M107** — abonelik bağlantısı yerel Claude oturumunu sürer, API anahtarı değil | Senin talebin; makinede kurulu CLI kullanılıyor |
| Kilit dosyaları PR kapısında **işaretlenir**, oturum ortasında bloke edilmez | Aksi halde sıradan bir sürüm yükseltmesi imkânsız olurdu (M53'ün lafzı) |
| Eskalasyon merdiveninin **tek kaynağı veritabanı** | Pakette ikinci bir varsayılan vardı; ikisi ayrışmıştı |
| Yayınlamada maskeleme **port seviyesinde**, sürücülerde değil | Yeni bir hedef eklenince unutulamaz |
| Confluence'ta **ticket başına tek yaşayan sayfa** | İnsanların Confluence'ı kullanma biçimi bu |
| Kanıt dosyası adları reddedilmez, **kodlanır** | "rapor özet.pdf" gibi Türkçe adlar meşru |
| Ajan oturumunun veri sınıfı **çağırandan gelir**, varsayılana düşmez | Yanlış sınıf = veri sızıntısı, yönlendirme tercihi değil |

Ayrıca `pnpm gate` diye ayrı bir komut var artık: dalga kapısı **asla önbellekten
okumaz**. İlk koşumda "yeşil" görüp sonra önbelleğin bir hatayı sakladığını fark ettim.

## Senden bekleyenler (hiçbiri acil değil)

1. **Demoyu izle** — yukarıdaki komut. Rahatsız olduğun bir şey varsa M-kararına dönüşür.
2. **OpenRouter anahtarını iptal et** — sohbet geçmişinde düz metin geçti; yenisini üret.
   (`maestro/.env`'de duruyor, git'e girmedi.)
3. **`hazirlik.md`** listesi — erişimler ve bilgi paketi. Hâlâ hiçbiri Dalga 3'ü bloklamıyor.

## Sırada ne var

Dalga 3: Temporal iş akışı (19 adım + kapılar + sinyaller — iskeletini ben yazacağım),
BFF (webhook + REST + auth), MCP sunucuları, ajan rolleri/promptları.
Bu dalganın sonunda **Aşama 1 demosu** var: 19 adımın tamamı, hafıza, denetim izi.
