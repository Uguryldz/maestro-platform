# `@maestro/storage` — Builder Raporu (Tur 2: doğrulayıcı bulgularının kapatılması)

**Durum: YEŞİL.** `pnpm install` · `pnpm -F @maestro/storage typecheck` · `pnpm -F @maestro/storage test` ·
kökten `pnpm lint` + `pnpm typecheck` + `pnpm test` — hepsi geçiyor.
**210 test, 8 test dosyası** (tur 1: 160 test, 7 dosya).

---

## 0. Bu turda ne kapandı (doğrulayıcı bulguları)

Her düzeltmenin ÖNCE kırmızı bir regresyon testi yazıldı; testler yazıldığında paket
**32 kırmızı** verdi. Aşağıdaki tabloda her satırın yanında onu ısıran test var.

### BLOKE bulgular

| # | Durum | Ne yapıldı | Isıran test |
|---|---|---|---|
| **B-1** | KAPANDI | Kilitli `put` artık **imzalanan** `content-md5: base64(md5(body))` gönderiyor (AWS: Object Lock'lu yüklemede `Content-MD5` veya `x-amz-sdk-checksum-algorithm` zorunlu). `FakeS3` bu başlık yoksa **400 `InvalidRequest`** dönüyor, varsa MD5'i gövdeden yeniden hesaplayıp doğruluyor. | `s3.test.ts` "sends an integrity checksum with a locked put" + invariance paketindeki tüm kilitli put'lar |
| **B-2** | KAPANDI | pg-blob WORM kontrolü **config kapısını kaybetti**: `assertNotRetained` artık her `put`/`delete`'te satırı okuyor. `put`'un `ON CONFLICT` bloğu WORM sütunlarını **birleştiriyor**, sıfırlamıyor: `object_lock = (existing.object_lock OR EXCLUDED.object_lock)`, `retain_until = GREATEST(existing.retain_until, EXCLUDED.retain_until)`. `FakePg` bu iki ifadeyi regex'le zorunlu tutuyor. | `pg.test.ts` "keeps enforcing a retention after the lock configuration is removed" + "never clears the WORM columns" + **invariance paketi** (aşağıda) |
| **B-3** | KAPANDI | İki katmanlı: (a) `send` her 2xx yanıtta `x-amz-request-id`/`x-amz-id-2` arıyor — yoksa `UnexpectedResponseError` (yeni, `StorageRequestError` alt sınıfı); listelemede ayrıca `content-type`'ın XML olmasını şart koşuyor. (b) `parseListObjectsV2` kök elemanın `ListBucketResult` olduğunu doğruluyor. `get` ve `put` de aynı kontrolden geçiyor — proxy'nin 200'ü artık ne boş liste ne 25 baytlık "nesne". | `s3-response.test.ts` "a 200 that did not come from the S3 API…" (5 test) + `xml.test.ts` (4 test) |
| **B-4** | KAPANDI | `isTruncated === true` ama token yok → `UnexpectedResponseError`. Kısmi liste asla döndürülmüyor. | `s3-response.test.ts` "refuses a truncated page that carries no continuation token" |
| **B-6** | KAPANDI | 404 artık gövdedeki `<Code>`'a göre ayrılıyor: `NoSuchKey` (veya gövdesiz 404) → `ObjectNotFoundError`/no-op; `NoSuchBucket` ve diğerleri → `StorageRequestError`. | `s3-response.test.ts` "delete tells a missing key apart from a missing bucket" (4 test) |
| **B-7** | KAPANDI (orkestratör kararına göre) | Sözleşme daraltılmadı. `FileName` artık yalnız `/` ve kontrol karakterini reddediyor; `evidenceKey`/`archiveKey` dosya adını **yüzde-kodluyor**, `parseEvidenceKey` geri çözüyor (çözülemeyen dizi → `undefined`). Türkçe ad, boşluk, parantez, `&`, `%` gidiş-dönüş testli. | `keys.test.ts` "accepts and round-trips a contract-legal file name" (6 vaka) + **invariance** "stores an evidence file whose name is Turkish and parenthesised" |
| **B-8** | KAPANDI | `contracts`'taki yeni `RunId` ile gidiş-dönüş testi eklendi (en kısa geçerli id dahil); `parseEvidenceKey` runId'yi artık `RunId` şemasıyla doğruluyor. | `keys.test.ts` "round-trips the shortest run id the contract allows" |

### Dalga 2 içinde kapatılması istenenler

| # | Durum | Ne yapıldı | Isıran test |
|---|---|---|---|
| **B-5** | KAPANDI | Sayfalama `for` döngüsüne alındı: `MAX_LIST_PAGES = 10_000` tavanı **ve** `next === previous` token tekrar kontrolü. İkisi de `StorageRequestError`. | `s3-response.test.ts` "refuses a server that repeats the same continuation token" + "stops at the page ceiling" |
| **B-9** | KAPANDI | `retentionClassForKey(key, fallback)`: sınıf **anahtar önekinden** türetiliyor (`evidence/`, `archive/`, `journal/`, `knowledge/`); sürücü konfigündeki `retentionClass` yalnız bilinmeyen düzenler için yedek. Her iki sürücüde de aynı. (`StoragePort.put` opsiyonları DONUK olduğu için sınıf oraya taşınamazdı.) | `s3.test.ts` "labels each object with the retention class of its own key" + `keys.test.ts` |
| **B-10** | KAPANDI | Sürücü `bytea` parametresini `Buffer.from(data)` olarak bağlıyor; `SqlExecutor` dokümantasyonuna **ikili sözleşme** yazıldı; `FakePg` `Buffer.isBuffer` değilse `throw` ediyor. | `pg.test.ts` "binds bytea as a node Buffer" (+ mutasyonda 5 test kırılıyor) |
| **B-11** | KAPANDI | `S3StorageOptions`, `PgBlobStorageOptions` ve iç `objectLock` nesneleri `z.strictObject`. `keyPrefixx` artık `StorageConfigError`. | `s3.test.ts` / `pg.test.ts` "rejects a misspelled option instead of silently ignoring it" |

### Fırsat bulundukça listesi — hepsi kapatıldı

| # | Ne yapıldı |
|---|---|
| **B-12** | `decodeXmlText` aralık dışı/surrogate sayısal varlıkta artık `RangeError` atmıyor, varlığı **harfi harfine** bırakıyor (`xml.test.ts`). |
| **B-13** | 1024 baytlık sınır artık **fiziksel** anahtara da uygulanıyor (`assertKeyByteLength`, her iki sürücünün `fullKey`'inde). Invariance testinde. |
| **B-14** | Geçersiz TTL artık `ZodError` değil `InvalidTtlError` (tamsayı/pozitif/tavan; 5 vaka). |
| **B-15** | `evidenceTicketPrefix` yılı 4 haneye zorluyor (`KeyYear`), yani `parseEvidenceKey` ile aynı sözleşme. |
| **B-16** | `pgBlobTableDdl` artık `CREATE INDEX … (key text_pattern_ops)` da üretiyor — `LIKE 'prefix%'` tam tablo taraması olmaktan çıktı. |
| **B-17** | `canonicalHeaders` yalnız harf-büyüklüğüyle ayrışan başlıkları **tek başlıkta birleştiriyor** (değerler virgülle), `host;host` imkânsız. Presign'ın `X-Amz-SignedHeaders`'ında da tekilleştirme var. |
| **B-18** | Tautolojik `typeof globalThis.fetch === "function"` testi atıldı; yerine **global `fetch`'i patlatan** ve sürücünün yalnız enjekte edilen `fetch`'i kullandığını kanıtlayan test kondu. |
| **B-19** | §6 güncellendi (aşağıda). |

---

## 1. `FakeS3` artık imzayı gerçekten doğruluyor

Doğrulayıcının en önemli uyarısı buydu: sahte uç yalnız `Authorization` başlığının
**varlığına** bakıyordu, dolayısıyla bir kanonikleştirme hatasını paket içi hiçbir test
yakalayamazdı.

`test/fakes/sigv4-verify.ts` (140 satır) **`src/sigv4.ts`'i import etmeyen bağımsız bir
doğrulayıcı**: tele düşen baytlardan (istek satırı, `url.pathname`, `url.search`, başlıklar,
gövde) imzayı yeniden türetir. Farklar bilinçli — RFC 3986 kodlaması bayt bayt yeniden
yazıldı, kanonik yol/sorgu **çözülüp yeniden kodlanarak** karşılaştırılıyor, `host`
URL'den alınıyor (sürücü onu başlık olarak göndermiyor). Uyuşmazsa `403 SignatureDoesNotMatch`.

Kanıtı: `uriEncode`'u sıradan `encodeURIComponent`'e düşüren mutasyon artık yalnız birim
testini değil, **sürücü sözleşme testini de** kırıyor (parantezli/Türkçe kanıt dosyası vakası).

`FakeS3` bu turda ayrıca gerçek uç kurallarını öğrendi: kilitli put'ta bütünlük sağlaması
zorunlu, saklama altındaki nesne ne yazılabilir ne silinebilir, her yanıt `x-amz-request-id`
taşır.

**Sınır:** presign edilmiş URL `fetch`'ten geçmediği için sahte uç onu doğrulamıyor;
presign'ın doğruluğu hâlâ yalnız AWS'nin yayımlanmış bilinen-cevap vektörüne dayanıyor.

---

## 2. Sürücü-değişmezliği: WORM artık paketin içinde

Doğrulayıcının "invariance paketinin en kritik ihlali" dediği vaka artık orada:

> **"keeps a retained object protected when the lock configuration is removed"** —
> kilit konfigüratlı bir sürücü örneğiyle nesne yazılır, sonra **aynı arka uca** kilitsiz
> ikinci bir sürücü örneği bağlanır: hem `put` hem `delete` reddedilir, baytlar değişmez.

Bunun için koşum yapısı `create()`'ten `deploy()`'a çevrildi: bir arka uç, üzerine
istenildiği kadar sürücü örneği (`deployment.driver(objectLock?)`). Böylece "konfig
değişti, veri aynı yerde" senaryosu üç koşumda da ifade edilebiliyor.

**Hâlâ farklı olan tek nokta** (bilinçli, §5.1): ihlalin **hata sınıfı**. s3-compat'ta uç
`403 AccessDenied` döndüğü için `StorageRequestError`, pg-blob'da `ObjectLockedError`.
Invariance testi bu yüzden "reddedilir + veri korunur" diye yazıldı, hata sınıfını
sabitlemiyor.

---

## 3. Dosya ve test özeti

| Dosya | Satır | Değişiklik |
|---|---|---|
| `src/s3.ts` | 265 | md5'li kilitli put, yanıt doğrulama, sayfalama tavanı/token kontrolü, 404 ayrımı, sınıf-anahtardan, TTL hatası |
| `src/sigv4.ts` | 215 | yinelenen başlık birleştirme (B-17) |
| `src/pg.ts` | 211 | WORM her zaman satırdan, WORM sütun birleştirme, `Buffer` bind, `text_pattern_ops` indeksi, `strictObject` |
| `src/keys.ts` | 193 | dosya adı yüzde-kodlama, `assertKeyByteLength`, `retentionClassForKey`, 4 haneli yıl |
| `src/errors.ts` | 112 | `UnexpectedResponseError`, `InvalidTtlError`, `ResponseContext` |
| `src/xml.ts` | 91 | kök eleman doğrulaması, güvenli varlık çözme |
| `src/s3-http.ts` | 67 | **yeni** — uç ayrıştırma, `queryString`, `contentMd5`, yanıt teşhisi, sayfa tavanı |
| `src/s3-options.ts` | 47 | **yeni** — `S3StorageOptions` şeması (s3.ts 300 satır tavanının altında kalsın diye ayrıldı) |
| `src/registry.ts` | 47 | — |
| `src/deps.ts` | 44 | `SqlExecutor` ikili sözleşmesi belgelendi |
| `src/index.ts` | 8 | — |
| **Toplam üretim** | **1300** | En büyük dosya 265 (tavan 300 ✓). Tur 1'de 1037'ydi; artışın tamamı yukarıdaki bulgular. ~1200'lük paket tavanının %8 üzerinde — bölmek yerine bulguları kapatmayı tercih ettim, gerekçesi bu tablo. |

| Test dosyası | Test | Odak |
|---|---|---|
| `driver-contract.test.ts` | 75 | Sürücü-değişmezliği, 3 koşum (+WORM konfig-kaldırma, fiziksel anahtar sınırı, Türkçe dosya adı) |
| `s3.test.ts` | 30 | Adresleme, imzalama, saklama başlıkları/etiketleri, presign, config |
| `keys.test.ts` | 40 | Anahtar şeması + kodlama, anahtar güvenliği, 10 yıl, sınıf türetme |
| `pg.test.ts` | 21 | SQL yüzeyi, `bytea` bağlama, WORM emülasyonu ve fail-open regresyonu, DDL |
| `xml.test.ts` | 13 | Kök eleman, varlık çözme, hata gövdesi |
| `s3-response.test.ts` | 12 | **yeni** — sahte 200, kesik/döngüsel listeleme, 404 ayrımı |
| `sigv4.test.ts` | 11 | AWS bilinen-cevap vektörleri + kanonikleştirme (yinelenen başlık dahil) |
| `registry.test.ts` | 8 | M44 kaydı |
| **Toplam** | **210** | Ağ yok, saat enjekte, tamamen deterministik |

**Mutasyon denetimi (bu tur, 7/7 yakalandı):**

| Mutasyon | Sonuç |
|---|---|
| Kilitli put'tan `content-md5`'i kaldır | 6 test KIRILDI ✓ |
| pg WORM kontrolüne config kapısını geri koy | 2 test KIRILDI ✓ (biri invariance) |
| Kanonik sorgu sıralamasını kaldır | 2 test KIRILDI ✓ (biri **sahte ucun imza doğrulaması** sayesinde) |
| `uriEncode`'u düz `encodeURIComponent` yap | 3 test KIRILDI ✓ (ikisi sürücü seviyesinde) |
| Yanıt teşhisini her zaman "sorun yok" yap | 2 test KIRILDI ✓ |
| 404'ü koşulsuz "anahtar yok" say | 2 test KIRILDI ✓ |
| `bytea`'yı çıplak `Uint8Array` bağla | 5 test KIRILDI ✓ |

---

## 4. Varsayımlar (değişenler işaretli)

1. **`delete` fikirseldir** — olmayan anahtar no-op. *Değişti:* bu yalnız `NoSuchKey`/gövdesiz
   404 için geçerli; `NoSuchBucket` artık hata.
2. **`list` mantıksal anahtar döndürür**; `keyPrefix` çağırana görünmez.
3. **`content-length` imzalanmaz ve gönderilmez**; `host` imzalanır, gönderilmez.
4. **Varsayılan adresleme `path`.**
5. **Saat enjekte edilir.**
6. `retainUntil` UTC takvimiyle çalışır; 29 Şubat başlangıcı saklamayı uzatır, kısaltmaz.
7. *(Yeni)* **Her 2xx yanıt `x-amz-request-id` taşımalıdır.** Bunu bilerek soyan bir uç için
   `requireAmzResponseHeaders: false` kapısı var; kapatan, proxy'nin login sayfasını "boş
   kova" diye okuma riskini bilerek kabul eder.
8. *(Yeni)* **Kanıt dosyası adı anahtarda yüzde-kodludur.** Fiziksel anahtar
   `…/rapor%20özet.pdf` görünür; mantıksal ad `parseEvidenceKey` ile geri gelir. Denetçi
   kovaya çıplak gözle bakarsa kodlanmış ad görür — bu bilinçli takas.
9. *(Yeni)* **pg-blob her `put`/`delete` öncesi bir `SELECT` yapar.** WORM kontrolü artık
   konfige bağlı olmadığı için kilit hiç kullanılmayan kurulumlarda da bir sorgu maliyeti
   var; korumanın veriye bağlı olması bu maliyetten önemli.

---

## 5. Bilerek eksik bırakılanlar

1. **S3'te WORM ihlalinin hata eşlemesi.** Gerçek uç 403 + `AccessDenied` döner, kilide özgü
   kod yoktur; uydurma kod yazmaktansa `StorageRequestError` bırakıldı. Invariance testi bu
   yüzden hata sınıfını değil davranışı sabitliyor (§2). Kapanışı: gerçek uçtan kaydedilmiş
   yanıt fikstürü (insa-plani §6, Aşama-0 duman testi).
2. **Çok parçalı yükleme.** `getStream`/`putStream` kararına bağlı (§7.2).
3. **Kova yaşam döngüsü kuralının uca uygulanması** — `deploy` paketinin işi.
4. **Retry/backoff ve devre kesici** — tüm portlar için ortak bir sarmalayıcı olmalı,
   sürücü başına yazmak v1'in dağınıklığıdır.
5. **SSE-KMS başlıkları** — masterplan'da M kararı yok.
6. *(Yeni)* **Presign'ın sahte uçta doğrulanması** — §1'deki sınır.
7. *(Yeni)* **`x-amz-sdk-checksum-algorithm` + `x-amz-checksum-sha256` yolu.** B-1 için
   `content-md5` seçildi: gövde hash'i zaten hesaplanıyor, MD5 tek ek geçiş ve her
   S3-uyumlu üründe destekli. SHA256 checksum başlıkları daha yeni bir API yüzeyi ve
   kurumsal gateway'lerde desteği belirsiz.

---

## 6. Arayüz / bağımlılık talepleri (orkestratör kararı gerekir — tekrar)

1. **`StoragePort.get` bir `Uint8Array` döndürüyor** → nesne tamamen bellekte. M34/M65
   paketleri yüzlerce MB olabilir. `getStream`/`putStream` kararı hâlâ bekliyor.
2. **`StoragePort.put` opsiyonları** `{ contentType, objectLock }` ile donuk; saklama sınıfı
   bu yüzden anahtar önekinden türetildi (B-9). Sınıfı çağıran belirlesin isteniyorsa port
   değişmeli.
3. **`db` paketine görev devri:** `pgBlobTableDdl()` artık tablo **ve** `text_pattern_ops`
   indeksini üretiyor; migration'ı `db` paketi yazmalı.
4. **`config` paketine öneri:** şemalar artık `strict`; `STORAGE_*` env eşlemesi yazılırken
   fazladan anahtar bırakmamak gerekiyor (sessizce yutulmaz, hata verir).
5. **Bağımlılık:** yeni runtime bağımlılığı **yok**. `node:crypto`'dan `createHash("md5")`
   eklendi (B-1). `@types/node` devDependency olarak duruyor.

---

## 7. Not: dal tabanı

Tur 1 `wave1-storage` dalındaydı ve **main'e merge edildi** (doğrulayıcının B-19 notu
haklıydı, önceki rapor eskimişti). Bu tur `main` üzerinden açılan **`wave2-storage-hardening`**
dalında; merge edilmedi, push edilmedi.
