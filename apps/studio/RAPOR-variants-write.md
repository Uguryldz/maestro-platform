# RAPOR — Variant WRITE side + pilot DB-first model (M38 / M83)

Uğur'un sert kuralı: **"AI ajan varyantları Maestro İÇİNDE oluşturulsun, TÜM
ayarlar UI'dan gelsin, env yalnızca bootstrap."** Bu dalga o kuralın son üç
eksiğini kapatır.

## Ana bulgu: ne zaten `main`'deydi, ne eksikti

`main` üzerinde önceki B-dalgası ŞUNLARI çoktan getirmişti:

- **BFF write endpoint'leri** — `apps/bff/src/routes/studio-variants.ts`:
  `POST /variants`, `PUT /variants/:id`, `POST /variants/:id/versions`, hepsi
  admin-gated, Zod-doğrulamalı, `503-by-name` (writer bağlı değilse). Servis
  katmanı `apps/bff/src/variant-service.ts` — persona control-char reddi, sunucu
  türevli author/version/timestamp.
- **Studio CRUD** — `Variants.tsx` (➕ Variant ekle modalı: rol, ad, model,
  persona) ve `Variant.tsx` (platform düzenle + "yeni sürüm yayınla" modalı).
- **In-memory writer** — `apps/bff/src/stores/variant-memory.ts`
  (`InMemoryVariantCatalog implements VariantCatalog, VariantWriter`), demo'da
  bağlı.

EKSİK olan (bu dalganın işi):

1. **Postgres writer yoktu.** Gerçek deploy (`apps/deploy/src/bin/bff.ts`) ve
   `real-users.ts` launcher YALNIZCA read-only `PrismaVariantCatalog` bağlıyordu;
   `variantWriter` hiçbir yerde yoktu → gerçek DB'de her write 503 dönüyordu.
2. **Pilot modeli env'den okuyordu.** `wiring.ts` `analyst`/`engineer`
   bindinglerini env `PILOT_MODEL`'e bağlıyordu.
3. **Default varyant seed'i yoktu.** Temiz kurulumda hiç varyant satırı yok →
   `/variants` boş, pilotun modelini çözeceği DB kaydı yok.

## Yapılanlar

### 1) Variant WRITER (Postgres) — `apps/deploy/src/stores/write-variants.ts`

`PrismaVariantWriter implements VariantWriter`. In-memory store ile AYNI
semantiği tutar (doğrulayıcı forge kontrolü yapsın diye):

- `create` → sürüm 1'i yazar; var olan `variantId`'yi reddeder (history'yi
  öksüz bırakmaz → servis 409 `variant_exists`).
- `publishVersion` → `latest + 1` INSERT eder, asla UPDATE etmez (M83).
  Composite PK `(variantId, version)` yarışı DB'ye bırakır.
- `edit` → yalnızca platform (`Variant.name`) overlay'ini değiştirir; model ve
  persona sürümlüdür, sadece `publishVersion` taşır.
- **Sunucu türevli author/timestamp.** `publishedBy` = çağıranın audit actor'ü,
  `publishedAt` = servis saati — body'den ASLA alınmaz.

**Şema donuk kaldı (kontrat kuralı).** `VariantVersion` tablosunda `persona`,
`note`, author kolonu YOK. Bu üç alan + `knowledgeRefs` `configJson` içine, read
tarafının da parse ettiği anahtarlarla yazılır (`persona`, `knowledgeRefs`,
`note`, `publishedBy`). `read-variants.ts` güncellendi: bu alanları configJson'da
varsa yüzeye çıkarır, yoksa eski `unrecorded` / `persona bu DB'de saklanmıyor`
işaretine düşer — writer-öncesi satırlar aynen render olur.

**Bağlandığı yerler:** `apps/deploy/src/bin/bff.ts` ve
`apps/demo-stack/src/bin/real-users.ts` — `studio.variantWriter =
new PrismaVariantWriter(db.variant, db.variantVersion)`.

### 2) BFF write endpoint'leri

Zaten `main`'deydi; DEĞİŞTİRİLMEDİ. Artık gerçek deploy'da writer bağlı
olduğundan 503 yerine gerçekten yazıyorlar. Writer bağlı değilse hâlâ
`503 variants` (isimle).

### 3) Studio CRUD

Ekranlar zaten `main`'deydi. Sadece **test** eklendi (aşağıda). Model, admin'in
UI'dan yazdığı dropdown/metin — "modelin UI'dan seçilmesi" budur.

### 4) Pilot modeli DB'den okuyor — env'den DEĞİL

- Yeni port + saf yardımcı: `apps/pilot/src/variant.ts`
  (`VariantModelReader` arayüzü + `resolveVariantModel(variantId, reader,
  {fallbackModel, warn})`). Pilotun `@maestro/db` bağımlılığı YOK (kontrat: yeni
  runtime dep yok), o yüzden Postgres'e kendisi bağlanmaz — bir **reader enjekte
  edilir**.
- `boot.ts`: gateway kurulmadan ÖNCE `analyst` (`PILOT_ANALYST_VARIANT`,
  default `analyst-default`) ve `engineer` (`PILOT_ENGINEER_VARIANT`, default
  `engineer-default`) varyantlarının **aktif sürüm modeli** çözülür ve
  `createPilotGateway`'e `models: {intake, analyst, engineer}` olarak verilir.
  `wiring.ts` bindingleri artık bu çözülen modelleri kullanır — env `PILOT_MODEL`
  DEĞİL.
- SettingsStore ve durum ekranındaki `model` de çözülen analyst modelinden
  seed'lenir; böylece panelde görünen model ile gateway'in gerçekten çağırdığı
  model aynıdır.
- **Fallback (dev):** reader bağlı değilse ya da varyantın yayınlı modeli yoksa,
  env `PILOT_MODEL`'e düşer ve **uyarı loglar** (sessiz değil). Reader THROW
  ederse (DB erişilemez) hata propagate olur — yanlış yapılandırmayı env
  default'una sessizce gömmez.

### 5) Default varyant seed'i

- `packages/db/src/variant-defaults.ts` — `analyst-default` + `engineer-default`
  (rol, `default` platform, kısa Türkçe persona), `DEFAULT_VARIANT_MODEL =
  "anthropic/claude-sonnet-4.5"`.
- `packages/db/src/seed-variants.ts` — `seedDefaultVariants(db, {model,
  publishedBy, now})`. `seed-template`/`seed-first-admin` gibi **idempotent ve
  clobber-etmez**: id'si zaten varsa (admin yeniden sürümlemiş olsa bile)
  dokunmaz; yarışı PK'ye bırakır. Sürüm 1'in modeli **bootstrap** modeldir.
- `apps/deploy/src/bin/migrate.ts` — advisory lock içinde, admin/template
  seed'lerinin yanında çağrılır; model `process.env.PILOT_MODEL` (bootstrap) ||
  `DEFAULT_VARIANT_MODEL`.

## Yalnızca env-bootstrap kalan ne var

- `PILOT_MODEL` — SADECE (a) seed'in sürüm 1 modeli, (b) reader yoksa pilot
  fallback'i. Akış anında ASLA okunmaz.
- `PILOT_ANALYST_VARIANT` / `PILOT_ENGINEER_VARIANT` — pilotun hangi varyant
  id'sini çözeceği (default seed'lenen ikili). Model DEĞİL — id.
- Pilotun kendisi standalone; gerçek DB-backed reader'ı DB'ye sahip composition
  root'ta (deploy/launcher) kurulur. `main.ts` şu an reader'sız boot eder → dev
  fallback (loglu). DB-first yol test'lerde enjekte edilen reader ile ve boot
  seam'i ile tam kanıtlanır.

## Güvenlik

- Append-only + sunucu türevli alanlar (forge edilmiş author/version/timestamp
  imkânsız — body'den alınmaz, DB'ye writer yazar).
- Admin-gate BFF'te (viewer reddedilir — testle).
- Persona control-char reddi zaten servis katmanında (CRLF fix ile aynı).
- Model/persona sır değildir; hiçbir yere sır sızmaz.

## Testler (hepsi OFFLINE)

- `apps/deploy/test/write-variants.test.ts` (8) — create sürüm-1 + sunucu
  türevli author; var-olanı reddet; publishVersion append-only (eski sürüm
  değişmiyor, latest+1, her sürümün kendi author'u); unknown → null; edit yalnız
  platform.
- `packages/db/test/seed-variants.test.ts` (6) — rol başına bir varyant;
  bootstrap model sürüm-1'e; default model; idempotent + non-clobbering;
  tam-seed'liye tekrar = no-op; configJson'da server-derived author.
- `apps/pilot/test/variant.test.ts` (5) — reader varsa DB modeli (X); reader yok
  → env (Y) + uyarı; yayınlı model yok → fallback + uyarı; throw propagate;
  **gateway binding testi: env `PILOT_MODEL=env-model-Y` iken analyst çağrısı
  `variant-model-X` gönderir.**
- `apps/studio/test/screens-agents.test.tsx` (+2) — variant detay "yeni sürüm
  yayınla" modalı: viewer'a buton yok; farklı MODEL ile sürüm yayınlar,
  yalnızca sürümlü alanları POST eder, `version`/`publishedBy`/`publishedAt`
  ASLA göndermez. `harness.tsx`'e `initialEntries` eklendi (`?id=` okuyan ekran
  için).

Kapı (hepsi yeşil): `@maestro/bff` typecheck + test (594), `@maestro/studio`
typecheck + test (250), `@maestro/deploy` typecheck + test (463), `@maestro/pilot`
typecheck + test (77), `@maestro/db` test (203). Repo `pnpm lint` = 0 problem.
