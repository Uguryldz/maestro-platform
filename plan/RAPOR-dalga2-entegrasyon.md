# Dalga 2 — entegrasyon turu raporu

Dalga 2 paketleri (`execution`, `memory`, `notify`, `publish`, `scanners`, `runners`) paralel yazılırken
`pii` paketi güvenlik düzeltme turundan geçti ve API'si sertleşti. Bu tur, oluşan kaymayı kapatıp kök
kapıyı yeşile döndürüyor.

**Sonuç:** `pnpm run gate` → **34/34 görev yeşil** (lint + önbelleksiz typecheck + test), **1737 test geçti,
7 atlandı (db, canlı Postgres isteyenler)**.

## 1. Turun başındaki kırmızı tablo

`pnpm install` → temiz. `pnpm lint` → temiz. `turbo typecheck test --force --continue` → **32/34 başarılı**;
kırmızı olan **yalnız `@maestro/execution`** (hem `typecheck` hem `test`). Diğer 15 paket etkilenmemişti:

| Paket | Durum | Not |
|---|---|---|
| `execution` | **typecheck + test KIRMIZI** | 8 tip hatası, 5 test hatası — tamamı `pii` kayması |
| `memory` | yeşil | `pii` düzeltmesi bu pakette zaten yapılmıştı |
| `notify`, `publish`, `scanners` | yeşil | **`pii`'yi hiç kullanmıyorlar** (grep ile doğrulandı) |
| `llm-gateway` | yeşil | markasız `PiiPolicy` tipini kullanıyor; markalı tip ona atanabildiği için kırılmadı |
| diğerleri | yeşil | — |

> `runners` diye bir paket `packages/` altında yok (Dalga 2 paketleri arasında sayılmıştı); `scanners` var ve yeşil.

### `execution` — ham hata listesi

```
src/collect.ts(87,7)        TS2322  PiiPolicy -> LoadedPiiPolicy ('[POLICY_BRAND]' eksik)
test/collect.test.ts(68)    TS2345  Masked<SessionReport> !-> SessionReport
test/collect.test.ts(103)   TS2345  aynısı
test/collect.test.ts(128)   TS2339  'finalText' Masked<SessionReport> üzerinde yok
test/collect.test.ts(132)   TS2339  'output' PiiBoundaryResult<string> üzerinde yok
test/collect.test.ts(136)   TS2339  'runId' Masked<SessionReport> üzerinde yok
test/execution.test.ts(41)  TS2345  Masked<SessionReport> !-> SessionReport
+ 5 test hatası (aynı üç kaymanın çalışma zamanı yüzü, biri PiiArgumentError)
```

## 2. Paket paket: ne kaydı vardı, nasıl kapatıldı

### `@maestro/execution`

| Kayma | Nerede | Nasıl kapatıldı |
|---|---|---|
| **(3) Markalı politika** | `src/collect.ts:62`, `src/execution.ts:39` | `PiiPolicy` → `LoadedPiiPolicy`. Davranış aynı; `defaultPiiPolicy()` zaten markalı dönüyor, tek fark elle yazılmış bir politika nesnesinin artık derlenmemesi (B-7). |
| **(1) `Masked<T>` zarf sınıfı** | `test/collect.test.ts`, `test/execution.test.ts` | Lavabo (sink) içinde `payload` → `payload.value`. Zarf artık sınıf; yayılma (spread) prototipi ve özel alanı kaybettiği için `.value` okumak tek yol. |
| **(2) `PiiBoundaryResult` sınıf** | `test/collect.test.ts:132` | `result.output` → `result.reveal()`. Üstüne bir iddia **eklendi**: `JSON.stringify(result)` gerçek IBAN'ı içermemeli — `.output` alanının kaldırılma sebebi tam olarak buydu (B-12/M82). |
| **(2) yan etki** | `test/collect.test.ts:109` | `assertNoPii(stored[0], …)` `PiiArgumentError` atıyordu: `stored[0]` artık düz nesne değil `Masked` örneğiydi ve maskeleyici sınıf örneklerini fail-closed reddediyor. Lavabo `.value` biriktirince iddia olduğu gibi geçerli kaldı. |
| **(4) Jeton dilbilgisi** | `test/collect.test.ts:90` | Birebir `/\[IBAN_\d+\]/` beklentisi → `IBAN_TOKEN = /\[IBAN_\d+\.[0-9a-f]+\]/`. İddia gevşetilmedi, **sıkılaştı**: nonce'un varlığını da doğruluyor. |
| **(5) Oturum ömrü — GERÇEK DAVRANIŞ HATASI** | `src/collect.ts`, `src/execution.ts` | Aşağıda §3. |

### `@maestro/pii`

Davranışı değiştirmeyen **tek bir ek**: `withPiiBoundary` artık `PiiGateOptions` alıyor ve isteğe bağlı
`sessionScope?: "call" | "boundary"` taşıyor (varsayılan `"call"` — mevcut davranış birebir korunuyor,
`maskOutbound` bu alanı hiç görmüyor). §3'teki hatayı düzeltmenin başka yolu yoktu: `Masked` zarfını
basmak (mint) yalnız bu pakete ait ve dışarı verilmiyor, dolayısıyla `execution` kendi kalıcı oturumunu
tutup zarfı üretemiyordu. Alternatif — `execution`'ın `Masked` yerine memory'deki gibi kendi kesişim
markasını tanımlaması — sınıf zarfını kesişim markasına geri çevirmek olurdu; `pii` RAPOR'unun tam olarak
kaldırdığı zayıflık. İki yeni test eklendi (`test/boundary.test.ts`): kapı ömrü boyunca tek oturum, ve
maskeli bir yükün ikinci geçişte parantezlerini kaybetmemesi. Mevcut "her çağrıda bir oturum" testi
(B-8 koruması) olduğu gibi duruyor ve hâlâ yeşil.

### `@maestro/memory`

Kod değişmedi (tur başında zaten yeşildi). `createJournalMasker` üstündeki **yorum eskimişti**: hâlâ "her
çağrı kendi oturumunu açar, jeton numaralandırması her çağrıda sıfırlanır" diyordu, oysa 6 satır aşağıdaki
düzeltme tam tersini yapıyor (ömür boyu tek oturum). Yorum gerçeğe çekildi — davranış dokunulmadı.

### `@maestro/config` (bu turda düzenleme yetkisi verilen tek katalog)

- `notify.delegated` tr+en eklendi.
- `packages/publish/RAPOR.md` §3'teki **46 `publish.*` anahtarı** tr+en eklendi. Katalog 63 → **110 anahtar**,
  iki dilde birebir aynı küme (parite testi yeşil). `publishMessageKeys()`'in döndürdüğü **65 anahtarın
  tamamı** (46 kendi + 19 `steps.*`) katalogda mevcut — geçici bir testle doğrulandı, test sonra silindi.
- `test/catalog-usage.test.ts` içindeki `KEY_LITERAL` düzenli ifadesine `publish` eklendi. Koruma gerçekten
  körmüş: regex genişletilip tr'den tek bir anahtar silindiğinde test kırmızıya döndü
  (`publish.label.risk_tier (emitted by packages/publish/src/keys.ts)`), yani tarama artık yük taşıyor.
  Başka bir namespace gerekmedi: tüm paketler tarandı, mesaj anahtarı görünümlü tek aile `publish.*`'tı
  (`gates.risk_tiers`, `escalation.ladder` vb. **parametre** anahtarları, mesaj değil).

## 3. Davranış hatası: maskeleyici ömrü (bulundu, düzeltildi, testi yazıldı)

**Nerede.** `execution`'da iki katmanda birden:

1. `createReportJournal` → `withPiiBoundary` **her çağrıda yeni oturum** açıyordu.
2. `AgentExecution.publish()` **her turda yeni bir günlük yazıcısı** kuruyordu.

**Neden hata.** Jetonlar artık oturum nonce'u taşıyor (`[IBAN_1.a3f9]`). Bir oturum kendi basmadığı
jeton-görünümlü metnin parantezlerini söküyor (`defangForeignTokens`, B-9 koruması — kullanıcı yazımı bir
`[TCKN_1]`'in başkasının kimliğine çözülmesini engelliyor). Günlük ise append-only ve geri okunuyor: ajan
2. turda 1. turda söylediğini — yani **maskelenmiş** metni — tekrarlıyor. Yeni oturum onu tanımıyor,
parantezleri söküyor, satır artık "burada bir değer kaldırıldı" demiyor. Defter kendisiyle çelişiyor.

**Kanıt.** Düzeltme geri alındığında yazdığım test tam bu çıktıyı veriyor:

```
expected 'still refunded IBAN_1.414b93fb' to be 'still refunded [IBAN_1.414b93fb]'
```

**Düzeltme.**
- `createReportJournal` artık `sessionScope: "boundary"` geçiyor → yazıcı ömrü boyunca tek oturum.
- `AgentExecution` yazıcıyı **veri sınıfı başına bir kez** kurup saklıyor (`journals: Map<DataClass, …>`).
  Veri sınıfı başına ayrı: iki sınıf iki profile çözülür, bir oturum tam olarak bir profile aittir.
- Ters harita (ReverseMap) yine kapanışın (closure) içinde; dışarı çıkan hiçbir şeyde yok — yazıcı koşuyla
  birlikte ölüyor. Bunun bedeli açıkça belgelendi (`PiiSessionScope` yorumu).

**Yeni testler (4 adet).**
- `pii/test/boundary.test.ts`: kapı kapsamı tek oturum tutuyor · kendi jetonunu ikinci geçişte sökmüyor.
- `execution/test/collect.test.ts`: yazıcı ömrü boyunca tek oturum (aynı raporun ikinci yazımı birebir aynı) ·
  aynı değer aynı jetonu alıyor, böylece bir koşu tek bir hikâye gibi okunuyor.
- `execution/test/execution.test.ts`: iki tur boyunca tek oturum — 2. turun alıntıladığı jeton sağ kalıyor.
  (Yardımcı: `echoingLlm`, cevabı çağrı anında hesaplayan LlmPort ikizi; hazır liste bunu ifade edemiyor.)

Üçünün de yük taşıdığı, düzeltme geçici olarak geri alınıp testlerin kırmızıya döndüğü görülerek doğrulandı.

## 4. Testler: ne değişti, neden

| Test | Değişiklik | Gerekçe |
|---|---|---|
| `collect.test.ts` — MASKED report | lavabo `payload` → `payload.value`; `/\[IBAN_\d+\]/` → nonce'lu regex | Zarf sınıflaştı; jeton dilbilgisi değişti. İddia sayısı aynı, biri **daha sıkı**. |
| `collect.test.ts` — bağımsız tarama | lavabo `.value` biriktiriyor | `assertNoPii` sınıf örneklerini fail-closed reddediyor; iddianın kendisi korundu. |
| `collect.test.ts` — un-mask | `result.output` → `result.reveal()`, **+1 yeni iddia** | Gerçek değerler `#output`'ta; `JSON.stringify(result)` sızdırmamalı. |
| `collect.test.ts` — markalı lavabo | `payload.runId` → `payload.value.runId` | `@ts-expect-error` iddiası olduğu gibi duruyor. |
| `execution.test.ts` — masked report | lavabo `.value`, **+1 nonce iddiası** | Aynı sebep. |
| `+4 yeni test` | — | §3. |

**Silinen test yok, gevşetilen iddia yok.** Geçersizleşen bir test de çıkmadı: her eski iddia yeni API'de
karşılığıyla ifade edilebildi.

## 5. Dokunulmayanlar

- `packages/contracts`, `packages/ports`: **dokunulmadı**.
- `notify`, `publish`, `scanners`: **hiç değişmedi** — `pii` kullanmıyorlar, oturum-ömrü hatası da yok.
- `llm-gateway`: değişmedi. `src/masking.ts` ve `src/gateway.ts` hâlâ markasız `PiiPolicy` alıyor; markalı
  tip atanabildiği için kapı yeşil. **Açık kayıt (Dalga 3):** `execution`/`memory` gibi `LoadedPiiPolicy`'ye
  geçirilmeli, yoksa elle yazılmış bir politika oradan girebilir (B-7'nin kapatılmamış son kapısı).
  Ayrıca `src/redact.ts:41` her çağrıda yeni oturum açıyor; log kırpma için ifşa riski yok (geri açma yok),
  ama iki kez kırpılan bir satırın jetonu parantezini kaybeder — kozmetik, kapsam dışı bırakıldı.

## 6. Doğrulama

```
pnpm install                # ✓
pnpm run gate               # ✓ exit 0 — lint + turbo typecheck test --force
                            #   Tasks: 34 successful, 34 total · Cached: 0
                            #   1737 test geçti, 7 atlandı (db, canlı PG isteyen)
```

Paket başına: contracts 18 · ports 5 · config 12 · pii 154 · audit 109 · test-kit 4 · notify 106 ·
publish 98 · storage 210 · llm-gateway 137 · secrets 197 · adapter-jira 90 · scanners 104 · adapter-ado 120 ·
db 162 (+7 atlandı) · execution 115 · memory 96.
