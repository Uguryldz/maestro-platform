# RAPOR — Mühendislik turu (6a) çalışır hale getirildi

**Branch:** `main` (worktree `agent-af5580acd014c9914`)
**Base:** `528481d`
**Gate:** `pnpm run gate` → exit 0, **60/60 task**

---

## Özet

`AgentExecution` zaten yazılmıştı ve doğruydu — M52 kapısını doğrulamadan önce
çalıştırma sırası, maskelenmiş journal, vuruş defteri hepsi yerindeydi. Eksik
olan yalnızca **üç işbirlikçiydi**. Üçü de yazıldı, seam dolduruldu, ret kalktı.

---

## Üç işbirlikçi

### 1. `WorkspaceProbe` → `SandboxWorkspaceProbe`
`packages/execution/src/workspace-probe.ts` + `git-status.ts`

- `git status --porcelain=v1 -z -uall` + `git diff --numstat -z`, **sandbox içinde**
  (`RunnerPort` üzerinden; host'ta değil — klon yalnızca sandbox'ta var).
- `-z` seçimi kasıtlı: porcelain v1 boşluk/tırnak içeren yolları escape'ler,
  satır tabanlı parser var olmayan bir yol üretir, var olmayan yol da hiçbir
  deny-list desenine uymaz. `-z` bu hata sınıfını ele almak yerine **ortadan
  kaldırır**.
- `-uall`: varsayılan `-unormal` yeni bir dizini **tek** girdiye indirger, o
  girdi de dizinin kendisidir — `.github/workflows/` altına açılan üç dosya
  korumalı olmayan tek bir yol gibi görünürdü.
- Rename'in **iki ucu** da kaydedilir (porcelain'de iki NUL alanı kaplar; naif
  split sonraki tüm girdileri kaydırır).
- `.git/` taraması ayrı: git kendi dizinini izlemez, `.git/hooks/post-checkout`
  hem korumasız hem de her diff'e görünmezdir.
- **Fail-closed:** komut 0 dönmezse hata fırlatır, asla "değişiklik yok" demez.

### 2. `VerificationRunner` → `SandboxVerificationRunner`
`packages/execution/src/verification-runner.ts`

- Repo'nun **kendi** komutlarını (`.maestro.yaml` / `RunContext.verification`)
  sandbox'ta çalıştırır; verdict **çıkış kodudur**, çıktı değil.
- **Kesilmiş çıktı asla "geçti" değildir.** `RunnerPort` tail döndürür, `tail()`
  akışın **başını** atar ve `RunResult`'ta bunu söyleyen hiçbir alan yoktur.
  Tail bütçesi dolduysa komut `TRUNCATED_EXIT_CODE` (-2) ile **başarısız**
  işaretlenir ve sebep stderr tail'ine yazılır — CI parmak izi, devir notu ve
  journal zaten oraya bakar. Bütçeye **tam** oturan çıktı da kesilmiş sayılır:
  ayırt edilemez, ve doğrulama kapısında ayırt edilemezin güvenli okuması
  kötümser olandır.
- Byte sayar, karakter değil (32 Türkçe karakter = 64 byte).

### 3. `StrikeLedger` → `PersistentStrikeLedger`
`packages/execution/src/persistent-strikes.ts` + `apps/deploy/src/stores/strikes.ts`
+ `StrikeCounter` tablosu (migration `0005_strike_counters`)

- **Kalıcı**: `Map` tek bir hiç durmayan worker için doğruydu; ikisi de geçerli
  değil — worker redeploy edilir, Temporal aktiviteyi **başka** bir worker'da
  yeniden dener. İkisi de sayacı sıfırlar, "üç kez aynı hata" hiç gelmez ve
  koşu insana ulaşmak yerine sonsuza dek aynı turu dener.
- Arayüz **senkron** (`record(): StrikeState`) — `AgentExecution` bunu turun
  verdict'i içinden çağırır. Bu yüzden **load-before / write-behind**:
  `hydrate(runId)` tur başında satırları okur, yazma kuyruğa alınır,
  `pendingWrites()` tur sonunda beklenir. Devri haklı çıkaran vuruş, workflow
  ona göre davranmadan önce diskte olur.
- Yazma hatası **tura fırlatılmaz** (tur kendi sebebiyle zaten başarısız;
  yerine DB hatası koymak operatöre yanlış hikâyeyi anlatır) ama **sessiz de
  değildir** (`onWriteError`).
- `handover`, saklanan değil **güncel** limitten türetilir (M71 limiti tur
  arasında değiştirebilir).

---

## `DEGRADED_CAPABILITIES` — önce / sonra

**Önce** (3 madde, ilki):
> "AgentTurnRunner (M30/M52/M54): the engineering turn … **REFUSES** with a named
> error. `AgentExecution` needs a WorkspaceProbe, a VerificationRunner and a
> StrikeLedger over the runner fleet; **none of the three is implemented**."

**Sonra:** madde **listeden kalktı**. `DEGRADED_CAPABILITIES.length` 3 → **2**.

Liste statikten `degradedCapabilities(reason)` fonksiyonuna dönüştü, çünkü artık
turun çalışıp çalışmaması **implementasyon** değil **deployment** sorusu:
sandbox filosu digest-pinned imaj ister (M27). `RUNNER_IMAGE_LINUX` **set ise**
hiçbir degraded madde yoktur; **set değilse** madde geri gelir ama **farklı
şey söyler** — "kimse yazmadı" değil, "bu deployment'ta filo yapılandırılmamış,
şu değişkeni ayarla". Operatörün ilkiyle yapabileceği bir şey yoktu.

`unwiredAgentTurnRunner` silindi; yerine `unrunnableTurnRunner(reason)`.

---

## Mutasyon kanıtları (9 — istenen 5'in üzerinde)

Her biri: bozuldu → test kırıldı → geri alındı. Kaynaklar temiz.

| # | Mutasyon | Kırılan test |
|---|---|---|
| M1 | `runSession`'a `signal` geçilmiyor | **3** (probe + verifier kill switch, release) |
| M2 | Truncation tespiti kapatıldı | **6** (tümü "truncated output is never a pass") |
| M3 | `hydrate` no-op — sayaç restart'ta sıfırlanıyor | **3** (M54 kalıcılık) |
| M4 | M52 ihlalinde build yine de koşuyor | **1** ("does NOT spend a build on an illegal diff") |
| M5 | Lease `finally`'de bırakılmıyor | **8** (her yolda teardown) |
| M6 | Rename kaynağı (`fromPath`) düşürüldü | **1** (korumalı zeminden **çıkan** içerik) |
| M7 | `.git/` taraması kör edildi | **2** (post-checkout hook, uçtan uca) |
| M8 | Tur kendi signal'ını sandbox'a geçirmiyor | **1 (uçtan uca)** kill switch |
| M9c | Violations rapordan silindi **+** verdict kapatıldı | **1 (uçtan uca)** M52 |

**M9 hakkında önemli bulgu:** M52'yi tek başına bozmak **yetmedi**. İki bağımsız
katman var — `AgentExecution.judge()` ve `runEngineering`'in kendi
`report.protectedViolations.length === 0` kontrolü — ve **her biri tek başına
yeterli**. Yalnızca **ikisini birden** bozduğumda koşu `done`'a ulaştı ve test
kırıldı. Bu, zayıf test değil, kasıtlı derinlemesine savunma; testte
belgelendi.

---

## Uçtan uca kanıt

`packages/workflows/test/workflow-engineering-turn.test.ts` — **4 test**,
`TestWorkflowEnvironment` (time-skipping) üzerinde, **gerçek**
`SandboxAgentTurnRunner` `createActivities` ile workflow'a bağlanmış. Diğer tüm
aktiviteler fake kalır; ağ/LLM/container yok.

1. **6a gerçekten koşuyor** — gerçek probe ve gerçek verifier sandbox'ta komut
   çalıştırıyor, rapor üretiliyor, hiçbir lease sızmıyor.
2. **Korumalı yol koşuyu durduruyor** — koşu `handover` ile bitiyor (sadece
   "merged değil" değil), probe **baktığını** kanıtlıyor, ve illegal diff'e
   **build harcanmıyor**.
3. **Kill switch turu gerçekten kesiyor** — `runSession` **içindeyken** abort;
   hata zinciri `kill_switch_stop_all` içeriyor, koşu `null`, lease iade.
4. **Kontrol testi** — aynı filo, aynı tur, signal yok → abort mesajı yok.
   (3'ün sebebinin gerçekten switch olduğunu, kurulum olmadığını kanıtlar.)

---

## Test sayısı

- `@maestro/execution`: **152 → 202** (+50)
- `@maestro/workflows`: **122 → 126** (+4 uçtan uca)
- `@maestro/db`: 170 (yeni tablo mevcut invariant testlerinden geçti)
- **Gate: 60/60, exit 0**

---

## ARAYÜZ İSTEKLERİ

1. **`RunResult` kesilme sinyali taşımıyor** (`packages/ports/src/runner.ts`,
   DONMUŞ). `tail()` akışın başını atar ve bunu söyleyen alan yoktur. Şu an
   tail'in byte bütçesini **dışarıdan** (`tailLimitBytes`) alıp doluluğa
   bakarak çıkarsıyorum — çalışır ama dolaylı, ve bütçeye tam oturan doğru
   çıktıyı da kesilmiş sayar (kasıtlı kötümser). Doğru çözüm `RunResult`'a
   `stdoutTruncated: boolean` / `bytesDropped: number` eklemek olurdu.
   Port donmuş olduğu için **yapmadım**.

2. **`RunnerPort` deployment'ın port seçiminde yok.** Sürücü
   `registerRunnerDrivers` ile kayıtlı ama `buildPortSelection` bir `runner`
   portu çözmüyor, `PortBundle`'da yok. Worker filoyu bu yüzden
   `createDockerLinuxRunner`'ı **doğrudan** çağırarak kuruyor — diğer sekiz
   portun aksine registry'den geçmiyor. Tutarlı olan `runner`'ı da port
   seçimine eklemek olurdu; bu `compose.ts`'in şeklini değiştirir ve paralel
   ajanların alanına yakın olduğu için **yapmadım**.

---

## Yapmadıklarım + neden

- **`AgentExecutionDeps` / `deps.ts` değiştirilmedi.** `AgentTurnRunner`
  arayüzü aynen uygulandı. `AgentExecution.runTurn`'e **opsiyonel** ikinci
  parametre (`TurnCollaborators`) eklendi — mevcut çağıranların hepsi
  değişmeden çalışır; probe/verifier tur başına bağlanmak zorunda çünkü
  workspace volume'u ve `AbortSignal` tura özgüdür. `AgentExecution` **tek**
  örnek kalır (koşu başına journal writer'ları ve M30 maskeleme oturumunu
  korumak için).
- **`packages/contracts`, `packages/ports`** — dokunulmadı.
- **`apps/bff/src/routes/`** — dokunulmadı (paralel ajanlar).
- **Sır maskeleme sırası** — değiştirilmedi, gerek yoktu: `withPiiBoundary`
  sırayı zaten doğru uyguluyor ve `collect.ts` bunu uzun uzun belgeliyor.
  Rapor `guardEgress` ile ikinci kez kontrol edilerek journal'a yazılır.
- **`onDelete: Cascade` → `Restrict`** — ilk yazdığım `Cascade`'i şemanın
  `schema-enums.test.ts` içindeki M30/M56 saklama invariantı reddetti. Kuralı
  gevşetmek yerine **uydum**: limite ulaşmış sayaç, biletin insana gitme
  sebebidir; başka yerdeki bir silme onu sessizce alıp götürmemeli.
- **`HANDOFF.md` okunamadı** — repo'da (hiçbir yolda) yok. Kod ve mevcut
  testlerden ilerledim.
- **Gate flake notu:** `@maestro/studio` içindeki bir React testi paralel CPU
  baskısı altında 5000ms timeout'a takılabiliyor (tek başına 217/217 geçiyor,
  Studio'da hiçbir dosyaya dokunmadım). Son gate koşusu exit 0 / 60-60.
