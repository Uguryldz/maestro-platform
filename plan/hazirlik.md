# MAESTRO — "Başla" Öncesi Hazırlık Listesi (Uğur'un listesi)

> Teknik olmayan özet + toplanacaklar. Plan: [`masterplan.md`](masterplan.md) (M1–M102).
> Hiçbiri "başla"yı bloklamaz — eksik olan pilotta ret oranını artırır, sistemi bozmaz.

## Maestro tek paragrafta
Jira = işin istendiği yer. ADO = kodun durduğu yer. Maestro ikisinin arasındaki işçi:
ticket'ı okur → eksikse sorar → analiz yazar → **insan onaylar** → kodu sandbox'ta yazar →
testleri **gerçekten koşturur** → ADO'ya PR bırakır → **insan onaylar** → merge.
**Prod'a hiçbir şey çıkarmaz** — main'e temiz, testli, onaylı kod bırakır; release kurumun kendi sürecidir.

## Sistemler nerede durur, nereden girilir?
Hepsi tarayıcıdan girilen web siteleri; bilgisayara kurulum yok (geliştiricinin git/IDE'si hariç).

| Sistem | Kimin ürünü | Nerede kurulu | Nereden girilir | Ne yapılır |
|---|---|---|---|---|
| **Jira** | Atlassian | Kurum sunucusu (Data Center) | tarayıcı → `jira.ugurbank.local` gibi iç adres | Ticket yazılır, `/approve` yorumla verilir |
| **ADO** = **Azure DevOps** (eski adı TFS) | Microsoft | **Server**: kurum içi sunucu (bankalarda yaygın) · **Services**: Microsoft bulutu (`dev.azure.com`) — M11 çift-mod: ikisi de desteklenir | tarayıcı | Repo, PR inceleme/onay, build sonucu |
| **Maestro** | bizim yazacağımız | Kurum içi Linux sunucu, Docker | tarayıcı → `maestro.ugurbank.local` (Studio = maketteki ekranlar) | İzleme, parametreler, knowledge — günlük kullanıcı girmek zorunda değil |

Kim nereye bakar: **PO/iş tarafı** yalnız Jira · **geliştirici** Jira + ADO (PR onayı) + IDE'si · **sen (admin)** ağırlıkla Maestro Studio.

## A. Erişimler (kurumdan istenecekler)
- [ ] Jira DC servis hesabı: Browse + Comment + Edit(label) + Assign + Create/Link Issue (M102)
- [ ] Jira admin'den TEK global webhook (bir kez — M102)
- [ ] ADO servis hesabı/PAT: repo read-write + PR + Service Hooks (M11)
- [ ] Pilot repo'larda branch policy: min 1 reviewer + force-push kapalı + build validation (M12)
- [ ] Ağ: Maestro sunucusundan Jira/ADO/LLM uçlarına erişim (Aşama 0'ın ilk işi doğrulama script'i)
- [ ] LLM: abonelik hesap(lar)ı (Claude öncelikli — M55) ve/veya API anahtarı

## B. Bilgi paketi (AI'nin "eğitimi" — Knowledge kütüphanesine yüklenecek)
- [ ] **Analiz şablonu**: kurumunki varsa dosyası; yoksa M43'teki 7 bölümlük şablonla başlanır
- [ ] **2-3 örnek geçmiş analiz** (beğenilen) — "bizde böyle yazılır" örneği (few-shot)
- [ ] **Kodlama standartları** (varsa; yoksa dil topluluk standartları kullanılır, not düşülür)
- [ ] **Her uygulamanın 3-5 cümlelik tanıtımı** (ne işe yarar, kritik modülleri ne) — repo kartlarının tohumu; gerisini AI keşifle çıkarır, sen düzeltirsin (M100)
- [ ] (Opsiyonel) güvenlik politikası, UI kılavuzu, süreç dokümanları — geldikçe eklenir, versiyonlu

## C. Kararlaştırılmış ama senden onay/veri bekleyenler
- [ ] Pilot ekip + sprint tarihi (M79: ugurpay + ugurweb, 1 sprint)
- [ ] Kapı sahipleri: PO / TL / QA kim (AD grupları veya isimler — M32/M51)
- [ ] Veri sınıfı: pilotta kod cloud LLM'e maskeli çıkabilir mi? (M18/M63 — uyum ekibi yoksa senin kararın)
- [ ] `protected_paths` ilk listesi: AI'nin dokunmayacağı dizinler (ödeme çekirdeği vb. — M52)

## D. Beklenti ayarı (dürüst notlar)
- İlk haftalarda analiz retleri NORMAL — ret aynı oturumda düzeltilir; kalıcı iyileşme knowledge'a doküman/örnek eklemenle olur (otomatik öğrenme v2).
- Maestro merge'e kadar sorumludur; prod hatası riskini düşüren şey kapılar + gerçek test + CI'dır, sıfırlamaz — UAT/release süreciniz aynen kalmalı.
- "Tek soru işareti yok" = karar eksiği yok demek; Aşama 0'da kurum ortamına dokununca çıkacak fiili pürüzler (proxy, sertifika, izin) mevcut kararların içinde çözülür.
