# Studio'nun kalan 8 ucu

Dal: `worktree-agent-a7463f033f628dfe6` · temel: `528481d`

Sekiz ucun tamamı yazıldı ve **canlı sistemde ölçüldü**. Beşi gerçek veriye
bağlandı, üçü adıyla reddediyor. Hiçbiri boş liste dönmüyor.

## Karar tablosu

| Uç | Sonuç | Kaynak / gerekçe |
|---|---|---|
| `GET /variants` | **bağlandı** (200) | `Variant` + `VariantVersion` tabloları, gerçek satırlar |
| `GET /variants/:id` | **bağlandı** (200) | aynı tablolar; bilinmeyen id → 404, bozuk id → 400 |
| `GET /pii` | **bağlandı** (200) | `AuditLog(PII_MASKED)` meta sayaçları + `LlmCall` sayımı |
| `GET /decisions` | **bağlandı** (200) | `AuditLog` karar aksiyonları + zincir doğrulaması |
| `GET /commands` | **bağlandı** (200) | `packages/contracts` `CommandName` enum'u (ürün kuralı) |
| `GET /mcp/manifest` | **bağlandı** (200) | `maestroMcpServer()` gerçek `ServerDefinition`'ı |
| `GET /eval` | **REDDEDİYOR** (503) | tablo yok **ve üretici yok** — aşağıya bak |
| `GET /cache` | **REDDEDİYOR** (503) | üretici yok — şemada `runner` diye bir şey yok |
| `GET /greenfield` | **REDDEDİYOR** (503) | tablo yok **ve üretici yok** |

## Neden tablo eklemedim (migration YOK)

Görev "tablo ekle ya da adıyla reddet, gerekçelendir" diyordu. **Üçü için de
reddi seçtim ve migration eklemedim.** Ölçüt tek: *bir şey bu veriyi YAZIYOR mu?*

- **`/eval`** — Hiçbir şey golden ticket kaydetmiyor, aday bir varyant sürümüne
  karşı koşturmuyor, skor saklamıyor. `VariantVersion.evalScore` bir kolon
  olarak var ama onu yalnızca demo seed yazıyor: koşusu, baseline'ı ve
  ticket-başına sonucu olmayan tek bir sayı. Migration 0006 ile `GoldenTicket`
  + `EvalRun` açsaydım hiçbir üreticinin doldurmadığı kolonlar olurdu, her okuma
  boş sayfa dönerdi — ve bu ekran boş sayfayı **"gerileme yok"** diye
  gösteriyor. Kapının bütün amacı gerilemenin yayından ÖNCE görünmesi; ölçülmemiş
  yeşil bir sayfa, hata veren sayfadan tehlikelidir.
- **`/cache`** — Ekran her çalışma alanı için runner'ı, disk boyutunu, oturum
  durumunu istiyor. Şemayı taradım: `schema.prisma` içinde **`runner` kelimesi
  hiç geçmiyor** — filo tablosu da yok, `WorkflowRun` üzerinde `runnerId` de.
  `RunnerPort` yalnızca `acquire/runSession/mountCache/release` sunuyor, boyut
  probu yok. Üç M4 katmanının envanteri de yok: `packages/cache` Redis
  koordinasyonu (token bucket, lock, semaphore), giriş ya da byte saymıyor.
  Elde yalnız `WorkflowRun.workspacePresent` var; ekranı ondan doldurmak satır
  başına bir runner id, bir byte sayısı ve bir oturum durumu **uydurmak**
  olurdu — üç uydurma değer, sonuç "ölçülmüş filo" gibi okunurdu. Bu, zaten
  `DEGRADED_CAPABILITIES` içinde `runners` (M60) için verilmiş kararın aynısı.
- **`/greenfield`** — `packages/workflows` içinde mimari öneri kaydı, adım
  durumu ya da repo kurulum satırı yazan hiçbir şey yok. Boş adım listesi
  "sihirbaz henüz başlamadı" diye okunur; oysa gerçek "bu yetenek yok".

Reddin şekli: **503 + `capability_not_wired` + eksik olanı anlatan cümle**
(`apps/bff/src/routes/unwired.ts`). 404 değil, çünkü 404 Studio'da
`MaybeUnwired` üzerinden **"yayında değil"** diye görünüyor — uç var, yetenek
yok demek istiyoruz. 503 gürültülü ve doğru.

## Kritik davranışlar

- **`/pii` maskelenen DEĞER dönmüyor.** Kaynak, `packages/pii`'nin
  `toAuditMeta`'sının yazdığı denetim satırları: yalnız sayı ve tip adı; o
  satırlara hiç düz metin yazılmadı. Üstüne çıktı şeması her seviyede
  `.strict()` — depo ileride bir örnek değer döndürmeye başlarsa uç **500 verip
  durur**, değeri iletmez. Testi var (`sampleValue` enjekte ediliyor, 500 ve
  gövdede değer yok). `matcher` daima bir tip/alan adı (`iban`, `customer_no`).
- **`/decisions` "doğrulandı" bayrağına körü körüne güvenmiyor.** Her satır
  türetildiği `auditSeq`'i taşıyor; zincir **her istekte yeniden hesaplanıyor**
  (`verifyChain`), saklı bir bayrak okunmuyor — saklı bayrak, izi yeniden yazan
  saldırganın da yeniden yazacağı şeydir. Boş sayfa `chainVerified: false`:
  boşluk bir zincir hakkında hiçbir şey kanıtlamaz.
- **Rol ayrımı.** `/pii` ve `/decisions` → `admin` veya `tech-lead`. Diğerleri
  oturum yeterli. Canlıda kanıtlandı: developer `/pii`'de 403, `/variants`'ta 200.
- **Sayfalama.** `/decisions` `limit` üst sınırlı (`limit=9999` → 400) ve cursor
  `seq` tabanlı — seq zincir kilidi altında verilir ve tekrar kullanılmaz, bu
  yüzden offset'in aksine satır atlamaz/tekrarlamaz.

## Canlı kanıt

Kendi Postgres'im (`maestro-a7463f-pg`, port 55443), migration 0001–0004
uygulandı, demo seed yazıldı (9 variant, 76 audit satırı, 5 LLM çağrısı).
BFF kaynaktan, **gerçek Prisma depolarıyla** ayağa kaldırıldı; giriş
`ayse.kaya@ugurbank.local` (`email` alanıyla aranıyor).

```
GET /variants            200  9 variant, gerçek satırlar (analyst-web v7, eval 94 …)
GET /variants/analyst-web 200 knowledge 2 dosya, sürüm listesi
GET /pii                 200  maskedCalls 1/5, maskedFields 2, kurallar (iban 1, customer_no 1)
GET /decisions?limit=3   200  audit-76/71/69, basis.auditSeq, chainVerified true, nextCursor "69"
GET /commands            200  8 komut, contracts enum sırasıyla
GET /mcp/manifest        200  18 araç + kapsam, forbiddenTools [approve_gate, reject_gate, merge_pr]
GET /eval                503  capability_not_wired · "golden-ticket evaluation … has no producer"
GET /cache               503  capability_not_wired · "there is no `runner` anywhere in the schema"
GET /greenfield?ticket=… 503  capability_not_wired · "no workflow writes an architecture proposal"
GET /variants (tokensuz) 401  unauthenticated
GET /pii (developer)     403  role_required {anyOf:[admin,tech-lead]}
GET /greenfield (ticketsiz) 400 invalid_ticket
```

### Tarayıcı

Studio dev sunucusu bu BFF'e bağlandı, sekiz ekran da açıldı. **Hiçbiri
"yayında değil" demiyor:**

- `/variants` — 9 satırlık tablo (rol/platform/model/sürüm/knowledge/eval)
- `/variant?id=analyst-web` — Persona · Knowledge 2 · Sürümler 1 sekmeleri
- `/pii` — "1 / 5", "%20", maskelenen alan 2, kural tablosu; **hiçbir yerde değer yok**
- `/issues` — 36/36 karar satırı, gerçek aktörler ve tarihler
- `/commands` — 8 komut, Türkçe çeviriyle, doğrulama zinciri
- `/mcp` — 18 araç + kapsam rozetleri, ⛔ ile üç yasaklı araç
- `/eval`, `/cache`, `/greenfield` — **"Veri alınamadı" hata durumu** (gürültülü
  ret), "yayında değil" **değil**

## Testler

`apps/bff/test/studio-remaining.test.ts` — **27 test**, hepsi gerçek assert'li,
ağ çağrısı yok. Kapsam: yetki (401/403), boş-liste-yerine-503, `null` eval
skorunun sıfıra çökmemesi, PII değer sızıntısının reddi, karar dayanağı,
sayfalama sınırı, komut listesinin contracts enum'uyla birebirliği, argüman
alan komutların tam kümesi, MCP kapsamları ve yasaklı araçların yokluğu.

Gate: `pnpm run gate` → **exit 0, 60/60 görev, 4105 test geçti** (BFF 401).

## ARAYÜZ İSTEKLERİ

1. **`apps/studio/src/api/errors.ts` → `ERROR_KEYS`'e `capability_not_wired`
   eklenmeli.** (Studio bana salt okunur.) Şu an 503 haritada olmadığı için
   `error.unexpected`'a düşüyor ve ekran "Beklenmeyen bir hata oluştu." diyor —
   doğru yönde (gürültülü) ama operatöre *hangi* yeteneğin bağlı olmadığını
   söylemiyor. Katalog cümlesini ekledim:
   `error.capability_not_wired` (tr+en, mevcut). Haritaya tek satır eklenince
   ekran doğru cümleyi gösterir. Aynı dosyada hiç 503 kodu yok — `not_ready` de
   eksik.
2. **`internal-audit` diye bir ROL yok.** Görev `/pii` ve `/decisions` için
   `admin`/`internal-audit` istiyordu; `packages/contracts` rol kümesini
   `admin | tech-lead | product-owner | qa | developer | viewer` ile kapatmış ve
   bankanın `internal-audit` DİZİN GRUBU `ROLE_BY_GROUP`'ta `viewer`'a düşüyor.
   Sözleşmede olmayan bir rolü yazsaydım hiç geçemeyecek bir kapı olurdu —
   denetçi, kendisi için yazılmış ekrandan reddedilirdi ve bu bir yetki
   yanlış-yapılandırması gibi görünürdü. `admin` + `tech-lead` yaptım.
   **Denetim grubuna kendi rolünü vermek contracts + dizin değişikliğidir.**
3. **`VariantVersion` yayınlayan ve not kolonu taşımıyor.** Ekran
   `publishedBy`/`note` istiyor; tabloda ikisi de yok, `unrecorded` işaretçisi
   dönüyorum (boş string "kimse kaydetmemiş, herhalde sorun yok" diye okunurdu).
4. **Persona metni veritabanında yok.** Prompt metinleri
   `packages/agent-roles` içinde kod; `configJson` yalnız model parametreleri ve
   knowledge referansları tutuyor. Detay ekranı bunu açıkça yazıyor.
5. **PII denetim meta'sında iki yazım var.** `packages/pii`'nin `toAuditMeta`'sı
   `maskedFields`/`maskedTypes` yazıyor, veritabanındaki satırlar
   `fields`/`kinds` kullanıyor. İkisini de okuyorum, yoksa açıkça iki alan
   maskelendiğini söyleyen bir iz üzerinde sıfır raporlanıyordu. **Tek yazıma
   indirilmeli.**

## Yapmadıklarım

- Migration eklemedim (yukarıdaki gerekçe). Numara çakışması da olmadı.
- `apps/studio/` altına hiç yazmadım (salt okunur).
- Paralel ajanların yollarına dokunmadım (`/onboarding`, `/repo-policy`,
  `/doc-template`, `/settings`, `/notify`, `/routing`).
- `packages/contracts` ve `packages/ports` dokunulmadı (donmuş).
- `/variants` sayfalama almıyor: katalog dokuz satır ve doğal bir üst sınırı
  var (rol × platform). Büyürse `PageQuery` hazır.
- `main`'e merge etmedim.
