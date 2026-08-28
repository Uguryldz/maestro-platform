# @maestro/publish — builder raporu

Belge üretimi + `PublishPort` sürücüleri (M47): **jira · confluence · repo-docs**, artı sözleşmede
duran ama Aşama 2'ye ait **docx/pdf** hedefleri (M103 — sessizce yok sayılmıyor; artık **kurulum anında**
`CapabilityNotSupportedError`, koşu ortasında değil).
Belgeler: 7 bölümlü analiz dokümanı (M43), kanıt paketi özeti, merge sonrası release notu taslağı (M91).
Şablon sürümü belgeye yazılıyor (M83), dil parametreden geliyor (M59/M104).
Yayınlanan her belge, hedeflere dağıtılmadan **önce** `@maestro/pii` sınırından geçiyor (M20/M82).

> Bu sürüm, bağımsız doğrulama turunun 13 bulgusunu kapatır. Bulgu → düzeltme → test eşlemesi **§9**'da.

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/md.ts` | Markdown yazıcı (`Markdown`) + kaçış kuralları + `documentHeader` (M83 şablon pini) + `label()` (katalog araması, boş çeviri = hata) + `contentHash` (sha256, idempotans parmak izi). Bilet/model/kullanıcıdan gelen HER metin kaçırılıyor: satır başındaki `#`, `-`, `1.`, fence işaretleri etkisizleştiriliyor — analiz metnine gömülü bir `# Başlık` sahte bölüm açamıyor. |
| `src/keys.ts` | Paketin ürettiği TÜM mesaj anahtarları (`MSG`) + dinamik aileler (`publish.risk_tier.*`, `publish.impact_source.*`, `publish.decision.*`) + `publishMessageKeys()`. Kullanıcıya dönük tek bir metin bile kodda yok. |
| `src/documents.ts` | `renderAnalysisMarkdown` (7 zorunlu bölüm, sırayla; `AnalysisDoc.parse` ile fail-closed), `renderEvidenceSummaryMarkdown` (dosyalar + onay zinciri + saklama/Object Lock), `renderReleaseNoteMarkdown` (M91) + `ReleaseNoteDraft` Zod şeması. Belgenin dili ile istenen çıktı dili uyuşmazsa **reddediliyor**. |
| `src/parse.ts` | Markdown okuyucu (başlık, paragraf, madde/numaralı liste, fenced kod, `**kalın**`, `` `kod` ``, bağlantı, `\` kaçışları, HTML yorumu atlama). Modellenmeyen sözdizimi düz metne düşüyor, kaybolmuyor. **Kapanmayan `<!--` kendi satırında biter** (eskiden belgenin geri kalanını yutuyordu). Girişte `stripUnsafeChars` süzgeci. `safeHref`: yalnız `http(s)`/`mailto`; `javascript:`/`data:` bağlantı olmuyor. |
| `src/adf.ts` | Markdown → ADF (WorkPort'un kabul ettiği düğüm kümesi). Jira adaptörü **import edilmiyor** (M44 temiz oda) — iki taraf portta buluşuyor. Numaralı liste, DC alt kümesinde karşılığı olmadığı için numarası metne yazılarak madde listesine çevriliyor (bilgi kaybı yok). `defuseWikiMarkup`: satır başı `hN.`/`bq.`/`----`/liste işaretleri ve `!...!` görsel makrosu metin düğümüne yazılmadan etkisizleştiriliyor — DC yorumları **wiki markup** olarak render edildiği için bunlar metin değil, biçimdir. |
| `src/storage-format.ts` | Markdown → Confluence storage format (XHTML alt kümesi + `code` makrosu). Kendi yazıldı, bağımlılık yok. `& < > " '` kaçırılıyor, `]]>` CDATA'yı kapatamıyor, tanınmayan dil parametresi düşürülüyor, güvensiz bağlantı düz metne çevriliyor. |
| `src/drivers/jira.ts` | `JiraPublisher` — WorkPort üzerinden ADF yorum. **M75**: (koşu, belge) çiftinin yorum id'si hatırlanıyor; yeniden yayında yorum **düzenleniyor**, ikincisi açılmıyor; içerik aynıysa Jira'ya hiç dokunulmuyor. |
| `src/drivers/confluence.ts` | `ConfluencePublisher` + `ConfluencePublishConfig` — REST v1 `/rest/api/content`. Sayfa yoksa oluşturur, varsa sürüm+1 günceller; **409'da sürümü yeniden okuyup sınırlı sayıda dener**; "bu başlık zaten var" (400) yanıtında sayfayı **sahiplenir**, kopya açmaz; içerik birebir aynıysa sürüm harcamaz. 404 yalnızca `locate()`'in GET'lerinde `null`'a çevrilir — PUT/POST'ta hata olur. `baseUrl` **https zorunlu** (`allowInsecureHttp` açık kaçış). Token `SecretPort`'tan (M80), boş token'la istek **atılmaz**. `fetch` enjekte. |
| `src/drivers/repo-docs.ts` | `RepoDocsPublisher` + `RepoDocsPublishConfig` — `ScmPort` ile dal + PR, enjekte `RepoWorkspace` ile dosya/commit (kendi git istemcisi yok). Aynı içerik commit **edilmiyor**; ikinci PR açılmıyor. **PR'ın durumu tanık**: merge/abandon edilmiş PR döngüyü kapatır, sonraki revizyon `-r1` dalı + yeni PR ile gider (M54 ret döngüsü). Her yan etkiden **hemen sonra** defter yazılır; makbuz her zaman commit sha'sıdır. Commit mesajı/dal adı/PR başlığı İngilizce (M59), belge gövdesi Türkçe. |
| `src/port.ts` | `MaestroPublishPort` (`PublishPort`): önce **maskeleme** (`PublishRedactor`, zorunlu kurucu argümanı), sonra `req.targets` üzerinde sırayla fan-out, hedef başına bir makbuz. Bir hedef patlarsa yayın patlar (kısmi makbuz listesi yok). |
| `src/pii.ts` | **PII sınırı (M20/M82)**: `createPublishRedactor(deps.pii, deps.runContext)`. Maskeleme port seviyesinde bir kez yapılır — üç hedef de aynı maskeli baytları alır, sonradan eklenecek bir sürücü "maskelemeyi unutamaz". Oturum nonce'u `runId`'den türetilir (idempotans: rastgele nonce her yayında farklı bayt üretirdi). ReverseMap fonksiyondan hiç çıkmaz. `assertNoPii` ile fail-closed. |
| `src/register.ts` | `registerPublishDrivers(registry, deps)` (M44): hedef başına bir sürücü + proje hedef kümesini karşılayan `multi` sürücüsü. Eksik yapılandırma/bağımlılık **kurulum anında** hata veriyor, koşu ortasında değil. |
| `src/types.ts` | Enjekte edilen işbirlikçiler: `Translate` (katalog), `RunContextResolver`, `PublishStateStore` (+ `InMemoryPublishState`, yalnız test/demo), `RepoWorkspace`, `FetchLike`, `PublishDeps`. |

**Üretim kodu: 14 dosya**, en büyük dosya 263 satır (`drivers/confluence.ts`; tavan 300).

### İdempotans — üç hedefte de kanıtlı
| Hedef | Aynı belge ikinci kez yayınlanınca | Belge değişince |
|---|---|---|
| jira | Jira'ya **hiç istek gitmiyor**, aynı yorum id'si makbuz olarak dönüyor | aynı yorum `updateComment` ile düzenleniyor (M75) |
| confluence | **PUT atılmıyor**, sayfa sürümü artmıyor, aynı sayfa id'si dönüyor | aynı sayfa sürüm+1 (ikinci sayfa yok) |
| repo-docs | commit **yok**, ikinci PR **yok**, aynı sha dönüyor | PR hâlâ açıksa aynı dalda yeni commit; PR merge/abandon edilmişse `-r<n>` dalı + yeni PR |

Uçtan uca test (`test/end-to-end.test.ts`) bunu üç hedefte birlikte ispatlıyor: analiz belgesi → markdown →
jira + confluence + repo-docs; ikinci yayında hiçbir yerde yeni bir nesne oluşmuyor.

## 2. Testler

`pnpm -F @maestro/publish test` → **11 dosya / 127 test, hepsi yeşil.** Tamamen çevrimdışı ve deterministik:
ağ yok (fetch enjekte, bellek içi sahte Confluence), dosya sistemi yok, saat yok — belgeler **zaman damgası
içermiyor**, bu yüzden aynı girdi her seferinde aynı byte dizisini üretiyor (idempotansın ön koşulu).
Maskeleme de deterministik (oturum nonce'u `runId`'den türetiliyor), yoksa idempotans çökerdi.

- `documents.test.ts` (22): 7 bölüm ve sırası · M83 şablon pini + marker satırı · etki matrisi satırları ve kaynağı (M100) · risk katmanının katalogdan gelmesi · byte-birebir tekrarlanabilirlik · dil parametresi (tr/en) · dil uyuşmazlığı reddi · eksik bölüm ve boş etki matrisi reddi (fail-closed) · analiz metnine gömülü markdown enjeksiyonunun etkisizleşmesi · kanıt paketi dosya/onay/saklama satırları · başka koşuya/bilete ait paket reddi · release notu (M91) alanları ve "yayın insan işi" notu · M104 disiplini: üretilen her anahtar pakette **beyan edilmiş**.
- `parse.test.ts` (17): başlık seviyeleri, paragraf birleştirme, madde/numaralı liste ayrımı, girintili devam satırı, fenced kod (kapanmamış fence dahil), HTML yorumlarının atılması, **kapanmayan yorumun belgeyi yutmaması (F5)**, **XML'de yasak kontrol karakterleri + bidi/görünmez unicode süzgeci (F3/F11)**, modellenmeyen sözdiziminin düz metne düşmesi, satır içi işaretler ve `\` kaçışları, `safeHref` kabul/ret listesi.
- `adf.test.ts` (11): doc zarfı, başlık seviyesi kırpma, strong/code/link markları, güvensiz bağlantının markdan arındırılması, numaralı liste dönüşümü, `listItem > paragraph` yerleşimi, boş metin düğümü üretmeme, tam analiz belgesinin bölüm kaybetmeden dönüşmesi, **satır başı wiki blok açıcılarının etkisizleşmesi**, **`!...!` görsel makrosunun etkisizleşmesi**, kendi başlık/liste düğümlerimize dokunulmaması (F4).
- `jira-contract.test.ts` (5) — **ÇAPRAZ PAKET SÖZLEŞME TESTİ, yeni**: `@maestro/publish` ADF üretir → `@maestro/adapter-jira` `toAdfDocument`+`adfToWikiMarkup` ile DC'nin sakladığı wiki markup'ı üretir. Analiz metni ne sahte `h1.`/`bq.` başlığı açabiliyor, ne `----` çizgisi çizebiliyor, ne sahte madde listesi kurabiliyor, ne de `!http://…!` ile dış ağdan görsel çekebiliyor; adaptörün zaten sahip olduğu `{}[]|` kaçışları korunuyor; gerçek analiz belgesi bizim kendi başlıklarımızla (8×`h2.`) doğru render oluyor. **Bulgunun kaçmasının sebebi tam olarak bu testin olmamasıydı**: iki paketin kendi süitleri yeşilken bileşimleri değildi. Adaptör buraya yalnız **devDependency** olarak giriyor; üretim kodu onu hâlâ import etmiyor (M44).
- `pii.test.ts` (8) — **yeni**: maskeleme üç egress'in (Jira yorumu, Confluence sayfası, git commit'i) hiçbirine ham TCKN/IBAN/kart/e-posta/telefon bırakmıyor · maskeleme deterministik (idempotans korunuyor) · onaylayan personelin adresi ve M83 şablon pini **açıkça listelenmiş istisna** olarak okunur kalıyor · listelenmemiş pin sessizce bozulmuyor, yayın **reddediliyor** · istisna listesi verilenin ötesine genişlemiyor · tanınmayan veri sınıfı en katı profile düşüyor (M18/M63) · denetim kancası yalnız sayım görüyor · politikasız kurulum reddediliyor.
- `storage-format.test.ts` (10): blok eşlemesi, `ol`/`ul`, code makrosu + CDATA, sahte dil parametresinin düşürülmesi, `<script>`/`<ac:...>` kaçışı, **CDATA kapatma saldırısı** (tek makro kalıyor), güvenli/güvensiz bağlantı, href tırnak kaçışı, marker yorumunun atlanması, tam belgenin dengeli markup üretmesi.
- `jira-driver.test.ts` (8): ADF gövdeli yorum, aynı belgede **sıfır** Jira çağrısı, değişen belgede `updateComment` (M75), belge türü başına ayrı yorum, bozuk kayıtta başkasının yorumunu düzenlememe, boş yorum id'si reddi, WorkPort'suz kurulum reddi, **boş ADF üreten belgenin reddi (F5)**.
- `confluence-driver.test.ts` (15): oluşturma (storage format + Bearer + space), güncelleme (tek sayfa, sürüm+1), değişmemiş belgede sürüm harcamama, **409 yarışında yeniden okuyup başarma**, sürekli 409'da gürültülü teslim olma, sayfa başlığı değişse bile hatırlanan id'yi izleme, boş token'la istek atmama, 500 → tipli hata, eksik alanlı yanıtın reddi, yapılandırma doğrulaması, **https zorunluluğu + `allowInsecureHttp` (F6)**, **silinmiş sayfaya PUT'ta sessiz başarı yerine hata (F1)**, **bilet başına tek yaşayan sayfa: ikinci koşu aynı sayfayı güncelliyor (F7)**, **"bu başlık zaten var" 400'ünde sayfayı sahiplenme, kopya açmama (F12)**, **boş sayfa üreten belgenin reddi (F5)**.
- `repo-docs-driver.test.ts` (15): dal + commit + PR sırası, İngilizce commit/PR metinleri (M59), değişmemiş belgede commit/PR yokluğu, değişen belgede aynı dal + tek PR, **PR merge edilip dal silindikten sonra yeni dal + yeni PR (F2)**, **PR açıkken aynı dalda kalma (F2)**, **commit ile PR arasında ölen yayında ikinci PR açılmaması (F8)**, belge türü başına ayrı dosya, kayıt kaybolsa bile aynı içeriğin yeniden commit edilmemesi **ve makbuzun dosya yolu değil commit sha'sı olması (F8)**, sha'yı söyleyemeyen workspace'te gürültülü ret, uygulamasız koşunun reddi, boş sha reddi, PR'sız mod, `..` içeren yol reddi, workspace'siz kurulum reddi.
- `register.test.ts` (13): hedef sırasına göre makbuzlar, tekrarlanan hedefin bir kez yayını, **docx/pdf'in KURULUM anında reddi (F9/M103)**, karışık hedef kümesinde hiçbir hedefe dokunulmaması, kurulmamış hedefin reddi, boş belge/geçersiz istek reddi, bir hedef patlayınca kısmi makbuz olmaması, sürücü adları, registry'den çözülen portun gerçekten çalışması, `multi` sürücüsünün proje hedef kümesi, hedef kümesi verilmeyen `multi` reddi, eksik bağımlılık/bilinmeyen yapılandırma anahtarı reddi.
- `end-to-end.test.ts` (3): üç hedefe tek belge, ikinci yayında hiçbir yerde yeni nesne, revize belgede "aynı yorum + sonraki sürüm + bir commit daha".

**Her düzeltmenin önce kırılan bir testi var.** Düzeltmeler tek tek geri alınarak doğrulandı: F1 geri
alındığında test `{ target: 'confluence', ref: '555' }` ile "çözüldü" diyor (raporlanan kanıtın aynısı),
F7'de anahtar `null` dönüyor, F12'de POST 400 ile patlıyor, F2/F8'de yeni dal açılmıyor ve PR sayısı 0
kalıyor, F4'te çapraz paket testinin 5 testinden 3'ü düşüyor.

## 3. Katalog anahtarları (M104) — TAMAM

Paketin ürettiği 46 anahtar `packages/config/locales/{tr,en}.json` dosyalarına **eklendi** ve
`packages/config/test/catalog-usage.test.ts`'in `KEY_LITERAL` düzeni artık `publish` ön ekini de tarıyor;
yani bu paketin ürettiği her anahtar iki dilde de aranıyor. Bu bölümün eski hâli (uzun "önerilen değerler"
listesi) geçersizdi, kaldırıldı. `deps.translate = t` bağlanabilir; `publishMessageKeys()` hâlâ
kompozisyon kökünde ön denetim için kullanılabilir.

## 4. Varsayımlar

1. **Belgeler zaman damgası taşımaz.** Üretim anı belgeye yazılsaydı aynı analiz her render'da farklı byte
   üretir, üç hedefteki idempotans kontrolü de çöpe giderdi. Zaman bilgisi zaten veriden geliyor
   (`EvidencePackage.createdAt`, onay kararlarının `at` alanı) ve Jira/Confluence/Git kendi zaman damgasını tutuyor.
2. **Jira gövdesi ADF'tir.** `WorkPort.addComment` "ADF ya da düz metin" kabul ediyor; DC'de wiki markup'a
   çeviri adaptörün işi (M46). Bu paket ADF üretir, Jira istemcisi kurmaz.
3. **Confluence REST v1** (`/rest/api/content`, `expand=version,body.storage`), DC ve Cloud v1'de aynı.
   Gerçek instance'tan kayıtlı fikstür **henüz yok** (insa-plani §6): testler elle yazılmış, sözleşmeye sadık
   bir sunucu ikizi kullanıyor. Erişim geldiğinde Aşama-0 duman testinde doğrulanmalı — özellikle kurum
   context path'i, proxy ve `title` araması (aynı space'te aynı başlık kuralı).
4. **Confluence kimliği BİLET başınadır, koşu başına değil.** Bir ticket'ın analiz belgesi, o ticket'ın
   kaç koşusu olursa olsun **tek yaşayan sayfadır**: ikinci koşu aynı sayfayı günceller, üzerine yazar.
   İnsanlar Confluence'ı böyle kullanıyor (link paylaşılır, favorilere eklenir) ve önceki hâller
   **Confluence'ın kendi sürüm geçmişinde** durur — kaybolmaz, "sayfa geçmişi"nden okunur. Defter anahtarı
   da artık başlıkla aynı kapsamda (`publish:confluence:<TICKET>:<belge>`); eskiden anahtar koşu kapsamlıydı,
   başlık bilet kapsamlıydı ve üreten/tüketen aynı kimliği kullanmıyordu. **Koşu bazlı ayrı sayfa isteniyorsa**
   başlık anahtarı ve defter anahtarı birlikte değiştirilmelidir; tek başına biri yetmez.
5. **Aynı içerikte Confluence sürümü artırılmıyor.** Şart "ikinci kopya oluşmasın"dı; sürüm geçmişini
   anlamsız kayıtlarla şişirmemek denetim açısından da daha doğru (değişmemiş belge "değişti" görünmüyor).
   Kurum "her yayın bir sürüm" isterse tek satırlık parametre işi.
6. **`PublishStateStore` kalıcı olmalı.** `InMemoryPublishState` yalnız test/demo içindir. Kayıt kaybolursa:
   jira'da ikinci bir yorum açılır (kurtarılabilir), confluence'ta başlıkla bulunur (kopya oluşmaz — başlık
   araması indeks gecikmeliyse "başlık zaten var" 400'ü sayfayı sahiplenir), repo-docs'ta aynı içerik commit
   edilmez ve makbuz `RepoWorkspace.headSha` ile gerçek commit sha'sından gelir; workspace bunu söyleyemiyorsa
   yayın **reddedilir** (dosya yolunu commit gibi makbuzlamaktansa gürültülü hata). Dalga 3'te `db` tablosu
   ya da `StoragePort` üstünde bir gerçekleme enjekte edilmeli.
7. **Commit/dal/PR metinleri İngilizce** (M59), belge gövdesi proje diline göre. Dal adı:
   `docs/maestro/<TICKET>-<belge>`; dosya: `docs/maestro/<TICKET>/<belge>.md`.
8. **Katalog metinleri de kaçırılıyor.** Katalog bir veri dosyası; içine markdown karakteri girse bile
   belge yapısını bozamaz. Yan etkisi: katalogdaki `_`/`*` karakterleri belgede `\_` olarak görünür.
9. **PII istisnaları açıktır ve kompozisyon kökünden gelir.** `runContext(runId).piiExemptions` maskelemeden
   muaf tutulacak **tam değerleri** taşır. Buraya yalnız iki şey girer: (a) kapıları imzalayan personelin
   kurumsal adresleri — kanıt paketi zaten "kim onayladı" demek için var (M82), `[EMAIL_1.…]` onu yok ederdi;
   (b) **M83 şablon pini** — `analysis-template@1.4.0` dedektörler açısından bir e-posta adresidir. Pin
   listelenmezse sessizce token'a dönüşmez, yayın `PublishRenderError` ile durur ve kompozisyon köküne ne
   eklemesi gerektiği söylenir. Muafiyet, maskelemeden ÖNCE yer tutucuya çevrilip SONRA geri konarak
   uygulanır; yani `assertNoPii` tripwire'ı her zaman "muaf olmayan her tanımlayıcı token" hâli üzerinde çalışır.
   Müşteri verisi bu listeye **girmez**; girerse üç egress'e birden açık gider.
10. **Maskeleme portun içindedir, sürücünün değil.** Yeni bir hedef sürücüsü eklendiğinde maskelemeyi
   "unutmak" mümkün değil: `MaestroPublishPort` maskeli metni dağıtır, sürücüler ham metni hiç görmez.
11. **`markdownSource` port sözleşmesinde dışarıdan gelir.** Sürücüler onu ayrıştırır; belge üreticileri
   (`renderAnalysisMarkdown` vb.) aynı pakette ama ayrı kapıdır — workflow önce üretir, sonra yayınlar.

## 5. Bağımlılıklar

| Paket | Tür | Gerekçe |
|---|---|---|
| `@maestro/contracts` | runtime (workspace) | `AnalysisDoc`, `EvidencePackage`, `PublishRequest/Receipt/Target/DocKind`, ortak tipler. |
| `@maestro/ports` | runtime (workspace) | `PublishPort`, `WorkPort`, `ScmPort`, `SecretPort`, `PortRegistry`, `CapabilityNotSupportedError`. |
| `@maestro/pii` | runtime (workspace) | **Yeni, orkestratör kararı (F10)**: yayınlanan belge üç egress'e birden gidiyor ve biri git geçmişi. `compiledProfileFor`, `createSessionWith`, `maskText`, `assertNoPii`. |
| `@maestro/adapter-jira` | **dev** (workspace) | Yalnız `test/jira-contract.test.ts` için. Üretim kodu import etmiyor — M44 temiz oda korunuyor. |
| `zod` ^4 | runtime | Monorepo standardı; yapılandırma + uzak yanıt doğrulaması (fail-closed). |
| `node:crypto` | runtime (yerleşik) | İçerik parmak izi (sha256). |
| `@types/node`, `typescript`, `vitest` | dev | Paket sözleşmesi. |

**Yeni HARİCİ runtime bağımlılığı YOK** (eklenen ikisi de workspace paketi). Markdown okuma, ADF ve Confluence storage dönüşümü elle yazıldı.
`@maestro/adapter-jira` **import edilmedi** (temiz oda); `@maestro/config` de import edilmedi — çeviri
fonksiyonu enjekte ediliyor (§6.5).

## 6. Arayüz/bağımlılık talepleri (contracts/ports DONMUŞ — burada yalnız kayıt)

1. **`PublishRequest` bilet anahtarı taşımıyor.** İçinde yalnız `runId` var; jira yorumu bir ticket'a,
   repo-docs bir uygulamanın repo'suna yazılmak zorunda. Şimdilik `deps.runContext(runId) → {ticketKey, app?}`
   enjekte ediliyor. Öneri: `PublishRequest`'e `ticketKey` (+ opsiyonel `appId`) eklenmesi — çözücüyü
   ve onun hata yollarını tümden ortadan kaldırır.
2. **`ScmPort`'ta dosya yazma/commit yok** (`createBranch`, `openPr` var; `commitFile` yok). Bu yüzden
   `RepoWorkspace` arayüzü bu pakette tanımlandı (`readFile` / `commitFile` / opsiyonel `headSha`). Öneri:
   ya `ScmPort.commitFile(repo, branch, path, content, message): Promise<{sha}>` eklensin, ya da
   `RepoWorkspace` `packages/ports`'a taşınsın — Dalga 2 `execution`/runner tarafı da aynı yeteneğe ihtiyaç duyacak.
2b. **`ScmPort`'ta "bu dal var mı" yok.** F2'nin düzeltmesi "dalın varlığını doğrula" istiyordu; port DONMUŞ
   ve `branchExists`/`getBranch` yok. Bu yüzden tanık olarak **PR durumu** kullanıldı (`getPrStatus`):
   `completed`/`abandoned` PR, dalın kapandığı anlamına gelir ve sonraki revizyon `-r<n>` dalıyla gider.
   Bu, ADO'da "açık PR'ı olan dal silinmez" davranışına dayanıyor. **Öneri:** `ScmPort.branchExists(repo, name)`
   eklenmesi — o zaman tanık dolaylı değil doğrudan olur. PR açmayan kurulumda (`openPullRequest: false`)
   dal ölümü tespit edilemez; o modda dalı silen bir insan/otomasyon varsayılmıyor.
3. **İdempotans defterinin (`PublishStateStore`) portlarda karşılığı yok.** `WorkPort`'ta yorum listeleme/arama
   olmadığı için "bu koşunun analiz yorumu hangisiydi" sorusunun tek yanıtı hatırlanan id. Alternatif:
   `WorkPort.findComment(marker: string)` eklenmesi (o zaman defter gereksizleşir). Karar orkestratörün.
4. **`ReleaseNoteDraft` sözleşmesi contracts'ta yok** (M91). Bu pakette Zod ile tanımlandı:
   `{templateVersion, language, ticketKey, summary, changes[], docUpdates[], mergeSha, prId?}`.
   Studio/BFF gösterecekse `packages/contracts` altına taşınmalı.
5. **`Translate` enjekte ediliyor, `@maestro/config`'in `t`'si doğrudan çağrılmıyor.** Sebep: §3'teki
   anahtarlar henüz katalogda yok; doğrudan bağlansaydı paket kurulduğu gün `MissingMessageError` ile
   patlardı. Anahtarlar eklendikten sonra composition root `translate: t` geçer, imza birebir uyumlu.
6. **docx/pdf (M103) Aşama 2.** Şu an **kurulum anında** `CapabilityNotSupportedError` (F9). Geldiğinde markdown → HTML dönüşümü
   `storage-format.ts`'in kardeşi olacak; PDF için headless tarayıcı, docx için ayrı araç kararı gerekiyor
   (insa-plani §6b ile aynı hat).
7. **`MaestroPublishPort.targets()`** şu an yalnız testte tüketiliyor; Studio'nun "bu projede hangi hedefler
   açık" ekranı ya da composition root doğrulaması için bırakıldı. Dalga 3-4'te tüketicisi olmazsa silinmeli.

## 7. Bilerek eksik bırakılanlar

- **docx/pdf üretimi yok** (M103, Aşama 2) — sessiz değil; `createPublishPort`/`multi` bu hedefleri
  **kurulumda** reddediyor, böylece `jira+pdf` kümesi Jira yorumunu attıktan sonra patlamıyor.
- **Kalıcı defter gerçeklemesi yok** — arayüz + bellek içi ikiz; kalıcılık Dalga 3 (`db`) işi.
- **Belgeyi kim üretir kararı yok** — bu paket `AnalysisDoc`/`EvidencePackage`/`ReleaseNoteDraft`'tan
  markdown üretir; bu nesneleri üreten ajan/aktivite Dalga 3'te.
- **Şablonun kendisi (knowledge pack dosyası) burada değil** — M43/M83 gereği sürümlü şablon Studio'da
  yönetiliyor; bu paket sürümü belgeye **yazar**, şablonu okumaz.
- **Confluence sayfa ağacı/etiket yönetimi yok** — yalnız opsiyonel `parentPageId`. Label/kısıt (restriction)
  kurumsal kural gelince eklenir.
- **Gerçek Jira/Confluence fikstürü yok** — erişim gelene kadar sunucu ikizleri (insa-plani §6).

## 8. Doğrulama

```
pnpm install                          # ✓
pnpm -F @maestro/publish typecheck    # ✓
pnpm -F @maestro/publish test         # ✓ 11 dosya / 127 test
pnpm run gate                         # ✓ (lint + turbo typecheck/test --force, 38 görev)
```

## 9. Doğrulama turu — bulgu bazında kapanış

| # | Bulgu | Düzeltme | Kırılan test |
|---|---|---|---|
| F1 | Confluence PUT 404 → sessiz başarı | `request()`'e `allow404`; yalnız `locate()` GET'leri kullanıyor, PUT/POST 404'te `PublishHttpError` | `confluence-driver`: "PUT lands on a page that is gone" |
| F2 | PR merge + dal silinince revize belge main'e ulaşmıyor | `getPrStatus` tanık; `completed`/`abandoned` → `-r<n>` dalı + yeni PR; defterde `prState`+`revision` | `repo-docs`: "NEW branch and PR once the previous one was merged" + "stays on the branch while its PR is still open" |
| F3 | XML'de yasak kontrol karakterleri → kalıcı 400 | `md.ts`'te tek `stripUnsafeChars`; `escapeInline`/`escapeBlock` **ve** `parseMarkdown` girişinde | `parse`: "drops characters XML cannot carry…" |
| F4 | Kaçış geri alınıyor → sahte `h1.` başlığı + `!url!` izleme pikseli | `adf.ts`'te `defuseWikiMarkup` (satır başı `hN.`/`bq.`/`----`/liste işaretleri, `!...!` çiftleri) | **`jira-contract.test.ts` (yeni, çapraz paket)** + `adf.test.ts` 2 test |
| F5 | Kapanmayan `<!--` belgeyi yutuyor → boş ADF/boş sayfa | Yorum kendi satırında biter; her sürücü kendi çıktısının boş olmadığını doğruluyor | `parse` + `jira-driver` + `confluence-driver` boş çıktı testleri |
| F6 | `baseUrl` şema kısıtı yok → PAT açık metin | https zorunlu + `allowInsecureHttp` (kardeş ADO adaptörüyle aynı kural) | `confluence-driver`: "base URL that would carry the PAT in clear text" |
| F7 | Üreten/tüketen anahtar uyuşmazlığı | Defter anahtarı da bilet kapsamlı; davranış §4.4'te yazılı | `confluence-driver`: "ONE live page per ticket" |
| F8 | Yarım yayında sha kayboluyor + mükerrer PR | Her yan etkiden sonra defter yazımı; `ref` her zaman sha (`headSha` ile kurtarma, yoksa gürültülü ret) | `repo-docs`: "does not open a second PR…" + "refuses to receipt a file path…" |
| F9 | Desteklenmeyen hedef koşu ortasında patlıyor | `buildPublisher` docx/pdf'i **kurulumda** reddediyor; `UnsupportedTargetPublisher` silindi (ölü kod) | `register`: "refuses docx and pdf at COMPOSITION time" + "does not touch a target…" |
| F10 | Ham PII üç egress'e birden gidiyor | `src/pii.ts` — port seviyesinde maskeleme, `assertNoPii` fail-closed, açık istisna listesi (§4.9) | `pii.test.ts` (8 test) |
| F11 | Bidi/görünmez unicode süzülmüyor | F3 ile aynı süzgeç (`U+200B-200F`, `202A-202E`, `2066-2069`, `FEFF`) | `parse`: aynı test |
| F12 | "Aynı başlık zaten var" (400) yolu yok | 400 + "already exists" → sayfayı sahiplen, indeks gecikmesinde tekrar ara | `confluence-driver`: "adopts the existing page…" |
| F13 | RAPOR sayıları yanlış, §3 geçersiz | §1/§2/§8 sayıları düzeltildi, §3 yeniden yazıldı (katalog anahtarları eklendi, `KEY_LITERAL`'a `publish` girdi) | — |

**Aşama-0 duman testi notu (F12):** `title` araması Confluence'ta indeks gecikmeli olabilir; "kopya oluşmaz"
iddiası artık aramaya değil, create'in 400'üne de dayanıyor. Gerçek instance'ta iki şey doğrulanmalı:
(1) kurumun Confluence sürümünün mükerrer başlıkta döndürdüğü **tam hata metni** (`DUPLICATE_TITLE` düzeni
gerekirse genişletilir), (2) kurum context path'i + proxy arkasında 404/400 gövdelerinin korunup korunmadığı.
