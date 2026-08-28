# `@maestro/pii` — Dalga 1 paket raporu (düzeltme turu 1)

**Durum:** YEŞİL. `pnpm install` · `pnpm -F @maestro/pii typecheck` · `pnpm -F @maestro/pii test`
(14 dosya / **152 test**) · kökten `pnpm lint` + `pnpm typecheck` + `pnpm test` (24 görev, 1216 test)
— hepsi temiz.
**Dal:** `wave1-pii-fixround` (güncel main üzerine rebase edildi; kendi worktree'sinde; main'e merge edilmedi).
**Bu tur:** bağımsız doğrulayıcının BLOKE bulguları (B-1…B-13, B-18) kapatıldı; raporun
**iki manşet iddiası geri alındı** (§2). 1636 satır üretim kodu (tavan 1200'ü aştı — gerekçe §5),
en büyük dosya 279 satır (tavan 300), 1548 satır test.

## 0. Doğrulayıcı bulgularının durumu

| # | Bulgu | Durum | Nerede kapandı | Kırılan regresyon testi |
|---|---|---|---|---|
| B-1 | TCKN ayraç kabul etmiyor (`TC: 123 456 789 50` ham gidiyor) | **KAPANDI** | `detectors/tckn.ts` + `detectors/separators.ts` | `spellings.test.ts` (5) |
| B-2 | IBAN büyük/küçük harf duyarlı; `.toLowerCase()` maskelemeyi kapatıyor | **KAPANDI** | `detectors/iban.ts` | `spellings.test.ts` (3) |
| B-3 | Ayraç kümesi dar: NBSP/TAB/nokta/çift boşluk | **KAPANDI** | `separators.ts` (`\p{Zs}\t.-`), iban+card | `spellings.test.ts` (9) |
| B-4 | "İki bağımsız katman" iddiası yanlış | **GERİ ALINDI + kısmen giderildi** | §2 yeniden yazıldı; tuzak teli artık anahtarları da tarıyor | `egress-gate.test.ts` (3) |
| B-5 | "Ham yükü geçirmek derlenmez" beş yoldan yanlış | **KAPANDI** | `masked.ts` (nominal zarf) | `egress-gate.test.ts` (3) + `@ts-expect-error` |
| B-6 | Profil düşürme fail-open; `guardEgress` sınıfı kendi çözüyor | **KAPANDI** | `policy.ts` monotonluk + `guardEgress(profile)` | `policy.test.ts` (4), `egress-gate.test.ts` (2) |
| B-7 | `PiiBoundaryOptions.policy` markasız, politika mutasyona açık | **KAPANDI** | `LoadedPiiPolicy` + `Object.freeze` | `policy.test.ts` (3, biri `@ts-expect-error`) |
| B-8 | Yanlış oturum haritası **başkasının kimliğini** dönüyor | **KAPANDI** | jetona oturum nonce'u (`[TCKN_1.a3f9]`) | `session-scope.test.ts` (3) |
| B-9 | Kullanıcı metnindeki jeton enjeksiyonu | **KAPANDI** | nonce + maskelemede yabancı jetonların kaçırılması | `session-scope.test.ts` (4) |
| B-10 | `maskOutbound`'daki tuzak telinin kendi testi yok | **KAPANDI** | `assertNoPii` artık nesne **anahtarlarını** da tarıyor | `egress-gate.test.ts` (3) |
| B-11 | Dönüş yolu denetlenmiyor (10 yıl saklanacak kayıt) | **KAPANDI** | `withPiiBoundary` cevabı da maskeliyor | `egress-gate.test.ts` (2) |
| B-12 | `PiiBoundaryResult.output` markasız, tek log satırı zehirliyor | **KAPANDI** | `result.ts` — `#output` + `reveal()` + `toJSON()` | `egress-gate.test.ts` (1), `boundary.test.ts` (1) |
| B-13 | Unicode e-posta sızıntısı | **KAPANDI** | `detectors/email.ts` (`\p{L}\p{N}` + `u`) | `spellings.test.ts` (4) |
| `fellBack` ölü yolu | Üretiliyor, tüketilmiyor | **KAPANDI** | `MaskedInfo.fellBack` → `onMasked` + `PiiBoundaryResult.fellBack` | `egress-gate.test.ts` (2) |
| B-18 | Operatör regex'i ReDoS'a açık | **KAPANDI** | `regex-safety.ts`, yükleme anında ret | `policy.test.ts` (6) |
| B-14/B-15 | base64 / HTML-entity / sıfır-genişlik / fullwidth gömülü PII | **BİLİNEN SINIR** | — | §7'ye yazıldı |
| Checksum katılığı | Tek hane yanlış girilmiş gerçek TCKN maskelenmiyor | **KABUL EDİLMİŞ RİSK** | — | §7, uyum ekibi imzası bekliyor |

## 1. Ne yapıldı

Maskeleme çekirdeği + ReverseMap + **atlanamaz sınır geçidi** (M20).

| Dosya | İş |
|---|---|
| `src/types.ts` | Tip/şema tanımları, **jeton dilbilgisi** (`[TCKN_1.a3f9]`), profil ve politika Zod şemaları |
| `src/errors.ts` | `PiiPolicyError` · `PiiArgumentError` · `PiiSessionError` · `PiiLeakError` · `PiiReverseMapLeakError` |
| `src/detectors/separators.ts` | **YENİ** — tek bir kimliğin içinde geçen ayraç sınıfı (`\p{Zs}`, TAB, nokta, tire) |
| `src/detectors/tckn.ts` | 11 hane + iki basamaklı checksum + **ayraçlı yazımlar** |
| `src/detectors/iban.ts` | ISO 13616 mod-97 + TR uzunluk kuralı + **harf duyarsız** + geniş ayraç |
| `src/detectors/card.ts` | 13-19 hane + Luhn + geniş ayraç |
| `src/detectors/phone.ts` | TR numara planı (+90/0090/0/gruplu/çıplak mobil) |
| `src/detectors/email.ts` | Unicode yerel kısım + noktalı alan adı |
| `src/detectors/account.ts` | Müşteri/hesap no — yapılandırılabilir desen, yükleme anında **ReDoS denetimiyle** derlenir |
| `src/regex-safety.ts` | **YENİ** — operatör deseninde iç içe sınırsız niceleyici + uzunluk denetimi (B-18) |
| `src/reverse-map.ts` | Jeton↔değer, **oturum nonce'lu**, serileştirilemez |
| `src/policy.ts` | `LoadedPiiPolicy` (markalı + donmuş), monotonluk, dataClass→profil çözümü, `compiledProfileFor` |
| `src/counts.ts` | Denetim sayaçları + `toAuditMeta` (M33 `PII_MASKED`) |
| `src/mask.ts` | Metin/nesne maskeleme, geri alma, yabancı jeton kaçırma, **anahtar tarayan** `assertNoPii` |
| `src/masked.ts` | **YENİ** — `Masked<T>` nominal zarf (özel alanlı sınıf) |
| `src/result.ts` | **YENİ** — `PiiBoundaryResult`; gerçek değerler `#output`'ta, `reveal()` ile alınır |
| `src/boundary.ts` | `withPiiBoundary` · `maskOutbound`/`unmaskInbound` · `guardEgress` |

### Jeton üretimi
`[TCKN_1.a3f9]` — okunur prefiks, oturum içi sıra numarası, **oturum nonce'u**.
Kimlik normalleştirilmiş değere bağlı: `TR33 0006…` ile `tr330006…` ile `TR33.0006…` aynı jetonu
alır, `Ali@X.com` ile `ali@x.com` aynı kişidir, `123 456 789 50` ile `12345678950` aynı TCKN'dir.
`unmask()` ilk görülen yazımı geri koyar. Jetonun içinde değerin hash'i **yok**.

**Nonce ne işe yarar:** jeton, onu üreten oturumun dışında bir şey ifade etmez. Öncesinde iki
oturum da `[TCKN_1]` üretiyordu; B oturumunun haritasıyla A oturumunun metni açıldığında
**yanlış kişinin kimliği** hatasızca dönüyordu (B-8). Nonce ayrıca kullanıcı metnine yazılmış
`[TCKN_1]` dizgesini gerçek jetondan ayırıyor (B-9); maskeleme sırasında bu oturumun üretmediği
her jeton-biçimli dizgenin köşeli parantezi sökülür (`[TCKN_1]` → `TCKN_1`), böylece `unmask`
sonradan onu dolduramaz. Nonce bir sır değildir ve hiçbir şeyi tanımlamaz — tek işi iki oturumun
jeton sözlüğünü ayrık tutmaktır.

### ReverseMap (M20)
Değerler `#private` alanlarda; sınıfın hiçbir numaralandırılabilir özelliği yok.
`JSON.stringify(map)` → `PiiReverseMapLeakError`; `Object.keys(map)` → `[]`;
`String(map)` → `ReverseMap(size=2)`. Üretmediği jetonu **dokunmadan bırakır**.
`withPiiBoundary` map'i kendi çağrı çerçevesinde yaratıp bırakır.

## 2. v1 hatasının panzehiri — **düzeltilmiş iddia**

> **Geri alınan iddia 1.** Önceki rapor "ham yükü geçirmek **derlenmez**" diyordu. Bu yanlıştı ve
> doğrulayıcı `tsc` ile kanıtladı: `Masked<T> = T & {marka}` kesişimini `JSON.parse(...)`,
> bir webhook gövdesi, `res.json()`, bir Prisma `Json` kolonu (hepsi `any`) ve tek bir `as`
> aşıyordu; **spread markayı koruyordu**; `Masked<any>` düpedüz `any`'ye çöküyordu.
>
> **Geri alınan iddia 2.** Önceki rapor "aynı hata **iki bağımsız katmanda** imkânsızlaştırıldı"
> diyordu. Katmanlar bağımsız değil: `assertNoPii` → `scanForPii` → `maskValue` **aynı
> dedektörleri** kullanır. Tuzak teli, maskeleyicinin göremediğini göremez.

Bugünkü doğru ifade — üç ayrı mekanizma, her biri sınırlı ve sınırı yazılı:

1. **Nominal zarf (derleme + çalışma zamanı).** `Masked<T>` artık özel alanlı bir sınıf.
   `{...zarf}` prototipi ve özel alanı kaybeder → ne derlenir ne de `Masked.is`'ten geçer;
   `as unknown as` ile zorlanan çağrı çalışma zamanında `PiiLeakError` alır. `any` hâlâ her tipe
   atanabilir (TypeScript kuralı, kaçınılmaz) — bu yüzden zarf **yükü içinde taşır**: tip
   sistemini zorlayan çağıranın verdiği `any`'nin `.value`'su `undefined`'dır, yani ham veri
   fiziksel olarak tele çıkamaz.
2. **Egress tuzak teli (çalışma zamanı).** `guardEgress(...)` herhangi bir çıkış noktasına takılır.
   Bağımsız bir dedektör kümesi değildir; iki şeyi yakalar: (a) "maskelemeyi unuttum" hatasını,
   (b) maskeleyicinin **yapısal olarak yeniden yazamadığı** yüzeyi — nesne **anahtarları**.
   `{ "12345678950": {...} }` bankacılıkta olağan bir şekildir; maskeleyici anahtar adını
   değiştirse şema bozulur, o yüzden anahtarları tarayıp **reddeder** (B-10). Tuzak telinin
   testi budur; `maskOutbound`'daki `assertNoPii` çağrısı silindiğinde test kırmızıya döner.
3. **Politika markası (derleme).** `PiiBoundaryOptions.policy` yalnız `loadPiiPolicy`'nin
   ürettiği `LoadedPiiPolicy`'yi kabul eder; belge donmuştur, yani doğrulama sonrası
   zayıflatılamaz (B-7).

`guardEgress` artık **politika + sınıf değil, derlenmiş profil** alır. Eskiden sınıfı kendisi
çözüyordu; yani tuzak teli, yükün beraberinde getirdiği ve webhook'tan gelen etiketin aynısına
güveniyordu — `dataClass: "acik"` demek ham TCKN'yi geçirmeye yetiyordu (B-6).

## 3. Test özeti

14 dosya, 152 test, tamamen çevrimdışı ve deterministik. **Gerçek kişisel veri yok**: tüm
örnekler `test/synthetic.ts` üreteçleriyle (checksum'ları hesaplanarak) yaratılır (M95).
Oturum nonce'u testlerde sabitlenebilir (`createSession(profile, "t1")`), üretimde 32 bit rastgele.

Kapsam: her dedektör için pozitif + checksum'ı bozulmuş negatif + yanlış-pozitif tuzağı ·
**ayraçlı/harf duyarsız/Unicode yazımlar** (`spellings.test.ts`) · **oturum kapsamı ve jeton
enjeksiyonu** (`session-scope.test.ts`) · **zarf/tuzak teli/dönüş yolu/log sızıntısı**
(`egress-gate.test.ts`) · çakışma çözümü · idempotanlık · alan kuralları · fail-closed traversal ·
ReverseMap sızıntı yüzeyleri · politika monotonluğu ve ReDoS reddi · `AuditAction` ID tutarlılığı.

### Mutasyon denetimi (testlerin yük taşıdığının kanıtı)
Bu turda 15 kasıtlı bozma uygulandı, **hepsi yakalandı**:

| Bozma | Sonuç |
|---|---|
| `maskOutbound`'dan `assertNoPii` sil | 1 test kırmızı (B-10 — önceki turda 89/89 yeşil kalıyordu) |
| `guardEgress`'ten `Masked.is` denetimini sil | 4 test kırmızı |
| Dönüş yolu maskelemesini kaldır | 2 test kırmızı |
| Politikanın `Object.freeze`'ini kaldır | 2 test kırmızı |
| Monotonluk denetimini kaldır | 3 test kırmızı |
| ReDoS denetimini kaldır | 4 test kırmızı |
| `assertNoPii`'nin anahtar taramasını kaldır | 2 test kırmızı |
| Yabancı jeton kaçırmayı kaldır | 1 test kırmızı |
| Jetondan nonce'u çıkar | 30 test kırmızı |
| `#output`'u genel özellik yap | 2 test kırmızı |
| TCKN ayraçlarını daralt | 5 test kırmızı |
| IBAN harf duyarsızlığını geri al | 2 test kırmızı |
| E-postayı yalnız ASCII yap | 3 test kırmızı |
| `PiiBoundaryOptions.policy`'nin markasını kaldır | `typecheck` KIRILDI |
| `OutboundCall`'ın zarfını kaldır | `typecheck` KIRILDI |

Ayrıca iki `@ts-expect-error` testinin gerçekten hata beklediği doğrulandı: yorumlar
kaldırıldığında `tsc` sırasıyla `TS2345` ve `TS2322` veriyor.

## 4. Varsayımlar

1. **Profil ekseni.** M18/M63 profillerin kurulumda uyum ekibiyle doldurulmasını söylüyor;
   `defaultPiiPolicy()` yalnız güvenli bir başlangıçtır. Artık `acik ⊆ dahili ⊆ gizli`
   **zorunludur**: gevşek bir sınıf, katı bir sınıftan fazlasını maskeleyemez.
2. **`gizli` = azami profil.** Bilinmeyen sınıfın düştüğü profil olduğu için `loadPiiPolicy`,
   `gizli`'nin tüm dedektörleri açık tutmasını zorunlu kılar.
3. **`dataClass` GÜVENİLMEYEN girdidir.** Tipi bilinçli `unknown`, çünkü webhook ve Jira alanları
   ne isterlerse gönderir. "Bilinmeyen → en katı" kuralı yalnız **tanınmayan** değeri korur;
   tanınan ama zayıf bir değeri (`"acik"`) korumaz. Bu yüzden: **sınıf beyanı güvenilir bir
   kaynaktan gelmelidir** (routing kuralı / params, webhook gövdesi değil) ve egress tuzak teli
   sınıfı yeniden çözmez, maskeleyicinin derlenmiş profilini alır. Tüketici paketler için
   bağlayıcı nottur.
4. **Sayısal alanlar maskelenir.** `{ tckn: 12345678950 }` jetona (string) çevrilir; tip değişir.
5. **Traversal fail-closed.** Yalnız düz nesne / dizi / `Date` / ilkel değerler. `Map`, `Set`,
   sınıf örneği, fonksiyon → `PiiArgumentError`. Bu artık **dönüş yolu için de** geçerli:
   `withPiiBoundary` cevabı da maskelediğinden, gezilemeyen bir cevap reddedilir.
6. **Kanonikleştirme geri dönüşü.** Bir değerin ilk görülen yazımı jetona bağlanır; aynı değerin
   farklı yazımları geri konurken ilk yazıma normalize olur. Anlam korunur, karakter-birebir
   sadakat korunmaz.
7. **İsim/adres tespiti yok.** M20'nin "alan" yarısı (`fieldRules`) tam olarak bunun içindir.
8. **Nonce sır değildir.** Aynı oturum içinde modele gösterilmiş bir jetonun aynı oturumda geri
   gelmesi **tasarım gereği** çözülür (çok turlu maskelemenin amacı budur). Nonce'un kapattığı
   şey oturumlar/biletler **arası** karışmadır.

## 5. Arayüz / bağımlılık talepleri

- **Yeni runtime bağımlılığı YOK.** `@maestro/contracts` + `zod`. Test tarafında `vitest` +
  `@types/node`. Nonce için `crypto.getRandomValues` (Node 24 genel nesnesi) kullanılıyor.
- **`contracts`/`ports` DEĞİŞTİRİLMEDİ.** `packages/ports/src/pii.ts` orkestratörün işi.
- **KIRICI DEĞİŞİKLİKLER (orkestratörün bilmesi gereken):**
  1. **Jeton dilbilgisi değişti:** `[IBAN_1]` → `[IBAN_1.a3f9]`. B-8'in yapısal çözümü metnin
     içinde bir oturum işareti gerektiriyor; başka yolu yok. Bu, `@maestro/llm-gateway`
     testlerindeki **4 birebir jeton iddiasına** dokundu; yalnız o iddialar (`toContain("[IBAN_1")`
     ve nonce'lu jetonla `unmask` çağrısı) güncellendi, gateway **kaynak kodu değişmedi**.
     Diğer tüketiciler jeton metnini birebir beklememelidir.
  2. **`guardEgress` imzası:** `guardEgress({policy, dataClass}, send)` →
     `guardEgress({profile, boundary?}, send)`. Profil `maskOutbound(...).profile` veya
     `compiledProfileFor(policy, güvenilirSınıf).profile` ile alınır (B-6).
  3. **`OutboundCall` artık zarf alır:** callee `payload.value` okur.
     `JSON.stringify(zarf)` maskeli yükü verir (`toJSON`), yani HTTP gövdesi kurmak aynı kalır.
  4. **`PiiBoundaryResult.output` kalktı:** yerine `reveal()`. `maskedOutput` aynı yerde.
  5. **`onMasked(counts, dataClass, info)`** — `info` = `{boundary, leg, fellBack}`. Eski iki
     parametreli kancalar derlenmeye devam eder.
  6. **`loadPiiPolicy` artık `LoadedPiiPolicy` döner ve belgeyi dondurur;** `defaultPiiPolicy()`
     de yüklenmiş/donmuş döner (bu yüzden `llm-gateway`'in mevcut kullanımı kırılmadı).
     `resolveProfile`/`compileProfile` markasız `PiiPolicy` kabul etmeye devam eder.
- **Satır tavanı aşımı:** paket 1636 satır üretim kodu (spec tavanı ~1200). Artışın tamamı bu
  turun bulgularından: nominal zarf, sonuç sınıfı, ReDoS denetimi, monotonluk, anahtar taraması,
  ayraç modülü. Dosya başına 300 satır tavanı korunuyor (en büyüğü 279).
- **Tüketiciler için bağlayıcı not (M20/M82):** `llm-gateway`, `memory` ve `storage` **maskeli**
  hâli yazmalıdır — `PiiBoundaryResult.maskedOutput`. `reveal()` yalnız kullanıcıya dönen anlık
  gösterime gider, hiçbir yere yazılmaz.
- **Audit için:** `toAuditMeta(counts)` → `{maskedOccurrences, maskedFields, maskedTypes}`;
  `onMasked` artık `fellBack`'i de veriyor (sınıf beyanı kullanılamadı → en katıya düşüldü).

## 6. v1'den ne alınmadı ve neden

Eski `packages/pii/src/index.ts` yalnız tarihsel referans olarak okundu; hiçbir satır kopyalanmadı.

| v1'deki şey | Neden alınmadı |
|---|---|
| `config.enabled` bayrağı | Tek satırlık **fail-open** anahtarı. |
| Serbest `patternRules` | Checksum'sız regex = yanlış pozitif fabrikası; serbest desen yalnız hesap/müşteri numarasına, üstelik yükleme anında **ReDoS denetimiyle** derlenerek bırakıldı. |
| `try { new RegExp(...) } catch { /* skip */ }` | Bozuk desen sessizce atlanıyordu. Artık `PiiPolicyError`. |
| `hash`/`partial`/`keep` alan stratejileri | `partial` kısmi değeri dışarı veriyor, `keep` hiçbir şey yapmıyor, `hash` jetona değerin hash'ini gömüyordu. |
| `ReverseMap.applyReverse` | O(n·m) ve kısmi jeton çakışmasına açık. |
| v1 ReverseMap'in düz `Map` alanı | Loglanabilir/serileştirilebilirdi. |
| `maskObject`'in bilinmeyen tipleri geçirmesi | Sayılar ve sınıf örnekleri sessizce maskesiz geçiyordu. |
| `runner.ts` entegrasyon şekli | **Asıl hata buydu**: maskeleme çağrısı isteğe bağlıydı. |

## 7. Bilinen sınırlar (dürüst kapsam)

Bu bölümdeki ilk üç madde **kapatılmadı**; bilinçli sınırlardır ve uyum ekibinin görmesi gerekir.

1. **Kodlanmış/gömülü PII maskelenmez (B-14/B-15).** base64 (`MTIzNDU2Nzg5NTA=`), HTML entity
   (`&#49;&#50;…`), sıfır-genişlik karakterlerle bölünmüş (`123​45678950`) ve fullwidth
   (`１２３４５６７８９５０`) yazımlar dedektörlerden geçer. Genel çözüm, her string için
   olası kod çözümlerini denemek olurdu; bu hem yanlış pozitif üretir hem de LLM sıcak yolunda
   maliyetlidir. Sınırlı ve doğrulanabilir bir davranış, gizlice yarım çalışan bir çözümden
   iyidir. **Azaltıcı:** bu paketle konuşan adaptörler (Jira/ADO) metni ham hâliyle vermelidir;
   normalizasyon yapan bir katman varsa maskeleme ondan **önce** koşmalıdır.
2. **Checksum katılığı — kabul edilmiş risk.** TCKN/IBAN/kart yalnız checksum doğrulanırsa
   maskelenir. Sonucu: bir insanın **tek hanesini yanlış yazdığı gerçek bir TCKN maskelenmez**.
   Alternatif (checksum'sız 11 hane maskelemek) her sipariş/fatura numarasını maskeler ve modelin
   ihtiyacı olan bağlamı yok eder. Bu, **uyum ekibinin imzalaması gereken bir kabul**tür;
   imzalanmazsa çare `fieldRules` ile alan bazlı kapatmadır (M20'nin "alan" yarısı).
3. **ReDoS denetimi bir sezgiseldir (B-18).** `regex-safety.ts` iç içe sınırsız niceleyiciyi
   (`(x+)+`) ve 200 karakterden uzun deseni reddeder; hayatta kalan her deseni güvenli
   **kanıtlamaz**. Operatör deseni yine de gözden geçirilmelidir.
4. Kişi adı/adres için desen tespiti yoktur; `fieldRules` ile alan bazlı kapatılır.
5. Yalnız TR telefon planı desteklenir; yurt dışı numarası maskelenmez.
6. Çıplak (ayraçsız, önek almamış) sabit hat numaraları kasıtlı olarak maskelenmez — fatura/
   sözleşme numaralarıyla ayırt edilemiyorlar. Çıplak mobil (5xx) maskelenir.
7. **Nesne anahtarındaki PII maskelenmez, reddedilir** (§2/B-10). `{ "<TCKN>": {...} }` şeklinde
   bir yük `PiiLeakError` alır; çağıranın yükü yeniden şekillendirmesi gerekir.
8. Maskeleme her çağrıda profil derler; gateway sıcak yolunda ölçüm gerekirse
   `createSessionWith(compiledProfile)` ile derleme önbelleğe alınabilir — API hazır
   (`compiledProfileFor` tam bunun için).
9. **İkinci, gevşek tarayıcı yazılmadı.** Doğrulayıcının önerdiği "checksum'sız, yalnız alarm
   üreten" egress tarayıcısı bu tura alınmadı: bugünkü tuzak teli bir alarm değil bir **ret**
   mekanizması ve iki farklı eşiği aynı yere koymak yanlış pozitifleri sessizce üretime taşır.
   Ayrı bir iş paketi olarak önerilir.
