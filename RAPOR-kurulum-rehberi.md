# RAPOR — Kurulum rehberi esnetildi, Jira talimatı canlı kuraldan yazıldı

## Özet
Üç sorun da düzeltildi. Rehber artık "hiç koşu yok" yerine **"kurulum tamamlanmadı"**
koşuluyla görünüyor, webhook adımı eklendi, ve yardım sayfasına Jira'da elle yapılacakları
**canlı dinleme kuralından türeten** bir bölüm kondu.

## Rehberin yeni görünme kuralı
Eski: `empty = runs.length === 0` → 16 koşu varken rehber gizliydi, kurulum eksik olmasına rağmen.

Yeni (`apps/studio/src/screens/Dash.tsx`):

    const setup = useSetupState(webhookAck);
    const setupIncomplete = !setup.loading && !setup.complete;
    const showGuide = setupIncomplete && !dismissed;

`complete = hasConn && hasBinding && hasTrainedAgent && webhookAck`. Yani **bir adım bile
eksikse, koşu sayısı ne olursa olsun** rehber görünür; hepsi bitince kendiliğinden çekilir.

Ortak kaynak: `apps/studio/src/screens/dash/setup-state.ts` (`useSetupState`). Panel ile
rehber **aynı** gerçeği okuyor — hatanın kökü ikisinin ayrı soru sormasıydı. Okuma hata
verirse adım **tamamlanmamış** sayılır (başarısız okumayı "tamam" saymak, gerçek eksiği
gizleyecek tek hata olurdu).

## "Gizle" tercihi nerede saklanıyor
`localStorage`, iki anahtar (`setup-state.ts`):

- `maestro.setup.guideDismissed` — "Anladım, gizle"
- `maestro.setup.webhookAcked` — webhook adımının kullanıcı onayı

Oturum jetonu **konmadı** (istendiği gibi). Storage kapalıysa (özel mod) `try/catch` ile
sessizce yutuluyor — tercih hatırlanmıyor, ekran çalışmaya devam ediyor.

**"Gizle" ≠ "tamamlandı":** rehber kapandığında Panel'de kısa bir not kalıyor —
*"Kurulum hâlâ eksik; başlangıç rehberi gizlendi."* + **"Rehberi göster"** düğmesi.
Kurulum gerçekten bitmişse ne rehber ne de not çıkıyor.

## Webhook adımı
4 adım → **5 adım**. Webhook 3. sıraya kondu: teslim yolu yokken eğitilmiş ajan sessiz
sistem demektir.

    bağlantılar → proje bağla → **Jira webhook'u** → ajanı eğit → izle

Webhook adımı **otomatik doğrulanamıyor** (aşağıda ARAYÜZ İSTEĞİ), o yüzden kullanıcı
onaylıyor; etiket bunu açıkça söylüyor: *"bunu Maestro doğrulayamaz, siz onaylayın"*.

## Ticket talimatının veri kaynağı
`GET /studio/listening-rules` → `ListeningRule` tablosu. Sabit metin **yok**.

`apps/studio/src/screens/help/JiraSetup.tsx` — Yardım sayfasının en üstünde
**"Jira'da ne yapmam gerekiyor?"**. Tablo canlı kuraldan doluyor: Proje · Koşul ·
Atanacak hesap · Çalışacak akış. Kural değişirse metin değişir; `enabled=false` kural
gösterilmez (tetiklemiyor); **hiç kural yoksa** "henüz dinleme kuralı tanımlı değil"
yazıyor — örnek uydurulmuyor.

**PII:** bot yalnız `accountId` ile gösteriliyor, e-posta hiçbir yerde yok; bir test
tüm ekranda e-posta deseni aramıyor olduğunu doğruluyor.

**Dikkat çeken bulgu:** bağlantının `botAccountId`'si (`712020:7ee7a2ab-…`) ile kuralın
`assigneeAccountId`'si (`712020:b836c135-…`) **farklı**. Talimat kuraldan yazıldı, çünkü
ticket'ı gerçekten tetikleyen odur. Bu ikisinin ayrışması operatörün bilmesi gereken bir
şey — ama bu görevin kapsamı dışında, ayrıca bakılmalı.

## Tarayıcı kanıtı (kendi Vite'ım :7032, BFF :7091 — paylaşılan 7000/7091 durdurulmadı)
Panel, **19 gerçek koşuyla birlikte** (Aktif 2 · Kapıda 2 · Tamamlanan 4 · Toplam 19,
"11 tanesi hatalı", OPS-25…OPS-51 listeleniyor):

- "Hoş geldiniz — Maestro'yu **5 adımda** çalışır hale getirin"
- Adım 1 ✓, 2 ✓, 4 ✓ (gerçek bağlantı/bağlama/eğitilmiş ajan), **adım 3 = "3" + "Şimdi bunu yap →"**
- Yani **rehber, koşular varken görünüyor** — düzeltilen hata tam olarak buydu.
- "Anladım, gizle" → rehber kapandı, *"Kurulum hâlâ eksik…"* notu + "Rehberi göster" kaldı.
- Sayfa yenilendikten sonra `guideDismissed = "1"` korunuyor (kalıcı).

Yardım → "Jira'da ne yapmam gerekiyor?":

    Proje: OPS
    Koşul: Ticket tipi: Görev
    Atanacak hesap (bot): 712020:b836c135-c9d3-499a-a665-aed43d362cfd
    Çalışacak akış: analiz
    URL: https://<maestro-sunucusu>/webhooks/jira
    Olaylar: Issue: created, updated · Comment: created

Canlı `ListeningRule` satırıyla birebir aynı.

## Tarayıcıda bulunan ve düzeltilen iki ek hata
Bunlar testte değil, **ancak tarayıcıda** görüldü:

1. **Webhook URL'i yanlıştı.** `location.origin` kullanınca ekranda
   `http://127.0.0.1:7032/webhooks/jira` yazdı — yani **Studio'nun** adresi. Jira'nın
   ulaşması gereken **BFF**. Gerçek bir kurulumda ikisi ayrı host; tarayıcı BFF'in genel
   adresini bilemez. Uydurmak yerine yol sabit, host yer tutucu:
   `https://<maestro-sunucusu>/webhooks/jira` + hangi adres olduğunu söyleyen bir not.
2. **Yardım metni bayattı.** `help.page.dash.*` hâlâ "4 adımda" diyor ve rehberin
   "hiç iş yoksa" çıktığını yazıyordu — ikisi de artık yanlış. tr+en güncellendi.

## Kapı
`pnpm run gate` → **64/64 görev yeşil, exit 0** (yükün düştüğü koşuda).

Yüklü koşularda her seferinde **başka** bir paket düşüyor (`storage`, sonra
`studio/users`+`listening`+`flow-screens`, sonra `pii`) — HANDOFF.md'de yazan yük flake'i;
makine 8 çekirdek, yük 20–31 (paralel ajanlar + canlı servisler). Düşenlerin **hepsi tek
başına yeşil**: storage 210/210, scanners 145/145, pii 154/154, o üç studio suite'i 58/58.
Dokunduğum paketlerle ilgisi yok.

- Lint: temiz.
- Typecheck: temiz.
- **Studio: 336 test yeşil** (öncesi 323 → **+13 yeni**).

## Test sayısı — 13 yeni
`test/screens-dash-start.test.tsx` (7, yeniden yazıldı):
- kurulum eksikken **koşular varken bile** rehber görünüyor
- hepsi bitince gizleniyor
- "gizle" kalıcı **ve** eksikliği itiraf eden not kalıyor
- önceden kaydedilmiş "gizle" tercihi yeni render'da uygulanıyor
- 5 adım listeleniyor, ilk eksik adım vurgulanıyor
- tek eksik webhook ise vurgu ona geçiyor
- webhook onayı `localStorage`'a yazılıyor

`test/screens-help-jira.test.tsx` (6, yeni):
- proje/tip/bot hesabı **canlı kuraldan** geliyor
- **kural değişince metin değişiyor** (sabit metin olmadığının kanıtı)
- kural yokken "tanımlı değil" diyor, örnek uydurmuyor
- `enabled=false` kural gösterilmiyor
- webhook URL/olaylar doğru, gizli anahtar **değeri** ekranda yok (Vault ref'i var)
- ekranda hiçbir e-posta yok (PII)

## ARAYÜZ İSTEĞİ
**`GET /studio/webhook-status`** — webhook'un Jira'da gerçekten kayıtlı olup olmadığını
bildiren bir uç **yok**. Jira bunu söylemiyor ve Maestro kaydın bir izini tutmuyor. Bu
yüzden webhook adımı, ölçülen değil **kullanıcının onayladığı** tek adım; tercih
`localStorage`'da, yani tarayıcı başına — başka bir makineden giren operatör adımı yine
açık görür. Uç eklendiğinde `setup-state.ts` içindeki `hasWebhook` tek satırda gerçek
ölçüme bağlanır; ekran ve testler değişmez.

İkincil: bot hesabının **görünen adı** için de uç yok — `accountId` gösteriliyor. Doğru
ve PII değil, ama "maestro" gibi bir ad daha okunur olurdu.

## Yapmadıklarım
- `packages/storage`, `apps/deploy`, `apps/bff/src/routes/webhooks.ts`,
  `packages/adapter-jira` — **paralel ajanlar orada**, dokunmadım.
- `packages/contracts`, `packages/ports` — DONMUŞ, dokunmadım.
- Canlı DB'ye yazmadım (yalnız BFF üzerinden okudum); paylaşılan 7000/7091 süreçlerini
  durdurmadım, kendi Vite'ımı 7032'de çalıştırıp kapattım.
- Bağlantının `botAccountId`'si ile kuralın `assigneeAccountId`'si arasındaki farkı
  **raporladım ama düzeltmedim** — hangisinin doğru olduğu bir ürün kararı.
- `main`'e merge etmedim.
