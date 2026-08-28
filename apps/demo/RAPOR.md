# RAPOR — `apps/demo`

Geliştirme/demo amaçlı uçtan uca düzenek. Üretim kodu değildir; `packages/*` altındaki
hiçbir dosyaya dokunulmadı.

## 1. Ne kuruldu

| Dosya | Ne yapar |
|---|---|
| `src/fake-jira.ts` | Jira DC taklidi: `adapter-jira`'nın çağırdığı REST v2 uçları (issue GET/PUT, comment POST/PUT, assignee PUT, issue POST, issueLink POST, group/member GET). Yanıt gövdeleri `packages/adapter-jira/fixtures` şekliyle aynı. Yorum eklenince **HMAC-SHA256 imzalı** `comment_created` webhook'u yollar. |
| `src/fake-ado.ts` | Azure DevOps Services taklidi: repo GET, refs GET/POST, pullrequests POST/GET/PATCH, threads GET, thread comment POST. PR taslaktan çıkınca **basic-auth'lu** `build.complete` Service Hook'u yollar (`reason: "pullRequest"` + allow-list'teki definition id). |
| `src/wiring.ts` | Composition root: gerçek `EnvFileSecretPort`, `JiraDcWorkPort`, `AdoScmDriver`, `AdoCiDriver`, `LlmGateway`, `AuditChain`. Sır değerleri koda gömülü değil; sürücüler `SecretPort` referanslarını çözer. |
| `src/run.ts` | Kısaltılmış akış: intake → analiz → insan kapısı → kod → tarama → test → PR + CI → insan kapısı → merge. |
| `src/server.ts` + `src/ui.html` | `node:http` ile tek sayfa (7010) + `/webhooks/jira` + `/webhooks/ado`. Durum SSE ile akar. |
| `test/*.test.ts` | 14 test: iki sözleşme testi (sahte sunucu ↔ gerçek adaptör) + tam akışın çevrimdışı koşusu. |

## 2. Hangi paketler gerçekten çağrılıyor

- **`@maestro/adapter-jira`** — `getTicket` (TicketSnapshot doğrulaması), `setLabels`,
  `addComment` (ADF → wiki markup), `updateComment` (M75 tek durum yorumu),
  `verifyWebhook` (ham gövde üzerinden imza), `parseCommandDetailed`, `verifyMembership`
  (sayfalanan grup listesi).
- **`@maestro/adapter-ado`** — `resolveRepo`, `createBranch`, `openPr`, `activatePr`,
  `listPrThreads`, `getPrStatus`; `AdoCiDriver.parseBuildEvent` (basic-auth + provenance
  kapısı).
- **`@maestro/llm-gateway`** — `openai-compat` sürücüsü ile OpenRouter; `generateObject`
  üç rolde (`intake`, `analyst`, `engineer`). Analiz çıktısı `AnalysisDoc` şemasıyla
  doğrulanır; tutmazsa gateway'in tek onarım turu çalışır, yine tutmazsa hata ekrana
  yazılır (gizlenmez).
- **`@maestro/pii`** — veri sınıfı `gizli` + `onPremMissing: "masked_cloud"` olduğu için
  gateway **maskelemeden** çıkış yapmaz; maskelenmiş gövde tekrar taranır. İnsana
  gösterilen kopya `unmask` ile açılır (M20); modele giden ve koda dönüşen kopya maskeli
  kalır. Üretilen kod ayrıca `scanForPii` ile taranır.
- **`@maestro/audit`** — `RUN_STARTED`, `GATE_OPEN`, `GATE_APPROVE` (yalnız insan aktör),
  `SECURITY_SCAN_PASS/FAIL`, `TEST_RUN_COMPLETE`, `CI_RESULT`, `PR_OPENED`, `PR_MERGED`,
  `RUN_CLOSED`. Koşu sonunda zincir `verify()` ile doğrulanır ve sonucu ekranda görünür.
- **`@maestro/secrets`** — `EnvFileSecretPort` (üretimde reddeder), `parseDotEnv`,
  `envVarName`/`parseSecretKey`.

## 3. Dürüstlük — neyin taklit olduğu

Ekranın üstünde sarı kutuda yazıyor: **Jira ve ADO sahte, model gerçek.**
Ayrıca bilerek taklit olan üç yer:

1. **Merge**: Maestro merge etmez (insan-merge kararı). Demo, ADO ekranındaki "Complete"
   tıklamasını sizin yerinize yapar ve log'a `(demo)` etiketiyle yazar; Maestro sonucu
   `getPrStatus` ile **doğrular**.
2. **Sandbox**: hardened konteyner yok. Üretilen dosyalar geçici bir dizine yazılır ve
   test `node` ile gerçekten çalıştırılır (ortam değişkeni miras alınmaz — API anahtarı
   çocuk sürece geçmez).
3. **Git push / gerçek diff**: yok. ADO'da dal ve PR gerçek API çağrılarıyla açılır ama
   kod bir depoya itilmez.

Gizlenen bir şey yok: bir adım patlarsa adım kırmızıya döner, hata metni ekranda kalır ve
akış durur.

## 4. Gerçekten koştu mu — doğrulama

`pnpm -F @maestro/demo start` ile açılıp tarayıcı akışı HTTP üzerinden sürüldü
(`POST /api/start`, ardından sahte Jira'ya iki `/approve` yorumu). Sonuç:

```
finished: true   failure: null
model çağrısı: 3 · token: 2942 · maskelenen alan: 3
denetim: 11 kayıt · verified: true
1..9 adımların tamamı "tamam"
✓ test gerçekten koştu: çıkış kodu 0 (65 ms) · OK
→ ado build.complete · PR #128 · build 4711 · succeeded
✓ merge doğrulandı · commit d3f9a172
✓ denetim zinciri doğrulandı — 11 kayıt, hash zinciri kopuk değil
```

Jira tarafında modelin gerçekten yazdığı Türkçe analiz yorumu, iki `/approve` ve kapanış
yorumu duruyor.

**Ayrıca gözlemlenen gerçek hata turu (ilk koşuda):** model ürettiği koda örnek bir
e-posta koydu → PII taraması `SECURITY_SCAN_FAIL` verdi → iş modele geri gönderildi;
ikinci turda `require()` kullanınca test düştü ve akış **kırmızıyla durdu**. Bunun
üzerine mühendis istemi netleştirildi (ESM zorunlu, "@" içeren metin yasak) ve tur sayısı
3'e çıkarıldı. Yani hata yolu da sahada doğrulandı.

Testler: `pnpm -F @maestro/demo test` → 14/14 yeşil, tamamı çevrimdışı.
Kök kapısı: `pnpm lint`, `pnpm typecheck`, `pnpm test` yeşil.

## 5. Eksikler / not düşülenler

- **Temporal yok** (Dalga 3). Kapı beklemeleri süreçte tutulan `Promise`'lardır: demo
  süreci kapanırsa koşu kaybolur. Gerçek akışta bu bir Temporal sinyalidir.
- **`packages/db` kullanılmadı**: Prisma şeması çalışan bir PostgreSQL ister; demo tek
  komutla ayağa kalksın diye denetim zinciri `InMemoryAuditStore` üzerinde tutuluyor.
  DB'li bir varyant istenirse compose ile eklenebilir.
- **`tsx` devDependency olarak eklendi.** Node 24 TypeScript'i doğrudan çalıştırabiliyor
  ama `packages/*` içindeki `./x.js` biçimli içe aktarmaları çözemiyor; test koşucusu
  (vitest) çözüyor, çıplak Node çözmüyor. `tsx` zaten `@maestro/db` üzerinden lock
  dosyasında vardı; **runtime** bağımlılığı eklenmedi (sunucular yalnız `node:http`,
  `node:crypto`, `node:child_process`, `node:fs` kullanır).
- **`getPushCredential` çağrılmıyor**: demo push yapmadığı için kısa ömürlü kimlik üreteci
  bilerek "çağrılırsa hata verir" şeklinde bağlandı.
- **Adaptörlerden istenen bir şey yok**: iki adaptör de demo için yeterliydi; eksik uç
  veya imza bulunmadı. Tek küçük not: `adapter-jira` fixture'ları `packages/adapter-jira/fixtures`
  altında (görev metninde `test/fixtures` yazıyordu), şekiller oradan alındı.
- **Kapı sayısı**: risk `dusuk` çıktığı için M51'in iki kapısı (TL analiz + PR) uygulandı;
  demo bunları "insan kapısı" olarak gösterir, altı kapılı kritik set kısaltılmış akışın
  dışında.
- **2b clarification kapısı yok**: intake "eksik var" derse ekranda uyarı yazılır ve akış
  devam eder; gerçek akışta burada süresiz bekleyen bir insan kapısı açılır.
