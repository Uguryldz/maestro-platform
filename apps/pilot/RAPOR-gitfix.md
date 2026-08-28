# RAPOR — git commit "nothing to commit, working tree clean" düzeltmesi

## Kök neden

`PILOT_SCM=github` yolunda gerçek uçtan uca akış hiç çalışmamıştı; yalnızca
fixture testleri (exec'i stub'layan) geçtiği için boş klon fark edilmemişti.

`stepEngineering` (apps/pilot/src/run.ts) modelin kodunu şuraya yazıyordu:

- `this.workspace.write(IMPLEMENTATION_PATH, …)` → `IMPLEMENTATION_PATH = "src/impl.mjs"`
- `this.workspace.write(TEST_PATH, …)` → `TEST_PATH = "test/impl.test.mjs"`

`createWorkspace.write` ise bu dosyaları **workspace kökü** (`root`) altına
yazıyordu. Buna karşılık `gitPush` (workspace.ts) depoyu **ayrı bir alt dizine**
(`root/repo`) klonlayıp `git add --all` + `git commit`'i **orada** çalıştırıyordu.

Yani modelin yazdığı dosyalar `root/src/impl.mjs` altındayken, git çalışma dizini
`root/repo` idi ve içi taze klondan başka bir şey içermiyordu. `git add --all`
sahnede değişiklik bulmuyor, `git commit` **"nothing to commit, working tree
clean"** ile düşüyordu. Kod-yazma yeri ile git çalışma dizini kopuktu.

Test çalıştırması (`runTest`) de `cwd: root`'ta koştuğu için lokal olarak
geçiyordu (dosyalar kökteydi) — bu yüzden hata yalnızca commit anında ortaya
çıkıyordu.

## Düzeltme — Seçenek (a): önce klonla, sonra klon içine yaz

Prompt'taki iki seçenekten **(a)** doğru olan: önce klonla → modelin kod
dosyalarını **klonun içine** yaz → testi klonda koştur → klondan add/commit/push.
Böylece kod dosyaları ile git çalışma dizini **aynı** dizin olur.

Neden (a), (b) değil: (b) (kökte `git init` + remote) gerçek depo içeriğini ve
geçmişini getirmez; PR'ın altında gerçek bir dal/temel olması ve gerçek bir
diff üretilmesi için depoyu klonlamak gerekir. (a) gerçek uçtan uca yoldur.

### Yeni sıralama (github yolu)

1. `createWorkspace()` — `codeDir` başlangıçta `root` (sahte yol davranışı korunur).
2. **`cloneForGithub(branch, baseBranch)`** — döngüden ÖNCE, kod yazılmadan:
   - Kısa ömürlü push kimliği (M31) TEK sefer mint edilir.
   - `workspace.gitClone(...)` → `git clone --branch <base> --depth 1 … repo` +
     `git checkout -b <feature>`; ardından workspace `codeDir`'i `root/repo`'ya
     çevirir. Klon başarısız olursa `codeDir` çevrilmez (fail-closed, yarı-açık
     çalışma dizini oluşmaz).
3. Mühendislik döngüsü — `write(IMPLEMENTATION_PATH/TEST_PATH)` artık `codeDir`
   (= `root/repo`) altına yazar; tarama; `runTest()` `cwd: codeDir`'de koşar
   (test'in `../src/impl.mjs` göreli importu klon içinde doğru çözülür).
4. **`pushToGithub(code, credential)`** — yeşilden sonra `workspace.gitCommitPush(...)`
   → `git add --all` (artık GERÇEK diff görür) → `git commit` → `git push` →
   `git rev-parse HEAD`. Aynı kısa ömürlü kimlik kullanılır (klon ve push aynı
   koşu içinde saniyeler arayla, TTL içinde).

### Kodun klonda olduğunun doğrulaması

`workspace.ts`'de `write`/`runTest` artık `root` yerine `codeDir`'i kullanır ve
`gitClone` `codeDir`'i klon çalışma ağacına (`root/repo`) çevirir. Test tarafında
(`flow-github.test.ts`) `git add` anında diskte `existsSync(<addCwd>/src/impl.mjs)`
ve node-test cwd'sinde `test/impl.test.mjs` kontrol edilerek dosyaların GERÇEKTEN
klonun içine indiği kanıtlanır — eski hatalı kodda bu var olmayacaktı.

## API değişikliği (workspace.ts)

`buildGitPushPlan` / `gitPush` / `GitPushArgs` ikiye bölündü (kontratlar/portlar
donuk; bu yalnızca pilotun iç workspace yardımcı yüzeyi):

- `buildGitClonePlan` + `gitClone` + `GitCloneArgs` — clone→checkout (yazımdan ÖNCE).
- `buildGitCommitPushPlan` + `gitCommitPush` + `GitCommitPushArgs` — add→commit→push→rev-parse (yazımdan SONRA).
- `DemoWorkspace.codeDir` (readonly getter) eklendi.
- Ortak kimlik/credential env'i `buildCredentialEnv` içinde toplandı; jeton
  gizliliği (GIT_CONFIG http.extraHeader, argv'de/log'da asla; base64 header),
  `--force` yokluğu, fail-closed push, hepsi aynen korundu.

## Hâlâ TODO (daha derin özellik)

Model sabit bir yola yazıyor (`src/impl.mjs`); bu, gerçek deponun MEVCUT
dosyalarıyla eşleşmeyebilir. Pilotun dürüst kapsamı için yeterli: dosya klonun
içine indiği için commit edilecek gerçek bir diff VAR ve gerçek bir PR açılıyor.
Modelin değişikliğini deponun GERÇEK dosyalarına (yeni dosya değil, gerçek kod
düzenlemeleri) eşlemek daha derin bir özelliktir — mühendisin depoyu görmesi
gerekir (bir sonraki dalga, TODO). Kod klasörü içinde `TODO` olarak not edilmiştir.

## Testler

- `apps/pilot/test/workspace-git.test.ts` yeniden yazıldı: klon planı
  (clone→checkout, parent→repo cwd), commit/push planı (add→commit→push→rev-parse,
  hepsi klon cwd'sinde), `gitClone`'un `codeDir`'i çevirmesi + yazımın klona
  inmesi (diskten okuyarak doğrulama), fail-closed (clone hatası codeDir'i
  çevirmez; push hatası rev-parse'a ulaşmaz), jeton argv/log'da yok.
- `apps/pilot/test/flow-github.test.ts` güncellendi: git SIRASI aynı; ek olarak
  `git add` ve node-test cwd'sinin klon dizini olduğu ve impl/test dosyalarının
  o dizinde diskte var olduğu (implInClone/testInClone) doğrulanır; push-fail →
  PR yok; jeton sızmaz.

Sonuç: **apps/pilot 9 dosya / 76 test yeşil**; `pnpm -F @maestro/pilot typecheck`
temiz; repo `pnpm lint` 0 hata (3 uyarı önceden var, demo-stack/real-users.ts,
bu değişikliğe ait değil).
