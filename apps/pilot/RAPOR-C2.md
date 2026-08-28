# RAPOR — Dalga C2: pilotu GERÇEK GitHub git akışına bağlama

## Amaç

Pilot artık sahte ADO yerine **GERÇEK GitHub ScmPort** sürücüsünü çalıştırabilir:
gerçek dal açma, gerçek `git clone/commit/push` ve gerçek (taslak) PR. Her şey
`PILOT_SCM` anahtarının arkasında; **varsayılan `fake`** olduğundan token
olmadan hiçbir davranış değişmez ve tüm mevcut testler aynen geçer.

## 1) PILOT_SCM anahtarı

`config.ts`:

```
export type ScmMode = "fake" | "github";
export function scmMode(env): ScmMode  // PILOT_SCM env → "github" değilse "fake"
```

- `fake` (varsayılan): `createPilotFakeScmPort` — ADO sürücüsü sahte ADO'ya
  karşı, `issueSecret` **fırlatmaya devam eder** (push yok). Değişiklik yok.
- `github`: `createPilotGithubScmPort` — `@maestro/adapter-github`'in
  `createGithubScmDriver`'ı; `GITHUB_OWNER`/`GITHUB_REPO` + token (SecretPort
  referansı `kv/github/token#value`) ile kurulur.

Env çözümü `env.ts:resolveGithub` içinde; `PILOT_SCM=github` olduğunda
`GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_TOKEN` **zorunludur** ve eksikse yüksek
sesle (Türkçe) hata verir. `fake` yolunda GitHub'a hiç dokunulmaz, token
seed'lenmez.

## 2) Gerçek git dizisi (mühendis adımı)

`workspace.ts:buildGitPushPlan` + `gitPush`. Model kodu workspace'e yazıldıktan
ve tarama+test **yeşil** olduktan sonra (`run.ts:pushToGithub`) sıra:

```
clone --branch main --depth 1 <remote> repo   (cwd: root)
checkout -b feature/<TICKET>                    (cwd: repo)
add --all
commit -m "[AI] <TICKET> …\n\nCo-Authored-By: …"   (M13)
push origin feature/<TICKET>                    (--force ASLA yok)
rev-parse HEAD                                   (commit sha)
```

Dizi, enjekte edilmiş bir `ExecRunner` üzerinden koşar — testte gerçek git
çağrılmaz. Push başarısız olursa `GitStepError` fırlar, `openPr` **hiç
çağrılmaz** (fail-closed: sahte "PR açıldı" yok).

## 3) Token'ı git config/log dışında tutmak

Token git'e **yalnızca ortam değişkeni** ile verilir, argv'ye **hiç** girmez:

```
GIT_CONFIG_COUNT=3
GIT_CONFIG_KEY_0=http.extraHeader   GIT_CONFIG_VALUE_0=AUTHORIZATION: basic <base64(x-access-token:TOKEN)>
GIT_CONFIG_KEY_1=user.name          GIT_CONFIG_VALUE_1=Maestro AI
GIT_CONFIG_KEY_2=user.email         GIT_CONFIG_VALUE_2=…
GIT_TERMINAL_PROMPT=0
```

`GIT_CONFIG_*`, git'in `-c key=value` geçici override'ının **env tabanlı**
biçimidir: değer `.git/config`'e **yazılmaz** ve `-c`'nin aksine **argv'de
görünmez** (yani `ps` / kabuk geçmişi / loglanan komut satırında yoktur).
Remote URL kimlik bilgisi içermez (`https://github.com/owner/repo.git`), yani
`.git/config` / `git remote -v` yalnız temiz URL'yi tutar. Kimlik (user.name/
email) de aynı yolla env'den geldiği için commit adımının argv'si temiz
`git commit -m …` olur. `--force` hiçbir adımda yoktur (protected_paths /
no force-push, M13). Loglar sadece git argv + stderr taşır; token'ı taşımaz.

Kısa ömürlü kimlik (M31): sürücünün `getPushCredential`'ı çağrılır
(`GITHUB_PUSH_TTL_SECONDS=600`, sürücü tavanı 1 saat). `wiring.ts`'teki
`issueSecret` geri-çağrımı seed'lenmiş token'ı okur ve `expiresAt = now + ttl`
damgalar; sürücü `assertTtlWithinCeiling` + `issuedCredentialIssues` ile bunu
zorlar (tavanı aşan veya penceresini aşan kimlik reddedilir). C4'te bir GitHub
App **installation token**'ı (gerçekten süren) aynı geri-çağrım şekliyle PAT'ın
yerine geçebilir.

## 4) Gerçek vs. sahte kalan

| Parça | Durum |
|---|---|
| Depo çözümü (resolveRepo) | **GERÇEK** GitHub |
| Dal açma (createBranch) | **GERÇEK** GitHub API |
| Kod push (clone/commit/push) | **GERÇEK** git |
| PR açma + taslaktan çıkarma (openPr/activatePr) | **GERÇEK** GitHub |
| **CI sinyali** | **SAHTE** — hâlâ sahte ADO `build.complete` Service Hook'u. Gerçek GitHub Actions/checks **C3**'te, burada YAPILMADI. |
| **Merge doğrulama** | **SAHTE** — merge bir insan eylemi olarak sahte ADO'da (`completePullRequest` + sahte `getPrStatus`). |

CI/merge'i sahte tutmak için: gerçek PR açıldığında id'si sahte ADO'ya
`registerExternalPr` ile kaydedilir ve o id için sahte `build.complete`
yayınlanır (`onRealPrOpened`). `stepMerge`, merge durumunu ayrı bir
`mergeStatus` portundan (sahte ADO sürücüsü, ADO-şekilli repo ref) okur;
gerçek GitHub PR'ına dokunmaz.

## Testler (hepsi OFFLINE — enjekte fetch + exec, gerçek git/ağ yok)

- `test/workspace-git.test.ts` (10 assert / 9 test): plan dizisi sırası,
  `--force` yok, token yalnız credential env'de (argv/remote'ta değil), M13
  commit mesajı; `gitPush` dizisi + her git çocuğunun credential env'i,
  clone→repo cwd'si, push hatasında fail-closed (rev-parse koşmaz),
  `GitStepError` mesajında token yok.
- `test/flow-github.test.ts` (2 test): uçtan uca github yolu.
  1. intake→push→PR: git dizisi `clone…push` sırasıyla exec'e gider, GitHub'a
     **gerçek** PR POST'lanır (`head=feature/OPS-6`), token hiçbir git
     argv'sinde ve hiçbir log satırında yok, token git env'inde (extraHeader)
     var — yani push gerçekten kimlikli.
  2. push başarısızsa run **fail-closed**: PR hiç POST'lanmaz, token log'a
     sızmaz.
- Mevcut `fake` yolu testleri (flow.test.ts dahil) **değişmeden** geçer.

**Sonuç: `pnpm -F @maestro/pilot typecheck` temiz, `test` 62/62 yeşil
(önceki 52 + yeni 10). Repo `pnpm lint` temiz.**

## Dokunulan dosyalar

- `apps/pilot/src/config.ts` — `ScmMode`, `scmMode()`, GitHub sabitleri, secret ref.
- `apps/pilot/src/env.ts` — `resolveGithub()` / `GithubEnv`.
- `apps/pilot/src/wiring.ts` — mod farkındalı `createPilotScmPort`, `createPilotGithubScmPort`, secret seed.
- `apps/pilot/src/workspace.ts` — `ExecRunner`, `buildGitPushPlan`, `gitPush`, `GitStepError`.
- `apps/pilot/src/run.ts` — mühendis adımında gerçek push, mod-farkındalı repo/dal/PR, `mergeStatus` portu.
- `apps/pilot/src/fake-ado.ts` — dış PR için `registerExternalPr` + `emitBuildCompleteFor` (CI sahte kalır).
- `apps/pilot/src/boot.ts` — mod çözümü, github env, yeni deps.
- `apps/pilot/package.json` — `@maestro/adapter-github` bağımlılığı.
- yeni: `apps/pilot/test/workspace-git.test.ts`, `apps/pilot/test/flow-github.test.ts`.
