# RAPOR — `@maestro/memory` (Dalga 2)

Ajanın bağlamının hiçbir koşulda kaybolmamasını sağlayan katman: append-only ticket
defteri, defterden türetilen yaşayan özet, oturum yeniden açılışında verilen bootstrap
paketi, şifreli Agent SDK oturum dosyaları ve M65 arşiv kararı.

> **Tur 2 (doğrulama sonrası).** Bağımsız doğrulayıcının 4 bloke + 11 ikincil bulgusu
> kapatıldı; kapatma biçimleri ve davranış değişiklikleri §"Doğrulama bulguları"nda
> tek tek yazılı. Her düzeltme önce kırılan bir testle yazıldı.

## Ne yazıldı

| Dosya | İş |
|---|---|
| `src/journal.ts` | `appendJournal` — tek yazma API'si; `seq = max+1`, çakışmada sırayı yürüterek + jitter'lı geri çekilmeyle yeniden dene; aynı süreçte (store, runId) başına yazma zinciri |
| `src/store-db.ts` | `journalStoreFromDb` — `@maestro/db`'nin `AppendOnlyDb["journalEntry"]` yüzeyi; izinli üç metodun **anlık kopyası** alınır, delegenin gerisi erişilemez |
| `src/types.ts` | `JournalStore` portu (yalnız `maxSeq`/`insert`/`list`), `JournalDraft`, enjekte `Clock` |
| `src/masking.ts` | M82 sınırı: `createJournalMasker` — `prepare` (maskele) + `seal` (doğrula + `assertNoPii`); `Journaled<T>` markası bu modül dışında basılamaz |
| `src/summary.ts` | `buildLivingSummary` — **deterministik**, ≤8000 karakter; azaltma merdiveni + kapı kararlarına ayrılmış bütçe |
| `src/enrich.ts` | `enrichLivingSummary` — opsiyonel LLM kancası, varsayılan kapalı, yalnız **ekler** |
| `src/blocks.ts` | Bütçeli metin kurgusu: bölüm başına değer/uç/atlama notu; en ucuz bölüm önce yer verir, garantili bölümler hiç vermez |
| `src/summary-format.ts` | satır biçimleyiciler (tek satıra indirgeme, kırpma, kanonik UTC damgası, kind sayımları) |
| `src/bootstrap.ts` | `buildBootstrapPackage` — garantili bölümler (durum satırları + açık retler + SoD şüphelileri + `protected_paths`) önce ve bütçe dışı; özet ve diff kalan yeri paylaşır |
| `src/rejections.ts` | `reviewGateDecisions` — `step\|actorGroup` bazlı açık ret hesabı, SoD'suz onay kapatmaz, eşitlikte ret kazanır |
| `src/protected-paths.ts` | M52 deny-list eşleştirici (`**`, `*`, `?`, dizin ve joker'siz desenler) + M52 varsayılanları |
| `src/session.ts` | Oturum dosyası arşivi: `saveSessionFile`/`loadSessionFile`/`tryLoadSessionFile`/`listSessionKeys` (yıl aralığı), anahtar = storage'ın `archiveKey`'i |
| `src/crypto.ts` | AES-256-GCM mühürleme (M31), **arşiv anahtarına bağlı** (format v2); anahtar enjekte, rastgelelik dışa kapalı |
| `src/archive.ts` | `decideWorkspaceArchive` — 60 gün hareketsizlik kararı (saf), `latestActivityAt(runId, …)`, `idleDaysBetween` |

Üretim kodu: **1978 ham satır**, 16 dosya, en büyük dosya 286 satır (sınır 300).

## Kritik tasarım kararları

1. **Silme/güncelleme yok — hiçbir katmanda.** `JournalStore` portunun kendisi yalnız
   `maxSeq`/`insert`/`list` adlarını taşıyor. `journalStoreFromDb` yapısal tipleme
   nedeniyle daha geniş bir istemci **alabilir**, ama aldığında bile yalnız üç metodun
   kopyasını saklar; `update`/`delete` ne tipte ne çalışma zamanında erişilebilir.
   Testler paketin dışa açık adlarında `update*/delete*/remove*` olmadığını da doğruluyor.
2. **Seq boşluksuzluğu PK ile garanti.** `max(seq)+1` oku-yaz, çakışmada yeniden dene.
   Bir seq ancak satırı commit olduğunda var olur, sonraki yazan o commit'i okur →
   ne çift kayıt ne boşluk. Çakışma bilgi taşır: takılan seq commit edilmiştir, o yüzden
   yeniden okumadan bir sonraki aday denenir; birkaç çakışmada bir depoyla senkronize
   olunur ve arada üstel + jitter'lı bekleme yapılır (kilitlenmiş adımı kırmak için).
   Testler: tek tabloya 40 eşzamanlı yazım (iki süreç) ve **20 bağımsız store ile 20/20**.
3. **Özet deterministik ve bütçesi bölümlere paylaştırılmış.** Aynı defter → bit bit aynı
   metin. Azaltma merdiveni ilk sığan seviyede durur. **Kapı kararları bütçenin ayrılmış
   %50'sini alır** ve hiçbir seviyede başka bölüm uğruna kırpılmaz; basılamayan kapı
   sayısı her zaman `(N earlier gate decisions omitted)` ile yazılır. Merdivenin en dar
   seviyesi bile sığmazsa bölümler **en ucuzdan** yer verir (önce sıkıştırılmış eski
   kayıt, sonra "recent"in en eskisi); kör kuyruk kırpması artık son çare.
4. **"Açık bulgu" tanımı.** `JournalEntry` DONUK ve durum alanı yok; bu yüzden çözülmüşlük
   metinden tahmin edilmiyor. Kural: `scan/review/test_review/ci/pii/quota/handover`
   kind'leri **durum niteliğinde**dir, en yenisi geçerlidir. Bu, donmuş sözleşmenin
   üstüne protokol uydurmadan verilebilecek tek dürüst yorum (bkz. Talepler #1).
5. **LLM bağımsızlığı.** Zenginleştirme yalnız **ekler** (`## notes (model)` bölümü);
   deterministik bölümler modelden önce yazılır. Enricher varsa masker zorunlu (M82).
6. **Bir masker = bir maskeleme oturumu.** Oturum masker'ın ömrü boyunca yaşar; bu yüzden
   `[EMAIL_1.<nonce>]` o masker'ın yazdığı her kayıtta aynı kişidir ve zaten maskelenmiş
   bir metni yeniden maskelemek **etkisizdir**. ReverseMap kapanışın içinde kalır, deftere
   veya özete asla girmez (M20). İki farklı masker token paylaşmaz (nonce farklı) — 10 yıllık
   kayıtta kalıcı, evrensel bir numaralandırma yeniden-tanımlama indeksi olurdu.
   Bunun doğal sonucu: **birleştirilmiş metin bir daha maskelenmez.** Başka oturumun
   token'ları yeniden maskelenirse parantezleri sıyrılır (`[EMAIL_1.x]` → `EMAIL_1.x`)
   ve okuyucu orada bir şey kaldırıldığını göremez. Bootstrap yalnız çağıranın verdiği
   alanları maskeler, bütünü `assertClean` ile denetler (fail-closed).
7. **M65 bağlam kaybı yok.** Test artık totolojik değil: defter `appendJournal` ile yazılıp
   **store'dan geri okunuyor**, yeni bir masker ve diskte hiçbir şey yokken bootstrap
   üretiliyor; özet/ret gerekçesi/korumalı yol uyarısı/son diff metinde bire bir doğrulanıyor.
8. **Şifreleme fail-closed ve anahtara bağlı.** GCM kimlik doğrulamalı; ek olarak mühür
   yazıldığı **storage anahtarına** bağlı (AAD). Bozulmuş ya da başka bir ticket'ın anahtarına
   kopyalanmış oturum dosyası "yeni oturum"a düşmez, `SessionCryptoError` fırlatır.
   Yokluk (`ObjectNotFound`) normal durumdur ve `tryLoadSessionFile` `null` döner.

## Doğrulama bulguları — ne yapıldı

| Bulgu | Durum | Kapatma |
|---|---|---|
| **Y-1** oturum mührü hedefe bağlı değil | Kapatıldı | AAD = `header ‖ len(key) ‖ archiveKey`; format sürümü **2** (v1 açılmaz). `seal/openSessionBytes` artık bağlanacak anahtarı parametre alır; `saveSessionFile` yazdığı anahtarı, `load/tryLoad` okuduğu anahtarı geçirir. Test: 1111'in dosyası 2222'nin adına kopyalandığında açılmıyor; yıl değişse de açılmıyor |
| **Y-2** 8'den fazla yazıcıda kayıt düşüyor | Kapatıldı | Varsayılan bütçe 8 → **32**; çakışmada seq yerel olarak yürütülüyor, 3 çakışmada bir depoyla senkron + üstel/jitter'lı `wait` (enjekte edilebilir, testler anlık). Wiring sözleşmesi koda yazıldı: **süreç başına TEK store**. Test: 20 bağımsız store → 20/20, çakışma sayacı > 0 |
| **Y-3** M52 uyarısı metnin sonunda ve kırpılıyor | Kapatıldı | Bölüm sırası: durum satırları → açık retler → SoD şüphelileri → **korumalı yollar** (hepsi garantili, bütçe dışı) → yaşayan özet → diff. Ret gerekçeleri alan bazlı 500 karaktere, diff notu 500'e kırpılıyor. Test: 40.000 karakterlik tek gerekçe ile uyarı metinde |
| **Y-4** açık ret kapatma kuralı | Kapatıldı | `latest` haritası `step\|actorGroup` ile anahtarlı; `sodVerified:false` **onay** hiçbir şeyi kapatmıyor ve ayrı `suspectDecisions` listesine + metne yazılıyor; `signatureSeq`+`at` eşitliğinde **ret kazanıyor**. (SoD'suz *ret* akışı durdurmaya devam eder: durdurmak yetki istemez) |
| **O-5** kapı kararları dar bütçede kayboluyor | Kapatıldı | Kapı satırlarına bütçenin %50'si ayrıldı; merdiven artık kapı sayısını sınırlamıyor. 1200 karakterde 6 yerine 10, 2000'de 6 yerine 17 kapı satırı; bütçenin %70'inden azı boş kalmıyor. Testler her seviyede koşuyor |
| **O-6** `latestActivityAt` `max(seq)` kullanıyor | Kapatıldı | `max(Date.parse(at))`, eşitlikte yüksek seq |
| **O-7** yabancı run kaydı sessizce kabul | Kapatıldı | `latestActivityAt(runId, entries)`; yabancı kayıt `MemoryArgumentError` |
| **O-8** `at` DB gidiş-dönüşünde değişiyor | Kapatıldı | `utcInstant` ile tüm damgalar kanonik UTC; özet/bootstrap DB round-trip'inden sonra bit bit aynı |
| **O-9** birleştirilmiş metin yeniden maskeleniyor | Kapatıldı | Bootstrap artık bütünü maskelemiyor; alanlar tek tek maskeli, bütün `assertClean` ile denetleniyor. Test: başka oturumun token'ı parantezleriyle korunuyor |
| **O-10** enjekte `RandomSource` public | Kapatıldı | `nodeRandom`/`RandomSource` paket index'inden çıkarıldı; `SessionArchiveDeps.random` kaldırıldı; test tohumu `sealSessionBytesWith` yalnız modül içi. Test: index'te bu adlar yok |
| **O-11** 10'dan fazla açık ret sessizce düşüyor | Kapatıldı | `(N earlier open rejections omitted)` |
| **D-12** `sessionKey` yılı `now`'dan | Kapatıldı | Anahtar `lastActivityAt`'ten türetiliyor (= `saveSessionFile`'ın yazacağı anahtar) + `listSessionKeys(storage, ticket, fromYear, throughYear)` yıl aralığı tarıyor |
| **D-13** tam Prisma delegesi kabul ediliyor | Kapatıldı (iddia da düzeltildi) | Yapısal tiplemede geniş nesne **atanabilir**; artık store yalnız üç metodun bağlı kopyasını tutuyor, sonradan eklenen/değiştirilen metotlar erişilemez. Test bunu kanıtlıyor |
| **D-14** küçük bütçede en yeni olaylar kesiliyor | Kapatıldı | Bölümler uç seçiyor (`head`/`tail`); son çare kırpma yerine en ucuz bölümden satır bırakma. Test: 450/600/900 bütçede `#59` metinde |
| **D-15** oturum dosyası sessizce üzerine yazılıyor | Kapatıldı (opsiyon + belge) | `SessionArchiveDeps.objectLock` → `StoragePort.put(..., { objectLock: true })` (M5/M57). Varsayılan kapalı, çünkü her sürücü desteklemiyor; anahtar `(yıl, ticket, run)` olduğu için üzerine yazma ancak aynı run'ın ikinci arşivlenmesinde olur |

### Test kalitesi bulguları
1. **M65 testi totolojikti** → yeniden yazıldı: defter `appendJournal` ile yazılıp store'dan
   geri okunuyor, bootstrap yalnız kayıttan üretiliyor (yukarıda madde 7).
2. **Kapı korunumu yalnız sınırsız bütçede test ediliyordu** → 6 farklı bütçede koşuyor,
   ayrıca "basılan + atlanan = 30" muhasebesi her seviyede doğrulanıyor.
3. **`masking.test.ts` adının tersini doğruluyordu** (`.not.toThrow()`) → artık ham PII ile
   `PiiLeakError` bekliyor; tip düzeyindeki ret `@ts-expect-error` ile aynı testte.

## Test özeti

`pnpm -F @maestro/memory test` → **12 dosya / 132 test, hepsi yeşil.** Tamamen çevrimdışı;
saat, depo, rastgelelik ve defter deposu enjekte.

| Dosya | Test | Kapsam |
|---|---|---|
| `journal.test.ts` | 15 | seq üretimi, tek/çok süreç eşzamanlılık, **20 bağımsız yazıcı**, backoff, retry bütçesi, maskeleme, mutasyon API'si olmadığının kanıtı |
| `crypto.test.ts` | 17 | round-trip, **anahtar bağı (Y-1)**, format v2, yanlış anahtar, kurcalama, IV tazeliği, public yüzeyde rastgelelik olmaması |
| `archive.test.ts` | 16 | 59/60 gün eşiği, **zaman bazlı son aktivite**, yabancı run reddi, yıl sınırı, saflık |
| `summary.test.ts` | 15 | determinizm, 8000 sınırı, **daralan bütçede kapı kararları**, D-14, O-8 |
| `session.test.ts` | 14 | anahtar düzeni, şifreli saklama, **kopyalanan dosyanın reddi**, Object Lock, yıl aralığı |
| `store-db.test.ts` | 10 | delegeye giden argümanlar, P2002/23505 → `SeqTakenError`, **daraltmanın kanıtı**, uçtan uca append |
| `masking.test.ts` | 9 | marka, çalışma zamanı tripwire, **tek oturum ömrü**, sınıf geri düşüşü, sayaç kancası |
| `protected-paths.test.ts` | 9 | glob semantiği, regex kaçışı, M52 varsayılanları |
| `bootstrap-budget.test.ts` | 8 | Y-3 bütçe, O-11 atlama notu, O-9 token korunumu, SoD bölümü |
| `bootstrap.test.ts` | 7 | **M65 kayıttan yeniden inşa**, M52 uyarısı, diff özeti, maskeleme |
| `rejections.test.ts` | 7 | Y-4'ün üç yolu (grup, SoD, eşitlik), imzalı sıra, gerekçe maskeleme |
| `enrich.test.ts` | 5 | ekleme, maskeleme, model hatasında düşüş, bütçe |

Kök kapı: `pnpm run gate` (lint + 13 paket typecheck + 38 test görevi) ✅.

## Varsayımlar

- Defterdeki `at` alanı çağıranın saatinden gelir; **özet ve bootstrap damgaları kanonik
  UTC yazar** (yerelleştirme M104'ün işi, hafızanınki değil).
- Bootstrap metni 16000 karakterle sınırlı; garantili bölümler bu bütçenin dışındadır,
  yani patolojik bir girdide metin garantili bölümler kadar uzayabilir (ve orada kırpılır).
- `LivingSummary` sözleşme gereği 8000; bootstrap içindeki özet, garantili bölümlerden
  artan yerin %75'ini alır (diff yoksa %95), en az 400 karakter.
- Oturum dosyası içerik anahtarı 32 bayt ve dışarıdan gelir; bu paket anahtar üretmez,
  saklamaz, türetmez.

## Talepler (orkestratör kararı)

1. **`contracts.JournalEntry`'de bulgu durumu yok.** "Açık bulgu" şu an "aynı kind'in en
   yenisi" kuralıyla türetiliyor. Gerçek ret/çözüm zinciri isteniyorsa `resolvesSeq?: number`
   veya `status?: "open"|"closed"` alanı gerekir — contracts DONUK olduğu için dokunulmadı.
2. **Oturum anahtarı adı/rotasyonu (M80).** Wiring dalgası için `SecretPort` anahtar adı
   standardı gerekli (ör. `memory/session-content-key`). Rotasyon istenirse mühür formatına
   key-id eklenmeli → format sürümü 3 (şu an v2).
3. **Arşiv anahtarı nerede saklanacak?** Akış, `decideWorkspaceArchive`'ın döndürdüğü
   `sessionKey`'i DB'ye yazmalı; yazmazsa dönüşte `listSessionKeys(ticket, yıl, yıl+1)`
   ile taranır (fallback olarak var, artık yıl sınırını aşıyor).
4. **Eşikler M71'e taşınmalı:** `maxIdleDays` (60), `recentCount` (12), `lineChars` (200),
   `maxAttempts` (32). Paket bunları opsiyon olarak alıyor.
5. **`@maestro/db` bağımlılığı runtime'dır** (`toJournalEntry` için). İstenirse `store-db.ts`
   ayrı bir alt-export'a (`@maestro/memory/db`) çekilebilir — tek satırlık package.json değişikliği.
6. **`protectedPathHits`** bootstrap dışında da (M52 kapısı, Dalga 3) kullanılmak üzere
   dışa açıldı; bu paket içinde yalnız testleri var — kasıtlı, ölü yol değil.
7. **Wiring sözleşmesi (yeni):** süreç başına TEK `JournalStore`; `appendJournal`'a
   `wait` geçilmez (üretimde `setTimeout`); `saveSessionFile`/`loadSessionFile` aynı
   `archiveKey` ile çağrılır — mühür o anahtara bağlıdır.
