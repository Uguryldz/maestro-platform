# RAPOR — Doküman şablonu, ayarlar, bildirim ve yönlendirme uçları

Branch: `worktree-agent-a1a81567d00848156` · base `528481d`

Studio'nun dört ekranı `{"error":"not_found"}` alıyordu. Dördü de artık canlı veri
okuyor; kanıtlar aşağıda gerçek Postgres + kaynaktan çalışan BFF + tarayıcı ile.

## Uçlar

| Uç | Rol | Ne yapar |
|---|---|---|
| `GET /doc-template` | admin, tech-lead | Yüklü `.docx`, taranan yer tutucular, bölüm eşlemesi, üretilen belgeler |
| `POST /doc-template` | **admin** | Kurumsal `.docx` yükler — yeni **sürüm**, üzerine yazmaz (M83) |
| `GET /doc-template/versions/:v/file` | admin, tech-lead | Bir sürümün baytları; pinlenmiş koşu buradan okur |
| `GET /settings` | admin, tech-lead | Bağlantılar (env + probe) ve bildirim sürücüleri |
| `PUT /settings` | **admin** | M71 parametreleri — `putParam` üzerinden, guarded olan öneri olur |
| `GET /notify` | admin, tech-lead | Hatırlatıcı merdiveni, delegasyon, bekleyen kapılar |
| `PUT /notify` | **admin** | `escalation.ladder` + `notify.routing` |
| `GET /routing` | admin, tech-lead | Bağlı Jira projeleri + veri sınıfı yönlendirme politikası |
| `PUT /routing` | **admin** | `dataclass.policy` — **guarded**, dört göz ister |

Okuma iki role açık, **yazma yalnız admin**: `.docx` her belgenin antetini
belirler, bu bir doküman sahibi kararıdır. Her yazma `assertWritable` ile
kill-switch'e tabi.

## Yazılan dosyalar

**BFF** — `doc-template-service.ts` (sürümleme/audit), `doc-template-scan.ts`
(docx okuma/tarama), `docx-zip.ts` (bağımlılıksız zip okuyucu), `notify-service.ts`,
`routing-service.ts`, `routes/doc-template.ts`, `routes/settings.ts`,
`stores/{doc-template-memory,admin-memory,settings-env}.ts`.

**deploy** — `stores/doc-template.ts`, `stores/routing.ts`, **`stores/params-store.ts`**
(aşağıda), `bin/bff.ts` bağlantıları.

**db** — migration `0006_doc_template`: `DocTemplateVersion` (+3 CHECK) ve
`DocTemplateOutputRow`.

**locales** — 8 yeni `doctemplate.what.*` anahtarı, tr+en parite korundu (1387/1387).

## Yol boyunca bulunan üç gerçek kusur

**1. `params` hiç veritabanına bağlı değilmiş.** `bin/bff.ts` boş bir
`InMemoryParamStore()` veriyordu — hiç tanım yok. Installer'ın `Param`/`ParamVersion`
tablolarına yazdığı her operasyonel ayar BFF'e görünmezdi; parametre ekranı boş,
merdiven/routing/politika okunamaz durumdaydı ve yeniden başlatma operatörün
değişikliğini sessizce siliyordu. `PrismaParamStore` yazıldı. (Bekleyen dört-göz
önerileri hâlâ süreç-yerel: öneri, onaylayanı olmayan bir değerdir ve sürüm
tablosu tam olarak bunu reddeder — `VOLATILE_STORES`'ta beyan edildi.)

**2. `/routing` ekranı çöküyordu.** `appIds` döndürüyordum, `Routing.tsx`
`row.apps.length` okuyor. Ekranlar BFF arayüzüne karşı tiplenmediği için tüm
yığın temiz derlendi ve sayfa tarayıcıda `TypeError` ile patladı. Alan adı
düzeltildi; **dört ekranın okuduğu her alan adı artık testle çivilendi**
(derleyicinin göremediği dikiş).

**3. Merdivende çift React key.** Seed'lenmiş ladder'da 72. saatte iki adım var;
routing haritasından geçince aynı satıra dönüşüyorlar. Ekran `kind-afterHours`
ile key'liyor → duplicate-key hatası ve operatörün ayırt edemeyeceği iki özdeş ok.
Aynı saatteki rung'lar artık birleştiriliyor (kanallar birleşir, düşmez).

Üçü de **tarayıcıda açarak** bulundu, testle değil — bu yüzden üçü de artık
regresyon testine sahip.

## Kanıt — gerçek Postgres, kaynaktan BFF

Kendi konteynerim (`maestro-doctpl-a1a81567`, port 55442, iş bitince kaldırıldı).
`uinfra-postgres` kullanılmadı.

```
migrate deploy      → 0006_doc_template uygulandı
\d DocTemplateVersion → 3 CHECK canlı (version>0, content non-empty, sizeBytes=octet_length)
login ayse.kaya@bank  → 200, roles ["viewer","admin"]
```

**Gerçek `.docx` yükleme** (`docx` paketiyle üretildi; `file` çıktısı
"Microsoft Word 2007+"):

```
POST /doc-template  → HTTP 201, v1, sizeBytes 8800
  bulundu : {{baslik}} {{ticket}} {{kosu}} {{kunye}} {{govde}} {{bolum:1}} {{bolum:2}}
  eksik   : {{sablon_surumu}} {{onay_tablosu}}     ← tarama eksikleri bildiriyor
  stiller : "Kurum Başlık", "Kurum Gövde", Heading 1-6 …  ← dosyadan okundu
GET /doc-template/versions/1/file → 200, cmp ile BYTE-IDENTICAL
```

Bayt-aynılığı M103r'nin sözü: kurumun kapağı/logosu/stilleri hiçbir şey
yeniden serileştirmediği için sağ kalıyor.

**Reddedilenler** (hiçbiri saklanmadı):

```
%PDF renamed .docx  → 400 doc_template_not_docx {reason:"not_a_zip"}
gerçek zip, Word değil → 400 {reason:"archive has no word/document.xml (1 entries)"}
kırpılmış .docx     → 400 {reason:"no end-of-central-directory record"}
```

İkincisi önemli: `PK\x03\x04` kontrolü dosya adını değiştiren herkesin geçtiği
4 bayt; arşiv gerçekten açılıyor.

**Sürümleme (M83)** — v2 yüklendi, v1 hem tabloda hem indirilebilir durumda kaldı.
Yeniden başlatmadan sonra da okundu (durabilite).

**Diğer uçlar:**

```
GET /settings → 200  (SIEM "unconfigured", identity local/bcrypt, yalnız Vault referansları)
GET /notify   → 200  (24s Jira → 72s → 168s delegasyon → 336s insana rapor)
GET /routing  → 200  (5 gerçek Jira binding + veri sınıfı politikası)
PUT /settings (unguarded) → applied, ParamVersion v2 Postgres'te
PUT /routing  (guarded)   → pending  ← dört göz; tek kişi gizli veriyi buluta yönlendiremez
kill-switch açıkken yazmalar → 409, okumalar → 200
kimliksiz dört uç → 401
```

## Tarayıcı kanıtı

Studio (7443) → BFF (7442), gerçek giriş. Dört ekran gezildi, sayfa metni
programatik olarak kontrol edildi:

```
/doctemplate  "Doküman şablonu (Word)"    yayında-değil: false  crash: false
/settings     "Ayarlar & bağlantılar"     yayında-değil: false  crash: false
/notify       "Bildirim & eskalasyon"     yayında-değil: false  crash: false
/routing      "Jira bağlantısı & eşleme"  yayında-değil: false  crash: false
konsol: 0 ERROR
```

Ekranlarda gerçek veri: `sablon-v2.docx v2`, dosyadan okunan stiller, yer tutucu
tablosu ("bulundu"/"şablonda yok"), merdiven okları, beş Jira projesi.

## Testler

Gate **yeşil, exit 0, 60/60**. Repo geneli 4147 test. BFF 443 (base 438 → +73 yeni
test, 5 dosya: `doc-template`, `docx-zip`, `settings`, `notify` + fixture).

Testler gerçek `.docx`'lerle çalışıyor (`docx` paketinin packer'ı) — elle
kurulmuş baytlar bu kontrolün ne yaptığını kanıtlamaz. Ağ çağrısı yok.

## ARAYÜZ İSTEKLERİ

1. **`AuditAction`** (`@maestro/contracts`, donmuş) — `DOC_TEMPLATE_UPLOADED` yok.
   Şimdilik `PARAM_CHANGED` + `doc-template:<v>` subject kullanılıyor; doğru ama
   denetçi "anteti kim değiştirdi" diye filtreleyemiyor.
2. **`PendingParamChange` tablosu** — öneri, onaylayanı olmayan bir değer; sürüm
   tablosunun CHECK'i bunu reddediyor, dolayısıyla öneriler süreç-yerel. Değer
   hiç uygulanmadığı için güvenlik açığı değil, ama bir bankanın kalıcı bekleyeceği
   durum.

## Yapmadıklarım

- `apps/studio/` altına hiç yazılmadı.
- **Belge üretimi**: `packages/publish` zaten yapıyor. Buradaki iş şablonun
  *yönetimi*. Üretilen belgeleri `DocTemplateOutputRow`'a yazan taraf publish
  akışına ait — tablo ve okuma yolu hazır, yazıcı bağlanmadı, o yüzden ekranın
  "Son üretilen belgeler" kartı boş.
- `/settings` bağlantıları **probe'lanmıyor**: `checkedAt` null, durum endpoint
  varlığından türüyor. Health reader paylaşılıyor ama bu bağlantılar için probe
  yok — uydurma "connected" yerine olanı söylüyor.
- Delegasyon zinciri yalnız delegate rung'ının sabit `to` listesinden okunuyor;
  tarih aralıklı vekil kaydı (ekranın alt yazısının ima ettiği) ayrı bir iş.
- Kill-switch mağazası hâlâ süreç-yerel (benim işim değil, `VOLATILE_STORES`'ta).
