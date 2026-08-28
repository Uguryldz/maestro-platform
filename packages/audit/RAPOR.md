# @maestro/audit — builder raporu

Denetim izinin **TEK** gerçeklemesi: SHA-256 hash zinciri · tek yazar kuralı · kurcalama/silme/yeniden
sıralama tespiti · günlük imzalı anchor · ArcSight CEF/syslog SIEM export (M33, M56, M32, M101).

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/canonical.ts` | Kanonik serileştirici (kendi yazıldı). Anahtarlar UTF-16 sırasıyla sıralı, boşluk yok, string'ler JSON kaçışlı **+ `\|` ayrıca `|` olarak kaçırılır**. Temsil edilemeyen değerler (`undefined`, `NaN`/`Infinity`, `bigint`, fonksiyon, symbol, `Map`/`Set`/`RegExp`, sınıf örneği, döngü, geçersiz `Date`) sessizce atlanmaz — `AuditCanonicalizationError` ile **reddedilir**. `Date` tek istisna: UTC ISO string'e serileşir. |
| `src/hash.ts` | `chainInput` = `seq \| at \| actor \| action \| subject \| prevHash \| canonical(meta)`; `computeEventHash` (sha256, küçük harf hex), `sealEvent`, `rehash` (saklı kayıttan yeniden hesap), `sha256Hex`, `GENESIS = "genesis"`. **`sealEvent` sözleşme şemasının ÇIKTISINI hash'ler** (`AuditEvent.omit({hash:true}).parse` → sonra `computeEventHash`) ve mühürlemeden önce üç kapı çalıştırır: `assertActor` · `assertSubject` · `assertUtcInstant`. Son adım `rehash(event) === event.hash` kendi kendini denetimi: `sealEvent` kendi doğrulamasından geçmeyen bir kaydı ASLA döndürmez. |
| `src/actor.ts` | `parseActor` / `assertActor` / `humanBehind` / `isHumanActor`. Kabul edilen dört biçim: `user@corp` · `maestro-worker` · `maestro-runner` · `ai-via:<user>` (M101). Sınıflandırılamayan aktör append anında reddedilir. |
| `src/fields.ts` | Hash'lenen serbest alanların fail-closed kuralları (K2/D1/D7/O4): `subjectRejection` / `assertSubject` (boş değil · kırpılmamış · `SUBJECT_MAX_LENGTH = 128` · kontrol karakteri yok · Unicode NFC) ve `assertUtcInstant` (`Z`, milisaniyeli, `new Date(at).toISOString() === at`). Hiçbiri **dönüştürmez**, reddeder. |
| `src/actions.ts` | `AUDIT_ACTION_INFO: Record<AuditAction, AuditActionInfo>` — CEF severity (0-10) + insan-okur ad + kategori + (varsa) outcome + `humanOnly`. **`Record` olduğu için contracts'a yeni action eklenirse bu dosya derleme hatası verir.** |
| `src/store.ts` | `AuditStore` arayüzü (`head` · `append` · `read`) + `InMemoryAuditStore`. Depo append-only: ilerlemeyen `seq`, tekrar eden `hash` **ve tekrar eden `prevHash`** reddedilir — üçü de `AuditLog`'un gerçek index'lerinin aynısı (D2). **Prisma import edilmedi.** |
| `src/chain.ts` | `AuditChain` (tek gerçekleme): `append` · `appendMany` (tek kilit altında bütün bir koşu) · `head` · `verify`. `ChainLock` arayüzü + `LocalChainLock` (süreç içi sıraya alıcı, hata kuyruğu zehirlemez). `Clock` enjekte edilir; `at` her zaman UTC'ye normalize edilir. **`verify()` beklentiyi kayıtlardan ASLA türetmez** (K1): aralıksız çağrıda daima `seq 1` + `genesis`; `fromSeq > 1` ise `expectPrevHash` (imzalı anchor'ın `headHash`'i) zorunlu — yoksa doğrulama yumuşatılmaz, `AuditChainError` ile reddedilir. |
| `src/verify.ts` | `verifyChain(events, options?)` → `{ ok, checked, firstBadSeq, headHash, issues[] }`. Bulgu türleri: `schema_invalid` · `hash_mismatch` · `prev_hash_mismatch` · `sequence_gap` · `out_of_order` · `bad_start` · **`empty`**. Boş girdi artık `ok:false` (O3). `schema_invalid` bir kaydın ARDINDAN gelen kayıtlar da denetlenir — okunamayan kaydın `seq`/`hash`'i kurtarılarak bağ zinciri sürdürülür (D5). `expectFirstSeq`/`expectPrevHash` yalnız çağırandan gelir. |
| `src/anchor.ts` | Günlük anchor (M33): `AuditAnchorBody`/`AuditAnchor` Zod şemaları, `buildAnchor` (gün dilimini önce doğrular, sonra imzalar; **`expectPrevHash` ZORUNLU** — bir önceki günün anchor `headHash`'i ya da `GENESIS`; devam anchor'ında `expectFirstSeq` de zorunlu, O2), `verifyAnchor`, `chainDigestOf` (günün TÜM hash'leri üzerinden özet — sadece zincir başı değil), `utcDayOf`, `eventsOfDay`, `AnchorSigner` arayüzü + `HmacAnchorSigner`. Ayrıca M56: `AUDIT_RETENTION_YEARS = 10` + `retentionExpiryOf`. |
| `src/cef.ts` | `toCefLine` / `toCefLines` / `toSyslogLine` + `escapeCefHeader` / `escapeCefExtension`. Başlık: `CEF:0\|Maestro\|Maestro\|<ver>\|<action>\|<name>\|<severity>\|<ext>`. |
| `src/anchor-series.ts` | `verifyAnchorSeries(anchors, signer, start?)` (O1): anchor'ları BİRBİRİNE bağlı bir dizi olarak doğrular — imza · gün sırası · `anchor[i].prevHash === anchor[i-1].headHash` · `firstSeq === öncekiLastSeq + 1` · `eventCount === lastSeq - firstSeq + 1`. Dizi varsayılan olarak genesis'ten başlamak zorundadır; arşivlenmiş bir baştan devam ediliyorsa `start` DIŞARIDAN verilir. |
| `src/errors.ts` | `AuditCanonicalizationError` · `AuditActorError` · **`AuditFieldError`** · `AuditChainError` · `AuditAnchorError` · `AuditExportError`. |

**Üretim kodu: 1512 satır**, en büyük dosya 236 satır (tavan 300).

### Kurcalama tespiti — denetim ekibine gösterilecek kanıt
| Saldırı | Nasıl yakalanır | Test |
|---|---|---|
| Kaydı **değiştir** (ör. onaylayanı değiştir, hash'e dokunma) | kaydın kendi alanlarından yeniden hesaplanan hash tutmaz → `hash_mismatch`, `firstBadSeq = 3` | `verify.test.ts` "catches a TAMPERED record" |
| `meta` içine tek anahtar ekle | aynı şekilde `hash_mismatch` | "catches a tampered meta field" |
| Kaydı **sil** | `sequence_gap` (kaç kayıt eksik dahil) + `prev_hash_mismatch` | "catches a DELETED record" |
| İlk kaydı sil | `bad_start` ("expected 1", "expected genesis") | "catches deletion of the first record" |
| Kayıtları **yeniden sırala** | `out_of_order` + `prev_hash_mismatch` | "catches REORDERED records" |
| Kaydı çoğalt | `out_of_order` | "catches a duplicated record" |
| Başka zincirden kayıt yapıştır (kendi içinde geçerli) | `prev_hash_mismatch` | "catches a record swapped in from another chain" |
| **Tüm günü yeniden yaz** (zincir kendi içinde tutarlı olur) | hash zinciri yakalayamaz — **anchor yakalar**: `headHash` / `chainDigest` uyuşmaz | `anchor.test.ts` "catches a rewritten chain that is internally consistent" |
| Zincirin **sonunu kırp** | zincir tek başına geçerli görünür (raporda açıkça yazılı); anchor `eventCount`/`headHash` ile yakalar | "catches deletion of the last record…" + "catches a truncated day" |
| **Tabloyu boşalt** | `verifyChain([])` → `ok:false`, `issues:[empty]`; `AuditChain.verify()` de öyle | `chain-verify.test.ts` "REFUSES an emptied table…" · `verify.test.ts` "refuses an empty input (O3)" |
| **Zinciri sahte genesis'ten yeniden mühürle** | beklenen başlangıç kayıttan değil sabitten geldiği için `bad_start`, `firstBadSeq = 1` | `chain-verify.test.ts` "REFUSES a chain re-sealed from a forged genesis" |
| **Kırpılmış günü imzalat** | `buildAnchor` `expectPrevHash` olmadan çalışmaz; verilen beklentiye uymayan gün `chain_broken` | `anchor.test.ts` "refuses to sign a day whose first records were deleted (O2)" |
| **Tüm bir GÜNÜ sil** | tek tek anchor'lar hâlâ `ok` döner — **diziyi doğrulama yakalar**: kopan `prevHash`/`firstSeq` bağı | `anchor-series.test.ts` "catches a WHOLE DAY deleted… (O1)" |
| **Denetim izini tek boşlukla zehirle** (`subject: "UGURPAY-1 "`) | mühürlemeden önce `assertSubject` reddeder; kayıt hiç yazılmaz, gün imzalanmaya devam eder | `fields.test.ts` "refuses a subject with trailing or leading whitespace" + "would have poisoned a whole day's anchor" |

### Tek yazar kuralı
`AuditChain.append` "head oku → sıradaki kaydı yaz" işini `ChainLock` altında yapar. M33 "tek yazar"
bir **dağıtım kararıdır, garanti değildir**: aynı worker'da iki eşzamanlı aktivite aynı head'i okur ve
aynı `seq`+`prevHash` ile iki kayıt üretir — zincir çatallanır. Kilit arayüz olduğu için Dalga 3'te
worker'a Postgres advisory lock enjekte edilir, bu paket veritabanı bağımlılığı kazanmaz.
İki test bunu ispatlıyor: kilitle 50 eşzamanlı append → `seq` 1..50 kesintisiz ve zincir doğrulanıyor;
kilitsiz (testin kendi `NO_LOCK`'u ile) → yazımların çoğu reddediliyor, zincir çatallanamıyor.

## 2. Testler

`pnpm -F @maestro/audit test` → **11 dosya / 109 test, hepsi yeşil.** Tamamen çevrimdışı ve deterministik:
ağ yok, dosya yok, `Date.now()` yok — saat `fixedClock` ile enjekte ediliyor, imza anahtarı testte sabit.

- `canonical.test.ts` (11): anahtar sırası bağımsızlığı, iç içe sıralama, 20 koşuda tek çıktı, pipe kaçışı ve çakışma önleme, JSON kaçışları + yalnız-vekil, `Date`, sayı biçimi, 11 reddedilen tür, döngü, sınıf örneği, null-prototip.
- `hash.test.ts` (8): tam chain-input string'i, sha256 eşitliği, 25 koşuda tek hash, meta anahtar sırası, **her alanın tek tek hash'i değiştirmesi**, pipe kaydırma saldırısı, `sealEvent` sözleşme reddi.
- `fields.test.ts` (10) — **YENİ**: `subject` kırpılma tuzağı (K2) dört açıdan; 128 karakter sınırı (D1); NFC/NFD (D7); kontrol karakteri; offset'li ve milisaniyesiz `at` reddi (O4).
- `actor.test.ts` (6): dört biçim, delegasyonun arkasındaki insan, AI ≠ insan, 14 reddedilen biçim, hata mesajının biçimleri sayması.
- `chain.test.ts` (13): genesis, bağlama, UTC normalizasyonu, aktör reddi, **gate kararı için insan-olmayan aktör reddi**, geçersiz zaman damgası, 50 eşzamanlı append, kilitsiz çatallanma ispatı (**tam olarak 1 kayıt yazılıyor, 9 red** — D3), `appendMany` bütünlüğü, hata sonrası kuyruk sağlığı, depo değişmezleri (`seq`/`hash`/**`prevHash`** — D2), aralık okuma.
- `chain-verify.test.ts` (9) — **YENİ**: K1'in tamamı. Testler bilerek `AuditChain.verify()` ÜZERİNDEN yazıldı, saf `verifyChain` üzerinden değil: bulgunun kök nedeni, güvenlik iddialarının üretimde kullanılmayan fonksiyonda kanıtlanmış olmasıydı.
- `verify.test.ts` (15): kurcalama tablosu + boş girdi reddi (O3), okunamayan kaydın ARDINDAKİ kayıtların denetlenmesi (D5, iki senaryo), dilim doğrulama, sahte genesis, `AuditEvent` olmayan kayıt.
- `anchor.test.ts` (15): özet + imza, tekrarlanabilirlik, doğrulama (kayıtlı/kayıtsız), değiştirilmiş anchor, yeniden yazılmış zincir, kırpılmış gün, yanlış anahtar/keyId, kırık zinciri imzalamayı reddetme, **kırpılmış günü imzalamayı reddetme + devam anchor'ında zorunlu beklenti (O2)**, boş gün / karışık gün, şema reddi, kanonik gövde imzası, gün gruplama, 10 yıl saklama.
- `anchor-series.test.ts` (7) — **YENİ**: O1. Bağlı dizi kabulü, **tüm bir günün silinmesi**, genesis'ten başlamayan dizi (+ dışarıdan verilen `start` ile kabulü), sırasız günler, `eventCount` tutarsızlığı, imza hatasının konumla raporlanması, boş dizi / okunamayan anchor.
- `cef.test.ts` (10): **25 AuditAction'ın hepsi için üretilen satır bağımsız ayrıştırıcıyla parse ediliyor** ve her alan doğrulanıyor; `ai-via` delegasyonu, kaçış saldırısı (`|`, `=`, `\`, `\n`, satır içine gömülü sahte `CEF:0|Evil|…` başlığı), kaçış kuralları, meta'sız satır, geçersiz kayıt reddi, toplu export; syslog: RFC 3164 çerçevesi, severity eşlemesi, host/facility doğrulaması.
- `actions.test.ts` (5): tablo ↔ enum birebir örtüşmesi, severity aralığı + ad kalitesi, önem sıralaması, `humanOnly` ve `outcome` kümelerinin tam listesi.

**CEF ayrıştırıcısı bilerek `src/cef.ts`'in tersi DEĞİL** (`test/cef-parser.ts`): format kurallarından
bağımsız yazıldı. İki taraf ortak kod kullansaydı yanlış bir kaçış kuralı da mutlu mutlu round-trip
ederdi ve Splunk/QRadar yine okuyamazdı; bağımsız ayrıştırıcı sayesinde test gerçek kanıt oluyor.

**Her düzeltme geriye dönük kanıtlandı:** eski davranış tek tek geri konup testler koşuldu; hepsi
kırmızıya döndü (K1 → 5 test, K2/D1/D7/O4 → 8 test, O1 → 2, O2 → 2, O3 → 2, D2 → 1, D5 → 2).
Yeşile boyanan değil, gerçekten yakalayan testler.

## 3. Varsayımlar

1. **Kalıcılık yok, Prisma import edilmedi (bilerek).** Gerekçe: (a) zincir mantığı saf olduğu için
   binlerce senaryo çevrimdışı ve milisaniyelerde test edilebiliyor — denetim kanıtı testin kendisi;
   (b) aynı kurallar Postgres, dosya ve test-double için tek yerden geçerli; (c) `packages/db` şeması
   `AuditLog.seq`'i "assigned by packages/audit under a chain lock" diye tanımlıyor — bu paket o
   sözleşmeyi yazar, tabloyu değil; (d) Dalga 3 worker'ı gerçek kilit + Prisma deposunu enjekte edecek.
   `InMemoryAuditStore` üretim deposu değildir; test/seed/çevrimdışı demo içindir.
2. **`at` yalnız tek bir biçimde mühürlenir: `YYYY-MM-DDTHH:MM:SS.sssZ`** (O4 düzeltmesi).
   `AuditChain` zaten `toISOString()` ile normalize ediyordu; artık `sealEvent` de offset'li ya da
   milisaniyesiz bir damgayı **reddediyor** — yani `AuditChain` dışındaki üreticiler (db demo seed'i
   gibi) için de kural aynı. **Önceki raporun "offset'li kayıtlar da doğrulanabilir" cümlesi yanlıştı
   ve kaldırıldı:** `packages/db` şeması `Timestamptz(3)` olduğu için `…+03:00` ile hash'lenmiş bir
   kayıt veritabanından `…Z` olarak döner ve `hash_mismatch` verir. Sözleşme offset'e izin veriyor,
   depolama vermiyor; bu paket depolamanın tarafını tutuyor.
3. **Kanonik biçim fail-closed.** `meta.foo = undefined` sessizce düşürülmez, hata verir. Çağıranlar
   `undefined` alanları `meta`'ya koymadan önce ayıklamalı (ör. `JSON.parse(JSON.stringify(x))` değil,
   açıkça inşa ederek).
4. **Gate kararları yalnız insan aktörle kaydedilir** (`GATE_APPROVE`, `GATE_REJECT`). Gerekçe: M32 SoD
   ve M101'in "maestro-mcp'de kapı onay/ret aracı YOK" kuralı. `ai-via:<user>` bile reddedilir — onay
   yalnız insan kanalından gelir. `KILL_SWITCH` bilerek kısıtlanmadı (çift onaylı akış workflow'un işi,
   ayrıca otomatik tetikleme senaryosu açık kalsın diye).
   **Sınır (D6):** `humanOnly` kontrolü yalnızca **SÖZDİZİMSELDİR** — `parseActor` bir string'in
   `user@corp` kalıbına uyup uymadığına bakar, o hesabın gerçekten bir insana ait olup olmadığına
   değil. `maestro-svc@ugurbank.corp` gibi bir servis hesabı bu kapıdan "insan" olarak geçer.
   Gerçek SoD kapısı workflow'un **AD/Jira grup üyeliği** kontrolüdür (M32); bu paket son savunma
   hattıdır, tek savunma hattı değil.
5. **Anchor imzası HMAC-SHA256 (varsayılan).** `AnchorSigner` arayüz olduğu için kurumda KMS/HSM ya da
   asimetrik imza gelirse anchor mantığı değişmez. Anahtar `SecretPort`'tan çözülmeli (bu paket anahtar
   yönetimi yapmaz).
6. **Anchor'ın nereye yazılacağı çağıranın kararı** (spec gereği): StoragePort (M5/M57 Object Lock),
   dosya düşümü, SIEM. Bu paket üretir ve doğrular, yazmaz.
7. **Kayıtsız gün anchor'lanmaz** (`empty_day` hatası): head hareket etmediği için önceki anchor hâlâ
   zinciri kapsıyor. Kurum "her gün bir anchor" isterse bu kural gevşetilmeli — arayüz talebi değil,
   parametre kararı.
8. **CEF metinleri İngilizce.** SIEM içeriği operatör altyapısıdır, kullanıcıya dönük metin değil;
   M104 kataloğu uygulanmaz, M59 gereği İngilizce kalır. Studio'da audit satırı gösterilecekse
   görünen metin katalogdan gelmeli, `AUDIT_ACTION_INFO.name`'den değil.
9. **Syslog çerçevesi RFC 3164**, varsayılan facility 13 (log audit), zaman damgası kaydın kendi anı
   (UTC) — dosya yeniden oynatıldığında tarih değişmesin diye. CEF severity → syslog severity eşlemesi:
   `>=9 → 2 (crit)`, `>=7 → 3 (err)`, `>=4 → 4 (warning)`, aksi `6 (info)`.
10. **`rt` alanı epoch milisaniye** (ArcSight sözleşmesi), `externalId = seq`, `suser = actor`,
    `cs1 = subject`, `cs2 = hash`, `cs3 = prevHash`, `cs4 = delegatedBy` (yalnız `ai-via`),
    `cs5 = meta` (kanonik JSON, boşsa alan yok), `act`, `cat`, `outcome`, `msg`.
11. **Unicode normalizasyonu: `subject` NFC olmak ZORUNDA, `meta` serbest** (D7 kararı). Görünüşte
    aynı iki string (NFC/NFD) farklı hash üretir; bu zincir bütünlüğü için bir sorun değil (kayıt
    kendi byte'larına göre doğrulanır) ama denetim için sorundur: `"ödeme"` araması diğer biçimi
    bulamaz, tek bir biletin izi ikiye bölünür. `subject` denetimin arama anahtarı olduğu için tek
    biçime (NFC) sabitlendi — normalize edilerek değil, **reddedilerek**. `meta` içeriği serbest
    metin taşıyabildiği için normalize edilmiyor; kanonik biçim byte'ı byte'ına delil olarak kalıyor.

## 4. Bağımlılıklar

| Paket | Tür | Gerekçe |
|---|---|---|
| `@maestro/contracts` | runtime (workspace) | `AuditEvent`, `AuditAction`, `IsoDateTime`, `Sha256Hex`. |
| `zod` ^4 | runtime | Zaten monorepo standardı; anchor şeması + `AuditEvent.safeParse` ile fail-closed doğrulama. |
| `node:crypto` | runtime (yerleşik) | SHA-256 ve HMAC. |
| `@types/node`, `typescript`, `vitest` | dev | Paket sözleşmesi gereği. |

**Yeni harici runtime bağımlılığı YOK.** `@maestro/ports`'a bağımlılık da yok (aşağıdaki talep #1).

## 5. Arayüz/bağımlılık talepleri (contracts/ports DONMUŞ — burada yalnız kayıt)

1. **`AuditPort` (veya `AuditStore`) `packages/ports`'ta yok.** Depo arayüzü şu an `packages/audit`
   içinde (`src/store.ts`). Dalga 2-3'te worker/BFF bu arayüze yazacaksa `ports`'a taşınması daha
   doğru olur — **orkestratör kararı**. Taşınırsa bu paket sadece `implements` tarafını korur.
2. **`AuditAnchor` sözleşmesi contracts'ta yok.** Anchor Zod şeması bu pakette tanımlandı. Anchor
   Studio'da gösterilecek ya da BFF'ten dönecekse `packages/contracts/src/audit.ts` yanına taşınmalı.
   Önerilen şekil bu pakette hazır: `{version, day, createdAt, algorithm, firstSeq, lastSeq,
   eventCount, prevHash, headHash, chainDigest, signature:{alg,keyId,value}}`.
3. **`AuditEvent.meta` `z.record(z.string(), z.unknown())`** — `unknown` olduğu için sözleşme
   düzeyinde "hash'lenebilir" garantisi yok; garantiyi kanonik serileştirici veriyor (fail-closed).
   İsteğe bağlı iyileştirme: `meta` için JSON-değer tipi tanımlanması.
4. **`AuditEvent.seq` `number`, `db` şemasında `BigInt`.** 10 yıllık hacimde `Number.MAX_SAFE_INTEGER`
   aşılmaz (2^53 kayıt), ama `db` katmanı BigInt↔number dönüşümünü açıkça yapmalı — sessiz `Number()`
   dönüşümü v1 tarzı bir hata kaynağı olur. Bilgi amaçlı not.
5. **Kilit gerçeklemesi Dalga 3'e ait.** Worker `ChainLock`'u Postgres advisory lock ile (tek zincir
   için tek kilit anahtarı) uygulamalı; ayrıca `AuditLog.seq` PK + `hash`/`prevHash` unique index'leri
   ikinci savunma hattıdır (süreçler arası çatallanma).
6. **Anchor'ları kim saklarsa DİZİ olarak saklamalı** (O1'in çağıran tarafı). `verifyAnchorSeries`
   ancak günlerin tamamı elde olduğunda "bir gün silinmiş" diyebilir; tek tek anchor doğrulaması
   bunu yapısal olarak yapamaz. Dalga 2/3'te anchor'ı yazan iş, WORM hedefine **kesintisiz gün
   dizisi** yazmalı ve doğrulama ekranı `verifyAnchorSeries`'i çağırmalı — `verifyAnchor`'ı tek
   başına değil.

## 6. Bilerek eksik bırakılanlar

- **Kalıcı depo (Prisma) yok** — §3.1'deki gerekçe; Dalga 1 `db` + Dalga 3 worker birleştirecek.
- **Anchor'ın diske/S3'e yazılması yok** — spec gereği çağıranda (StoragePort/dosya).
- **Dosya düşümü / syslog soketi yok** — `toSyslogLine` satırı üretir; dosyaya yazan ya da UDP/TCP'ye
  gönderen taşıyıcı (M33 "dosya düşümü") Dalga 2 `notify`/deploy tarafının işi. Bu paket saf mantık.
- **Kanıt paketi (evidence) üretimi yok** — ayrı sözleşme (`contracts/evidence.ts`), ayrı paket.
- **Retention silme işi yok** — `retentionExpiryOf` tarihi hesaplar; yaşam döngüsü kuralını uygulayan
  StoragePort/arşiv işi (M56) başka pakette.
- **CEF parser üretimde yok** — yalnız testte (bağımsız kanıt için). SIEM tarafı okur, biz yazarız;
  üretimde çağrılmayan bir parser ölü yol olurdu.
- **`InMemoryAuditStore.snapshot()` SİLİNDİ** (D4): hiçbir yerden çağrılmıyordu, `read()` aynı işi
  yapıyor. Referans depoda ölü yol bırakmanın bedeli, o yolun hiç test edilmemesidir.
- **`humanBehind` / `isHumanActor` bilerek DURUYOR — tüketicisi Dalga 3** (D4). İkisi de M32 SoD
  kapısının ihtiyacı: `humanBehind("ai-via:po.demir@ugurbank.corp")` delegasyonun ARKASINDAKİ insanı
  verir, `isHumanActor` aynı string için `false` döner. "Üreten ≠ onaylayan ≠ merge eden" kontrolünü
  yapan workflow, bir AI'ın kullanıcı token'ıyla yazdığı kaydı o kullanıcıya saymak zorunda (M101);
  bu ayrımı her çağıranın kendi başına yeniden yazması, v1'in kayan-kural hastalığının ta kendisi
  olurdu. `actor.test.ts` ikisinin de semantiğini sabitliyor. Dalga 3'te SoD kapısı bunları
  çağırmazsa, o zaman silinmeleri gerekir.

## 7. Doğrulama

```
pnpm install                       # ✓
pnpm -F @maestro/audit typecheck   # ✓
pnpm -F @maestro/audit test        # ✓ 11 dosya / 109 test
pnpm -F @maestro/db test           # ✓ 13 dosya / 162 test (demo seed zinciri bu paketi kullanıyor)
pnpm lint                          # ✓ (kök eslint)
pnpm typecheck                     # ✓ (kök turbo)
pnpm test                          # ✓ (kök turbo, 24 görev)
```

## 8. Bağımsız doğrulama bulgularının kapatılması (2. tur)

| Bulgu | Ne yapıldı | Kanıtlayan test |
|---|---|---|
| **K1** — `AuditChain.verify()` kurbanın kendi beyanına güveniyor (fail-open) | `verify()` beklentiyi artık kayıtlardan türetmiyor. Aralıksız/`fromSeq<=1` çağrıda **daima** `expectFirstSeq: 1` + `expectPrevHash: GENESIS`. `fromSeq > 1` ise `expectPrevHash` (imzalı anchor'ın `headHash`'i) **zorunlu**; verilmezse `AuditChainError("unanchored_slice")` ile reddediliyor, "yumuşatılmış" bir doğrulama yok. Genesis'ten başlayan bir doğrulamaya genesis dışı beklenti verilirse de reddediliyor. | `chain-verify.test.ts` (9 test, hepsi **`AuditChain.verify()` üzerinden** — saf `verifyChain` üzerinden değil): ilk kayıtları silme · boş tablo · sahte genesis'ten yeniden mühürleme · beklentisiz dilim reddi · anchor `headHash`'i ile dilim kabulü |
| **K2** — `subject` kırpılmadan hash'lenip kırpılarak saklanıyor | İki katmanlı: (a) `sealEvent` artık sözleşme şemasının **çıktısını** hash'liyor (`AuditEvent.omit({hash:true}).parse` → `computeEventHash`), (b) `assertSubject` `actor` ile aynı fail-closed disiplini uyguluyor — kırpılmamış değer **dönüştürülmüyor, reddediliyor**. Mühür sonunda `rehash(event) === event.hash` kendi kendini denetimi var: bu paket kendi doğrulamasından geçmeyen bir kayıt üretemez. | `fields.test.ts` "refuses a subject with trailing or leading whitespace" · "never seals a record that fails its own verification" · "refuses the same value through the whole append path" · "would have poisoned a whole day's anchor — now the day still signs" |
| **O1** — Anchor'lar birbirine zincirlenmiyor | Yeni `src/anchor-series.ts` → `verifyAnchorSeries(anchors, signer, start?)`: gün sırası · `prevHash === öncekiHeadHash` · `firstSeq === öncekiLastSeq + 1` · `eventCount === lastSeq - firstSeq + 1` · her anchor'ın imzası. Dizi varsayılan olarak genesis'ten başlamalı. | `anchor-series.test.ts` "catches a WHOLE DAY deleted, which each anchor alone reports as fine (O1)" (+ 6 test) |
| **O2** — `buildAnchor` kendine referanslı beklenti kullanıyor | `expectPrevHash` **zorunlu parametre**; devam anchor'ında `expectFirstSeq` de zorunlu (`missing_expectation`). Anchor gövdesindeki `firstSeq`/`prevHash` artık kayıttan değil, doğrulanmış beklentiden yazılıyor. | `anchor.test.ts` "refuses to sign a day whose first records were deleted (O2)" · "refuses to continue a previous anchor without being told where it ended (O2)" |
| **O3** — `verifyChain([])` → `ok:true` | Boş girdi artık `empty` bulgusu üretiyor → `ok:false`, `checked:0`, `headHash:null`. `ok` hesabı değişmeden (`issues.length === 0`) korunduğu için "ok:false ama bulgu yok" gibi bir ara durum oluşmuyor. | `verify.test.ts` "refuses an empty input — emptiness proves nothing (O3)" · `chain-verify.test.ts` "REFUSES an emptied table…" |
| **O4** — RAPOR varsayım #2'nin offset güvencesi yanlıştı | Güvence **kaldırıldı ve düzeltildi** (§3.2) + `sealEvent` offset'li/milisaniyesiz `at`'i `AuditChain` dışında da reddediyor (`assertUtcInstant`). | `fields.test.ts` "refuses an offset-bearing instant" · "refuses a UTC instant without millisecond precision" |
| **D1** — `subject` uzunluk sınırı yok | `SUBJECT_MAX_LENGTH = 128` (db `VarChar(128)`); 129 karakter mühürlenmiyor. | `fields.test.ts` "refuses a subject longer than the column that stores it" |
| **D2** — `InMemoryAuditStore` `prevHash` tekliğini uygulamıyor | `prevHashes` kümesi eklendi → `prev_hash_conflict`. Referans depo artık gerçek depodan zayıf değil; en fazla bir genesis satırı var. | `chain.test.ts` "rejects a second record claiming the same predecessor — the DB's prevHash index (D2)" |
| **D3** — gevşek assertion (`toBeLessThan(10)`) | Gerçek değer sabitlendi: **tam olarak 1 kayıt yazılıyor, 9 yazım reddediliyor**. | `chain.test.ts` "proves the lock is what prevents the fork…" |
| **D4** — ölü yol | `InMemoryAuditStore.snapshot()` **silindi**. `humanBehind`/`isHumanActor` gerekçesiyle bırakıldı (§6, Dalga 3 SoD/M32 tüketicisi + silme koşulu yazılı). | `actor.test.ts` (semantik sabitleniyor) |
| **D5** — `schema_invalid` sonrası bağ denetimi atlanıyor | Okunamayan kaydın `seq`/`hash`'i en iyi çabayla kurtarılıyor; ardındaki kayıtlar denetlenmeye devam ediyor. `hash` okunamıyorsa bağ denetimi sessizce **geçilmiyor**, yapılmıyor — kayıt zaten `ok:false` yapmış oluyor. | `verify.test.ts` "keeps checking the record that FOLLOWS an unreadable one (D5)" · "reports the gap when records are deleted right after an unreadable one (D5)" |
| **D6** — `humanOnly` yalnız sözdizimsel | §3.4'e sınır notu yazıldı: `maestro-svc@ugurbank.corp` bu kapıdan geçer; gerçek SoD kapısı workflow'un grup üyeliği kontrolüdür (M32). | — (rapor notu) |
| **D7** — Unicode normalizasyonu yok | **Karar: `subject` NFC zorunlu (reddederek, normalize etmeden), `meta` serbest.** Gerekçe §3.11'de. | `fields.test.ts` "refuses a subject that is not Unicode NFC" |

**Geriye dönük kanıt:** her düzeltme için eski davranış tek tek geri kondu ve ilgili testler koşuldu;
hepsi kırmızıya döndü. Testler düzeltmeyi gerçekten yakalıyor, düzeltmeyle birlikte yazılmış süs değil.

**`packages/db` uyumu:** `db`'nin demo seed zinciri `sealEvent`/`GENESIS`/`assertActor` kullanıyor.
Yeni fail-closed kapılar seed'i kırmadı (subject'ler kırpılmış, ≤128, NFC; `at` `toISOString()`);
`pnpm -F @maestro/db test` → 162 test yeşil. `db` tarafında değişiklik gerekmedi.
