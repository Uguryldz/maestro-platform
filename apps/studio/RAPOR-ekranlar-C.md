# Studio ekranları — küme C (şablon, bilgi, gözetim)

Dalga 4, 16 ekran. `pnpm run gate` **yeşil (50/50, exit 0)**,
`pnpm --filter @maestro/studio build` **çalışıyor**, studio testleri **117 yeşil**.

Branch: `worktree-agent-a652765c2468ad809` · taban: `78783a7`, sonra küme A'nın
`f199ebb` commit'i üzerine hizalandı (aşağıda §6).

---

## 1. Yazdığım ekranlar

| Ekran | Ne yapar | Uç durumu |
|---|---|---|
| **template** | **Analiz şablonu tasarımcısı (M108)** — bölüm ekle/çıkar/sırala, her bölüme başlık · açıklama · AI talimatı · zorunlu/opsiyonel · beklenen biçim · few-shot örnek; versiyonlu, önizlemeli | uç yok |
| **doctemplate** | **Kurumsal Word/PDF şablonu (M103r/M109)** — yüklenen `.docx`, tanınan yer tutucular, bölüm→`{{bolum:N}}` eşlemesi, üretilen belgeler | uç yok |
| **knowledge** | Knowledge kütüphanesinde arama; veri sınıfı fail-closed | **`GET /studio/knowledge`** ✅ |
| **audit** | Hash zincirli denetim izi + zincir doğrulaması | **`GET /studio/audit`, `/studio/audit/verification`** ✅ |
| **security** | 6b tarama bulguları, önem sırasına göre | **`GET /studio/scans`** ✅ |
| **cost** | Gateway çağrı kaydından harcama + abonelik havuzu | **`GET /studio/cost`, `/studio/quota`** ✅ |
| **llm** | LLM Gateway: abonelik havuzu + çağrı kaydı | **`GET /studio/quota`, `/studio/cost`** ✅ |
| **pii** | PII maskeleme kuralları ve **sayıları** | uç yok |
| **issues** | Karar defteri, filtreli | uç yok |
| **routing** | Jira proje bağlama + yönlendirme politikası | uç yok |
| **variants** | Ajan variant kataloğu | uç yok |
| **variant** | Tek variant: persona · knowledge · sürümler | uç yok |
| **eval** | Golden ticket havuzu + son eval koşumu, **gerileme** vurgulu | uç yok |
| **cache** | 3 cache katmanı + aktif ticket çalışma alanları | uç yok |
| **greenfield** | Repo'su olmayan ticket'ın akışı + AI mimari önerisi | uç yok |
| **help** | Rol bazlı kullanım kılavuzu | veri katmanı yok (dokümantasyon) |

`src/app/screens.ts`, `routes.tsx`, `screen-components.ts` dosyalarına **dokunmadım**.

---

## 2. Şablon tasarımcısının veri modeli (M108) — **sunucu tarafı buna göre yazılacak**

Yer: **`apps/studio/src/screens/template/model.ts`** (saf modül: React yok, ağ yok,
240 satır, 24 birim testi).

```ts
type SectionFormat = "free_text" | "bullet_list" | "table" | "impact_matrix";

interface TemplateSection {
  key: string;          // slug — ŞEMANIN ANAHTARI (kalıcı kimlik)
  title: string;        // görünen başlık (serbestçe değişir)
  description: string;  // insana açıklama
  aiInstruction: string;// ajana talimat → prompt'a girer
  required: boolean;    // fail-closed: eksikse insan kapısına GELMEZ
  format: SectionFormat;
  example: string;      // few-shot "iyi cevap" ölçüsü
}

interface TemplateVersion {           // GET/POST gövdesi
  name: string;
  version: number;
  sections: TemplateSection[];        // SIRA ÖNEMLİ = doküman sırası
}
```

**Anahtar türetme kuralı (`SectionKeyName`)** — sunucunun birebir uygulaması gereken kısım:

1. `slugify(title)`: küçült → **Türkçe harfleri katla** (`ç→c ğ→g ı→i İ→i ö→o ş→s ü→u`)
   → NFD ile aksan sil → `[^a-z0-9]+` → `_` → baş/son `_` kırp → **60 karakter**.
2. `uniqueKey(base, taken)`: boşsa `bolum`; çakışırsa `_2`, `_3`, … ilk boş olan.
3. Başlık **her değiştiğinde** anahtar yeniden türetilir ve **diğer bölümlere karşı**
   benzersizleştirilir. Bir bölüm kendi anahtarıyla çakışmaz (yeniden numaralanmaz).

Örnek: `"Kapsam (dahil / hariç)"` → `kapsam_dahil_haric` · `"Işık ölçümü"` → `isik_olcumu`.
İki kez "Yeni bölüm" eklenirse → `yeni_bolum`, `yeni_bolum_2`.

**Değişmezler (test edilmiş):**
- Bölüm silme/sıralama sonrası **anahtarlar benzersiz kalır ve içerik bozulmaz**.
- **Son bölüm silinemez** (`canRemoveSection`), seçim silinen bölümde kalmaz.
- Aralık dışı taşıma **no-op** — veri kaybı yok.
- Her mutasyon **yeni draft** döndürür (girdi mutasyona uğramaz).
- `id` **istemciye özel** düzenleme tutamağıdır, **sunucuya gönderilmez** (`toWireSections` siler).

**Versiyonlama:** kaydetmek yayınlar → `version + 1`. Yayınlanmış sürüm **yerinde
değişmez** (M83 pinleme: akış başladığı sürümle biter). Ekranda draft yalnızca
**yayınlanmış sürüm numarası değişince** yeniden tohumlanır — aynı sürümü döndüren
bir refetch yazılmakta olan metni **silmez** (regresyon testi var).

**Doğrulama:** bölüm tanımları sunucuda Zod şemasına çevrilir; `required` bölüm
eksikse analiz insan kapısına gelmez, ajan yeniden üretir. **Yeni bölüm eklemek kod
değişikliği gerektirmez** — M108'in asıl amacı budur.

---

## 3. Güvenlik kararları

- **pii** — maskeleme **sunucuda**. Ekran maskeyi çözmez, çözmeye çalışmaz; yanıt tipinde
  örnek değer taşıyabilecek **hiçbir alan yok** ve istenmiyor. Sadece **sayı ve kural**
  gösterilir. Test, ekranda e-posta/TCKN/`[GİZLENDİ]` deseni **bulunmadığını** doğruluyor.
- **knowledge** — **iki katman**: (1) BFF veri sınıfına göre çıkışta süzüyor ve `withheld`
  döndürüyor; (2) ekran gelen kayda **ayrıca** fail-closed davranıyor — `dataClass`
  eksik/tanınmıyorsa **`gizli`** sayılır ve **düşürülür** (maskelenmez). İki sayı
  toplanıp gösteriliyor: eksiltme **görünür**, sessiz değil.
- **audit** — zincirin kendi iddiası kendisi hakkında kanıt değil. `ok: true` **tek başına
  yeşil basılmaz**: `checked === 0` ise **"dayanaksız"** (amber). Ayrıca yeniden hesaplama
  **iç tutarlılık** gösterir, kurcalanmazlık değil (toptan yeniden yazan hash'leri de
  yeniden hesaplar) — dış çapa olmadığı için bu **yeşil sonuçta bile** yazılıyor
  (`audit.basis.no_anchor`). Zincir bozuksa **kayıtlar yine gösterilir** (denetçinin
  aradığı kanıt onlar).
- **security/issues** — bulgular **önem sırasına göre**, hiçbiri gizlenmiyor.
  Tanınmayan seviye `unknown` olur ve **`low`'un ÜSTÜNE** sıralanır (sınıflandırılmamış
  bulgu zararsız değildir). `outcome: "error"` (tarayıcı çalışmadı) **temiz sayılmaz**,
  `fail` ile aynı kırmızı registerde.
- **cost/llm/routing** — `LlmOutcome` (ok/queued/degraded/blocked) görünür.
  **`queued` ve `degraded` asla yeşil değil**; kota bitince iş **kuyruğa girer, düşmez**.
  Bilinmeyen havuz durumu yeşile düşmez. Abonelik çağrıları `usd: null` taşır ve
  **dolar toplamına katılmaz** ("kotadan" yazar; `$0.00` yazmak gerçek tüketimi
  bedava göstermek olurdu).

---

## 4. UÇ İSTEKLERİ (detaylı)

BFF ajanı yazma yüzeylerini bilerek yazmadı; aşağıdakiler **okuma** uçları (ve iki yazma).
Ekranlar yazıldı ama **uydurma uca çağrı yapıp "çalışıyor" demiyorlar**: 404/501 gelince
küme A'nın `<NotAvailable>` bileşeni gösteriliyor ("bu bölüm henüz yayında değil"),
**"kayıt bulunamadı" değil** — çünkü kayıt eksik değil, uç yok. Uç geldiği anda ekran
kendiliğinden canlanır, kod değişmez.

### 4.1 Şablon tasarımcısı (M108) — **en öncelikli**

```
GET /studio/template            → { template: TemplateVersion,
                                    history: { version, at, author, summary }[],
                                    projects: { projectKey, version, pinnedRuns }[] }
POST /studio/template/versions  → gövde: { name, sections: TemplateSection[] }
                                  yanıt: TemplateVersion (yeni version = eski + 1)
```
`TemplateSection` tam şeması **§2**'de. Sunucunun uygulaması gerekenler:
`key` benzersizliği (istemci garanti eder ama **sunucu da doğrulamalı** — fail-closed),
en az bir bölüm, yayınlanmış sürümün **değiştirilemezliği**, M83 pinleme, 4-göz.

### 4.2 Doküman şablonu (M103r/M109)

```
GET  /studio/doc-template  → { template: { fileName, version, uploadedAt, uploadedBy,
                                           sizeBytes, styles: string[] } | null,
                               placeholders: { token, descriptionKey, location, found }[],
                               sectionMapping: { index, title, token, mapped }[],
                               outputs: { fileName, at, templateVersion }[] }
POST /studio/doc-template  → .docx yükle (multipart, ≤10MB); yer tutucu taraması,
                             makro/gömülü nesne temizliği, sürümleme
```
`template: null` **gerçek bir durum** (şablon yüklenmemiş) — ekran uyarır, üretim durmaz.

### 4.3 Diğer okuma uçları

```
GET /studio/variants           → { variants: { variantId, role: LlmRole, platform, model,
                                    activeVersion, knowledgeFiles, evalScore: number|null }[] }
GET /studio/variants/:id       → { variantId, role, platform, model, activeVersion, persona,
                                    knowledge: { docId, fileName, category, version }[],
                                    versions: { version, publishedAt, publishedBy, note,
                                                evalScore: number|null }[] }
GET /studio/eval               → { goldenTickets: { goldenId, sourceTicket, kind, expectation,
                                                    lastScore: number|null }[],
                                    lastRun: { runId, variantId, baselineVersion,
                                               candidateVersion, at,
                                               results: { goldenId, baselineScore: number|null,
                                                          candidateScore: number|null }[] } | null }
GET /studio/cache              → { layers: { layerId: "dependency"|"workspace"|"knowledge",
                                             keyedBy, entries, bytes, note }[],
                                    workspaces: { ticketKey, runnerId, bytes,
                                                  sessionState: "resumable"|"human_working"|"sleeping",
                                                  lastAccessAt, idleDays }[],
                                    evictionAfterDays: number }
GET /studio/greenfield?ticket= → { ticketKey, title,
                                    steps: { stepId: "analysis"|"architecture"|"approval"|
                                                     "repo_setup"|"skeleton"|"first_pr",
                                             state: "done"|"active"|"pending" }[],
                                    proposal: { stack, modules[], repoLayout, dependencies[],
                                                platform: PlatformProfile, pipeline } | null }
GET /studio/routing            → { projects: { projectKey, trigger: "auto"|"label"|"command",
                                               apps: string[], note }[],
                                    rules: { ruleId, condition, backend, model,
                                             outcome: "ok"|"queued"|"degraded"|"blocked" }[] }
GET /studio/pii                → { summary: { maskedCalls, totalCalls, maskedFields,
                                              exemptVariants: string[], onPremCalls,
                                              archiveMasked: boolean },
                                    rules: { ruleId, kind, matcher, strategy, hits }[] }
```
**`/studio/pii` için kritik not:** yanıt **maskelenen değeri taşımamalı** — ne ham ne
maskeli örnek. `matcher` alan adı ya da desendir, **değer değildir**. Geçmişteki açık
tam olarak "maskelenen değerin ikinci kopyası"ydı.

```
GET /studio/decisions          → { decisions: { decisionId, ref, question, decision,
                                                severity, status, decidedAt }[] }
```

### 4.4 Mevcut uçlarla ilgili küçük istekler

- **`GET /studio/audit/verification`** bugün `{ ok, checked, brokenAtSeq }` döndürüyor.
  **İstek:** dış çapa bilgisi (`anchor: { hash, at, location } | null`) eklensin.
  Bugün ekran "iç tutarlı" diyor ve çapa olmadığını açıkça yazıyor; çapa gelirse
  "kurcalanmadı" iddiası ilk kez dürüstçe kurulabilir. Şu an **kasıtlı olarak** o iddia yok.
- **`GET /studio/cost`** sayfa döndürüyor; ekran toplamı **o sayfadan** hesaplıyor ve
  bunu kullanıcıya yazıyor. **İstek:** sunucu tarafı toplam (`totals: { apiUsd, quotaCalls,
  tokens }`) — sayfa toplamını "tüm zamanlar" gibi göstermemek için bugün açıkça
  "bu sayfadaki N çağrıdan hesaplandı" yazıyoruz.
- **`GET /studio/knowledge`** `q` zorunlu. Ekran boş aramada **hiç istek atmıyor**.
  Listeleme (aramasız gezinme) istenirse ayrı bir uç gerekir.

---

## 5. Katalog

- **411 küme C anahtarı** (`template.*`, `doctemplate.*`, `knowledge.*`, `audit.*`,
  `pii.*`, `security.*`, `issues.*`, `cost.*`, `llm.*`, `routing.*`, `variant(s).*`,
  `eval.*`, `cache.*`, `greenfield.*`, `help.*`, `severity.*`, `data_class.*`).
- `tr.json` ve `en.json` **976 anahtar, parite tam** (küme A'nın 320 anahtarı dahil).
- Koordinatörün istediği gibi **ekran adıyla ön eklendi**; küme A ile **çakışan tek anahtar
  yok** (birleştirme betiği doğruladı). Genel anahtarlar (`action.*`, `empty.*`, `error.*`)
  **yeniden tanımlanmadı**, olduğu gibi kullanıldı.
- Gömülü kullanıcı metni **yok**; hepsi `useT()`.

---

## 6. Küme A ile hizalama (koordinasyon notundan sonra)

- `src/screens/shared/` küme A'nın alanı: kendi `ScreenState.tsx`'imi **sildim**,
  15 ekranı onların **`QueryState`**'ine taşıdım. Onların dosyalarını **değiştirmedim**.
- Bu klasöre **iki yeni dosya** ekledim (raporlanıyor, gerekirse taşınabilir):
  - `TextArea.tsx` — çok satırlı alan (`Input`'un eşi; AI talimatı ve örnek metin için).
    `ui/Field.css` ve aynı id bağlama kurallarını kullanır. İkinci küme isterse `src/ui/`'a terfi edebilir.
  - `unwired.tsx` — `MaybeUnwired`: 404/501'i **"henüz yayında değil"** olarak gösterir
    (küme A'nın `NotAvailable`'ını kullanır), diğer hataları normal çevrilmiş hata olarak bırakır.
  - Ayrıca kümeme özel: `shared/severity.ts`, `shared/outcome.ts`.
- `main` ilerlemesine göre **5 ekranı gerçek uçlara göre yeniden yazdım** (knowledge, audit,
  security, cost, llm) — tipleri artık `packages/contracts` ve `apps/bff/src/read-models.ts`
  ile birebir (`LlmCallLog`, `SubscriptionAccount`, `ScanFinding`, `AuditEvent`).
  Bu sırada `ScanSeverity`'nin `info` seviyesini ve `{ ok, checked, brokenAtSeq }`
  doğrulama şeklini kaçırdığımı fark edip düzelttim.

---

## 7. Testler (117 studio testi; 60'ı bu kümeden)

| Dosya | Kapsam |
|---|---|
| `test/template-model.test.ts` (24) | slugify (Türkçe katlama), anahtar benzersizliği, ekle/sil/sırala/düzenle, **çakışma engelleme**, wire dönüşümü |
| `test/cluster-c-safety.test.ts` (21) | veri sınıfı fail-closed, zincir değerlendirmesi, önem sıralaması, `LlmOutcome` + havuz durumu |
| `test/screens-c.test.tsx` (15) | Template (listeleme, ekleme, sıralama, yeniden adlandırma+çakışma, son bölüm, taslak korunması, 404, çevrilmiş hata), Knowledge (arama, düşürme, sayım), Pii (**değer sızmıyor**), Audit (dayanaksız ok, gerçek geçiş, bozuk zincirde kayıtlar görünür) |

Testler `<StrictMode>` içinde koşuyor (uygulama da öyle) — efekt çift çağrımına dayanıklılık
böylece kapsanıyor. Hiçbir test ağa çıkmıyor; her biri kendi fetch stub'ını enjekte ediyor.

**Mutasyon doğrulaması yapıldı** (testler bozuk kodda gerçekten kırılıyor):
anahtar çakışma koruması kaldırıldı → 1 kırık · sıralama bölümü düşürdü → 3 kırık ·
son bölüm koruması kaldırıldı → 1 kırık · sunucu verdict'ine körü körüne güvenildi → 3 kırık ·
etiketsiz kayıt `acik` sayıldı → 6 kırık · draft tohumlama koruması kaldırıldı → sonsuz döngü ·
404 düz hataya düştü → 1 kırık.

---

## 8. Yapmadıklarım ve nedeni

- **Şablon/doküman kaydetme uçlarına gerçek bağlanma** — uç yok (BFF ajanı bilerek yazmadı).
  Tasarımcı tam çalışıyor; kaydetme mutasyonu yazılı ama uç gelmeden 404 alır ve ekran
  bunu "henüz yayında değil" diye gösterir. **Uydurma uca "çalışıyor" demedim.**
- **`.docx` yükleme (drag-drop)** — yazma ucu yok; yükleme yüzeyi olmayan bir dosya
  seçici ölü yol olurdu. Yer tutucu/eşleme görünümü tam.
- **Variant persona düzenleme** — salt okunur. Yeni sürüm yayınlamak önce golden ticket
  eval'i gerektiriyor ve o uç da yok; iş görmeyen bir "Kaydet" düğmesi ölü yol olurdu.
- **Greenfield mimari onayı** — kapı kararları **insan kanalından** verilir (Jira komutu /
  kapı ekranı); delegated oturum BFF'te zaten reddedilir. Ekran durumu gösterir, karar vermez.
- **Sayfalama (cursor)** — uçlar `nextCursor` döndürüyor, ekranlar ilk sayfayı gösteriyor.
  Sonsuz kaydırma/sayfa düğmesi kapsam dışı bırakıldı; büyük denetim izinde gerekecek.
- **Sürükle-bırak sıralama** — ↑ ↓ düğmeleriyle yapıldı (klavye ve ekran okuyucu için
  doğrudan çalışıyor). Sürükleme sonradan **üstüne** eklenebilir.
- **Şekil üretimi (SVG etki matrisi / akış şeması)** — `DOKUMAN-STANDARDI.md`'de Dalga 4
  kalemi ama **docx sürücüsünün işi** (sunucu tarafı), Studio ekranı değil.
