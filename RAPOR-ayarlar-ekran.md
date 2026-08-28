# RAPOR — Ayarlar ekranına "Altyapı" bölümü

Dal: `worktree-agent-a59d8c6104a84a367` (worktree `3eda0f6` üzerine)

## Soru neydi

Önceki tur `/settings` ucunu gerçeğe uydurmuştu: motor, veritabanı ve LLM artık uçtan dönüyor.
Ama **ekran onu göstermiyordu**. `RAPOR-ayarlar.md` bunu açıkça devretmişti: *"Studio ekranına tablo
eklemedim… o kararı vermek bana düşmez. Kullanıcıya sorulacak."* Karar verildi, ekran eklendi.

## Tekrarı nasıl önledim — ve neden böyle

`Settings.tsx:19`'daki yorum salt-okunur tablonun **bilerek** kaldırıldığını söylüyordu: düzenlenebilir
panelle aynı başlık altında tekrarlıyordu. **O gerekçe o gün doğruydu.** Kaldırıldığında liste yalnız
`jira/ado/vault` biçimli satırlar taşıyordu — gerçekten örtüşüyordu.

Bugün örtüşmüyor. Liste artık `temporal`, `database`, `llm` de taşıyor; **hiçbiri düzenlenebilir
panelde yok**. Operatör "motor nereye bağlı, ayakta mı" sorusunu hiçbir ekrandan soramıyordu.

**Kararım: satır gizlemedim, iki tabloyu ayırdım.** Gerekçe:

1. **Aynı id, farklı gerçek.** `/studio/connections`'taki `jira` operatörün Studio'ya *yazdığı*
   sitedir; buradaki `jira` dağıtımın `deploy/.env`'inden *okunan* sitedir. Bu ikisi **ayrışabilir**,
   ve ayrıştıkları an bu ekranın söyleyebileceği en değerli şey tam olarak o ayrımdır. Tekilleştiren
   bir filtre, göstermek istediğim tek şeyi silerdi.
2. **id'ler zaten eşleşmiyor.** Canlıda düzenlenebilir panelde `llm-openrouter`, altyapıda `llm`
   var. id'ye bakan bir filtre bunları yakalayamaz; yakaladığını sanmak daha kötü.
3. **Fark yazıyla söyleniyor.** Kartın kendi alt başlığı: *"Bu dağıtımın altyapısı — deploy/.env
   dosyasından gelir, buradan değiştirilemez."* İlk denemede eksik olan parça buydu — tablo değil,
   tablonun **ne olduğunu söyleyen cümle**.

## Eklenen bölüm

`apps/studio/src/screens/settings/InfrastructurePanel.tsx` (182 satır, **yeni**) — `Card` + `Table`,
`useApi()` + TanStack Query, `signal` iletiliyor. `ConnectorsPanel`'in **altında**, kendi başlığıyla.

Sütunlar: Bağlantı · Durum · Hedef · Kimlik referansı.

**Salt okunur olduğu üç ayrı yerden belli:** başlıkta ("Altyapı (salt okunur)"), alt başlıkta
(nereden geldiği + değiştirilemeyeceği), ve **hiçbir düğme olmaması** — admin'e bile. Bir test bunu
koruyor (`queryByRole("button")` kartın içinde boş).

### Üç durum ayrımı — uçtaki tuzak

Uç `connected` kelimesini **iki farklı anlamda** kullanıyor, ve bu ekranda ikisini birbirine
karıştırmak en pahalı hata olurdu:

| Satır | uç `status` | `checkedAt` | Ekranda |
|---|---|---|---|
| `temporal`, `database` | `connected` | dolu — **probe yokladı** | 🟢 **bağlı** + "az önce yoklandı" |
| `jira`, `llm`, `identity`, `publish` | `connected` | **null** — probe yok | 🔵 **yapılandırıldı** + "yoklanmadı" |
| `ado`, `vault`, `storage`, `egress_proxy`, `siem` | `unconfigured` | null | ⚪ **kurulmadı** + "adres tanımlı değil" |

`statusOf` (BFF) probe **yokken** de `connected` dönüyor — adres dolu diye. Ekran bunu tekrarlasaydı,
kimsenin yoklamadığı bir motorun üzerinde yeşil ışık yanardı. Ayrımı `status` + `checkedAt`'ten
**sunumda** yaptım; uydurulan durum yok, BFF'in sözlüğüne dokunulmadı (yazma iznim de yoktu).

`unconfigured` asla `degraded` gibi görünmüyor — "kurulmamış" ile "bozuk" operatörü iki ayrı işe
gönderir.

## Tarayıcı kanıtı — ve orada yakalanan bir hata

Kendi Vite'ım **7031**'de (`MAESTRO_BFF_ORIGIN=http://127.0.0.1:7091`) — 7010 başka bir ajanda
doluydu. Paylaşılan 7000/7091 süreçlerine dokunulmadı, ikisi de işim bitince ayakta doğrulandı; kendi
sunucum PID ile kapatıldı.

**Motor satırı görünüyor ve şunu yazıyor:**

> **İş akışı motoru (Temporal)** · 🟢 bağlı · *az önce yoklandı* · `localhost:7233` · `none`

Veritabanı satırı: `postgresql://maestro:***@localhost:55432/maestro` — **sunucunun maskesi olduğu
gibi**, ekran ikinci kez maskelemiyor. Ham parola görülmedi.

### Tarayıcının yakaladığı hata (testler kaçırmıştı)

İlk render'da satırın altında **"az önce ÖNCE yoklandı"** yazıyordu. Sebep: `age.now` = "az önce"
zaten tam bir zarf öbeği, ama `age.days`/`age.hours` ("5 gün") çıplak süre. İkisini tek şablona
(`{age} önce yoklandı`) sokmak Türkçede kelimeyi ikizliyor — İngilizcede de: *"probed just now ago"*.

Düzeltme: taze yoklama kendi cümlesini alıyor (`settings.infra.checked_now`), hangi anahtarın
döndüğüne bakarak — geçen süreyi ikinci kez hesaplayarak değil (tek saat, tek karar). Regresyon
testi eklendi; testin `NOW` sabiti de zamana karşı sabitlendi (2020), yoksa iddia kendi kendine
çürürdü.

**Bu, kapının değil tarayıcının yakalayabileceği türden bir hataydı** — HANDOFF'un altı hatası da
aynı şekilde bulunmuştu.

İngilizce parite tarayıcıda doğrulandı: *"connected / probed 1m ago"*, *"configured / not probed"*,
*"not configured"*.

## Katalog

**Altı yeni anahtar, tr+en parite korundu** (alfabetik sıraya yerleştirildi):
`settings.infra.{title,sub,checked,checked_now,not_probed,endpoint_unset}` ve
`settings.status.configured`. Mevcut `settings.connection.{temporal,database,llm}` anahtarları
önceki turdan hazırdı, dokunulmadı.

## Testler

`apps/studio/test/screens-settings-infra.test.tsx` (252 satır, **yeni**) — **13 test**, hepsi yeşil.
Ağ çağrısı yok; `stubFetch` canlı `/settings` cevabını birebir taklit ediyor (16 Ağustos ölçümü).

Kanıtlananlar: motor satırı render ediliyor (adres + durum) · veritabanı ve LLM satırları da ·
`unconfigured` satır **gizlenmiyor** (M33/siem) ve `degraded` gibi görünmüyor · yoklanmamış satır
`connected` gibi görünmüyor · yoklanmış satır zaman damgasını taşıyor · zarf ikizlenmiyor · düşmüş
motor kırmızı kalıyor · **parola DOM'un tamamında geçmiyor** ve sunucunun maskesi bozulmuyor ·
kartta hiç düğme yok · viewer da görüyor · farkı söyleyen cümle ekranda · İngilizce parite ·
iki tablo yan yana, ayrı başlıklarla.

### Mutasyon kanıtı

1. `infraStatusOf`'ta `return probed` → `return true` (yoklanmamışı bağlı say) → **2 test kırıldı**
   (tr + en). Geri alındı.
2. Fixture'a maskesiz parola (`maestro:s3cr3t-pw@`) → **sızıntı testi kırıldı**
   (`expected … not to contain 's3cr3t'`). Geri alındı.

## Kapı

`pnpm run gate` → **exit 0, 64/64 görev**.

Bir kez varsayılan eşzamanlılıkla düştü (`@maestro/studio#test`, ayrıca bff/workflows/deploy
zaman aşımı) — üç ajan koşarken. Tekrar koşuldu → yeşil; studio paketi **tek başına 326/326**
(29 dosya). HANDOFF bu yük-flake'ini zaten belgeliyor.

## ARAYÜZ İSTEKLERİ

**Yok.** `apps/bff/` okundu, **yazılmadı**. `packages/contracts` ve `packages/ports` **donmuş**
kaldı — `SettingsView`/`Connection` tipleri Studio'nun kendi `screens/common/admin-api.ts`'inde
zaten tanımlıydı, yenisi gerekmedi.

## Yapmadıklarım — bilerek

- **Satır tekilleştirmedim.** Yukarıdaki üç gerekçe. Kararı ve gerekçesini panelin dosya başı
  yorumuna da yazdım ki bir sonraki tur "bu neden iki kere duruyor" diye sormasın.
- **BFF'in `statusOf`'unu düzeltmedim.** Probe'suz bir satıra `connected` demesi tartışılabilir ama
  `apps/bff/` yazma yasağı vardı ve uç bu ayrımı `checkedAt` ile zaten **veriyor** — ekran onu
  okuyabiliyor. Sözlüğü değiştirmek `/settings`'in diğer tüketicilerini de etkilerdi.
- **`notifyDrivers`'ı göstermedim.** `/settings` onu da dönüyor ama bildirim sürücüleri kendi
  ekranında (M45) — kaldırılma gerekçesinin hâlâ geçerli olduğu tek parça bu.
- **Yeni probe kurmadım.** `jira`/`llm` için yoklama eklemek cazipti; ikinci bir probe seti sağlık
  ekranıyla ayrışma riski taşır (önceki turun gerekçesi) ve BFF yazımı gerektirirdi.

## Dosyalar

- `apps/studio/src/screens/settings/InfrastructurePanel.tsx` (182 satır, **yeni**)
- `apps/studio/src/screens/Settings.tsx` (44 satır) — panel bağlandı; kaldırma gerekçesini anlatan
  yorum **güncellendi** (artık neden geri geldiğini de anlatıyor)
- `apps/studio/test/screens-settings-infra.test.tsx` (252 satır, **yeni**) — 13 test
- `packages/config/locales/{tr,en}.json` — altı yeni anahtar, tr+en parite
