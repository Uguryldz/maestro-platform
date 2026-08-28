# RAPOR — Jira bağlantısındaki bot hesabı yanlıştı

**Dal:** `gap-b10-b14-pii-changetype-audit-realmerge`
**Temel commit:** `c5685e4`

## Bulgu (canlı ölçüm)

`Connection` tablosunda `id='jira'` kaydının `configJson`'ı operatörün **kişisel**
hesabını taşıyordu:

| | accountId |
|---|---|
| Kayıtta yazan (`configJson.botAccountId`) | `712020:7ee7a2ab-…` — **Uğur Yıldız**, operatörün kendisi |
| Token'in gerçek sahibi (`/rest/api/3/myself`) | `712020:b836c135-…` — **maestro**, bot |
| Dinleme kuralının beklediği (`ListeningRule.assigneeAccountId`) | `712020:b836c135-…` — **doğru olan** |

Kural ve gerçek bot eşleşiyordu; yanlış olan **bağlantı kaydıydı**.

## Kök neden — üç ayrı kusur

Kod zaten test sırasında `botAccountId`'yi öğrenip yazıyordu
(`routes/connections.ts:148`). Yanlış değerin hayatta kalmasının sebebi tek bir
eksiklik değil, birbirini besleyen üç kusurdu:

1. **Karşılaştırma hiç yoktu.** `botAccountId` serbest metin bir `config` alanı.
   `ConnectionInput` onu `Record<string,string>` olarak kabul ediyor, `ConnectorsPanel`
   formu `config`'i olduğu gibi geçiriyordu. Operatörün elle girdiği 36 karakterlik
   kimliği **hiçbir şey token'in gerçek sahibiyle kıyaslamıyordu**. Asıl kusur bu.
2. **Düzeltme sessizdi.** Otomatik düzeltme çalışsa bile operatöre *hiçbir şey*
   söylemiyordu — ekranda düz yeşil "Bağlantı başarılı" çıkıyordu. Yanlış hesabın
   varlığı hiç fark edilemezdi.
3. **Düzeltme kalıcı olmuyordu.** Panelin düzenleme kipi `config`'i aynen geri
   gönderiyor. Test kimliği düzelttikten sonra yapılan **herhangi bir** düzenleme
   (isim/URL değişikliği bile) operatörün eski yanlış değerini geri yazıyordu.
   Yanlış değerin her düzeltmeye rağmen ayakta kalmasının mekanizması budur.

Ayrıca yol üstünde iki gerçek hata daha bulundu:

4. **PII sızıntısı** — `identity` `displayName ?? emailAddress` şeklindeydi.
   `displayName` boş gelen bir hesapta botun **e-postası** hem panele hem de
   kalıcı test notuna yazılırdı.
5. **Sıralama hatası** — otomatik düzeltme `recordTest`'ten *sonra* çalışıyor,
   `put` ile satırın tamamını yazdığı için az önce kaydedilen test sonucunu
   (`lastTestNote`/`lastTestedAt`) **siliyordu**. Testim bunu yakaladı.

## Seçilen çözüm: **otomatik düzelt + yüksek sesle söyle** (reddetme değil)

Gerekçe:

- **Reddetmek yanlış olurdu.** Bağlantı gerçekten çalışıyor; token geçerli.
  Testi kırmızıya boyamak operatörü çalışan bir kimlik bilgisini kurcalamaya iter.
- **Sessiz kabul de yanlış.** Yanlış hesap; yorum/atama/geçiş yanlış kişiye
  atfedilir, dört-göz muafiyeti yanlış hesaba tanınır.
- **Otomatik düzeltme doğru kaynağa güvenir.** `/myself` yanıtı token'in *kendi*
  sahibidir — tanım gereği otoriter. Karşı taraf ise elle yazılmış 36 karakterlik
  bir dizi. Klavyeyi API'ye tercih etmek bilinen-yanlış bir değeri yerinde tutmak
  demektir. Operatörün o kimliği elle doğru yazmasını beklemek hataya davetiyedir.
- **Ama sessiz düzeltme de bir kusurdur** — bu yüzden düzeltme artık kendini
  duyuruyor: rozet **kehribar/uyarı** olur (yeşil değil), mesaj **iki kimliği de**
  yazar, kapatılması gereken bir **toast** çıkar ve **denetim kaydı**
  `test_ok_bot_corrected` fiiliyle iki kimliği birden saklar.

`ok` alanı `true` kalır (bağlantı gerçekten kuruldu), ama düz "başarılı" demesine
izin verilmez.

## Değişiklikler

| Dosya | Ne |
|---|---|
| `apps/bff/src/connection-service.ts` | Kimlik karşılaştırması; `accountIdCorrected` alanı; `ok_bot_fixed` sonucu. **PII:** `emailAddress` yedeği kaldırıldı, yalnız `displayName`. |
| `apps/bff/src/routes/connections.ts` | Düzeltme `recordTest`'ten **önce**e alındı (sonuç silinmesin); `mergeLearnedIdentity` ile öğrenilen kimlik düzenlemede korunur; denetim kaydına iki kimlik + `test_ok_bot_corrected`. |
| `apps/studio/src/screens/settings/ConnectorsPanel.tsx` | `warn` durumu; kehribar rozet; uyarı toast'ı; iki kimliğin tam metni. |
| `apps/studio/src/screens/common/admin-api.ts` | `ConnectionTestResponse.botAccountCorrected` (yalnız accountId, e-posta yok). |
| `packages/config/locales/{tr,en}.json` | `connections.test.ok_bot_fixed`, `connections.status.ok_fixed` — tr+en parite korundu. |

## Kayıtlı yanlış verinin düzeltilme yolu

Canlı DB'ye **yazmadım**. Operatörün yolu: Studio → Ayarlar → Bağlantılar →
Jira satırında **"Test et"**. Test, gerçek sahibi okur, `botAccountId`'yi
`712020:b836c135-…` olarak düzeltir, kehribar uyarıyı ve iki kimliği gösterir.
Tek tıkla, elle kimlik yazmadan. Sonraki düzenlemeler artık değeri geri
bozmaz (kusur 3 kapatıldı).

## PII koruması

- `/myself` yanıtı e-posta içerir; `identity` artık **yalnız** `displayName` okur.
- Yanıtta, panelde, toast'ta, `lastTestNote`'ta ve denetim kaydında yalnız
  `accountId` ve `displayName` var.
- Bir test bunu doğrudan iddia ediyor: fikstür gövdesi gerçek bir e-posta taşır ve
  test onun **hiçbir çıktıda** geçmediğini assert eder (test yanıtı, bağlantı
  listesi, denetim kaydı).

## Fail-closed

Ağ hatasında (`ECONNREFUSED`) sonuç `ok:false` + `connections.test.unreachable`;
`botAccountCorrected` **yok**, "doğrulandı" denmiyor ve **kayıtlı değer
değiştirilmiyor** — kanıtsız bir üzerine yazma, yanlış değerden daha kötüdür.
200 dönen ama `accountId` içermeyen bir yanıt da düzeltme iddia etmez.

## Testler

**8 yeni test** (7 BFF + 1 Studio), hepsi **fikstür** — ağ çağrısı yok.

BFF (`apps/bff/test/connections.test.ts`) — toplam 24 geçiyor:
1. Uyuşmayan `botAccountId` yakalanıyor ve düzeltiliyor
2. Eşleşen kimlik sessizce kabul ediliyor (yanlış alarm yok)
3. Ağ hatasında "doğrulandı" denmiyor + değer korunuyor (fail-closed)
4. `accountId` içermeyen 200 yanıtında düzeltme iddia edilmiyor
5. Denetim kaydında iki kimlik + e-posta yok
6. E-posta hiçbir çıktıda geçmiyor (PII)
7. Sonraki düzenleme yanlış kimliği geri getirmiyor

Studio (`apps/studio/test/screens-connectors.test.tsx`) — toplam 7 geçiyor:
8. Düzeltilen hesap **kehribar uyarı** olarak görünüyor, yeşil değil; iki kimlik ekranda

## Mutasyon kanıtı (4 mutasyon, hepsi kırdı)

| Mutasyon | Sonuç |
|---|---|
| Karşılaştırmayı `if (false)` yap | **3 test kırıldı** |
| `identity`'yi e-posta öncelikli yap | **1 test kırıldı** (PII testi) |
| `mergeLearnedIdentity` çağrısını kaldır | **1 test kırıldı** |
| Kehribar `warn` dalını sil | **1 test kırıldı** |

Dördü de geri alındı; sonrasında hepsi yeşil.

## Kapı

`pnpm run gate` → **EXIT=0, 64/64 görev** (yük ortalaması 17.88 iken).
Ara koşularda `studio/screens-users`, `screens-killswitch` ve `bff/password`
düştü — üçü de brief'te/HANDOFF'ta adı geçen **yük flake'leri**; tek başlarına
koşulduğunda geçtiler ve her koşuda farklı test düştü (regresyon değil).

## ARAYÜZ İSTEKLERİ

Yok. `packages/contracts` ve `packages/ports` değiştirilmedi. `botAccountId`
donmuş `Connection.config` içinde serbest bir alan olarak kalıyor.

> Not (gelecek için, bu iş kapsamında değil): `botAccountId`'yi `config`'ten
> çıkarıp `Connection` üzerinde **yalnız-sunucu-yazar** bir alan yapmak, elle
> girilebilirliği tümüyle ortadan kaldırırdı. Contracts donmuş olduğu için
> yapılmadı; bugünkü çözüm elle girilen değeri kabul edip **kanıtla** düzeltiyor.

## Yapmadıklarım

- **Canlı DB'ye yazmadım** — düzeltme operatörün "Test et" tıklamasıyla gelir.
- `packages/storage`, `apps/deploy/src/object-lock.ts`, `packages/db/prisma/migrations/`
  — paralel ajanların alanı, dokunulmadı.
- `main`'e merge edilmedi.
- Jira DC (`jira_dc`) yolu aynı karşılaştırmadan geçiyor (`key`/`name` üzerinden),
  ama canlıda DC bağlantısı olmadığı için gerçek ortamda doğrulanmadı.
