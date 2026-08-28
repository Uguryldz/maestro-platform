# Maestro dokümantasyonu — doküman haritası

| Hazırlayan | Tarih | Versiyon | Kapsam |
|---|---|---|---|
| Maestro doküman ajanı | 09.08.2026 | v1.0 | Kurulum, kullanım, operasyon, mimari ve güvenlik dokümantasyonunun haritası |

**Kaynak:** `plan/masterplan.md` (M1–M109) + depodaki kod + paket raporları
(`packages/*/RAPOR.md`) + `mock/index.html` yardım görünümü.
**Biçim:** `plan/referans/DOKUMAN-STANDARDI.md` ve referans belge
`UiPath-Orchestrator-HA-Plani-v1.0.pdf` (okundu) — künye tablosu, numaralı bölümler,
koyu başlıklı karşılaştırma tabloları, uyarı kutuları, kod blokları, **Kaynaklar** ve
**Netleştirilecek açık maddeler** bölümleri, doküman kontrolü tablosu.

---

## Dokümanın altın kuralı

Bu dokümanlardaki her cümlenin ya kodda ya masterplan'da bir karşılığı vardır.
Henüz yazılmamış olan her şey **HENÜZ YOK** etiketiyle işaretlenmiştir. Bu etiketi
gördüğünüz yerde ilgili özellik **bugün çalışmaz** — planlanmıştır, yazılmamıştır.
Tam liste: [`RAPOR.md`](RAPOR.md) § "HENÜZ YOK".

---

## Hangi dokümanı okumalıyım?

| Rolünüz | Okuma sırası | Süre |
|---|---|---|
| **PO / iş analisti** | [`ilk-kosu.md`](ilk-kosu.md) → [`sss.md`](sss.md) | ~15 dk |
| **Geliştirici / Tech Lead** | [`ilk-kosu.md`](ilk-kosu.md) → [`mimari.md`](mimari.md) → [`sss.md`](sss.md) | ~45 dk |
| **QA** | [`ilk-kosu.md`](ilk-kosu.md) → [`mimari.md`](mimari.md) § kapılar | ~20 dk |
| **Platform / DevOps** | [`kurulum.md`](kurulum.md) → [`jira-baglama.md`](jira-baglama.md) → [`operasyon-runbook.md`](operasyon-runbook.md) | ~90 dk |
| **Güvenlik / uyum / denetim** | [`guvenlik.md`](guvenlik.md) → [`mimari.md`](mimari.md) → [`RAPOR.md`](RAPOR.md) | ~60 dk |
| **Mimar / ARB** | [`mimari.md`](mimari.md) → [`guvenlik.md`](guvenlik.md) → [`../plan/masterplan.md`](../plan/masterplan.md) | ~2 sa |

---

## Doküman listesi

| Doküman | Kime | İçerik |
|---|---|---|
| [`../README.md`](../README.md) | herkes | Maestro nedir, 19 adım, mimari şema, hızlı başlangıç, **bugün ne çalışıyor** |
| [`kurulum.md`](kurulum.md) | platform ekibi | Gereksinimler, sıfırdan kurulum, doğrulama komutları, on-prem senaryosu, sık hatalar |
| [`jira-baglama.md`](jira-baglama.md) | Jira/ADO admin + platform | Servis hesabı, izinler, global webhook, proje bağlama, opt-in etiketi, kuru koşum; ADO tarafı da |
| [`ilk-kosu.md`](ilk-kosu.md) | PO, geliştirici, QA | "İlk iş analizimi almak istiyorum" — ticket açmaktan analiz çıktısına, ekran ekran |
| [`operasyon-runbook.md`](operasyon-runbook.md) | operatör / nöbetçi | Kapı bekliyorsa, koşu takıldıysa, kill switch, runner düştü, kota bitti, alarm→aksiyon, yedekleme |
| [`mimari.md`](mimari.md) | mimar, geliştirici, denetim | Katman mimarisi, 19 adım detayı, kapılar ve SoD, risk kademeleri, PII sınırı, LLM egress, audit zinciri |
| [`guvenlik.md`](guvenlik.md) | güvenlik, uyum, denetim | Sandbox izolasyonu, korumalı yollar, 4-göz, kill switch, sır yönetimi, MCP kapsamları, denetim izi |
| [`sss.md`](sss.md) | herkes | Sık sorulanlar |
| [`RAPOR.md`](RAPOR.md) | orkestratör, platform | Bu doküman turunun raporu + **tam "HENÜZ YOK" listesi** |

---

## Diğer kaynaklar (bu klasörün dışında)

| Kaynak | Ne |
|---|---|
| [`../plan/masterplan.md`](../plan/masterplan.md) | **Tek doğruluk kaynağı** — M1–M109 karar kaydı |
| [`../plan/insa-plani.md`](../plan/insa-plani.md) | Dalga planı, builder+verifier modeli |
| [`../plan/GECE-RAPORU.md`](../plan/GECE-RAPORU.md) | Dalga 1-2 durum raporu, sade dille |
| [`../plan/referans/DOKUMAN-STANDARDI.md`](../plan/referans/DOKUMAN-STANDARDI.md) | Analiz belgesi kalite çıtası (M109) |
| [`../mock/index.html`](../mock/index.html) | Studio prototipi — 37 ekran; Dalga 4'ün spec'i. İçindeki **Yardım** görünümü bu dokümanların ekran karşılığıdır |
| [`../apps/demo/README.md`](../apps/demo/README.md) | Canlı demonun kendi kılavuzu |
| `../packages/*/RAPOR.md` | Paket başına ne yapıldı, ne bilerek eksik bırakıldı |

---

## Doğrulama durumu

Bu dokümanlar yazılırken depoda koşturulan komut:

```
$ pnpm run gate
 Tasks:    48 successful, 48 total
Cached:    0 cached, 48 total
  Time:    2m4.892s
```

24 paketin testleri: **2898 geçti, 40 atlandı** (atlananlar Docker/Postgres/gerçek-araç
gerektiren entegrasyon testleridir — bkz. [`kurulum.md`](kurulum.md) § "Atlanan testler").
