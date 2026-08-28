# RAPOR-A1 — Users & Settings, canlı yazma yüzeyi

Studio'nun **Kullanıcılar** ve **Ayarlar** ekranları artık gerçekten çalışıyor:
salt-okunur "arama" penceresi yerine yönetilebilir bir yüzey. Kullanıcılar
UI'dan eklenip düzenlenip pasifleştirilebiliyor; Ayarlar canlı `/settings`
uçlarına bağlı ve iki kademeli kill-switch'i taşıyor.

## Eklenen BFF uçları (hepsi admin-rol korumalı)

`apps/bff/src/routes/studio-catalog.ts` (mevcut `GET /studio/users/:username`
okuma ucunun yanına):

- **`GET /studio/users`** — tüm pencere, pasif (off-boarded) satırlar dahil.
  Denetim için pasif hesaplar gizlenmez. Asla `passwordHash` dönmez.
- **`POST /studio/users`** — yeni yerel hesap. Parola `LocalIdentityProvider.
  provision()` üzerinden geçer, yani bcrypt + politika uygulanır; zayıf parola
  `password_policy` koduyla + kırılan kuralların listesiyle döner. **Roller
  gruplardan türetilir** (`rolesOf`), çağırandan alınmaz. `201` döner.
- **`PUT /studio/users/:username`** — görünen ad / gruplar (→ roller) / aktiflik
  düzenleme. Roller her zaman gruplardan yeniden türetilir; parola burada asla
  değişmez.
- **`DELETE /studio/users/:username`** — **pasifleştirme** (silme değil).

Zod ile doğrulama; `AssignableGroup` sadece `ROLE_BY_GROUP`'un tanıdığı grupları
kabul eder. Provisioning yeteneği yoksa (AD/LDAP sürücüsü) uç 503
(`capability_not_wired`) döner — sahte bir kimlik yazmaz.

### Arayüz / altyapı değişiklikleri

- `UserDirectory`'ye **`list(limit)`** eklendi (deps.ts). `InMemoryUserDirectory`
  ve `PrismaUserDirectory` (deploy) uyguladı; Prisma tarafı sıralı + `take` ile
  sınırlı `findMany` kullanır, pasif satırları korur.
- `InMemoryUserDirectory.remove()` artık **pasifleştiriyor** (hard-delete yerine),
  böylece referans uygulama üretimdeki `PrismaUserDirectory` ile aynı sözleşmeyi
  taşıyor: denetim izi kapanmış geçitteki adı çözebilsin.
- `apps/bff/src/auth/groups.ts` — BFF'in grup→rol okuması (`ROLE_BY_GROUP`,
  `rolesOf`, `ASSIGNABLE_GROUPS`). deploy'daki eşlemenin aynası; `groups.test.ts`
  her değeri donmuş `Role` union'ına karşı sabitler. Prisma paketini import
  etmemek için çoğaltıldı.
- `AccountProvisioner` + `accountProvisionerOf` yapısal yetenek dedektörü
  (deps.ts), `commandDiagnosticsOf` ile aynı desen.
- `ApiClient.delete<T>()` eklendi (studio/src/api/client.ts).

## Studio — artık ne yapabiliyor

**Kullanıcılar (`Users.tsx`)**: gerçek tablo (kullanıcı adı, gruplar, roller,
durum, işlemler). "➕ Kullanıcı ekle" modalı — ad, kullanıcı adı, parola ve
**grup onay kutuları** (her kutunun yanında vereceği rol rozeti + canlı "verilecek
roller" önizlemesi). Düzenleme aynı modalı yeniden kullanır (parola/kullanıcı adı
gizli). Pasifleştirme gerekçe isteyen `ConfirmModal` üzerinden. Zayıf parola
BFF'ten gelen kırılan kuralları alan-altında Türkçe gösterir. Başarı/hata
toast'ları mevcut stilde. Pasif hesabın rolleri üstü çizili + gri (renk ve metin
"hâlâ yetkili mi?" sorusunda çelişmesin diye).

**Ayarlar (`Settings.tsx`)**: `MaybeUnwired` sarmalayıcı kaldırıldı (uç artık
canlı); `QueryState` ile bağlandı. Bağlantılar + notify sürücüleri okunur
gösterilir (bunlar dağıtım gerçeği; `credentialRef` asla sır taşımaz). İki
kademeli **kill-switch** paneli (`intake_only` / `all`) zaten gerekçe-zorunlu
`ConfirmModal` ile — korundu ve doğrulandı (M58).

## Silme yerine pasifleştirme kararı

**Pasifleştirme seçildi.** Bir off-boarding hesabını silmek denetim izini boşa
düşürürdü: ayrılan bir onaylayanın adı kapanmış geçitlerin üzerinde ve o adı
`UserDirectory.find` çözer. Silinen satır izi kimseye işaret etmeyen bir kayda
dönüştürür (M33). `DELETE` bu yüzden `active=false` yazar; guard pasif hesabı
eksik hesapla aynı görür (bir sonraki istekte tüm oturumlar ölür), yani gerçek
bir iptal — kozmetik bayrak değil. Referans `InMemoryUserDirectory.remove()` de
üretimdeki Prisma davranışıyla eşleşecek şekilde pasifleştirmeye çevrildi.

## Test sayıları (hepsi yeşil)

- BFF: **524** test (studio-catalog'a 12 yeni user-yazma testi + yeni
  `groups.test.ts` 6 test dahil). `typecheck` temiz.
- Deploy: **408** test (+2 yeni `list()` testi; `findMany` fake'i eklendi).
- Studio: **218** test. `screens-users.test.tsx` yeni tablo/modal akışına
  yeniden yazıldı; `hardening.test.tsx`'teki 3 user + 2 settings testi yeni
  canlı davranışa güncellendi. `typecheck` temiz.
- Config: **23** test (yeni locale anahtarları tr+en).
- Repo `pnpm lint`: temiz.

## Kapsam notu

git / ADO / pilot'a dokunulmadı. Değişiklikler yalnızca Users + Settings + onların
BFF yazma uçları ve dokundukları paylaşılan altyapı (UserDirectory arayüzü,
grup→rol okuması, ApiClient.delete, locale anahtarları).
