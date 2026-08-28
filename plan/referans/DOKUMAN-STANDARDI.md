# Doküman standardı — referans belge

> Referans: [`UiPath-Orchestrator-HA-Plani-v1.0.pdf`](UiPath-Orchestrator-HA-Plani-v1.0.pdf)
> Uğur Yıldız'ın kendi hazırladığı kurum içi plan dokümanı. M103r'nin (Word/PDF
> çıktısı) ve M108'in (şablon tasarımcısı) **hedef kalitesi budur** — "şöyle bir
> şey üretebiliriz" değil, "bu seviyeyi tutturacağız".

## Belgenin taşıdığı ve bizim üretmemiz gereken öğeler

| Öğe | Referanstaki hali | Bizde karşılığı |
|---|---|---|
| **Künye tablosu** | Başlığın hemen altında tek satır: Hazırlayan · Tarih · Versiyon · Kapsam. Ayrı kapak sayfası YOK | `{{onay_tablosu}}` yerine önce **künye**; kapak opsiyonel olmalı (kısa dokümanda kapak israf) |
| **Numaralı bölümler** | `1.`, `2.`, `3.1`, `3.2`… iki seviye | Şablon tasarımcısı (M108) bölüm sırasını zaten veriyor; numaralandırma Word stilinden gelir |
| **Karşılaştırma tabloları** | Koyu lacivert başlık satırı, parametre/varsayılan/kaynak · seçenek A-B-C artı/eksi | `TabloStili` — beklenen biçim olarak "tablo" seçilen bölümler buraya render olur |
| **Mimari şekiller + altyazı** | `Şekil 1 — Sentinel modu mimarisi` · kutular, oklar, veri merkezi grupları | Etki matrisi ve akış şemaları için gerekli; **bugün yok** (aşağıya bak) |
| **Uyarı/not kutuları** | Sarı zeminli "Destek notu:" · mavi sol çizgili italik alıntı kutusu | Risk/varsayım vurguları için şart |
| **Kod blokları** | Gri zemin, monospace, gerçek konfig satırları | Analizdeki API/konfig örnekleri için |
| **Kaynakça** | `12. Kaynaklar` — hangi iddia hangi resmi dokümana dayanıyor, tarihli | **En kritik eksiğimiz** (aşağıya bak) |

## Referanstan çıkan iki şablon kararı

Belgenin bölüm listesi bizim 7 bölümlük analiz şablonumuzda **olmayan** iki bölüm içeriyor
ve ikisi de bir AI'nin yazdığı analizde bizimkilerden daha değerli:

**1. "Kaynaklar" bölümü (izlenebilirlik).**
Referansta her teknik iddia bir kaynağa bağlanmış (üretici dokümantasyonu, sürüm, tarih).
AI'nin yazdığı bir analizde bu **denetim gereği**: "bu kabul kriterini nereden çıkardın?"
sorusunun cevabı belgede durmalı — hangi dosya, hangi repo kartı, hangi knowledge dokümanı,
ticket'ın hangi cümlesi. Uydurma iddiayı yakalamanın en ucuz yolu bu.

**2. "Netleştirilecek açık maddeler" bölümü.**
Referansta 8 madde: ürün seçimi, ölçüm sonuçları, bakım penceresi… Yani belge
"her şeyi biliyorum" numarası yapmıyor, **bilmediğini listeliyor**. Bizim akışta
clarification (2b) analizden ÖNCE sorulur; ama cevaplanmamış/ertelenmiş maddeler
analiz belgesinde görünmeli — PO onay verirken neyin açık kaldığını görsün.

Bu iki bölüm **varsayılan şablona** eklenecek (M108 tasarımcısında ekleme/çıkarma serbest).

## Bugün eksik olan: şekil üretimi

Referansın en güçlü tarafı mimari şekilleri. Bizim üretebileceğimiz karşılıkları:
**etki matrisi** (platform × modül), **akış/adım şeması**, **fan-out ağacı** (ana ticket →
alt ticket'lar). Bunlar bugün metin/tablo olarak var, şekil olarak yok.

Karar: Word/PDF sürücüsü (M103r) şekilleri **SVG olarak** üretsin ve belgeye gömsün;
kaynak veri zaten yapılandırılmış (etki matrisi bir dizi, fan-out bir ağaç). Dış kütüphane
gerekmez, `.docx` SVG'yi taşır. Şekil altyazısı `Şekil N — …` biçiminde otomatik numaralı.
Dalga 4 kalemi.
