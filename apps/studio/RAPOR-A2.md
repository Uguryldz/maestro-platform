# RAPOR-A2 — Routing, Onboard, Notify ekranları

Kapsam: `Routing.tsx`, `Onboard.tsx`, `Notify.tsx` ve bunların BFF uçları
(`/routing`, `/notify`, `/onboarding`). Users/Settings/pilot/git dokunulmadı.

## Başlangıç durumu (önemli)

Görev metni, `main`'in onboarding/routing/notify uçlarını içeren commit'lerde
olduğunu varsayıyordu; worktree `git reset --hard main` sonrası farklı bir
HEAD'e (cc1ba26) düştü. Bu `main`'de:

- BFF uçları **zaten tam yazılmış ve testliydi**: `/routing` (GET+PUT),
  `/notify` (GET+PUT), `/onboarding/options` + `/onboarding/dry-run` +
  `POST /onboarding`, `/studio/apps`. `screens.ts`'de "unwired" işareti yoktu.
- `Onboard.tsx` **zaten tam kabloluydu** (options → dry-run → submit; M102 kuru
  koşum zorunluluğu submit butonunu kilitliyor). Değişiklik gerekmedi.
- `Routing.tsx` ve `Notify.tsx` **salt-okunurdu**: PUT uçları vardı ama ekran
  düzenleme yapmıyordu; Routing, Application Registry'yi ve M102 bağlama
  mekaniğini göstermiyordu.

İş bu yüzden ağırlıklı **Studio tarafında** oldu: iki ekranı düzenlenebilir
yapmak ve Routing'e kayıt defteri + mekanik kartını eklemek.

## /settings dosyası koordinasyon notu

`apps/bff/src/routes/settings.ts` tek dosyada `/settings`, `/routing`, `/notify`
handler'larını barındırıyor ama **temiz biçimde ayrılabilir**: her handler ayrı
bir servis modülüne delege ediyor (`routing-service.ts`, `notify-service.ts`,
`params-service.ts`). Diğer builder'ın `/settings` handler'ına ve `SettingsUpdate`
şemasına **dokunmadım**. `settings.ts` dosyasını hiç düzenlemedim — yalnızca
`notify-service.ts`'e (bana ait /notify servisi) `ladderRaw` alanı ekledim.

## Her ekran ne yapıyor

### Routing.tsx (yeniden yazıldı)
- **Bağlama mekaniği kartı (M102)**: webhook modeli + proje bağlama akışı.
- **Bağlı Jira projeleri**: `GET /routing` → projeler, tetikleme, uygulamalar,
  not. "+ Proje/uygulama bağla" butonu #onboard'a götürüyor.
- **Yönlendirme politikası (3 kademe / veri sınıfı)**: `GET /routing` kuralları.
  Yalnızca **admin** için "Politikayı düzenle" → `RoutingPolicyEditor` modalı →
  `PUT /routing` ile `dataclass.policy` (KORUMALI parametre). Modal, dört-göz
  uyarısını yazıyor ve sonucu `applied` (uygulandı) vs `pending` (onay bekliyor)
  olarak ayrı gösteriyor. Backend'ler kurallardan ön-doldurulur;
  `whenOnpremMissing` kuraldan geri kazanılamadığı için güvenli varsayılanda
  açılıp admin'e onaylatılır (korumalı kayıt zaten tüm politikayı yeniden ifade
  eder).
- **Uygulama kayıtları (Application Registry — M100)**: `GET /studio/apps` →
  uygulama, ADO repo (`<proje>/_git/<repo>`), platform, `.maestro.yaml` durumu,
  kaynak. Repo kartı açıklama notu.

### Onboard.tsx (değişmedi — zaten çalışıyor)
- `GET /onboarding/options` → sihirbaz selectleri.
- `POST /onboarding/dry-run` → son N ticket'ın hangi kademeyle nereye düşeceği
  (byRule / bySuggestion / unresolved). Kuru koşum görülmeden submit kilitli.
- `POST /onboarding` → paketi **admin onayına** (dört-göz teklifi) gönderir.

### Notify.tsx (düzenlenebilir yapıldı)
- Merdiven / delegasyon / bekleyen kapılar `GET /notify` ile okunuyordu; korundu.
- Yalnızca **admin** için "Merdiveni düzenle" → `NotifyEditor` modalı: her adımın
  **eşiği (saat)** ve **kanalı**, artı **varsayılan kanallar** düzenlenir.
  Adımın `id` ve `event`'i korunur (eşik değişince açık kapılar yeniden
  eskalasyona girmesin — `EscalationStep.id` gerekçesi). `PUT /notify` ile
  `{ ladder, routing }` birlikte yazılır; `{ results }` içinde herhangi bir
  `pending` varsa "onaya gönderildi", yoksa "kaydedildi" gösterilir.

## Kablolanan uçlar
- `GET /routing`, `PUT /routing` (dataclass.policy, korumalı)
- `GET /studio/apps` (Application Registry)
- `GET /notify`, `PUT /notify` (ladder + routing)
- `GET /onboarding/options`, `POST /onboarding/dry-run`, `POST /onboarding`

## BFF değişikliği
`notify-service.ts` `NotifyView`'a `ladderRaw` (depolanan ham merdiven:
adım id/kanal/olay/eşik) eklendi. Projeksiyon rungların id'si yok; editörün bir
eşiği değiştirip aynı adımları id'leriyle geri PUT edebilmesi için gerekliydi.
`packages/contracts` ve `packages/ports` dosyalarına dokunulmadı (donuk).

## Testler (hepsi offline)
- **BFF**: mevcut `notify.test.ts` (15), `settings.test.ts` (routing GET/PUT
  dahil), `onboarding.test.ts` korundu. `notify.test.ts`'e `ladderRaw` + `routing`
  alanlarının döndüğü ve ham adımın `id` taşıdığı iddiaları eklendi. **BFF: 507
  test yeşil, typecheck temiz.**
- **Studio**: yeni `screens-routing-notify.test.tsx` (5 test): registry render,
  korumalı editörün non-admin'den gizlenmesi, politikanın dört-göz teklifi olarak
  kaydı (backend ön-dolum + pending toast), eşik düzenleyip aynı id ile PUT,
  notify edit butonunun non-admin'den gizlenmesi. Mevcut `screens-platform.test`
  notify mock'u yeni sözleşmeyle (ladderRaw/routing) güncellendi. **Studio: 223
  test yeşil, typecheck temiz.**
- `@maestro/config` catalog-usage testi yeşil (yeni `notify.*` anahtarları tr+en
  parite). Lint, dokunduğum dosyalar için temiz.

## i18n
Yeni `routing.*`, `notify.*` anahtarları `tr.json` **ve** `en.json`'a eklendi
(mekanik kartı, registry, politika editörü, notify editörü). `notify.*`
anahtarları catalog-usage testiyle zorlanır ve ikisinde de mevcuttur.

## doğrulayıcı düzeltmesi (whenOnpremMissing round-trip)

**Bulgu (KRİTİK — gizli-veri buluta sızma, no-op save downgrade):**
`Routing.tsx` `whenOnpremMissing`'i koşulsuz `"degrade_ai_assist"` olarak
sabitliyordu; `RoutingView` yalnız render edilmiş (kayıplı) `outcome` veriyordu.
Saklı politikada `gizli` fallback = `block` iken, admin editörü açıp fallback'e
dokunmadan kaydettiğinde öneri uydurulmuş `degrade_ai_assist` taşıyordu. İki
onaycı da bu uydurulmuş değeri onaylıyordu (`putParam` yalnız iki öneriyi
birbiriyle byte-eşliği kontrol eder, mevcut saklı değerle değil), böylece katı
`block` sessizce `degrade_ai_assist`'e düşüyordu — 4-göz koruyamıyordu.

**Düzeltme (Notify'daki `ladderRaw` ile simetrik):**
1. `routing-service.ts` → `RoutingView`'a **ham `policy`** (saklı gerçek değer,
   render outcome değil) eklendi; `readRouting` `policy`'yi aynen döndürür.
2. Studio `RoutingView` tipine `policy: DataClassPolicy` eklendi.
3. `Routing.tsx:70` artık `routing.data.policy`'yi **aynen** kullanır — hardcode
   ve kurallardan yeniden-üretim kaldırıldı (`useMemo`/`DATA_CLASSES`/
   `DataClassName` importları temizlendi). `RoutingPolicyEditor` gerçek saklı
   değerle açılır; kullanıcı dokunmazsa saklı değer birebir geri gider.
4. Ek güvenlik: editörde "Kayıtlı değer: X" satırı ve fallback değiştiğinde
   "değişiyor" rozeti — ikinci onaycı önerinin NE DEĞİŞTİRDİĞİni görür.

**Negatif testler (zorunlu):**
- Studio `screens-routing-notify.test.tsx`: saklı `whenOnpremMissing:"block"`
  olan politikada editör açılıp fallback'e DOKUNMADAN save → PUT payload'ında
  `whenOnpremMissing` **hâlâ `"block"`**, `degrade_ai_assist` DEĞİL. Mevcut
  "four-eyes proposal" testi de artık backend'in ham policy'den geldiğini iddia
  eder.
- BFF `settings.test.ts`: GET /routing saklı `whenOnpremMissing`'i **aynen**
  verir (`block`), yalnız kayıplı outcome değil — `degrade_ai_assist` ile
  `masked_cloud` aynı `degraded` outcome'a düştüğü için editörün kuraldan tahmin
  YÜRÜTMEMESİ gerektiğini pinler. `outcome:"blocked"→"block"` reverse-map'i de
  mevcut "reports a blocking fallback as blocked" testiyle korunur.

Sonuç: **BFF 508 test yeşil** (+1), **Studio 224 test yeşil** (+1), her ikisi
typecheck temiz, catalog-usage yeşil, lint temiz. Notify/step-id/guarded-save/
admin-gate kısımlarına dokunulmadı.
