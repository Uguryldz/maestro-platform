# RAPOR — Pilot testlerini `maestro/.env`'den yalıtma (test-env fix)

## Sorun (kök neden)

`bootPilot` env türevli her kararı `loadRepoEnv()` üzerinden çözüyordu:

- `const repoEnv = loadRepoEnv()` → `../../../.env` (yani `maestro/.env`) okunuyor.
- `const mode = options.scm ?? scmMode(repoEnv)` → SCM modu.
- `resolveOpenRouter`/`resolveGithub`/`resolveJiraCloud` içinde `process.env[k] ?? env[k]`.

Sonuç: `PILOT_SCM=github` (+ gerçek `GITHUB_TOKEN`) `.env`'de veya geliştirici
kabuğunda olan biri için, `scm` pinlenmemiş "offline" bir test gerçek GitHub'a
POST atabiliyordu (gözlemlenen: `flow.test.ts` → 422 "Reference already exists").
`flow.test.ts` tekil olarak `scm:"fake"` ile pinlenmişti ama tehlike yapısaldı:
`bootPilot`'u çağıran ve env türevli her opsiyonu pinlemeyen HERHANGİ bir test,
`.env`/`process.env` içeriğine göre gerçek davranışa sürüklenebilirdi.

## Seçilen çözüm — Option A (açık env enjeksiyonu)

`llmFetch`/`jiraFetch`/`githubFetch` zaten enjekte edildiği gibi, ortamı da
enjekte ediyoruz. Option B (NODE_ENV/import.meta.env ile örtük test tespiti)
riskli ve örtük olduğu için reddedildi.

`BootOptions`'a opsiyonel `env?: Record<string,string>` eklendi. **Verildiğinde
YETKİLİ (authoritative) kaynaktır:**

- `maestro/.env` OKUNMAZ (`loadRepoEnv()` çağrılmaz).
- `process.env` YOK SAYILIR — enjekte edilen map tüm env türevli boot kararları
  için tek kaynaktır.

Gerçek uygulama (`main.ts`) `env` geçmez → `loadRepoEnv()` okunur ve `process.env`
üstüne katmanlanır; davranış AYNEN eskisi gibi kalır.

### Plumbing

- `config.ts` `scmMode(env, authoritative=false)` — `authoritative` iken
  yalnızca `env["PILOT_SCM"]`; aksi halde eski `process.env ?? env ?? "fake"`.
- `env.ts` `resolveOpenRouter`/`resolveGithub`/`resolveJiraCloud` her birine
  `authoritative=false` eklendi — `true` iken `process.env` atlanır, yalnızca
  enjekte edilen map kullanılır. Eksik anahtar YETKİLİ modda kabuktan
  doldurulmaz (aynı sert Türkçe hata fırlar).
- `boot.ts`: `const injected = options.env !== undefined;`
  `const repoEnv = options.env ?? loadRepoEnv();` ve tüm çözümleyicilere
  `injected` bayrağı geçirilir.

İmza değişiklikleri tümüyle geriye dönük uyumlu (yeni parametreler opsiyonel,
varsayılan `false`) ve `apps/pilot` içi; `contracts/ports` DOKUNULMADI, yeni
runtime bağımlılığı YOK.

## Testlerin `.env`'den bağımsızlaştırılması

`bootPilot`'u çağıran TEK dosyalar: `flow.test.ts` (1 boot) ve
`flow-github.test.ts` (2 boot). Diğer test dosyaları bootPilot çağırmıyor.

Üçüne de `env: {}` eklendi → her boot tam hermetik. `flow.test.ts` ayrıca
`scm:"fake"` "belt-and-braces" olarak korundu; `flow-github.test.ts` zaten
`scm/openRouter/jiraCloud/github` pinliyor, `env:{}` ek güvence.

## Guard testi — `test/env-isolation.test.ts` (3 test)

`process.env`'i kirletir (`PILOT_SCM=github`, `GITHUB_OWNER/REPO/TOKEN`,
`PILOT_MODEL`, `OPENROUTER_API_KEY`) ve şunu kanıtlar:

1. **Birim:** `scmMode({})` kirli kabukta `"github"` döner (gerçek app davranışı),
   ama `scmMode({}, true)` `"fake"` döner (enjekte edilen map yetkili).
2. **Birim:** çözümleyiciler yetkili modda kirli `process.env`'i yok sayar;
   token/anahtar yalnızca enjekte edilen maptan gelir, eksik anahtar kabuktan
   doldurulmaz (loud throw).
3. **Entegrasyon:** kirli `process.env` + `env:{}` ile `bootPilot` yine `fake`
   modda ayağa kalkar — github kenarı hiç çözülmez, ağ çağrısı olmaz
   (Jira transport'u herhangi bir çağrıda loud fail eder).

## Doğrulama

- `pnpm -F @maestro/pilot typecheck` → temiz.
- `pnpm --filter @maestro/pilot test` → **79 test / 10 dosya geçti**
  (önceki 76 + 3 guard).
- **Kirli ortamla** kanıt:
  `PILOT_SCM=github GITHUB_TOKEN=x GITHUB_OWNER=attacker GITHUB_REPO=attacker-repo PILOT_MODEL=y OPENROUTER_API_KEY=sk-polluted pnpm --filter @maestro/pilot test`
  → **79/79 geçti.** Kirlilik hiçbir teste sızmıyor.
- `pnpm lint` → 0 hata (yalnızca `apps/demo-stack` içinde önceden var olan,
  bu değişiklikle ilgisiz 3 uyarı; demo-stack'e dokunulmadı).

## Özet

- Seçim: Option A — enjekte edilebilir, **yetkili** `env`.
- Değişen dosyalar: `src/boot.ts`, `src/config.ts`, `src/env.ts`,
  `test/flow.test.ts`, `test/flow-github.test.ts`, yeni `test/env-isolation.test.ts`.
- Artık pilot testleri `maestro/.env` veya `process.env` içeriğinden bağımsız,
  deterministik.
