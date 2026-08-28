# HANDOFF

## DURUM
**1.0.8 canlıda, yedi servis de sağlıklı.** `uguryldz/maestro-node:1.0.8` ve
`uguryldz/maestro-studio:1.0.8` Docker Hub'da. Çalışma ağacı temiz.

## Bu turda çıkan imajlar
- **1.0.7** — panel ve keşif düzeltmeleri (parametre menüsü, JQL bare-id, adım sütunu,
  "işleme alındı" yorumu, saniyelik tarama aralığı, sihirbazda bağlı projeler)
- **1.0.8** — keşif turu artık kendini bildiriyor (aşağıda)

## 1.0.8'in tek düzeltmesi: sessiz tur
1.0.7 canlıya alındıktan sonra ölçüldü: tarama açık, altı kural etkin, bağlantı yeşil —
ve logda keşiften **tek satır yok**. `discoverOnce` yalnız ticket alınınca ya da hata olunca
yazıyordu; her eşleşmenin zaten `WorkflowRun` satırı varsa sağlıklı tur hiçbir şey basmıyor.

Sonuç: **çalışan tarama ile hiç başlamamış tarama logda birebir aynı görünüyordu.** Durum ucu
(`/studio/listening-status`) biliyor ama oturum istiyor; operatör önce loga bakar.

Artık her tur konuşuyor. Canlı kanıt:
`[keşif] tur bitti: 6 kural arandı, 0 ticket alındı, 14 eşleşme görüldü`
Yani Jira'ya gidiyor, 14 ticket buluyor, hepsi zaten koşulmuş olduğu için yenisini başlatmıyor.

## Canlıda doğrulanan
- Parametre menü girdisi panelde (`navKey:"nav.params"` bundle içinde)
- Tarama aralığı **panelden** geliyor: param 20 sn → ölçülen tur arası **21 sn**
  (`ParamVersion.jira.discover_seconds`, sürüm 3)
- nginx `/api/` yolu çalışıyor (401 = oturum istiyor, doğru davranış)
- BFF açılış logu: `jira ticket keşfi açık (300000 ms)` — boot varsayılanı, ilk turdan sonra
  panel değeri devralıyor

## Testler
deploy 808/808 · tsc temiz. Diğerleri 1.0.7 turunda yeşildi: bff 920, studio 405,
db 231 (+10 atlandı), config 26. Turbo'nun toplu koşusu bu makinede YÜK yüzünden ALAKASIZ
paketleri kırmızı gösterebiliyor — düşen paketi TEK BAŞINA koştur.

## Sıradaki iş
- **Bağlantı testi gerçek bir tamamlama çağrısı yapmalı.** Şu an `/models` çağırıyor: kredisi
  bitmiş OpenRouter anahtarı testi GEÇİYOR, sonra koşu 2. adımda 403 ile takılıyor. Canlıda
  bir kez yaşandı. Kullanıcı kararı bekliyor.
- **Bot hesabını sil**: `User` tablosunda `712020.b836c135-…@corp`, `maestro-admins` üyesi
  (dört-göz muafiyeti). **Bankaya giderken SİL.**

## Tuzaklar
- `pkill -f "src/bin/worker.ts"` kendi kabuğunu vurur; `\.ts` diye kaçır.
- Jira Cloud auth **Basic** (`email:token`), DC **Bearer** — iki ayrı sürücü.
- JQL'de hesap kimliği **tırnaksız** ve `in (...)` içinde olmalı; `assignee = "712020:…"`
  sessizce boş döner.
- `ParamVersion` sütunları: `key, scopeRef, version, valueJson, guarded, changedBy,
  approvedBy, at` — `changedAt`/`status` YOK.
- BFF host'a port yayınlamaz; panele `http://127.0.0.1:7000/api/...` üzerinden git.
- `unbound` sessizliği KASITLI (M102) — bug sanıp "düzeltme".
- Canlı `/login`'e dokunma; launcher restart oturumu düşürür.
