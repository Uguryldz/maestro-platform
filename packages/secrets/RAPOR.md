# RAPOR — `@maestro/secrets` (Dalga 1)

`SecretPort` (M80) iki sürücüsü: **vault** (HashiCorp Vault KV v2 + AppRole) ve **env-file** (dev).
Kod/yorum/test adları İngilizce (M59); bu rapor Türkçe.

> **Revizyon 2 (sertleştirme turu).** Bağımsız doğrulayıcının **KOŞULLU GEÇTİ** raporundaki
> B1-B11 bulguları kapatıldı; §6 bulgu bazında durumu verir. Revizyon 1'de bu raporda yer alan
> **yanlış bir iddia** da düzeltildi (§1, üretim kapısı maddesi).

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/keys.ts` | Ortak anahtar dilbilgisi: `<mount>/<path>[#<field>]`. Segment kuralı path-traversal'ı (`..`, boş segment, boşluk) kapatır. `parseScope` kısa ömürlü kimlik kapsamı için **gerçek üst-sistem adlarını** kabul eden ayrı bir kural uygular (aşağı bakınız). `envVarName` env-file eşlemesi — **tersine çevrilebilir (enjektif)** kodlama. |
| `src/stage.ts` | **(yeni)** Dağıtım aşaması çözümü: `NodeEnv` (`development`/`test`/`production`, `@maestro/config`'in `EnvSchema`'sıyla birebir aynı), `normalizeStage`, `resolveStage`, `isProductionStage`. Ortam **yalnız sıkılaştırabilir** kuralı burada yaşar. |
| `src/config.ts` | Zod yapılandırması: `VaultConfig`, `EnvFileConfig`, `ShortLivedConfig`. `allowedMounts` (en az 1 — boş liste joker DEĞİL), TTL tavanları, sabitler. `addr` için **TLS kapısı** (`vaultAddrIssue` + `allowInsecureAddr`). |
| `src/errors.ts` | Tipli hatalar: `SecretNotFoundError` (404), `SecretPermissionDeniedError` (403 / mount izinsiz), `VaultSealedError` (501/503), `VaultHttpError`, `VaultResponseError`, `SecretTtlError`, `SecretExpiredError`, `SecretKeyError`, `SecretConfigError`. Hiçbiri yanıt gövdesi taşımaz. |
| `src/cache.ts` | Enjekte saat (`Clock`) + TTL'li bellek içi önbellek. Değerler `#private` alanda. |
| `src/vault-client.ts` | AppRole login, lease takibi, süre dolmadan `renew-self` ile yenileme (başarısızsa yeniden login), eşzamanlı isteklerde tek-uçuş (single-flight) login, KV/dinamik okuma, durum→hata eşlemesi. Enjekte `fetch`. Yenileme penceresi lease'in yarısıyla sınırlı; login yanıtında `client_token` **zorunlu**. |
| `src/vault-driver.ts` | `SecretPort` uygulaması: `get()` (KV v2 `data/` öneki, alan seçimi, önbellek) + `issueShortLived()` (M31). Tavan **verilen lease'e de** uygulanır. |
| `src/env-file-driver.ts` | Ortam değişkeni + opsiyonel dotenv dosyası. `issueShortLived` → `CapabilityNotSupportedError`. Üretimde **kurucuda** reddedilir. |
| `src/register.ts` | `registerSecretDrivers(registry)` — M44 DI; iki sürücü de `secret` portuna kayıtlı. |
| `src/index.ts` | Paket dış yüzeyi. `VaultClient` **yalnız tip olarak** dışa verilir (değer olarak değil). |
| `fixtures/*.json` | Kayıtlı-biçim Vault yanıtları (login, renew, KV okuma, silinmiş KV, dinamik kimlik, 403/503 gövdeleri) + `ado-names.json` (gerçek ADO proje/repo adları). Test hiçbir yanıt şeklini satır içinde uydurmuyor (§5 "halüsinasyon entegrasyon" maddesi). |

### Fail-closed davranışlar (M6 ruhu)
- `allowedMounts` dışındaki mount → **istek yapılmadan** `SecretPermissionDeniedError`.
  İzin listesi **tam eşleşmeyle** uygulanır: `["kv"]` izni `kvault/…`, `kv-root/…`, `KV/…` için geçerli değildir.
- Bozuk anahtar/kapsam → **istek yapılmadan** `SecretKeyError`.
- Alan yoksa **veya boş string** ise → `SecretNotFoundError` (boş secret = yer tutucu = yok sayılır).
- `issueShortLived` TTL zorunlu, pozitif tam sayı, `maxTtlSeconds` tavanının üstü **reddedilir** (kırpılmaz).
- **Tavan verilen lease'i de bağlar (M31).** Vault'un döndürdüğü `lease_duration` tavanın üstündeyse
  ya da istenen pencereyi (`ttl + 60 s` saat kayması payı) aşıyorsa → `SecretTtlError`.
  `lease_duration` **yoksa/kullanılamazsa tahmin edilmez** → `VaultResponseError`.
  `lease_duration <= 0` → `SecretExpiredError`. Süresi dolmuş kimlik asla dönmez.
- Login yanıtında `client_token` yoksa → `VaultResponseError`; **iptal edilmiş token yeniden benimsenmez**
  (eski token'a düşme yalnız `renew-self` yolunda, yani zaten elde olan token'ın ömrünü uzatırken geçerlidir).
- `addr` https değilse yapılandırma reddedilir; `allowInsecureAddr: true` yalnız üretim dışında kaçış sağlar,
  üretimde kaçış anahtarı da çalışmaz (hem Zod'da hem `VaultClient` kurucusunda).
- `filePath` yapılandırılmış ama okunamıyorsa hata yükselir (sessizce boş kaynak yok).
- AppRole `roleId`/`secretId` yoksa istemci kurulmaz.
- **Üretimde `env-file` sürücüsü kurulmaz** (`SecretConfigError`), fabrika yolunda değil **sınıf kurucusunda**.
  Kapı hem enjekte edilen `deps.nodeEnv` değerine hem de **ayaktaki sürecin `process.env.NODE_ENV`'ine** bakar
  ve **yalnız sıkılaştırma** yönünde birleştirir: `NODE_ENV=production` olan bir süreçte çağıran
  `deps:{nodeEnv:"development"}` verse de sürücü kurulmaz. Tanınmayan aşama değerleri
  (`prod`, `PROD`, `Production`, `staging`, string olmayan değerler) "üretim değil" sayılmaz, **reddedilir**.

> **Düzeltme (Revizyon 1'in yanlış iddiası).** Bu raporun önceki sürümü kapı için
> *"DI'yi atlayarak da kaçırılamaz"* diyordu. Doğrulayıcı bunun tersini kanıtladı: kaçış **DI'yi atlayarak
> değil, tam da DI ÜZERİNDEN** oluyordu (`options.nodeEnv ?? process.env.NODE_ENV` — çağıranın değeri
> öncelikliydi ve Zod'dan geçmiyordu), ayrıca kapı yalnız birebir `"production"` metnini tanıyordu.
> İddia artık geçerli: kapı çağıranın değerini **yalnız sıkılaştırma yönünde** kabul eder (B1).

### Sızıntı koruması
- Secret materyali (`role_id`, `secret_id`, client token, önbellekteki değerler) yalnız ECMAScript `#private`
  alanlarda; `JSON.stringify`, `Object.keys`, `util.inspect` bunları göremez.
- `toJSON()`/`toString()` her sınıfta açıkça yazıldı; yalnız adres/sürücü/izinli mount/önbellek sayısı döner.
- Hatalar **asla** yanıt gövdesi taşımaz (adapter-jira'daki `responseBody` alanı bilinçli olarak kopyalanmadı —
  Vault gövdesi tanım gereği secret'tır). Yeni hata metinleri de yalnız **sayı** taşır
  (ör. "vault granted 86400s"), gövde ya da kimlik değeri taşımaz.
- `test/leak.test.ts` bunu 10 testle kanıtlar; kontrol yüzeyi `String()`, `JSON.stringify()`,
  `util.inspect()` ve `Error.stack`. Bu tur sızıntı duruşuna **dokunulmadı**, 10 test aynen yeşil.

## 2. Test özeti

`pnpm -F @maestro/secrets test` → **8 dosya / 197 test yeşil** (önceki tur: 110), tamamen çevrimdışı ve
deterministik (enjekte `fetch` + sabit saat; ağ yok, `sleep` yok, `Date.now()` yok).

| Dosya | Kapsam |
|---|---|
| `keys.test.ts` (59) | Dilbilgisi, varsayılan alan, 9 ret vakası (traversal dâhil); **`envVarName` enjektifliği** (21 anahtarlık külliyat + ayraç çiftleri + POSIX ad biçimi); **`parseScope` gerçek ADO adları** (fikstürden 15 kapsam) ve 21 saldırı dizesi |
| `cache.test.ts` (4) | TTL içi isabet, sınırda ıskalama + tahliye, TTL=0, `clear` |
| `vault-client.test.ts` (27) | Login gövdesi/başlıkları, token yeniden kullanımı, tek-uçuş, namespace, lease takibi, skew içinde renew, renew reddi→login, renewable=false→login, **renewable alanı YOK→login (fail-closed)**, **login'de `client_token` yoksa hata**, **renew'de eski token korunur**, **kısa lease'te skew kırpması**, **kullanılamaz auth lease'i**, **üretimde http adres reddi**, 403/404 veri olarak, 501/503/500/429 eşlemesi, bozuk/boş gövde |
| `vault-driver.test.ts` (37) | KV `data/` yolu, varsayılan alan, önbellek TTL ve `invalidate`, 403/404/503, boş/eksik alan, mount izni, bozuk anahtar; issueShortLived: ttl query'si, lease önceliği, tavan reddi, `0/-1/1.5/NaN` reddi, kapsam traversal reddi, süresi dolmuş red, alan eksik, önbelleklenmeme, **gerçek ADO adıyla kapsam URL'i**, **verilen lease tavan/pencere/eksik/absürt (7 vaka) denetimi** |
| `env-file-driver.test.ts` (27) | Ortamdan okuma, yok/boş, mount izni, bozuk anahtar, özel önek, dosya kaynağı + ortam önceliği + tek okuma + `invalidate`, okunamayan dosya, `parseDotEnv`, `CapabilityNotSupportedError`, üretim reddi (2 yol), **ortam-sıkılaştırır kapısı (6 vaka)**, **ayraç çakışmasında yanlış secret dönmediği** |
| `driver-invariance.test.ts` (18) | `describe.each` ile iki sürücüde aynı senaryolar: var → aynı değer; yok → `SecretNotFoundError`; izinsiz → `SecretPermissionDeniedError`; **önek-eşleşmesi reddi (4 vaka)**; bozuk → `SecretKeyError`; her hata sorulan anahtarı adlandırır |
| `leak.test.ts` (10) | Sürücü/istemci/önbellek render'ı ve 500/bozuk-gövde/expiry/login-hatası/404 hataları secret içermiyor + "aşırı redaksiyon yok" karşı-testi |
| `register.test.ts` (15) | Kayıt, iki sürücünün çözümlenmesi, bilinmeyen sürücü reddi, varsayılanlar, geçersiz config'in tüm alanları raporlaması, tavanlar, **https zorunluluğu + dev kaçış anahtarı + üretimde kaçışın kapanması**, **`VaultClient`'ın dış yüzeyde olmadığı** |

**Mutasyon denetimi.** Doğrulayıcının 25 mutantından hayatta kalan 2'si (B11) artık ölüyor. Bu turda
düzeltilen her dal için ayrıca mutant koşuldu ve **14/14 mutant öldü**; hepsi:
`renewable === true → !== false` · `includes(mount) → some(startsWith)` · ortam sıkılaştırmasının kaldırılması ·
`envVarName` kaçışının `"_"`e düşürülmesi · verilen lease tavanının kaldırılması · istenen pencere kontrolünün
kaldırılması · `Number.isSafeInteger` kontrolünün gevşetilmesi · eksik lease'te istenen TTL'in tahmin edilmesi ·
login'de eski token'a düşme · skew kırpmasının kaldırılması · üretim https kontrolünün kapatılması ·
kapsam kontrol-karakteri/boşluk/traversal kurallarının tek tek kaldırılması. Geri alma sonrası 197/197 yeşil.

**Kapı durumu:** `pnpm install` ✔ · `pnpm -F @maestro/secrets typecheck` ✔ · `pnpm -F @maestro/secrets test` ✔ (197) ·
kökten `pnpm lint` ✔ · `pnpm typecheck` ✔ · `pnpm test` ✔ (`turbo --force` ile 24/24 görev, önbelleksiz).
Üretim kodu **1074 satır** (tavan 1200), en büyük dosya 215 satır (tavan 300). Yeni runtime bağımlılığı **yok**.

## 3. Varsayımlar

1. **KV sürüm 2.** `get()` yolu `<addr>/v1/<mount>/data/<path>`, yanıt `{data:{data:{...}}}`. KV v1 kullanılacaksa
   sürücüye `kvVersion` yapılandırması eklenmeli (5 satırlık iş).
2. **Anahtar dilbilgisi** `<mount>/<path>[#<field>]`, alan varsayılanı `value`. `adapter-jira`'daki
   `tokenRef: "kv/jira/pat"` örneği bu dilbilgisiyle uyumlu.
3. **Kapsam (scope) dilbilgisi anahtar dilbilgisinden AYRIDIR.** Anahtar segmentlerini biz seçeriz, kapsam
   segmentlerini üst sistem seçer: `adapter-ado` `ado/<project>/<repo>/push` üretir ve `RepoRef.project/repo`
   sözleşmede `NonEmpty`'dir. Bu yüzden kapsamda **boşluk, nokta, alt çizgi, ASCII-dışı harf serbesttir**
   ("Core Banking", ".github", "_internal-tools", "Ödeme Sistemleri"), yasak olan yalnızca yolu tehlikeli
   kılan şeylerdir: boş segment, `.`/`..`, baştaki/sondaki boşluk, C0/C1 kontrol karakterleri ve DEL,
   `\` (WHATWG URL bunu `/` sayar), `%` (sunucu tarafında `%2e%2e` çözülür), `?`, `#`, 512 karakter üstü.
4. **Kısa ömürlü kimlik** dinamik bir secrets engine'den okunur: `<shortLived.mount>/<pathPrefix>/<scope>?ttl=<n>s`,
   yanıtta `lease_duration` ve `data.<field>` **zorunludur**. Varsayılanlar `git`/`creds`/`token`/900 s.
   Verilen lease'in istenen pencereyi aşma payı **60 s**'dir; bu sayı `adapter-ado`'daki `EXPIRY_SKEW_SECONDS`
   ile bilerek aynıdır — iki paket "kısa ömürlü" tanımında ayrışmamalı (M31).
5. **AppRole** kimlik doğrulama; `role_id`/`secret_id` çalışma zamanı bağımlılığı olarak kompozisyon kökünden
   enjekte edilir — yapılandırmada asla yazmaz.
6. **Aşama işareti** `NODE_ENV ∈ {development, test, production}` (`@maestro/config/env.ts` ile aynı enum).
   Bu paket enum dışındaki değeri (ör. `staging`) **tanımıyor ve reddediyor**; kurumda böyle bir aşama adı
   kullanılacaksa doğru yer `EnvSchema` — tek elden eklenmeli.
7. **env-file değişken adı**: `MAESTRO_SECRET_<MOUNT>_<PATH>__<FIELD>`; `/` ayracı `_` olur, küçük harfler
   büyütülür, **başka her karakter `__<HEX>_` olarak kaçırılır**. Tümü küçük harf olan yaygın anahtarlar
   eskisiyle **birebir aynı** adı alır (`kv/jira/pat#token` → `MAESTRO_SECRET_KV_JIRA_PAT__TOKEN`);
   ayrım gerektiren durumlar artık çakışmaz (`kv/jira-prod/pat` → `MAESTRO_SECRET_KV_JIRA__2D_PROD_PAT__VALUE`,
   `kv/jira/prod/pat` → `MAESTRO_SECRET_KV_JIRA_PROD_PAT__VALUE`). Büyük/küçük harf de kaçırılır, çünkü
   Windows'ta ortam değişkeni adları büyük/küçük harf duyarsızdır.
8. **Vault adresi https.** `http://` yalnız üretim dışında ve yalnız `allowInsecureAddr: true` ile
   (dev-compose `http://127.0.0.1:8200`). Üretimde kaçış anahtarı yok sayılır.
9. 5xx'te **yeniden deneme yok** — dayanıklı retry Temporal'ın işi (adapter-jira ile aynı duruş).

## 4. Arayüz / bağımlılık talepleri (orkestratöre)

> `packages/contracts` ve `packages/ports` **hiç değiştirilmedi**. Aşağıdakiler talep, uygulama değil.

1. **`DriverFactory` çalışma-zamanı bağımlılıkları (tekrarlanan talep).** `DriverFactory<P> = (config: unknown) => P`
   imzasında `fetch`, saat, AppRole materyali için yer yok; `adapter-jira`'nın başlattığı `{...config, deps:{...}}`
   sözleşmesini aynen sürdürdüm. **Bu turda görüldü ki `deps` yalnız ergonomi sorunu değil, güvenlik sınırı:**
   Zod'dan geçmediği için içine konan `nodeEnv` bir kapıyı gevşetebiliyordu (B1). Şimdilik güvenlik etkisi olan
   tek `deps` alanı sürücünün kendisinde doğrulanıyor; kalıcı çözüm `resolve(port, driver)(config, deps)` gibi
   şemalı ikinci bir parametre — tek elden karar.
2. **`SecretPort.get` düz `string` döndürüyor.** Paket içinde sızıntıyı kapattım ama değer porttan çıktığı an
   düz string olarak çağıranın log'una girebilir. İleride `ports`'a `SecretValue` sarmalayıcısı eklenirse koruma
   uçtan uca olur. Dalga 2'de runner/execution paketleri secret'ı taşımaya başlayınca değerlendirilmeli.
3. **`@maestro/config/env.ts`**: `VAULT_ADDR` var; `VAULT_ROLE_ID` / `VAULT_SECRET_ID` (veya dosya yolları) ve
   `MAESTRO_SECRET_DRIVER` yok. Kompozisyon kökü kurulurken `EnvSchema`'ya eklenmeli ve üretimde zorunlu listeye
   girmeli — bu paket `config`'e dokunmadı.
4. **Lease iptali.** `ScmPort.getPushCredential(ttl)` bittiğinde kimliği erken iptal etmek isteyecek
   (`sys/leases/revoke`). Bu `SecretPort`'a bir `revoke(handle)` yöntemi gerektirir; port dondurulmuş olduğu için
   yazmadım. Dalga 2'de `runners`/`execution` speci yazılırken karara bağlanmalı.
5. **`adapter-ado` ↔ `secrets` kapsam sözleşmesi.** `pushScope` ile `parseScope` artık uyumlu (B5) ve iki paket
   aynı 60 s kaymayı kullanıyor (B2). İkisini birden kıracak bir değişiklik olursa tek elden yapılmalı;
   bugün bunu koruyan şey iki taraftaki fikstür/sabit testleridir, ortak bir modül değildir (paketler arası
   bağımlılık M44 gereği yok).

## 5. Bilerek eksik bırakılanlar

- **CyberArk / Azure Key Vault sürücüleri** — M80 "kurum ürünü belli olunca". Anahtar dilbilgisi ve
  `allowedMounts` kapısı ortak olduğundan yeni sürücü yalnız `get()` + kayıt satırı yazacak.
- **403'te zorla yeniden login + tek tekrar.** Token ortada iptal edilirse faydalı olurdu; gerçek bir yetki
  reddini maskeleyebileceği için yazılmadı. (İptal edilmiş token'ın *yeniden benimsenmesi* ayrı bir hataydı,
  o kapatıldı — B3.)
- **Verilen kısa ömürlü kimliğin yenilenmesi/iptali** (§4 madde 4).
- **Response wrapping (`X-Vault-Wrap-TTL`)** ve **secret-id rotasyonu** — dağıtım (deploy) paketinin işi.
- **KV v1** ve **KV meta/list/write** işlemleri — `SecretPort` yalnız okuma sözleşmesi.
- **`invalidate()` için otomatik tetikleyici (B10 kararı).** `invalidate()` bugün hâlâ üretim kodundan
  çağrılmıyor; bilinçli olarak **korundu**, silinmedi. Gerekçe: (a) exported bir sınıfın kamu API'si ve
  test edilmiş, (b) güvenlik anlamı var — sızdığı düşünülen bir değeri önbellekten atmanın başka yolu yok,
  (c) 3 satır; Dalga 2'de rotasyon sinyali (M71 parametre değişimi) bağlandığında aynısı yeniden yazılacaktı.
  Spekülatif bir "rotation signal" API'si eklemek ise spec dışına taşma olurdu. Karar Dalga 2'de
  `runners`/`execution` speci yazılırken tek satırla bağlanacak.
  Not: doğrulayıcının aynı maddede andığı `tokenExpiresAtMs()` ölü değildir — `VaultClient.toJSON()` onu kullanır.

## 6. Doğrulayıcı bulguları — kapanış durumu (B1-B11)

| # | Bulgu | Durum | Nerede |
|---|---|---|---|
| B1 | Üretim kapısı çağıran tarafından kapatılabiliyor | **Kapandı** | `src/stage.ts` (yeni), `src/env-file-driver.ts`; ortam yalnız sıkılaştırır, `NodeEnv` enum'u ile normalize, tanınmayan değer reddedilir. Yanlış rapor iddiası §1'de düzeltildi. |
| B2 | M31 tavanı verilen lease'e uygulanmıyor | **Kapandı** | `src/vault-driver.ts`; `granted > maxTtlSeconds` ve `granted > ttl + 60` → `SecretTtlError`, `lease_duration` yoksa `VaultResponseError` (tahmin yok). |
| B3 | İptal edilmiş token yeniden benimseniyor | **Kapandı** | `src/vault-client.ts`; `#adoptAuth(..., keepCurrentToken)` — eski token'a düşme yalnız renew yolunda. |
| B4 | `envVarName` enjektif değil | **Kapandı** | `src/keys.ts`; `__<HEX>_` kaçışlı tersine çevrilebilir kodlama + çakışma testleri + uçtan uca "yanlış secret dönmüyor" testi. |
| B5 | Scope dilbilgisi gerçek ADO adlarını reddediyor | **Kapandı** | `src/keys.ts` `parseScope` deny-list'e geçti; `fixtures/ado-names.json` ile fikstür testi, 21 saldırı dizesi hâlâ reddediliyor. |
| B6 | Absürt lease tiplenmemiş `RangeError` veriyor | **Kapandı** | `src/vault-driver.ts`; `Number.isSafeInteger` + sınır kontrolleri **tarih aritmetiğinden önce**. |
| B7 | `addr: z.url()` düz http'ye izin veriyor | **Kapandı** | `src/config.ts` `vaultAddrIssue` + `allowInsecureAddr`; üretimde kaçış anahtarı da geçersiz, kontrol hem şemada hem `VaultClient` kurucusunda. |
| B8 | `VaultClient` dışa açık, mount kapısını atlıyor | **Kapandı** | `src/index.ts`; yalnız `export type` — değer olarak dışa verilmiyor, testler paket içinden alıyor. |
| B9 | Lease < skew ise her okumada yeni login | **Kapandı** | `src/vault-client.ts`; `renewAt = expiry - min(skew, lease/2)`. |
| B10 | Ölü yol (`invalidate`, `tokenExpiresAtMs`) | **Karara bağlandı** | §5 son madde: `invalidate()` gerekçeli korundu; `tokenExpiresAtMs()` zaten `toJSON()` tarafından kullanılıyor. |
| B11 | Hayatta kalan 2 mutant | **Kapandı** | `test/vault-client.test.ts` (`renewable` alanı olmayan auth bloğu) ve `test/driver-invariance.test.ts` (izin listesi önek eşleşmesi). İkisi de mutantla kırmızıya düşüyor. |
