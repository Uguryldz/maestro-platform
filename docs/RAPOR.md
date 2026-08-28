# RAPOR — `docs` paketi (Dalga 4)

> **Künye** · Hazırlayan: doküman ajanı · Tarih: 2026-08-09 · Sürüm: 1.0 ·
> Kapsam: kurulum, kullanım, operasyon, mimari, güvenlik dokümantasyonu
> Dal: `worktree-agent-aa45ba6ac605f3821` · Taban: `cbcf9cd` (wave-3 workflows fix round)

---

## 1. Ne yazıldı

| Doküman | Hedef kitle | Satır | Şekil | İçerik |
|---|---|---|---|---|
| `README.md` (kök) | herkes | 225 | 2 | Maestro nedir, 19 adım tablosu, mimari şema, hızlı başlangıç, **bugün ne çalışıyor/çalışmıyor**, depo düzeni |
| `docs/README.md` | herkes | 80 | — | Doküman haritası, role göre okuma sırası, doğrulama durumu |
| `docs/kurulum.md` | platform/DevOps | 380 | — | Gereksinimler, adım adım kurulum, atlanan testlerin açılması, DB ve parametreler, env sözleşmesi, on-prem senaryo, sık hatalar |
| `docs/jira-baglama.md` | Jira/ADO admin | 394 | 1 | Servis hesabı, izin seti (**+1 eksik global izin**), global webhook, binding, 3 kademe eşleşme, komut grameri, ADO çift mod, CI allow-list |
| `docs/ilk-kosu.md` | PO, geliştirici, QA | 348 | — | Zihinsel model, demo koşusu (Yol A), gerçek Jira akışı (Yol B), analiz şablonu, ticket yazma önerileri |
| `docs/operasyon-runbook.md` | operatör | 650 | 1 | Hızlı karar tablosu, kapı/takılma/kill-switch/runner/kota/CI, yedekleme, audit olayı, alarm→aksiyon, sürüm |
| `docs/mimari.md` | mimar, denetim | 783 | 11 | Katman kuralı, 19 adım, `continueAsNew`, kapılar+SoD, veri sınıfı+PII, LLM egress, audit, hafıza, fan-out, MCP, şablon mimarisi |
| `docs/guvenlik.md` | güvenlik, uyum | 716 | — | Tehdit modeli, fail-closed, sandbox, korumalı yollar, onay kontrolleri, kill switch, sır yönetimi, MCP, denetim, **bilinen sınırlar** |
| `docs/sss.md` | herkes | 498 | — | Role göre gruplanmış SSS |
| `docs/RAPOR.md` | orkestratör | 242 | — | bu dosya |

**Toplam 4316 satır Türkçe dokümantasyon, 15 mermaid diyagramı.**

Biçim: `DOKUMAN-STANDARDI.md`'ye uygun — künye, numaralı bölümler, koyu başlıklı
karşılaştırma tabloları, `> [!WARNING]`/`> [!IMPORTANT]`/`> [!NOTE]` uyarı kutuları,
kod blokları, çapraz referanslar.

---

## 2. Doğruladığım komutlar

Yazdığım her komuttan çalıştırılabilir olanları **gerçekten koşturdum**:

| Komut | Sonuç |
|---|---|
| `node --version` | `v24.15.0` ✅ |
| `pnpm --version` | `10.33.0` ✅ |
| `docker --version` | `Docker version 29.4.1` ✅ |
| `psql --version` | **komut yok** — bu yüzden dokümanda Postgres opsiyonel ve Docker'lı olarak anlatıldı |
| `pnpm install --frozen-lockfile` | ✅ exit 0 |
| **`pnpm run gate`** | ✅ **48/48 görev, 0 önbellek, 2m4.892s** |
| `pnpm run test` (paket bazlı sayım) | ✅ **24 paket · 2898 geçen · 40 atlanan** |
| `pnpm -F @maestro/demo start` | ✅ Beklenen hatayla durdu: *"OPENROUTER_API_KEY bulunamadı"* — demo'nun gürültüyle durduğu doğrulandı |
| `pnpm run gate` (doküman sonrası) | ✅ tekrar yeşil (§6) |

**Koşturamadıklarım ve nedeni:**

| Komut | Neden koşturulmadı |
|---|---|
| `curl .../webhooks/jira` (401 testi) | BFF'in çalıştırıcı kökü yok — sunucu ayağa kaldırılamıyor |
| `pnpm -F @maestro/db seed` | Canlı Postgres yok (bu makinede `psql` bile yok) |
| `MAESTRO_DOCKER_IT=1` bataryası | Docker var ama batarya ~dakikalarca sürer ve doküman turunun kapsamı değil; komut `runners/RAPOR.md`'den birebir alındı |
| `MAESTRO_SCANNERS_IT=1` | Gerçek gitleaks/semgrep/trivy imajları indirilmesi gerekir |
| Demo'nun tam akışı | `OPENROUTER_API_KEY` yok (kullanıcı anahtarı iptal etti — GECE-RAPORU §"Senden bekleyenler") |

Koşturamadığım komutları dokümanda **kaynağıyla birlikte** verdim (ör. Postgres test
komutu `packages/db/test/live-guards.test.ts`'in kullanım notundan birebir).

---

## 3. "HENÜZ YOK" listesi — Dalga 4'ün geri kalanına girdi

Bu listenin **her maddesi** dokümanlarda açıkça işaretlendi. Sıra, engelleme
derecesine göre.

### 3.1 Uygulama katmanı — bunlar olmadan Maestro çalıştırılamaz

| # | Ne yok | Nerede olmalı | Kanıt |
|---|---|---|---|
| **1** | **BFF composition root** | `apps/bff/src/main.ts` | `apps/bff/package.json`'da `start` script'i yok; RAPOR §3d: *"Kompozisyon kökü yazılmadı"*. Kökün sağlaması gerekenler listelenmiş: `WorkPort`, `WorkEventReader`, `CiPort`, `RunGateway`, `AuditChain`, `SessionStore`, `IdentityProvider`, `UserDirectory`, `JiraProjectBindings`, `GateDirectory`, `ParamStore`, `KillSwitchStore` |
| **2** | **Worker uygulaması** | `apps/worker` | Dizin yok. `packages/workflows` `createMaestroWorker` verir ama onu ayağa kaldıran uygulama yok |
| **3** | **`deploy/`** — compose + Dockerfile + egress-proxy konfigi | `deploy/` | Dizin yok. Masterplan §3'te planlı. **Kurulabilir hiçbir artefakt yok** |
| **4** | **Studio (Next.js)** | `apps/studio` | Dizin yok. Yalnız `mock/index.html` (37 ekran) prototipi var |
| **5** | **Runner Agent daemon** (win/mac) | `apps/runner-agent` | `packages/runners/src/agent-protocol.ts` yalnız **şema**; RAPOR: *"Sunucu/dinleyici yok — taşıma Dalga 3"* |
| **6** | **DB destekli depolar** | — | BFF bugün `InMemoryParamStore`, `InMemoryKillSwitchStore`, `StaticJiraProjectBindings`, `StaticGateDirectory`, `InMemoryUserDirectory`, `InMemorySessionStore` ile çalışır |

### 3.2 Sürücüler ve yetenekler

| # | Ne yok | Karar | Not |
|---|---|---|---|
| 7 | `agent-macos` runner sürücüsü | M21 | Aşama 3; donanım+MDM giriş kriteri |
| 8 | `agent-windows` runner sürücüsü | M21 | Aşama 2 |
| 9 | **`docx`/`pdf` publish sürücüsü** | M103r | **Kayıtlı ama kurulum anında reddediliyor** — sessizce boş dosya üretmiyor. M103r "ileride değil, birinci sınıf gereksinim" diyor |
| 10 | **SVG şekil üretimi** (etki matrisi, akış şeması, fan-out ağacı) | M109 | `DOKUMAN-STANDARDI.md`: *"bugün metin/tablo olarak var, şekil olarak yok"* |
| 11 | **AD/LDAP kimlik sürücüsü** | M8 | Arayüz hazır (`IdentityProvider`), sürücü yok. MVP lokal bcrypt hesap |
| 12 | `cyberark` / `azure-keyvault` secret sürücüleri | M80 | Kurum ürünü belli olunca |
| 13 | **Redis** — hiçbir pakette istemci yok | M4 | Kapasite semaforu, rate limit, cache. Bugünkü `TokenBucket` **süreç içi** |
| 14 | **Atomik rate limit** (Redis Lua) | M19 | Bugünkü token-bucket tek süreçte doğru, çok süreçte paylaşılmaz |
| 15 | `/ai-explain` workflow sinyali | — | Komut "desteklenmiyor" yanıtı alıyor (sessiz yutma yok) |
| 16 | Clarification cevabının **Jira yorumundan** alınması | — | Port yeteneği gerekiyor; Studio yolu çalışıyor |
| 17 | Gerçek soket adaptörü (`notify`) | — | `notify/RAPOR.md` §5.2 talebi |
| 18 | `getStream`/`putStream` (`StoragePort`) | — | Bugün nesne tamamen bellekte; M34/M65 paketleri yüzlerce MB olabilir |
| 19 | Retry/backoff + devre kesici ortak sarmalayıcı | — | Tüm portlar için ortak olmalı; sürücü başına yazmak v1 dağınıklığı |
| 20 | `ScmPort`/`CiPort` sürücü kaydı | — | `@maestro/adapter-ado` `PortRegistry`'ye kayıt olmuyor; `registerAdoDrivers` eklenirse sürüklenme testi `scm`/`ci`'yi de kapsar |

### 3.3 Yapılandırma boşlukları — ikinci proje onboard edilmeden önce kapanmalı

| # | Ne | Etki |
|---|---|---|
| **21** | **`GATE_OWNER` parametrik değil** | Kapı 5'i farklı **türde** bir sahibe yönlendirmek imkânsız. `ParamReader.gateOwners` gerekiyor. Kodda yazılı (D7): *"ikinci proje onboard edilmeden önce"* |
| **22** | **Proje üyeliği adlandırma kuralı koda gömülü** | `maestro-<projectkey>` kuralı (`projectGroupFor`). Doğrusu `JiraBinding`'e `memberGroups`/`readerGroups` alanı. **Kurumun AD şeması uyuşmuyorsa bu bulgu yeniden açılır** |
| **23** | **Çok worker'lı idempotency guard'ı** | Bugün süreç içi; `createMaestroWorker` açılışta **uyarıyor**. Tablo destekli guard gerekiyor (D6) |
| **24** | 3 katalog/port talebi açık | `WorkPort.parseCommandDetailed`, `WorkPort.parseEvent`, `AuditAction`'a `maestro-bff` aktörü ve `USER_PASSWORD_CHANGED` |

### 3.4 Doğrulanmamış / tatbikatsız

| # | Ne | Karar |
|---|---|---|
| **25** | **Restore tatbikatı yapılmadı** | M66 — **Aşama 1 çıkış kriteri** (PG + Storage + Vault bir kez) |
| **26** | **Runbook tatbikatla doğrulanmadı** | Aşama 3 çıkış kriteri |
| **27** | **Gerçek Jira/ADO duman testi yok** | Kurum erişimi gelmedi. Contract testler kayıtlı gerçek yanıt fikstürleriyle koşuyor — insa-plani §6: **%95 doğruluk sınırı**, kalan %5 (proxy, sertifika, sürüm farkları) erişim günü kapanır |
| **28** | **Gerçek Temporal'a bağlı koşum yok** | Testler `TestWorkflowEnvironment` ile |
| **29** | Temporal test sunucusu ikilisi CI imajında yok | `MAESTRO_TEST_SERVER` ile gösterilmeli — **operasyon maddesi** |

### 3.5 Bilinen güvenlik sınırları (gizlenmedi, dokümana yazıldı)

| # | Sınır |
|---|---|
| **30** | **Gömülü PII kodlamaları** — base64, HTML-entity, sıfır-genişlik, fullwidth ile gömülü PII yakalanmıyor (B-14/B-15) |
| **31** | **mac/Windows konteyner izolasyonu yok** — M25 telafi seti + **kabul edilen risk kaydı** |
| **32** | **S3 WORM ihlalinin hata eşlemesi** — gerçek uç 403 + `AccessDenied` döner, kilide özgü kod yok; uydurma kod yazılmadı |
| **33** | `packages/audit`: kalıcı depo (Prisma) yok, anchor'ın diske/S3'e yazılması yok, syslog soketi/dosya düşümü yok — hepsi çağıranın işi ve **çağıran henüz yok** |

---

## 4. Dokümanda düzelttiğim yanlış iddialar

| Nerede | Eski iddia | Düzeltme |
|---|---|---|
| Kök `README.md` | *"Kod: `packages/*` (çekirdek) + `apps/*` (bff · worker · runner-agent · studio)"* | `apps/` altında **yalnız `bff` ve `demo`** var. Yeni README bunu açıkça yazıyor ve eksik uygulamaları tablo hâlinde listeliyor |
| Kök `README.md` | *"masterplan.md (M1–M104)"* | M109'a kadar var |
| İlk taslağım | Rate limit "Redis Lua ile atomik" | Kodu okudum: `TokenBucket` **süreç içi**; Redis hiçbir pakette yok. Düzeltildi ve HENÜZ YOK olarak işaretlendi |
| İlk taslağım | ScanPort'ta yalnız 3 sürücü | `fortify`, `sonarqube`, `xray` de kayıtlı (M77) — ama **yapılandırılana kadar `CapabilityNotSupportedError` atıyorlar** |

---

## 5. Kaynak ↔ iddia izlenebilirliği

M109'un "Kaynaklar" ilkesini bu rapora da uyguladım. Dokümanlardaki iddiaların
dayandığı kaynaklar:

| İddia sınıfı | Kaynak |
|---|---|
| 19 adım, adım türleri, kapı setleri | `packages/contracts/src/workflow.ts` (`STEP_IDS`, `STEP_META`, `APPROVAL_GATE_STEPS`, `GATES_BY_RISK`) |
| Kapı sahipleri, SoD kuralları | `packages/workflows/src/gates.ts` (`GATE_OWNER`, `canCloseGate`) |
| Workflow garantileri, `continueAsNew` | `packages/workflows/src/ticket-workflow.ts` + `RAPOR.md` §0 (K1-K4, Y1-Y5, O1-O4, D1-D7) |
| BFF uçları, auth, sinyal beyaz listesi | `apps/bff/src/routes/*.ts` + `apps/bff/RAPOR.md` (B1-B7) |
| env sözleşmesi | `packages/config/src/env.ts` — 8 değişken, 6'sı üretimde zorunlu |
| Parametreler | `packages/db/src/params-defaults.ts` — 17 tanım, varsayılan değerleriyle |
| Şema | `packages/db/prisma/schema.prisma` — 17 model, 15 enum |
| Sandbox profili, egress | `packages/runners/RAPOR.md` §2 + `src/sandbox.ts`, `src/provision.ts` |
| Korumalı yollar | `packages/execution/src/protected-paths.ts` (dosyanın kendi yorumları) |
| PII sınırı, bulgular | `packages/pii/RAPOR.md` §0 (B-1…B-18) |
| Komut grameri | `packages/adapter-jira/src/commands.ts` + `RAPOR.md` §8 |
| CI köken doğrulaması | `packages/adapter-ado/RAPOR.md` §0 (K1, K3) |
| MCP kapsamları, geri alınan iddia | `packages/mcp-servers/RAPOR.md` §0 (B1-B9) |
| Analiz şablonu mimarisi | `packages/agent-roles/RAPOR.md` §1-3 |
| Demo davranışı | `apps/demo/README.md` + `RAPOR.md` §3 + **canlı koşum** |
| Jira izinleri | `packages/adapter-jira/RAPOR.md` §1 "M102 izin seti — kod nerede duruyor (DÜZELTME)" |
| Doğrulama bulguları özeti | `plan/GECE-RAPORU.md` |
| Kararlar (M1-M109) | `plan/masterplan.md` |
| Doküman biçimi | `plan/referans/DOKUMAN-STANDARDI.md` |
| Yardım metni tonu ve içeriği | `mock/index.html` → `V.help` görünümü |

**Referans belge okundu.** `UiPath-Orchestrator-HA-Plani-v1.0.pdf` — 8 sayfanın
tamamı incelendi. Not: dosya `plan/referans/` altında **değil**,
`/home/ubuntu/coder/` kökünde duruyor; `DOKUMAN-STANDARDI.md` ona depo-içi bir yolla
referans veriyor ve **o yolda dosya yok**. (Küçük bir düzeltme kalemi.)

Referanstan uygulanan biçim öğeleri:

| Öğe | Nasıl uygulandı |
|---|---|
| **Künye tablosu** (başlığın hemen altında, kapak sayfası yok) | 8 dokümanın hepsinde: Hazırlayan · Tarih · Versiyon · Kapsam |
| İki seviyeli numaralı bölümler | `1.`, `2.`, `3.1`, `3.2`… |
| Koyu başlıklı karşılaştırma tabloları | Parametre/varsayılan/kaynak ve seçenek artı-eksi tabloları |
| Altyazılı mimari şekiller | **Mermaid** olarak (14 diyagram). Referanstaki gibi PNG değil — Markdown'da mermaid canlı render olur ve düzenlenebilir kalır |
| Uyarı/not kutuları | `> [!WARNING]` · `> [!IMPORTANT]` · `> [!NOTE]` |
| Kod blokları | Gerçek komutlar ve gerçek yapılandırma satırları |
| **`Kaynaklar` bölümü** | `mimari.md` §17, `guvenlik.md` §18, `operasyon-runbook.md` §14, bu rapor §5 — her iddia hangi dosyaya/karara dayanıyor |
| **`Netleştirilecek açık maddeler` bölümü** | `mimari.md` §16, `guvenlik.md` §17, `operasyon-runbook.md` §13 |
| **`Doküman kontrolü`** (versiyon geçmişi + imza tablosu) | `mimari.md` §18, `guvenlik.md` §19, `operasyon-runbook.md` §15 |

Son üç öğe M109'un getirdiği ve referans belgede bulunan bölümlerdir; bu doküman turu
bunları **kendine de uyguladı**.

---

## 6. Kapı durumu

Doküman turu **hiçbir kod dosyasına dokunmadı**. Değişen dosyalar yalnız:

```
maestro/README.md          (güncellendi — yanlış apps/ iddiası düzeltildi)
maestro/docs/README.md     (yeni)
maestro/docs/kurulum.md    (yeni)
maestro/docs/jira-baglama.md (yeni)
maestro/docs/ilk-kosu.md   (yeni)
maestro/docs/operasyon-runbook.md (yeni)
maestro/docs/mimari.md     (yeni)
maestro/docs/guvenlik.md   (yeni)
maestro/docs/sss.md        (yeni)
maestro/docs/RAPOR.md      (bu dosya)
```

`pnpm run gate` doküman turundan **önce ve sonra** koşturuldu, ikisi de yeşil:
**48/48 görev, 0 önbellek.**

---

## 7. Yapmadıklarım ve nedenleri

| Yapılmadı | Neden |
|---|---|
| **PDF/Word/Confluence-HTML çıktısı** | `insa-plani.md` §6b bunu D-Dalgası çıktısı olarak tarif ediyor (headless tarayıcı / pandoc). Görev tanımı `maestro/docs/` altına Markdown istedi; dönüştürme zinciri ayrı bir kalem ve bu turda araç doğrulaması yapılamadı |
| **Test stratejisi ve yol haritası dokümanları** | `insa-plani.md` §6b'nin D-Dalgası listesinde var ama bu görevin 8 dokümanlık listesinde yok |
| **Studio ekran kılavuzu** | `apps/studio` yok; maketin ekranlarını "kullanım kılavuzu" diye anlatmak, olmayan bir ürünü anlatmak olurdu. Mock'a **prototip** olarak referans verildi |
| **API referansı (OpenAPI)** | BFF uçları RAPOR'da listeli ama şema üretilmiş bir spesifikasyon yok; uydurmak yerine uç listesi verildi |
| **`.maestro.yaml` tam şeması** | Kodda bu dosyayı ayrıştıran bir yükleyici bulamadım; yalnız `protected_paths` semantiği `execution` paketinde gerçek. Doküman alan listesini M71'den verdi, **örnek tam dosya yazmadım** |
| **Gerçek kurulum tatbikatı** | `deploy/` yok, Temporal/Vault/S3 bu makinede yok |
| **Ekran görüntüleri** | Studio yok; demo ekranı için `apps/demo/jira-gorunum.png` mevcut ama görsel gömme bu turun kapsamı değildi |

---

## 8. Öneriler (orkestratör kararı)

1. **`deploy/` + `apps/bff/src/main.ts` + `apps/worker` en kritik üçlüdür.** Bu üçü
   olmadan doküman "kurulum" bölümü teorik kalıyor. Bunlar geldiğinde
   `docs/kurulum.md` §6 (on-prem) gerçek komutlarla güncellenmeli.
2. **`GATE_OWNER` parametrikleştirmesi** ikinci projeden önce kapanmalı — bu bir
   yapılandırma boşluğu değil, **onboarding blokeri**.
3. **Proje üyeliği adlandırma kuralı** kurumun AD şemasıyla doğrulanmalı; uyuşmazsa
   B3 bulgusu yeniden açılır.
4. Kurum erişimi geldiğinde `docs/jira-baglama.md` §8 kontrol listesi **gerçek bir
   bağlamada koşturulmalı** ve doküman sahadan gelen farklarla güncellenmeli.
5. **İki ek Jira izni** kurumun izin talebine eklenmeli — ikisi de M102 listesinde
   yoktu: **global "Browse users and groups"** (kapı doğrulamasının tek dayanağı) ve
   **"Edit Own Comments"** (M75 tek durum yorumu). Verilemezse alternatif tasarım
   gerekir.
6. Dokümanlar `packages/*/RAPOR.md` dosyalarına **sıkı bağımlıdır**. Bir paket
   yeniden yazılırsa ilgili doküman bölümü de gözden geçirilmeli; özellikle
   `guvenlik.md`'deki "gerçek bulgu" kutuları.
