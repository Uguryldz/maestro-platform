# Maestro — İlk Koşu Kılavuzu

*"İş analizimi almak istiyorum" — ticket açmaktan analiz çıktısına*

| Hazırlayan | Tarih | Versiyon | Kapsam |
|---|---|---|---|
| Maestro doküman ajanı | 09.08.2026 | v1.0 | Zihinsel model · canlı demo koşusu (bugün çalışan yol) · gerçek Jira akışı (hedef yol) · analiz belgesinin bölümleri · onay ve ret · ticket yazma önerileri |

> **Kime:** PO, iş analisti, geliştirici, QA — Maestro'yu ilk kez kullanacak herkes.
> **Ön koşullar:** Jira projeniz Maestro'ya bağlanmış olmalı
> ([`jira-baglama.md`](jira-baglama.md)). Kendi makinenizde denemek için
> [`kurulum.md`](kurulum.md) yeterlidir.
> **Süre:** okuma ~10 dk; demo koşusu ~2 dk.

Bu doküman iki yol anlatır:

| Yol | Ne | Bugün çalışıyor mu |
|---|---|---|
| **A — Canlı demo** (§2) | Kendi makinenizde, sahte Jira/ADO + **gerçek model** | ✅ **Evet** |
| **B — Gerçek Jira akışı** (§3) | Kurum Jira'sında gerçek ticket | ⚠️ Kısmen — [§3.0](#30-önce-dürüstlük-bu-yol-bugün-uçtan-uca-koşmuyor)'a bakın |

---

## 1. Önce zihinsel model

```
Sen Jira'ya ticket yazarsın
        ↓
Maestro okur — eksik varsa YORUMLA SORAR (form yok)
        ↓
Analiz yazar ve Jira'ya yorum olarak koyar
        ↓
Sen /approve dersin          ← burada karar sendedir
        ↓
Kod yazılır, taranır, testler GERÇEKTEN koşar
        ↓
ADO'da PR açılır, build validation koşar
        ↓
QA ve Tech Lead onaylar      ← burada da karar insanda
        ↓
Merge + kanıt paketi
```

**Prod'a hiçbir şey çıkmaz.** Release kurumun kendi sürecidir.

Rolünüze göre nerede duracağınız:

| Rol | Nerede çalışırsınız | Studio'ya girmeniz gerekir mi |
|---|---|---|
| **PO / iş tarafı** | Jira'dan hiç çıkmazsınız | ❌ Hayır |
| **Geliştirici** | Jira + ADO (PR incelemesi ADO'da) | ❌ Hayır |
| **QA** | Jira (kapı onayları yorumla) | ❌ Hayır |
| **Admin** | Studio | ✅ Evet |

---

## 2. Yol A — canlı demoyu koşturmak

Bugün **uçtan uca çalışan tek yol** budur. Kurum erişimi gerektirmez.

### Adım 1 — Model anahtarını koy

```bash
# maestro/.env dosyasına tek satır (dosya git'e girmez):
OPENROUTER_API_KEY=sk-or-...
```

> [!NOTE]
> Anahtar yalnız `maestro/.env` dosyasında durur; koda gömülü değildir, ekrana veya
> loga yazılmaz ve **üretilen test sürecine geçirilmez** (çocuk süreç ortam
> değişkenlerini miras almaz).

### Adım 2 — Başlat

```bash
cd maestro
pnpm -F @maestro/demo start
```

Anahtar yoksa demo **sessizce sahte başarı üretmez**, gürültüyle durur:

```
Demo başlatılamadı: OPENROUTER_API_KEY bulunamadı.
maestro/.env dosyasına OPENROUTER_API_KEY=... satırını ekleyin.
```

*(Bu çıktı bu depoda gerçekten koşturularak doğrulanmıştır.)*

### Adım 3 — Tarayıcıyı aç

**http://localhost:7010**

| Port | Ne |
|---|---|
| 7010 | Demo arayüzü |
| 7011 | **Sahte** Jira |
| 7012 | **Sahte** Azure DevOps |

Ekran ikiye bölünmüştür:

- **Sol taraf = Jira görünümü** — ticket, yorumlar ve altta bir yorum kutusu.
- **Sağ taraf = Maestro'nun içi** — adımlar, defter kayıtları, model çağrı sayacı,
  denetim izi.

### Adım 4 — Akışı başlat ve iki kez onayla

1. Sağ üstteki **▶ Akışı başlat**'a basın. Ticket zaten yazılıdır.
2. Sol tarafta **"📋 Analiz hazır"** yorumu belirince, alttaki kutuya **`/approve`**
   yazıp gönderin.
3. Kod yazılır, taranır, testler koşar, PR açılır, CI yeşile döner.
4. PR yorumu gelince bir kez daha **`/approve`**.
5. Akış merge ile biter ve denetim zinciri doğrulanır.

**Sizin yaptığınız tek şey iki `/approve`.** Gerisi akar.

Durdurmak için terminalde `Ctrl-C`.

### Adım 5 — Ne gördüğünüzü anlayın

Bu tabloyu demonun kendi raporundan alıyoruz — hangi parçanın gerçek olduğu önemlidir:

| Parça | Durum |
|---|---|
| Jira | ❌ **SAHTE** — yerel taklit sunucu (7011) |
| Azure DevOps | ❌ **SAHTE** — yerel taklit sunucu (7012) |
| Yapay zeka modeli | ✅ **GERÇEK** — OpenRouter üzerinden |
| Analiz, kod, testler | ✅ **GERÇEK** — model üretir, testler gerçekten çalışır |
| Kişisel veri maskeleme | ✅ **GERÇEK** — `@maestro/pii` maskeler, gidiş yolunda tekrar taranır |
| Denetim izi | ✅ **GERÇEK** — `@maestro/audit` hash zinciri, sonunda doğrulanır |
| Webhook imzası | ✅ **GERÇEK** — HMAC-SHA256, ham gövde üzerinden |
| CI köken doğrulaması | ✅ **GERÇEK** — `reason: pullRequest` + allow-list |
| Temporal, hardened sandbox, gerçek git push | ❌ **YOK** — sonraki dalgalarda |

> [!IMPORTANT]
> Sahte sunucular **gerçek adaptörlerimizle** konuşur. Jira'ya yorum yazılınca
> **imzalı** webhook gider; ADO build sonucu **basic-auth'lu** Service Hook olarak
> gelir. İmza veya yetki yanlışsa Maestro reddeder — demoda da öyle. Yani taklit
> olan karşı taraftır, bizim tarafımız değil.

Bilerek taklit olan üç yer:

1. **Merge** — Maestro merge etmez (insan-merge kararı). Demo, ADO ekranındaki
   "Complete" tıklamasını sizin yerinize yapar, log'a `(demo)` etiketiyle yazar ve
   Maestro sonucu `getPrStatus` ile **doğrular**.
2. **Sandbox** — hardened konteyner yok. Üretilen dosyalar geçici bir dizine yazılır,
   testler `node` ile gerçekten çalıştırılır.
3. **Git push / gerçek diff** — yok. ADO'da dal ve PR gerçek API çağrılarıyla açılır
   ama kod bir depoya itilmez.

### Adım 6 — Bir şey patlarsa

Ekranda kırmızı görünür ve akış durur. **Başarı taklit edilmez.** Sık görülen iki
gerçek durum:

- **Tarama patlar:** model ürettiği kodun içine örnek e-posta koyarsa kişisel veri
  taraması bunu yakalar ve iş modele geri gönderilir (en fazla 3 tur).
- **Test düşer:** üretilen test gerçekten koşar; çıkış kodu 0 değilse hata metni
  ekrana yazılır ve düzeltme turu başlar.

### Maliyet

Bir koşu tipik olarak 3-4 model çağrısıdır (~3.000 token, ucuz model). Ekranda çağrı
ve token sayacı görünür.

---

## 3. Yol B — gerçek Jira'da iş analizi almak

### 3.0 Önce dürüstlük: bu yol bugün uçtan uca koşmuyor

> [!WARNING]
> Aşağıdaki adımlar **tasarlanmış ve kodlanmış** akıştır; her adımın koddaki
> karşılığı vardır ve testlidir. Ama **bugün gerçek bir Jira ticket'ıyla uçtan uca
> koşturulamaz**, çünkü şunlar **HENÜZ YOK**:
>
> - `apps/bff/src/main.ts` — BFF'in çalıştırıcı kökü (paket `buildServer(deps)`
>   verir, sürücüleri bağlayan kök yazılmadı)
> - `apps/worker` — Temporal worker uygulaması
> - `deploy/` — compose dosyaları, Dockerfile'lar
> - `apps/studio` — Studio arayüzü
> - Gerçek Jira/ADO erişimi (kurum erişimi gelmedi; contract testler kayıtlı gerçek
>   yanıt fikstürleriyle koşuyor)
>
> Bu bölümü **hedef kullanıcı deneyimi** olarak okuyun. Bugün denemek için Yol A'yı
> kullanın.

### 3.1 Ticket'ı açın — serbest metin yeterli

Jira'da normal bir ticket açın. **Zorunlu alan dayatılmaz** (M98): özel alan yok,
şablon zorunluluğu yok, form yok. Ne istediğinizi yazın.

Projeniz **opt-in** modundaysa (pilot varsayılanı) ikisinden birini yapın:

- Ticket'a **`maestro`** etiketini ekleyin, **veya**
- Yoruma **`/ai-start`** yazın.

Projeniz `otomatik` modundaysa hiçbir şey yapmanıza gerek yok.

### 3.2 Maestro okur ve eksikse sorar

Dakikalar içinde ilk yorum gelir. İki ihtimal var:

**a) Bilgi eksikse — soru sorar (adım 2b).**

Maestro yorumla sorar, siz yorumla cevaplarsınız. Form doldurmazsınız.

> [!IMPORTANT]
> **Uydurma yasaktır.** Bilmediğini sormak zorundadır. Bu bir temenni değil, kodda
> uygulanan bir kuraldır: analiz belgesindeki her iddianın **Kaynaklar** bölümünde
> bir dayanağı olmalıdır ve dayanak, role gerçekten gösterilen bağlamda geçmelidir.
> Bağlamda olmayan referans = uydurma → **analiz reddedilir**, kapıya bile gelmez.

Bu bekleme **süresizdir**. Otomatik ret yoktur, zaman aşımı bir karara dönüşmez.
Yalnız hatırlatıcılar eskale eder (24s → 72s → 7g, parametrik).

**b) Bilgi yeterliyse** doğrudan analize geçer.

### 3.3 Repo keşfi ve analiz (adım 3ö, 3)

Kısa bir **salt-okunur** ajan oturumu repo'yu gezer. Sonra analist rolü, kurumun
şablonuna göre analiz belgesini yazar ve Jira'ya yorum olarak koyar.

Varsayılan şablon şu bölümleri içerir (Studio'dan değiştirilebilir — M108):

| Bölüm | Ne içerir |
|---|---|
| Amaç | İşin neden yapıldığı |
| Kapsam | Neyin dahil, neyin hariç olduğu |
| **Etki matrisi** | Platform × modül — hangi uygulamalar etkileniyor |
| Kabul kriterleri | Ne zaman "bitti" sayılacağı |
| Ekran/API değişiklikleri | Somut arayüz etkisi |
| Test yaklaşımı | Nasıl doğrulanacağı |
| Risk ve geri dönüş planı | Ters giderse ne olacağı |
| **Kaynaklar** | Her iddianın dayanağı: hangi dosya, hangi repo kartı, hangi knowledge dokümanı, ticket'ın hangi cümlesi |
| **Netleştirilecek açık maddeler** | Cevaplanmamış / ertelenmiş sorular |

> [!NOTE]
> Son iki bölüm M109 ile eklendi ve ikisi de **zorunludur**. "Netleştirilecek açık
> maddeler" boş olabilir ama **var olmak zorundadır** — "açık madde yok" bilinçli bir
> cevaptır, sessizlik değil. Amaç: PO onay verirken neyin açık kaldığını görsün ve
> belge "her şeyi biliyorum" numarası yapmasın.

Analiz belgesi ayrıca üç kalite taramasından geçer: yer tutucu metin (`TODO`, `TBD`,
`...`, `-`), içeriksiz cevap ve kaynaksız iddia **reddedilir** — model düzeltme turuna
girer.

### 3.4 Onaylayın (adım 4 — PO kapısı)

Analiz yorumunun altına **tek başına**:

```
/approve
```

> [!WARNING]
> **Yorumda başka hiçbir metin bulunamaz.** `"/approve etmiyorum"` gibi bir yorum
> komut **sayılmaz** ve size neden sayılmadığı yazılır. Türkçede olumsuzlama sonda
> geldiği için bu kural bir güvenlik kontrolüdür (M105).

Beğenmediyseniz:

```
/reject Etki matrisinde mobil tarafı eksik, ugurmobil-android da etkileniyor
```

Gerekçeniz ajana **aynı oturumda** iletilir — sıfırdan başlamaz, kaldığı yerden
düzeltir. İlk haftalarda ret **normaldir**.

> [!NOTE]
> Aynı kapıdan **3 ret** olursa iş otomatik olarak insana devrolur (M54), tüm bağlam
> ve defter kayıtlarıyla birlikte. Sonsuz döngü yoktur.

Onayınız doğrulanır:

- **Grup üyeliği** — gerçekten PO grubunda mısınız? (Jira'dan sorulur, iddiaya
  güvenilmez)
- **SoD** — 4. kapıyı imzalayan kişi 5. kapıyı **imzalayamaz** (M32)
- **İnsan kanalı** — bir AI aracı sizin token'ınızla kapı kapatamaz

Doğrulama tutmazsa kapı **açık kalır** ve size sebebi yazılır. Sessiz geçiş yoktur.

### 3.5 Sonrası — analizden fazlasını istemiyorsanız

Kodun da Maestro tarafından yazılmasını istemiyorsanız:

```
/mode-change human_lead
```

Analiz sizde kalır, kodu insan yazar, Maestro izlemeye geçer.

> [!WARNING]
> **Bu komut bugün koşu ortasında reddedilir.** Sinyal ulaşır, workflow açıkça
> reddeder ve defterine yazar. Work mode koşunun **başında** çözülür (adım 0);
> ortada değiştirmek `human_lead` dalının tüm adımlarını yeniden tanımlamayı
> gerektirir ve bu bir **ürün kararıdır**. Bugünkü davranış: sessizce yutmaz,
> açıkça reddeder.

### 3.6 Tam akışa devam

`/approve`'dan sonra Tech Lead kapısı (5), sonra geliştirme, tarama, testler, PR ve
kalan kapılar gelir. Adım adım tablo: [`../README.md`](../README.md) § 2.

---

## 4. Ticket'ınızı nasıl yazarsanız daha iyi analiz alırsınız

Bunlar zorunluluk değil, gözlemdir:

| Yapın | Yapmayın |
|---|---|
| Ne istediğinizi **iş diliyle** yazın | Çözümü siz tasarlamaya çalışmayın |
| Hangi ekranı/akışı etkilediğini söyleyin | "Bilirsin işte" tarzı ima bırakmayın |
| Kabul kriteriniz varsa yazın | Zorunlu değil — Maestro sorar |
| Bug ise **nasıl üretildiğini** yazın | Bug akışı zaten repro-first çalışır (M67) |
| İlgili ticket/PR linki verin | |

> [!NOTE]
> **Bug ticket'ları farklı akar** (M67): analiz yerine kısa teşhis raporu üretilir,
> **önce hatayı üreten başarısız test** yazılır, sonra fix. Test yeşile dönünce kanıt
> hazırdır. Kapı seti otomatik olarak düşük/orta seçilir.

---

## 5. Kalıcı iyileşme nasıl olur

> [!IMPORTANT]
> **Otomatik öğrenme yoktur.** Maestro sizin retlerinizden kendi kendine öğrenmez
> (bu bilinçli bir kapsam dışı kalemidir). Kalıcı iyileşme **Knowledge kütüphanesine**
> içerik eklemekle olur:
>
> - **Analiz şablonu** — kurumunuzunki
> - **2-3 örnek geçmiş analiz** — "bizde böyle yazılır" örneği (few-shot)
> - **Kodlama standartları**
> - **Repo kartları** — her uygulamanın modül özeti; onboarding'de AI keşfeder, siz
>   düzeltirsiniz, her merge'te tazelenir
> - Güvenlik politikası, süreç dokümanları — geldikçe, versiyonlu

Knowledge yönetimi Studio'dan yapılır → **HENÜZ YOK** (`apps/studio` yazılmadı).

---

## 6. Sonraki adımlar

- Bir şey ters giderse → [`operasyon-runbook.md`](operasyon-runbook.md)
- Nasıl çalıştığını merak ediyorsanız → [`mimari.md`](mimari.md)
- "Bu güvenli mi?" → [`guvenlik.md`](guvenlik.md)
- Kısa cevaplar → [`sss.md`](sss.md)
