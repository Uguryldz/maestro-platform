# Maestro — canlı demo (`@maestro/demo`)

**Nasıl izlerim? (5 satır)**

1. `maestro/.env` içinde `OPENROUTER_API_KEY=...` satırı olsun (dosya git'e girmez).
2. Depo kökünde bir kez `pnpm install`, sonra `pnpm -F @maestro/demo start`.
3. Tarayıcıdan **http://localhost:7010** adresini aç, sağ üstteki **▶ Akışı başlat**'a bas.
4. Sol taraf Jira'dır: analiz yorumu gelince alttaki kutuya `/approve` yazıp gönder — sonra PR yorumu gelince bir kez daha.
5. Sağ taraf Maestro'nun içidir: adımlar ve kayıtlar orada akar; akış merge ile biter.

Durdurmak için terminalde `Ctrl-C`.

---

## Bu demoda ne gerçek, ne sahte?

| Parça | Durum |
|---|---|
| Jira | **SAHTE** — bilgisayarında çalışan taklit sunucu (`localhost:7011`) |
| Azure DevOps | **SAHTE** — taklit sunucu (`localhost:7012`) |
| Yapay zeka modeli | **GERÇEK** — OpenRouter üzerinden `openai/gpt-4o-mini` |
| Analiz, kod, testler | **GERÇEK** — model üretir, testler gerçekten çalıştırılır |
| Kişisel veri maskeleme | **GERÇEK** — `@maestro/pii` maskeler, gidiş yolunda tekrar taranır |
| Denetim izi | **GERÇEK** — `@maestro/audit` hash zinciri, sonunda doğrulanır |
| Temporal, sandbox, gerçek git push | **YOK** — sonraki dalgalarda |

Sahte sunucular gerçek adaptörlerle konuşur: Jira yorumu yazıldığında **imzalı** webhook
gider, ADO build sonucu **basic-auth'lu** Service Hook olarak gelir. İmza veya yetki
yanlışsa Maestro reddeder — demoda da öyle.

## Ekranda ne göreceksin

```
ticket okundu → analiz üretildi → [İNSAN: /approve] → kod yazıldı → tarama →
testler koştu → PR açıldı + CI → [İNSAN: /approve] → merge + denetim izi
```

Senin yaptığın iki şey var: ticket zaten yazılmış durumda, sen sadece iki kez
`/approve` yazıyorsun. Gerisi akıyor.

## Bir adım patlarsa

Ekranda kırmızı görünür ve akış durur. Başarı taklit edilmez. Sık görülen iki gerçek
durum:

- **Tarama patlar:** model ürettiği kodun içine örnek e-posta koyarsa, kişisel veri
  taraması bunu yakalar ve iş modele geri gönderilir (en fazla 3 tur).
- **Test düşer:** üretilen test gerçekten koşar; çıkış kodu 0 değilse hata metni
  ekrana yazılır ve düzeltme turu başlar.

## Sık sorulanlar

- **Para harcıyor mu?** Bir koşu tipik olarak 3-4 model çağrısıdır (~3.000 token,
  ucuz model). Ekranda çağrı ve token sayacı görünür.
- **Anahtarım nereye gidiyor?** Sadece `maestro/.env` dosyasında durur, koda gömülü
  değildir, ekrana/loga yazılmaz, üretilen test sürecine de geçirilmez.
- **Portlar dolu derse?** 7010/7011/7012 portlarını kullanan eski bir süreç vardır;
  onu kapatıp tekrar başlat.

## Geliştirici notları

- Kod yalnız `apps/demo` altındadır; `packages/*` hiç değiştirilmedi.
- Sözleşme testleri (`pnpm -F @maestro/demo test`) sahte sunucuların gerçek adaptörlerle
  konuştuğunu kanıtlar ve ağa çıkmaz — model çağrıları testte taklit edilir.
- Ayrıntılar ve bilinen sınırlar: [`RAPOR.md`](RAPOR.md).
