# Studio ekranları — küme B (yönetim ekranları)

Dalga 4 · 11 ekran · platformu yöneten, ayarlayan ekranlar.

**Branch:** `worktree-agent-ab01b419310e9e82d`
**Temel:** `78783a7` · küme A (`f199ebb`) sonrası **yeni BFF uçlarına ve
`screens/shared/` modülüne göre revize edildi**.

**Kapı:** `pnpm run gate` → **exit 0** (50/50 görev).
`pnpm --filter @maestro/studio build` → **exit 0**.
Studio testleri: **93** (56 iskelet + **37 yeni**). Hiçbir dosya 300 satırı geçmiyor
(en büyük: `common/admin-api.ts` 260).

---

## 0. Koordinasyon notuna göre yapılan revizyon

Küme A `main`'e girdikten sonra üç şey değişti ve üçüne de uyum sağlandı:

1. **`screens/shared/` kullanılıyor.** Kendi yazdığım `common/QueryState.tsx`
   **silindi**; artık `shared/QueryState.tsx` (ve `NotAvailable`) kullanılıyor,
   `shared/format.ts`'ten `ageLabel` + `byteSize` alınıyor. `shared/` altındaki
   hiçbir dosya **değiştirilmedi**. `common/index.ts` bunları yalnızca yeniden
   dışa vuruyor (yönetim ekranı tek yerden import etsin diye), sahiplenmiyor.
2. **Gerçek uçlar bağlandı.** `/studio/runners`, `/studio/sandboxes`,
   `/studio/health`, `/studio/users/:username` **artık var** — bu dört ekran
   uydurma sözleşmelerimden **BFF'in gerçek okuma modellerine** taşındı
   (`RunnerRecord`, `SandboxRecord`, `ServiceHealth`, `DirectoryUser`).
   Bu, özellikle `users` ekranını kökten değiştirdi (§1).
3. **Katalog çakışması yok.** Küme A'nın 320 anahtarı birleştirildi;
   **0 çakışma** (anahtarlarım ekran adıyla ön ekli). Ortak `action.*`,
   `empty.*`, `state.*`, `age.*`, `unit.*` anahtarları **yeniden tanımlanmadı**,
   olduğu gibi kullanıldı. Şu an tr/en **906'şar anahtar, parite tam**.

Revizyonda **72 anahtar silindi** — karşılığı olmayan uçlar için yazılmış
etiketlerdi (rol düzenleme, sandbox oturum zarfı, yedekleme alanları). Ölü
katalog anahtarı bırakmadım.

---

## 1. Yazılan ekranlar

| Ekran | Uç | Ne yapar |
|---|---|---|
| **params** | `GET /params`, `PUT /params/:key` **(canlı)** | Tanım + değer + bekleyen öneri birleştirilir; hiç değişmemiş parametre varsayılanıyla görünür. `guarded` parametre **doğrudan kaydedilmez**: düğme "Onaya gönder", 202 → "eski değer hâlâ geçerli", açık öneri satırda öneren kişiyle. Tür istemcide de doğrulanır. |
| **settings** | `GET /settings` *(istek)* + `GET/POST /killswitch` **(canlı)** | Bağlantılar + bildirim sürücüleri + **kill-switch paneli**. Secret gösterilmez, yalnız Vault referansı. |
| **users** | `GET /studio/users/:username` **(canlı)** | **Yönetim tablosu değil, sorgu ekranı** — gerekçe aşağıda. Hesabın rolleri/grupları/aktifliği + kapalı rol kümesi açıklamalı + SoD kuralları. Pasif hesapta **"verilmiş token süresi dolana kadar geçerli kalabilir"** uyarısı. |
| **yaml** | `GET /repo-policy` *(istek)* | `.maestro.yaml` **salt-okunur**. Korumalı yollar (M52) iki yarım: platform varsayılanları salt-okunur (**silme düğmesi yok**), repo eklemeleri eklenip kaldırılabilir. |
| **runners** | `GET /studio/runners` **(canlı)** | `unreachable` **en üste sıralanır** + uyarı bandı. Havuz toplamları **BFF'ten alınır** (istemci yeniden hesaplamaz); ekran yalnızca sunucunun göndermediği "kaç makine karanlık" bilgisini ekler. |
| **sandbox** | `GET /studio/sandboxes` **(canlı)** | Oturum listesi (durum, boyut, son erişim). **Transkript yok, silme düğmesi yok** — ikisinin de gerekçesi ekranda yazılı. `human_held` ayrı durum. |
| **mcp** | `GET /mcp/manifest` *(istek)* | Kapsamlar (`read`/`operate`/`admin-öneri`) + **yasaklı araçlar** (`approve_gate`, `reject_gate`, `merge_pr`) sunucudan gelir; "kapı kararı veremez" notu iki yerde. |
| **commands** | `GET /commands` *(istek)* | Komut tablosu + doğrulama zinciri. "Yorumun tamamı komut olmalı" ve "yorum düzenlemesi komut sayılmaz" ayrı ayrı. |
| **notify** | `GET /notify` *(istek)* | Merdiven, delegasyon, bekleyenler. "Hiçbir aşamada otomatik ret yok". |
| **health** | `GET /studio/health` **(canlı)** | Servis tablosu + **BFF'in hesapladığı** genel durum. Yedekleme/tatbikat paneli **`NotAvailable`** olarak işaretli — uç yok, uydurma tarih basılmıyor. |
| **onboard** | `/onboarding/*` *(istek)* | 4 adım, hepsi `Select`. **Kuru koşum (M102) zorunlu**; taslak değişince eski sonuç geçersiz. Çözülemeyen ticket'lar isimle. |

### `users` neden tablo değil, sorgu ekranı?
BFF **tek bir uç** veriyor: `GET /studio/users/:username`. Liste ucu ve
**hiçbir mutasyon ucu yok**, çünkü kimlik ve yetkinin doğruluk kaynağı dizin
(AD/LDAP grup üyeliği, M8) — Maestro o eşlemeyi *okur*. Rol düzenleme veya
"Pasifleştir" düğmesi koymak (a) var olmayan uçları çağırmak, (b) daha kötüsü,
**Studio'dan pasifleştirmenin erişimi her yerde kestiği izlenimini vermek**
olurdu. Onun yerine ekran, platformun hesap hakkında *bildiğini* dürüstçe
gösteriyor ve pasif hesapta token ömrü uyarısını basıyor.

> İlk sürümde `PUT /users/:id/roles` ve `PUT /users/:id/active` uçlarını
> **istek olarak** yazmıştım (rol editörü + pasifleştirme onay modalı dahil).
> Gerçek uç tek yönlü çıkınca o kodu **sildim** — uydurma uca bağlı çalışan
> arayüz bırakmak, görev tanımındaki "çalışıyor gibi sahte veri" tuzağının ta
> kendisi olurdu. Yetki yönetimi ürün olarak isteniyorsa §4.1 açık istek.

### Ortak parçalar
- **`../shared/`** (küme A'nın, dokunulmadı): `QueryState`, `NotAvailable`,
  `ageLabel`, `byteSize`.
- **`common/`** (benim): `ConfirmModal` (gerekçesiz onay vermez),
  `KeyValue`/`formatValue`/`useDuration`, `useLabel` (§3), `admin-api.ts` +
  `onboarding-api.ts` (uç sözleşmeleri), `screens.css` (yalnız `var(--token)`).

---

## 2. Katalog

tr/en **906'şar anahtar, parite tam**, küme A ile **0 çakışma**.
Ad alanları ekran adıyla ön ekli (`params.*`, `killswitch.*`, `users.*`, …) +
paylaşılan `role.*` (6 rol + açıklama), `platform.*`, `duration.*`,
`field.reason*`. Mevcut genel anahtarlar (`action.*`, `empty.*`, `state.*`,
`age.*`, `unit.*`) **yeniden tanımlanmadı**.

Ekranlarda **tek bir gömülü kullanıcı metni yok**; süre ifadeleri bile
katalogdan (`age.*`, `duration.days_hours`).

---

## 3. `useLabel` — neden var (küme C'yi de ilgilendirir)

Bazı anahtarların son parçası **sunucudan** geliyor:
`health.service.${service}`, `runners.state.${state}`, `platform.${platform}`,
ayrıca `note`/`descriptionKey` gibi doğrudan anahtar taşıyan alanlar.
`t()` eksik anahtarda **fırlatıyor** — ki statik anahtar için doğrusu bu. Ama
sunucudan gelen bir id için yanlış: kataloğun henüz tanımadığı **tek** bir
servis, `ErrorBoundary` üzerinden **tüm sağlık sayfasını** karartırdı ve
görülmesi en gereken satır kaybolurdu. `useLabel(key, fallback)` katalog
biliyorsa çeviriyor, bilmiyorsa **ham id**'yi gösteriyor. Bu, "sunucu *cümlesi*
basma" kuralını çiğnemiyor: basılan şey BFF'in seçtiği makine id'si
(`postgres`, `jira_dc`), düzyazı değil.

---

## 4. UÇ İSTEKLERİ (BFF ajanına)

**Kullandığım canlı uçlar:** `GET/PUT /params*`, `GET/POST /killswitch`,
`GET /studio/runners`, `GET /studio/sandboxes`, `GET /studio/health`,
`GET /studio/users/:username`.

Aşağıdakiler **yok**. Ekranları yazdım ama **uydurma veri göstermiyorlar** —
uç gelene kadar hata durumu gösteriyorlar. Tip sözleşmeleri
`src/screens/common/admin-api.ts` ve `onboarding-api.ts` içinde.

> **Ortak kural:** kullanıcıya görünecek metin **katalog anahtarı** olarak
> dönmeli (`note`, `descriptionKey`, `whenKey`), düzyazı olarak değil (M104).

### 4.1 Kullanıcı yönetimi — **ürün kararı gerekiyor**
Bugün yalnız tek kullanıcı sorgusu var. Studio'dan yetki yönetimi isteniyorsa
gereken: `GET /studio/users` (sayfalı liste) + `PUT /studio/users/:username/roles`
+ `PUT /studio/users/:username/active` (gövdede **zorunlu `reason`**).
**Ama önce şu karar verilmeli:** roller dizinden geliyorsa (M8) Studio'dan rol
vermek dizinle çelişir. Kararın hangi yöne gittiğini bilmeden ekran yazmadım.
Ayrıca pasifleştirme ucu gelirse **hesabın açık oturumlarını da düşürmeli** ve
yanıtta kalan oturum sayısını dönmeli — arayüz "pasifleştirildi ama N oturum
açık" uyarısını basabilsin diye (geçmişteki "iptal edilen hesap 8 saat admin
kaldı" açığı).

### 4.2 `GET /settings` → `SettingsView`
`connections[]{id,endpoint,status,credentialRef,checkedAt}` — `credentialRef`
**Vault yolu veya auth yöntemi**, asla secret. `notifyDrivers[]{channel,enabled,target}`.
(Mockta "Bağlantıyı test et" düğmesi var; `POST /settings/connections/:id/test`
gelirse takarım — çalışmayan düğme çizmedim.)

### 4.3 `GET /notify` → `NotifyView`
`ladder[]{afterHours,channels[],kind:"notify"|"delegate"|"report"}`,
`delegations[]{role,primary,backup,lastResort}`,
`waiting[]{ticketKey,step,waitingHours,lastActionKey,lastActionParams}`.
`step` katalog son-parçası (`analysis`,`pr`,`clarification`,`test_plan`,`test_result`).
**Not:** `/studio/gates` bekleyen kapıları zaten veriyor (`waitingDays` dahil) —
"bekleyenler" kartı oraya bağlanabilir; merdiven ve delegasyon kaydı için yine
de ayrı uç gerekiyor.

### 4.4 `GET /mcp/manifest` → `McpView`
`endpoint`, `auditActor`, `tools[]{name,scope,descriptionKey}`, **`forbiddenTools[]`**.
Yasaklı liste **sunucudan gelmeli** — Studio'da sabitlersem, MCP'ye bir gün
`approve_gate` eklenirse ekran yalan söylemeye devam eder.
Araç adı: mockta `toggle_killswitch`, doğrusu **`propose_killswitch`** (`admin-proposal`).

### 4.5 `GET /commands` → `CommandsView`
`commands[]{name,roles[],takesArgument,whenKey,effectKey}`.
Kaynak `apps/bff/src/jira-commands.ts`'te zaten var; dışa vurulması yeterli.

### 4.6 `GET /repo-policy` → `RepoPolicyView`
`policies[]{appId,platform,repo,yaml,protectedPaths{**platformDefaults[]**,**repoAdditions[]**},fetchedAt}`.
**İki listenin ayrı gelmesi zorunlu** (M52): tek liste gelirse arayüz varsayılanı
silinebilir gösterir ve sunucunun reddedeceği bir düğme çizmiş olurum.
`POST /repo-policy/:appId/protected-paths` (yalnız ekleme) ·
`DELETE .../protected-paths/:path` (**yalnız `repoAdditions`**; varsayılan için 403).

### 4.7 `GET /onboarding/options` · `POST /onboarding/dry-run` · `POST /onboarding`
Sırasıyla `{jiraProjects[],adoRepos[],platforms[]}`,
`{jiraProject,adoRepo}` → `{byRule[],bySuggestion[],unresolved[]}`,
ve `{jiraProject,adoRepo,platform,triggerMode,gateSet,mergeMode}` → `{proposalId}`.
Sonuncusu **canlı yapılandırma yazmamalı**, admin onay kuyruğuna öneri düşürmeli
(M93). Sunucu da kuru koşumsuz gönderimi reddetmeli (istemci kapısı yeterli değil).

### 4.8 Yedekleme / geri dönüş tatbikatı (M66)
`/studio/health` yalnız servis canlılığı veriyor. Tatbikat takibi için:
`backup{databaseAt,vaultAt,**restoreDrillAt**}` — `restoreDrillAt` **null
dönebilmeli**. Bugün ekranda o panel `NotAvailable`; uydurma "tatbikat
yapılmadı" satırı, platformun konuyu takip ettiği izlenimini verirdi.

### 4.9 Kill-switch öneri kuyruğu (M58+M101) — **eksik kalan tek yapısal parça**
M101'e göre MCP `propose_killswitch` ile **öneri** oluşturur, insan Studio'da
onaylar. BFF'te bekleyen kill-switch önerisi tutan yapı **yok**
(`POST /killswitch` doğrudan uygular). Studio tarafını çift onaylı bir öneri
gibi tasarladım (modal + zorunlu gerekçe + geri alınamaz uyarısı), ama
**MCP'den gelen bekleyen öneriyi listeleyen kuyruğu yapamadım** — veri yok.
Gereken: `GET /killswitch/proposals` → `{proposals[]{id,level,reason,proposedBy,at}}`
ve `POST /killswitch/proposals/:id/approve`. Params'taki 4-göz deseninin
(`pending` + farklı ikinci kişi) kill-switch'e de uygulanması gerekiyor.

---

## 5. Testler (37 yeni)

| Dosya | Adet | Kapsam |
|---|---|---|
| `screens-params.test.tsx` | 7 | Guarded'da "Kaydet" **yok**, "Onaya gönder" var; 202'de "eski değer geçerli"; açık öneri + öneren; hata kodu değil çevrilmiş cümle; tür uymayan değer **PUT edilmez**; değişmemiş parametre varsayılanıyla listelenir. |
| `screens-killswitch.test.tsx` | 6 | Düğmeye basmak **istek göndermez**; gerekçesiz onay **istek göndermez**; onaylanınca gövde `{level,reason}`; delegated oturumda kontroller **gizli**; admin olmayanda **gizli**; `all` onayında "geri alınamaz"; sunucudaki seviye gösterilir. |
| `screens-users.test.tsx` | 6 | Ad girilmeden **hiç istek atılmaz**; hesap görünümü; pasif hesapta **token ömrü uyarısı**; **hiçbir mutasyon düğmesi/checkbox yok** + "roller Maestro'da verilmez"; kapalı rol kümesi listelenir; bilinmeyen kullanıcıda çevrilmiş hata. |
| `screens-platform.test.tsx` | 18 | runners: unreachable **ilk satır** + uyarı + **BFF'in havuz toplamı** basılır; hata çevrilir. sandbox: boş durum uydurmaz, `human_held` ayrı + **silme düğmesi yok**, transkript gerekçesi. yaml: varsayılan için **sıfır** silme düğmesi, yalnız POST (**hiç DELETE yok**), boş yol gönderilmez. mcp: yasaklı araçlar + "karar veremez". health: **sunucunun** genel durumu, tanınmayan servis sayfayı düşürmez, yedekleme paneli **uydurmaz**. commands: iki dil kuralı. notify: otomatik ret yok + "16 gün 2 saat". onboard: kuru koşumsuz gönderim **engelli**, çözülemeyen ticket'lar isimle, taslak değişince kuru koşum geçersiz. |

`test/harness.tsx` — rota tablolu, **her isteği kaydeden** fetch stub'ı; testler
ekranda ne yazdığını **ve ne gönderildiğini** doğruluyor. Tanımsız uç 404
`not_found` döner. Ağa çıkan test yok.

**Mutasyon doğrulaması yapıldı:** `ParamEditor`'da guarded dalının etiketi
`params.action.propose` → `action.save` yapıldığında **2 test kırmızıya döndü**,
düzeltilince yeşillendi. Testler tautolojik değil.

---

## 6. Ortak alana yazdıklarım

`src/ui/`, `src/api/`, `src/app/`, `src/screens/shared/` — **hiçbirine
dokunulmadı**. `src/app/screens.ts` değişmedi.

Tek ortak dosya çifti **katalog** (`packages/config/locales/{tr,en}.json`):
küme A'nın anahtarları birleştirildi (0 çakışma), benimkiler eklendi, ölü
72 anahtar silindi. Paylaşılan `role.*`, `platform.*`, `duration.*`,
`field.reason*` anahtarlarını **ben ekledim** — küme C aynı anahtarı farklı
metinle eklerse çakışır; o durumda benimki silinebilir.

---

## 7. Yapmadıklarım

- **Sandbox canlı transkripti** — PII (M18) taşıyabilir, log ucu da yok.
- **Sandbox/workspace silme** — retention job'ın işi (M65); operatör elindeki
  silme düğmesi insanın içinde çalıştığı oturumu yok eder.
- **Studio'dan rol/hesap yönetimi** — §1 ve §4.1: dizin sahibi, uç yok, ürün kararı gerekiyor.
- **`.maestro.yaml` içerik düzenleme** — dosya repoda yaşar, takımın PR süreciyle değişir.
- **"Bağlantıyı test et" / "AD'den senkronize et" düğmeleri** — uç yok,
  çalışmayan düğme çizmedim.
- **Parametre sürüm geçmişi** — `GET /params` yalnız güncel değerleri dönüyor;
  `GET /params/:key/history` gerekir.
- **Karanlık tema anahtarı**, **rota tablosu değişikliği** — kapsam dışı.

## 8. Not: kapıda görülen flake

Ara koşumlarda `@maestro/storage#test` ve `@maestro/claude-driver#test` birer kez
düştü; ikisi de tek başına geçiyor (210/210, 68/68) ve **değişikliklerim
stash'lenmiş temiz ağaçta da aynı davranış gözlendi** (temel ağaçta bir koşum
exit 0). Zamanlamaya duyarlı iki test `--concurrency=4` altında yük binince
düşüyor. Son üç kapı koşumu **exit 0**; Studio'nun 93 testi her koşumda geçti.
Küme B'nin ürettiği bir sorun değil, ama kapının güvenilirliği ayrıca ele
alınmaya değer.
