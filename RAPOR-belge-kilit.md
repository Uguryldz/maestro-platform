# RAPOR — analiz belgesi Jira'ya eklenmiyor (objectLock yapılandırması)

## Özet

Akış zaten kusursuz çalışıyordu; kırık olan tek şey **kompozisyon kökünde eksik olan
`objectLock` yapılandırmasıydı**. `docx`/`pdf` hedefi kilitli bir `put` istiyor, sürücü
yapılandırma olmadığı için M57 gereği **reddediyor**, ve fail-soft dal belgeyi düşürüp
deftere sebebini yazıyordu. Reddetme doğruydu — **eksik olan yapılandırmaydı**.

İki ayrı kompozisyon noktası vardı ve **ikisi de** eksikti. Bu raporun en önemli bulgusu bu.

## Branch + commit

- Branch: `worktree-agent-a63caa671c02d6c55` (`96520de` üzerine)
- Commit: aşağıda "Commit" bölümünde.

## Yapılandırmayı nereye bağladım

Tek bir doğruluk kaynağı: **`apps/deploy/src/object-lock.ts`** (yeni, 57 satır).
`objectLockConfig(env, profile)` → `{ mode: "COMPLIANCE", years: 10 }`.

Buradan **iki** çağrı noktası besleniyor:

1. **`apps/deploy/src/boot.ts` → `buildStorageSink`** — *canlıda kırılan yol buydu.*
   `registerPublishDrivers`, `BinaryDocPublisher`'a `deps.sink`'i verir; bu nesne
   registry'nin `storage` portu **değildir**. Belgeyi yazan sink budur.
2. **`apps/deploy/src/driver-config.ts` → `storageConfig`** — registry'nin `StoragePort`'u.
   Kanıt paketi (`delivery.ts:159`, `manifest.json` dahil) bu port üzerinden kilitli
   `put` yapıyor, yani bu da aynı hatadan etkileniyordu.

**Neden ikisi de önemli:** İlk düzeltmemi sadece `driver-config.ts`'e uygulayıp
`boot.ts`'i geri aldığımda **hiçbir test kırılmadı** — çünkü `compose.test.ts`
`deployment.ports.storage`'ı yokluyor, sink'i değil. Sadece registry'yi düzeltmiş olsaydım
ek hâlâ çalışmayacak ama kod doğru görünecekti. Bu yüzden sink'e **kendi** regresyon
testini yazdım (`doc-storage-lock.test.ts`, "gives the docx target a sink that is itself
lock-configured") ve `boot.ts` geri alındığında **birebir canlıdaki hatayı** ürettiğini
doğruladım:

```
ObjectLockNotConfiguredError: storage: objectLock requested for
"evidence/OPS-49/run-20260816-0001/OPS-49-analysis.docx" but this driver has no
objectLock configuration (M57 fail-closed: silent downgrade is forbidden)
```

## Saklama süresinin kaynağı — uydurulmadı

- **10 yıl** → `plan/masterplan.md` **M56**: *"Audit + kanıt paketi saklama: **10 yıl**"*.
- **COMPLIANCE** → `plan/masterplan.md` **M57**: *"s3-compat sürücüsüne `object_lock: compliance` konfigü"*.

Sayıyı literal olarak tekrar yazmadım: `object-lock.ts`, `@maestro/storage`'ın
`RETENTION_YEARS_DEFAULT`'unu (`packages/storage/src/keys.ts:6` = 10) **import ediyor**.
Böylece üç kaynak — masterplan M56, `contracts` `EvidencePackageRow.retentionYears`
(varsayılan 10, `packages/contracts/src/evidence.ts:24`) ve sürücünün uyguladığı süre —
sessizce ayrışamaz.

**Neden GOVERNANCE değil COMPLIANCE:** GOVERNANCE modunda bypass yetkisi olan biri
saklamayı kısaltabilir veya kaldırabilir; COMPLIANCE'ta süre boyunca **hiç kimse**
yapamaz (root hesap dahil). Ayrıcalıklı bir operatörün sessizce silebildiği kanıt,
kanıt değildir.

## Prod profili (`s3-compat`) kararı

**Yapılandırdım** — `storageConfig` prod dalına da aynı `objectLock` eklendi. Gerekçe
doğrudan görevin kuralı: *"dev'de çalışıp prod'da sessizce kırılan bir şey bırakma."*
Prod'u boş bıraksaydım tam da o durum oluşurdu: dev 10 yıl kilitler, prod hiç kilitlemez.

**Kapatamadığım kısım ve nedeni:** S3'te `x-amz-object-lock-*` başlıkları uç noktaya
sadece **talimat verir**. Kovanın kendisinde Object Lock'un **oluşturulma anında** açılmış
olması gerekir; hiçbir istemci çağrısı bunu sonradan açamaz. Bu bir **operatör ön koşulu**,
kodun kapatabileceği bir boşluk değil. İyi haber: Object Lock'suz bir kova kilitli put'a
**400 ile** cevap verir — yani prod, korumasız nesne yazmak yerine **gürültülü** başarısız
olur; istenen yön budur. Bunu `storageConfig`'in üstündeki yorumda yazdım.

## Testler

Toplam **5 yeni test**, hepsi gerçek assert'li, ağ çağrısı yok:

`apps/deploy/test/doc-storage-lock.test.ts` (yeni, 3 test) — sahte sink **yok**; gerçek
`BinaryDocPublisher` gerçek `PgBlobStorage`'a yazıyor:
1. Gerçek `.docx` kilit altında saklanıyor (satır yazıldı, >1000 bayt, `object_lock=true`,
   `retain_until` 10 yıl sonra).
2. `docx` hedefinin aldığı **sink'in kendisi** kilit yapılandırmalı (`bootPlatform`
   üzerinden, canlıdaki yol).
3. Yapılandırma yokken belge **hâlâ reddediliyor** ve **hiçbir satır yazılmıyor** —
   korumasız kopya yok (M57 korunuyor).

`apps/deploy/test/compose.test.ts` (2 yeni test, 22 → 25):
4. Kompoze edilmiş storage portu kilitli put'u onurlandırıyor (10 yıl doğrulanıyor).
5. Prod `s3-compat` config'i **aynı** saklamayı taşıyor.

Mevcut `packages/publish` testleri bu hatayı **yakalayamazdı**: publisher'a her put'u
kabul eden sahte bir sink veriyorlar. Kanıtın `apps/deploy`'da yaşamasının sebebi bu.

## Mutasyon kanıtı

**Mutasyon 1 (M57 zayıflatma):** `packages/storage/src/pg.ts:105`'te reddetmeyi sessiz
düşürmeye çevirdim (`if (!lock) { retainUntilAt = null; }` — M57'nin yasakladığı şeyin ta kendisi):
- `compose.test.ts` → "still refuses a locked put when objectLock is unconfigured" **kırıldı**
- `@maestro/storage` → 210 testten 1'i **kırıldı**
- Geri alındı, `git diff` temiz, ikisi de yeşil.

**Mutasyon 2 (asıl düzeltmeyi geri alma):** `boot.ts`'teki `objectLock`'u kaldırdım:
- Yeni sink testi **kırıldı**, üstelik **canlıdaki hata mesajının aynısıyla**.
- `compose.test.ts` **kırılmadı** — sink ile registry'nin ayrı yollar olduğunun kanıtı;
  bu yüzden ayrı test gerekti.
- Geri alındı, hepsi yeşil.

## Kapı

`pnpm run gate` → **64/64 görev başarılı**, `@maestro/deploy` 588 test (585'ten +3).
Bir koşuda `@maestro/studio` `screens-killswitch` düştü; **tek başına yeşil**
(722ms, yük altındaki 1497ms zaman aşımına karşı) — HANDOFF'ta belgelenmiş yük flake'i,
storage ile ilgisi yok, dokunmadım.

## Korunanlar

- **M57 fail-closed zayıflatılmadı.** Yapılandırma yokken kilitli put hâlâ reddediliyor;
  bunu bir teste sabitledim ki gelecekte sessizce gevşemesin.
- **Fail-soft davranışı korundu.** `analysis-docs.ts`'e dokunmadım; belge üretilemezse
  akış hâlâ çökmüyor, deftere ve Jira'ya yazıyor.
- `contracts` / `ports` **donmuş** — değiştirilmedi.
- Metin katalogları değiştirilmedi (tr+en paritesi bozulmadı).

## ARAYÜZ İSTEKLERİ

**Yok.** `PgBlobStorageOptions` ve `S3StorageOptions` şemaları `objectLock`'u zaten
taşıyordu; eksik olan sadece kompozisyon kökünde değerin verilmesiydi. Donmuş paketlere
dokunmak gerekmedi.

## Yapmadıklarım

- **Canlı ticket ile uçtan uca doğrulama yapmadım.** Kanıtım test seviyesinde: gerçek
  publisher + gerçek sürücü + gerçek config, canlı hata mesajının testte yeniden
  üretilmesi dahil. Canlı doğrulama worker'ın yeniden başlatılmasını gerektiriyor;
  HANDOFF *"launcher restart oturumu düşürür → önce haber ver"* diyor, o yüzden
  durdum. **Sıradaki adım:** worker'ı bu commit ile yeniden başlatıp yeni bir ticket
  koşturmak; ek sayısı 0 yerine 1 olmalı.
- Canlı DB'ye yazmadım; `storage_blob`'u okumak istedim ama `psql` yok ve `pg` bu
  workspace'in bağımlılığı değil (proje Prisma kullanıyor). Sadece SELECT denedim,
  yazma girişimi olmadı.
- **Geçmişte başarısız olan OPS-42/OPS-49 belgelerini geri doldurmadım.** O koşular
  `done` durumunda; yeniden üretmek ayrı ve bilinçli bir karar olmalı.
- Saklama süresini profil başına değiştirilebilir yapmadım. `objectLockConfig` `env` ve
  `profile` alıyor ama bugün hepsine aynı politikayı veriyor — bilerek: dev'in daha zayıf
  kilitlediği bir kurulum, sertifikalanan koddan farklı bir yol koşardı.
