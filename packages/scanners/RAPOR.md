# RAPOR — `@maestro/scanners` (Dalga 2 · sertleştirme turu)

M27 (gitleaks + semgrep + trivy, dijest-pinli imajlar, **fail-closed**, sonuçlar kanıt paketine),
M77 (opsiyonel kurum sürücüleri), M34 (kanıt paketi), M44 (eklenti/DI), M71 (`scan.block_level`).

> **Bu tur ne değiştirdi:** bağımsız doğrulayıcı 16 bulguyla (B1-B16) paketi reddetti. Hepsi
> kapatıldı. En önemlisi: fikstürler artık **gerçek konteyner koşumlarının çıktısı** ve pakete
> **gerçek-araç duman testi** eklendi (`MAESTRO_SCANNERS_IT=1`). Doğrulayıcının haklı olduğu asıl
> nokta şuydu: 104 çevrimdışı test, "gitleaks hiç çalışmıyor" hatasını göremezdi — çünkü sahte
> runner, testin beklediği stdout'u döndürüyordu.

## 0. Bulgu bazında durum

| # | Bulgu | Durum | Nasıl kapandı |
|---|---|---|---|
| B1 | gitleaks `--report-path /dev/stdout` hiçbir şey yazmıyor → her tarama `error` | **Kapandı** | Rapor konteyner içinde dosyaya yazılıp geri okunuyor (`src/command.ts`); `detect` yerine v8.19+ `dir`/`git` alt komutları. Gerçek imajla doğrulandı |
| B2 | trivy ayrıştırıcısı raporu olmayan her JSON'u `pass` sayıyor | **Kapandı** | `SchemaVersion` + `ArtifactName` **zorunlu**; `{}`, `{"Results":null}`, `{"error":…}` artık `error` |
| B3 | Boş/yanlış workspace = `pass` | **Kapandı** | (a) konteyner içi kapsam kapısı (mount yok → 91, boş → 92), (b) semgrep `paths.scanned` boşsa `fatal`, (c) trivy `ArtifactName` mount yoluyla eşleşmeli, (d) sürücüde mutlak-yol ön kontrolü |
| B4 | Fortify/Sonar sayfalama sessizce kesiliyor | **Kapandı** | `HttpScanPort` gerçek sayfalama yapıyor; sunucunun bildirdiği toplam tutmazsa `error` |
| B5 | Fortify/Sonar: alakasız JSON → `pass` | **Kapandı** | `data` / `issues` zorunlu alan |
| B6 | `scanGateDecision(results, [])` → `blocking: false` | **Kapandı** | Boş `required` **ve** boş sonuç listesi koşulsuz bloke |
| B7 | Aynı araç iki kez → kanıt dosya adı çakışması, özet-kapı çelişkisi | **Kapandı** | `dedupeResults()` (en bloke edici kalır); manifest öncesi ad tekilliği assert ediliyor |
| B8 | `extraArgs` taramayı etkisizleştirebiliyor | **Kapandı** | Karar semantiğini değiştiren bayraklar reddediliyor — **ve aynı kapıyı açan env değişkenleri de** (aşağıda) |
| B9 | İmaj ADI hiç doğrulanmıyor → seçenek enjeksiyonu | **Kapandı** | OCI referans grameri; `--privileged@sha256:…` reddediliyor |
| B10 | Oynak etiket kontrolü büyük/küçük harfe duyarlı | **Kapandı** | `toLowerCase()` + liste genişletildi (`prod`, `production`, `release`, `current`, `head`) |
| B11 | Token deklaratif konfigden geçebiliyor | **Kapandı** | `depsOf` yalnız `runner`/`fetchImpl`/`clock` alıyor; kimlik-bilgisi şeklindeki anahtar **sessizce yoksayılmıyor, reddediliyor** |
| B12 | trivy `networkMode:"none"` + tohumsuz önbellekle asla koşamaz | **Belgelendi + talep açıldı** | §5.1; `runners`'a DOKUNULMADI. Duman testi bu senaryonun **fail-closed** olduğunu gerçek trivy ile kanıtlıyor |
| B13 | `run()` "asla fırlatmaz" değişmezi saat fırlatınca kırılıyor | **Kapandı** | `ContainerScanPort.run` ve `HttpScanPort.run` dış try/catch ile sarıldı; testi var |
| B14 | Fikstür yolları göreli, gerçekte `/workspace/...` geliyor | **Kapandı** | `repoPath()` mount önekini sıyırıyor; gerçek çıktıyla doğrulandı |
| B15 | sha256 testi totolojik | **Kapandı** | `sha256sum` ile hesaplanmış iki sabit dijest assert ediliyor |
| B16 | semgrep çıkış kodu yorumu yanlış | **Kapandı** | Yorumlar ölçülen davranışla değiştirildi (3 bulgu → çıkış 0; 7 = konfig hatası) |

**Doğrulayıcının en önemli isteği** — "erişim gelince doğrulanacak" maddesi çekirdek üçlü için
**kapandı**: fikstürler canlı koşum çıktılarıyla değiştirildi ve duman testi pakete girdi.
Fortify/SonarQube için hâlâ kurum erişimi gerekiyor (§4.2).

## 1. Ne yapıldı

`packages/scanners` — ScanPort sürücüleri. Üretim kodu **1586 satır**, en büyük dosya 189 satır
(tavan 300). Önceki tur 1199 satırdı; artışın tamamı fail-closed kapıları, sayfalama ve
kapsam kanıtı.

| Dosya | İş |
|---|---|
| `src/image.ts` | **Dijest pinleme kapısı** + **OCI ad grameri** (B9) + oynak etiket reddi (B10) |
| `src/config.ts` | `ContainerScanConfig` (Zod), `extraArgs`/`env` karar-bayrağı reddi (B8) |
| `src/command.ts` | **Konteyner içi sarmalayıcı**: kapsam kapısı + rapor dosyası okuma (B1/B3) |
| `src/runner.ts` | `ContainerRunner` arayüzü (enjekte edilir) + `Clock` |
| `src/tools.ts` | Araç başına komut satırı, "koştu sayılan" çıkış kodları, ayrıştırıcı bağlantısı |
| `src/parse/{gitleaks,semgrep,trivy}.ts` | Gerçek JSON şemaları + `ScanFinding` eşlemesi + kapsam kanıtı |
| `src/severity.ts` | Seviye sıralaması, eşik (`blockLevel`) değerlendirmesi |
| `src/result.ts` | `ScanResult` üretimi; **tek hata yolu** = `outcome: "error"` |
| `src/container-driver.ts` | `ContainerScanPort` — fail-closed çekirdek |
| `src/optional/http-scan.ts` | M77 ortak gövdesi + **sayfalama** (B4) + `depsOf` (B11) |
| `src/optional/{fortify,sonarqube,xray}.ts` | M77 sürücüleri |
| `src/evidence.ts` | M34 çıktısı + kapı kararı + **tekilleştirme** (B7) |
| `src/register.ts` | `registerScanDrivers(registry, deps)` (M44) |

### 1.1 gitleaks neden bir kabuk sarmalayıcısıyla koşuyor (B1)

`--report-path /dev/stdout` **hiçbir şey yazmıyor**. Gerçek v8.30.1 ile ölçüldü:

```
# 2 sır içeren ağaç, --report-path /dev/stdout
exit=1 · stdout = 0 bayt          → paket: "gitleaks: produced no output" → error
# aynı komut, --report-path /tmp/r.json
exit=1 · dosyada tam JSON (592 B) → paket: 2 bulgu → fail
```

Bu yüzden her araç şu POSIX-sh önsözünün arkasında koşuyor (`src/command.ts`):

```sh
if [ ! -d '/workspace' ]; then exit 91; fi                      # mount yok
if [ -z "$(ls -A '/workspace' 2>/dev/null)" ]; then exit 92; fi # mount boş
"$@" >/dev/null; code=$?                                        # (yalnız gitleaks)
if [ ! -f '/tmp/maestro-gitleaks-report.json' ]; then exit 93; fi
cat '/tmp/maestro-gitleaks-report.json'; exit $code
```

- Araç komutu `"$@"` ile geliyor — script metnine **hiç gömülmüyor**, dolayısıyla hiçbir argüman
  script'in anlamını değiştiremez. Script'e giren tek değer mount yolu ve o zaten
  `/[A-Za-z0-9._\-/]*` ile sınırlı (ayrıca `command.ts` içinde ikinci kez assert ediliyor).
- 91/92/93 rezerve çıkış kodları hiçbir aracın kendi kod aralığında değil; sürücü bunları
  okunabilir gerekçeye çevirip `error` üretiyor.
- **Runner gereksinimi:** konteynerin `/tmp`'si yazılabilir olmalı. Salt-okunur kök dosya
  sistemiyle koşulursa gitleaks raporu yazamaz → çıkış 93 → `error` (sessiz geçiş yok).

### 1.2 "Tarama koştu ama hiçbir şeye bakmadı" nasıl kapatıldı (B3)

Üç bağımsız kapı, üçü de gerçek araçla doğrulandı:

| Kapı | Nerede | Kanıt |
|---|---|---|
| Mount yok / boş | Konteyner içi önsöz | Boş dizin → 92 → `error` (her üç araçla da canlı) |
| semgrep hiçbir dosyaya bakmadı | `paths.scanned.length === 0` → `fatal` | Boş mount canlı çıktısı: `{"results":[],"errors":[],"paths":{"scanned":[]}}`, çıkış 0 |
| trivy başka bir hedefi taradı | `ArtifactName !== mountPath` → `fatal` | Canlı raporda `"ArtifactName": "/workspace"` |
| gitleaks | Önsöz + rapor dosyası zorunlu | Rapor yoksa 93 |
| Sürücü ön kontrolü | `workspacePath` boş **veya göreli** ise `error` | Göreli yol runner'ın çalışma dizinine göre çözülür; mount hiçbir şeyi tutmaz |

**trivy'de neden "en az bir `Results` girdisi" kuralı YOK:** canlı ölçüm, trivy 0.73.0'ın paket
manifest'i olmayan bir kaynak ağacında `Results` anahtarını **hiç yazmadığını** gösterdi (temiz
`app.js`-only ağaç ile boş dizin çıktıları `ReportID` dışında aynı). Bu kuralı koymak, lockfile'ı
olmayan her repoyu kalıcı `error`'a düşürürdü. Kapsam kanıtı bu yüzden `ArtifactName` + konteyner
içi mount kapısı üzerinden kuruldu — ikisi de aynı soruyu daha doğru cevaplıyor.

**semgrep "scanned 0 files" semantiği (bilinçli karar):** semgrep yalnız **yüklü kuralların dilini**
taşıyan dosyaları sayar. Sadece Python kuralı olan bir kural seti + sadece JS içeren bir repo →
`paths.scanned: []` → bu paket `error` veriyor. Bu bir yanlış pozitif değil: kural seti repoyu
kapsamıyor demektir ve M27 açısından "temiz geçti" demek yanlış olur. Kurumda kural seti çok dilli
olacağı için pratikte yalnız gerçek kapsam boşluklarında görülür.

### 1.3 Fail-closed nasıl garanti edildi (M27)

- `run()` **hiçbir koşulda fırlatmaz** — artık enjekte edilen saat fırlatsa bile (B13): dış
  try/catch epoch damgalı bir `error` sonucu üretiyor.
- `pass` yalnız şu dördü birden olursa döner: konteyner koştu + kapsam kanıtlandı + "tamamlandı"
  anlamına gelen çıkış kodu + tam olarak ayrıştırılabilen rapor.
- `error`'a düşen yollar: imaj çekilemedi/runner fırlattı · timeout · beklenmeyen çıkış kodu
  (rapor geçerli JSON olsa bile) · boş stdout · JSON olmayan/kesilmiş stdout · şemaya uymayan rapor ·
  aracın kendi bildirdiği hata (semgrep `errors[]`) · **kapsamsız tarama** · **rapor dosyası yok** ·
  üretilen sonucun sözleşmeyi ihlal etmesi · sürücünün başka bir araca sorulması · boş/göreli
  `workspacePath` · bayrak gibi okunabilecek `diffBaseRef` · **eksik sayfa** (M77).
- **Eşik hiçbir zaman hatayı affetmez**: `blockLevel: "critical"` olsa da `error` bloke eder.
- **"Tarama koşmadı ama devam ettik" imkânsız**: `scanGateDecision()` zorunlu üçlüden sonucu
  olmayanı `missing` sayar; boş sonuç listesi **ve boş `required` listesi** de bloke (B6).

### 1.4 Karar semantiğini değiştiren ayarlar (B8)

`scan.block_level` DB'de versiyonlu ve audit'li (M71). Aynı sonuca guard'sız ulaşan iki kanal vardı:

- `extraArgs`: `--severity`, `--exit-code`, `--skip*`, `--ignore*`, `--exclude*`, `--baseline*`,
  `--no-git`, `--config`/`-c`, `--format`/`--json`/`--output`, `--report-*`, `--enable-rule`
  → **fabrikada reddediliyor** (`--severity=HIGH` ve `--severity HIGH` aynı sayılır).
- `env`: bu araçların hepsi bayraklarını env değişkenine de yansıtıyor. `TRIVY_SEVERITY`,
  `TRIVY_IGNORE*`, `TRIVY_EXIT_CODE`, `TRIVY_SKIP_DIRS/FILES`, `GITLEAKS_CONFIG(_TOML)`,
  `GITLEAKS_ENABLE_*`, `SEMGREP_RULES/BASELINE/SEVERITY/EXCLUDE` → **reddediliyor**.
  `TRIVY_DB_REPOSITORY` ve proxy değişkenleri **serbest**: onlar "nereden çekileceğini" söyler,
  "neyin bulgu sayıldığını" değil.

`--parallel`, `--timeout` gibi yalnız koşum biçimini değiştiren bayraklar geçmeye devam ediyor.

## 2. Test özeti

`pnpm -F @maestro/scanners test` → **9 dosya, 145 test yeşil** (çevrimdışı, deterministik).
`MAESTRO_SCANNERS_IT=1` ile ek olarak **10 gerçek-araç testi** (biri karşılıklı dışlayan trivy
dalı; her iki dal da ayrı ayrı yeşil görüldü).

| Dosya | Test | Kapsam |
|---|---|---|
| `test/image.test.ts` | 16 | dijest pinleme, **OCI ad grameri (B9)**, **büyük/küçük harf + kanal etiketleri (B10)**, **env kara listesi (B8)** |
| `test/severity.test.ts` | 7 | eşik mantığı, `isScanBlocking` ile tutarlılık |
| `test/parse.test.ts` | 27 | **canlı fikstürler**, kapsam kanıtı (B2/B3), mount öneki sıyırma (B14), sır sızdırmama |
| `test/command.test.ts` | 6 | sarmalayıcı script'i, `"$@"` yalıtımı, rezerve çıkış kodları (B1/B3) |
| `test/container-driver.test.ts` | 18 | komut satırı (dosya-rapor modeli), mount/ağ/timeout, eşik, **extraArgs reddi (B8)** |
| `test/fail-closed.test.ts` | 27 | **13 başarısızlık senaryosu**, kapsamsız tarama, **fırlatan saat (B13)**, boş `required` (B6) |
| `test/evidence.test.ts` | 15 | M34 dosyaları, **tekilleştirme (B7)**, **sabit sha256 (B15)** |
| `test/register.test.ts` | 11 | M44 kayıt, **deps kısıtı (B11)**, opsiyonel sürücü reddi |
| `test/optional.test.ts` | 18 | Fortify/SonarQube/Xray, **sayfalama (B4)**, **zorunlu zarf (B5)** |
| `test/real-tools.test.ts` | 10 | **gerçek imajlar** — opt-in |

Kök kapısı: `pnpm run gate` → **38 görev, hepsi yeşil**.

### 2.1 Gerçek-araç duman testi nasıl koşulur

```bash
docker pull zricethezav/gitleaks:v8.30.1
docker pull semgrep/semgrep:1.171.0
docker pull aquasec/trivy:0.73.0

# trivy DB önbelleğini bir kez tohumla (ağ gerekir, ~1.2 GB)
mkdir -p /tmp/trivy-cache
docker run --rm -v /tmp/trivy-cache:/root/.cache/trivy \
  --entrypoint trivy aquasec/trivy:0.73.0 fs --scanners vuln /etc >/dev/null

MAESTRO_SCANNERS_IT=1 MAESTRO_SCANNERS_IT_TRIVY_CACHE=/tmp/trivy-cache \
  pnpm -F @maestro/scanners exec vitest run test/real-tools.test.ts
```

- İmajlar varsayılan olarak **dijestle** pinli (`test/real-tools.test.ts` başındaki sabitler);
  `MAESTRO_SCANNERS_IT_{GITLEAKS,SEMGREP,TRIVY}` ile kurum registry'sine yönlendirilebilir.
- `MAESTRO_SCANNERS_IT_TRIVY_CACHE` **verilmezse** trivy testi "ağsız + tohumsuz önbellek →
  `error`" iddiasını doğrular (B12). İki dal karşılıklı dışlayan; ikisi de koşuldu.
- Testler sırları depoya değil, `os.tmpdir()` altındaki geçici çalışma alanlarına yazıyor.
- Test için konteyner koşan `ContainerRunner` **yalnız `test/docker-runner.ts` içinde**;
  üretim kodu hâlâ hiçbir süreç başlatmıyor.

### 2.2 Duman testinin yakaladığı ikinci hata (çevrimdışı testlerin göremediği)

semgrep 1.171.0, `--metrics=off` verilse bile sürüm kontrolü için ağa çıkmaya çalışıyor ve
**ağsız runner'da tam 120 saniye bekliyor** — asıl tarama 0.8 saniye sürerken. Ölçüm:

```
--metrics=off                              → 2m00s
--metrics=off --disable-version-check      → 4s
```

`--disable-version-check` kalıcı olarak komut satırına eklendi. Bu, üretimde her semgrep
taramasına 2 dakika ekleyen (ve kurumda blackhole proxy varsa timeout'a kadar sürecek) gerçek bir
hataydı; sahte runner'lı hiçbir test bunu gösteremezdi.

## 3. Fikstürlerin kaynağı (dürüst kayıt — bu tur değişti)

Çekirdek üçlünün fikstürleri artık **gerçek konteyner koşumlarının birebir stdout'u**.
Çalışma alanı: iki sahte kimlik bilgisi (`ghp_…`, `sk_live_…`), `os.system()` ve `eval()` içeren
bir Python dosyası, kasıtlı sözdizimi hatalı bir Python dosyası, `lodash 4.17.15` + `minimist 1.2.0`
içeren bir `package-lock.json`; `/workspace` altına salt-okunur mount edildi.

| Fikstür | Kaynak | Not |
|---|---|---|
| `gitleaks-report.json` | gitleaks v8.30.1 canlı çıktısı, 2 bulgu | **Tek düzenleme:** `Secret` ve `Match` alanları `REDACTED-FOR-FIXTURE` yapıldı. Paket bu alanları zaten okumuyor; gerçek görünümlü bir token'ı depoya koymak Maestro'nun kendi deposunu taradığında bulgu üretirdi |
| `semgrep-results.json` | semgrep 1.171.0 canlı çıktısı, 3 bulgu | biri `metadata.severity: HIGH`, biri `metadata: {}` + `severity: INFO`, biri `metadata.severity: MEDIUM` |
| `semgrep-fatal.json` | semgrep 1.171.0, geçersiz `--config` → çıkış 7 | `errors[]` iki `level: "error"` girdisi, `paths.scanned: []` |
| `semgrep-clean.json` | semgrep 1.171.0, temiz ağaç | `paths.scanned` dolu — "bulgu yok" ile "hiçbir şeye bakmadı" ayrımının fikstürü |
| `semgrep-empty-workspace.json` | semgrep 1.171.0, **boş mount** | çıkış 0, `paths.scanned: []` — B3'ün canlı kanıtı |
| `trivy-fs.json` | trivy 0.73.0 canlı çıktısı | 9 zafiyet (1 CRITICAL, 4 HIGH, 4 MEDIUM) |
| `trivy-clean.json` | trivy 0.73.0, manifest'siz ağaç | `Results` anahtarı **hiç yok** — §1.2'nin kanıtı |
| `fortify-issues.json` | Fortify SSC dokümante REST zarfı | **erişim gelince doğrulanacak** |
| `sonarqube-issues.json` | SonarQube `/api/issues/search` | **erişim gelince doğrulanacak** |

Fikstürlerin üretildiği imaj dijestleri:

```
zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
semgrep/semgrep@sha256:bdf7013b2c3634a487671158da77c554f531742326b543a9464d2adf6c433ac8
aquasec/trivy@sha256:7cced7cae583819fc7806d4cbc0dbbc7cad18b99f7d3e235192e6da8c091045c
```

## 4. Kararlar ve varsayımlar

1. **`blockLevel` varsayılanı `"high"`** — `packages/db/src/params-defaults.ts` içindeki platform
   varsayılanıyla (M71) bilerek aynı. Eşik ne olursa olsun `error` bloke eder.
2. **gitleaks'in severity'si yoktur** — her sır `secretSeverity` ile derecelendirilir (varsayılan
   `critical`). Uydurma alan okunmadı; `Secret`/`Match`/`Entropy` sonuca **hiç girmiyor** (M20/M34).
3. **gitleaks alt komutu `dir` / `git`** — v8.30.1 `--help` çıktısında `detect` artık listelenmiyor
   (çalışıyor ama gizli). `dir <path>` ağaç taraması, `git <path> --log-opts <base>..HEAD` aralık
   taraması; ikisi de salt-okunur mount üzerinde canlı doğrulandı.
4. **semgrep `rulesRef` zorunlu** — kural seti tarama anında indirilmez (`--config=auto` ağ ister).
   `--metrics=off` ve `--disable-version-check` her koşumda geçilir (§2.2).
5. **trivy `UNKNOWN` → `medium`** — "kimse derecelendirmemiş" demektir, "zararsız" değil.
6. **semgrep bilinmeyen severity etiketi → `high`** — yeni bir etiket sessizce eşiğin altına düşmesin.
7. **trivy `Secrets` / `Misconfigurations` kapsam dışı** — sır taraması gitleaks'in işi (M27).
8. **Konteyner varsayılanı ağsız + salt-okunur mount**; `/tmp` yazılabilir olmalı (§1.1).
9. **Özet dosyası dil-bağımsız** — `scan/summary.md` sütunları sözleşme alan adları; kullanıcıya
   dönük cümle M104 kataloğunun işi.
10. **Yeni runtime bağımlılığı yok** — yalnız `zod` + `@maestro/contracts` + `@maestro/ports`;
    sha256 için `node:crypto`. contracts/ports'a ve `@maestro/runners`'a **dokunulmadı**.
11. **Sayfalama tavanı 50 sayfa** — yalan söyleyen bir `total` sonsuz döngü yapamasın; tavana
    çarpılırsa kısmi rapora karar verilmez, `error` döner.

### 4.1 Kanıt paketinde yol biçimi (B14)

Gerçek araçlar konteyner-mutlak yol veriyor (`/workspace/src/settings.js`), trivy ise zaten
göreli (`package-lock.json`), gitleaks `git` modunda da göreli. `repoPath()` mount önekini tek
yerde sıyırıyor; kanıt paketindeki her yol repo-göreli.

### 4.2 Hâlâ kurum erişimi bekleyenler

- **Fortify SSC:** uç (`/api/v1/projectVersions/{id}/issues`), `Authorization: FortifyToken <token>`
  ve `data[]` alan adları. Uygulanan akış **rapor çekme**: taramayı mevcut Fortify hattı başlatır.
  Sayfalama artık `count` üzerinden gerçekten yürüyor; `count` gelmezse ve sayfa doluysa `error`.
- **SonarQube:** `Authorization: Bearer` SonarQube 9.x+ içindir; daha eski sunucular Basic bekler.
  Sayfalama `total` + `p` üzerinden.
- Her iki opsiyonel sürücü de **https zorunlu** tutuyor.
- **Xray hangi ürün?** (M77 "Xray/Zephyr" test yönetimi diyor, `ScanTool` enum'u tarayıcı gibi
  konumluyor.) Karar gelene kadar `createXrayScanPort` yapılandırılsa bile
  `CapabilityNotSupportedError` fırlatıyor.

## 5. Talepler (orkestratör kararı gerekiyor)

### 5.1 `ContainerRunRequest`'e salt-okunur ek mount alanı (B12 — YENİ)

trivy'nin varsayılanı `networkMode: "none"`. Gerçek ölçüm:

```
--network none, tohumsuz önbellek → FATAL: failed to download vulnerability DB → exit 1 → error
--network none, tohumlanmış /root/.cache/trivy (salt-okunur mount) → exit 0, tam rapor
```

Yani **ağsız trivy yalnız tohumlanmış bir önbellekle koşabilir**, ama `ContainerRunRequest`'te
workspace dışında mount alanı yok. `@maestro/runners` bu turda ayrı bir düzeltme turunda olduğu
için **dokunulmadı**. Talep: `ContainerRunRequest`'e `readOnlyMounts: { hostPath, containerPath }[]`
benzeri bir alan eklensin (arayüz `packages/scanners/src/runner.ts` içinde, `runners` uygulaması
onu karşılasın). Alternatif: kurum `TRIVY_DB_REPOSITORY` ile iç aynayı gösterip
`networkMode: "internal"` kullanır — o yol bugün de açık.
**Bugünkü davranış güvenli:** önbellek yoksa trivy `error` veriyor ve kapı bloke ediyor; sessiz
"temiz geçti" yok. (Duman testinde `MAESTRO_SCANNERS_IT_TRIVY_CACHE` verilmediğinde bu iddia
doğrulanıyor.)

### 5.2 Konteyner koşumu için port arayüzü (önceki turdan devam)

`RunnerPort.runSession` (`packages/ports/src/runner.ts`) bu iş için kullanılamadı: (a) `RunJob`'ta
imaj alanı yok — dijest-pinli imaj ifade edilemiyor, (b) `RunResult` yalnız `stdoutTail` döndürüyor;
kesilmiş bir rapor bizde ayrıştırma hatası olur, yani her büyük tarama `error`'a düşerdi. Bu yüzden
pakette kendi `ContainerRunner` arayüzü tanımlandı (yalnız tip). **Talep:** `@maestro/runners` bu
arayüzü karşılayan bir uygulama dışa versin. `test/docker-runner.ts` beklenen davranışın
çalışan bir örneği (entrypoint override + tam stdout + timeout + salt-okunur mount).

### 5.3 `ScanResult.imageDigest` konteyner-olmayan sürücülere uymuyor

Alan zorunlu ve `NonEmpty`; Fortify/SonarQube'un imajı yok. Şimdilik köken dizesi yazılıyor
(`fortify-ssc:projectVersion/42`). **Öneri:** sözleşmede alan `provenance` olarak genelleşsin veya
`imageDigest` opsiyonel + `provenance` eklensin. (Sözleşme DONUK olduğu için değiştirilmedi.)

### 5.4 `ScanResult`'ta hata sebebi alanı yok

`maestro.scan-error` (severity `critical`) sentetik bulgusu kullanılıyor — `maestro.` öneki hiçbir
araç kuralıyla çakışmaz. Sözleşmeye opsiyonel `note`/`error` alanı eklenirse bu geçici çözüm kalkar.
Araç stderr'i varsayılan olarak sonuca **girmez** (`includeStderrInError: false`): stderr eşleşen
satırı yankılayabilir, hata sonucu bir sır ifşa kanalı olmamalı.

### 5.5 Runner'dan beklenen iki davranış (yeni, küçük)

1. Konteynerin `/tmp`'si yazılabilir olmalı (gitleaks raporu). Salt-okunur kökle koşulacaksa
   `--tmpfs /tmp` yeterli.
2. `argv[0]` artık `sh`; runner imaj entrypoint'ini geçersiz kılmaya devam etmeli (zaten arayüz
   sözleşmesinde yazıyordu).
