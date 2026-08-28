# MAESTRO — İnşa Planı: Alt Ajanlarla Bölerek Yazım

> masterplan.md §4'ün yürütme detayı. "Başla" onayından sonra bu plan işler.
> İki hedefe göre tasarlandı: **① çalışırlık kanıtla teslim** ② **API timeout'a dayanıklılık**.

## 0. İki hedefin mühendislik karşılığı

**"%100 çalışma"** — mutlak garanti dünyada yok; garanti edilebilen şu: hiçbir paket
"bitti" sayılmaz **kanıt** olmadan. Kanıt = derlenir + lint + kendi testleri yeşil +
bağımsız doğrulayıcı ajanın onayı + dalga sonunda kök entegrasyon testi yeşil.
v1'in ölüm sebebi (parçalar tek tek makul, bütün hiç çalışmadı) bu zincirle sınıfça kapanır.
Gerçek Jira/ADO'ya bağlı duman testleri erişim gelince koşar — o güne kadar contract
testler kayıtlı gerçek yanıt fikstürleriyle çalışır (bkz. §6).

**"API timeout olmasın"** — timeout tek dev üretimin hastalığıdır. Bu planda:
- Hiçbir ajan tek seferde büyük çıktı üretmez; her paket **küçük adımlarla dosyaya yazar**
  (her adım bir tool çağrısı — kesilirse diskteki iş kaybolmaz).
- Her paket **checkpoint commit**'lidir; ajan ölürse yenisi `git log` + rapor dosyasından devam eder.
- Paket boyutu tavanı: ~600-1200 satır üretim kodu + testleri. Daha büyüğü pakete bölünür.
- Ajanlar **arka planda paralel** koşar; ben (orkestratör) sonuçları toplarım.
- Uzun koşan işler (test, build) ajan içinde komuttur, LLM üretimi değildir — timeout riski taşımaz.

## 1. Roller

| Rol | Kim | Görev |
|---|---|---|
| **Orkestratör** | ben (ana oturum) | Temel katmanı bizzat yazar (§3 Dalga 0), paket speclerini üretir, alt ajanları başlatır, entegrasyonu yapar, dalga kapısını ben koşarım |
| **Builder** (Opus) | paket başına 1 | Spec'e göre paketi yazar; kendi testlerini koşup yeşil görmeden dönemez |
| **Verifier** (Opus) | paket başına 1, builder'dan BAĞIMSIZ | Kodu görmeden önce spec'i okur; sonra derler, testleri kendi koşar, v1-hata-listesiyle düşmanca inceler (§5) |
| **Entegrasyon kapısı** | orkestratör | Dalga sonunda kökten `turbo run lint typecheck test` + akış testi; kırmızıysa sonraki dalga AÇILMAZ |
| **Uğur** | sen | Aşama sonu demoları onaylar (M40a) — ajan kapısı değil, insan kapısı |

## 2. İşçi ajan sözleşmesi (her pakete aynı protokol)

**Girdi (spec paketi):** paketin amacı · bağımlı arayüzler (`contracts`/`ports` — SALT OKUNUR) ·
kabul kriterleri · test fikstürleri · yasaklar.
**Kurallar:**
1. `packages/contracts` ve `packages/ports`'a DOKUNULMAZ; arayüz değişikliği ihtiyacı → rapora yazılır, orkestratör karar verir (tek elden — arayüz kayması v1 hastalığıdır).
2. Yeni bağımlılık eklemek rapora gerekçeyle işlenir; orkestratör onaylamazsa geri alınır.
3. Her mantık dosyasına test; "test sonra yazılır" yok.
4. Dönmeden önce: `pnpm -F <paket> lint && typecheck && test` — üçü yeşil değilse dönmek yasak; çözemiyorsa "TAKILDIM + neden" raporuyla döner.
5. Çıktı raporu (paket kökünde `RAPOR.md`): ne yapıldı · test özeti · varsayımlar · arayüz/bağımlılık talepleri.
**Ret döngüsü:** Verifier bulgu bulursa AYNI builder bulgularla devam eder (bağlam korunur);
3 turda kapanmazsa orkestratör devralır. (Evet — Maestro'nun kendi M54 kuralı, kendi inşasına uygulanıyor.)

## 3. Dalga planı (bağımlılık sırası + paralellik)

**Kural: contract-first.** Tüm ajanlar aynı donmuş arayüzlere yazar; bu yüzden Dalga 0'ı ben yazarım, paralellik ondan sonra başlar.

### Dalga 0 — Temel (orkestratör, bizzat; delege edilmez)
Monorepo iskeleti (pnpm+turbo+CI) · `contracts` (tüm Zod şemaları) · `ports` (tüm arayüzler) ·
`config` (Zod'lu env+parametre yükleyici) · test altyapısı (fikstür düzeni, mock-LLM, `TestWorkflowEnvironment` kalıbı) · `db` şema taslağı.
**Kapı:** kök build+test yeşil; arayüzler DONDU.

### Dalga 1 — Çekirdek paketler (8 paralel builder + 8 verifier)
| Paket | İçerik özü |
|---|---|
| `db` | Prisma şema+migration+seed (WorkflowRun, StepEvent, Journal, Variant, RoutingRule/Binding, Param, AuditLog). **Seed maketteki veri setidir**: 5 uygulama + repo kartları, 4 bağlı Jira projesi + kuralları, 22 ticket (kapıda/çalışan/hatalı/kapanmış dağılımıyla), defter kayıtları, imzalı kapı kararları, audit zinciri — v1'den veri TAŞINMAZ, Studio ilk açılışta dolu gelir |
| `adapter-jira` | DC istemci · webhook verify (raw-body) · yorum/label/assign · komut parse (M46/M102) |
| `adapter-ado` | çift-mod istemci · repo/branch/PR/threads · Service Hook parse (M11-M13) |
| `llm-gateway` | abonelik havuzu + kota pencere takibi + kuyruk (M55) · 4 API sürücüsü · politika/rate-limit |
| `storage` | s3-compat + pg-blob + opsiyonel Object Lock (M5/M57) |
| `secrets` | SecretPort: vault + env-file (M80) |
| `pii` | maskeleme çekirdeği + ReverseMap (M20; v1'den evrilir, entegrasyon hatası düzeltilerek) |
| `audit` | hash zinciri + günlük anchor + CEF export (M33) |

### Dalga 2 — Yürütme katmanı (6 paralel)
`runners/docker-linux` (hardened profil + cache mount) · `execution` (Agent SDK oturum başlat/resume/bootstrap) ·
`memory` (journal + yaşayan özet + session dosyaları — M30) · `notify` (teams/smtp/jira/slack — M45) ·
`publish` (jira/confluence/repo-docs — M47) · `scanners` (gitleaks/semgrep/trivy sarmalayıcı, fail-closed — M27)

### Dalga 3 — Beyin + kapılar (orkestratör-ağır; 4 paket)
`workflows` (Temporal 15 adım + kapılar + fan-out + sinyaller — aktiviteler alt ajanlara, **workflow iskeletini ben yazarım**; en kritik paket) ·
`bff` (webhook uçları + REST + auth) · `mcp-servers` (jira/ado/workspace + **maestro-mcp** — M37/M101) · ajan rolleri (intake/analyst/reviewer promptları + şema doğrulama — M43)

### Dalga 4 — Yüzey (paralelliğin en genişi)
`studio` — **maketteki 32 ekran spec'tir**: ekran başına/küme başına bir builder (8-10 paket; mock HTML'i spec olarak alır, Refine+gerçek BFF'e bağlar) · `runner-agent` (win/mac daemon) · `deploy` (compose+Dockerfile'lar) · `docs`

### Entegrasyon kilometre taşları = masterplan aşamaları
Dalga 1 ortası → **Aşama 0 demo** (kısaltılmış akış, mock adaptörlerle uçtan uca; erişim geldiyse gerçek duman) →
Dalga 2-3 → **Aşama 1 demo** (15 adım + hafıza + audit) → Dalga 4 → **Aşama 2-3 demoları**.
Her demo M40a gereği SANA gösterilir; onayın olmadan sonraki dalga başlamaz.

## 4. Paralellik ve çakışma önleme
- Her builder **kendi worktree'sinde** çalışır (dosya çakışması imkânsız); merge'i orkestratör yapar.
- Paketler arası tek temas noktası donmuş arayüzler olduğundan merge çatışması yapısal olarak nadirdir.
- Aynı anda en fazla ~8 builder (doğrulayıcılarıyla ~16 ajan); kuyruk orkestratörde.

## 5. Verifier'ın v1 kontrol listesi (her pakette zorunlu)
□ Ölü yol var mı — yazılmış ama hiçbir yerden çağrılmayan fonksiyon/mod?
□ Fail-open var mı — doğrulama hatasında sessiz geçiş?
□ Halüsinasyon entegrasyon — çağrılan uç/alan gerçekten fikstürde var mı?
□ Test gerçek mi — assert'süz/tautolojik test, gevşetilmiş assertion?
□ ID/anahtar tutarlılığı — üreten ile tüketen aynı anahtarı mı kullanıyor (v1'in CI-gate ölümü)?
□ Auth — her yeni uç kimlik doğruluyor mu?
□ Spec dışına taşma — istenmeyen özellik/bağımlılık eklenmiş mi?

## 6. Gerçek-sistem sınırı (dürüst kapsam)
Erişim (Jira/ADO adres+hesap, LLM anahtarı) gelmeden ajanlar **kayıtlı gerçek yanıt fikstürleri** +
mock sunucularla doğrular; bu, kodun %95 doğruluk sınırıdır. Kalan %5 (kurum proxy'si, sertifika,
sürüm farkları) erişim günü Aşama-0 duman testinde kapanır — bu yüzden hazirlik.md A listesi erken istenir.

## 6b. D-Dalgası — Doküman üretimi (kod ÖNCESİ çalıştırılabilir)
"Başla" kod onayıdır; doküman üretimi ondan bağımsız, İSTENDİĞİ AN başlar. Aynı model:
doküman başına builder+verifier çifti; kaynak = masterplan M1-M102 + diyagramlar + maket.
Paketler: mimari tasarım (ARB) · güvenlik mimarisi · iş analizi & kapsam · kurulum & gereksinim ·
test stratejisi · runbook taslağı · yol haritası. Verifier kontrolü: her iddia bir M-kararına
dayanıyor mu (uydurma özellik yasak), çelişki var mı, hedef kitleye uygun dil mi.
Çıktı: Markdown kaynak → PDF (headless tarayıcı) + Word (pandoc/python-docx) + Confluence-import
uyumlu HTML. Confluence'a otomatik yükleme kurum erişimi gelince (maestro-svc); o güne kadar
"tek tıkla import" dosyası teslim edilir. Platform tarafında kalıcı karşılığı: M47 + M103.

## 7. Sayılar
~38-42 iş paketi · paket başına 1 builder + 1 verifier · tepe eşzamanlılık ~8+8 ·
tavan ~1200 satır/paket · her dalga sonu tek entegrasyon kapısı · 4 insan demosu (M40a).
