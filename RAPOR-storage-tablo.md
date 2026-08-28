# RAPOR — `storage_blob` tablosunu üretime getirmek

**Dal:** `worktree-agent-ae0aa3111c37f686c` (temel: `81b19c9`)
**Migration numarası:** `0017_storage_blob` (mevcut en yüksek `0016` idi; canlı DB de `0016`'da,
çakışma yok)

## Karar: **A yolu — Prisma migration**

`packages/db/prisma/migrations/0017_storage_blob/migration.sql`.

**Gerekçe:**

1. **Kodun kendisi bunu söylüyordu.** `pgBlobTableDdl()`'in doc yorumu zaten
   *"applied by the `db` packet's migration"* diyor. Fonksiyon yazılırken migration yolu
   tasarlanmış, sadece migration hiç yazılmamış. B yolu bu niyeti terk etmek olurdu.
2. **Üretim yolu zaten var ve kilitli.** Her servis konteyneri kendi girişinden önce
   `apps/deploy/src/bin/migrate.ts` koşuyor; bu da `prisma migrate deploy`'u bir Postgres
   **advisory lock** arkasında sıraya sokuyor (N replika yarışamaz). Migration yazmak bu
   hazır, test edilmiş yola bağlanmak demek — yeni bir açılış yolu icat etmek değil.
3. **B yolu bir yetki kırılması.** Uygulamanın kendi şemasını açılışta değiştirmesi, bankada
   DDL yetkisi olmayan bir servis hesabıyla koşulacak dağıtımda **çalışmaz**; üstelik
   `_prisma_migrations` defterinde iz bırakmaz — denetçinin "bu tablo ne zaman, hangi sürümle
   geldi?" sorusunun cevabı kaybolur. Migration disiplini WORM kanıtı tutan bir sistemde
   tam da korunması gereken şey.
4. **Tablo Prisma modeline eklenmedi, bilerek.** `schema.prisma`'ya model koymak
   `db.storageBlob.deleteMany()`'i tüm monorepo'ya açardı — yani M56/M57 WORM korumasının
   ORM üzerinden **atlanabilir** hale gelmesi. Tablo bir sürücünün özel deposu; erişim
   yalnızca `StoragePort` üzerinden. Bu yüzden `0002` gibi el yazımı SQL olarak geldi.

## DDL `pgBlobTableDdl` ile nasıl hizalandı

DDL **elle yazılmadı**: `pgBlobTableDdl()` çalıştırılıp çıktısı birebir migration'a kondu.
Hizanın korunması bir teste bağlandı — `packages/storage/test/pg-migration.test.ts`
fonksiyonu **yeniden çalıştırıp** ürettiği her satırın migration'da (yorum değil, çalışan
ifade olarak) bulunduğunu doğruluyor. `pg.ts`'te bir sütun adı değişirse test anında kırılır.

Test `@maestro/db`'yi import etmiyor, dosyayı yoldan okuyor: `db` ile `storage` birbirine
bağımlı değil ve tek bir assert için iki paketi kenetlemek yanlış olurdu.

## Uçtan uca kanıt (kendi Postgres'im)

`docker run --rm -d --name maestro-storage-blob-agent ... -p 55447:5432 postgres:18-alpine`
(iş bitince **kaldırıldı**; `uinfra-postgres` ve diğer projelerin konteynerlerine dokunulmadı).

`apps/deploy/test/live-storage-blob.test.ts` — `TEST_DATABASE_URL` ile opt-in, tıpkı
`live-stores.test.ts` gibi; değişken yoksa kapı offline kalıyor. Boş şemaya **tüm**
migration'lar uygulanıyor, sonra **gerçek sürücü + gerçek Prisma adaptörü** ile:

- `PK\x03\x04` ile başlayan **gerçek bir .docx** yazıldı, **bayt bayt aynı** geri okundu
- `content_type` doğru saklandı, `list()` belgeyi ön ekinden buldu
- **kilit gerçek**: `object_lock=true`, `retain_until` ~10 yıl ileride
- **WORM**: kilitli belgenin üzerine yazma ve silme **reddedildi**, orijinal baytlar yerinde
- **fail-closed korundu**: `objectLock` yapılandırılmamış sürücü kilitli put'u reddetti ve
  **hiçbir satır yazmadı**
- **idempotent**: migration ikinci kez uygulandı, kilitli belge sağ kaldı

**8/8 yeşil.**

## Yol boyunca bulunan ikinci gerçek hata (tablo tek başına yetmiyordu)

Tabloyu yarattıktan sonra `put` **hâlâ patladı**:

```
Code: 42804  column "tags" is of type jsonb but expression is of type text
Code: 42804  column "created_at" is of type timestamp with time zone but expression is of type text
```

Sürücü `tags`'i JSON **string**, üç zamanı ISO **string** olarak bağlıyor. Worker'ın gerçekte
kullandığı adaptör (Prisma `$queryRawUnsafe`) parametreleri `text` olarak bağladığı için
Postgres dönüşümü çıkarsamayı reddediyor. Yani **migration tek başına ek dosyayı getirmezdi** —
bir sonraki halka buydu.

Düzeltme `packages/storage/src/pg.ts`'te, INSERT'e tipleri açıkça yazmak:
`$4::jsonb`, `$6::timestamptz`, `$7::timestamptz`.

**Bu neden testlerden kaçmıştı:** offline sahte (`test/fakes/fake-pg.ts`) `tags`'i düz `string`
olarak saklıyor, yani `jsonb` bağlamasını hiç denemiyor. Offline suite yeşilken üretim
patlıyordu. Artık `pg.test.ts` sürücünün **ürettiği SQL metnini** doğruluyor — veritabanı
gerekmeden kapıda yakalanıyor.

Ayrıca `LockRow.retain_until` tipi `string | Date | null` yapıldı: ham `pg` ISO string,
Prisma `Date` döndürüyor; tek birine daraltmak WORM kontrolünü diğer adaptörde sessizce
yanlış yapardı.

## Mutasyon kanıtı

| Mutasyon | Sonuç |
|---|---|
| Migration'da `tags jsonb` → `tags text` | Drift testi kırıldı: *"missing from migration: tags jsonb NOT NULL"* (2 test) |
| `0017` dizini kaldırıldı + tablo DROP edildi | Canlı testin **8'i de** kırıldı, **üretimdeki hatanın birebir aynısıyla**: `Code: 42P01, relation "storage_blob" does not exist` |
| `::jsonb` / `::timestamptz` cast'leri geri alındı | Offline `pg.test.ts` kırıldı **ve** canlı test `42804` ile kırıldı |

Üçü de geri alındı, hepsi yeniden yeşil.

## Test sayısı

- `packages/storage`: **219** yeşil (8 yeni migration guard + 1 yeni cast regresyonu dahil)
- `apps/deploy`: **588** yeşil, 40 skipped (canlı 8'i `TEST_DATABASE_URL` olmadan atlanıyor)
- Kapı: **64/64 task** yeşil

`studio/screens-users` bir kez yük altında flake yaptı (bilinen, `apps/studio/` dosyasına
dokunmadım); tek başına **7/7** geçiyor. Aynı koşuda `bff`/`workflows`/`demo-stack` turbo
tarafından iptal edilmişti — tek tek koşuldu: **783/783**, **162/162**, typecheck temiz.

## Geri alınabilirlik / mevcut veri

Migration yalnızca **yaratıyor**: bir tablo + bir indeks, ikisi de `IF NOT EXISTS`.
Geri alma yönü `DROP INDEX storage_blob_key_pattern_idx; DROP TABLE storage_blob;`.
Hiçbir `ALTER` yok, dolayısıyla **dolu tabloya NOT NULL sütun ekleme tehlikesi yok**.
`IF NOT EXISTS` sayesinde tabloyu elle yaratmış bir dağıtımda tekrar uygulamak
başarısız migration değil, no-op.

`retain_until` **nullable** kaldı ve `object_lock` varsayılanı **false**: aksi halde
kilitsiz put imkânsız olurdu. Fail-closed şemada değil **sürücüde** duruyor
(`ObjectLockNotConfiguredError`) — ikisi de teste bağlı.

## ARAYÜZ İSTEKLERİ

Yok. `packages/contracts` ve `packages/ports` değişmedi; `StoragePort` yeterliydi.

## Yapmadıklarım

- **Canlı DB'ye yazmadım.** Yalnızca SELECT ile durum doğrulandı; `storage_blob` canlıda
  **hâlâ yok** ve `_prisma_migrations` `0016`'da. Tabloyu canlıya getirecek olan
  `migrate deploy` — bu benim yetkimde değildi.
- **Canlı ticket ile doğrulamadım** (OPS-51 yeniden koşturulmadı); servisler ve iki paralel
  ajan koşuyordu. Kanıt kendi Postgres'imde, gerçek sürücüyle uçtan uca alındı.
- `packages/adapter-jira`, `apps/bff/src/routes/webhooks.ts`, `apps/studio/` — dokunulmadı.
- `schema.prisma`'ya model eklemedim (yukarıdaki 4. gerekçe).
- `main`'e merge etmedim.
