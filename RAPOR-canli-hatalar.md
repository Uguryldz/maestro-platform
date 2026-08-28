# Canlı hata raporu — ZodError, takılı koşular, RunNotFoundError

Dal: `worktree-agent-aa9020332d41dcce4` (kaynak: `gap-b10-b14-pii-changetype-audit-realmerge` @ `7d37045d`)

Üç bulgu da **ölçüldü**, tahmin edilmedi. Kanıtlar aşağıda; her iddianın yanında onu
üreten komut var.

---

## Özet — üç bulgunun ikisi zaten düzelmişti

Görev tanımı üç aktif hata varsayıyordu. Ölçüm başka bir şey söyledi:

| Bulgu | Gerçek durum | Yapılan |
|---|---|---|
| 1. `ZodError: variantId` | **Kök neden `7d37045d`'de düzeltilmiş.** Log, düzeltmeden ÖNCE başlamış iki koşuya ait. Ama yazma yolunda koruma yoktu. | Kalan boşluk kapatıldı: `create`/`patch` artık boş `variantId`'yi reddediyor. 7 test + 3 mutasyon kanıtı. |
| 2. `3o`'da takılı koşular | **Ölü.** Temporal'da dördü de `Failed`. DB `running` diyor çünkü **terminal durumu geri yazan hiçbir şey yok.** | Teşhis + ARAYÜZ İSTEĞİ (kod değişikliği değil — donmuş arayüz gerektiriyor). |
| 3. `RunNotFoundError: OPS-40` | **Zararsız ama gerçek bir yarış.** Poller değil. Tek kez, `attempt: 1`, 739 ms. | Teşhis; kendi kendine iyileşiyor. Düzeltme önerisi aşağıda. |

---

## Bulgu 1 — `variantId` boş dize

### Kök neden (kanıtla)

Yığın izi görevde belirtilen yeri değil, **gateway'in giriş sınırını** gösteriyor:

```
at LlmGateway.generateObject (packages/llm-gateway/src/gateway.ts:119:45)
at Module.runIntake (packages/workflows/src/impl/intake.ts:135:34)
```

`gateway.ts:119` = `GenerateObjectRequestSchema.parse(request)`. Yani varyant
"çözümlenemiyor" değil; **koşu satırı boş `variantId` ile açılmış**, ve ilk model
çağrısında sözleşme ihlali olarak patlıyor.

Canlı DB bunu tam olarak doğruluyor — `startedAt`'e göre sıralı:

```
OPS-22 | (boş)           | 2026-08-15 19:51:58
OPS-23 | (boş)           | 2026-08-15 19:58:12
OPS-24 | analyst-default | 2026-08-15 20:04:43
...    | analyst-default | ...
OPS-40 | analyst-default | 2026-08-16 08:46:45
```

**16 koşudan yalnızca 2'sinde boş** — ve loglardaki iki ZodError tam olarak o ikisi
(OPS-22, OPS-23). Kalan 14 koşu sağlam.

**Neden:** `apps/deploy/src/stores/run-pins.ts` (`activeAnalystVariantId`,
`DEFAULT_ANALYST_VARIANT = "analyst-default"`) commit `7d37045d`'de, **2026-08-15
23:18:24**'te eklendi. OPS-22/23 ise 19:51 ve 19:58'de — düzeltmeden ~3.5 saat önce —
açılmıştı. Yani **kök neden zaten kapatılmış**; log eski koşuların retry'larını
gösteriyor.

Sorulara net cevap:
- *Varyant hiç seçilmiyor mu, seçilip boş mu kaydediliyor?* → Artık seçiliyor.
  Öncesinde hiç seçilmiyordu (çözücü yoktu), sütun `@default("")` olduğu için boş yazılıyordu.
- *DB'de varyant satırı var mı?* → **Evet, 2 tane**: `analyst-default`, `engineer-default`
  (`VariantVersion` 3 satır). Yani fallback literali gerçek bir satıra denk geliyor.

### Kalan boşluk — asıl düzelttiğim şey

Kök neden kapalıydı ama **değişmez (invariant) korunmuyordu**: `WorkflowRun.variantId`
sütunu `@default("")`, `RunCreate.variantId` opsiyonel, `NewRun.variantId` ise sadece
`string`. Composition root'un yanlış bağlanması aynı zehirli satırı tekrar yazabilirdi.

**Karar: fail-closed, mağazada varsayılan YOK.** Gerekçe:
- Varsayılan **`run-pins.ts`'e ait** — deployment'ın varyantlarını o biliyor.
- Mağazada ikinci ve sessiz bir varsayılan, yanlış bağlanmış bir kurulumu maskeler ve
  gerçek banka ticket'larını **kimsenin seçmediği bir ajana** sabitler.
- "Boş dize kaydet" zaten yanlış olan mevcut davranıştı.

`apps/deploy/src/stores/run-context.ts`:
- Yeni `UnpinnedRunError` — ticket'ı ve eksik alanı **adıyla** söylüyor (ZodError'ın
  söylemediği şey buydu).
- `assertPinned(input)` — `create`'te, **idempotency kontrolünden ÖNCE**. İkinci webhook
  teslimi hatayı yeniden üretilebilir yapan denemedir; orada sessizce dönmek onu en iyi
  görüleceği anda gizlerdi.
- `trim()` ile kontrol: gateway şeması `z.string().min(1)`, yani `" "` oradan geçer —
  çıplak uzunluk kontrolü aynı hatayı bir boşluk ileri taşırdı.
- `toRunUpdate` artık boş pin'i **düşürüyor** (atmıyor): `patch` kısmi güncellemedir,
  çağıran başka sütunları değiştirmek istiyor ve canlı bir koşuyu un-pin etmek hiçbir
  çağıranın kastettiği şey değil.

### Mutasyon kanıtı (zorunlu madde 2 ve 3)

| # | Mutasyon | Sonuç |
|---|---|---|
| 1 | `assertPinned(input);` satırı silindi | **5 test kırıldı** |
| 2 | `input.variantId.trim() === ""` → `input.variantId === ""` | **1 test kırıldı** (boşluk testi) |
| 3 | `toRunUpdate`'teki `.trim() !== ""` koruması kaldırıldı | **1 test kırıldı** |

Üçü de geri alındı; `run-context` + `run-pins` → **31/31 yeşil**.

`variantId` için istenen test: `refuses to open a run with an empty variantId` —
yalnızca hata fırlatıldığını değil, **satırın hiç yazılmadığını** da doğruluyor
(`expect(recorded.creates).toHaveLength(0)`). Başarılı bir `create`'ten SONRA atılan bir
istisna, aynı zehirli satırı bırakıp yine de "rejects" beklentisini geçerdi.

---

## Bulgu 2 — `3o`'da takılı koşular: **ÖLÜ**, takılı değil

Temporal'a soruldu (kesin kanıt):

```
$ docker exec maestro-temporal-1 temporal workflow list --address temporal:7233 --namespace default

Failed   maestro-OPS-33   ticketWorkflow   10 hours ago
Failed   maestro-OPS-32   ticketWorkflow   10 hours ago
Failed   maestro-OPS-31   ticketWorkflow   10 hours ago
Failed   maestro-OPS-30   ticketWorkflow   10 hours ago
```

**Dördü de `Failed`.** Retry döngüsünde değiller, aktivite denemiyorlar. Destekleyici
kanıt: OPS-30..33 canlı worker logunda (`/tmp/worker-flow.log`) **hiç geçmiyor** —
worker onlar için hiçbir iş almıyor.

Çalışma sonu olayları, `RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED` ile:

- **OPS-33** — `discoverRepo` aktivitesi:
  `ClaudeCliError: claude CLI turn failed (exit 1)`
  (`packages/claude-driver/src/claude-sub.ts:116` → `LlmGateway.agentSession` →
  `impl/analysis.ts:50`). Kapanış: `2026-08-15T23:17:39Z`.
- **OPS-30** — farklı kök neden: `invalid secret key`.

Yani "3o'da takılı" görüntüsü iki ayrı ölü nedenden geliyor (Claude CLI oturumu ve
eksik/hatalı secret), ikisi de retry'ları tüketip workflow'u öldürmüş.

### Asıl kusur bu değil — sistemik olan şu

Toplam **13 `ticketWorkflow` Temporal'da `Failed`**, ama DB'de 16 koşunun tamamı hâlâ
`status=running`. OPS-40 bile Temporal'da `Completed` iken DB'de `step=13 running`.

Sebep ölçüldü: **terminal durumu DB'ye geri yazan hiçbir kod yok.**
- `grep` ile `status: "failed"` / `"done"` / `markTerminal` → workflows ve deploy
  store'larında **sıfır sonuç**.
- `RunContext` (`packages/workflows/src/impl/deps.ts:44-68`) bir `status` alanı
  **içermiyor**.
- `RunContextStore` yalnızca `get` + `patch(Partial<RunContext>)` sunuyor — `patch`
  `RunContext`'ten türediği için `status` yazmak **tip düzeyinde imkânsız**.
- `PrismaRunContextStore.create` `status: "running"` yazıyor; `TERMINAL_STATUSES`
  yalnızca **okuma** filtresinde kullanılıyor.

Bu yüzden panodaki "16 koşu çalışıyor" gerçek değil: 13'ü ölü, 1'i bitmiş, DB bunu
hiç öğrenmiyor. HANDOFF'un "OPS-34, OPS-36 ölü" notu doğruydu ve aslında daha geniş.

**Kod değişikliği yapmadım** — çünkü doğru düzeltme donmuş `RunContextStore` arayüzünü
değiştirmeyi gerektiriyor. ARAYÜZ İSTEĞİ olarak aşağıda.

---

## Bulgu 3 — `RunNotFoundError: OPS-40`: gerçek yarış, ama zararsız

Görevdeki hipotez (poller eski yorumu yeniden okuyor) **yanlış çıktı.** Ölçüm:

```
08:46:44.966Z  journal aktivitesi çalıştı  → RunNotFoundError   (attempt: 1)
08:46:45.705   WorkflowRun satırı yazıldı  (DB startedAt)
```

**739 ms'lik açık.** Poller değil, `attempt: 1`'de bir **başlangıç yarışı**.

Yapısal kök neden `apps/deploy/src/temporal-gateway.ts`:

```ts
await this.client.workflow.start(...);        // satır 233 — workflow ANINDA sevk edilebilir
const outcome = { workflowId, started: true };
await this.openRun(input, outcome);            // satır 239 — satır ANCAK ŞİMDİ yazılıyor
```

`start()` döner dönmez worker ilk aktiviteyi çekebilir; satır henüz yoktur.

**Zararsız olduğunun kanıtı:**
- Logda `RunNotFoundError` **tam olarak 1 kez** geçiyor (`grep -c` → 1).
- `attempt: 1` — Temporal yeniden denedi, satır o sırada yazılmıştı, aktivite geçti.
- OPS-40 Temporal'da **`Completed`**; olay akışının sonu
  `EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED`.

Yani kendi kendine iyileşiyor ve gürültü tek satır. **Düzeltmedim**: `start()` ile satır
yazımını atomik yapmak ya `start` öncesi satır açmayı (başlamayan workflow için hayalet
satır riski) ya da gateway'in çağrı sırasını değiştirmeyi gerektirir — ikisi de bu
görevin kapsamından geniş ve şu an zarar vermeyen bir davranış için canlı yolu
değiştirmek istemedim. Öneri aşağıda.

---

## ARAYÜZ İSTEKLERİ

**1. `RunContextStore` terminal durumu yazabilmeli** (Bulgu 2 — asıl kusur)

`packages/workflows/src/impl/deps.ts` (donmuş sayılan bölge):

```ts
export interface RunContextStore {
  get(ticket: TicketKey): Promise<RunContext>;
  patch(ticket: TicketKey, changes: Partial<RunContext>): Promise<void>;
  finish(ticket: TicketKey, status: "done" | "failed" | "cancelled"): Promise<void>; // YENİ
}
```

Gerekçe: `status` bilerek `RunContext`'te değil (aktivitelerin okuduğu iş bağlamı değil),
bu yüzden `patch` ile yazılamaz ve yazılmamalı. Ayrı bir `finish` doğru şekil. Bunsuz
DB'deki koşu durumu Temporal'la **kalıcı olarak** ayrışıyor ve pano yanlış sayı gösteriyor.
`ticketWorkflow` bunu kendi `try/catch/finally`'sinde çağırmalı.

**2. (İsteğe bağlı, Bulgu 3) `openRun` `start()` ile yarışmamalı**

En küçük düzeltme: `journal` gibi ilk aktiviteler `RunNotFoundError`'ı retry edilebilir
saymaya devam etsin (şu an öyle ve çalışıyor), ama gürültüyü azaltmak için ya `start`
öncesi satır açılıp başarısız start'ta silinsin, ya da bu ilk-tur hatası `INFO`
seviyesine indirilsin. Şu an zarar yok — bu bir temizlik maddesi, hata değil.

---

## Yapmadıklarım

- **Canlı ortama hiç yazmadım.** DB'ye yalnızca `SELECT`, Temporal'a yalnızca
  `list`/`show`. Hiçbir servis durdurulmadı/yeniden başlatılmadı.
- **OPS-22/23'ün zehirli satırlarını düzeltmedim** — canlı DB'ye yazma yasak. İkisi de
  zaten ölü; temizlenecekse operatör kararı.
- **Bulgu 2'yi kodla düzeltmedim** — donmuş arayüz gerektiriyor (yukarıdaki istek).
- **Bulgu 3'ü düzeltmedim** — ölçülen etkisi sıfır, canlı yolu gereksiz riske atmamak için.
- `discoverRepo`'nun `ClaudeCliError`'ını ve OPS-30'un `invalid secret key`'ini
  **kök nedene kadar kovalamadım** — bunlar ortam/kimlik bilgisi sorunları, kapsam ayrı.

## Kapı

`pnpm run gate` → **exit 0**, **64/64 görev**. (`GATE_EXIT=0` olarak doğrulandı.)

İki not, ikisi de benim değişikliğimden bağımsız:
- Kapının ilk koşusunda `@maestro/studio` 2 testi 5 sn zaman aşımına düştü, `workflows`
  yük altında kırıldı. Tek başına koşturulunca: studio **313/313**, workflows **128/128**.
  HANDOFF'un "test düşerse önce tek başına koş" tuzağı — yük kaynaklı flake.
- Worktree'de `node_modules` yoktu; `pnpm install` gerekti. `--frozen-lockfile` **başarısız**
  oldu çünkü commit'li `pnpm-lock.yaml`, `apps/deploy/package.json`'daki
  `@maestro/claude-driver` workspace bağımlılığını içermiyordu. Lockfile'a o 3 satır
  eklendi (gerçek bir eksiklik, commit'e dahil).
- `apps/studio/test/screens-flow.test.tsx` ve `screens-listening.test.tsx`'te HEAD'den
  gelen 3 kullanılmayan-import lint hatası vardı; kapı bunlarda kırılıyordu, silindi.
