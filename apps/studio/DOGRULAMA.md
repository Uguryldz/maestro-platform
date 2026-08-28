# `apps/studio` — bağımsız doğrulama raporu (Dalga 4)

**Denetleyen:** bağımsız doğrulayıcı ajan · **Tarih:** 2026-08-09
**Kapsam:** `maestro/apps/studio` — 37 ekran, 3 ajan (iskelet + küme A/B/C)
**Çalışma biçimi:** salt-okunur denetim. 12 mutasyon testi yapıldı; **her mutasyon
sonrası kaynak `git`ten doğrulanarak geri alındı** — `git status --porcelain apps/studio`
denetim sonunda **temiz**.

**Karar: `KALDI`** (1 kritik, 3 yüksek)

---

## 0. Doğrulanan iddialar (rapordakiler gerçekten doğru olanlar)

Bunları önce yazıyorum, çünkü raporların **çoğu** doğrulandı ve bulguların ağırlığı
buna göre okunmalı.

| İddia | Doğrulama yöntemi | Sonuç |
|---|---|---|
| 177 test yeşil | `pnpm --filter @maestro/studio exec vitest run` | ✅ 13 dosya / 177 test |
| tr/en parite tam | JSON anahtar kümesi farkı | ✅ 1314 = 1314, fark **0**, boş değer **0** |
| Gömülü kullanıcı metni yok | JSX düz metin + `placeholder=`/`aria-label=`/`title=` taraması | ✅ **0 bulgu** |
| Kapı kararı REST değil sinyal | `signals.ts` + BFF `runs.ts` | ✅ `POST /runs/:ticket/signals/gateDecision`, gövdede aktör alanı **yok** |
| `knowledge` fail-closed | **Mutasyon:** `resolveDataClass` → `"acik"` | ✅ **6 test kırıldı** |
| `audit` körü körüne yeşil basmıyor | **Mutasyon:** `checked <= 0` dalını devre dışı bırak | ✅ **2 dosya / birden çok test kırıldı** |
| `pii` maskelenen değeri göstermiyor | **Mutasyon:** `matcher` hücresine TCKN/e-posta ekle | ✅ **1 test kırıldı**; yanıt tipinde değer taşıyacak alan yok |
| `evidence` SoD tikini uydurmuyor | **Mutasyon:** `sodVerified` → daima yeşil | ✅ **1 test kırıldı** |
| Kill switch tek tık değil | **Mutasyon 1:** `ConfirmModal` boş gerekçe kabulü → **1 test kırıldı**. **Mutasyon 2:** `mayOperate = true` → **2 test kırıldı** | ✅ iki adımlı + zorunlu gerekçe + delegated/non-admin gizli |
| `template` anahtar çakışması engelli | **Mutasyon:** `uniqueKey` suffix döngüsünü kaldır | ✅ **6 test kırıldı** |
| `severity` unknown dibe batmıyor | **Mutasyon:** `unknown: 6` | ✅ **2 test kırıldı** |
| `LlmOutcome` fail-closed | **Mutasyon:** bilinmeyen → `"ok"` | ✅ **1 test kırıldı** |
| `mayDecide` yetki gizleme | **Mutasyon:** `return true` | ✅ **1 dosya kırıldı** |
| Token `localStorage`'da değil | `grep localStorage/sessionStorage/cookie` | ✅ yalnız `maestro.locale`; token `useRef`'te |
| Ölü dosya / ölü export | Tüm `src/` çapraz referans taraması | ✅ **0 başvurusuz dosya** |
| Rol gizleme güvenlik sanılmıyor | `RequireSession.tsx`, `Sidebar.tsx`, `signals.ts` yorumları + `auth.test.tsx` | ✅ gizli ekranın URL ile açıldığını **bilerek** test ediyor |

Kısacası: **fail-closed disiplini gerçek, testler tautolojik değil.** Aşağıdaki
bulgular bu zeminin üzerindeki kusurlar.

---

## K1 — (KRİTİK) Halüsinasyon entegrasyon: `journal` ve `evidence` **var olan** uçları yanlış yoldan çağırıyor

**Dosya:** `apps/studio/src/screens/shared/runs.ts:113` ve `:130`

```ts
// runs.ts:113
api.get<JournalResponse>(`/runs/${ticket ?? ""}/journal`, { signal })
// runs.ts:130
api.get<EvidencePackage>(`/runs/${ticket ?? ""}/evidence`, { signal })
```

**BFF'te bu yollar yok.** Gerçek uçlar `apps/bff/src/routes/studio-runs.ts` içinde:

| Studio çağırıyor | BFF'te gerçekte var olan |
|---|---|
| `GET /runs/:ticket/journal` ❌ | `GET /studio/runs/:ticket/journal` (studio-runs.ts:80) |
| `GET /runs/:ticket/evidence` ❌ | `GET /studio/runs/:ticket/evidence` (studio-runs.ts:113) |

`apps/bff/src/routes/runs.ts` yalnızca üç yol kaydediyor: `/runs`, `/runs/:ticket`,
`/runs/:ticket/signals/:name`. Alt kaynak yok → Fastify **404** döner.

**Alan adı da uyuşmuyor.** Studio `{ entries: JournalEntry[] }` bekliyor
(`runs.ts:103`); BFF `pageBody()` ile `{ items, nextCursor }` gönderiyor
(`studio-runs.ts:92` + `paging.ts:43-45`). Yol düzeltilse bile `entries`
`undefined` olur ve defter **sessizce boş** görünür — hata bile vermez.

**Neden kritik:**
1. Bu, brifingte "v1'in ölüm sebebi" diye işaretlenen kusurun aynısı: var olan bir
   ucu uydurma bir yoldan çağırmak.
2. `detail` ekranının "Ticket defteri" sekmesi ve `evidence` ekranının **tamamı**
   üründe hiç çalışmıyor. `evidence` ekranı denetim kanıtı ekranı — bir bankada
   denetçinin kanıt paketine baktığı yer.
3. Kod **kendi yalanını belgeliyor**: `runs.ts:97` ve `:120` yorumları
   *"ENDPOINT REQUEST (not implemented by the BFF today)"* diyor,
   `JournalTab.tsx:200` ve `Evidence.tsx:26` aynısını tekrarlıyor. Uç **zaten
   yazılmıştı**.

**Kanıt (git sırası):** BFF uçları `b00eeec` (`wave-4: BFF studio read-model API,
17 endpoints`) commit'inde geldi; küme A'nın ekranları **ondan sonra** `3dbc03d`
ve `f199ebb` ile girdi. Yani ajan var olan bir yüzeyi kaçırdı, sonra yokluğunu
rapora "uç isteği" olarak yazdı. Küme B (`4b29d3b` — *"rewire management screens
onto the real /studio endpoints"*) bu düzeltmeyi kendi ekranlarında yaptı; küme
A'nın `shared/runs.ts`'i **hiç dokunulmadan kaldı** (küme B raporu §0.1:
*"`shared/` altındaki hiçbir dosya değiştirilmedi"*).

**Hiçbir test bunu yakalamıyor**, çünkü `test/harness.tsx:66-70` eşleşmeyen her
yola 404 `not_found` dönüyor ve testler tam olarak o 404'ü "beklenen davranış"
diye pinliyor. Test, yanlışı doğrulamış oluyor.

**Aynı sınıftan ikinci sorun:** `useRuns` / `useRunState` (`runs.ts:71`, `:90`)
`GET /runs` ve `GET /runs/:ticket` kullanıyor. Bunlar **var** ve çalışıyor, ama
BFF `/studio/runs`'ı özellikle Studio için yazmış — küme A raporunun §5.1'de
"en yüksek öncelikli uç isteği" diye istediği `step`/`runStatus`/`risk`/`appId`
alanlarının **hepsi** zaten `/studio/runs`'ta mevcut (`studio-runs.ts:27-56`,
`{...record, state}` ile `WorkflowRunState` join'li). `dash`, `tickets`, `fanout`
ve `clarify` ekranları var olan veriyi kullanmadıkları için gereğinden zayıf.

---

## Y1 — (YÜKSEK) Sunucudan gelen tanınmayan bir enum **tüm ekranı karartıyor** (`MissingMessageError`)

**Dosyalar:** `Users.tsx:111,113,175` · `Sandbox.tsx:54` · `Cost.tsx:135,158` ·
`Llm.tsx:106,154,180` · `Variants.tsx:55` · `Variant.tsx:81` · `Notify.tsx:38` ·
`Commands.tsx:63` · `Dash.tsx:132` · `Tickets.tsx:245` · `Security.tsx:112` ·
`Settings.tsx:57` · `Runners.tsx:145` · `Cache.tsx:110` · `Routing.tsx:70`

`t()` eksik anahtarda **fırlatıyor** (tasarım gereği) ve `ErrorBoundary` bunu
kırmızı panele çeviriyor. Statik anahtar için doğru. Ama yukarıdaki satırlar
anahtarın son parçasını **sunucudan** alıyor.

Küme B bu tuzağı gördü ve `useLabel(key, fallback)` yazdı
(`src/screens/common/label.ts`) — **kendi 5 ekranında** kullanıyor. Küme A ve C
kullanmıyor.

**Kanıtladım (geçici probe testi, sonra silindi):**

```
MissingMessageError: missing message "role.release-manager" for locale "tr"
  ❯ src/screens/Users.tsx:175:24  ❯ UserCard src/screens/Users.tsx:173:30

MissingMessageError: missing message "sandbox.state.archived" for locale "tr"
MissingMessageError: missing message "llm.role.reviewer_x" for locale "tr"
```

Üçü de **canlı** uçlardan geliyor:

- `Users.tsx` — `DirectoryUser.roles`. Studio bunu `readonly Role[]` diye tipliyor
  (`common/admin-api.ts:70`) ama BFF'in gerçek tipi `readonly string[]`
  (`apps/bff/src/deps.ts:95`) ve `GET /studio/users/:username` dizinden geleni
  **filtresiz** geçiriyor (`studio-catalog.ts:122-127`). Kurumsal AD'de
  `Role` birleşiminde olmayan tek bir grup adı → **users ekranı komple ölür**.
  Yani "pasifleştirilmiş hesabı görebiliyor muyum" sorusunun cevabı bazı
  hesaplarda "ekran hiç açılmıyor" oluyor.
- `Sandbox.tsx:54` — `SandboxRecord.state`. Bugün 3 değer; 4.'sü eklendiğinde
  filo ekranı kararır.
- `Cost.tsx` / `Llm.tsx` — `LlmCallLog.role` ve `.dataClass`.

**Neden yüksek:** `ErrorBoundary` **tüm ekranı** değiştiriyor, tek satırı değil.
Bilinmeyen bir kayıt yüzünden bilinen 200 kaydın hepsi kayboluyor — `useLabel`
yorumunun (`label.ts:11-14`) kelimesi kelimesine tarif ettiği felaket, sadece
başka ekranlarda.

**Not:** `severity.ts` ve `outcome.ts` bu sorundan **muaf** — normalize edip
kapalı kümeye indiriyorlar. Doğru desen zaten depoda var, tutarlı uygulanmamış.

---

## Y2 — (YÜKSEK) Kapı reddi gerekçesinin **ikinci savunma katmanı hiç test edilmiyor**

**Dosya:** `apps/studio/src/screens/shared/signals.ts:68`

```ts
if (decision === "reject" && trimmed === "") throw new MissingReasonError();
```

Küme A raporu §4'te bunu mutasyon tablosuna koymuş:
> | Ret gerekçesi zorunluluğunu kaldır | `refuses to send a rejection without a reason` |

**Doğrulamada bu iddia düştü.**

- **Mutasyon:** yalnız `signals.ts:68`'i sil → **177/177 test yeşil kaldı.**
- **Mutasyon:** `GatePanel.tsx`'teki `disabled={reasonMissing}` + `submit()`
  içindeki dalı da sil → **o zaman** `refuses to send a rejection without a reason`
  kırıldı.

Yani test **yalnızca `GatePanel`'in butonu pasifleştirmesini** ölçüyor
(`flow-screens.test.tsx:286` → `expect(submit).toBeDisabled()`). `useGateDecision`
içindeki gerçek son-kapı hiçbir testle korunmuyor.

**Neden yüksek:** Rapor "mutasyonla doğruladım" diyerek bir korumayı doğrulanmış
gibi sunuyor; gerçekte o satır silinse **hiçbir uyarı çıkmaz**. `GatePanel`
dışından `useGateDecision` çağıran ikinci bir çağrı noktası eklendiği gün (ki
`signals.ts` paylaşılan veri katmanı, tam olarak bunun için var) gerekçesiz ret
istemciden çıkar. BFF `reject_needs_reason` ile 400 döndüğü için **veri kaybı
yok** — bu yüzden K değil Y. Ama denetim raporunun doğruluğu açısından ciddi:
**"mutasyon testiyle doğruladım" iddiası bu maddede yanlıştır.**

---

## Y3 — (YÜKSEK) Ham sunucu metni kullanıcıya basılıyor (`security` ekranı)

**Dosya:** `apps/studio/src/screens/Security.tsx:89`

```ts
{ key: "finding", header: t("security.col.finding"), cell: (row) => row.finding.message },
```

`ScanFinding.message` sözleşmede `NonEmpty` — yani **serbest metin**
(`packages/contracts/src/scan.ts:17`). Kaynağı Semgrep/Trivy/Gitleaks gibi harici
tarayıcılar. Bu, iskelet raporu §6'nın ve `QueryState.tsx:10-12` yorumunun
("*a raw string reaching the DOM is the regression this wrapper exists to
prevent*") açıkça yasakladığı şey.

**Neden yüksek:**
1. **Kural ihlali** — proje "kullanıcıya görünen her metin katalogdan" diyor;
   burada üçüncü parti bir aracın İngilizce cümlesi Türkçe arayüze basılıyor.
2. **Güvenlik boyutu var:** Gitleaks bulgularının `message` alanı sızan sırrın
   bir parçasını taşıyabilir; `Security.tsx` bunu hiçbir maskeleme olmadan
   ekrana yazıyor. `pii` ekranında titizlikle korunan kural burada delinmiş.
3. `label(...)` / `useLabel` deseni tam bu iş için depoda mevcut, kullanılmamış.

**Karşılaştırma:** aynı satırın hemen altında `file`/`line` `<code>` içinde
gösteriliyor — o **makine kimliği**, sorun değil. Sorun `message`, çünkü o düzyazı.

**İkinci örnek (daha düşük):** `KillSwitchPanel.tsx:100` —
`state.data.reason`, önceki bir adminin serbestçe yazdığı gerekçe metni,
doğrudan basılıyor. Bu bir *operatör* metni (sunucu metni değil) ve denetim izinde
görünmesi gerekiyor, o yüzden savunulabilir; ama kaynak yine katalog dışı.

---

## O1 — (ORTA) Dört-göz: kendi önerisini onaylıyormuş gibi görünen buton

**Dosya:** `apps/studio/src/screens/params/ParamEditor.tsx:49-50, 72-76`

```ts
const confirming = pending !== null && guarded && formatValue(pending.value) === draft.trim();
// ...
{guarded ? (confirming ? t("params.action.approve_change") : t("params.action.propose")) : t("action.save")}
```

`confirming` hesabı `pending.proposedBy` ile **oturumdaki kullanıcıyı
karşılaştırmıyor**. Öneriyi yapan kişi ekranı tekrar açtığında buton
**"Değişikliği onayla"** yazıyor — oysa BFF o isteği onay saymıyor:
`params-service.ts:81` `samePerson(open.proposedBy, request.actor)` ile yakalayıp
yeniden `status: "pending"` döndürüyor.

**Sonuç:** operatör "onayladım" diyor, sistem "hâlâ bekliyor" diyor. Yanlış
karar değil (sunucu fail-closed doğru), ama **yanlış zihinsel model** — dört-göz
kuralının en tehlikeli yanlış anlaşılması. `pending.proposedBy` zaten elde
(`Params.tsx:104` onu ekranda gösteriyor bile), karşılaştırma tek satır.

---

## O2 — (ORTA) BFF'in `/studio/*` okuma yüzeyinin bir kısmı hiç kullanılmıyor; ekranlar var olmayan uçlar için yazılmış

Studio'nun çağırdığı **14 yol BFF'te yok**: `/settings`, `/notify`, `/commands`,
`/mcp/manifest`, `/repo-policy`, `/onboarding*`, `/template*`, `/doc-template`,
`/variants*`, `/eval`, `/cache`, `/greenfield`, `/routing`, `/pii`, `/decisions`.

Bunların **kasıtlı** olduğu (uç yok → `MaybeUnwired` "henüz yayında değil")
raporlarda yazılı ve `unwired.tsx` ile dürüstçe ele alınmış — bu **spec dışına
taşma değil**, kabul edilebilir. Ama aynı anda BFF'in **yazılmış** uçlarından
üçü hiç kullanılmıyor:

| BFF'te var, Studio kullanmıyor | Kullanabilecek ekran |
|---|---|
| `GET /studio/gates` (`waitingDays` dahil) | `notify` "bekleyenler" kartı — bugün uydurma `/notify` ucunu bekliyor |
| `GET /studio/apps`, `/studio/apps/:appId/repo-card` | `fanout` etki matrisi, `routing` uygulama listesi |
| `GET /studio/runs*` ailesi | K1'de anlatıldı |

Küme B raporu §4.3 `/studio/gates`'in varlığını **fark etmiş** ve not düşmüş
("*`/studio/gates` bekleyen kapıları zaten veriyor*"), ama ekranı ona
bağlamamış. Yani bilgi vardı, uygulanmadı.

---

## O3 — (ORTA) `Users` ekranı pasif hesabın **yetkilerini** normal renkte gösteriyor

**Dosya:** `apps/studio/src/screens/Users.tsx:374-410`

Pasif hesapta üstte kırmızı `users.state.disabled` rozeti ve altta token ömrü
uyarısı var (`:414-418`) — bu **iyi** ve testi var. Ancak roller listesi
(`:399-407`) aktif hesapla **birebir aynı** renkte basılıyor: `admin` rolü mor
rozetiyle, sanki hâlâ yürürlükteymiş gibi.

Brifingteki soru "pasifleştirilmiş hesap arayüzde hâlâ yetkili görünüyor mu?"
— cevap: **kısmen evet**. Uyarı metni doğru şeyi söylüyor ama görsel dil onu
yalanlıyor. Rozetlerin soluklaştırılması / üstü çizilmesi gerekirdi.

---

## D1 — (DÜŞÜK) `slugify` içinde ölü dal: `İ` eşlemesi hiç çalışmıyor

**Dosya:** `apps/studio/src/screens/template/model.ts:252-273`

`TR_FOLD` sözlüğünde `İ: "i"` var ve regex `[çğıİöşü]` onu arıyor — ama
`.toLowerCase()` **önce** çalışıyor ve JS'te `"İ".toLowerCase()` → `"i̇"`
(i + birleşen nokta). Yani `İ` regexe hiç ulaşmıyor.

```
node> "İ".toLowerCase()            → "i̇"
node> /[çğıİöşü]/.test("İ".toLowerCase()) → false
```

**Etkisi yok** — sonraki `.normalize("NFD").replace(/[̀-ͯ]/g,"")` birleşen noktayı
zaten siliyor, `slugify("İstanbul Şubesi")` → `istanbul_subesi` doğru çıkıyor.
Ama sözlük girdisi ve regex karakteri **ölü kod**; okuyanı korumanın oradan
geldiğine inandırıyor. Türkçe başlıklarla denedim, hepsi doğru:
`"Işık ölçümü"` → `isik_olcumu`, `"Kapsam (dahil / hariç)"` → `kapsam_dahil_haric`,
`"Çıkış / Giriş"` → `cikis_giris`.

---

## D2 — (DÜŞÜK) `ErrorBoundary` `error.message`'ı ekrana ve `console`'a basıyor

**Dosya:** `apps/studio/src/app/ErrorBoundary.tsx:29, 51`

`console.error("[studio] render failed", error, info.componentStack)` ve
`{error.name}: {error.message}`.

Kendi yorumu bunu gerekçelendiriyor ("*katalog bozuksa katalog araması sorunu
anlatamaz*") ve gerekçe geçerli. Ancak `ApiError.message` `` `api ${status} ${code}` ``
üretiyor (`errors.ts:273`) — bir render hatası bir `ApiError` sarmalarsa HTTP kodu
son kullanıcı ekranına düşer. Üretimde bu panelin **kod göstermeyen** bir
sürümü olmalı. Sırrı sızdırmıyor, o yüzden düşük.

---

## D3 — (DÜŞÜK) `Table` `caption` ve toast metinleri tutarsız kullanılıyor

Küme A ekranları `caption={t(...)}` veriyor (`Evidence.tsx:138`), küme B/C
ekranları çoğunlukla vermiyor. Ekran okuyucu deneyimi ekrandan ekrana değişiyor.
Kural ihlali değil, tutarsızlık.

---

## Bakılıp **temiz çıkan** maddeler

- **Fail-open yol:** kapı kararı, kill switch, dört-göz, knowledge sınıfı,
  `LlmOutcome`, `severity`, `poolOutcome` — **hepsi fail-closed**. Belirsiz
  durumun sessizce "izin ver"e düştüğü tek bir yol bulamadım.
- **Auth:** veri çeken **her** yol `useApi()` üzerinden gidiyor; `ApiClient`
  her isteğe bearer ekliyor (`client.ts:180`), 401'de `onSessionLost` →
  `RequireSession` → `/login` (`client.ts:246-249`). 403'te oturum
  **düşürülmüyor** (doğru). `test/api-client.test.ts` ikisini de pinliyor.
- **`canDecideGate` güvenlik sanılıyor mu:** hayır. Üç ayrı dosyada
  ("bu güvenlik değildir") yazılı ve `auth.test.tsx` gizli ekranın URL ile
  **açıldığını** bilerek doğruluyor.
- **Sır sızıntısı:** token `localStorage`/URL/log/hata mesajında **yok**;
  yalnız `useRef`'te. `localStorage`'da sadece `maestro.locale`.
- **Kill switch tek tık:** hayır — buton → modal → zorunlu gerekçe → geri
  alınamaz uyarısı. 3 test + 2 mutasyonla doğrulandı.
- **`template` bölüm silme/sıralama:** son bölüm silinemiyor, aralık dışı taşıma
  no-op, her mutasyon yeni draft, `id` wire'a gitmiyor. 24 birim testi + mutasyon
  doğrulandı.
- **Spec dışına taşma:** ağır UI kit yok, gereksiz bağımlılık yok, `screens.ts` /
  `routes.tsx` / `screen-components.ts` hiçbir küme tarafından değiştirilmemiş.
- **`queryKey` çakışması:** `["quota"]` ve `["cost","calls"]` `Cost`/`Llm`
  arasında **kasıtlı** paylaşım (aynı uç, aynı şekil) — doğru önbellek davranışı,
  çakışma değil.

---

## Karar

# `KALDI`

**Gerekçe:** Paket disiplinli yazılmış — fail-closed davranış gerçek, testler
mutasyonla kırılıyor, gömülü metin yok, parite tam, sır sızıntısı yok. Ama:

1. **K1** tek başına yeterli: `evidence` ekranının tamamı ve `detail`'in defter
   sekmesi, **BFF'te zaten yazılmış** uçları yanlış yoldan çağırdıkları için
   üründe çalışmıyor. Alan adı da (`entries` ↔ `items`) uyuşmuyor, yani yol
   düzeltilse bile sessizce boş görünür. Bu, brifingin "v1'in ölüm sebebi" diye
   işaretlediği hata sınıfının birebir tekrarı — üstelik kod, var olan ucun
   yokluğunu **belgeleyen yorumlar** taşıyor.
2. **Y1** canlı bir uçtan gelen tek bir beklenmedik dizgenin **tüm ekranı**
   karartmasına izin veriyor; `users` ekranında bu, kurumsal AD'nin
   sözleşmedeki 6 rolün dışında bir grup adı döndürmesi kadar yakın.
3. **Y2** raporlanan bir mutasyon doğrulamasının **gerçekte yapılmadığını**
   gösteriyor. Kusurun kendisi orta şiddette (BFF ikinci kapıyı tutuyor), ama
   bir doğrulama iddiasının yanlış çıkması diğer iddiaların ağırlığını düşürüyor.
4. **Y3** projenin en net kuralını (ham sunucu metni basma) tarayıcı bulgusu
   metniyle deliyor — ve o metin sızan sır parçası taşıyabilen tek alan.

**Düzeltme için gereken minimum:** K1'de iki yolu `/studio/runs/...` yap ve
`JournalResponse`'u `{ items, nextCursor }`'a çevir (uçlar hazır, iş küçük);
Y1 için `useLabel`'ı A ve C kümelerine yay; Y2 için `signals.ts:68`'e doğrudan
bir birim testi yaz; Y3 için `finding.message`'ı katalog anahtarına veya
en azından bilinçli bir "ham tarayıcı çıktısı" kabına al. Bunlar yapılırsa
paket geçer — kalan bulgular O/D seviyesinde ve bloklamaz.
