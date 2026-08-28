# Dalga 4 — Deploy + Composition Root

## Özet

Gerçek sürücüleri gerçek portlara bağlayan **composition root** yazıldı, üç
çalıştırılabilir giriş noktası (BFF, worker, migrate) eklendi, ve tek komutla
ayağa kalkan bir compose yığını kuruldu.

Composition root `apps/deploy/` altında bir workspace paketi
(`@maestro/deploy`); Docker/compose/env gibi kod olmayan artefaktlar
`maestro/deploy/` altında.

---

## Port → Sürücü Tablosu

Tek karar noktası: `apps/deploy/src/profile.ts`. Aşağıdaki tablo çalışan
sistemden alındı (`worker.ts` açılışta basar):

| Port | `prod` profili | `dev` profili |
|---|---|---|
| `work` | `jira-dc` | `jira-dc` |
| `scm` | `ado` | `ado` |
| `ci` | `ado` | `ado` |
| `llm` | `gateway` | `gateway` |
| `scan` | `trivy` | `trivy` |
| `storage` | `s3-compat` | `pg-blob` |
| `secret` | `vault` | `env-file` |
| `notify` | `multi` | `jira` |
| `publish` | `multi` | `jira` |

`dev` profili `prod`'un eksik hali **değildir** — farklı sürücü kümesidir.
`NODE_ENV=production` altında `dev` profili **reddedilir** (env-file sürücüsü
sırları ortam değişkeninde tutar; bir bankanın kimlik bilgileri
`/proc/<pid>/environ`'a düşmemeli).

### Sürücü importlarının tek yeri

`apps/deploy/src/registry.ts` — bu dosya dışında hiçbir `packages/*` çekirdeği
sürücü paketi import etmez (M44 clean-room korunuyor).

### İki fazlı kayıt (gerçek bir sıralama kısıtı)

`notify/jira` ve `publish/jira` **başka bir portun üzerine** kuruluyor: ikisi de
`deps.work` istiyor, hem de **kayıt anında**. Bu yüzden `bootPlatform` önce work
portunu kuruyor, sonra registry'yi. Lazy proxy tercih edilmedi: kablolama hatası
o zaman ilk bildirimde null dereference olurdu.

---

## Compose Servisleri

`deploy/compose.yaml` — `docker compose config` ile doğrulandı (geçerli).

| Servis | İmaj / Build | Host portu |
|---|---|---|
| `postgres` | `postgres:17-alpine` | 5432 |
| `temporal` | `temporalio/auto-setup:1.25.2` | 7233 |
| `temporal-ui` | `temporalio/ui:2.32.0` | 8233 |
| `migrate` | `Dockerfile.node` (tek seferlik iş) | — |
| `bff` | `Dockerfile.node` | **7001** |
| `worker` | `Dockerfile.node` | — |
| `studio` | `Dockerfile.studio` (nginx) | **7000** → 8080 |

### Bağımlılık sırası (gerçek, dekoratif değil)

```
postgres ─┬─→ migrate ─┬─→ bff ──→ studio
          │            └─→ worker
temporal ─┘
```

- Her `depends_on` **`condition: service_healthy`** kullanıyor.
- `bff` ve `worker`, `migrate` için **`service_completed_successfully`** bekliyor.
- `bff` healthcheck'i `/healthz` değil **`/readyz`** — çünkü readiness Temporal'ı
  ve kill-switch'i gerçekten yokluyor. Sadece-liveness probe, workflow motorunu
  kaybetmiş bir BFF'i load balancer'da tutar.
- `postgres` healthcheck'i `pg_isready -U ... -d ...` (çıplak `pg_isready`
  uygulamanın veritabanı henüz yaratılmamışken de "hazır" der).

### Güvenlik

- Hiçbir servis root değil (`user: "10001:10001"`, imajda da `USER`).
- `network_mode: host` **yok**, `privileged` **yok**, docker soketi mount
  **edilmiyor**.
- Tüm uygulama servislerinde `read_only: true`, `cap_drop: ALL`,
  `no-new-privileges:true`.
- Studio `nginx-unprivileged` üzerinde, 8080 dinliyor (root olmadığı için 80'i
  bağlayamaz).
- Compose'da **düz sır yok** — hepsi `${VAR}` interpolasyonu; test bunu zorluyor.

---

## Ayağa Kaldırma

```bash
cp deploy/.env.example deploy/.env    # doldur
pnpm deploy:up                        # veya: make -C deploy up
```

Kök script'ler: `deploy:up`, `deploy:down`, `deploy:logs`, `deploy:ps`,
`deploy:build`, `deploy:migrate`, `deploy:config` — hepsi `deploy/Makefile`'a
delege ediyor ("up" ne demek, tek yerde tanımlı).

`make up` `.env` yoksa **açıkça durur**; yoksa compose her değişkeni boş
string'e çevirir ve yığın yarı-yapılandırılmış kalkar.

---

## Migration

`apps/deploy/src/bin/migrate.ts`:

- **Postgres advisory lock** (`pg_try_advisory_lock`) arkasında serileştirildi —
  N replika aynı anda `prisma migrate deploy` çalıştırırsa
  `_prisma_migrations` tablosunda yarışır ve "failed" işaretlenebilir.
- Advisory lock, tablo-kilidi yerine bilinçli tercih: **oturuma** bağlı, bağlantı
  düşünce kendiliğinden bırakılır. Migration ortasında öldürülen bir konteyner
  kilidi sonsuza dek tutamaz.
- Bloklayan `pg_advisory_lock` yerine poll + timeout: bloklayan çağrı takılı bir
  sahibin arkasında sonsuza dek asılı kalır, ve sonsuza dek asılan konteyner
  hiçbir şey raporlamaz.
- `migrate deploy` (asla `migrate dev`): drift'i **reddeder**, "düzeltmeyi"
  önermez. `migrate dev` şemayı düşürmeyi teklif ederdi.
- `DATABASE_URL` çocuk sürecin ortamından geçiyor, komut satırından **değil**
  (`ps` ile her kullanıcı görürdü).

---

## Testler

**230 test** (`apps/deploy/test/`), tamamı gerçek — fake sürücü yok.

> **Düzeltme (Y-2).** Bu bölüm daha önce **"102 test"** diyordu ve tablosunda
> **`read-models.test.ts` hiç yoktu** — paketin en büyük test dosyası, 99 test.
> `compose-file` (37→34) ve `users` (9→12) sayıları da tutmuyordu. Testler
> gerçekti; yanlış olan raporun kendisiydi, ki bu denetimi yanıltır: "102"
> bekleyip 201 bulan bir doğrulayıcı hangi sayının hangi iddiaya ait olduğunu
> takip edemez. Aşağıdaki sayılar `pnpm test` çıktısından birebir alınmıştır ve
> düzeltme dalgasının eklediği 29 testi de içerir.

| Dosya | Test | Ne doğruluyor |
|---|---|---|
| `read-models.test.ts` | 99 | `unbridgedReadModels`: 12 okuma modelinin **her metodu** reddediyor mu; reddin model+metot+eksik store'u adıyla söylemesi; hata metninin sır/filtre sızdırmaması. Boş sayfa dönmemesi bu paketin en önemli fail-closed davranışı |
| `compose-file.test.ts` | 34 | YAML parse (merge key'ler çözülerek); servis kümesi; healthcheck varlığı+retries; `service_healthy`/`service_completed_successfully`; root olmama; host networking yokluğu; docker soketi mount edilmemesi; Dockerfile iddiaları |
| `profile.test.ts` | 23 | Profil literal'lerinin paketlerin **kendi sabitleriyle** eşleşmesi (rename drift'i yakalar); profil bütünlüğü |
| `compose.test.ts` | 20 | Gerçek sürücülerle gerçek kablolama; her portun **metotları** var mı; eksik env ile açılmayı reddetme; port adının hatada geçmesi |
| `bindings.test.ts` | 17 | **(yeni, O-1)** `PrismaJiraProjectBindings`: `dry_run`/`draft`/`paused` bağlamanın canlı sayılmaması; tanınmayan trigger'ın `opt_in`'e düşmesi; bozuk `defaultsJson`'ın `human_only`+`gizli`'ye düşmesi; literal sözlüklerin kontratla eşleşmesi |
| `users.test.ts` | 12 | Prisma UserDirectory; bozuk `groupsJson`'ın üyelik sayılmaması; off-boarding'in silme değil pasifleştirme olması; tanınmayan grubun rol vermemesi |
| `durability.test.ts` | 10 | **(yeni, K-1)** Bellek-içi kill switch'in yeniden başlatmada gerçekten `off`'a düşmesi; `prod` profilinin bunun üstüne **açılmayı reddetmesi**; `dev`'in izin verip uyarı basması |
| `migrate.test.ts` | 8 | Advisory lock: ilk denemede alma, sahibi bekleme, timeout'ta pes etme (sonsuza dek asılmama), tek sabit lock id, bloklayan varyantın kullanılmaması; şema yolunun **var olan** bir dosyaya çıkması |
| `secret-names.test.ts` | 7 | Sır değişken adlarının sürücüden **türetilmesi** (elle yazılmıyor) ve compose/.env.example ile tutarlılığı; **(yeni, O-2)** yorumlardaki adların da doğru yazılması |
| **TOPLAM** | **230** | |

**Testlerin yakaladığı gerçek hatalar** (yazarken değil, çalıştırırken):

1. `trivy` sürücüsü digest-pinned `image` istiyordu — hiç verilmiyordu.
2. Vault `allowedMounts`'ta `git` yoktu → her push kimlik bilgisi reddedilirdi.
3. `notify/jira` ve `publish/jira` kayıt anında `deps.work` istiyordu → iki fazlı
   kayıt gerekti.
4. Sır değişken adları elle yanlış yazılmıştı: gerçek kodlama `kv/jira#token` →
   `MAESTRO_SECRET_KV_JIRA__TOKEN` (çift alt çizgi), ve `api-key` →
   `..._API__2D_KEY` (tire, kod noktası olarak kaçırılıyor).
5. Port metot adları tahmin edilmişti (`openPullRequest` → gerçekte `openPr`,
   `llm.complete` → `generateObject`/`agentSession`).
6. `resolveSchemaPath` `@maestro/db/package.json`'ı çözmeye çalışıyordu —
   paketin `exports` haritası buna izin vermiyor, yani migration konteynerde
   patlardı. Test yakaladı; artık entry point üzerinden çözülüyor ve dosyanın
   **var olduğu** doğrulanıyor.
7. `dev` profilinde `pg-blob` sürücüsü `SqlExecutor` istiyordu ama hiçbir giriş
   noktası vermiyordu — worker/BFF elle çalıştırılınca çıktı (ölü yol).

`pnpm run gate` → **exit 0**, **52/52** turbo görevi, repo genelinde **3467 test**
(sayılar çalıştırılarak alındı; "3000" ve "50/50" yuvarlanmış değerlerdi —
Y-2'nin aynı hatası, aynı yerde).

Sır sızıntısı elle de doğrulandı: `VAULT_SECRET_ID` ve DB parolası ile açılış
hatası tetiklendi, ikisi de çıktıda **geçmiyor** (`lifecycle.ts` yalnızca
`error.message` basar, `stack` basmaz).

---

## ARAYÜZ İSTEKLERİ

Donmuş paketlere dokunulmadı. Üç gerçek boşluk:

### 1. `ScanPort` ↔ `RunnerPort` köprüsü yok

`@maestro/scanners` bir `ContainerRunner` istiyor:

```ts
interface ContainerRunner {
  run(request: {
    image: string;               // digest-pinned
    argv: readonly string[];
    workspacePath: string;
    workspaceMountPath: string;
    network: "none" | "internal";
    timeoutSeconds: number;
    env: Readonly<Record<string, string>>;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
}
```

`@maestro/runners` ise `RunnerPort` sunuyor:
`acquire / runSession / mountCache / release` — **`image` alanı yok** ve stdout
**tail** döndürüyor. Kesilmiş bir tarayıcı raporu daha küçük bir rapor değil,
**parse hatasıdır**; "pass" diye okunursa güvenlik kapısı sessizce çalışmayı
bırakır.

İki paket de kendi dosyalarında bunu yazıyor. Uydurma bir adaptör yazmak yerine
`unbridgedScanRunner()` yazıldı: port **kurulur** (kablolama doğrulanabilir),
ilk taramada boşluğu adıyla söyleyerek reddeder.

**İstenen:** ya `RunnerPort`'a tam-stdout dönen bir tek-atış metodu, ya
`ContainerRunner`'ı karşılayan resmî bir `@maestro/runners` export'u:

```ts
// @maestro/runners
export function createContainerRunner(
  config: unknown,
  deps: RunnerDeps,
): ContainerRunner;   // @maestro/scanners'ın ContainerRunner'ı
```

### 2. `WorkPort.parseEvent` yok

BFF `WorkEventReader`'ı kendi tanımlıyor çünkü `WorkPort`'ta webhook payload'ını
sınıflandıran bir metot yok. Şu an composition root sürücünün
`parseWebhookEvent`'inden türetiyor (`src/work-events.ts`) — ikinci bir grammar
yazılmadı, ama bu portta olmalı:

```ts
// @maestro/ports — WorkPort'a
parseEvent(payload: unknown): {
  kind: "issue" | "comment" | "other";
  ticketKey?: TicketKey;
  labels?: readonly string[];
};
```

### 3. `AuditStore`'un Postgres implementasyonu yok

`@maestro/audit` yalnızca `InMemoryAuditStore` ve `LocalChainLock` sunuyor;
ikincisi **süreç-yerel**. Hash zincirli denetim izi (M33) tek BFF replikasıyla
doğru, ikinci replika eklendiği anda **sessizce yanlış**. Compose şu an tek
replika çalıştırıyor; ölçeklemeden önce Postgres destekli `AuditStore` +
advisory-lock tabanlı `ChainLock` gerekiyor.

---

## Yapılmayanlar ve Nedenleri

### Worker **poll etmiyor** (bilinçli reddediş)

Portların hepsi kuruluyor, ama `@maestro/workflows`'un `CoreDeps`'i çalışma-anı
durumu istiyor ve **hiçbiri implemente değil**:

- `RunContextStore`, `GateStore`, `ParamReader`, `DirectoryReader`
- `IdempotencyGuard` (tablo destekli; `InMemoryIdempotency` tek-worker'lık)
- `AuditStore` (yukarıda)

Bunlar Postgres destekli çalışma durumu — sonraki dalganın işi. In-memory stub
ile worker **başlardı**, task queue'yu poll ederdi, ticket alırdı — ve ilk
yeniden başlatmada her run'ın bağlamını **sessizce** kaybederdi, Jira yorumu çoktan
atılmış olarak. Başlamayan worker sabah 09:00'da bir çağrıdır; başlayıp unutan
worker bozuk bir denetim izidir. Bu yüzden `worker.ts` portları kurar, tabloyu
basar, ve eksikleri **adıyla sayarak** reddeder.

### `apps/studio` repoda yok

`Dockerfile.studio` yazıldı ve compose'da servis tanımlı, ama uygulama mevcut
değil. Build stage `apps/studio` yoksa **açık hata verir** — boş bir nginx'in
`/` üzerinde 200 dönmesi çalışan bir deployment'a birebir benzerdi.
`pnpm deploy:up` studio dışındaki her şeyi ayağa kaldırır; studio build'i
uygulama gelene kadar başarısız olur.

### BFF'in bazı store'ları hâlâ in-memory — ve hepsi aynı ağırlıkta değil

Bu bölüm daha önce `sessions`, `params`, `killSwitch`, `bindings`, `gates`'i tek
bir liste hâlinde "henüz tamamlanmadı" diye sunuyordu. Doğrulayıcı haklı olarak
buna itiraz etti: aynı listede **oturum kaybı** ile **acil durum freninin
kendiliğinden bırakılması** yan yana duruyordu, oysa bunlar aynı tür eksik değil.
Ayrım artık kodda da, burada da açık:

| Store | Durum | Yeniden başlatmada |
|---|---|---|
| `users` | **Prisma** (`PrismaUserDirectory`) | kalıcı |
| `bindings` | **Prisma** (`PrismaJiraProjectBindings`, O-1) | kalıcı |
| `killSwitch` | bellek-içi | **fren `off`'a düşer** → `prod` profili **açılmayı reddeder** (K-1) |
| `params` | bellek-içi | M71 parametreleri + bekleyen 4-göz önerileri kaybolur — açılışta uyarı basılır |
| `sessions` | bellek-içi | herkes çıkış yapmış olur — kabul edilebilir |
| `gates` | statik varsayılanlar | değişmez |

**K-1 neydi:** `killSwitch` bellek-içiydi ve `KILL_SWITCH_OFF` ile başlıyordu;
compose'da `bff` servisi `restart: unless-stopped` ile çalışıyor. İkisi bir
araya gelince operatör olay anında switch'i `stop_all` yapıyor, konteyner
herhangi bir sebeple yeniden başlıyor ve **fren kendiliğinden bırakılıyordu** —
sessizce, yazma uçları yeniden açık. Bu, bu paketin kendi ilkesinin tersiydi:
`unbridgedReadModels` "boş sayfa sakin sistem yalanıdır" diye özenle
**reddetmeye** ayarlanmışken kill switch aynı özeni görmemişti. Artık
`assertStoresDurable` `prod` profilinde soket açılmadan **adıyla reddediyor**;
`dev` izin veriyor ama bunu açıkça yazıyor (`stores/durability.ts`).

`params` bilinçli olarak uyarı seviyesinde: kaybı kötü ama telafi edilebilir
(tanımların varsayılanı var, öneri tekrar açılabilir). Kill switch'in kaybı
telafi edilemez, çünkü kimseye telafi gerektiği söylenmiyor.

Kalanların şemada karşılığı yok; onları uydurmak bu dalganın işi değil.

### Docker imajları build edilmedi

Ortam kısıtlı (imaj indirme yok). `docker compose config` çalıştırıldı ve
**geçerli**; Dockerfile'lar sözdizimsel olarak doğru ve testlerle
(multi-stage, non-root, `--frozen-lockfile`, `exec`) doğrulanıyor.

---

## Koordinatör Değişikliklerine Uyum

İki donmuş-paket değişikliği bildirildi; **eklenmedi** (çakışma olmasın), ama
kod ileriye dönük uyumlu yazıldı:

1. **`EnvSchema`'ya `BFF_PORT`/`BFF_HOST`** — kendi şemamdan **çıkarıldı**.
   `listenAddress(env)` bunları `env.base`'den yapısal olarak okuyor, yani
   değişiklik inmeden önce de sonra da derleniyor. Compose'da
   `BFF_HOST: "0.0.0.0"` **açıkça** verildi (loopback varsayılanı bilinçli;
   test bunu zorluyor).

2. **`contracts/identity.ts` — `Role` kapalı kümesi** — `PrismaUserDirectory`'nin
   grup→rol eşlemesi tam olarak o birliğin değerlerini kullanıyor
   (`admin`, `tech-lead`, `product-owner`, `qa`, `developer`, `viewer`).
   Literal yazıldı (modül henüz yok), ama `users.test.ts` `ROLES` export'u
   göründüğü anda her değeri ona karşı **pinliyor**. Tanınmayan grup **hiçbir**
   rol vermiyor — kapalı küme böyle korunuyor.

Route dosyalarına dokunulmadı.
