# RAPOR — `@maestro/adapter-ldap` (LDAPS kimlik sürücüsü, M8 / Dalga 5)

**Branch:** `worktree-agent-af4be8c9a4596aecb`
**Taban commit:** `1d9d29f` (wave-4)
**Kapı:** `pnpm run gate` → 57/57 yeşil (taban 56/56 + `@maestro/adapter-ldap`)
**Testler:** 104 test, 7 dosya, tamamı çevrimdışı — **hiç ağ çağrısı yok**

---

## 1. Nereye koydum ve neden (M44)

**`packages/adapter-ldap`** — yeni bağımsız paket.

M44 clean-room kuralı: *"eklenti sürücüleri çekirdeğe değil bağımsız paketlere
yazılır; çekirdek onları import etmez, DI ile yüklenir."* `docs/mimari.md:99`
zaten "AD/LDAP kimlik sürücüsü (M8)" satırını **HENÜZ YOK** listesinde
tutuyordu — bu paket o satırı kapatıyor.

`apps/bff/src/auth/ldap-identity.ts` seçeneğini **elemem**in somut sebebi:

- `IdentityProvider` arayüzü `apps/bff/src/deps.ts` içinde yaşıyor, ama
  `apps/bff` bir **uygulama**dır ve `packages/*` içindeki hiçbir paket ona
  bağımlı değil (`grep '@maestro/bff' packages/*/package.json` → sıfır sonuç).
  Sürücüyü BFF'in içine koymak, sürücüyü Fastify'a, bcrypt'e ve BFF'in tüm
  bağımlılık ağacına bağlardı.
- Sürücü `SecretPort`'a ihtiyaç duyuyor (servis hesabı sırrı). Bu
  `@maestro/ports`'ta, yani doğru yön paket→port.
- `DirectoryReader` implementasyonu da bu pakette; o `packages/workflows`'un
  seam'i. BFF içinde olsaydı workflows'un BFF'e bakması gerekirdi.

**Arayüzler `import` edilmiyor, yapısal (structural) olarak karşılanıyor.**
`LdapIdentityProvider` `IdentityProvider`'ı, `LdapDirectoryReader` da
`DirectoryReader`'ı *donmuş sözleşmeleri hiç import etmeden* karşılar; uyumu
composition root'ta derleyici doğrular. Bu, M44'ün istediği yönü korur.

| Dosya | Sorumluluk | Satır |
|---|---|---|
| `src/filter.ts` | RFC 4515/4514 kaçışlama, `{{username}}` şablonu | 121 |
| `src/identity.ts` | Bind akışı, zamanlama eşitleme, fail-closed | 249 |
| `src/account-state.ts` | Pasif hesap tespiti (3 bağımsız sinyal) | 66 |
| `src/roles.ts` | Grup → rol eşlemesi | 76 |
| `src/config.ts` | Zod şeması + `parseRoleMappings` | 202 |
| `src/transport.ts` | TLS zorunluluğu kararı | 77 |
| `src/client.ts` | Dar `LdapConnection` seam'i (soket yok) | 62 |
| `src/ldapts-client.ts` | **Tek** soket açan dosya | 155 |
| `src/directory-reader.ts` | `membersOf` — AD grubu → kurumsal adres | 131 |
| `src/register.ts` | Composition root fabrikaları | 55 |

Hepsi ≤300 satır, TypeScript strict, ESM (`.js` uzantılı importlar).

---

## 2. Grup → rol eşlemesi (YAPILANDIRILABİLİR)

Bugünkü `projectGroupFor()` (`apps/bff/src/routes/access.ts:27`)
`maestro-<projectkey>` kuralını **koda gömüyor**. Bankanın AD şeması farklıysa
platform çatallanmadan kurulamaz — denetimde açık bulgu.

**Örnek konfig (compact form):**

```bash
LDAP_ROLE_MAPPINGS=maestro-admins:admin,maestro-qa:qa,maestro-leads:tech-lead|developer
```

**Örnek konfig (DN'ler için JSON form)** — DN'deki virgüller ayraçla çakıştığı
için:

```bash
LDAP_ROLE_MAPPINGS=[{"group":"CN=maestro-admins,OU=Groups,DC=bank,DC=local","roles":["admin"]},{"group":"CN=payments-squad,OU=Groups,DC=bank,DC=local","roles":["qa","developer"]}]
```

Sürücü compact form'da **bare DN'i reddeder** (`LdapConfigError`) — sessizce
anlamsız anahtarlara bölüp hiçbir şey eşlememektense hata verir.

**Eşleme kuralları:**

- Hem **bare ad** hem **tam DN** ile eşleşir, iki yönde de:
  `maestro-admins` yazan bir konfig, dizinden
  `CN=maestro-admins,OU=Groups,DC=bank,DC=local` dönse de tutar.
- **Büyük/küçük harf duyarsız** (AD öyle).
- **İç içe gruplar** takip edilir (`1.2.840.113556.1.4.1941`):
  `payments-squad` → `maestro-developers` içindeyse kişi ikincisini de tutar.
- Rol adları **kapalı küme**ye karşı boot'ta doğrulanır: `tech-leads` gibi bir
  yazım hatası **açılışta reddedilir**, sessizce yetkisiz bırakmaz.

**Orkestratör kararına uyum (kritik):** bilinmeyen grup adı **süzülmez**.
`groups` dizinden geldiği gibi taşınır — `internal-audit`, `release-manager`,
takıma özel etiket, hepsi oturumda görünür ve denetlenebilir kalır. Yetki
vermezler çünkü `Role` kapalı bir birlik ve birlik dışı ad hiçbir kapıya
uymaz. `test/identity.test.ts` bunu doğruluyor: alice `internal-audit`
grubunu taşır, rolleri yalnız `["admin","viewer"]`.

Herkes taban olarak `viewer` alır (`defaultRoles`) — eşlemesi tutmayan hesap
**salt-okunur** bir platform görür, bozuk değil.

> **`projectGroupFor` DEĞİŞTİRİLMEDİ.** O *proje görünürlüğü* sorusunu
> yanıtlıyor (rol yetkisi değil) ve yerel sürücünün yolunda da duruyor.
> Değiştirmek kendi testlerini gerektiren ayrı bir iş — bkz. §9.

---

## 3. `EnvSchema` eklemeleri (`packages/config/src/env.ts`)

| Değişken | Varsayılan | Not |
|---|---|---|
| `IDENTITY_DRIVER` | `local` | `local` \| `ldaps-bind`. Varsayılan korundu → mevcut kurulumlar etkilenmez |
| `LDAP_URL` | — | `ldaps://ad.bank.local:636` |
| `LDAP_USER_BASE_DN` | — | Zorunlu (sürücü seçiliyse) |
| `LDAP_GROUP_BASE_DN` | user base | |
| `LDAP_BIND_DN` | — | Zorunlu (sürücü seçiliyse) |
| `LDAP_CA_CERT_PATH` | — | Kurumun kendi CA'sı, PEM |
| `LDAP_USER_FILTER` | AD varsayılanı | `{{username}}` taşır |
| `LDAP_GROUP_FILTER` | AD varsayılanı (nested) | `{{dn}}` taşır |
| `LDAP_ROLE_MAPPINGS` | boş | §2 |
| `LDAP_ALLOW_INSECURE` | `false` | Üretimde koşulsuz reddedilir |

**Fail-closed doğrulama:** `IDENTITY_DRIVER=ldaps-bind` seçilir seçilmez
`LDAP_URL`, `LDAP_USER_BASE_DN`, `LDAP_BIND_DN` **zorunlu** olur — üretimde
değil, **her ortamda**, çünkü yarım yapılandırılmış bir dizin boot'ta
patlamalı, ilk giriş denemesinde değil. Üretimde ayrıca `ldap://` ve
`LDAP_ALLOW_INSECURE=true` reddedilir.

**`LDAP_BIND_PASSWORD` diye bir değişken YOK** — bilerek. Ortamdaki parola her
`docker inspect`'te ve her crash dump'ta duran paroladır.

### `LDAP_BIND_PASSWORD_REF` nerede — ve neden orada (kapının yakaladığı hata)

Sırrın **referansı** `apps/deploy/src/env.ts`'teki `DeployEnvSchema`'ya
eklendi, `@maestro/config`'e **değil**. İlk denememde `EnvSchema`'ya koymuştum;
`apps/deploy/test/secret-names.test.ts` bunu **kırmızıya çevirdi** ve haklıydı:

O test, `MAESTRO_SECRET_*` ortam değişkeni adlarını `DeployEnvSchema`'daki
`*_REF` varsayılanlarından **türetir** ve hem `.env.example`'a hem
`compose.yaml`'a karşı doğrular. Başka bir şemada duran bir referans o
kontrolün **göremediği** referanstır — ve semptomu tam da testin var olma
sebebi olurdu: sürücü "secret not found" der, operatör değişkeni set görür,
adın bir alt çizgi farkla arandığını anlamanın yolu yoktur.

Bu yüzden:
- `LDAP_BIND_PASSWORD_REF` → `DeployEnvSchema` (diğer tüm `*_REF`'lerle birlikte)
- `REFERENCE_VARS` listesine eklendi → ad artık türetilip doğrulanıyor
- `compose.yaml`'a hem `LDAP_BIND_PASSWORD_REF` hem
  `MAESTRO_SECRET_KV_LDAP__SERVICE__2D_PASSWORD` geçirildi
- `@maestro/config`'te yerine **neden orada olmadığını anlatan bir yorum** ve
  bunu sabitleyen bir test bırakıldı

`deploy/compose.yaml`'a ayrıca `IDENTITY_DRIVER` ve tüm `LDAP_*` yapılandırma
değişkenleri geçirildi (hiçbiri kimlik bilgisi taşımıyor).

`deploy/.env.example`'a tamamı **yorumlu** eklendi, gerçek kimlik bilgisi
yazılmadı.

---

## 4. Bağımlılık gerekçesi: `ldapts`

Bu repoda norm **sıfır yeni runtime bağımlılığı** (`adapter-jira` çıplak
`fetch` kullanıyor). Burada normdan **saptım**, gerekçesi:

LDAP, HTTP değildir. Bind isteği **ASN.1 BER** kodlamasıdır. Kimlik doğrulama
yolunda elle yazılmış bir BER kodlayıcı, tam da bu projede 22 denetimde 22
kusur bulduran ince hata sınıfının yüzeyidir. İncelenmiş bir protokol
kodlayıcısını ödünç almak **daha küçük** risk.

- `ldapts@9.0.0` — MIT, TypeScript-native, aktif bakımda
- Tek geçişli bağımlılık: `strict-event-emitter-types@2.0.0` (kendi bağımlılığı yok)
- `ldapjs` **elendi**: 2024'ten beri bakımsız

**Kapsama alındı:** `ldapts` yalnız `src/ldapts-client.ts`'te import edilir,
`LdapConnection` seam'inin **arkasında**. Tüm güvenlik mantığı (kaçışlama, boş
parola reddi, pasif hesap, fail-closed, rol eşleme) bu seam'in **üstünde** ve
sahte dizine karşı çevrimdışı test ediliyor. `ldapts-client.ts` `index.ts`'ten
**bilerek export edilmiyor** — dışarıdan kendi TLS seçenekleriyle istemci
kurulmasını engeller.

---

## 5. Güvenlik testlerinin kanıtları

Sahte dizin (`test/fake-directory.ts` + `test/filter-engine.ts`) filtreyi
**gerçekten ayrıştırır** — `&`, `|`, `!`, eşitlik, varlık, substring `*`, ve
AD'nin iki extensible-match kuralı (bit-AND, in-chain). Bu olmasaydı injection
testi **boş** olurdu: sabit yanıt döndüren bir mock, kaçışlama çalışsa da
çalışmasa da geçerdi.

| Senaryo | Test | Sonuç |
|---|---|---|
| **Başarılı giriş** | `identity.test.ts` | alice → `admin`+`viewer`, kullanıcının DN'ine kendi parolasıyla bind edildiği doğrulandı |
| **Yanlış parola** | `identity.test.ts` | `null` |
| **Olmayan kullanıcı** | `identity.test.ts` | `null` — **ayırt edilemez** |
| **Zamanlama eşitliği** | `identity.test.ts` | Her iki yolda da **tam 2 bind** (`toHaveLength(2)`) — bilinmeyen hesap yolunda da yakma bind'i harcanıyor |
| **Pasif hesap** | `identity.test.ts` | dan (uAC=514) doğru parolayla bile `null`; **dan'ın DN'ine hiç bind edilmiyor** |
| **Pasif hesap (filtre düzenlense bile)** | `identity.test.ts` | `userAccountControl` cümlesi filtreden çıkarılsa da reddediliyor — ikinci bağımsız kontrol |
| **Boş parola** | `identity.test.ts` | `null`, **dizine hiç bağlanılmıyor** (`connectCount === 0`) |
| **Boşluk parola** | `identity.test.ts` | `"   "`, `"\t"`, `"\n"`, `" \t\n "` → hepsi `null` |
| **Anonim bind tuzağı kanıtı** | `identity.test.ts` | Sahte dizinin boş parolaya **`true`** döndürdüğü ayrıca test ediliyor (RFC 4513 §5.1.2) — testler yalnız sürücü baştan reddettiği için geçiyor |
| **Injection** | `injection.test.ts` | 8 payload × "kimseyi doğrulamıyor" + kaçışlama birim testleri |
| **Injection kanıtı boş değil** | `injection.test.ts` | Kaçışlanmamış filtre elle kurulduğunda **>1 hesap** eşleşiyor; kaçışlanmış hâlde **sıfır** |
| **TLS'siz reddi** | `transport.test.ts` | `ldap://` varsayılanda red; üretimde `allowInsecure=true` olsa **bile** red |
| **StartTLS / diğer şemalar** | `transport.test.ts` | `https://`, `ldap+tls://`, `file://` → red |
| **Sertifika doğrulama kapatma** | `roles.test.ts` | Şemada böyle bir anahtar **yok**; `rejectUnauthorized`/`tlsInsecure` verilse **strip** ediliyor |
| **Fail-closed (dizin kapalı)** | `identity.test.ts` | `LdapUnavailableError` **fırlatılıyor** — `null` dönmüyor, yerel hesaba düşülmüyor |
| **Servis hesabı sırrı** | `secret-hygiene.test.ts` | 6 test, aşağıda |
| **Belirsiz filtre** | `identity.test.ts` | >1 eşleşme → `null` ("ilkini seç" yok) |

### Sırrı elle taradım — ve GERÇEK BİR SIZINTI buldum

Görev "kendin dene, çıktıyı tara" diyordu. Ayrı bir sonda yazdım: sürücüyü
ayırt edici bir parolayla hatalı yapılandırıp `String`, `message`, `stack`,
`JSON.stringify`, `util.inspect(depth:10)` ve canlı sürücü nesnesinin kendisi
dahil **her yüzeyi** tarayan bir script.

**Bulgu:** `LdapUnavailableError` ilk hâlinde alttaki hatayı standart `cause`
alanına **iliştiriyordu**. Bind yolundaki hatalar kendisine parola verilmiş bir
transport'tan gelir ve hiçbir şey böyle bir kütüphanenin krediyi kendi hata
nesnesine koymasını engellemez (`attemptedPassword`, `options`, istek
anlık görüntüsü). `util.inspect` ve yapılandırılmış logger'lar `cause`'u
**varsayılan olarak gezer** → servis parolası doğrudan log toplayıcısına.

Sonda çıktısı, düzeltmeden önce:
```
secret present: true | user pw present: false
```

**Düzeltme:** `cause` artık **iliştirilmiyor**, **özetleniyor** — yalnız tip,
`code` ve mesaj (`summarise()`). Sonda çıktısı düzeltmeden sonra:
```
secret present: false | user pw present: false
```

Sonda `test/secret-hygiene.test.ts` olarak **kalıcı regresyon testine**
dönüştürüldü (6 test): sızdıran transport, `cause` özetleme, servis hesabı
hatası (referans **var**, değer **yok**), canlı sürücü nesnesi, directory
reader, ve başarı yolunda kullanıcı parolası.

---

## 6. Mutasyon kanıtları

Her mutasyon uygulandı, test koşuldu, **geri alındı**. Nihai ağaçta
`MUTATION` işareti yok.

| # | Mutasyon | Sonuç |
|---|---|---|
| 1 | `renderUserFilter`'dan `escapeFilterValue` kaldırıldı | **6 test kırmızı**. Kritik: `payload "alice)(|(sAMAccountName=*" authenticates nobody` **düştü** — yani kaçışlama olmadan payload **gerçekten birini doğruladı** (kimlik doğrulama atlatma) |
| 2 | Boş parola kontrolü kaldırıldı | **5 test kırmızı** — sahte dizin RFC 4513 gereği boş bind'e `true` döndüğü için anonim bind ile giriş açıldı |
| 3 | TLS zorunluluğu kaldırıldı (`production` ve `allowInsecure` kontrolleri) | **2 test kırmızı** |
| 4 | Pasif hesap kontrolü kaldırıldı | **1 test kırmızı** — filtre düzenlendiğinde ikinci savunmanın taşıdığı yük kanıtlandı |
| 5 | `cause` yeniden bütün olarak iliştirildi (§5'teki asıl kusur) | **3 test kırmızı** |

---

## 7. Composition root'a eklenmesi gereken satırlar

`apps/deploy/src/boot.ts` — **ben eklemedim** (composition root'un kendisi
`docs/mimari.md:99`'a göre hâlâ yazılmamış durumda ve paralel ajanların işiyle
çakışırdı).

`apps/deploy/src/driver-config.ts` içine:

```ts
export function ldapConfig(env: DeployEnv, secrets: unknown): Record<string, unknown> {
  return {
    url: required(env.base.LDAP_URL, "LDAP_URL", "the LDAPS identity driver has no default directory"),
    userBaseDn: required(env.base.LDAP_USER_BASE_DN, "LDAP_USER_BASE_DN", "user search has no default base"),
    groupBaseDn: env.base.LDAP_GROUP_BASE_DN,
    bindDn: required(env.base.LDAP_BIND_DN, "LDAP_BIND_DN", "the search bind needs a service account"),
    bindPasswordRef: env.base.LDAP_BIND_PASSWORD_REF,
    caCertPath: env.base.LDAP_CA_CERT_PATH,
    allowInsecure: env.base.LDAP_ALLOW_INSECURE,
    ...(env.base.LDAP_USER_FILTER !== undefined ? { userFilter: env.base.LDAP_USER_FILTER } : {}),
    ...(env.base.LDAP_GROUP_FILTER !== undefined ? { groupFilter: env.base.LDAP_GROUP_FILTER } : {}),
    roleMappings: parseRoleMappings(env.base.LDAP_ROLE_MAPPINGS),
  };
}
```

`apps/deploy/src/boot.ts` içine:

```ts
import { createLdapIdentityProvider, createLdapDirectoryReader } from "@maestro/adapter-ldap";

// … bootPlatform içinde, secrets kurulduktan sonra:
const identity =
  env.base.IDENTITY_DRIVER === "ldaps-bind"
    ? createLdapIdentityProvider(ldapConfig(env, secrets), { secrets, nodeEnv: env.base.NODE_ENV })
    : new LocalIdentityProvider(users, new BcryptPasswordHasher());
```

`apps/bff` bunu `IdentityProvider` olarak alır — yapısal uyum, ekstra adaptör
gerekmez.

### `DirectoryReader` — hangisi seçilecek (paralel ajan notu)

**Onun dosyalarına dokunmadım.** İki implementasyon aynı seam'i karşılıyor:

- **DB destekli** (paralel ajan) — Postgres'teki bildirim yönlendirme tablosu
- **LDAPS destekli** (bu paket, `createLdapDirectoryReader`) — canlı AD grubu

**Önerim: LDAPS'ı birincil, DB'yi yedek/override yapın.** Gerekçe: AD grubu
üyeliği **gerçeğin kaynağı**dır ve ayrılan bir çalışan AD'den çıkarıldığında
bildirim listesi kendiliğinden düzelir; DB kopyası bayatlar ve "ayrılan kişi
hâlâ onay bildirimi alıyor" denetim bulgusuna yol açar. DB tablosu ise
AD'de karşılığı olmayan takma listeler için üstte kalmalı.

Composition root'ta karar **tek satır**; iki reader'ı birleştiren küçük bir
composite yazmak gerekirse o da composition root'un işi — **bu paket öyle bir
şey dayatmıyor**.

---

## 8. Kullanıcıdan (banka mimarından) İSTENMESİ GEREKEN BİLGİLER

Pilot öncesi bunlar olmadan kurulum yapılamaz:

1. **LDAPS adresi ve portu** — `ldaps://…:636`. (Yalnız `ldaps://`; StartTLS
   desteklenmiyor, gerekçesi `src/transport.ts`.)
2. **Base DN'ler** — kullanıcı aramasının ve grup aramasının başlayacağı yerler
   (`OU=Users,DC=…` / `OU=Groups,DC=…`).
3. **Servis hesabı**: DN'i, ve parolasının **Vault yolu** (`kv/ldap#…`).
   Parolanın kendisi bana/koda değil, **Vault'a** girilmeli. Hesabın yalnız
   kullanıcı ve grup alt ağaçlarında **okuma** yetkisi olmalı.
4. **CA sertifikası** (PEM) — kurumun kök/ara CA'sı ve konteynerdeki yolu.
5. **Grup adları ve rol karşılıkları** — hangi AD grubu hangi Maestro rolüne
   (`admin`, `tech-lead`, `product-owner`, `qa`, `developer`, `viewer`)
   karşılık geliyor. Adları **tam DN** olarak vermeleri en güvenlisi.
6. **Şema doğrulaması**: login adı hangi öznitelikte —
   `sAMAccountName` mi, `userPrincipalName` mi? Grup üyeliği `member` mi
   `memberOf` mu? Varsayılanlar AD'ye göre, farklıysa `LDAP_USER_FILTER` /
   `LDAP_GROUP_FILTER` ile ayarlanır.
7. **İç içe grup kullanıyorlar mı** — varsayılan filtreler nested'ı takip
   ediyor; dizin çok büyükse bu sorgu maliyetli olabilir, DBA/AD ekibiyle
   teyit edilmeli.
8. **Pasifleştirme yöntemi**: `userAccountControl` bit'i mi, `accountExpires`
   mi, `nsAccountLock` mı? Üçünü de kontrol ediyorum ama hangisinin kullanıldığı
   teyit edilmeli — **ve bir pasifleştirilmiş test hesabıyla uçtan uca
   denenmeli**.
9. **Test hesapları**: pilot için en az bir normal, bir yetkili ve bir
   **pasifleştirilmiş** hesap.

---

## 9. ARAYÜZ İSTEKLERİ (donmuş sözleşmeler — değiştirmedim)

1. **`IdentityProvider` bir PORT değil.** `apps/bff/src/deps.ts`'te yaşıyor,
   `@maestro/ports`'ta değil. Bu yüzden `PortRegistry.register(...)` ile
   kaydedilemiyor ve `register.ts` düz fabrika fonksiyonları sunuyor —
   diğer sürücülerden farklı bir desen. **Talep:** `IdentityProvider` (ve
   `AuthenticatedUser`) `@maestro/ports`'a taşınsın, böylece kimlik de
   diğer portlarla aynı DI yolunu kullansın.

2. **`DriverFactory<P> = (config: unknown) => P` bağımlılık kanalı taşımıyor.**
   `adapter-jira`'nın RAPOR'unda da geçen aynı istek. Bu sürücünün
   `SecretPort`'a ve `nodeEnv`'e ihtiyacı var; şimdilik `createLdap*(config,
   deps)` imzasıyla çözdüm. **Talep:**
   `DriverFactory<P> = (config: unknown, deps: DriverDeps) => P`.

3. **`AuthenticatedUser.roles` `readonly string[]`** — sözleşmedeki karar
   doğru ve ona uydum; yalnız not: hiçbir yerde "bu ad birliğin dışında"
   diye bir **işaret** taşınmıyor. Studio'nun bilmediği rol adını ham
   göstermesi gerekiyor (sözleşme öyle diyor) ama denetim raporu "hangi
   adlar tanınmadı" sorusunu sormak isterse bugün yanıtlanamaz. **Talep
   (düşük öncelik):** oturuma türetilmiş `unmappedRoles: readonly string[]`
   eklensin — süzme değil, yalnız görünürlük.

---

## 10. YAPMADIKLARIM

- **`projectGroupFor` değiştirilmedi.** §2'de gerekçesi: proje görünürlüğü
  ayrı bir soru, yerel sürücünün yolunda da duruyor, kendi testlerini
  gerektiren ayrı bir değişiklik. Yapılandırılabilir hâle getirilmesi
  **hâlâ açık bir denetim maddesi** — Dalga 5'in devamına önerilir.
- **Composition root'a bağlamadım** — `apps/deploy/src/boot.ts` değiştirilmedi
  (§7'de eklenecek satırlar hazır). Paralel ajanlarla çakışma riski ve
  composition root'un kendisinin henüz yazılmamış olması.
- **`DirectoryReader`'ın DB versiyonuna dokunulmadı** — paralel ajanın işi.
- **Gerçek bir LDAP sunucusuna karşı çalıştırmadım.** Ağ çağrısı yasağı
  gereği tüm doğrulama sahte dizine karşı. `ldapts-client.ts`'in kendisi
  (BER kodlaması, TLS el sıkışması, gerçek `ldapts` hata şekilleri)
  **kurumun test AD'sinde doğrulanmalı** — pilotun ilk adımı bu olmalı.
- **Kullanıcıya görünen yeni metin eklemedim** → katalog 1337/1337 tr+en
  paritesi **bozulmadı**. Sürücü hataları operatör içindir, son kullanıcı
  `error.unauthenticated` görür.
- **Hesap kilitleme / deneme sayacı yok.** LDAP bind'i başarısız denemeleri
  **dizinin kendi politikası** sayar; burada ikinci bir sayaç tutmak AD'nin
  kilitleme eşiğiyle çelişirdi. Not: bu, sürücünün bir hesabı kilitlemek için
  kullanılabileceği anlamına gelir (dizin politikası neyse o uygulanır).
