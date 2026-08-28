# @maestro/demo-stack

Studio'yu tek komutla, gerçek veriyle çalışır halde gösteren geliştirme yığını.

```bash
cd maestro
pnpm install          # bir kez
pnpm demo:up
```

Sonra tarayıcıda **http://localhost:7000** — Studio orada, BFF 7001'de.
Durdurmak için `Ctrl-C` (Studio önce, sonra BFF zarifçe kapanır).

Yalnız BFF isteniyorsa: `pnpm demo:bff`.

---

## Bu bir DEMO, ama YALAN DEĞİL

Veri sahte, **davranış sahte değil**. Ayağa kalkan BFF, `apps/bff`'in
`buildServer()`'ının ta kendisi: aynı rotalar, aynı `authGuard`, aynı rol
kontrolleri, aynı proje kapsamı, aynı `decideGate` yolu, aynı fail-closed
kontroller. Değiştirilen tek şey **portların altındaki katman** — Postgres,
Temporal, Jira, ADO, Vault, depolama ve LLM ağ geçidi yok; yerlerine BFF'in
kendi bellek-içi referans store'ları (`apps/bff/src/stores/`) tohumlanmış
halde duruyor.

Somut olarak, bu yığında **gerçekten** çalışan şeyler:

- **Kimlik doğrulama.** bcrypt gerçek, parola politikası gerçek. Yanlış parola
  401. Bilinmeyen hesap da 401 — aynı kod, aynı süre (zamanlama sızıntısı yok).
- **Yetkilendirme.** `viewer` rolü `/studio/runners`'a 403 alır, `internal-audit`
  olmayan `/studio/audit`'e 403 alır, bir geliştirici görmediği projenin
  biletine 403 alır.
- **Kapı kararları.** Onay sinyal olarak gider ve koşu **gerçekten ilerler**
  (aşağıdaki kanıta bakın: `12/gate` → `12b/running`). Kapının sahibi olmayan
  reddedilir. Reddetme gerekçesiz kabul edilmez. `signatureSeq`, hash
  zincirindeki gerçek konumdur.
- **Veri sınıfı filtresi.** `gizli` bilgi tabanı kaydı yetkisiz oturuma
  gösterilmez ve "kaç tanesi gizlendi" sayısı döner.
- **Fail-closed uçlar.** İmzasız Jira webhook'u ve kimliksiz ADO derleme sonucu
  reddedilir — demo'nun Jira sırrı yok, o yüzden `verifyWebhook` **reddeder**,
  "tamam" demez.

Ekranda hiçbir yerde "çalışıyor gibi görünüp arkada hiçbir şey yapmayan" uç
yok. Bağlanmamış ekranlar `NotAvailable` göstermeye devam ediyor (aşağıdaki
dürüst liste).

### Demo olduğu görülebilir

Açılışta konsola ve Studio'nun **Sistem sağlığı** ekranına aynı bilgi düşer:

```
  Maestro demo yığını (yalnız geliştirme)
  DEMO YIĞINI — veriler tohumlanmış, dış sistem bağlı değil.
  Dış sistem bağlı değil: Postgres, Temporal, Jira, ADO, Vault, depolama ve LLM ağ geçidi yok.
```

Bu cümleler **gömülü metin değil**: `packages/config/locales/{tr,en}.json`
içindeki `demo.stack.*` anahtarlarından geliyor (M104). Sağlık ekranı her
servisin `note` alanını katalogdan çeviriyor (`useLabel`), o yüzden konsol ile
tarayıcı aynı kaynaktan konuşuyor. Sağlık tablosunda `bff` ve `studio` sağlıklı,
Postgres/Temporal/Vault/depolama/egress/worker/runner **kapalı** görünür —
çünkü gerçekten yoklar.

---

## Demo hesapları

Parolalar burada **açıkça** yazılı, `deploy/.env.example` kalıbında: yerel
geliştirme kimlik bilgisi sır değildir, ve giriş bilgisi bulunamayan bir demo
kimsenin çalıştıramayacağı bir demodur. Yine de bcrypt'ten ve gerçek parola
politikasından geçiyorlar. **Bu parolalar demo yığını dışında asla
kullanılmamalıdır.** BFF varsayılan olarak yalnız `127.0.0.1`'e bağlanır.

Tümünün parolası aynı: **`Demo!Maestro-2026`**

| Kullanıcı | Rol | Neyi gösterir |
|---|---|---|
| `ayse.kaya` | `admin` | Runner/kota/sağlık ekranları, kill switch, gizli bilgi tabanı kayıtları |
| `mert.demir` | `tech-lead` | 5 ve 12 numaralı kapıların sahibi — UGURPAY-501'in PR onayını kapatabilir |
| `can.ozturk` | `product-owner` | 4 numaralı analiz kapısının sahibi — UGURPAY-504'ü onaylar, PR kapısını onaylayamaz |
| `deniz.yilmaz` | `qa` | 9 ve 11 numaralı test kapılarının sahibi — UGURPAY-123'ün sonuç onayını kapatabilir |
| `baran.tekin` | `developer` | Yalnız kendi projelerini görür; UGURPAY biletlerine 403 |
| `selin.aydin` | `viewer` | Hiçbir yönetim ucuna erişemez; gizli kayıt göremez |
| `hulya.arslan` | `internal-audit` | Denetim zinciri ve doğrulaması yalnız bu rolle (ve admin ile) okunur |

---

## Tohumlanan veri

`mock/index.html` senaryosuna sadık, banka bağlamında Türkçe:

| Ne | Kaç | Ayrıntı |
|---|---|---|
| Koşu (`WorkflowRunState` + `RunRecord`) | 17 | 5 projede; 1 fan-out ana + 4 alt bilet |
| Açık onay kapısı | 5 | 4/5/9/11/12 adımlarında, üç farklı sahip grubu |
| Journal kaydı (M30) | 184 | Koşunun ulaştığı adıma kadar, adım adım |
| Denetim olayı (M33) | 4 | Kapanan koşuların onay zinciri, hash'li |
| LLM çağrı kaydı (M16) | ~100 | Journal'daki AI turlarıyla birebir; bazıları abonelik (`usd: null`) |
| Kanıt paketi (M56) | 2 | Yalnız `done` koşular; risk katmanının istediği onaylarla |
| Uygulama kaydı (M100) | 5 | Biri `.maestro.yaml`'sız (akış durur, uydurmaz) |
| Jira bağlaması (M102) | 5 | Biri **duraklatılmış** (`UGURKREDI`), biri `opt_in` |
| Runner (M60) | 6 | Biri **`unreachable`** (`mac-02`, Xcode güncellemesi) |
| Sandbox (M31) | 6 | `active` / `resumable` / `human_held` karışık |
| Abonelik hesabı (M55) | 4 | Biri `exhausted`, biri `cooling`, biri `disabled` |
| Tarama sonucu (M27) | 5 | 2'si `fail` — UGURDESK-52'nin `fail` durumda olma sebebi |
| Bilgi tabanı kaydı (M18) | 6 | **2'si `gizli`** — Studio'nun düşürdüğü görülebilsin |
| Parametre tanımı (M71) | 12 | 5'i `guarded` (dört göz) |

Durum çeşitliliği kasıtlı: `gate` (beş farklı adımda), `running`, `queued`
(kota bekliyor), `fail` (biri CI, biri tarama), `handover` (insan çalışıyor),
`done`.

**Tutarlılık garanti altında.** Her türetilmiş kayıt tek bir koşu literalinden
üretiliyor, ve `test/seed.test.ts` bunu doğruluyor: journal'ın `runId`'si o
koşunun `runId`'si, journal koşunun ulaştığı adımı geçmiyor, `seq` 1'den
başlayıp boşluksuz artıyor, maliyet toplamı katalogdaki token sayısıyla
uyuşuyor, kanıt paketindeki onaylar risk katmanının istediği kapı setine eşit,
ve fan-out ana/alt ilişkisi iki yönden de tutuyor.

---

## Hangi ekran gerçek veri gösteriyor, hangisi `NotAvailable`

Dürüst liste. Bağlanmamış ekranlar **sahte veriyle doldurulmadı** — BFF'de o uç
yok, Studio da `NotAvailable` gösteriyor, ve öyle kalıyor.

### Gerçek tohumlanmış veri gösterenler (17)

`dash`, `live`, `tickets`, `fanout`, `clarify`, `workmode`, `runners`,
`sandbox`, `knowledge`, `llm`, `cost`, `audit`, `security`, `params`, `users`,
`health`, `login`

### `NotAvailable` kalanlar (18) — BFF'de uç yok

`greenfield` (`/greenfield`), `commands` (`/commands`), `cache` (`/cache`),
`yaml` (`/repo-policy`), `variants` (`/variants`), `variant`
(`/variants/:id`), `eval` (`/eval`), `template` (`/template`), `doctemplate`
(`/doc-template`), `pii` (`/pii`), `notify` (`/notify`), `routing`
(`/routing`), `mcp` (`/mcp/manifest`), `onboard` (`/onboarding*`), `issues`
(`/decisions`), `evidence`, `detail`'in journal sekmesi, `settings`'in
bağlantılar bölümü.

Son üçü **kısmi**: `detail` başlığı ve adım listesi gerçek veri gösterir ama
journal sekmesi boş kalır; `settings`'in kill-switch paneli çalışır ama
sürücü/bağlantı bölümü kalmaz; `evidence` ekranı hiç veri alamaz.

> **Not — düzeltilebilir bir uyuşmazlık.** `evidence` ve `detail`'in journal
> sekmesi aslında *veri olmadığı için* değil, **yol öneki uyuşmadığı için**
> boş: Studio `/runs/:ticket/journal` ve `/runs/:ticket/evidence` çağırıyor
> (`apps/studio/src/screens/shared/runs.ts:113,130`), BFF ise bu uçları
> `/studio/` öneki altında sunuyor (`GET /studio/runs/:ticket/journal`,
> `GET /studio/runs/:ticket/evidence`) ve **ikisi de tohumlanmış durumda**.
> Studio'da tek kelimelik bir önek düzeltmesi bu iki ekranı anında canlandırır.
> Bu paket `apps/studio/` altına yazmadığı için düzeltme yapılmadı; Studio'nun
> o dosyasındaki "BFF bu ucu sunmuyor" yorumu artık eskimiş.

### Hiç uç çağırmayanlar (2)

`help`, `jira` — tamamen statik içerik, zaten öyle tasarlanmış.

---

## Kanıt

Aşağıdakiler çalışan yığından alınmış gerçek çıktılardır.

**Açılış**

```
──────────────────────────────────────────────────────────────────────────
  Maestro demo yığını (yalnız geliştirme)
  DEMO YIĞINI — veriler tohumlanmış, dış sistem bağlı değil.
  Dış sistem bağlı değil: Postgres, Temporal, Jira, ADO, Vault, depolama ve LLM ağ geçidi yok.
──────────────────────────────────────────────────────────────────────────
  BFF 127.0.0.1:7001 adresinde · Studio http://localhost:7000
  Tohumlanan: 17 koşu · 5 açık kapı · 184 journal kaydı · 4 denetim olayı
  Demo hesapları ve parolaları: apps/demo-stack/README.md
──────────────────────────────────────────────────────────────────────────
  VITE v7.3.6  ready in 287 ms
  ➜  Local:   http://localhost:7000/
```

**Sağlık ve giriş**

```console
$ curl -s http://127.0.0.1:7001/healthz
{"status":"ok","env":"development"}                                    # HTTP 200

$ curl -s -X POST http://127.0.0.1:7001/auth/login \
    -H 'content-type: application/json' \
    -d '{"username":"mert.demir","password":"nope"}'
                                                                       # HTTP 401

$ curl -s -X POST http://127.0.0.1:7001/auth/login \
    -H 'content-type: application/json' \
    -d '{"username":"mert.demir","password":"Demo!Maestro-2026"}'
{"token":"2VQTkQTC6BXYrE677SBFtOsafJl_gMKeEzJtBgtIm6o",
 "expiresAt":"2026-08-09T22:33:35.032Z",
 "user":{"userId":"mert.demir@ugurbank.local","username":"mert.demir",
         "roles":["tech-lead"],
         "groups":["maestro-tech-leads","maestro-ugurpay","maestro-ugurweb"]}}
```

**Koşu listesi — katalog ile iş akışı durumu birleşmiş**

```console
$ curl -s "http://127.0.0.1:7001/studio/runs?limit=2" -H "authorization: Bearer $TOK"
{"items":[
  {"ticketKey":"UGURPAY-502","title":"Kredi limiti — iOS ekranı",
   "appId":"ugurmobil-ios","mode":"full_auto","risk":"orta","dataClass":"gizli",
   "parentTicketKey":"UGURPAY-500","reporter":"can.ozturk","costUsd":4.1,
   "state":{"runId":"run-ugurpay-502","step":"10","status":"running",...}},
  {"ticketKey":"UGURPAY-123","title":"İade akışında tutar yuvarlama hatası",
   "prId":1836,"costUsd":2.9,
   "state":{"runId":"run-ugurpay-123","step":"11","status":"gate",...}}],
 "nextCursor":"MjpydW5zOg"}
```

**Kapı onayı koşuyu GERÇEKTEN ilerletiyor**

```console
$ curl -s http://127.0.0.1:7001/runs/UGURPAY-501 -H "authorization: Bearer $TOK"
{"runId":"run-ugurpay-501","step":"12","status":"gate","risk":"orta", ...}

$ curl -s -X POST http://127.0.0.1:7001/runs/UGURPAY-501/signals/gateDecision \
    -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
    -d '{"decision":"approve"}'
{"accepted":true,"step":"12","signatureSeq":5}                         # HTTP 200

$ curl -s http://127.0.0.1:7001/runs/UGURPAY-501 -H "authorization: Bearer $TOK"
{"runId":"run-ugurpay-501","step":"12b","status":"running", ...}
                                          ^^^^^^^^^^^^^^^^ durum değişti
```

**Yetki kontrolleri gerçekten reddediyor**

```console
$ curl -s http://127.0.0.1:7001/studio/runners -H "authorization: Bearer $VIEWER"
{"error":"role_required","details":{"anyOf":["admin","tech-lead"]}}    # HTTP 403

$ curl -s http://127.0.0.1:7001/studio/audit -H "authorization: Bearer $VIEWER"
{"error":"role_required","details":{"anyOf":["admin","internal-audit"]}} # HTTP 403

# gizli kayıt viewer'a gösterilmiyor, ama gizlendiği söyleniyor:
$ curl -s "http://127.0.0.1:7001/studio/knowledge?q=limit" -H "authorization: Bearer $VIEWER"
{"items":[],"nextCursor":null,"withheld":1}

# aynı sorgu, yetkili hesapla:
$ curl -s "http://127.0.0.1:7001/studio/knowledge?q=limit" -H "authorization: Bearer $ADMIN"
{"items":[{"id":"kb-001","title":"Kredi limiti artırma iş kuralları",
           "dataClass":"gizli",...}],"withheld":0}
```

**Studio ve `/api` vekili**

```console
$ curl -s -o /dev/null -w '%{http_code}\n' http://localhost:7000/
200
$ curl -s http://localhost:7000/api/healthz
{"status":"ok","env":"development"}                                    # HTTP 200
```

---

## Testler

```bash
pnpm --filter @maestro/demo-stack test     # 42 test, 3 dosya
```

- `test/stack.test.ts` (14) — yığın ayağa kalkıyor, giriş gerçek, roller ve
  proje kapsamı zorlanıyor, gizli filtresi çalışıyor
- `test/seed.test.ts` (16) — tohumun tutarlılığı: roster her rolü kapsıyor,
  koşu/durum eşleşiyor, journal doğru koşuya ait, maliyet toplamları uyuşuyor,
  kanıt paketi risk katmanının kapı setini taşıyor, hash zinciri doğrulanıyor
- `test/gate.test.ts` (12) — kapı sinyali durumu değiştiriyor, yanlış kişi
  reddediliyor, gerekçesiz ret reddediliyor, izinsiz sinyal adı reddediliyor,
  imzasız webhook reddediliyor

Ağ çağrısı yok: testler `app.inject` kullanıyor, port bağlamıyor.

---

## Mimari

```
pnpm demo:up
   └── src/bin/up.ts
         ├── buildDemoStack()  ──► BffDeps (bellek-içi)
         │      ├── work:     DemoWorkPort      — yalnız verifyMembership gerçek, gerisi reddeder
         │      ├── ci:       DemoCiPort        — kimlik doğrulaması yok → reddeder
         │      ├── runs:     InMemoryRunGateway — sinyal durum makinesini GERÇEKTEN ilerletir
         │      ├── audit:    AuditChain + InMemoryAuditStore  (gerçek hash zinciri)
         │      ├── identity: LocalIdentityProvider + bcrypt   (gerçek)
         │      └── read:     apps/bff'in kendi In-Memory store'ları, tohumlanmış
         ├── buildServer(deps) ──► apps/bff'in GERÇEK Fastify sunucusu, 7001
         └── spawn vite        ──► apps/studio dev sunucusu, 7000 (/api → 7001 vekili)
```

Neden `apps/deploy/src/stores/read-models.ts` bunun tam tersini yapıyor:
orada bellek-içi read model'leri bağlamak **yanlış** olurdu — gerçek bir
kuruluma bakan bir composition root'un "koşu yok" demesi, sakin bir Cuma'dan
ayırt edilemez. Burada store **tohumlu** ve süreç kendini demo ilan ediyor, o
yüzden boş sayfa yalan değil hata olurdu. Aynı kod, farklı bağlam, ters doğru
karar.

`apps/bff/`, `apps/studio/`, `apps/deploy/` bu paket tarafından **yalnız
okunur**; hiçbirine yazılmadı.

---

## ARAYÜZ İSTEĞİ

`packages/contracts` ve `packages/ports` donmuş olduğu için değiştirilmedi;
uygulama sırasında karşılaşılan iki uyuşmazlık:

1. **`internal-audit` rolü `Role` enum'unda yok.** BFF'in `AUDIT_ROLES`
   (`routes/studio-ops.ts:18`) ve `CONFIDENTIAL_ROLES`
   (`knowledge-policy.ts:18`) sabitleri `internal-audit` kabul ediyor, ama
   `packages/contracts/src/identity.ts`'teki `Role` enum'u onu içermiyor. Yani
   denetim zinciri, sözleşmenin temsil edemediği bir rol olmadan okunamıyor.
   Demo hesabı bu yüzden rolleri `readonly string[]` olarak tutuyor
   (`UserRecord.roles` da öyle). Öneri: `Role` enum'una `internal-audit`
   eklensin, ya da BFF'in sabitleri enum'a daraltılsın.

2. **`WorkPort`'ta `parseEvent` yok.** `apps/deploy` bunu zaten RAPOR'unda
   belirtmiş; demo da aynı boşluğa çarptı ve `WorkEventReader`'ı ayrıca enjekte
   etmek zorunda kaldı.
