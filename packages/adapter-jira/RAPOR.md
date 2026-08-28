# @maestro/adapter-jira — builder raporu

WorkPort sürücüsü: **Jira Data Center / Server**, REST v2, PAT + webhook secret (M46/M102).

> **Tur 2 (düzeltme turu).** Bağımsız doğrulayıcı paketi KALDI ile döndürdü; bloklayıcı
> bulguların hepsi kapatıldı, kanıtları **§8**'de bulgu bazında listeli. Bu turda değişen
> davranışlar: argümansız komutlar (`/approve` başta) artık yorumda TEK BAŞINA durmak
> zorunda · düzenlenmiş yorumlar komut üretmiyor · üyelik eşleşmesi `displayName`
> kullanmıyor · boş PAT ve çözülemeyen üyelik sayfası artık sessiz değil, hata.

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/client.ts` | `JiraDcClient` — enjekte edilen token sağlayıcısıyla PAT bearer auth, enjekte edilen `baseUrl`, ince `fetch` sarmalayıcı; JSON in/out; 204/boş gövde → `void`; **boş PAT'te istek gönderilmez** (`JiraConfigError`); **tek** 429 geri çekilmesi (Retry-After saniye, `maxBackoffMs` ile sınırlı), ikinci 429 kesin hata; **POST hiç tekrarlanmaz** (idempotent değil). Başka retry yok — dayanıklı tekrar Temporal'ın işi. |
| `src/errors.ts` | Tipli hatalar: `JiraHttpError` (taban) · `JiraAuthError` 401 · `JiraForbiddenError` 403 · `JiraNotFoundError` 404 · `JiraRateLimitError` 429 (+`retryAfterMs`) · `JiraWebhookVerificationError` · `JiraResponseError` · `JiraArgumentError` · `JiraLinkFailedError` · `JiraMembershipUnresolvedError` · `JiraConfigError`. |
| `src/mapping.ts` | REST issue JSON → `TicketSnapshot` (components/labels/parent/proje/kullanıcı eşlemesi). Yalnız stok alanlar okunur — `ISSUE_FIELDS` içinde tek bir `customfield_*` yok (M98). Çıktı `TicketSnapshot` şemasından geçirilir; şema hatası `JiraResponseError` olarak hangi alanın patladığını söyler. |
| `src/datetime.ts` | DC `+0300` (iki nokta yok) ve webhook epoch-millis biçimlerini `IsoDateTime` sözleşmesine normalize eder. |
| `src/adf.ts` | ADF modeli + `paragraph · heading · codeBlock · panel · bulletList · strong/inlineCode/link · doc` üreticileri; `toAdfDocument` (ADF ya da düz metin) ve `adfToWikiMarkup`. **Metin düğümleri kaçışlanır** (`{ } [ ] \|`), link href'i temizlenir, `{code}` bloğunda makro çiti kırılır — ticket metni/model çıktısı wiki markup enjekte edemez. |
| `src/commands.ts` | `parseCommandLine` / `parseCommandBody` — komut yorumun İLK dolu satırında; `/approve · /reject <sebep> · /status · /ai-explain · /ai-start · /ai-assign <appId> · /mode-change <mod> · /ai-takeover`. **Argümansız komutlar (`approve · status · ai-explain · ai-start · ai-takeover`) yorumda tek başına durmalı**; satırda ya da alt satırlarda ek metin varsa `invalid` + `command.takes_no_argument`. Asla throw etmez. |
| `src/webhook.ts` | RAW gövde üzerinde HMAC-SHA256 (`node:crypto`), sabit zamanlı karşılaştırma, **fail-closed**; `parseWebhookEvent` (comment/issue/other, `edited` bayrağıyla) ve `commandFromWebhook` → `CommandEnvelope`. **Yalnız düzenlenmemiş `comment_created` komut üretir.** `signWebhookBody` fikstür imzalamak için. |
| `src/work-port.ts` | `JiraDcWorkPort implements WorkPort`: `getTicket · addComment · updateComment · setLabels · assign · createLinkedIssue · verifyMembership · parseCommand · verifyWebhook · transition`. |
| `src/config.ts` + `src/register.ts` | Zod'lu `JiraDcConfig` (`baseUrl`, `tokenRef`, `webhookSecretRef` + varsayılanlı `childIssueTypeName`/`linkTypeName`/`requestTimeoutMs`/`groupPageSize`) ve `registerJiraDrivers(registry)` → port `work`, sürücü `jira-dc`. |
| `fixtures/*.json` | `issue-get` · `webhook-comment-created` · `webhook-issue-created` · `group-members` · `issue-created-response` · `comment-created-response`. |

### M102 izin seti — kod nerede duruyor (DÜZELTME)

M102'nin saydığı izinler: Browse + Add Comment + Edit Issue (label) + Assign + Create/Link Issue.
Sürücünün bunlara karşılık gelen uçları: `GET /issue` · `POST .../comment` · `PUT /issue/{key}`
(gövde tam olarak `{fields:{labels}}`) · `PUT .../assignee` · `POST /issue` + `POST /issueLink`.
`transition()` **uygulanmadı**: `CapabilityNotSupportedError("WorkPort","transition")` fırlatır —
DC'de workflow izni istenmiyor, ilerleme label/yorumla gösteriliyor. Özel alan/ekran/eklenti
değişikliği yok (M98).

> **Raporun ilk turdaki "M102 dışına çıkmıyor" iddiası YANLIŞTI.** İki uç M102 listesinde
> karşılığı olmayan izin gerektiriyor ve **kurum izin listesine eklenmeli**:
>
> | Uç | Nerede | Jira DC'de gerektirdiği izin | Neden gerekli |
> |---|---|---|---|
> | `GET /rest/api/2/group/member` | `verifyMembership` | **"Browse users and groups" — GLOBAL izin** (proje izni değil) | M32 SoD / M51 kapı yetkisinin tek dayanağı; grup üyeliği başka türlü doğrulanamıyor |
> | `PUT /rest/api/2/issue/{key}/comment/{id}` | `updateComment` | **"Edit Own Comments"** (yorumu `maestro-svc` yazdığı için "Own" yeterli; başkasının yorumu düzenlenmiyor) | M75 tek düzenlenen "▶ Maestro durum" yorumu; yoksa yorum spam'i |
>
> Karar orkestratörde: ya bu iki izin kurum listesine eklenir, ya da M32/M75 için alternatif
> tasarım gerekir (üyelik için ayrı bir dizin servisi / ilerleme için yeni yorum akışı).
> **masterplan.md bu paket tarafından değiştirilmedi.**

## 2. Testler

`pnpm -F @maestro/adapter-jira test` → **7 dosya / 90 test, hepsi yeşil** (tur 1: 72; düzeltme
turunda +18). Tamamı çevrimdışı ve deterministik: ağ yok, `fetch` `test/helpers.ts` içindeki katı
sahte ile enjekte ediliyor (beklenmeyen istek → test patlar), `sleep` enjekte edildiği için 429
geri çekilmesi anında.

- `client.test.ts` (12): auth başlığı, URL/query kurulumu, JSON gövde, 204/boş gövde, 401/403/404/500 eşlemesi, 429→retry→200, çift 429, Retry-After tavanı, boş baseUrl, **boş PAT'te istek gönderilmemesi (O-5)**, **429 alan POST'un tekrarlanmaması**.
- `mapping.test.ts` (7): fikstür → `TicketSnapshot.parse` (sözleşmeden geçer), webhook içindeki issue, eksik alan raporu, kullanıcı kimliği fallback'i, tarih normalizasyonu, custom field yokluğu.
- `adf.test.ts` (10): üreticiler, düz metin sarma, ADF geçişi, hatalı gövde, wiki-markup çıktısının tam metni, **metin kaçışı**, **`{code}` çit kırma**, **link href temizliği**.
- `commands.test.ts` (15): sekiz komut, büyük/küçük harf, `/reject` sebebi, hatalı appId/mod, bilinmeyen komut, düz metin, çok satırlı gövde, **`/approve` + ek metin (aynı satır ve alt satır) reddi (K-1)**, **tüm argümansız komutlar için tek-başına kuralı**, argümanlı komutların satır sonunu almaya devam etmesi.
- `webhook.test.ts` (18): doğru imza, prefix'li/prefix'siz/büyük harf digest, yeniden serialize edilmiş gövde reddi, kurcalanmış gövde/yanlış secret/eksik başlık/bozuk digest/boş secret, Buffer gövde, olay sınıflandırma, `CommandEnvelope.parse`, **`comment_updated` komut üretmemesi (K-2)**, **`created !== updated` yorumun komut sayılmaması**, **düzenlenmemiş yorumun `edited:false` olması**, **`/approve` + ek metin reddi**.
- `work-port.test.ts` (23): her port metodu istek gövdesiyle birlikte, label doğrulaması, fan-out + link, link hatasında öksüz key, üyelik (isim/key/e-posta, sayfalama, ret), webhook doğrulama, bilinmeyen komutta `null`, `transition` yetenek hatası, **displayName ile eşleşmeme (O-1)**, **pasif üyenin atlanması (O-2)**, **çözülemeyen sayfa bean'i ve sayfa bütçesi aşımında hata (O-6)**, **port üzerinden K-1/K-2 reddi**.
- `register.test.ts` (5): registry kaydı, `SecretPort` üzerinden PAT çözümü, **varsayılanların gerçekten assert edildiği config testi**, config doğrulama, SecretPort'suz kurulum reddi.

Fikstürler Jira DC REST v2'nin belgelenmiş yanıt şekillerine göre elle yazıldı (kayıt-tarzı); kurumsal erişim geldiğinde `insa-plani §6` uyarınca gerçek kayıtlarla değiştirilmeli.

## 3. Varsayımlar (doğrulanması gerekenler)

1. **DC yorumları wiki markup'tır.** REST v2 `comment.body` bir string'dir; ADF yalnız Cloud v3'te geçerli. Bu yüzden ADF **çekirdeğin kanonik biçimi** olarak kaldı, `adfToWikiMarkup` çıkışta render ediyor (M46: "wiki-markup/ADF farkları DC'ye göre"). İleride bir Cloud sürücüsü aynı belgeyi olduğu gibi POST eder. Modellenmeyen ADF düğümleri düz metne düşer — yorum asla kaybolmaz.
2. **Webhook imzası** `X-Hub-Signature: sha256=<hex>` başlığında, ham gövde üzerinden HMAC-SHA256 (`JIRA_SIGNATURE_HEADER` sabiti). BFF gövdeyi **parse etmeden önce** doğrulamalı; yeniden serialize edilen gövde imzayı bozar (test bunu kanıtlıyor).
3. **`assign(key, accountId)`** — DC'de atama `name` (kullanıcı adı) ile yapılır; port'un `accountId` adı Cloud paritesi için korundu, değer DC kullanıcı adı/anahtarı olarak gönderilir. `null` → atamayı kaldırır.
4. **`verifyMembership`** `GET /group/member?includeInactiveUsers=false` ile sayfalanır; yalnız **kullanıcı adı (`name`), kullanıcı anahtarı (`key`) ve e-posta** üzerinden büyük-küçük harf duyarsız eşleşir — `displayName` KULLANILMAZ (benzersiz değil, LDAP'tan gelir, değişir). Pasif kullanıcı üye sayılmaz: sunucu parametresine ek olarak `active === false` olan üye yerel olarak da atlanır (M32 fail-closed). Grup yoksa `JiraNotFoundError`, üyelik kararı verilemiyorsa `JiraMembershipUnresolvedError` yükselir — hiçbir belirsizlik sessiz `false`'a dönüşmez.
5. **`createLinkedIssue`** proje anahtarını parent key'inden türetir, issue tipi `childIssueTypeName` (varsayılan `Task`), link tipi `linkTypeName` (varsayılan `Relates`) — ikisi de config'ten, DC örneğine göre ayarlanmalı. Link adımı patlarsa `JiraLinkFailedError` **oluşan child key'i taşır**; çağıran telafi edebilir (yeniden create etmemeli).
6. **`/reject` sebebi ilk satırda** aranır (gramer "ilk satır" olduğu için). `/reject` + alt satırda gerekçe → `invalid`. Gerekirse gevşetilebilir; şu an spec'e sadık. Argümanlı komutlarda (`/reject`, `/ai-assign`, `/mode-change`) alt satırlar hâlâ serbest metindir; **argümansız komutlarda değil** — bkz. §8/K-1.
7. **`/mode-change`** hem `ai-assist` hem `ai_assist` kabul eder (maket tire yazıyor, sözleşme snake_case) — tire alt çizgiye normalize edilir. `/ai-assign` argümanı küçük harfe çevrilip `AppId` regex'iyle doğrulanır.
8. Rate limit: DC'de 429 nadirdir ama reverse proxy koyabilir; `Retry-After` yalnız saniye biçiminde okunur, HTTP-date yok sayılır. **429 alan POST tekrarlanmaz** (yorum/issue/link yaratma idempotent değil; tekrar çift yorum riski). GET/PUT/DELETE için tek geri çekilme aynen duruyor.
9. **Webhook komut kaynağı yalnız `comment_created`.** Düzenlenen yorum (`comment_updated`, ya da `created !== updated` olan bir created teslimi) komut üretmez; `parseWebhookEvent` bunları hâlâ `kind:"comment"` + `edited:true` olarak sınıflandırır ki BFF isterse sayaç tutabilsin. Gerekçe §8/K-2.
10. **`/approve` yorumun tamamı olmalı.** Onay veren kişi komutu tek başına yazar; açıklama ayrı yoruma gider. Kullanıcıya dönen mesaj `command.takes_no_argument` bunu zaten söylüyor ("komutu tek başına yazın"). **Fikstür `webhook-comment-created.json` bu kurala uyacak şekilde güncellendi** (gövde artık düz `/approve`).
11. **Wiki markup kaçışı.** Yorum metni (ticket açıklaması, model çıktısı) güvenilmez kabul edilir: `{ } [ ] |` kaçışlanır, link href'inden çit kırabilecek karakterler atılır, `{code}` bloğunun içindeki `{code`/`{panel`/`{noformat`/`{quote`/`{color}` dizileri bir boşlukla bölünür (blok içinde backslash kaçışı işlemez). Kod örneği içindeki gerçek bir Jira makrosu bu yüzden bir boşluk kazanır — bilinçli takas.

### "Geçersiz komut" sonucu (spec'te istenen yapı)
`parseCommandLine` üç durumlu döner: `{status:"ok",command}` · `{status:"none"}` (yorum komut değil) · `{status:"invalid",command,messageKey,messageParams}`. `WorkPort.parseCommand` bunların yalnız `ok` olanında zarf döner, aksi halde **`null`** — hiçbir durumda throw etmez. `JiraDcWorkPort.parseCommandDetailed()` invalid bilgisini korur ki BFF kullanıcıya "komut hatalı" yanıtı yazabilsin (M14: sessiz varsayılan yok).

## 4. Bağımlılıklar

| Paket | Tür | Gerekçe |
|---|---|---|
| `@maestro/contracts` | runtime (workspace) | `TicketSnapshot`, `CommandEnvelope`, `ParsedCommand`, `TicketKey`, `AppId`, `WorkMode`, `IsoDateTime` — adaptör çıktısı sözleşmeden geçirilir. |
| `@maestro/ports` | runtime (workspace) | `WorkPort`, `SecretPort`, `PortRegistry`, `CapabilityNotSupportedError`. |
| `zod` ^4 | runtime | Zaten monorepo standardı; sürücü config doğrulaması ve şema parse'ı. |
| `@maestro/test-kit` | dev (workspace) | `loadFixture` — fikstürleri okumak için mevcut altyapı yeniden kullanıldı. |
| `@types/node`, `typescript`, `vitest` | dev | Paket sözleşmesi gereği. |

**Yeni harici runtime bağımlılığı YOK.** HTTP için global `fetch`, HMAC için `node:crypto` kullanıldı (jira.js / axios / node-fetch eklenmedi).

## 5. Arayüz talepleri (contracts/ports DONMUŞ — burada yalnız kayıt)

1. **`DriverFactory<P> = (config: unknown) => P` bağımlılık kanalı taşımıyor.** Sürücünün `SecretPort`'a (tokenRef/webhookSecretRef çözümü) ve testte enjekte edilebilir `fetch`'e ihtiyacı var. Geçici çözüm: factory girdisi `{...config, deps:{secrets, fetchImpl?, sleep?}}` şeklinde; `deps` yoksa `JiraConfigError` fırlatılır (sessizce kimliksiz istemci kurulmaz). **Talep:** `DriverFactory<P> = (config: unknown, deps: DriverDeps) => P` ya da `PortRegistry.register(..., factory, deps)`.
2. ~~**`WorkPort` webhook doğrulama metodu içermiyor**~~ — **KAPANDI**: orkestratör port'a `verifyWebhook(rawBody, headers)` ekledi, sürücü imzayı ona uyarladı (başlık araması büyük/küçük harf duyarsız).
3. ~~**`updateComment` port'ta yok**~~ — **KAPANDI**: orkestratör port'a ekledi (`updateComment(key, commentId, body)`). İzin notu için bkz. §1 M102 düzeltmesi.
4. **`parseCommand` yalnız `CommandEnvelope | null` döndürüyor**, "komut gibi görünen ama geçersiz" durumu kaybediyor. Sürücüde `parseCommandDetailed` ile korundu. **Talep:** dönüş tipi `CommandEnvelope | InvalidCommand | null` ya da ayrı bir metot. **Bu artık daha kritik**: K-1 sonrası `/approve etmiyorum` gibi bir yorum `null` dönüyor; BFF `parseCommandDetailed` çağırmazsa onaylayan kişi neden hiçbir şey olmadığını öğrenemez (M14).
5. **`TicketSnapshot` durum (status) alanı taşımıyor.** DC issue'sunda `fields.status.name` var ve intake/rapor için faydalı olabilir; şu an okunmuyor. Bilgi amaçlı not.
6. **`WorkPort.parseCommand(rawBody)` isim tuzağı.** Parametre `rawBody` deniyor ama metot **parse edilmiş webhook nesnesini** bekliyor (ham gövde string'i verilirse sessizce `null` döner — "komut yok" ile ayırt edilemez). Sürücü tarafında düzeltilemez, port donmuş. **Talep:** parametre adı `payload` olsun ya da tip `unknown` yerine açıkça `WebhookPayload`. O güne kadar BFF sırası: `verifyWebhook(rawBody, headers)` → `JSON.parse(rawBody)` → `parseCommand(payload)`.

## 6. Katalog anahtarları (M104 — `packages/config` bu paket tarafından düzenlenmedi)

Paket hiçbir kullanıcıya görünen metin üretmez; hepsi `COMMAND_MESSAGE_KEYS` altında sabit
**anahtar**. Kullanılan anahtarlar ve durumları:

| Anahtar | Parametre | Durum |
|---|---|---|
| `command.unknown` | `{commands}` | Dalga 0'dan beri katalogda |
| `command.reject_needs_reason` | — | Dalga 0'dan beri katalogda |
| `command.invalid_app_id` | `{value}` | Orkestratör tr+en ekledi ✓ |
| `command.invalid_mode` | `{value}`, `{modes}` | Orkestratör tr+en ekledi ✓ |
| `command.takes_no_argument` | `{command}` (örn. `/approve`) | Orkestratör tr+en ekledi ✓ — K-1 bunu kullanıyor |

## 7. Doğrulama

```
pnpm install                              # ✓ lockfile güncel
pnpm -F @maestro/adapter-jira typecheck   # ✓
pnpm -F @maestro/adapter-jira test        # ✓ 7 dosya / 90 test
pnpm lint                                 # ✓ (kökten eslint)
pnpm typecheck                            # ✓ (kökten turbo, 10 paket)
```

## 8. Doğrulayıcı bulgularının kapatılması (tur 2)

| # | Bulgu | Ne yapıldı | Kanıtlayan test |
|---|---|---|---|
| **K-1** | `/approve` satırının artık metni sessizce yutuluyordu → yanlış onay | `commands.ts`: argümansız komut kümesi (`approve · status · ai-explain · ai-start · ai-takeover`) tanımlandı. `parseCommandLine` bu komutlarda satırda argüman görürse `invalid` + `command.takes_no_argument` (`{command:"/approve"}`) döner; `parseCommandBody` ayrıca **alt satırlarda** dolu metin varsa aynı sonucu verir — yani argümansız komut yorumun tamamı olmak zorunda. Argümanlı komutlarda (`/reject`, `/ai-assign`, `/mode-change`) ilk-satır grameri değişmedi. | `commands.test.ts`: "refuses an /approve that carries extra text on the same line" (`/approve etmiyorum, reddediyorum` · `/approve değil` · `/approve ama sonra`), "refuses an /approve followed by prose on another line" (`/approve\n\nAma önce güvenlik testi bitsin.` · `/approve\n/reject AC-3 yok`), "applies the stand-alone rule to every argument-free command", "still lets argument commands take the rest of their line" · `webhook.test.ts`: "does not approve when the /approve line carries extra text (K-1)" · `work-port.test.ts`: "refuses an approval smuggled behind extra text or an edit" |
| **K-2** | `comment_updated` başkası adına onay üretiyordu (M32 SoD atlanıyordu) | `webhook.ts`: `JiraWebhookEvent.comment` artık `edited` bayrağı taşıyor (`comment_updated` ⇒ true; `created !== updated` ⇒ true). `commandFromWebhook` **yalnız düzenlenmemiş `comment_created`** olayından komut üretir, diğerlerinde `{envelope:null, invalid:null}`. Sınıflandırma korundu (BFF sayaç tutabilsin), komut kaynağı olmaktan çıkarıldı. | `webhook.test.ts`: "ignores a comment_updated event even when it carries a command" (`updateAuthor: kotu.niyetli`), "ignores a created delivery whose comment has already been edited", "marks an untouched comment as not edited" · `work-port.test.ts`: "refuses an approval smuggled behind extra text or an edit" |
| **O-1** | `verifyMembership` `displayName` ile eşleşiyordu | `work-port.ts / identifiersOf`: eşleşme yalnız `name`, `key`, `emailAddress` üzerinden; `displayName` ve gereksiz `userIdOf(user)` çağrısı çıkarıldı (`userIdOf` importu da düştü). | `work-port.test.ts`: "never matches a member on the display name" (`{name:"selin.arslan", displayName:"Mert Demir"}` + `verifyMembership("mert demir")` → `false`) |
| **O-2** | Pasif kullanıcı yalnız sunucu parametresine güvenilerek eleniyordu | `work-port.ts / isActiveMember`: üyede `active === false` ise atlanır; `includeInactiveUsers=false` sorgusu ek savunma olarak duruyor. | `work-port.test.ts`: "skips members the payload marks inactive" (`{name:"ayrilmis.calisan", active:false}` → `false`) |
| **O-5** | Boş PAT sessizce anonim istek üretiyordu | `client.ts / send`: token boş/whitespace (ya da string değilse) `JiraConfigError` — istek **hiç gönderilmez**. Webhook sırrındaki fail-closed davranışın karşılığı. | `client.test.ts`: "refuses to send a request when the PAT resolves to nothing" (`""`, `"   "`, `undefined`; `stub.calls` boş kalıyor) |
| **O-6** | Üyelik sayfalamasında sessiz deny | `work-port.ts`: yeni `JiraMembershipUnresolvedError` (`incomplete_page_bean` \| `too_many_pages`). `hasMorePages` sayfa bean'inde ne `isLast` (boolean) ne `total` (number) bulursa hata fırlatır; `MAX_GROUP_PAGES` (40) tükendiğinde de `false` yerine hata fırlatılır. Yön hâlâ fail-closed ama artık sessiz değil. | `work-port.test.ts`: "raises instead of denying when a page bean cannot be reasoned about", "raises instead of denying when the group outgrows the page budget" (40 istek sonrası hata) |
| **Test kalitesi** | `register.test.ts` "applies the documented defaults" hiçbir default assert etmiyordu | Test artık `JiraDcConfig.parse(...)` çıktısını tam olarak assert ediyor (`Task` · `Relates` · `15_000` · `50`) **ve** varsayılan `groupPageSize`'ın tele çıktığını (`maxResults=50`) doğruluyor. | `register.test.ts`: "applies the documented defaults" |

### Düşük öncelikli bulgular — bu turda kapatıldı

| Bulgu | Ne yapıldı | Kanıtlayan test |
|---|---|---|
| Wiki markup kaçışı yoktu (`{code}`, `[metin\|http://…]` enjeksiyonu) | `adf.ts`: metin düğümlerinde `{ } [ ] \|` backslash ile kaçışlanır; `link()` href'inden `[ ] { } \|` ve boşluk atılır; `{code}` bloğu içeriği literal olarak render edilir ve `{code`/`{noformat`/`{panel`/`{quote`/`{color` dizileri bir boşlukla bölünür (blok içinde kaçış işlemediği için tek yol bu). Böylece ticket metni ya da model çıktısı Maestro'nun kendi kapı yorumunu taklit edemez. | `adf.test.ts`: "escapes macro and link openers in text it did not build", "keeps an injected fence from closing a code block early", "does not let a crafted link href break out of the link" |
| 429 retry'ı POST'ta da yapılıyordu (çift yorum riski) | `client.ts`: POST 429 alırsa geri çekilme yok, doğrudan `JiraRateLimitError`. GET/PUT/DELETE için tek geri çekilme aynen. Tekrar kararı Temporal'ın (kendi idempotency anahtarıyla). | `client.test.ts`: "does not retry a throttled POST — a duplicate comment is worse than a failure" (1 istek, 0 sleep) |
| `parseCommand(rawBody)` isim tuzağı | Port donmuş olduğu için kodda düzeltilemedi; §5/6'da arayüz talebi olarak kayda geçti + BFF'in izlemesi gereken sıra yazıldı. | — (arayüz talebi) |

### Bu turda değişen davranışlar — çağıranların bilmesi gerekenler

1. `/approve` (ve diğer argümansız komutlar) artık **yorumun tamamı** olmalı. BFF, `parseCommand` `null`
   dönünce `parseCommandDetailed().invalid` ile `command.takes_no_argument` mesajını kullanıcıya
   yazmalı — yoksa onaylayan kişi neden hiçbir şey olmadığını anlayamaz (M14).
2. Düzenlenmiş yorumlar komut üretmez. Bir TL yorumunu düzelterek onay veremez; yeni yorum yazmalı.
   Maketteki "Jira komut seti" yardım metni bunu söylemeli.
3. `fixtures/webhook-comment-created.json` gövdesi `/approve` (eskiden `/approve` + açıklama satırı).

## jira-cloud sürücüsü

Aynı `WorkPort` arayüzünü uygulayan ikinci sürücü: **Jira Cloud**, REST v3, HTTP Basic
(e-posta + Atlassian API token'ı). Yanıt ayrıştırma **belleğe değil, canlı siteden
(uyildiz.atlassian.net / OPS) kaydedilmiş `fixtures/cloud/*.json` dosyalarına** göre yazıldı.

### Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/cloud/config.ts` | Zod'lu `JiraCloudConfig` (`baseUrl` · `email` · `apiTokenRef` + DC ile aynı varsayılanlar: `childIssueTypeName`/`linkTypeName`/`requestTimeoutMs`/`groupPageSize`), fail-closed; `JIRA_CLOUD_DRIVER = "jira-cloud"`. |
| `src/cloud/client.ts` | `JiraCloudClient` — Basic auth (`base64(email:token)`), JSON in/out, `errors.ts`'teki tipli hatalar. **Süreç içi retry YOK**: 429 → `JiraRateLimitError` (+`retryAfterMs`), 5xx → yeni `JiraRetryableError`; ikisi de yalnız SINIFLANDIRMA — dayanıklı tekrar Temporal'ın işi. Boş token/e-posta'da istek gönderilmez (anonim düşüş yok, DC'deki O-5 ile aynı kural). |
| `src/errors.ts` (ek) | `JiraRetryableError` (5xx) + `isRetryableJiraError()` yardımcısı. Yeni dosya değil, mevcut hata ailesine iki ek. |
| `src/adf.ts` (ek) | `adfToPlainText` — Cloud açıklamaları ve yorumları ADF geldiği için düz metne indirger. Blok araları `\n\n`, `hardBreak` → `\n`; **bilinmeyen yaprak düğümler (mention/emoji/media) kaybolmaz, `￼` yer tutucusu olur** — görünmez içerik `/approve @kisi`'yi çıplak `/approve` sanılmaktan alıkoyar (M105 fail-closed). |
| `src/cloud/mapping.ts` | `mapCloudIssueToSnapshot` (`issue-get.json` şekli → `TicketSnapshot`): ADF açıklama düz metne, kimlikler `accountId` (e-posta yedek, `displayName` asla), `+0300` ofseti mevcut `normalizeJiraDateTime` ile normalize, team-managed projelerin boş/eksik `components`'ı tolere edilir, `parent.key` → `parentKey`. `ISSUE_FIELDS` DC'den aynen kullanılır. |
| `src/cloud/search.ts` | `searchIssues({jql, maxResults, fields, pageToken})` → `GET /rest/api/3/search/jql`. Eski `/rest/api/3/search` KALDIRILDIĞI için (CHANGE-2046) hiç çağrılmaz. **Sınırsız JQL muhafızı** (`assertBoundedJql`): boş sorgu ya da yalnız `ORDER BY` süreçten çıkmadan `JiraArgumentError` — canlıda görülen "Burada sınırsız JQL'lere izin verilmez" hatası tipli hale getirildi. Sayfalama fikstürdeki gerçek alanlarla: `issues` + `isLast` (+ varsa `nextPageToken` imleci); `total` yok, uydurulmadı. |
| `src/cloud/comment-command.ts` | `parseCommandFromComment(ticketKey, comment)` — pilot webhook değil YOKLAMA yaptığı için komutlar `comments-list.json`'daki yorum kaynağından ayrıştırılır. ADF gövde düz metne indirgenir, `commands.ts` grameri aynen kullanılır (M105: çıplak komut yorumun tamamı olmalı; "/approve etmiyorum" komut DEĞİL). **`created !== updated` olan yorum komut üretmez** — yoklamada olay ayrımı yok, kanıt zaman damgaları (DC'deki K-2 ile aynı SoD gerekçesi). `commandFromCloudPayload` hem `{ticketKey, comment}` hem `{issue:{key}, comment}` zarfını kabul eder. |
| `src/cloud/work-port.ts` | `JiraCloudWorkPort implements WorkPort`: `getTicket` · `addComment`/`updateComment` (ADF gövde OLDUĞU GİBİ gönderilir — wiki markup yok; kayıtlı 201 yanıtından `id`) · `setLabels` (**fark tabanlı**: önce `fields=labels` okunur, yalnız `{update:{labels:[{add},{remove}]}}` deltası yazılır — kayıtlı 204; fark yoksa yazma hiç yapılmaz) · `assign` (`accountId`, `null` = atamayı kaldır) · `createLinkedIssue` · `verifyMembership` · `searchIssues` · `listComments` · `parseCommand(FromComment)` · `verifyWebhook`/`transition` → `CapabilityNotSupportedError`. |
| `src/register.ts` (ek) | `createJiraCloudWorkPort` fabrikası + `registerJiraDrivers` artık `work` portuna **iki** sürücü kaydeder: `jira-dc`, `jira-cloud`. Aynı `deps.secrets` deseni; Cloud'un webhook sırrı yok. |

### Kararlar ve varsayımlar

- **Fan-out bağlantısı `issuelink` ile, `parent` alanıyla DEĞİL.** Team-managed projede `parent`
  bir üst hiyerarşi katmanı (Epik) ister; görev altına görev açılamazdı. `POST /rest/api/3/issueLink`
  (`linkTypeName`, varsayılan `Relates`) her seviyede çalışır ve DC sürücüsüyle birebir aynı
  telafi sözleşmesini korur (`JiraLinkFailedError` öksüz `childKey` taşır). Açıklama alanı v3'te
  ADF istediği için düz metin `toAdfDocument` ile sarılır.
- **`verifyWebhook` → `CapabilityNotSupportedError`.** Pilot yorumları YOKLUYOR; kayıtlı bir Cloud
  imza şeması yok. Fail-closed: bu sürücünün doğrulayamadığı bir teslimat asla "doğrulanmış"
  sayılamaz. Cloud webhook'ları ileride eklenirse imza fikstürü kaydedilerek açılmalı.
- **`parseCommandFromComment` imzası `(ticketKey, comment)`.** Görev tanımı `(comment)` diyordu ama
  yorum kaynağı issue ANAHTARI taşımıyor (yalnız `self` URL'sinde issue id'si var) ve
  `CommandEnvelope.ticketKey` zorunlu; yorumları yoklayan çağıran anahtarı zaten biliyor.
- **`verifyMembership` teslimat listesinde yoktu ama uygulandı** — `WorkPort` zorunlu kılıyor ve
  M32/M51 kapı yetkisi buna dayanıyor. `GET /rest/api/3/group/member` için canlı fikstür
  kaydedilmedi; standart Cloud sayfa bean'i (`values`/`isLast`/`total`, `project-search.json`'da
  görülen şekil) varsayıldı, DC'deki fail-closed sayfalama kuralları aynen taşındı
  (`JiraMembershipUnresolvedError`, pasif üye atlanır, eşleşme yalnız `accountId`/e-posta).
  **Doğrulayıcı bu ucu canlı kayıtla teyit etmeli.**
- **`listComments` eklendi** (teslimat listesinde yoktu): yoklama modelinde
  `parseCommandFromComment`'i besleyen kaynak; `comments-list.json` fikstürü bu uçtan kaydedilmişti.
  Tek sayfa döner — pilot tek "▶ durum" yorumu + az sayıda komutla çalışıyor; sayfalama gerekirse
  fikstürle birlikte eklenmeli.
- `email` config'te açık değer (kimlik, sır değil); token `apiTokenRef` ile SecretPort'tan çözülür
  (M44: sır referansı, sır değeri asla).

### Testler

`pnpm -F @maestro/adapter-jira typecheck` ✅ · `test` ✅ (**13 dosya / 154 test**, DC 90 + Cloud
**64 yeni**) · repo eslint'i paket üzerinde ✅. Tamamı çevrimdışı, ağ yok — `fetch` sahtesi
`test/helpers.ts`'ten, yanıtlar `fixtures/cloud/*.json`'dan.

- `test/cloud/mapping.test.ts` (12): kayıtlı issue → sözleşmeden geçen snapshot (Türkçe metin
  bozulmadan: "Ödeme Onayı", ADF açıklama düz metin, `+03:00` normalize), eksik `components`,
  `null` açıklama, `accountId` kimliği, `adfToPlainText` (blok birleşimi, `hardBreak`, mention
  yer tutucusu, kayıtlı yorum gövdesi).
- `test/cloud/search.test.ts` (6): kayıtlı sayfanın ayrıştırılması (6 issue, `isLast:true`),
  yeni uç yolunun doğrulanması, sınırsız JQL reddi (istek çıkmadan), `ordering = broken` gibi
  gerçek koşulların kabulü, `nextPageToken` gidiş-dönüşü, bozuk yanıtta `JiraResponseError`.
- `test/cloud/client.test.ts` (7): Basic auth başlığı, boş token/e-posta reddi, 204, 401/403/404,
  **429'un TEK istekle** sınıflandırılması (+`retryAfterMs`), 5xx → `JiraRetryableError`,
  400'ün retryable OLMAMASI, `isRetryableJiraError`.
- `test/cloud/comment-command.test.ts` (14): kayıtlı düz yazı yorumun komut olmaması, çıplak
  `/approve` zarfı, **M105 negatifleri** ("/approve etmiyorum" · ikinci paragraf · `hardBreak`
  arkası metin · mention'lı `/approve` — hepsi `command.takes_no_argument`), argümanlı komutlar,
  **düzenlenmiş yorumun yok sayılması**, bilinmeyen komut, yazarı olmayan komutta hata, iki zarf
  biçimi, anahtarsız zarf reddi.
- `test/cloud/work-port.test.ts` (20): her port metodu istek gövdesiyle; ADF'nin OLDUĞU GİBİ
  gidişi; **label farkı** (yalnız `{add:"yeni"},{remove:"eski"}`; fark yoksa yazma yok);
  `accountId` ataması; fan-out + issuelink + öksüz key; üyelik (kimlik/e-posta, pasif atlama,
  sayfalama, çözülemeyen sayfada hata); `listComments`; port üzerinden komut; `verifyWebhook` ve
  `transition` yetenek hatası; sınırsız JQL muhafızının portta da işlemesi.
- `test/cloud/register.test.ts` (5): iki sürücülü kayıt, SecretPort'tan token → Basic başlığı,
  varsayılanlar, hatalı config'te alan adları, SecretPort'suz kurulum reddi.
- `test/register.test.ts` güncellendi: kayıtlı sürücü listesi artık `[jira-dc, jira-cloud]`.

### Bağımlılık / arayüz talepleri

- **Yeni çalışma zamanı bağımlılığı YOK** — Node 24 yerleşik `fetch`'i kullanıldı; axios/got eklenmedi.
- Donmuş `packages/ports`/`contracts`'ta değişiklik istenmedi. Not (bloklamıyor): `WorkPort.parseCommand(rawBody)`
  webhook zarfı varsayar; yoklama modelinde Cloud sürücüsü bunu `{ticketKey|issue.key, comment}` zarfıyla
  karşılıyor — BFF yoklayıcısının bu zarfı kurması ya da doğrudan `parseCommandFromComment` çağırması yeterli.

## doğrulayıcı düzeltmeleri

Bağımsız doğrulayıcının jira-cloud turundaki 1, 2, 4 ve 6 numaralı bulguları kapatıldı
(3, 5, 7 orkestratörde). Her düzeltmenin negatif testi var; paket kapısı yeşil
(**13 dosya / 160 test**, +6).

| # | Bulgu | Ne yapıldı | Negatif test |
|---|---|---|---|
| **1 — KRİTİK** | M105 ADF bypass: blockquote/codeBlock içindeki ya da code/link mark'lı `/approve` gerçek onay üretiyordu (DC K-1'in ADF hali) | `adf.ts`: yeni `adfToCommandLines` — her görünür satır `commandCapable` etiketiyle döner. Yalnız **top-level paragraph'ın marksız düz text düğümleri** komut-taşıyabilir; heading/codeBlock/panel/blockquote/liste/bilinmeyen kapsayıcı içeriği ve HERHANGİ bir mark (code/link/strong…) taşıyan ya da text-olmayan inline (mention…) içeren satırlar görünür kalır ama `commandCapable:false`. `comment-command.ts / parseCloudCommentBody`: ilk dolu satır komut-taşıyabilir değilse `none`; taşıyabilirse gramer tüm görünür satırlar üzerinde çalışır — düz `/approve` + arkasında alıntı/kod bloğu hâlâ `takes_no_argument` (tek-yorum kuralı bozulmadı). Düz string gövde eskisi gibi doğrudan gramere gider. | `comment-command.test.ts`: "never reads a command out of quoted, code or styled text" (blockquote'lu · codeBlock'lu · inline-code'lu · link-mark'lı · strong'lu · heading'li `/approve` → hepsi `none`), "still blocks a plain /approve trailed by quoted or code content" (→ `takes_no_argument`), "does not honour an /approve riding with invisible content" (mention'lı satır artık komut metni değil → `none`); `mapping.test.ts`: "tags only plain top-level paragraph text as command-capable". Düz paragraf `/approve` pozitifi aynen yeşil. |
| **2 — ORTA** | `updated` alanı yoksa edited-comment kontrolü sessizce atlanıyordu (fail-open) | `comment-command.ts`: `created` muhafızıyla simetrik — komut taşıyan yorumda `updated` string değilse `JiraResponseError` ("cannot prove it is unedited"). Alanları map/filter eden bir poller K-2 deliğini sessizce geri açamaz; hata yüksek sesli. | `comment-command.test.ts`: "fails loudly when the updated timestamp is missing — unprovably unedited" (`updated` silinmiş `/approve` → throw, mesaj `updated` içerir; komut asla üretilmez). |
| **4 — KÜÇÜK** | `values:[] · isLast:false` çelişkili üyelik sayfasında sessiz `false` (paketin O-6 kuralına aykırı) | `cloud/work-port.ts / verifyMembership`: `hasMorePages` kontrolü boş-sayfa kısa devresinin ÖNÜNE alındı; "sayfa devam var diyor ama üye taşımıyor" durumu `JiraMembershipUnresolvedError` (yeni `contradictory_page` nedeni, `errors.ts` union'ına eklendi) ile fail-loud. Meşru boş son sayfa (`isLast:true`) hâlâ `false`. | `work-port.test.ts`: "raises on a page that claims more members but carries none — no silent deny" (çelişkili sayfa → `contradictory_page` hatası; `isLast:true` boş sayfa → `false`). |
| **6 — KÜÇÜK** | `createLinkedIssue` label'ları `setLabels`'ın boşluk/boş ön-kontrolünden geçmiyordu | Ortak `requireCleanLabels` yardımcısı çıkarıldı; `setLabels` VE `createLinkedIssue` aynı ön-kontrolü kullanıyor — hatalı label, çocuk issue yaratılmadan `JiraArgumentError` ile durur (yarım fan-out yok). | `work-port.test.ts`: "refuses fan-out labels Jira would reject, before any request" (`"iki kelime"` · `" "` → hata, sıfır istek). |

Davranış notu (çağıranlar için): mark'lı/karışık satırdaki komut artık `invalid` değil `none`
döner — güvenlik yönü aynı (onay üretilmez), yalnız BFF'in "hatalı komut" geri bildirimi
düz-paragraf komutlarıyla sınırlıdır. `adfToPlainText` (açıklama düzleştirme) değişmedi.
