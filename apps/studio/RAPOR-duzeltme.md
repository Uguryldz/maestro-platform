# `apps/studio` — düzeltme raporu (Dalga 4)

**Branch:** `worktree-agent-ac9e534ba702d8d0e` · **Taban:** `68be376` (demo stack)
**Kapsam:** `DOGRULAMA.md` bulguları (K1, Y1–Y3, O1–O3, D1–D3) + orkestratör EK-1, EK-2

**Sonuç:** `pnpm run gate` yeşil (54/54 görev) · `pnpm --filter @maestro/studio build` başarılı ·
190 → **202 test**, tümü yeşil · tr/en parite **1327 = 1327**, fark 0, boş değer 0.

---

## Uç eşleştirme tablosu

`ApiClient` her yola `/api` öneki koyar (`api/client.ts:41`); BFF rotaları kökte
(`server.ts:98-109`, `prefix` yok). Yani karşılaştırma birebir.

### Studio'nun çağırdığı ve BFF'te **VAR OLAN** uçlar (27)

| Studio yolu | Yöntem | Çağrı yeri | BFF'te |
|---|---|---|---|
| `/auth/login` | POST | `auth/AuthProvider.tsx:84` | ✅ `auth.ts:19` |
| `/auth/logout` | POST | `auth/AuthProvider.tsx:95` | ✅ `auth.ts:47` |
| `/auth/session` | GET | `auth/AuthProvider.tsx:70` | ✅ `auth.ts:52` |
| `/runs` | GET | `shared/runs.ts:71` | ✅ `runs.ts:31` |
| `/runs/:ticket` | GET | `shared/runs.ts:90` | ✅ `runs.ts:45` |
| `/runs/:ticket/signals/gateDecision` | POST | `shared/signals.ts:69` | ✅ `runs.ts:55` |
| `/runs/:ticket/signals/clarificationAnswered` | POST | `shared/signals.ts:99` | ✅ `runs.ts:55` |
| `/runs/:ticket/signals/modeChange` | POST | `shared/signals.ts:126` | ✅ `runs.ts:55` |
| **`/studio/runs/:ticket/journal`** | GET | `shared/runs.ts:126` | ✅ `studio-runs.ts:80` — **K1'de düzeltildi** |
| **`/studio/runs/:ticket/evidence`** | GET | `shared/runs.ts:151` | ✅ `studio-runs.ts:113` — **K1'de düzeltildi** |
| `/studio/health` | GET | `Health.tsx:39` | ✅ `studio-ops.ts:82` |
| `/studio/runners` | GET | `Runners.tsx:40` | ✅ `studio-ops.ts:52` |
| `/studio/sandboxes` | GET | `Sandbox.tsx:44` | ✅ `studio-ops.ts:66` |
| `/studio/quota` | GET | `Llm.tsx:62`, `Cost.tsx:52` | ✅ `studio-ops.ts:76` |
| `/studio/cost` | GET | `Llm.tsx:67`, `Cost.tsx:47` | ✅ `studio-catalog.ts:95` |
| `/studio/audit` | GET | `Audit.tsx:44` | ✅ `studio-ops.ts:97` |
| `/studio/audit/verification` | GET | `Audit.tsx:55` | ✅ `studio-ops.ts:114` |
| `/studio/scans` | GET | `Security.tsx:106` | ✅ `studio-catalog.ts:81` |
| `/studio/knowledge` | GET | `Knowledge.tsx:52` | ✅ `studio-catalog.ts:58` |
| `/studio/users/:username` | GET | `Users.tsx:78` | ✅ `studio-catalog.ts:110` |
| `/params` | GET | `Params.tsx:49` | ✅ `params.ts:33` |
| `/params/:key` | PUT | `Params.tsx:54` | ✅ `params.ts:37` |
| `/killswitch` | GET | `settings/KillSwitchPanel.tsx:52`, `shell/KillSwitchIndicator.tsx:39` | ✅ `killswitch.ts:43` |
| `/killswitch` | POST | `settings/KillSwitchPanel.tsx:57` | ✅ `killswitch.ts:24` |

### Studio'nun çağırdığı ama BFF'te **OLMAYAN** uçlar (21)

Hepsi kasıtlı: read-model henüz yazılmadı. **Hepsi artık `MaybeUnwired` ile
sarılı** → 404 "Bu bölüm henüz yayında değil" veriyor, "Kayıt bulunamadı" değil.

| Studio yolu | Ekran | Sarmalayıcı |
|---|---|---|
| `/settings` | `Settings.tsx:39` | ✅ **O2'de `QueryState` → `MaybeUnwired` yapıldı** |
| `/notify` | `Notify.tsx:35` | ✅ **O2'de düzeltildi** |
| `/mcp/manifest` | `Mcp.tsx:37` | ✅ **O2'de düzeltildi** |
| `/commands` | `Commands.tsx:40` | ✅ **O2'de düzeltildi** |
| `/repo-policy` | `Yaml.tsx:30` | ✅ **O2'de düzeltildi** |
| `/onboarding/options` | `Onboard.tsx:53` | ✅ **O2'de düzeltildi** |
| `/pii` | `Pii.tsx:58` | ✅ zaten sarılıydı |
| `/eval` | `Eval.tsx:61` | ✅ zaten sarılıydı |
| `/cache` | `Cache.tsx:54` | ✅ zaten sarılıydı |
| `/decisions` | `Issues.tsx:36` | ✅ zaten sarılıydı |
| `/greenfield` | `Greenfield.tsx:62` | ✅ zaten sarılıydı |
| `/doc-template` | `Doctemplate.tsx:64` | ✅ zaten sarılıydı |
| `/variants`, `/variants/:id` | `Variants.tsx:37`, `Variant.tsx:63` | ✅ zaten sarılıydı |
| `/routing` | `Routing.tsx:49` | ✅ zaten sarılıydı |
| `/template` | `Template.tsx:54` | ✅ zaten sarılıydı |

**Mutasyon uçları** (sorgu değil, `useMutation` → hata toast'a düşer, sarmalayıcı
konusu değil): `POST /template/versions`, `POST /onboarding/dry-run`,
`POST /onboarding`, `POST /repo-policy/:appId/protected-paths`,
`DELETE /repo-policy/:appId/protected-paths/:path`.

**Uydurma uca giden çağrı kalmadı** — "var olan bir ucu yanlış yoldan çağırmak"
sınıfından hiçbir örnek yok.

### BFF'te var, Studio kullanmıyor

`/healthz`, `/readyz`, `/webhooks/*` (Studio'nun işi değil) ·
`/studio/runs`, `/studio/runs/:ticket`, `/studio/runs/:ticket/summary`,
`/studio/runs/:ticket/cost`, `/studio/gates`, `/studio/apps*` — bkz. "Kapatmadıklarım".

---

## Bulgu bulgu ne yapıldı

### K1 (KRİTİK) — Halüsinasyon entegrasyon ✅ KAPANDI

İki ayrı hata vardı, ikisi de düzeltildi:

1. **Yol:** `/runs/:ticket/journal` → `/studio/runs/:ticket/journal`;
   `/runs/:ticket/evidence` → `/studio/runs/:ticket/evidence`
   (`shared/runs.ts:126`, `:151`). `encodeURIComponent` de eklendi.
2. **Şekil:** `JournalResponse` `{ entries }` → `{ items, nextCursor }`
   (BFF `pageBody()`, `paging.ts:43`). `JournalTab.tsx:34` `data?.items` okuyor.

"Uç yok" diyen yanıltıcı yorumlar (`runs.ts:97/120`, `JournalTab.tsx:13`,
`Evidence.tsx:26`) silindi; yerlerine rotanın dosya:satır referansı yazıldı.

**Mutasyon kanıtı (iki ayrı):**
- Yolu `/runs/...`'a geri al → **2 test kırıldı** (defter render + hata yolu).
- Yolu doğru bırak, `items`'ı `entries` yap → **1 test kırıldı**
  ("Analiz belgesi üretildi" bulunamadı). Yani **sessiz boş** hâli de yakalanıyor —
  doğrulayıcının "yolu düzeltip şekli düzeltmezsen daha kötü" uyarısı test edilmiş durumda.

Test: `flow-screens.test.tsx` — çağrılan URL'yi *ve* dönen satırları assert ediyor;
eski test uçtan 404 bekliyordu (yanlışı pinliyordu), o kaldırıldı.

### Y1 (YÜKSEK) — Tanınmayan enum ekranı karartıyor ✅ KAPANDI

`common/label.ts`'e **`useEnumLabel()`** eklendi: `{ text, unknown }` döner.
Bilinen değer → çeviri; bilinmeyen → `value.unrecognised` ("tanınmayan: X",
64 karakterle sınırlı); boş → `value.unknown_blank`. Ekranı karartmak yerine
**ham değeri güvenli biçimde ve işaretli** gösteriyor.

Yayıldığı yerler (küme A ve C dahil): `Users.tsx` (rol rozetleri),
`Sandbox.tsx` (state), `Cost.tsx` (rol + dataClass), `Llm.tsx` (account_state,
rol, dataClass), `Variants.tsx`, `Variant.tsx`, `Notify.tsx`, `Commands.tsx`,
`Routing.tsx`, `Cache.tsx`, `Settings.tsx`, `Tickets.tsx` + `Dash.tsx`
(`run.exec.*`, `RUN_STATUS_PREFIX` ile).

**Renk de düzeltildi:** bilinmeyen değer nötr gri; `ROLE_TONE[role]`/
`STATE_TONE[row.state]` artık `undefined` dönemiyor (`roleTone`, `stateTone`
yardımcıları). Bilinmeyen tarama sonucu **asla yeşil** olamaz.

**Mutasyon kanıtı:** `useEnumLabel`'ın catch dalını yeniden `t()` fırlatacak hâle
getir → **3 test kırıldı**, üçü de "ekranın tamamı kayboldu" şeklinde
(`ayse.kaya`, `UGURPAY-501` bulunamıyor) — doğrulayıcının tarif ettiği felaketin
aynısı.

### Y2 (YÜKSEK) — Test yalan söylüyordu ✅ KAPANDI

`signals.ts:68` için `renderHook` ile **doğrudan birim testi** yazıldı
(`hardening.test.tsx`): gerekçesiz ret, yalnız-boşluk gerekçe, `messageKey`,
gerekçeli ret gider + trim, onay gerekçe istemez. 5 test.

**Mutasyon kanıtı:** yalnız `signals.ts:68`'i sil → **3 test kırıldı**.
(Doğrulayıcının ölçümünde aynı mutasyon **0 test** kırıyordu — 177/177 yeşil kalıyordu.)

### Y3 (YÜKSEK) — Ham tarayıcı metni ✅ KAPANDI

`Security.tsx` içinde **`FindingMessage`** bileşeni: `finding.message` artık
varsayılan olarak **gösterilmiyor**. Yerine "Tarayıcı metnini göster" düğmesi;
açıldığında "Tarayıcı çıktısı (çevrilmemiş, sır içerebilir)" etiketi + `<samp lang="en">`.
Gerekçe: Gitleaks mesajı sızan sırrın kendisini taşıyabilir — ekranı **açmak**
sırrın ikinci bir kopyasını üretmemeli; göstermek **bilinçli bir eylem** olmalı.
Triyaj için gereken önem/araç/konum açıkta kalıyor.

**Mutasyon kanıtı:** `cell: (row) => row.finding.message` geri koy →
**1 test kırıldı** (`AKIAIOSFODNN7EXAMPLE` sayfada görünüyor).

**Canlı doğrulama:** demo yığınında `/security` — UGURDESK-52'nin gitleaks
bulgusu düğme arkasında, önem/araç/dosya görünür.

### O1 (ORTA) — Dört-göz: kendi önerini onaylıyormuş gibi görünen buton ✅ KAPANDI

`ParamEditor` artık `viewerUserId` alıyor; `isSelfProposal()` `ai-via:` önekini
soyup kişileri karşılaştırıyor (BFF `samePerson`/`humanBehind`,
`params-service.ts:148` aynası). Öneren kişi kendi değerini yazdığında buton
**"Onaya gönder"** kalıyor ve yeni bir katalog metni sebebini söylüyor
(`params.guarded.own_proposal`). Kimlik bilinmiyorsa `false` — belirsizlik
"geçerli ikinci göz" sayılmıyor.

**Mutasyon kanıtı:** `ownProposal = false` yap → **2 test kırıldı**
(kendi önerisi + AI-delege aynı kişi sayılması).

### O2 (ORTA) — Yazılmamış uçlar "Kayıt bulunamadı" diyordu ✅ KISMEN KAPANDI

6 ekran (`Settings`, `Notify`, `Mcp`, `Commands`, `Yaml`, `Onboard`) düz
`QueryState` kullanıyordu → 404'te "Kayıt bulunamadı" diyordu. Hepsi
`MaybeUnwired`'a çevrildi. Artık 21 bağlanmamış ucun tamamı tutarlı.

**Mutasyon kanıtı:** `unwired.tsx`'teki `NotAvailable` dalını sil →
**1 test kırıldı**. Ayrıca 500'ün **hâlâ** hata olarak göründüğünü ayrı bir test
pinliyor (bozuk uç ≠ yazılmamış uç).

O2'nin "kullanılmayan BFF uçları" yarısı: bkz. "Kapatmadıklarım".

### O3 (ORTA) — Pasif hesabın yetkileri normal görünüyordu ✅ KAPANDI

`Users.tsx`: pasif hesapta rol rozetleri **üstü çizili** (`<s>`) ve **gri**.
Rol listede kalıyor (denetçi görmeli) ama görsel dil uyarı metnini artık
yalanlamıyor.

**Mutasyon kanıtı:** `<s>` sarmalını kaldır → **1 test kırıldı**.
Aktif hesabın normal kaldığını ayrı test pinliyor.

### D1 (DÜŞÜK) — `slugify` ölü dal ✅ KAPANDI (davranış değişmedi)

Fold artık `.toLowerCase()`'den **önce** çalışıyor, sözlüğe büyük harfler eklendi.
Böylece `İ` girdisi gerçekten sözlükten geçiyor.

**Dürüst not:** bu bir okunabilirlik kusuruydu, davranış kusuru değil —
doğrulayıcı da "Etkisi yok" demişti. NFD zaten birleşen noktayı siliyordu.
Ölçtüm: eski ve yeni `slugify` **6 Türkçe başlıkta da aynı** çıktıyı veriyor.
Yazdığım 3 test bu yüzden **karakterizasyon testi**: refaktörün davranışı
koruduğunu kanıtlıyor ve ileride fold'un sessizce bozulmasını engelliyor,
ama orijinal hatayı mutasyonla kanıtlayamazlar (orijinal hatanın gözlenebilir
çıktısı yoktu). Bunu test dosyasına da yazdım.

Yan bulgu: sözlükteki 13 girdiden **yalnız `ı`** gerçekten gerekli; diğerlerini
NFD zaten ASCII'ye indiriyor. `ı` girdisini silince **3 test kırılıyor** —
yani sözlüğün taşıyıcı kısmı test altında.

### D2 (DÜŞÜK) — `ErrorBoundary` HTTP kodu sızdırıyordu ✅ KAPANDI

Artık yalnız `MissingMessageError` mesajını gösteriyor (eksik anahtarı görmek
tek çözüm yolu). Diğer her hata **sadece sınıf adını** gösteriyor — `ApiError`'ın
mesajı `api ${status} ${code}` üretiyordu ve son kullanıcıya HTTP kodu + sunucu
hata kodu düşüyordu. Tam hata **hâlâ `console.error`'a** gidiyor.

**Mutasyon kanıtı:** `DETAILED_ERRORS`'a `"ApiError"` ekle → **1 test kırıldı**
(`403` ve `role_required` sayfada).

### D3 (DÜŞÜK) — `Table caption` tutarsızlığı ❌ KAPATMADIM

Bkz. "Kapatmadıklarım".

---

## Orkestratör ek bulguları

### EK-1 (YÜKSEK) — Boş sayfa + 3× tekrar ✅ KAPANDI

İki ayrı sebep vardı:

1. **3× tekrar:** `App.tsx` `makeQueryClient()` 404'ü **yeniden deniyordu**
   (`failureCount < 2`). Var olmayan bir uç ikinci denemede var olmaz. Artık
   404 ve 501 de 401/403 gibi tekrarlanmıyor. 5xx ve ağ hataları hâlâ tekrarlanıyor.
2. **Boş görünüm:** `Template.tsx` zaten `MaybeUnwired` kullanıyordu; asıl
   şikâyet edilen boşluk büyük ölçüde tekrarlar sırasındaki ara durumdu.

**Canlı doğrulama (demo yığını, tarayıcı):** `/template` →
konsolda `/api/template` **1 kez** (önce 3'tü), ekranda her iki bölümde de
"Bu bölüm henüz yayında değil" + açıklama. Boş panel yok.

**Test:** ekranın `NotAvailable` gösterdiğini ve **tek istek** yaptığını
(üretim retry politikasıyla) pinleyen 2 test.

**`ProtectedPaths.tsx` hakkında düzeltme:** bu dosyada `useQuery` **yok** —
`policy`'yi prop olarak alıyor, yalnız `useMutation` var ve hataları
`toast.show("error", t(messageKeyOf(error)))` ile çevrilmiş şekilde gösteriyor.
Yani burada ele alınmamış hata yolu yoktu; sarmalayıcı gereken şey sorgu değil.
Onu besleyen `Yaml.tsx`'in `/repo-policy` sorgusu ise O2'de `MaybeUnwired`'a çevrildi.

### EK-2 (ORTA) — Türkçe ek uyumu ✅ KAPANDI + tarandı

`dash.attention.age` `"{age}tir açık"` → `"{age} açık"` (bu düzeltme `main`'e
henüz girmemişti, ben uyguladım).

**Tarama sonucu:** katalogun tamamını (1327 anahtar) yer tutucuya bitişik ek
için taradım. **Başka örnek yok.** Bitişik başka 9 eşleşme var ama hepsi
`v{n}` / `v{version}` biçiminde **önek**, ek değil (`template.version_n`,
`variant.subtitle`, `params.field.current`, `eval.last_run_sub`,
`template.preview_title`, `template.project_pinned`, `template.project_version`,
`template.saved`, `doctemplate.version_n`) — bunlar doğru.

**Kural teste bağlandı:** `hardening.test.tsx` katalogun tamamını gezip
`{x}dir/tir/de/da/den/dan/lik` kalıbını arıyor; bulursa kırılıyor. Tek bir
metni pinlemek yerine kuralı pinliyor.

**Mutasyon kanıtı:** eski metni geri koy → test kırıldı, hatalı anahtarı
adıyla raporladı.

---

## Kapatmadıklarım ve nedenleri

1. **O2'nin ikinci yarısı — kullanılmayan BFF uçları.**
   `/studio/gates`, `/studio/apps`, `/studio/apps/:appId/repo-card`,
   `/studio/runs*` ailesi yazılmış ama kullanılmıyor. **Kapatmadım.**
   Neden: bunlar *hata* değil, *fırsat*. Her biri ilgili ekranın veri kaynağını
   değiştirmek demek — `notify`'ı uydurma `/notify` yerine `/studio/gates`'e,
   `dash`/`tickets`/`fanout`/`clarify`'ı `/runs` yerine `/studio/runs`'a bağlamak.
   Bu, 6+ ekranın veri modelini, kolonlarını ve testlerini değiştiren bir
   **yeniden bağlama işi**; düzeltme görevinin kapsamı değil ve tek commit'te
   yapılırsa gözden geçirilemez. Ayrıca `/runs` şu an **çalışıyor** — bozuk bir
   şey düzeltmiyor olurdum. Ayrı bir görev olarak önerilir; en yüksek değerli
   olanı `dash`/`tickets` → `/studio/runs` (step/runStatus/risk/appId alanları
   hazır, ekranlar bugün bunları gösteremiyor).

2. **D3 — `Table caption` tutarsızlığı. Kapatmadım.**
   Neden: doğrulayıcının kendi ifadesiyle "kural ihlali değil, tutarsızlık".
   Düzeltmek 20+ ekranda `caption` eklemek ve her biri için katalog anahtarı
   üretmek demek; parite dosyasını ~20 anahtar şişirir. Erişilebilirlik iyileştirmesi
   olarak ayrı ve odaklı bir görevde yapılmalı — kritik/yüksek bulgularla aynı
   commit'e karıştırmak ikisini de zorlaştırır.

3. **`Y3` ikinci örneği — `KillSwitchPanel.tsx:100` `state.data.reason`. Kapatmadım.**
   Neden: doğrulayıcının kendi değerlendirmesi ("savunulabilir") doğru. Bu bir
   **operatör** metni, sunucu düzyazısı değil; denetim izinde görünmesi
   *gereken* bir gerekçe. Kaba almak, denetim amacını zayıflatır.

---

## ARAYÜZ İSTEKLERİ (donmuş paketler — dokunmadım)

1. **`Role` sözleşmesi ile BFF'in gerçeği çelişiyor.** (Doğrulayıcının işaret
   ettiği madde; kararı sizin.)
   `packages/contracts/src/identity.ts` `Role`'ü **kapalı 6 elemanlı** küme
   yapıyor. Ama BFF'in kendi tipi `readonly string[]` (`apps/bff/src/deps.ts:95`)
   ve `GET /studio/users/:username` dizinden geleni **filtresiz** geçiriyor
   (`studio-catalog.ts:122-127`). Studio tarafında `DirectoryUser.roles`
   `readonly Role[]` diye tipli (`common/admin-api.ts:70`) — yani tip sistemi
   bir garanti veriyormuş gibi görünüyor, gerçekte yok.

   Y1 düzeltmesi bu çelişkiyi **çökmez** hâle getirdi (bilinmeyen rol gösteriliyor,
   işaretleniyor, yetki rengi almıyor), ama çelişkinin kendisi duruyor. Üç seçenek:
   (a) BFF dizin gruplarını `Role`'e göre filtrelesin — kapalı küme gerçek olur,
   ama bilinmeyen grup **sessizce kaybolur** (denetimde kötü);
   (b) `DirectoryUser.roles` sözleşmede `string[]` olsun, `Role` yalnız *yetki*
   kararları için kalsın — tip dürüst olur (**benim önerim**);
   (c) olduğu gibi kalsın, Studio savunmasıyla yaşasın.
   Karar sizin; hiçbirini uygulamadım.

2. **Studio `humanBehind`/`samePerson`'a erişemiyor.** O1 için dört-göz kişi
   karşılaştırmasını `ParamEditor.tsx`'te **yeniden yazmak** zorunda kaldım
   (`ai-via:` önekini soyma). Mantık `@maestro/audit`'te var ama Studio o pakete
   bağlı değil ve bağlamak istemedim (sunucu tarafı bir paketi tarayıcı
   bundle'ına sokmak). Kural iki yerde yazılı olduğu için ayrışabilir.
   Öneri: `humanBehind` gibi saf kimlik yardımcıları `packages/contracts`'e
   taşınsın (ikisi de zaten oraya bağlı). Sunum katmanı olduğu için risk düşük —
   yetki kararı hâlâ sunucuda.

---

## Mutasyon kanıtları özeti

Her düzeltme için: davranışı boz → testin kırıldığını gör → geri al.
Baz durum her seferinde 202/202 yeşile döndürüldü.

| # | Bulgu | Mutasyon | Sonuç |
|---|---|---|---|
| 1 | K1 yol | `/studio/runs/.../journal` → `/runs/.../journal` | **2 test kırıldı** |
| 2 | K1 şekil | `data?.items` → `data?.entries` | **1 test kırıldı** (sessiz boş yakalandı) |
| 3 | Y1 | `useEnumLabel` catch dalı yeniden fırlatsın | **3 test kırıldı** (ekran kararması) |
| 4 | Y2 | `signals.ts:68` ret kapısını sil | **3 test kırıldı** (önce: 0) |
| 5 | Y3 | `cell: (row) => row.finding.message` geri koy | **1 test kırıldı** (sır sayfada) |
| 6 | O1 | `ownProposal = false` | **2 test kırıldı** |
| 7 | O2 | `unwired.tsx` `NotAvailable` dalını sil | **1 test kırıldı** |
| 8 | O3 | pasif hesapta `<s>` sarmalını kaldır | **1 test kırıldı** |
| 9 | D1 | `TR_FOLD`'dan `ı` girdisini sil | **3 test kırıldı** |
| 10 | D1 (sıra) | fold'u tekrar `toLowerCase()` sonrasına al | **kırılmadı** — davranış-nötr olduğu için (yukarıda açıklandı) |
| 11 | D2 | `DETAILED_ERRORS`'a `"ApiError"` ekle | **1 test kırıldı** |
| 12 | EK-2 | `"{age}tir açık"` geri koy | **1 test kırıldı** |

---

## Canlı doğrulama (demo yığını, gerçek tarayıcı)

`pnpm demo:up` + Playwright, `ayse.kaya` / admin:

- `/template` → `/api/template` konsolda **1 kez** (önce 3), her iki bölüm
  "Bu bölüm henüz yayında değil". Boş panel yok. **(EK-1)**
- `/dash` → "16 gün açık", "6 gün açık" — "güntir" yok. **(EK-2)**
- `/security` → gitleaks bulgusu "Tarayıcı metnini göster" düğmesi arkasında;
  önem/araç/konum açıkta. **(Y3)**

---

## Değişen dosyalar

**Kaynak (18):** `app/App.tsx`, `app/ErrorBoundary.tsx`, `screens/common/label.ts`,
`screens/common/index.ts`, `screens/shared/runs.ts`, `screens/detail/JournalTab.tsx`,
`screens/Evidence.tsx`, `screens/Security.tsx`, `screens/Users.tsx`, `screens/Sandbox.tsx`,
`screens/Cost.tsx`, `screens/Llm.tsx`, `screens/Variants.tsx`, `screens/Variant.tsx`,
`screens/Routing.tsx`, `screens/Cache.tsx`, `screens/Settings.tsx`, `screens/Notify.tsx`,
`screens/Commands.tsx`, `screens/Mcp.tsx`, `screens/Yaml.tsx`, `screens/Onboard.tsx`,
`screens/Tickets.tsx`, `screens/Dash.tsx`, `screens/Params.tsx`,
`screens/params/ParamEditor.tsx`, `screens/template/model.ts`

**Test (3):** `test/hardening.test.tsx` (yeni), `test/flow-screens.test.tsx`,
`test/screens-params.test.tsx`

**Katalog (2):** `packages/config/locales/tr.json`, `en.json` — +13 anahtar
(`value.*` 5, `params.guarded.own_proposal`, `users.note.role_not_in_force`),
1 düzeltme (`dash.attention.age`). Parite 1327 = 1327, iki dosya da sıralı.

`packages/contracts`, `packages/ports`, `apps/bff/` — **dokunulmadı**.
