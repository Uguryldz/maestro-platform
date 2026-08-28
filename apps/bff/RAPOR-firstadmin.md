# RAPOR — First-run bootstrap admin (banking standard)

## Amaç

Taze bir kurulumun giriş yapabileceği bir `admin` / `admin123` hesabı — ama ilk
girişte parola değişikliği ZORUNLU. Kullanıcı kalıcı-zayıf parola yerine bunu
seçti (bankacılık standardı).

## Gerilim ve çözüm

Platformun kendi parola politikası (`apps/bff/src/auth/password.ts` — min 12,
büyük/küçük/rakam/simge, M8) `admin123`'ü REDDEDER. Çözüm:

- Bootstrap parolası SADECE seed yolunda politika-MUAF. `seedFirstAdmin` bcrypt
  hash'i doğrudan yazar, `provision`'ı (ve dolayısıyla `assertPassword`'ü)
  atlar.
- `provision()` normal hesaplar için değişmedi — hâlâ tam politikayı uygular.
- Change-password endpoint'i YENİ parolada tam politikayı çalıştırır, yani
  `admin123`'e geri dönülemez (çok kısa + simge yok).
- Global politika hiçbir yerde zayıflatılmadı.

## Şema alanı + migration 0009

`packages/db/prisma/schema.prisma` — `User` modeline:

```prisma
mustChangePassword Boolean @default(false)
```

Migration: `packages/db/prisma/migrations/0009_user_must_change_password/migration.sql`
(elle yazıldı; son migration 0008'di):

```sql
ALTER TABLE "User"
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
```

`DEFAULT false` yük taşıyan kısım: normal `provision` yolundan geçen her hesap
ilk girişinden itibaren kısıtsız; sadece seed bunu `true` yapar. **Migration
canlı DB'ye uygulanmadı** — 0009 teslim edildi, orchestrator uygular.

## seedFirstAdmin davranışı

`packages/db/src/seed-first-admin.ts`:

- `admin` kullanıcısı UPSERT değil CREATE eder: `email`=`admin`, `id`=`admin`,
  `displayName`="Yönetici", `groupsJson`=`["maestro-admins"]` (→ `admin` rolü,
  `ROLE_BY_GROUP`'a göre), `passwordHash`=bcrypt(`admin123`),
  `mustChangePassword=true`, `active=true`.
- **Idempotent + clobber-etmez**: önce "admin var mı" diye bakar
  (`groupsJson array_contains ["maestro-admins"]`). Bir admin varsa (bootstrap
  admin parolasını değiştirmiş olsa bile — hâlâ admin grubunda) NO-OP döner.
  İkinci çalıştırma, veya parola değiştirildikten sonraki çalıştırma, parolayı
  `admin123`'e geri sıfırlamaz.
- Hasher ENJEKTE edilir (`@maestro/db` bcrypt bağımlılığı almaz — sadece BFF'in
  identity provider'ı bcrypt bilir). Composition root `BcryptPasswordHasher`
  geçer.

Genuine bootstrap yolundan çağrılır (demo değil): `apps/deploy/src/bin/migrate.ts`,
advisory-lock içinde, `seedAnalysisTemplate` ile aynı desende — HER deployment'ın
koştuğu yol.

## Change-password route + kısıtlı-oturum guard

`apps/bff/src/routes/auth.ts` — `POST /auth/change-password`
(authenticated, `allowRestricted: true`):
`{currentPassword, newPassword}` alır → mevcut parolayı doğrular → yeni parolada
TAM politika (`assertPassword`) → re-key → `mustChangePassword` temizler →
hesabın DİĞER tüm oturumlarını (bu dahil) öldürür.

`apps/bff/src/auth/guard.ts` — `authGuard` artık `mustChangePassword`'ü
dizinden her istekte tazeliyor (roller/gruplar gibi; dizin gerçek, oturum
cache). Kısıtlı bir oturum SADECE opt-in eden rotalara ulaşır
(change-password + logout + session, `allowRestricted: true`); diğer HER rota
`409 password_change_required` ile reddedilir. Fail-closed: opt-in etmeyi
unutan yeni bir rota kısıtlı oturuma kapalıdır.

Login yanıtı ve `GET /auth/session` artık `mustChangePassword` taşıyor, böylece
Studio yönlendirebiliyor.

## Politika-muafiyetinin bootstrap'a sınırlanması

- Muafiyet SADECE `seedFirstAdmin`'de (hash doğrudan yazılır).
- `LocalIdentityProvider.provision` değişmedi: normal hesaplarda
  `assertPassword` çalışır, `mustChangePassword=false` yazar.
- `LocalIdentityProvider.changePassword` yeni parolada `assertPassword`
  çalıştırır — bootstrap admin'i `admin123`'ten kalıcı olarak çıkarır.

## Studio

- `apps/studio/src/screens/ChangePassword.tsx` (yeni) — shell dışı, tek başına
  ekran; politika ihlallerini Türkçe (`users.password.*`) gösterir.
- `RequireSession` `mustChangePassword` oturumunu `/change-password`'e yönlendirir
  ve uygulamanın geri kalanını bloklar.
- `AuthProvider.changePassword` başarıda oturumu temizler → kullanıcı yeni
  parolayla /login'e düşer.
- Katalog anahtarları `login.change.*` + `error.password_change_*` iki dilde de
  eklendi (parity testi yeşil).

## Testler (offline)

- `packages/db/test/seed-first-admin.test.ts` — 4: boş DB'de admin/admin123 +
  mustChangePassword; admin varsa no-op; parola değiştikten sonra sıfırlamaz;
  idempotent.
- `apps/bff/test/first-admin.test.ts` — 9: login mustChangePassword=true; session
  bayrağı; kısıtlı oturum normal rotada 409, change-password/logout/session'da
  geçer; zayıf yeni parola reddi (too_short + no_symbol); yanlış current parola
  reddi; başarılı değişiklik bayrağı temizler + diğer oturumları öldürür; yeni
  parolayla ikinci login kısıtsız; provision edilen hesap asla kısıtlı değil.
- `apps/deploy/test/users.test.ts` — +3: bootstrap bayrağı round-trip; bayraksız
  satır non-bootstrap; upsert bayrağı yazar.
- `apps/studio/test/auth.test.tsx` — +4: kısıtlı oturum ekranı yönlendirir + app
  bloklu; deep link de yönlenir; ihlaller Türkçe; başarıda /login'e düşer.

## Doğrulama

`@maestro/bff` typecheck+test (577), `@maestro/db` (197), `@maestro/studio` (242),
`@maestro/deploy` (435), `@maestro/config` (23) yeşil. Repo `pnpm lint` temiz.
