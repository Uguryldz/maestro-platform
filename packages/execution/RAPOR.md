# RAPOR — `@maestro/execution` + `@maestro/claude-driver`

Dalga 2 paketi: **ajan oturumunun gerçekten koşturulması** (M17 · M30 · M52 · M54 · M55/M107 · M20/M82).
`packages/contracts` ve `packages/ports` **okundu, değiştirilmedi**.

Bu sürüm, bağımsız doğrulamanın "KALDI" raporundaki bulguların kapatılmasıdır. Bulguların tamamı
canlı koşumla yeniden üretildi, düzeltildi ve her biri için **önce kırılan test** yazıldı.
Kapanış durumu → §9.

## 0. Paket bölünmesi (neden iki paket)

Tek paket 1220 satıra çıkmıştı (tavan 1200) ve bulguların kapatılması kaçınılmaz olarak daha da
büyütüyordu. Paket, doğal sınırından ikiye ayrıldı:

| Paket | Sorumluluk | Üretim satırı |
|---|---|---|
| `@maestro/claude-driver` | Yerel `claude` CLI'sinin sürülmesi: argv/env, stream-json okuyucu, `AgentRunner`, süreç adaptörü | **709** |
| `@maestro/execution` | Turun orkestrasyonu: M30 bootstrap, M52 kapısı, M54 sayaç, sonuç toplama, PII sınırı | **1010** |

Bağımlılık yönü tek yönlü: `execution` `LlmPort` üzerinden çalışır, `claude-driver`'ı **tanımaz**.
İkisini composition root birleştirir. En büyük dosya 224 satır (tavan 300).
**184 test / 10 dosya** (execution 116/6, claude-driver 68/4), hepsi çevrimdışı ve deterministik.

## 1. Ne yazıldı

| Dosya | İçerik |
|---|---|
| `claude-driver/src/cli.ts` | `claude` argv + env üreticisi (saf). Bayrak doğrulaması → §2 |
| `claude-driver/src/stream-json.ts` | `--output-format stream-json` NDJSON okuyucusu (saf, fail-closed) |
| `claude-driver/src/claude-sub.ts` | **`ClaudeSubRunner implements AgentRunner`** — M55/M107 sürücüsü |
| `claude-driver/src/node-spawn.ts` | `SpawnFn`'in `node:child_process` gerçeklemesi (tek saf-olmayan adaptör) |
| `execution/src/bootstrap.ts` | M30 oturum bootstrap metni + `composeTurnPrompt` (saf) |
| `execution/src/protected-paths.ts` | M52 deny-list: glob derleyici, yol normalize, ihlal bulucu |
| `execution/src/ci-fingerprint.ts` | M54 CI hata kimliği: gürültü normalizasyonu + **yapılandırılmış sinyal çıkarımı** |
| `execution/src/strikes.ts` | M54 sayaç + "insana devir" kararı |
| `execution/src/collect.ts` | Sonuç toplama + **PII sınırı ve egress tuzağından** geçen journal yazıcısı |
| `execution/src/execution.ts` | `AgentExecution.runTurn` — turu uçtan uca bağlayan orkestrasyon |

## 2. CLI bayrakları nereden doğrulandı (uydurma yok)

Makinede kurulu sürüm: `/home/ubuntu/.local/bin/claude` → `.../versions/2.1.226`.
**Gerçek `claude` hiçbir testte çağrılmadı**; doğrulama `claude --help` çıktısından ve ikilinin
içindeki dizgilerden (`grep -a`, ikili çalıştırılmadan) yapıldı.

| Bayrak | Yardım metnindeki tanım |
|---|---|
| `-p, --print` | "Print response and exit" |
| `--output-format stream-json` | "only works with --print" |
| `--verbose` | stream-json ile **zorunlu çift** (aşağıdaki hata dizgisi) |
| `--input-format text` | "only works with --print" |
| `--model` / `--permission-mode` | choices: `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` |
| `--safe-mode` | "Start with all customizations … disabled … **Auth, model selection, built-in tools, and permissions work normally**" |
| `--setting-sources <sources>` | "Comma-separated list of setting sources to load (user, project, local)" |
| `--settings <file-or-json>` | "Path to a settings JSON file …" |
| `--tools <tools...>` | "Specify the list of **available** tools from the built-in set. Use `\"\"` to disable all tools…" |
| `--allowedTools <tools...>` | "list of tool names to **allow**" |
| `--mcp-config` / `--strict-mcp-config` | "Only use MCP servers from --mcp-config, ignoring all other MCP configurations" |
| `-r, --resume` / `--session-id <uuid>` | M30 oturum devamı |
| `--fork-session` | **kullanılmıyor** (id'nin sabit kalması resume doğrulamasının dayanağı) |

İkiliden okunan, kararları doğrudan belirleyen iki dizgi:

```
"Error: When using --print, --output-format=stream-json requires --verbose"
HkS=["user","project","local"]      → --setting-sources VARSAYILANI
```

### 2a. Müşteri repo'sunun ayar yüzeyi neden ve nasıl kapatılıyor (Y4)

Ajan **müşteri repo'sunun içinde** koşuyor, dolayısıyla repo'daki `.claude/` düşman girdidir.
`HkS=["user","project","local"]` gösteriyor ki bayrak verilmezse repo'nun `.claude/settings.json` ve
`.claude/settings.local.json` dosyaları **yükleniyor** — bunlar `hooks` taşıyabilir, yani CLI'nin
bankanın runner'ında çalıştırdığı keyfi komutlar. M52 kapısı bunu göremez: kapı git diff'i üstünde
ve **sonradan** koşar, hook ise diff oluşmadan önce çalışır.

Kapatma **iki bağımsız yarımdan** oluşuyor, ikisi de koşulsuz üretiliyor:

1. **`--setting-sources user`** — taşıyıcı yarım. Proje ve local ayar kaynakları hiç okunmaz.
2. **`--safe-mode`** — CLAUDE.md, skills, plugins, agents, workflows, output styles, LSP,
   keybindings ve keşfedilen MCP sunucularını kapatır; hook'ları yalnız admin-managed (policy)
   ayarlarıyla sınırlar. İkilideki `XYy` tablosu ve `Qxs()` bunu doğruluyor.

**`--bare` neden değil:** yardım metni "Anthropic auth is strictly `ANTHROPIC_API_KEY` or
`apiKeyHelper` (OAuth and keychain are never read)" diyor; abonelik koltuğunun API anahtarı yok,
`--bare` bu sürücüyü çalışamaz hale getirir. `--safe-mode` ise auth'a dokunmuyor — seçimin sebebi
tam olarak bu.

**`--safe-mode` MCP'yi öldürmüyor mu?** Yardım metni "MCP servers … disabled" diyor; ikilideki
gerçekleme bunu `mcpAutoDiscovered`, `mcpClaudeAi`, `mcpAgentFrontmatter` ile sınırlıyor — yani
**keşfedilen** sunucular. `--mcp-config` ile açıkça verilen platform dosyası etkilenmiyor, ki bu
sürücünün dayandığı yol odur. Yine de bu bir ikili-içi ayrıntı olduğu için daraltma buna
yaslanmıyor: `--strict-mcp-config` de koşulsuz gönderiliyor (§2b).

### 2b. Araç kümesi: kullanılabilirlik ≠ onay (Y5, Y6)

Önceki sürümde yalnız `--allowedTools mcp__<server>` üretiliyordu ve hem kod yorumu hem modele giden
bootstrap cümlesi bunu "yalnız bu sunuculara ulaşabilirsin" diye anlatıyordu. `claude --help` bu iki
kavramı ayırıyor: `--tools` **kullanılabilirlik**, `--allowedTools` **onay**. Onay listesi araç
kümesini daraltmaz, üstelik `bypassPermissions` modu onayı tamamen geçersiz kılar.

Şimdi:

- **`--tools`** zorunlu alan; yerleşik araç kümesi pinleniyor (`[]` → `--tools ""`, hepsi kapalı).
- **`--strict-mcp-config` koşulsuz**; `mcpConfigPath` yoksa bile gönderiliyor, böylece workspace'in
  kendi `.mcp.json`'ı ve operatörün kullanıcı düzeyi sunucuları asla yüklenmiyor. Eski davranışta
  `mcpConfigPath: null` (veya `"   "`) **sıfır daraltma** demekti.
- **`bypassPermissions` sandbox dışında reddediliyor** (`ExecutionConfigError`); `sandboxed: true`
  açıkça verilmeden bu mod kurulamaz.
- `--disallowedTools` **bilerek üretilmiyor**: `--tools` kullanılabilirliği pinlediği için var
  olmayan bir aracın ayrıca reddedilmesi gereksiz. Gerekçe burada kayıtlı olsun diye yazıldı.
- Bootstrap promptundaki cümle düzeltildi: "Reach systems through these MCP servers only" →
  "These MCP servers are configured for this session".

### 2c. Diğer sürücü kararları

- **Prompt argv'de değil, stdin'de.** `ps` çıktısına düşmez, bayrak sanılamaz. `cli.test.ts` artık
  argv'deki bayrak-dışı her jetonu beyaz listeye karşı sayıyor (eski test hiç kırılamayan bir
  iddiaydı — §8).
- **Env allow-list.** `process.env` kopyalanmıyor. `extra` alanı `PASSTHROUGH_ENV` (kurum proxy'si +
  TLS trust store) ile filtreleniyor ve **ÖNCE** yayılıyor; `PATH`/`HOME`/token/configDir'i ezemez.
  Eskiden `extra` en sona yayılıyordu, yani allow-list'i deliyordu (O9).
- **Koltuk izolasyonu zorunlu.** `SeatCredential.configDir` artık `string` ve boş olamaz. `null`
  olabildiğinde tüm koltuklar tek `~/.claude`'u paylaşıyordu: tur 2 başka koltukta koşarsa `--resume`
  A'nın transkriptini B'nin hesabıyla gönderirdi ve kimlik kontrolü bunu yakalayamazdı (id doğru,
  hesap yanlış) (O4).
- **Oturum kimliği iki yönde de doğrulanıyor.** `--resume` sonrası farklı id → M30 bağlamı gitti.
  `--session-id` ile pinlenen yeni oturum farklı dönerse gateway'in oturum deposu transkripte
  ulaşmayan bir id kaydeder — aynı kayıp, bir tur sonra (D1).
- **Fail-closed okuma.** `result` yok / iki tane / `is_error` / non-zero exit / timeout → hepsi hata.
  Ayrıca **okunamayan satır kalırsa tur reddediliyor**: stream-json modunda stdout'un her satırı
  NDJSON'dur, değilse ya sürüm kayması ya da akışa yazan başka bir şey vardır. Sayaç eskiden
  hesaplanıp atılıyordu, yani "asla sessizce düşmez" vaadi ayrıştırıcının içinde bitiyordu (D3).
- **Kota muhasebesi fail-closed.** M55 dolar değil kota sayar, yani jeton sayıları **sayacın
  kendisidir**. `success` sonucunda okunamayan `usage` artık protokol hatası; eskiden 0/0 dönüyordu
  ve bu aşağı akışta "bilinmiyor" değil "bedava tur" olarak okunuyordu — dolmuş koltuğa iş
  verilmesinin yolu (O5). Gerçekten bedava tur (`0`) hâlâ kabul ediliyor: sıfır bir sayıdır, yokluk
  değil.
- **Süreç adaptörü.** `child.stdin.on("error")` `.end()`'ten **önce** bağlanıyor (Y1) ve timeout
  tüm süreç grubunu öldürüyor (`detached: true` + `process.kill(-pid)`) (D2). İkisi de §9'da
  anlatıldığı gibi canlı koşumla üretildi.

## 3. M30 — bootstrap

`buildSessionBootstrap(ctx)` saf fonksiyon; ticket defteri + yaşayan özet + workspace durumu +
protected_paths + MCP sunucuları + görev tek blok. `composeTurnPrompt(ctx, isResume)`: resume'da
**yalnız görev** gider.

Bir düzeltme: prompt artık **etkin** protected-path listesini yazıyor (platform tabanı dahil),
yalnız repo'nun eklemelerini değil. Kapı tabana göre de yargıladığı için, ajana hiç gösterilmemiş
bir kural tuzaktır. Ayrıca "yeniden adlandırma da değiştirmektir" cümlesi eklendi.

## 4. M52 — protected_paths (fail-closed)

Önceki RAPOR bu bölümde **yanlış** bir iddia taşıyordu ("fazlasını isteyen desen yükleme anında
reddediliyor"). Gerçekte derleyici anlamadığı söz dizimini reddetmiyor, meta-karakterleri kaçırıp
**ölü desen** üretiyordu. Canlı kanıt (eski derleyici):

```
**/*.{sql,ddl}  →  ^(?:[^/]+\/)*[^/]*\.\{sql,ddl\}$   →  db/x.sql eşleşmiyor
```

Yani incelemede koruma gibi okunan bir satır, çalışma anında hiçbir şeyi korumuyordu. Bu, bu
dosyanın üretebileceği en tehlikeli şeydir.

Şimdi:

- **Beyaz liste, kaçırmadan ÖNCE.** `*?/` dışında `[A-Za-z0-9._-]` olmayan her karakter
  `ExecutionConfigError` atar; hata mesajı suçlu karakteri adıyla söyler. `**/*.{sql,ddl}`,
  `**/[Ss]ecrets/**`, `+(migrations|secrets)/**` artık **yükleme anında** reddediliyor (Y2).
- **Varsayılanlar taban, ikame değil.** `createProtectedPathMatcher(extra)` her zaman
  `DEFAULT_PROTECTED_PATHS` ∪ `extra` kurar; varsayılansız matcher kurmanın **yolu yok**. Eskiden
  `protectedPaths: []` ile koşan bir tur `db/migrations/1.sql` + `api/.env` + `tls/server.key`
  değiştirip `status:"ok"` dönüyordu — M52 tamamen kapalıydı (Y3).
- **Büyük/küçük harf ve unicode.** Derleme `i` bayrağıyla, yollar ve desenler `NFC` ile
  normalize ediliyor. `db/Migrations/001.SQL`, `api/.ENV`, `tls/server.KEY`, `.Maestro.yaml` artık
  yakalanıyor; NFD bir yol NFC bir deseni eşliyor (macOS) (O7).
- **Yeniden adlandırma ve tip değişimi.** `ChangedFile.status` artık `renamed` ve `typechange`
  içeriyor, `fromPath` alanı var ve ihlal kontrolü **iki ucu da** bakıyor. `src/util.ts` →
  `app/secrets/stolen.txt` ve `tls/server.key` → `public/notes.txt` ikisi de ihlal. Düz dosyanın
  sembolik linke dönmesi artık "modified" gibi görünmüyor (O6).
- **Varsayılan liste genişledi** (O8): migration/secrets'ın yanına runner'ın kendi yürütme yüzeyi
  (`.git/**`, `.github/**`, `.gitlab-ci.yml`, `Jenkinsfile`, `.claude/**`), ek anahtar formatları
  (`*.p12`, `*.pfx`, `*.jks`, `id_rsa*`, `.npmrc`) ve M53 gereği çözülmüş bağımlılık grafiği
  (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `go.sum`, `Cargo.lock`, `poetry.lock`).
- **`.git/` için ayrı kontrol.** `git status` kendi dizinini raporlayamaz, dolayısıyla
  `.git/hooks/post-checkout`'a bırakılan bir hook hem korumasız hem **görünmezdi** — runner'da
  kalıcı kod yürütme, hiçbir diff'te izi olmadan. `WorkspaceProbe` artık ikinci bir metot taşıyor:
  `internalChangedFiles()`. `AgentExecution` ikisini birleştirip kapıya veriyor.
- **Tek tanım.** `assertNoProtectedChanges` / `ProtectedPathViolationError` **silindi**. Yazılmış
  ama hiçbir yerden çağrılmayan bu ikili M52'nin ikinci tanımıydı ve önceki RAPOR "kapının kendisi"
  diye tam olarak ölü olanı anlatıyordu. Kapı `findProtectedViolations` + `runTurn`'ün
  `status:"failed", reason:"protected_path"` dalıdır (D5).
- Workspace okunamıyorsa `WorkspaceProbeError` — "hiçbir şeye dokunulmadı" kanıtlanamaz.

## 5. M54 — 3-strike devir

`StrikeLedger(now, limit = 3)`; anahtar `{runId, scope, ref}`. `handoverDecision(state)` →
`{handover, workMode: "ai_assist", messageKey: "run.handover_stuck", count, limit, reasons}`.

**CI parmak izi baştan yazıldı.** Eski sürüm iki yönde birden bozuktu ve ikisi de canlı üretildi:

| Yön | Eski davranış | Sonuç |
|---|---|---|
| Fazla kaba | Her yol `<path>` oluyordu, yani `FAIL src/pay/mapper.test.ts` ile `FAIL src/auth/login.test.ts` aynı dizgeydi | Farklı iki hata tek sayaca düşüyor → **erken devir** |
| Fazla ince | Çıktıdaki opak bir jeton (korelasyon id'si, temp dizin) her koşumda değişiyordu | Sayaç her koşumda 1'den başlıyor → **M54 hiç tetiklenmiyor**, sonsuz döngü koruması ölü |

Yeni tasarım çıktının hash'i değil: önce gürültü normalize ediliyor, sonra **yapı** çıkarılıyor
(hangi test, hangi hata sınıfı, hangi TS tanı kodu, hangi runtime kodu) ve yalnız o sinyaller
hash'leniyor. Anahtar ayrıntılar:

- Yollar `<path>`'e çökmüyor, **basename'i korunuyor**: `/w/run-1/src/pay/mapper.test.ts` ile
  `/w/run-2/...` aynı, `mapper.test.ts` ile `login.test.ts` farklı.
- Opak jeton kuralı "8+ alfanümerik" değil, "8+ ve **hem harf hem rakam içeren**". Blanket kural
  `assertionerror` / `referenceerror` kelimelerini de yutardı — hata sınıfı buradaki en değerli
  sinyal, onu silen bir kural bir hatayı diğeriyle takas eder.
- `error TS2345` gibi tanı kodları **korunuyor**; sayı normalizasyonu bu formu atlıyor.
- Komut kimliği (`ad#exitCode`) her zaman parmak izinin parçası: kırmızı `lint` ile kırmızı `test`
  aynı problem değildir.
- Hiçbir yapı tanınmazsa normalize metne düşülüyor — kaba ama asla sessizce boş değil.
- `ciSignals()` dışa açık: "bu hatanın kimliği olarak neyi saydık" sorusu, takılan bir koşumun
  devir notunda insana gösterilmesi gereken şeydir.

Testler her iki yönü de kapsıyor (18 test, `ci-fingerprint.test.ts`).

**Sinyal üretilir, uygulanmaz.** Work-mode değişimi ve Jira özeti Dalga 3 workflow'unun işi.

## 6. Sonuç toplama + PII sınırı (M20/M82)

`SessionReport` = değişen dosyalar · diff özeti · komut çıktıları · protected ihlalleri · strike
durumu · `resumeToken` · zaman damgası.

Journal yazımı `createReportJournal()` üzerinden `withPiiBoundary` ile; sink'in parametre tipi
`Masked<SessionReport>` olduğu için ham rapor ile sink'i çağırmak **derlenmez**.

İki düzeltme:

- **Tel tuzağı artık son hop'ta.** `journalSink` `guardEgress` ile sarılıyor (`guardedJournalSink`).
  Tip markası yalnız bu paketin içindeki bir çağıranı durdurur; sink'e başka yerde mühürlenmiş bir
  yükün verilmesine ya da maskeleyicinin bir şeyi kaçırmasına karşı bir şey yapmaz. `guardEgress`
  ikisini de, maskeleyicinin kullandığı **aynı derlenmiş profille**, satır yazılmadan hemen önce
  yeniden kontrol ediyor (D4).
- **Oturum ömrü koşum başına.** Yazıcı artık `dataClass` ile değil **`runId`** ile anahtarlanıyor.
  Sınıfla anahtarlandığında aynı sınıfı paylaşan iki ticket tek yazıcıyı paylaşıyordu: iki ayrı
  ticket'ın defterine **aynı jeton** yazılıyordu ve ReverseMap A'nın gerçek değerlerini B koşarken
  bellekte canlı tutuyordu (O1). Koşum bitince `endRun(runId)` sözlükten düşürüyor; devir kararı
  bunu kendisi çağırıyor ve açık koşum sayısı `maxOpenRuns` (varsayılan 8) ile sınırlı — bu bir
  performans ayarı değil, **bellekte tutulan sır** sınırıdır.
- **Koşum ortasında sınıf değişimi reddediliyor.** Tur 1 `dahili` → tur 2 `gizli` durumunda eski kod
  sessizce ikinci bir oturum açıyor ve 1. turun jetonunun parantezlerini söküyordu. Artık
  `DataClassChangedError`: defterin zaten yazdığı satırlar geriye dönük yeniden maskelenemeyeceği
  için tek fail-closed cevap gürültülü durmaktır (O2).

## 7. Varsayımlar

1. `WorkspaceProbe` ve `VerificationRunner` bu pakette gerçeklenmedi, enjekte ediliyor —
   `runners/docker-linux` ve Dalga 3'ün işi. **Yeni yükümlülük:** `WorkspaceProbe` artık
   `internalChangedFiles()` de istiyor; gerçekleme `.git/` dizinini oturuma verildiği hâliyle
   karşılaştırmalı (git kendi içini raporlayamaz).
2. `permissionMode` ve `tools` varsayılansız, zorunlu alanlar: bir bankada ajanın gözetimsiz ne
   kadar iş yapabileceğine bu paket karar veremez.
3. `credentialRef → SeatCredential` çözümü `resolveSeat` ile dışarıda; bu nesne hiçbir zaman token
   tutmaz. `configDir` artık zorunlu, havuzdaki her koltuk kendi oturum deposunu almalı.
4. `@maestro/llm-gateway` bağımlılığı yalnız `claude-driver`'da ve yalnız tip içindir.
5. Yeni npm bağımlılığı yok. Kullanılmayan `zod` runtime bağımlılığı `devDependencies`'e alındı
   (yalnız test helper'ında `import type`) (D6).

## 8. Test kalitesi

Bağımsız doğrulamanın işaret ettiği iki zayıf test düzeltildi:

- `strikes.test.ts`'in parmak izi testleri gerçekçi olmayan tek satırlık girdiyle yanlış güven
  veriyordu ve O3'ün iki yönünü de kaçırıyordu. Yerine `ci-fingerprint.test.ts` geldi: gerçek vitest
  çıktısı şeklinde fikstürler, iki yön de ayrı ayrı kapsanıyor.
- `cli.test.ts`'teki "keeps the prompt out of argv" testi, fonksiyonun hiç almadığı bir dizgenin
  argv'de olmadığını iddia ediyordu — hiç kırılamazdı. Yerine argv'deki **bayrak-dışı her jetonu**
  beyaz listeye karşı sayan bir test kondu; bildirilmiş bir seçenekten gelmeyen her şey testi kırar.

## 9. Bulgu kapanış tablosu

Yöntem: her bulgu için önce kırılan test yazıldı; Y1/D2/Y2/O3/O7 ayrıca **eski gerçeklemeler
satır satır kopyalanıp koşturularak** canlı üretildi (geçici dosyalar commit'ten önce silindi).

| Bulgu | Durum | Kanıt / düzeltme |
|---|---|---|
| Y1 stdin EPIPE | Kapandı | Eski kodda `Error: write EPIPE` yakalandı; `.end()` öncesi `stdin.on("error")` |
| Y2 ölü glob | Kapandı | Eski derleyici `\{sql,ddl\}` üretiyordu; kaçırmadan önce beyaz liste + RAPOR §4 düzeltildi |
| Y3 boş liste fail-open | Kapandı | Varsayılanlar artık BİRLEŞİM; varsayılansız matcher kurulamıyor |
| Y4 hook/ayar yüzeyi | Kapandı | `--safe-mode` + `--setting-sources user` koşulsuz; gerekçe §2a |
| Y5 `--allowedTools` yanılgısı | Kapandı | `--tools` pinliyor; `bypassPermissions` sandbox dışında reddediliyor; yorum + prompt düzeltildi |
| Y6 `mcpConfigPath: null` | Kapandı | `--strict-mcp-config` koşulsuz |
| O1 jeton sızması | Kapandı | Yazıcı `runId` ile anahtarlı; `endRun` + `maxOpenRuns` |
| O2 sınıf değişimi | Kapandı | `DataClassChangedError` |
| O3 CI parmak izi | Kapandı | Yapılandırılmış çıkarım; iki yön de canlı üretildi ve test edildi |
| O4 koltuk izolasyonu | Kapandı | `configDir` zorunlu `string` |
| O5 `usage` yoksa 0 | Kapandı | `success`'te okunamayan usage → protokol hatası |
| O6 rename/typechange | Kapandı | `fromPath` + iki uçlu kontrol + `typechange` |
| O7 harf/unicode atlatması | Kapandı | `i` bayrağı + `NFC` |
| O8 varsayılan liste dar | Kapandı | Liste genişletildi + `internalChangedFiles()` ile `.git/` bütünlüğü |
| O9 `extra` allow-list'i deliyor | Kapandı | `PASSTHROUGH_ENV` ile filtre, ÖNCE yayılıyor |
| D1 yeni oturum kimliği | Kapandı | İki yönlü doğrulama |
| D2 torun süreç | Kapandı | Eski kodda torun dosyayı yazdı; `detached` + grup kill |
| D3 `unparsedLines` | Kapandı | Okunamayan satır varsa tur reddediliyor |
| D4 `guardEgress` | Kapandı | `guardedJournalSink` |
| D5 ölü yol | Kapandı | `assertNoProtectedChanges` + `ProtectedPathViolationError` silindi |
| D6 kullanılmayan `zod` | Kapandı | `devDependencies`'e alındı |
| D7 RAPOR sayıları | Kapandı | 709 + 1010 satır, 184 test / 10 dosya |

## 10. Talepler (orkestratör kararı gerekir)

1. **i18n anahtarı:** `run.handover_stuck` (M54) `packages/config/locales`'a eklenmeli.
2. **`.maestro.yaml` şeması:** `protected_paths` ve lint/build/test komutları için Zod şeması yok;
   şema `contracts`'a girerse buradaki tipler ona bağlanmalı — arayüz değişikliği, karar
   orkestratörde.
3. **M53 lockfile politikası:** lockfile'lar varsayılan deny-list'e alındı, yani bir bağımlılık
   değişikliği artık **insana devir** üretiyor. M53 "lockfile değişimi PR'da ayrıca işaretli" diyor;
   bu daha sert bir yorum. Rutin sürüm yükseltmeleri için fazla katıysa lockfile satırları tabandan
   çıkarılıp `scanners`'ın işaretleme yoluna bırakılmalı — **politika kararı**.
4. **`WorkspaceProbe.internalChangedFiles()`** Dalga 3 / `runners` tarafında gerçeklenmeli;
   gerçeklenmeden M52'nin `.git/` kolu enjekte edilen double'a bağlıdır.
5. **Kota muhasebesi:** abonelik sürücüsünde `--max-budget-usd` bilerek geçilmiyor (maliyet dolar
   değil kota). `result.total_cost_usd` ayrıştırılıyor ama `LlmCallLog.usd` gateway'de `null` kalıyor.
6. **Oturum ilerlemesinin journal'a akıtılması:** `onStdoutLine` ucu var ve `nodeSpawn` besliyor;
   bağlantı Dalga 2 `memory` paketiyle kurulmalı.
