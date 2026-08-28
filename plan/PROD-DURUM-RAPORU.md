# MAESTRO — Prod Durum Raporu ve Eksik Envanteri
> 2026-08-10 · Uğur'un "tüm planı oku, eksikleri belirle, proda çıkacağız" isteği üzerine.
> Tüm plan dosyaları (masterplan M1-M109, prod-tamamlama, insa-plani) okunarak çıkarıldı.

## A. SENİN BUGÜN SORDUĞUN 4 ŞEYİN CEVABI

### 1. PDF neden bomboş?
GERÇEK BUG. PDF 9 sayfa ama içinde metin operatörü (`BT`) = 0. Yani pdfkit sayfaları
açıyor ama metni çizmiyor. Word DÜZGÜN, sadece PDF bozuk. Sebep: `pdf-render.ts`
DejaVu fontunu register ediyor ama `.text()` çağrıları ya boş modele düşüyor ya font
resolve sessiz başarısız oluyor. → **Düzeltilecek** (aşağıda P0).

### 2. Doküman hangi modele bağlı?
Doküman üretimi modele bağlı DEĞİL — analiz zaten üretilmiş veriden (`AnalysisDoc`)
render ediliyor. Ama ANALİZİ üreten model: **OpenRouter üzerinden `openai/gpt-4o-mini`**
(`PILOT_MODEL` varsayılanı). Yani şu an ucuz bir OpenAI modeli.

### 3. Subscription'a mı bağladın?
HAYIR. Şu an **API anahtarı** (OpenRouter `OPENROUTER_API_KEY`) kullanıyoruz —
`openai-compat` sürücüsü. Plan M55/M107 abonelik (Claude Code CLI oturumu) diyor;
kod (llm-gateway/pool.ts) VAR ama pilot onu KULLANMIYOR. Yani planladığımız
"token pahalı, subscription kullanacağım" kararı henüz devrede değil. → P1.

### 4. Ayarlar nerede?
İki yerde, ikisi de gerçek: (a) **Studio → Yönetim → Ayarlar** ekranı (bağlantılar,
kill-switch); (b) **Studio → Yönetim → Parametreler** (M71: kapı setleri, eşikler, dil,
model seçimi DB'de, versiyonlu). AMA pilot'un kendi ayarları (model, poll, onaycı grup)
ayrı bir yerde (pilot `/api/settings`) — Studio param'larıyla henüz BİRLEŞMEDİ. → P2.

---

## B. NE GERÇEK, NE DEĞİL (dürüst tablo)

| Parça | Durum | Not |
|---|---|---|
| Jira (senin siten OPS) | ✅ GERÇEK | jira-cloud sürücüsü, canlı |
| Analiz üretimi | ✅ GERÇEK | ama gpt-4o-mini, abonelik değil |
| Word üretimi | ✅ GERÇEK | Türkçe sağlam |
| PDF üretimi | ❌ BOZUK | metin çizilmiyor (P0) |
| Jira'ya attachment | ⚠️ ELLE | kod var (PublishPort), akışa bağlı değil (P0) |
| Studio yönetim ekranları | ✅ GERÇEK | Kullanıcılar/Ayarlar/Routing/Notify/Variants/Eval (Dalga A+B) |
| Studio → gerçek DB | ✅ GERÇEK | launcher liveReadModels |
| admin/admin123 + must-change | ✅ GERÇEK | ilk kurulum akışı |
| Gerçek git (GitHub sürücüsü) | ✅ KOD VAR | pilot'a bağlı ama TOKEN YOK → hâlâ fake ADO |
| Kod→PR→merge | ❌ TAKLİT | senin GitHub repo+token'ın gelince gerçek olur |
| Temporal 19-adım tam akış | ⚠️ KISMİ | packages/workflows'ta var; pilot BASİT akış kullanıyor |
| Abonelik (M55/M107) | ❌ DEVREDE DEĞİL | kod var, kullanılmıyor |
| Mac/Windows runner | ⏸ KAPSAM DIŞI | fiziksel makine (bilinçli) |
| Prod deploy (apps/deploy) | ⚠️ AYAĞA KALKMIYOR | kurum uçları (ADO/S3/LLM) fail-closed ister (M6, doğru) |

---

## C. PROD'A ÇIKMADAN ÖNCE YAPILMASI GEREKENLER (öncelik sıralı)

### P0 — Bugünkü bariz bug'lar (hemen)
1. **PDF render'ı düzelt** — metin çizilmiyor; Word gibi düzgün olmalı.
2. **Analiz üretilince Word+PDF'i OTOMATİK Jira'ya ekle** (M103r) — ben elle ekledim, akış yapmalı.
3. **M109 gömülü çizim** — analiz belgesine etki matrisi/akış şeması SVG şekil (senin "içinde çizim olsun" isteğin).

### P1 — Model & abonelik (senin "token pahalı" kararın)
4. **M55/M107 abonelik sürücüsünü pilota bağla** — Claude Code CLI oturumu, API anahtarı yerine. Model seçimi Studio param'ından (M71) okunsun.
5. **Model kalitesi** — gpt-4o-mini analiz için zayıf; abonelik Claude'a geçince kalite artar.

### P2 — Ayar birleştirme
6. **Pilot ayarlarını Studio param'larıyla birleştir** — model/onaycı grup/poll tek yerden (M71). İki ayrı ayar yeri kafa karıştırıyor.

### P3 — Gerçek uçtan uca (senin GitHub'ın gelince)
7. **GitHub repo + fine-grained PAT** (SEN vereceksin) → pilot `PILOT_SCM=github` → gerçek branch/PR/merge.
8. **Gerçek CI** (M106) — GitHub Actions/checks webhook'u ile.

### P4 — Prod altyapısı (kurum ortamına geçince)
9. **apps/deploy prod profili** — gerçek kurum uçlarıyla (Jira DC / ADO / S3 / Vault / LLM). Bugün fail-closed olduğu için ayağa kalkmıyor; bu DOĞRU, sadece uçlar lazım.
10. **Temporal tam akış** — pilot basit akış; gerçek 19-adım workflow (packages/workflows) prod'da devreye.
11. **restore tatbikatı** (M66), **SSL** (şu an HTTP), **gerçek AD/LDAP** kullanıcıları.

### P5 — Kalite & sadeleştirme (sürekli)
12. Parola politikası min 8→12 geri (prod), SoD gevşetmesini kaldır (gerçek kullanıcılar), gerçek knowledge paketi yükle.

---

## D. DÜRÜST ÖZET
Kod olarak **çok şey hazır** (25 paket, ~72k satır, 6 açık yakalandı ve kapatıldı).
Ama "prod'a çık" = kod + **kurum uçları** + **senin GitHub'ın** + **abonelik bağlama** +
**bugünkü bug'lar (PDF/attachment/çizim)**. Kod tarafı bizde; uçlar ve token sende;
bug'lar ve abonelik sıradaki iş. Mac/Windows bilinçli beklemede.
