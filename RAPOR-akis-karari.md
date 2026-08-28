# RAPOR — Akış tipi artık ticket başına karar veriliyor

**Branch:** `worktree-agent-a35e2606762a18067` (taban: `11d5f03`)
**Commit:** `0384525` — `flow: akış tipini ticket başına karar verilebilir yap`
(main'e **merge edilmedi**)

## Sorun

`apps/deploy/src/bin/bff.ts` içindeki `flowOf(env)` akış tipini **ortam
değişkeninden** okuyordu (`MAESTRO_PROFILE` / `MAESTRO_FLOW`). Bu, bir kurulumun
**tamamını** tek akışa bağlıyordu: ya her ticket `analiz`, ya her ticket
mühendislik. Bankada aynı Jira projesinde hem "şunu analiz et" hem "şu hatayı
düzelt" ticket'ı bulunur; eski yapı bunu ifade edemiyordu.

## Worktree düzeltmesi (önce)

Worktree `1c78e71 "first commit"` üzerindeydi. Görev `git reset --hard main`
diyordu, **ama `main` (`df73d44`) hedef commit'i içermiyor** — `11d5f03`,
`main`'in ilerisinde (`main` onun atası). `main`'e sıfırlamak yanlış tabana
indirirdi ve `grep -c FlowType` kontrolünü de geçemezdi. Bu yüzden doğrulama
hedefine sadık kalıp `git reset --hard 11d5f03` yaptım. Her iki kontrol de
geçti: HEAD `11d5f03`, `grep -c FlowType … = 3`.

## Yapılan

### 1. `ruleFor` pilottan platforma taşındı → `apps/bff/src/flow-decision.ts`

Pilotun `apps/pilot/src/listening.ts:140` `ruleFor` mantığı (öncelik sırasına
göre ilk eşleşen kazanır) yeni bir BFF modülüne taşındı. Pilot **okundu,
yazılmadı**.

**M44 gerekçesi:** Karar, veritabanı okuyabilen *composition-root* tarafında
verilmeli. `packages/workflows` veritabanına **soramaz** — soran bir workflow,
bir admin kuralı düzenlediği anda replay'de farklı yol izlerdi. Ayrıca kural
**tipleri** (`ListeningRuleRecord`, `FlowType`, `MatchKind`) zaten
`apps/bff/src/listening-store.ts`'te; donmuş `@maestro/contracts` içinde değil.
Yani modül `apps/bff`'te durunca **hiçbir donmuş sınır aşılmıyor** ve BFF'e Jira
importu da girmiyor.

### 2. Kural kaynağı `ListeningRule` tablosu — migration YOK

Önceki ajanın bulgusu doğrulandı: `ListeningRule` (`schema.prisma:480`) zaten
`projectKey`, `assigneeAccountId`, `matchKind`, `matchValue`, `flowType`,
`priority`, `enabled` taşıyor. `ListeningStore` arayüzü ve `PrismaListeningStore`
zaten BFF deps'ine bağlıydı. **Şema değişikliği yapılmadı.** `RoutingRule`'a
dokunulmadı.

### 3. Karar noktası: `runIntake`, workflow BAŞLAMADAN

`apps/bff/src/jira-intake.ts` — `signalWithStart` çağrısından **önce**
`decideFlow()` kuralları bir kez okur, sonucu **start girdisinde** taşır
(`flow` alanı `SignalWithStartInput`'ta zaten vardı). Bu, HANDOFF 2. maddedeki
`openGate` → `canCloseGate` deseninin aynısı: dizin/veritabanı çözümlemesi
dışarıda yapılır, workflow'a çözülmüş değer verilir. **Determinizm korunur.**

### 4. Status/issuetype nereden geliyor

Donmuş `TicketSnapshot`'ta **status alanı yok**. Tek kaynak webhook teslimatı.
`WorkEvent`'e `status`/`issueType`/`assignee` eklendi; çıkarım
`apps/deploy/src/work-events.ts`'te yapılıyor — böylece Jira importu `apps/bff`'e
girmiyor (M44, `labels` ile aynı desen). Cloud'da atanan kişinin **yalnız
`accountId`'si** olduğu için (HANDOFF 3. madde) `accountId` önce okunuyor, DC
alanları geri düşüş.

## Geri düşüş davranışı (mevcut kurulum bozulmuyor)

| Durum | Sonuç |
|---|---|
| Kural eşleşti | Kuralın akışı (`reason: "rule"`) |
| Hiç kural eşleşmedi | `flowOf(env)` varsayılanı (`reason: "default"`) |
| Kural yok **ve** varsayılan yok | Akış boş → motorun tam hattı (`reason: "none"`) |
| `ListeningStore` hiç bağlı değil | Varsayılan — eski davranışın aynısı |
| Store **hata verdi** | Varsayılan; ticket asla mahsur kalmaz |

Kuralı olmayan bir kurulum bugüne kadar nasıl davrandıysa aynen öyle davranır.

## Fail-closed

Kurallar **çelişirse** (bir status kuralı ile bir issuetype kuralı aynı ticket'ı
tutabilir — hiçbir unique index bunu engelleyemez) **en dar** akış seçilir:
`analiz` < `duzeltme` < `gelistirme`. `analiz` hiç kod yazmaz; yanlış olmanın
bedeli "kimsenin istemediği bir belge", diğer yönde ise "kimsenin istemediği bir
kod değişikliği". Öncelik numarası daha iyi olsa bile dar olan kazanır.

Çelişki **reddedilmez** — reddetmek ticket'ı mahsur bırakırdı; dar akış zaten
güvenli. Bunun yerine `rule_conflict` olarak **raporlanır**.

Not: "hiç kural eşleşmedi" *belirsizlik değil*, *sınıflandırılmamış*tır — o
yüzden dar akışa değil, operatörün bilinçli seçimi olan varsayılana düşer.

## Görünürlük — operatör sorabiliyor

`RUN_STARTED` denetim kaydının `meta`'sına yazılıyor:

- `flow` — hangi akış
- `flowReason` — `rule` | `rule_conflict` | `default` | `none`
- `flowRuleId` — karar veren kuralın kimliği (varsa)
- `flowConflictingRuleIds` — çelişkide rol alan tüm kurallar

Log satırı değil **denetim zinciri** seçildi: "OPS-41 neden kod yazdı?" sorusu
aylar sonra sorulur, log o zaman çoktan gitmiş olur.

## Testler

**Toplam 42 yeni test, hepsi gerçek assert'li, ağ çağrısı yok.**

| Dosya | Test |
|---|---|
| `apps/bff/test/flow-decision.test.ts` | 23 |
| `apps/bff/test/flow-intake.test.ts` | 11 |
| `apps/deploy/test/work-events.test.ts` | 8 |

**Kanıt — aynı projede iki ticket, iki akış** (`flow-intake.test.ts`, gerçek
imzalı webhook teslimatı üzerinden, sahte değil):

- `UGURPAY-1` (issuetype `Hata`) → `duzeltme`
- `UGURPAY-2` (issuetype `Analiz`) → `analiz`
- ve `expect(bug.flow).not.toBe(analysis.flow)`

**Kanıt — kural yoksa varsayılana düşüyor:** dört ayrı test (eşleşmeyen kural /
hiç kural yok / store bağlı değil / store hata verdi).

## Mutasyon kanıtı

Mutasyonlar **yalnız bu worktree'de** yapıldı; paylaşılan checkout'a
(`/home/ubuntu/coder/maestro`) dokunulmadı. Hepsi geri alındı, `grep MUTANT`
temiz.

| # | Mutasyon | Sonuç |
|---|---|---|
| 1 | `matches()` → `return false` (kural eşleştirmeyi boz) | **20 test kırıldı** ✓ |
| 2 | `NARROWNESS` sıralamasını ters çevir (fail-open yap) | **3 fail-closed testi kırıldı** ✓ |
| 3 | Store bağlı değilken varsayılana düşmeyi kaldır | **İlk denemede HAYATTA KALDI** |

3. mutasyon **gerçek bir test boşluğu ortaya çıkardı**: harness her zaman bir
listening store bağlıyor, dolayısıyla "store'suz kurulum" geri düşüşü — yani
"mevcut kurulumlar bozulmasın" vaadinin ta kendisi — hiç kapsanmıyordu. Boşluğu
kapatan test yazıldı, mutasyon tekrar uygulandı, **bu kez öldü**, sonra geri
alındı.

## Gate

`pnpm run gate` → **64/64 görev başarılı, exit 0.**
(BFF 745 test, deploy 560 test.)

İlk koşuda `@maestro/pilot > docs.test.ts` 5 sn zaman aşımıyla düştü; tek başına
koşturulunca 14/14 geçiyor — canlı servislerin yükünden kaynaklanan flake,
dokunmadığım kodda. İkinci koşu tamamen yeşil.

## ARAYÜZ İSTEKLERİ

1. **Kural çelişkisi ekranda gösterilmeli.** `rule_conflict` şu an yalnız
   denetim kaydında. Dinleme kuralları ekranı, aynı ticket'ı tutabilecek
   status+issuetype kural çiftlerini **uyarı olarak** göstermeli — veritabanı
   unique index'i bu durumu engelleyemiyor.
2. **Koşu ekranında "neden bu akış?"** `flowReason` + `flowRuleId` zaten
   kaydediliyor; koşu detay ekranında "Akış: düzeltme — kural `lr_bug`" diye
   gösterilebilir. Yeni veri toplamaya gerek yok.
3. **Kural denemesi (dry-run).** Admin bir kural yazarken "bu kural şu an hangi
   ticket'ları tutardı?" sorusunu sorabilmeli. `rulesFor()` bunu karşılayacak
   şekilde dışa açık.

## Yapmadıklarım

- **`analystVariantId` / `engineerVariantId` bağlanmadı.** `ruleFor()` kuralın
  tamamını döndürüyor (varyant alanları test ile korunuyor), ama koşuyu o ajan
  varyantıyla başlatmak ayrı bir iş — akış tipi kararının kapsamı dışında.
- **Diğer intake yolları ticket bilgisi taşımıyor.** `/ai-start`, `/ai-assign`,
  Studio "Başlat" ve `platform/operate` çağrılarında status/issuetype elde
  değil; bu yollar varsayılana düşüyor (eski davranış). Bunlar için ticket'ı
  Jira'dan okumak gerekirdi — ayrı bir tur, ayrı bir hata yüzeyi.
- **Canlı doğrulama yapılmadı.** Gerçek Jira ticket'ı ile uçtan uca koşu
  denenmedi; canlı servislere dokunmadım.
- **Locale dosyaları değiştirilmedi** — kullanıcıya gösterilen yeni metin
  eklemedim. `flowReason` değerleri denetim kodu, ekran metni değil; tr+en
  paritesi bozulmadı.
- Pilot silinmedi, Studio ekranları Temporal'a geçirilmedi (Faz 5/6).
