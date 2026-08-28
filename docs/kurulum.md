# Maestro — Kurulum ve Gereksinim Dokümanı

*Geliştirme kurulumu · doğrulama · veritabanı · on-prem hedef mimari*

| Hazırlayan | Tarih | Versiyon | Kapsam |
|---|---|---|---|
| Maestro doküman ajanı | 09.08.2026 | v1.0 | Gereksinimler · adım adım kurulum · atlanan testlerin açılması · DB ve parametreler · env sözleşmesi · on-prem senaryo · sık hatalar. Kapsam dışı: Jira/ADO bağlama (bkz. `jira-baglama.md`) |

> **Kime:** platform / DevOps ekibi, Maestro'yu ilk kez ayağa kaldıracak kişi.
> **Ön koşullar:** Linux sunucuya (veya geliştirici makinesine) `sudo` erişimi, git,
> internet ya da kurumun iç paket aynası.
> **Süre:** geliştirme kurulumu ~15 dk; on-prem senaryosunun okunması ~30 dk.

> [!WARNING]
> **Bugün kurulabilir bir dağıtım artefaktı YOKTUR.** `deploy/` klasörü (compose
> dosyaları, Dockerfile'lar) **HENÜZ YOK** — Dalga 4 kalemidir. Aynı şekilde
> `apps/studio`, `apps/worker`, `apps/runner-agent` ve BFF'in çalıştırıcı kökü de
> yazılmamıştır. Bu doküman **bugün gerçekten koşabilen** kurulumu (geliştirme +
> doğrulama + demo) adım adım anlatır, sonra on-prem hedef mimariyi tarif eder ve
> her eksik parçayı açıkça işaretler.

---

## 1. Gereksinimler

### 1.1 Bugün gerekli olanlar (geliştirme + doğrulama)

| Bileşen | Sürüm | Zorunlu mu | Nereden gelir |
|---|---|---|---|
| **Node.js** | **≥ 24.0.0** | ✅ zorunlu | `package.json` → `engines.node` |
| **pnpm** | **10.33.0** | ✅ zorunlu | `package.json` → `packageManager` |
| **git** | herhangi | ✅ zorunlu | depo klonu |
| **Docker** | ≥ 24 (test edilen: 29.4.1) | ⚠️ opsiyonel | yalnız sandbox ve tarayıcı entegrasyon testleri için |
| **PostgreSQL** | 16+ | ⚠️ opsiyonel | yalnız `db` canlı testleri için (`0002` migration guard'ları) |

`pnpm` sürümü **birebir** eşleşmelidir; farklı sürüm `pnpm install --frozen-lockfile`
adımında uyarı üretir.

```bash
node --version    # v24.15.0 (doğrulanmış)
pnpm --version    # 10.33.0  (doğrulanmış)
docker --version  # Docker version 29.4.1 (doğrulanmış)
```

### 1.2 Üretim hedefinde gerekli olanlar (M1–M6)

Bunlar masterplan'ın kilitli kararlarıdır; bugün bağlanabilecek bir composition root
olmadığı için **hiçbiri henüz bağlanmamıştır**.

| Bileşen | Karar | Rolü |
|---|---|---|
| **Temporal** (self-hosted) | M1 | 19 adımlık dayanıklı iş akışı; 15-20 gün uyuyan kapılar |
| **PostgreSQL 16+** | M3 | WorkflowRun, StepEvent, Journal, Param, AuditLog… (17 model) |
| **Redis** | M4 | kapasite semaforu, rate limit, kısa ömürlü cache — **HENÜZ YOK** (hiçbir pakette Redis istemcisi yazılmadı) |
| **Vault** | M6 | tüm secret'lar; `env-file` sürücüsü üretimde **reddedilir** |
| **S3-uyumlu depolama** | M5 | kanıt paketleri, journal içeriği, 10 yıllık arşiv |
| **Egress proxy** | M26 | kurum dışına tek çıkış, allow-list'li |
| **Jira Data Center/Server** | M46 | ticket kaynağı |
| **Azure DevOps** (Server veya Services) | M11 | repo, PR, build validation |

---

## 2. Adım adım: geliştirme kurulumu

Bu bölümün her komutu bu depoda **gerçekten koşturulmuş** ve çıktısı doğrulanmıştır.

### Adım 1 — Depoyu al ve bağımlılıkları kur

```bash
git clone <depo-url> coder
cd coder/maestro
pnpm install --frozen-lockfile
```

`postinstall` sırasında `@maestro/db` paketi `prisma generate` çalıştırır. Soğuk bir
klonda `typecheck`'in geçmesini sağlayan şey budur — atlanırsa Prisma tipleri üretilmez
ve tip kontrolü kırılır.

> [!NOTE]
> `pnpm` iki paketin build script'ini çalıştırmaya izinlidir: `@prisma/engines`,
> `esbuild`, `prisma`. Bu liste `package.json` → `pnpm.onlyBuiltDependencies`
> içindedir ve bilinçlidir — başka hiçbir paketin kurulum sırasında kod çalıştırmasına
> izin verilmez.

### Adım 2 — Kapıyı koştur (asıl doğrulama budur)

```bash
pnpm run gate
```

Beklenen çıktı (bu depoda ölçülen):

```
 Tasks:    48 successful, 48 total
Cached:    0 cached, 48 total
  Time:    2m4.892s
```

`gate` ile `check` arasındaki fark önemlidir:

| Komut | Ne yapar | Ne zaman |
|---|---|---|
| `pnpm run lint` | eslint | hızlı geri bildirim |
| `pnpm run typecheck` | `turbo run typecheck` | tip kontrolü |
| `pnpm run test` | `turbo run test` | **önbellekli** — değişmeyen paketi atlar |
| `pnpm run check` | lint + typecheck + test | günlük kullanım |
| **`pnpm run gate`** | lint + `--force` typecheck test | **dalga kapısı — asla önbellekten okumaz** |

Önbellek bir kez gerçek bir hatayı sakladığı için kapı komutu ayrıldı. Teslim
öncesi **daima `gate`** koşturulur.

### Adım 3 — Tek tek paket doğrulaması (opsiyonel)

```bash
pnpm -F @maestro/workflows test     # 122 test — 19 adım, kapılar, sinyaller
pnpm -F @maestro/bff test           # 212 test — webhook, auth, komut grameri
pnpm -F @maestro/runners test       # 224 test — sandbox sertleştirmesi
pnpm -F @maestro/db test            # 170 test — şema, migration, seed
```

Depodaki 24 paketin toplamı: **2898 geçen test, 40 atlanan**.

### Adım 4 — Demoyu çalıştır (bugün çalışan tek uçtan uca yol)

```bash
# maestro/.env dosyasına bir satır:
#   OPENROUTER_API_KEY=sk-or-...
pnpm -F @maestro/demo start
```

Tarayıcıda **http://localhost:7010**. Ayrıntı: [`ilk-kosu.md`](ilk-kosu.md).

Demo üç port kullanır:

| Port | Ne |
|---|---|
| 7010 | demo arayüzü |
| 7011 | **sahte** Jira sunucusu |
| 7012 | **sahte** Azure DevOps sunucusu |

---

## 3. Atlanan testler ve nasıl açılır

40 test varsayılan olarak atlanır çünkü gerçek altyapı ister. Kapı bunlarsız da
yeşildir; bunlar **ek** güvencedir.

### 3.1 Sandbox kaçış bataryası (23 test — `@maestro/runners`)

Gerçek bir Docker motoru içinden root olmayı, ağa çıkmayı, salt-okunur kökü aşmayı
ve docker soketine ulaşmayı **gerçekten dener**.

```bash
MAESTRO_DOCKER_IT=1 pnpm -F @maestro/runners test
```

Ek değişkenler: `MAESTRO_DOCKER_IT_IMAGE`, `MAESTRO_DOCKER_IT_SOCKET`.

### 3.2 Gerçek tarayıcı duman testleri (10 test — `@maestro/scanners`)

Gerçek gitleaks/semgrep/trivy imajlarını çalıştırır.

```bash
MAESTRO_SCANNERS_IT=1 pnpm -F @maestro/scanners test
```

Ek değişkenler: `MAESTRO_SCANNERS_IT_GITLEAKS`, `MAESTRO_SCANNERS_IT_SEMGREP`,
`MAESTRO_SCANNERS_IT_TRIVY`, `MAESTRO_SCANNERS_IT_TRIVY_CACHE`.

### 3.3 Canlı Postgres migration guard'ları (7 test — `@maestro/db`)

`0002` migration'ının trigger + CHECK + kısmi unique index'leri yalnız onları kırmaya
çalışan bir istemci gerçekten başarısız olursa gerçektir.

```bash
docker run -d --rm -p 55432:5432 \
  -e POSTGRES_PASSWORD=maestro -e POSTGRES_DB=maestro_test \
  --name maestro-pg postgres:16-alpine

TEST_DATABASE_URL=postgresql://postgres:maestro@localhost:55432/maestro_test \
  pnpm -F @maestro/db test
```

*(Komut metni `packages/db/test/live-guards.test.ts` dosyasının başındaki
kullanım notundan alınmıştır.)*

### 3.4 Hava boşluklu CI için Temporal test sunucusu

`@temporalio/testing` zaman-atlatmalı sunucuyu varsayılan olarak **internetten
indirir**. İnternetsiz CI'da diskteki ikili kullanılır:

```bash
MAESTRO_TEST_SERVER=/opt/temporal/temporal-test-server pnpm -F @maestro/workflows test
```

> [!NOTE]
> Bu bir **operasyon maddesidir, kod maddesi değil**: CI imajına bu ikilinin
> konması gerekir.

---

## 4. Veritabanı kurulumu

### 4.1 Şema

```bash
# Prisma istemcisini üret (postinstall zaten yapar)
pnpm -F @maestro/db generate

# 0001_init'i şemadan çevrimdışı yeniden üret (elle yazılmaz)
pnpm -F @maestro/db migration:build
```

> [!WARNING]
> `0001_init/migration.sql` **Prisma tarafından üretilir**, elle düzenlenmesi
> yasaktır. `0002_append_only_and_guards/migration.sql` ise **tek elle yazılan
> migration**'dır (append-only trigger'ları, CHECK kısıtları, kısmi unique
> index'ler) — o dosya elle bakılır.

Şema: **17 model, 15 enum**. Başlıcaları: `WorkflowRun`, `StepEvent`, `JournalEntry`,
`Application`, `RepoCard`, `JiraProjectBinding`, `RoutingRule`, `Param`, `ParamVersion`,
`AuditLog`, `LlmCall`, `SubscriptionAccount`, `Variant`, `KnowledgeDoc`,
`EvidencePackageRow`, `User`.

### 4.2 Tohumlama (seed)

```bash
pnpm -F @maestro/db seed                # parametreler + demo veri seti
pnpm -F @maestro/db seed --params-only  # yalnız 17 varsayılan parametre
```

Demo veri seti: 5 uygulama + repo kartları, 4 bağlı Jira projesi + yönlendirme
kuralları, 22 ticket (kapıda/çalışan/hatalı/kapanmış dağılımıyla), defter kayıtları,
imzalı kapı kararları ve tutarlı bir audit zinciri. **v1'den veri taşınmaz.**

### 4.3 Varsayılan parametreler (M71)

Ayarlar `.maestro.yaml`'da değil **veritabanında** yaşar, versiyonlu ve audit'lidir.
17 tanım `packages/db/src/params-defaults.ts` içindedir:

| Anahtar | Ne kontrol eder |
|---|---|
| `gates.risk_tiers` | Risk kademesi → kapı seti |
| `trigger.mode` | Proje tetikleme modu (otomatik / opt-in) |
| `escalation.ladder` | Hatırlatıcı merdiveni (M88) — **tek doğruluk kaynağı burasıdır** |
| `lang.output` | AI çıktı dili (M59) |
| `coverage.ratchet` | Coverage düşemez kuralı (M70) |
| `sod.qa_split` | QA senaryo ≠ QA sonuç onaylayan (M92, varsayılan kapalı) |
| `workspace.max_age_days` | Workspace yaş sınırı (M65, 60 gün) |
| `stuck.threshold` | Takılma eşiği (M54, varsayılan 3) |
| `quota.warn_pct` | Kota uyarı yüzdesi (M19) |
| `build.timeout_min` | Platform başına build bekleme (M85) |
| `scan.block_level` | Tarama blok seviyesi (M27) |
| `killswitch.state` | Kill switch durumu (M58) |
| `merge.mode` | `insan-merge` / `auto-merge` (M48) |
| `binding.dry_run_sample_size` | Kuru koşum örneklem sayısı (M102) |
| `dataclass.policy` | Veri sınıfı → arka uç eşlemesi (M18/M63) |
| `subscription.queue_enabled` | Kota kuyruğu (M55) |
| `notify.routing` · `notify.reminder_channel` | Olay → kanal eşlemesi (M45) |

---

## 5. Ortam değişkenleri

Çekirdek env sözleşmesi `packages/config/src/env.ts` içindedir ve **dardır**:

| Değişken | Tip | Üretimde zorunlu |
|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | varsayılan `development` |
| `DATABASE_URL` | URL | ✅ |
| `TEMPORAL_ADDRESS` | metin | ✅ |
| `JIRA_BASE_URL` | URL | ✅ |
| `ADO_BASE_URL` | URL | ✅ |
| `VAULT_ADDR` | URL | ✅ |
| `STORAGE_ENDPOINT` | URL | ✅ |
| `EGRESS_PROXY_URL` | URL | opsiyonel |

> [!IMPORTANT]
> **M6 fail-closed:** `NODE_ENV=production` iken yukarıdaki altı zorunlu değişkenden
> biri eksikse süreç **başlamaz**, `EnvValidationError` atar. "Dokümante ama yok"
> secret'la ayağa kalkma hatası sınıfça kapalıdır.

Bunun dışındaki her ayar ya DB parametresidir (M71) ya da paket yapılandırmasıdır
(Zod'lu, composition root'ta verilir). **Yüzlerce env değişkeni yoktur** — bu bilinçli.

`NODE_ENV` çözümü ayrıca sertleştirme kapısıdır: `runners` ve `secrets` paketlerinde
**tanımsız, boş veya tanınmayan bir `NODE_ENV` üretim sayılır**. Yalnız `development`
ve `test` gevşetme anahtarlarını açar; ortam yalnız **sertleştirebilir**.

---

## 6. On-prem kurulum senaryosu (hedef mimari)

> [!WARNING]
> **Bu bölüm hedef durumu tarif eder.** `deploy/` klasörü **HENÜZ YOK**; aşağıdaki
> servis listesi masterplan §6'nın kararıdır, çalışan bir compose dosyası değildir.

### 6.1 Yerleşim

Maestro, kurum içi bir Linux sunucuda Docker Compose ile koşar. Kullanıcılara
kurulum yapılmaz — herkes tarayıcıdan girer.

| Servis | Port | Erişim |
|---|---|---|
| **Studio** (Next.js) | **7000** | kullanıcının gördüğü tek adres; `maestro.<kurum>.local` buraya bağlanır |
| BFF (Fastify) | 7001 | webhook uçları + REST + `/mcp` |
| Temporal | 7233 | gRPC, yalnız iç ağ |
| Temporal UI | 8233 | yalnız admin |
| PostgreSQL / Redis | 5432 / 6379 | dışa **kapalı** |
| Runner Agent (win/mac) | **port yok** | makineler **outbound** bağlanır; içeri port açılmaz (M22) |

Kurumda önüne ters vekil konur; dışarıya yalnız 443 açılır.

### 6.2 Dış bağlantılar

Maestro'nun dışarıya ihtiyaç duyduğu her şey:

| Hedef | Ne için | Nerede |
|---|---|---|
| Jira DC | ticket + yorum + webhook | kurum içi |
| ADO (Server/Services) | repo + PR + build validation | kurum içi / bulut |
| LLM | abonelik havuzu · API · on-prem vLLM | egress proxy'den / kurum içi |
| Vault | tüm secret'lar | kurum içi |
| S3-uyumlu depolama | kanıt paketleri + arşiv | kurum içi |
| SIEM | denetim izi (CEF/syslog) | kurum içi |

**İçeri açık port yoktur.** Windows/macOS build makineleri Maestro'ya outbound
gRPC ile bağlanır. Tüm dış çıkış egress proxy üzerinden gider ve hedef listesi
kısıtlıdır (M26). Kurum kendi proxy'sini kullanıyorsa Maestro'nunki ona
**zincirlenebilir** (M64).

### 6.3 Egress proxy — bu bir ağ kontrolüdür, ortam değişkeni değil

`packages/runners` bu dersi pahalıya öğrendi ve rapora yazdı:

- Sandbox konteynerine `HTTP_PROXY`/`HTTPS_PROXY` **enjekte edilir** ve iş bunları
  ezemez, ama **enjeksiyon bir kontrol değildir** — iş bu değişkenleri okumak
  zorunda değildir.
- Ham TCP'yi kapatan tek şey, konteynerin bağlandığı Docker ağının
  **`Internal: true`** olmasıdır. Bu, ilk konteyner başlamadan **önce** daemon'a
  sorulur; değilse iş hiç başlamaz (fail-closed).
- Ağ tanımlı ama proxy tanımsızsa yapılandırma reddedilir.
- `host`, `none`, `bridge`, `default`, `container:<id>` ağ adları **her aşamada**
  reddedilir — bunlar operatörün kurduğu ağ değil, namespace seçicisidir.

### 6.4 Yedekleme

| Ne | Nasıl |
|---|---|
| PostgreSQL | günlük dump + WAL |
| StoragePort içeriği | kurumun kendi depolama yedeği |
| Vault | snapshot |

Geri dönüş prosedürü: [`operasyon-runbook.md`](operasyon-runbook.md) § 8.
**Restore tatbikatı Aşama 1 çıkış kriteridir** (M66) ve henüz yapılmamıştır.

---

## 7. Sık karşılaşılan hatalar

| Belirti | Sebep | Çözüm |
|---|---|---|
| `EnvValidationError: DATABASE_URL: required in production` | `NODE_ENV=production` ama zorunlu env eksik | Altı zorunlu değişkeni doldur (§5). Bu bir **özellik**tir (M6), atlatılmaz |
| `typecheck` soğuk klonda kırılıyor | `prisma generate` koşmamış | `pnpm -F @maestro/db generate` |
| `pnpm install` uyarı veriyor | pnpm sürümü 10.33.0 değil | `corepack use pnpm@10.33.0` |
| Demo "port kullanımda" diyor | 7010/7011/7012'de eski süreç var | Eski süreci kapat, tekrar başlat |
| Demo model çağrısında hata | `.env` içinde `OPENROUTER_API_KEY` yok | Anahtarı `maestro/.env` dosyasına ekle (git'e girmez) |
| `runners` testleri Docker hatası veriyor | `MAESTRO_DOCKER_IT=1` verilmiş ama Docker erişilemiyor | Değişkeni kaldır (testler atlanır) veya Docker soketini erişilebilir yap |
| `workflows` testleri internet istiyor | Temporal test sunucusu indiriliyor | `MAESTRO_TEST_SERVER=<yol>` ile diskteki ikiliyi göster |
| `gate` yeşil ama `test` kırmızı (ya da tersi) | turbo önbelleği | Daima `pnpm run gate` (`--force`) ile karar ver |
| Vault sürücüsü `addr` reddediyor | `https` değil | Üretimde `allowInsecureAddr` **çalışmaz**; gerçek TLS uç gerekir |

---

## 8. Kurulum sonrası ne yapmalı

1. **Jira ve ADO'yu bağla** → [`jira-baglama.md`](jira-baglama.md)
2. **İlk analizi al** → [`ilk-kosu.md`](ilk-kosu.md)
3. **Operasyon el kitabını oku** → [`operasyon-runbook.md`](operasyon-runbook.md)
4. **Güvenlik modelini uyum ekibiyle gözden geçir** → [`guvenlik.md`](guvenlik.md)
