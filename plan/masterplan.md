# MAESTRO — Ana Plan (Master Plan)

> **Proje:** Maestro — finans kuruluşu içi, Jira-yönetimli, AI destekli SDLC otomasyon platformu.
> **Sürüm:** 1.1 — **KİLİTLİ karar seti, açık soru YOK.** (1.1: maket incelemesi + 86 soruluk karar turu → M44–M98 eklendi, 2026-08-07)
> **Tarih:** 2026-08-04 (1.0) · 2026-08-07 (1.1)
> **Soy:** Orkestra v1 (kod analizi yapıldı, dersleri alındı) → Orkestra v2 tasarım turu (`../../plan/v2/projectplan-v2.md`) → **Maestro** (bu doküman, öncekileri kapsar ve geçersiz kılar).
> **Lisans/Mülkiyet:** © 2026 **Uğur Yıldız** — tüm hakları saklıdır. İlk commit'te repo köküne bu ibareyle tescilli `LICENSE` dosyası konur; her kaynak dosyada kısa telif başlığı zorunlu değildir, `LICENSE` + `package.json` `"license": "SEE LICENSE IN LICENSE"` yeterlidir (M40).
> **Altın kural:** Uğur **"başla"** demeden tek satır ürün kodu yazılmaz. "Başla"dan sonra da v1'in "tek uçuş" hatası tekrarlanmaz: her aşama sonunda çalışır demo + onay (M40a).
> **Diyagramlar:** [`diagrams/`](diagrams/) — maestro-system, -flow, -llm, -ado, -runner, -hafiza, -tumkapsam (mermaid), -senaryolar (ek geliştirme vs yeni proje, mermaid)

---

## 0. Tek Paragraf Özet

Jira'da açılan bir ticket, Temporal üzerinde koşan dayanıklı bir iş akışını başlatır; düşünen AI roller (Vercel AI SDK, structured output) analiz/inceleme üretir, yapan AI roller (Claude Agent SDK) platforma uygun runner'da (Linux container / Windows VM / Mac mini) kodu gerçekten yazar, derler, test eder ve Azure DevOps'ta PR açar; altı insan onay kapısı (AD-grup doğrulamalı, süresiz bekleyen, SoD'lu) süreci yönetir; her adım hash-zincirli denetim iziyle ticket defterine yazılır, ajan bağlamı hiçbir zaman kaybolmaz (journal + yaşayan özet + session resume) ve süreç sonunda tek arşivlenebilir kanıt paketi üretilir. Tüm dış bağımlılıklar (SCM, CI, LLM, depolama, runner) port/sürücü mimarisiyle değiştirilebilir.

---

## 1. Kapsam

### 1.1 Hedef uygulama portföyü

| Uygulama | Stack | Runner | Bağımlılık cache |
|---|---|---|---|
| ugurpay | Next.js | `docker-linux` (node imajı) | npm store |
| ugurweb | React | `docker-linux` (node imajı) | npm store |
| ugurmobil-android | Kotlin/Gradle | `docker-linux` (Android SDK imajı) | Gradle |
| ugurmobil-ios | Swift/Xcode | `agent-macos` (Mac mini) | SwiftPM/Pods + DerivedData |
| ugurmasaüstü | C#/.NET | `agent-windows` (Win Server VM) | NuGet |

### 1.2 Kapsam DIŞI (bilerek)
Çoklu Git sağlayıcı (Bitbucket/GitHub/GitLab — port hazır, sürücü yazılmaz), multi-tenant, ticari paketleme/lisanslama sistemi, Atlassian Marketplace, epic-level workflow (**not:** çok platformlu işler ana+alt ticket modeliyle KAPSAMDA — M41; kapsam dışı olan yalnız epic/inisiyatif seviyesi portföy yönetimi), otomatik knowledge öğrenme (feedback portu veri toplar, işleme v2), gerçek iOS cihaz/TestFlight (simulator-only), Prometheus/Grafana tam gözlemlenebilirlik (Aşama 3 sonrası), air-gap paketleme.

---

## 2. KARAR KAYDI — M1–M40 (tamamı kilitli)

### Çekirdek platform
| # | Karar | Gerekçe |
|---|---|---|
| M1 | **Temporal (self-hosted)** — orkestrasyon | 15-20 gün uyuyan insan-kapılı akış + sinyal + `TestWorkflowEnvironment`; Restate/DBOS/Camunda/custom değerlendirildi, elendi |
| M2 | **TypeScript monorepo** — pnpm 10 + Turborepo, Node 24 LTS | Tek dil, uçtan uca Zod tipleri |
| M3 | **PostgreSQL 16+** — tek RDBMS (workflow meta, StepEvent, variant, audit, journal index) | |
| M4 | **Redis** — kapasite semaforu, rate limit, kısa ömürlü cache | |
| M5 | **`StoragePort` (BYOS)** — S3-uyumlu sürücü (varsayılan) + Postgres-BLOB sürücü (küçük kurulum). MinIO/SeaweedFS yalnız dev-compose varsayılanı, ürün bağımlılığı değil. pgvector YOK | AGPL sürtünmesi + kurumda mevcut S3 + OpenShift/ODF uyumu |
| M6 | **Vault** — tüm secret'lar, kısa ömürlü git kimlikleri; Aşama 1'de gerçekten devrede; `change-me` türü default secret ile süreç ayağa kalkmaz (eksik secret = başlatma hatası) | v1'in "dokümante ama yok" hatası |
| M7 | **Fastify 5 BFF** — tek veri kapısı; Studio DB'ye doğrudan erişmez; tüm uçlar auth'lu | v1'in auth'suz ikinci CRUD felaketi sınıfça kapalı |
| M8 | **Next.js + Refine + Auth.js v5 Studio** — variant/knowledge/eval + izleme; kimlik MVP'de lokal kullanıcı (bcrypt + parola politikası + oturum 8h), **Aşama 2'de AD/LDAP bağlanır** (karar: LDAP bind; kurum OIDC sağlarsa Auth.js provider değişimi tek dosya) | Eski açık soru #5 kapandı |
| M9 | **Prisma** ORM (güncel) | Devamlılık; Drizzle değer katmıyor |
| M10 | **Zod 4** — tüm kontratlar; ajan I/O şemaları `packages/contracts`'ta tek kaynak | |

### SCM / CI — Azure DevOps
| # | Karar | Gerekçe |
|---|---|---|
| M11 | **ADO çift-mod adaptörü**: tek `ScmPort` sürücüsü, `mode: server \| services` konfigü. Server → PAT + kurum içi Service Hooks; Services → Entra ID service principal + DMZ'den webhook. Contract testler iki modda da koşar | Eski açık soru #1: "hangisi" sorusu silindi — ikisi de desteklenir, kurulumda seçilir |
| M12 | **CI = ADO branch policy + build validation.** Maestro pipeline tetiklemez; policy tetikler, `build.complete` Service Hook → Temporal sinyali. PR başına zorunlu: min 1 insan reviewer, force-push kapalı, build validation | Bankanın kendi kontrolü otorite kalır |
| M13 | PR akışı: draft → active; açıklamada analiz özeti + kanıt linki; `[AI]` commit prefix + `Co-Authored-By`; PR thread'leri = 12b yorum döngüsü (thread status API) | |
| M14 | **Ticket→repo eşleme**: `RoutingRule` (Jira project/component → ADO project/repo/pipeline + platform profili). Eşleşme yoksa akış intake'te "repo eşlemesi yok" hatasıyla insan atamasına düşer — sessiz varsayılan yok | |
| M15 | Webhook güvenliği: raw-body HMAC/secret başlık + IP kısıtı + timestamp-nonce replay koruması; **her ortamda fail-closed** | |

### LLM — tam modüler hibrit
| # | Karar | Gerekçe |
|---|---|---|
| M16 | **`LlmPort` = LLM Gateway**; 4 sürücü İLK GÜNDEN yazılır: `anthropic-direct`, `aws-bedrock`, `gcp-vertex`, `openai-compat` (vLLM/on-prem). Aktif sürücüler + rol→model eşlemesi **tamamen konfigürasyon** | Eski açık soru #2: "hangisi" değil "hepsi"; geçiş = konfig değişikliği |
| M17 | Düşünen roller: **Vercel AI SDK** `generateObject` + Zod (provider-bağımsız). Yapan roller: **Claude Agent SDK** (`ExecutionAgentPort` arkasında) — Claude gerektirir | |
| M18 | **Veri sınıfı politikası konfigüre edilebilir** (`routing.yaml`): sınıf→arka uç eşlemesi + `gizli` sınıf için `onprem_yoksa: degrade_ai_assist \| block \| masked_cloud` seçeneği (kurum uyum ekibi seçer; varsayılan `degrade_ai_assist`). GPU yoksa on-prem sürücü pasif durur, GPU gelince konfigle açılır | Eski açık soru #3: "en esnek" — davranış koda değil politikaya yazıldı |
| M19 | Gateway korumaları: atomik token-bucket rate limit (Redis Lua), per-workflow + aylık bütçe (TEK doğruluk kaynağı; %80 uyarı, %100 stop), fiyat tablosu konfigde, **bilinmeyen model = hata** (sessiz fallback yok), maskeli çağrı logu, prompt cache | v1'in 3× fiyat / sessiz fallback hataları |
| M20 | **PII maskeleme LLM sınırında** (alan + regex, ReverseMap yalnız kullanıcıya dönen metinde); artefakt deposuna **maskeli** hali yazılır | |

### Yürütme — runner matrisi + sandbox
| # | Karar | Gerekçe |
|---|---|---|
| M21 | **Runner matrisi**: `docker-linux` (ephemeral hardened container) + `agent-macos` (Mac mini havuzu) + `agent-windows` (ayrık Win Server VM havuzu — ADO agent'larıyla ORTAK DEĞİL). Tek `RunnerPort`, üç sürücü | Eski açık soru #9 kapandı: ayrık havuz |
| M22 | mac/win runner'larda **Maestro Runner Agent** daemon'u platforma **outbound** gRPC/WebSocket bağlanır; içeri port açılmaz | Banka ağ onayı |
| M23 | Linux sandbox profili: read-only rootfs, cap-drop ALL, no-new-privileges, non-root, tmpfs workspace, **mem/CPU/pids limitleri**, **prosesi gerçekten öldüren timeout**, egress yalnız proxy. Aşama 3'te gVisor (runsc) runtime | v1 profil + eksikleri |
| M24 | **Docker yetkisi yalnız Runner Servisi'nde** (ayrı servis, dar API); worker'da docker.sock asla | |
| M25 | mac/win izolasyon telafisi: iş başına ephemeral kullanıcı+workspace, dar yerel haklar, MDM/EDR, aynı egress kuralları, iş sonu audit'li temizlik. **Kabul edilen risk** olarak kayıtlı | |
| M26 | **Egress proxy**: kurum dışına TEK çıkış; allow-list (LLM uçları + paket registry'leri + ADO Services modundaysa ADO); tüm çıkışlar loglu | |
| M27 | Güvenlik taraması 6b: gitleaks + semgrep + trivy, **dijest-pinli imajlar**, **fail-closed**, sonuçlar kanıt paketine | v1'de hiç çağrılmıyordu |
| M28 | iOS test kapsamı **MVP'de simulator-only**; imzalama/TestFlight kapsam dışı (kapsam DIŞI listesinde) | Eski açık soru #10 kapandı |

### Süreklilik — hafıza + cache
| # | Karar | Gerekçe |
|---|---|---|
| M29 | İnsan kapıları **süresiz bekler** (durable timer); kademeli hatırlatıcı 24h Jira → 72h Slack → 7g backup delegasyonu; otomatik ret YOK; `continueAsNew` hijyeni | 15-20 gün doğal durum |
| M30 | **Ticket hafızası**: ① append-only Ticket Defteri (PG index + StoragePort içerik) ② her adım sonunda ucuz modelle güncellenen Yaşayan Özet ③ Agent SDK session dosyaları çalışma alanında → dönüşte **resume**; workspace yoksa journal+özet ile bootstrap. Her ret/CI döngüsü önceki oturumun devamı | Sıfır bağlam kaybı |
| M31 | **3 katman cache**: ① bağımlılık (repo+lockfile) ② ticket çalışma alanı (klon+build+session; ticket ömrünce; kapanış/cancel'da audit'li silme) ③ knowledge+prompt cache. Katman ② runner diskinde **şifreli** (Linux: LUKS/fscrypt'li volume; Win: BitLocker'lı disk; mac: FileVault'lu disk — dizin erişimi iş bazlı ephemeral kullanıcıyla sınırlı) | Eski açık soru #11 kapandı |

### Yönetişim — banka sertleştirmesi
| # | Karar | Gerekçe |
|---|---|---|
| M32 | **SoD matrisi**: üreten (AI servis hesabı) ≠ onaylayan ≠ merge eden; kapı onayları AD/Jira grup üyeliğinden doğrulanır; 4-göz çiftleri (PO≠TL, TL≠reviewer) workflow'da hard-check | |
| M33 | **Audit**: tek yazarlı (yalnız worker aktivitesi) SHA-256 hash zinciri + günlük anchor (zincir başı ayrı yere imzalanır); **SIEM export = CEF formatlı syslog + dosya düşümü** (kurumdaki hedef sistemden bağımsız çalışır; Splunk/QRadar toplayıcıları bunu zaten okur) | Eski açık soru #6 kapandı: format-standart çözümü |
| M34 | **Kanıt paketi** (adım 13): analiz + diff + test raporu + tarama + imzalı onay zinciri + maliyet → tek arşiv (StoragePort); **change yönetimi bağlantısı = Jira**: paket linki ticket'ta kalır, ticket kurumun change kaydına referans verilir (ServiceNow benzeri ayrı sistem entegrasyonu kapsam dışı, gerekirse WorkPort'a sürücü eklenir) | Eski açık soru #7 kapandı |
| M35 | **Fail-closed ilkesi** her doğrulama noktasında: imza, tarama, grup üyeliği, politika — doğrulanamıyorsa akış durur, sessiz geçiş yok | |
| M36 | 4 work mode + `/ai-takeover` `/ai-handoff` + 11 Jira komutu (yetki + state + idempotency doğrulamalı); insan yollarında ilerleme sinyali ADO webhook'undan gelir | v1'in ölü prId beklemesi kapalı |
| M37 | **MCP-first araç erişimi**: Agent SDK oturumlarına `jira-mcp`, `ado-mcp`, `workspace-mcp` (ticket defteri oku/yaz) sunulur; MCP sunucuları da yetki-filtreli. Çekirdek portlar TS adaptör kalır | |
| M38 | Variant seti: `web · mobile-ios · mobile-android · desktop · backend`; knowledge tek deposu StoragePort; prompt caching zorunlu; golden-ticket eval Studio'da | |
| M39 | Ölçek: role-based Temporal task queue + havuz semaforları; pilot 10-30 ticket/gün, mimari 100+ eşzamanlı; backpressure'da Jira'ya "queued" bildirimi | |
| M41 | **Çoklu platform ek geliştirme = ana ticket + alt ticket fan-out**: analizin etki matrisi birden çok platforma dokunuyorsa Maestro Jira'da platform başına alt ticket açar; her alt ticket kendi repo/runner/kapı/PR'ıyla bağımsız Maestro akışıdır (tek ticket-tek repo ilkesi korunur); bağımlılık sırası analizden gelir (ör. önce API, sonra istemciler — Done sinyaliyle tetiklenir); ana ticket koordinatör workflow'dur, tüm alt ticketlar Done olunca birleşik kanıt paketiyle kapanır. Bkz. `diagrams/maestro-senaryolar` | İşlerin çoğu çok platformlu ek geliştirme |
| M42 | **Yeni proje (greenfield) akışı**: repo yoksa ek adımlar — AI mimari önerisi → **insan mimari onayı** (yeni repo açma yetkisi insanda) → otomatik kurulum (ADO repo + branch policy + `.maestro.yaml` + pipeline + RoutingRule) → Agent SDK iskelet oturumu (kurum starter şablonundan, build+smoke yeşil) → ilk PR = iskelet, normal kapılardan geçer → sonraki ticketlar ek geliştirme yoluna girer | "Yeni kredi uygulaması" senaryosu |
| M43 | **Analiz dokümantasyon standardı**: kurumun analiz şablonu (amaç, kapsam, etki matrisi, kabul kriterleri, ekran/API değişiklikleri, test yaklaşımı, risk/geri dönüş) knowledge pack'te **versiyonlu dosya**dır, Studio'dan yönetilir; analyst çıktısı şablon bölümlerine **Zod ile doğrulanır** — eksik bölüm = analiz kapıya gelmeden reddedilir (fail-closed); örnek analizler few-shot olarak şablonla birlikte verilir | Analizler standarda uyar, kişiye göre değişmez |
| M40 | **Mülkiyet/lisans**: © 2026 Uğur Yıldız, tüm hakları saklı; tescilli `LICENSE` ilk commit'te. **M40a — çalışma protokolü**: "başla" onayı olmadan kod yok; her aşama sonunda demo+onay; aşama çıkış kriteri gerçek sistemde gösterilmeden ilerlenmez |

## 2b. KARAR KAYDI — M44–M98 (karar turu, 2026-08-07)

> Kaynak: maketteki 12 tartışma maddesi + 74 yeni soru (`acik-sorular.md` envanteri) → Uğur'la tek tek karara bağlandı.

### Konfigürasyon mimarisi (üst ilke — birçok kararı etkiler)
| # | Karar | Gerekçe |
|---|---|---|
| M71 | **Ayarlar DB'de yaşar, Studio'dan yönetilir** (versiyonlu + audit'li parametreler): kapı setleri, eşikler, dil, coverage kuralı, eskalasyon merdiveni, SoD anahtarları, timeout'lar… `.maestro.yaml`'da YALNIZ repo'nun doğası gereği repo'da durması gerekenler kalır: build/test/lint komutları, `protected_paths`, platform profili ipuçları | Uğur: "bir çok ayarı maestro.yaml yerine UI'a parametre olarak koy, DB'de tutulsun" |
| M44 | **Eklenti-modül mimarisi + clean-room repo düzeni**: bildirim, yayınlama, kalite araçları vb. çekirdeğe değil eklenti sürücülerine yazılır; çekirdek yalnız port arayüzünü bilir. Repo bu ayrımı fiziksel olarak yansıtır (`packages/adapters/*` bağımsız, çekirdek onları import etmez — DI ile yüklenir) | Genişletilebilirlik + temiz oda ilkesi |

### Entegrasyon & bildirim
| # | Karar |
|---|---|
| M45 | **`NotifyPort` eklenti modülü** — sürücüler: `teams` (Adaptive Card) + `smtp` (e-posta) + `jira-comment` + `slack` (hazır, pasif). Aktif kanallar ve kanal→olay eşlemesi Studio parametresi |
| M46 | **Jira Data Center/Server** hedeflenir (PAT + webhook secret, wiki-markup/ADF farkları DC'ye göre); Cloud sürücüsü ileride WorkPort'a eklenebilir |
| M47 | **Analiz yayını çok-hedefli `PublishPort`**: `jira-comment` + `confluence-page` + `repo-docs` sürücüleri; hedef seti proje bazlı parametre — "hepsi olsun, esnek ve modüler" |
| M103 | **PublishPort'a `docx/pdf` render sürücüsü**: analiz dokümanı ve kanıt paketi özeti, Jira/Confluence'a ek olarak **Word (.docx) ve PDF** dosyası olarak da üretilebilir (şablon: kurum kapak/format standardı, knowledge'da versiyonlu); denetime/kurula dosya teslimi için. Aşama 2 kalemi |
| M109 | **Doküman kalite standardı + iki yeni varsayılan bölüm** (Uğur'un kendi hazırladığı referans belgeden, 2026-08-09): üretilecek analiz dokümanının hedef kalitesi `plan/referans/UiPath-Orchestrator-HA-Plani-v1.0.pdf` ile sabitlendi (künye tablosu, numaralı bölümler, koyu başlıklı karşılaştırma tabloları, altyazılı mimari şekiller, uyarı kutuları, kod blokları, kaynakça). Varsayılan analiz şablonuna iki bölüm eklenir: **"Kaynaklar"** (her iddia hangi dosya/repo kartı/knowledge dokümanı/ticket cümlesine dayanıyor — uydurma iddiayı yakalamanın en ucuz yolu, denetim gereği) ve **"Netleştirilecek açık maddeler"** (cevaplanmamış/ertelenmiş clarification maddeleri; PO onay verirken neyin açık kaldığını görür). Ayrıca docx/pdf sürücüsü etki matrisi · akış şeması · fan-out ağacını **SVG şekil** olarak üretip gömer (kaynak veri zaten yapılandırılmış; dış kütüphane gerekmez), altyazı `Şekil N — …` otomatik numaralı. Ayrıntı: `plan/referans/DOKUMAN-STANDARDI.md` |
| M108 | **Analiz şablonu Studio'da TASARLANIR** (M43'ün genişletilmesi, Uğur 2026-08-09): şablon artık yalnız yüklenen bir dosya değil, Studio'da **şablon tasarımcısı** ekranıyla kurulur — bölüm ekle/çıkar/sırala, her bölüme başlık + açıklama + AI'ye talimat + zorunlu/opsiyonel + beklenen biçim (serbest metin / madde listesi / tablo / matris), bölüm başına örnek metin (few-shot). Şablon **versiyonlu** (M83 pinleme aynen geçerli), önizlemeli, proje bazında seçilebilir. Analyst çıktısı bu tanıma göre Zod'a çevrilip doğrulanır — yani yeni bir bölüm eklemek kod değişikliği GEREKTİRMEZ. Dalga 4 (Studio) kalemi |
| M103r | **Analiz çıktısı Word/PDF olarak teslim edilir — kurumsal şablonla** (M103'ün revizyonu, Uğur 2026-08-09): "ileride" değil, birinci sınıf gereksinim. Kurum **kendi .docx şablonunu yükler** (kapak sayfası, antet/altbilgi, logo, stil tanımları, onay tablosu); Maestro analizi o şablonun içine yerleştirir ve `.docx` + `.pdf` üretir. Şablon Studio'dan yüklenir, versiyonludur, önizlenebilir. Kanıt paketi ve Jira'ya ek olarak: dosya indirme + PublishPort `docx`/`pdf` hedefleri. Şablon yüklenmemişse sade varsayılan kapakla üretilir (fail-open değil — üretim durmaz, ama Studio uyarır) |
| M107 | **Abonelik bağlantısı = yerel Claude oturumu** (M55'in uygulama kararı, Uğur 2026-08-08): `claude-sub` sürücüsü API anahtarı kullanmaz; kurulu **Claude Code CLI**'yi (kullanıcının aboneliğiyle bağlı) non-interaktif modda sürer ve `--resume` ile oturumu devam ettirir. Kota/pencere takibi ve havuz mantığı (M55) aynen geçerli. API sürücüleri (OpenRouter dahil, `openai-compat`) yalnız yedek/duman testi yoludur. Süreç çalıştırma enjekte edilebilir — testler çevrimdışı kalır |
| M105 | **Komut grameri güvenlik kuralı** (Dalga 1 doğrulamasından doğdu): argüman almayan komutlar (`/approve`, `/status`, `/ai-explain`, `/ai-start`, `/ai-takeover`) **yorumun tamamı** olmak zorundadır — ek metin varsa komut işlenmez, kullanıcıya uyarı yazılır. Gerekçe: analiz/yorum dili Türkçe (M59) ve olumsuzlama sonda gelir; "`/approve` etmiyorum" gibi bir yorum aksi halde kapıyı geçirirdi. Ayrıca **yorum düzenlemesi komut kaynağı değildir** (düzenleyen ≠ yazar → başkası adına onay; M32 SoD). BFF, tanınmayan/geçersiz komutta sessiz kalmaz, kullanıcıya mesaj yazar (M14) |
| M106 | **CI sinyali köken doğrulamalı** (Dalga 1 doğrulamasından doğdu): `build.complete` olayı yalnız `reason = pullRequest` ise ve build tanımı **{proje, repo, definition-id}** allow-list'inde ise kabul edilir; sinyal kökenini taşır ve workflow, koşunun `ApplicationRecord`'uyla eşleşmeyen sinyali reddeder. Webhook kimlik doğrulaması port imzasının parçasıdır — doğrulanmamış gövdeyi ayrıştırmak tip düzeyinde imkânsızdır. Aktif PR'ın önizleme merge commit'i **merge SHA sayılmaz** (yalnız `completed`) |
| M104 | **Dil havuzu mimarisi** (M59+M60'ın altyapı kararı): kullanıcıya dönük TÜM metinler — Studio arayüzü, bildirim şablonları, Jira yorum kalıpları, analiz bölüm başlıkları — merkezi **mesaj kataloğunda** yaşar; başlangıç TR + EN, **yeni dil eklemek = katalog dosyası eklemek** (kod değişikliği yok; hedef ileride ~4 dil). AI çıktı dili proje parametresidir (M71, DB'de); kod/commit/test adları her koşulda İngilizce kalır (M59). Katalog dosyaları Dalga 0'da `packages/contracts` yanında kurulur ki hiçbir paket metni koda gömmesin |
| M77 | **Kalite araçları opsiyonel sürücüler** (ilk aşamada zorunlu değil): SonarQube (ScanPort), **Fortify** (ScanPort — kurumda VAR), Artifactory/Nexus (registry + onaylı paket listesi kaynağı), Xray/Zephyr (test yönetimi). Port arayüzleri baştan, sürücüler ihtiyaç olunca |
| M80 | **`SecretPort`**: `vault` (varsayılan, dev-compose'da hazır) + `env-file` (dev); `cyberark` / `azure-keyvault` sürücüleri ileride — kurum ürünü belli olunca |
| M101 | **`maestro-mcp` — yerleşik yönetim MCP'si**: platformun kendisi de MCP ile yönetilir (BFF `/mcp` ucu, streamable HTTP; `packages/mcp-servers`'a 4. sunucu). Kimlik = çağıran kullanıcının kişisel token'ı; AI araçları o kullanıcının RBAC'ıyla çalıştırır, audit aktörü `ai-via:<kullanıcı>`. Kapsamlar: **read** (workflow durumu, journal, param, kota, runner sağlığı, bekleyen kapılar) · **operate** (workflow başlat, uygulama ata, work-mode değiştir, duraklat/sürdür, adım retry, kapı sahibine hatırlatma) · **admin-öneri** (param değişikliği → 4-göz kuyruğuna; kill-switch = çift onay). **Kapı onay/ret aracı YOK**: MCP bekleyen kapıyı listeler/özetler ama karar veremez — onay yalnız insan kanalından (Jira yorumu / Studio), M32 SoD böyle korunur |
| M102 | **Jira proje bağlama mekaniği**: kurulumda Jira admin **tek seferlik tek global webhook** tanımlar (issue created/updated + comment added; proje başına webhook/JQL bakımı yok) → BFF gelen olayı `JiraProjectBinding` listesine göre içeride filtreler (bağlı değil/pasif → sessizce düşürülür + sayaç). Bağlama tamamen Maestro tarafında: `JiraProjectBinding` DB kaydı (projectKey, tetikleme modu, eşleme kuralları, varsayılanlar, aktif/pasif) — M71 gereği versiyonlu+audit'li, Studio onboarding sihirbazından yönetilir. `maestro-svc` Jira izinleri: Browse + Add Comment + Edit Issue (label) + Assign + Create/Link Issue (fan-out) — workflow, özel alan, eklenti değişikliği İSTENMEZ (M72/M98 uyumlu). **Aktivasyon öncesi kuru koşum zorunlu**: son 20 ticket çekilir, eşleşme önizlemesi (kademe ①/②/③ dağılımı) gösterilir, admin görüp aktive eder. Proje bazlı pause (intake durur) ve unbind (geçmiş korunur) |

### Jira süreci
| # | Karar |
|---|---|
| M48a | **Tetikleme proje bazlı**: her Jira projesi `otomatik` / `opt-in` (label `maestro` veya `/ai-start`) modunda — Studio parametresi. Pilot varsayılanı opt-in |
| M50 | **Alt ticket tipi proje bazlı yapılandırılır**: sub-task / ayrı story+link / yalnız-Maestro-içi; varsayılan **ayrı story + "relates to" link** |
| M72 | **Kurum Jira workflow'una dokunulmaz**: ticket mevcut durumunda kalır, Maestro aşamayı **label** ile gösterir (`maestro:analiz`, `maestro:kapi-po`, `maestro:gelistirme`…) |
| M74 | **Assignee aşamaya göre değişir**: AI çalışırken servis hesabı, kapıda onay bekleyen kişi, devirde insan geliştirici |
| M75 | **Yorum düzeni**: kapı istekleri/sonuçları ayrı yorum; ara ilerleme tek DÜZENLENEN "▶ Maestro durum" yorumunda güncellenir — yorum spam'i yok |
| M96 | **Ana ticket kapanışı = PO onayı**: tüm alt işler Done olunca birleşik özet+kanıt paketi hazırlanır, PO "kapat" onayı verir |
| M98 | **Zorunlu Jira alanı dayatılmaz**; eksikleri intake ajanı sorar (2b). Kalite güvencesi şablon doğrulaması |
| M59 | **Dil karma**: analiz, Jira yorumları, kapı özetleri **Türkçe**; kod, commit, PR başlığı, test adları **İngilizce**. Parametreyle değiştirilebilir |
| M99 | **Ticket→uygulama eşleşmesi 3 kademe**: ① RoutingRule (Jira proje + component/label → uygulama kaydı) ② kural eşleşmezse intake AI ticket metninden aday uygulama önerir (güven skoruyla) — öneri analiz onay kapısında İNSANLA doğrulanır (PO/TL onayı eşleşmeyi de onaylar) ③ aday yoksa/çelişkiliyse akış durur → "atama bekleyen" kuyruğu; insan Studio'dan veya Jira `/ai-assign <uygulama>` komutuyla eşler. Sessiz varsayılan yok (M14 fail-closed korunur). Jira projesi ↔ uygulama **N:M** (ör. UGURMOB projesi → ios + android; component ayrıştırır) |
| M100 | **Uygulama Kaydı (Application Registry) + repo kartı**: her uygulama = ADO repo + platform profili + `.maestro.yaml` + **repo kartı** (modül/alan özeti, knowledge'da versiyonlu, ilk onboarding'de AI keşfiyle üretilir, her merge'te tazelenir). Analiz akışı: keşif oturumu BİRİNCİL uygulamanın repo'sunda çalışır; etki matrisi DİĞER uygulamaları klonlamadan repo kartlarından değerlendirir; matris >1 uygulama → onay sonrası fan-out (M41), çocuk ticketlar parent'ın Jira projesinde açılır ve uygulama ataması analizden yazılır (kural aranmaz) |

### SCM / dallanma
| # | Karar |
|---|---|
| M49 | **Trunk-based**: `main` + `feature/UGURPAY-123-kisa-ad`, **squash merge**, sürüm tag'i. Mobil store sürümleri için repo bazında `release/x.y` istisnası tanımlanabilir. GitFlow reddedildi (AI'ın uzun ömürlü develop ile rebase savaşı) |
| M48 | **Merge iki mod, proje bazlı**: `insan-merge` (varsayılan — TL basar) / `auto-merge` (tüm kapılar+CI yeşilse Maestro). Analizde hangi modda olduğu yazılır |
| M76 | **Reviewer ataması**: repo sahiplik tanımı (ADO required reviewers) + dokunulan dizine göre sahip bulma + meşgulse rotasyon; SoD çifti (reviewer ≠ üreten) hard-check |
| M84 | **Repo yapısı esnek**: varsayılan uygulama başına ayrı repo; RoutingRule **path filtresi** destekler → monorepo düzeni de çalışır |
| M85 | **Build bekleme**: platform başına timeout parametresi (linux 30dk / win 45dk / mac 60dk varsayılan) + timeout'ta 1 otomatik yeniden kuyruklama + webhook kaçarsa poll doğrulaması |
| M52 | **`protected_paths` deny-list** repo bazında (`.maestro.yaml`): AI korumalı yola diff üretirse akış durur, insana devir. Migration + secrets varsayılan korumalı |
| M53 | **Bağımlılık politikası**: onaylı liste içi serbest; liste dışı paket = öneri + TL onay kapısı; lockfile değişimi PR'da ayrıca işaretli |

### Onay kapıları
| # | Karar |
|---|---|
| M51 | **Risk-katmanlı kapı seti**: düşük→2 **onay kapısı** (TL analiz + PR), orta→4 (+PO +QA sonuç), kritik→5 (+QA senaryo = tam set). *Netleştirme (2026-08-09, doğrulayıcı bulgusu Y4):* eski metindeki "kritik→6" clarification beklemesini (2b) de sayıyordu; 2b bir **onay kapısı değil**, süresiz insan beklemesidir ve her kademede vardır. Onay kapısı sayısı 2/4/5, insan teması sayısı 3/5/6. Riski analiz belirler; PO yükseltebilir, DÜŞÜREMEZ; seçim audit'e yazılır. Onayların ana yolu **Jira yorumu** (`/approve`), Studio ikincil |
| M81 | **PO+TL paralel onay**; vekil = Studio'da tarih aralıklı **delegasyon kaydı** (audit'li); 7g otomatik delegasyon da bu kaydı kullanır |
| M54 | **Takılma koruması**: aynı kapıdan 3 ret VEYA aynı CI hatası 3 kez → ai-assist'e düşer, tüm bağlam+journal ile insana devir + Jira özeti. N parametrik |
| M73 | **Break-glass = insan-only**: acil işler Maestro DIŞINDA normal ADO yoluyla yapılır; Maestro yalnız olay sonrası retro-kayıt üretir. Tek-onaylı hızlı AI yolu reddedildi |
| M88 | **Eskalasyon tamamen parametrik**: merdiven adımları, kanalları, mesai/tatil takvimi Studio'dan kurgulanır; varsayılan sade 24s→72s→7g |
| M92 | **QA SoD anahtarı** (senaryo onaylayan ≠ sonuç onaylayan): parametre, varsayılan KAPALI |

### LLM — abonelik bağlantıları (önemli mimari ek)
| # | Karar |
|---|---|
| M55 | **Abonelik (subscription) sürücü sınıfı**: token-API pahalı → Claude/Gemini/Codex **abonelik hesapları** LlmPort'a ayrı sürücü tipi olarak girer. Maliyet takibi dolar değil **kota/pencere bazlı** (5 saatlik pencere, haftalık limit vb.). **Havuz + kota-farkında sıra**: birden çok hesap havuzda, gateway pencereyi izler, dolu hesabı pas geçer; hepsi doluysa iş kuyruğa girer, pencere açılınca devam (Temporal bekler), Jira'ya "kota bekleniyor" notu |
| M78 | **Model/persona değişikliği = admin önerir + ikinci yetkili onaylar (4-göz) + zorunlu eval koşumu**; regresyonda gerekçe şart; sürüm geçmişi + audit |
| M62 | **KPI paneli** (esnek widget'lar, son hali maket turunda): lead time, PR kabul oranı & ret turları, kota/maliyet tüketimi, otomasyon oranı |

### Güvenlik & uyum
| # | Karar |
|---|---|
| M56 | Audit + kanıt paketi saklama: **10 yıl** (StoragePort yaşam döngüsü kuralı) |
| M57 | **WORM opsiyonel**: s3-compat sürücüsüne `object_lock: compliance` konfigü; kurum desteklemiyorsa hash zinciri + günlük anchor yeterli |
| M58 | **2 seviyeli kill-switch**: ① yeni iş alma durdur (pause intake) ② her şeyi durdur (sandbox'lar güvenli söndürülür, kapılar bekler kalır). Studio'da admin + audit + Jira duyurusu |
| M63 | Veri sınıfı politikası **kurulumda uyum ekibiyle doldurulur** (M18 esnekliği korunur); Studio'da politika editörü ekranı |
| M64 | **Ağ konumu esnek**: Maestro egress proxy'si kurum proxy'sine **zincirlenebilir** (proxy chain); iki düzen de desteklenir |
| M82 | **Journal + yaşayan özet maskeli yazılır** (LLM sınırındaki aynı maske); 10 yıllık kayıtta açık PII kalmaz; ReverseMap yalnız anlık gösterimde |
| M89 | **İptal/ret'te workspace + cache audit'li ANINDA silinir**; journal/audit/kanıt arşivi saklama politikasına tabi (silinmez) |
| M95 | **Test fixture kuralı**: sentetik veri zorunlu; PII desen taraması gerçek-veri-benzeri kalıpta uyarır; AI'ın ürettiği test verisi her zaman sentetik (persona kuralı) |
| M97 | **Gizli sınıfta "yapan" rolün ai-assist'e düşmesi KABUL**; paralelde on-prem agentic çözüm (vLLM + açık coder model + harness) Aşama 3 araştırma kalemi |

### Süreklilik & işletim
| # | Karar |
|---|---|
| M65 | **Workspace yaş sınırı 60 gün** + arşiv: hareketsiz workspace diskten silinir, session+journal StoragePort arşivinde kalır → dönüşte bootstrap (~5dk kayıp, bağlam kaybı yok) |
| M66 | **Restore tatbikatı Aşama 1 çıkış kriteri** (PG+Storage+Vault bir kez); Aşama 3'te tam tekrar |
| M83 | **Analiz şablonu sürüm pin'i**: her akış başladığı şablon sürümüyle biter; sürüm no ticket'a + kanıt paketine yazılır; Studio'da "hangi ticket hangi sürüm" raporu |
| M86 | **Studio herkese açık, rolü kadar görür**: geliştirici/PO/QA kendi işlerinin akışını/journal'ını/maliyetini görür; variant/politika/ayar ekranları admin+TL |
| M60 | **Studio iki dilli (TR/EN)** — i18n altyapısı + dil seçici |
| M61 | **Mobil onay = Jira mobil** (`/approve` yorumla); Studio responsive olur ama mobil-öncelikli değil |
| M87 | **İşletim platform takımında**; runner/servis sağlık uyarıları NotifyPort'tan seçilen ops kanalına (Studio parametresi). Mesai içi destek; 7/24 Aşama 3 kararı |
| M94 | **Sürüm ritmi 2 haftada bir, mesai dışı**; Temporal versioning ile çalışan workflow'lar kesilmez |
| M93 | **Self-service onboarding** (Aşama 3): Studio'da "yeni uygulama ekle" sihirbazı — RoutingRule + profil + `.maestro.yaml` PR'ı + kapı seti tek akışta, admin onaylı |
| M79 | **Pilot: ugurpay + ugurweb, 1 gerçek sprint** (2-3 hafta), tek takım, KPI setiyle ölçüm |

### İş tipleri
| # | Karar |
|---|---|
| M67 | **Repro-first bug akışı**: bug tipinde analiz yerine kısa teşhis raporu + ÖNCE hatayı üreten başarısız test, sonra fix; test yeşile dönünce kanıt hazır. Kapı seti otomatik düşük/orta |
| M68 | **Refactor kapsamda, davranış-koruma şartıyla**: kabul kriteri "mevcut testler yeşil + davranış değişmez"; düşük coverage'da önce karakterizasyon testi; kapı seti orta başlar |
| M69 | **Test değişikliği etiketi**: mevcut test dosyası diff'i üç kategori (yeni/güncelleme/silme); güncelleme+silme PR'da ayrı bölüm + TL onayında açıkça listelenir; assertion zayıflatma tespiti dev-reviewer prompt'unda |
| M70 | **Coverage ratchet**: sabit eşik yok — PR sonrası coverage düşemez + yeni satırlarda min %80; Studio parametresi |
| M90 | **Maestro kendi starter setini getirir** (platform başına, knowledge pack'te versiyonlu); kurum ileride kendi şablonunu Studio'dan yükleyebilir |
| M91 | **Release notu taslağı**: merge sonrası ucuz modelle ticket+diff'ten taslak + doc güncelleme önerisi → Jira yorumu; yayın insan işi |

### Eski açık soruların kapanış özeti
| Eski soru | Karar |
|---|---|
| ADO Server mı Services mı? | M11 — çift mod, konfigle |
| Anthropic mı Bedrock mı Vertex mi? | M16 — dördü de sürücü, konfigle |
| On-prem GPU? | M18 — on-prem sürücü hazır/pasif; gizli-sınıf davranışı politikayla (varsayılan: ai-assist'e düş) |
| Studio kimliği? | M8 — MVP lokal, Aşama 2 AD/LDAP |
| SIEM hedefi/formatı? | M33 — CEF syslog + dosya (sistem-bağımsız) |
| Change yönetimi? | M34 — Jira üzerinden, paket linkiyle |
| Mac donanımı/MDM? | M21/M25 — Mac mini havuzu Aşama 3; MDM görüşmesi o aşamanın giriş kriteri (aşağıda) |
| Windows: ayrık mı ortak mı? | M21 — ayrık VM havuzu |
| iOS imzalama/simulator? | M28 — simulator-only |
| Workspace şifreleme? | M31 — disk şifreleme + iş bazlı erişim |

---

## 3. NE YAZILACAK — Monorepo Yapısı ve Sorumluluklar

```
maestro/
├── apps/
│   ├── bff/            Fastify 5 — webhook'lar (Jira+ADO), REST (auth'lu), Temporal start/signal
│   ├── worker/         Temporal worker — workflow + aktiviteler (düşünen ajan çağrıları buradan)
│   ├── runner-agent/   mac/win daemon + linux driver host — RunnerPort sürücüleri, outbound bağlantı
│   └── studio/         Next.js + Refine — variant/knowledge/eval, izleme, ayarlar
├── packages/
│   ├── contracts/      Zod şemaları: ajan I/O, iç olay şeması, port DTO'ları  ← HER ŞEYİN TEMELİ
│   ├── config/         Zod-doğrulamalı env + yaml politika yükleyici (routing.yaml, llm.yaml)
│   ├── ports/          Arayüzler: WorkPort · ScmPort · CiPort · LlmPort · StoragePort · RunnerPort
│   │                   + NotifyPort · PublishPort · SecretPort · ScanPort (M44 eklenti mimarisi)
│   ├── adapter-jira/   Jira DC: istemci + ADF + webhook parse/verify + komutlar (v1'den evrilir)
│   ├── adapter-ado/    ADO çift-mod: repos/PR/threads/status + Service Hooks parse/verify
│   ├── llm-gateway/    4 API sürücüsü + abonelik sürücü sınıfı (claude-sub/gemini-sub/codex-sub, kota-farkında havuz — M55)
│   │                   + politika + rate limit + kota/bütçe + maliyet + çağrı logu + PII entegrasyonu
│   ├── notify/         NotifyPort sürücüleri: teams · smtp · jira-comment · slack (M45)
│   ├── publish/        PublishPort sürücüleri: jira-comment · confluence-page · repo-docs (M47)
│   ├── secrets/        SecretPort sürücüleri: vault · env-file (+ cyberark/keyvault ileride — M80)
│   ├── execution/      ExecutionAgentPort: Claude Agent SDK oturum yönetimi (başlat/resume/bootstrap)
│   ├── memory/         Ticket Defteri + Yaşayan Özet + session dosya yönetimi
│   ├── workflows/      Temporal workflow + aktiviteler + sinyaller (15 adım)
│   ├── runners/        docker-linux (dockerode+profil) · agent-protokol (gRPC şema) · cache yönetimi
│   ├── scanners/       gitleaks/semgrep/trivy sarmalayıcı (dijest-pinli, fail-closed)
│   ├── pii/            maskeleme çekirdeği (v1'den evrilir; runner.ts entegrasyon hatası düzeltilmiş)
│   ├── audit/          hash zinciri (TEK implementasyon) + CEF/syslog export + günlük anchor
│   ├── storage/        StoragePort sürücüleri: s3-compat · pg-blob
│   ├── mcp-servers/    jira-mcp · ado-mcp · workspace-mcp (ajanlara) + maestro-mcp (platform yönetimi — M101)
│   └── db/             Prisma şema + migration + seed
├── deploy/             compose (dev + prod overlay), Dockerfile'lar (multi-stage, sıkı), egress-proxy örnek konfig
├── docs/               kurulum · runbook · işletim; her doküman koddan türetilen gerçeklerle (v1'in hayal-doküman hatası yasak)
└── LICENSE             © 2026 Uğur Yıldız — tüm hakları saklıdır
```

**Port arayüzleri (imza özeti — kod değil, sözleşme):**
- `ScmPort`: `resolveRepo(rule)` · `createBranch` · `getPushCredential(ttl)` · `openPr(draft)` · `activatePr` · `listPrThreads` · `replyThread` · `getPrStatus`
- `CiPort`: pasif — `parseBuildEvent(webhook) → CiResultSignal`
- `LlmPort`: `generateObject({role, variant, input, schema})` · `agentSession({workspace, task, resumeToken})` → sürücü seçimi politikadan
- `RunnerPort`: `acquire(platformProfile)` · `runSession(job)` · `release` · `mountCache(keys)`
- `StoragePort`: `put/get/list/delete/presign`
- `WorkPort`: `getTicket` · `comment(adf)` · `transition` · `parseCommand(webhook)` · `verifyMembership(user, group)`
- `NotifyPort`: `send(channel, event, payload)` — sürücü seçimi parametreden (M45)
- `PublishPort`: `publish(analysisDoc, targets[])` — jira/confluence/repo-docs (M47)
- `SecretPort`: `get(key)` · `issueShortLived(scope, ttl)` (M80)

**Konfigürasyon ilkesi (M71):** işletim parametreleri (kapı setleri, eşikler, eskalasyon, dil, SoD anahtarları…) **DB'de**, Studio'dan versiyonlu+audit'li yönetilir. `.maestro.yaml` yalnız repo-öz bilgiler: build/test/lint komutları, `protected_paths`, platform ipuçları.

---

## 4. NASIL GELİŞTİRİLECEK — Aşama Planı ve İş Kırılımı

> **Yürütme modeli:** alt ajanlarla bölerek — dalga planı, işçi ajan sözleşmesi, verifier kontrol listesi ve timeout-dayanıklılık taktikleri [`insa-plani.md`](insa-plani.md)'de. Özet: Dalga 0 (contracts/ports) orkestratör elinden ve DONDURULUR; sonra paket başına builder+verifier çifti paralel; dalga sonu kök entegrasyon kapısı yeşil olmadan sonraki dalga açılmaz; aşama demoları (M40a) insan kapısı olarak kalır.

**Test disiplini (her aşamada zorunlu):** Temporal `TestWorkflowEnvironment` (zaman atlatmalı workflow testleri — 20 günlük bekleme testte saniyeler), her adaptör için contract test (kayıtlı gerçek yanıtlarla), her port için sürücü-değişmezlik testi, mock-LLM ile deterministik akış testi, aşama sonunda gerçek sistemlere karşı smoke. CI: lint → typecheck → unit → contract → build → (nightly) smoke.

### Aşama 0 — Walking Skeleton (~2-3 hafta)
**Hedef:** 1 gerçek ticket, uçtan uca, gerçek sistemlerde.
| İş | İçerik |
|---|---|
| 0.1 | Monorepo iskeleti + contracts + config + CI boru hattı |
| 0.2 | db şeması (çekirdek tablolar: WorkflowRun, StepEvent, Journal, Variant, RoutingRule, Setting, AuditLog) + seed |
| 0.3 | adapter-jira: webhook verify (raw-body) + ticket oku + ADF yorum + durum geçişi |
| 0.4 | adapter-ado: çift-mod istemci; branch/PR/hooks minimum seti |
| 0.5 | llm-gateway: anthropic-direct + openai-compat sürücüleri, generateObject, bütçe sayacı |
| 0.6 | runners/docker-linux: hardened profil + bağımlılık cache + workspace volume |
| 0.7 | execution: Agent SDK oturumu (başlat + sonuç topla) |
| 0.8 | workflows: kısaltılmış akış (intake → analyst → TEK onay kapısı → engineer → PR → build validation sinyali) |
| 0.9 | bff: iki webhook + start/signal |
**Çıkış kriteri:** ugurpay veya ugurweb'de gerçek bir ticket → gerçek Claude → gerçek sandbox → ADO'da gerçek PR → build validation yeşil; `TestWorkflowEnvironment` + iki adaptör contract testi yeşil. **Demo + onay.**

### Aşama 1 — Yönetişim + Süreklilik (~2-3 hafta)
15 adımın tamamı; 6 kapı (grup doğrulama + SoD + süresiz bekleme + hatırlatıcı); audit zinciri + CEF export; kanıt paketi; PII maskeleme; memory paketi (journal + özet + session resume); cache katman ①②; Vault entegrasyonu; scanners (6b gerçek).
**Çıkış kriteri:** "15 gün beklet → kaldığı yerden devam" tatbikatı (testte zaman atlatmalı + gerçekte 1 gün bekletmeli); ret döngüsünde session devamlılığı gösterimi; denetim ekibine kanıt paketi sunumu; **restore tatbikatı (PG+Storage+Vault bir kez — M66)**. **Demo + onay.**

### Aşama 2 — Ürünleşme + Platform Genişlemesi (~3-4 hafta)
4 work mode + handoff komutları; 12b PR thread döngüsü; test ajanları (designer/reviewer/engineer); Studio (variant + knowledge + eval + izleme + ayarlar); AD/LDAP kimlik; mcp-servers üçlüsü; `linux-android` profili; **agent-windows** (ugurmasaüstü) — Runner Agent daemon + Windows VM kurulumu; bedrock + vertex sürücüleri (konfig testiyle).
**Çıkış kriteri:** pilot takım gerçek sprint'te; Android + C# ticket'ları uçtan uca; work mode geçiş tatbikatı. **Demo + onay.**

### Aşama 3 — Yaygınlaştırma (~3 hafta + donanım tedarik süresi)
**Giriş kriteri: Mac donanımı + MDM onayı tamam** (tedarik Aşama 1'de başlatılır — uzun süren kalem). `agent-macos` (ugurmobil-ios, simulator test); gVisor runtime; on-prem vLLM sürücüsü aktivasyonu (GPU geldiyse; gelmediyse politika `degrade_ai_assist` çalışmaya devam eder); ölçek ayarları (role queue + çoklu worker); OpenShift/Helm taslağı; işletim runbook'u + yedekleme tatbikatı.
**Çıkış kriteri:** 5 uygulamanın 5'i destekli; runbook tatbikatla doğrulanmış. **Demo + onay.**

**Toplam:** ~10-13 hafta mühendislik (donanım tedarik süreleri paralel yürür).

---

## 5. YAZILDIKTAN SONRA AKIŞ NASIL ÇALIŞACAK

Tam adım adım şema: [`diagrams/maestro-tumkapsam.md`](diagrams/maestro-tumkapsam.md) (düzenlenebilir mermaid). Kısa anlatım — `UGURPAY-123` örneği:

1. **Ticket + webhook:** Jira → BFF (HMAC, fail-closed) → Temporal başlar; Ticket Defteri açılır. RoutingRule ticket'ı `ugurpay / linux-node / ADO repo X`'e eşler (eşleşme yoksa insan atamasına düşer, M14).
2. **Intake:** ucuz model ticket'ı doğrular; eksikse reporter'a soru (2b), süresiz + hatırlatıcılı bekleme.
3. **Keşif + analiz:** kısa Agent SDK oturumu repo'yu gezer; analyst (gateway politikası hangi modeli seçtiyse) analiz + teknik tasarım üretir; Jira'ya ADF yorum.
4. **PO onayı → TL onayı:** yorumla `/approve`; grup üyeliği + SoD doğrulanır; her karar imzalı.
5. **Geliştirme:** full-auto ise Linux havuzunda hardened sandbox; çalışma alanı mount; Agent SDK oturumu kodu yazar, lint/build/unit koşar, branch push eder. ai-assist/human-lead ise insan kodlar, PR açınca ADO webhook'u akışı ilerletir.
6. **Tarama + inceleme:** gitleaks/semgrep/trivy (fail-closed) → dev-reviewer gerçek diff'i inceler. Her ret, aynı oturumun devamıyla düzeltilir.
7. **Test:** senaryolar üretilir/denetlenir → QA onayı → test-engineer aynı çalışma alanında senaryoları koda çevirip **gerçekten koşar**.
8. **CI + PR:** PR aktifleşir → ADO branch policy build validation'ı koşturur → sinyal gelir → QA sonuç onayı → TL PR onayı (min 1 insan reviewer policy'de).
9. **12b:** PR thread'leri dinlenir; "changes requested" → geliştirmeye dönüş (oturum devam). 15-20 gün sessizlik → sadece hatırlatıcılar; bağlam kaybolmaz.
10. **Kapanış:** merge → kanıt paketi StoragePort arşivine, Jira Done, çalışma alanı audit'li silinir, audit zinciri CEF olarak SIEM'e akar.

---

## 6. İşletim

- **Dev/pilot:** Docker Compose — servisler: bff, worker, runner-svc, studio, temporal(+ui), postgres, redis, s3-uç (dev: minio/seaweedfs), vault, egress-proxy. Prod overlay: gerçek kurum Postgres/S3/Vault uçları. Eksik secret = başlamaz (M6).
- **Port haritası** (compose varsayılanları, `.env` ile değiştirilebilir; kurumda öne ters vekil konur, dışarıya yalnız 443 açılır):

| Servis | Port | Erişim |
|---|---|---|
| **Studio** (Next.js) | **7000** | kullanıcının gördüğü tek adres — `maestro.ugurbank.local` buraya bağlanır |
| BFF (Fastify) | 7001 | webhook uçları + REST + `/mcp` (M101) |
| Temporal | 7233 | gRPC, yalnız iç ağ |
| Temporal UI | 8233 | yalnız admin |
| PostgreSQL / Redis | 5432 / 6379 | dışa kapalı |
| Runner Agent | **port yok** | win/mac makineler outbound bağlanır, içeri port açılmaz (M22) |

  > 7000/7001 bilinçli seçim: eski v1 stack'i bu portlardaydı, emekliye ayrıldı (konteynerleri durduruldu, kaynağı `coder/orkestra`'da tarihsel referans olarak duruyor). v1 verisi taşınmaz — Maestro kendi seed'iyle dolar.
- **Runner makineleri:** Win VM + Mac mini'ler Runner Agent daemon'unu servis olarak koşturur; outbound bağlanır; sağlıkları Studio'da görünür.
- **Yedekleme:** PG (günlük dump + WAL), StoragePort (kurumun kendi depolama yedeği), Vault snapshot. Geri dönüş prosedürü runbook'ta, Aşama 3'te tatbikatlı.
- **Yükseltme:** migration'lı sürüm çıkışı; çalışan workflow'lar Temporal versioning ile eski koduyla biter.
- **OpenShift geçişi:** tüm servisler stateless (durum PG/Redis/Storage'da); Helm chart Aşama 3'te taslak, geçiş ayrı karar.

## 7. Riskler (açık soru değil — kabul edilmiş, izlenen)

| Risk | Kabul/azaltma |
|---|---|
| mac/win'de konteynır izolasyonu yok | M25 telafi seti; kabul edilen risk kaydı |
| Agent SDK = Claude bağımlılığı ("gizli" sınıfta) | M18 politika: degrade/block seçeneği; on-prem sürücü hazır |
| Mac tedarik/MDM gecikmesi | Aşama 3 giriş kriteri; tedarik Aşama 1'de başlar; iOS'a kadar 4 uygulama canlı |
| ADO Server API sürüm farkları | Çift-mod contract testleri; pilot öncesi kurum sürümünde duman testi |
| LLM maliyet sapması | Gateway bütçesi hard-stop; günlük maliyet raporu Studio'da |
| Kurum ağ/proxy sürprizleri | Aşama 0'da ilk iş: ağ yolu doğrulama script'i (Jira/ADO/LLM uçlarına erişim kontrolü) |

---
*Bu doküman Maestro'nun tek doğruluk kaynağıdır. Değişiklik = yeni M-kararı + gerekçe. "Başla" onayı Aşama 0'ı açar.*
