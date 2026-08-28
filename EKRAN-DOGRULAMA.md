# Ekran Doğrulama Raporu

**Tarih:** 2026-08-10
**Yöntem:** Çalışan sistem tarayıcıda gezildi (Playwright), her ekran açıldı, konsol ve BFF yanıtları `curl` ile doğrulandı.
**Oturum:** `ayse.kaya@bank` (admin) · Studio `127.0.0.1:7000` · BFF `127.0.0.1:7001`
**Kapsam:** `apps/studio/src/app/screens.ts` içindeki 36 rota + login = 37 ekran.

> **Not — yöntem uyarısı:** Tarayıcı içi `innerText` ile toplu tarama YANLIŞ SONUÇ verdi (React render'ı yarışa girdi ve hata kutularını "yok" gösterdi). Aşağıdaki tablo ekran görüntüsü, erişilebilirlik anlık görüntüsü ve BFF'e atılan doğrudan `curl` ile teyit edilmiştir.

---

## Ekran tablosu

| Ekran | Yol | Durum | Ne gördüm | Konsol |
|---|---|---|---|---|
| Giriş | `/login` | VERİ VAR | Kullanıcı adı/parola/dil alanları; giriş başarılı, `/dash`'e yönlendi | temiz |
| Panel | `/dash` | BOŞ | Sayaçlar: Aktif **0**, Kapıda **0**, Tamamlanan **0**, Toplam **22**. "Şu an dikkat isteyen akış yok." + "Hareket dökümü için sunucuda bir uç yok (GET /activity)" | temiz |
| Yardım | `/help` | VERİ VAR | "Maestro tek paragrafta" anlatımı, rol tablosu (8 satır) | temiz |
| Canlı demo | `/live` | VERİ VAR | 4 adımlı akış şeridi (Ticket yaz → Analizi onayla → PR'ı onayla → Merge + kanıt) | temiz |
| İş akışları | `/tickets` | VERİ VAR | 22 satır gerçek ticket (UGURPAY-123, UGURDESK-52…). **Ama** her satırda Durum=`başlamadı`, Adım=`—`; filtreler Çalışıyor(0)/Kapıda(0)/Tamamlandı(0)/Hatalı(0) | temiz |
| İş akışı detayı | `/detail/:ticket` | **HATA** | 22 ticket'ın **6'sında** "⚠ Veri alınamadı / Sunucuda bir hata oluştu." Diğerlerinde künye dolu ama sekme gövdesi "henüz yayında değil" | **500** `/api/studio/runs/UGURPAY-123` |
| Ana ticket (fan-out) | `/fanout` | BOŞ | Form + "Etki matrisi analiz belgesinde yaşıyor ve sunucuda bir ucu yok." "Alt ticket'lar: proje seçilmedi" | temiz |
| Clarification (2b) | `/clarify` | BOŞ | Ticket/Yanıt formu çalışır durumda; "Açık iş akışı yok" | temiz |
| Work mode & devir | `/workmode` | VERİ VAR | Mod matrisi 4 satır (full_auto, ai_assist, human_lead, human_only) × 5 sütun | temiz |
| Yeni proje sihirbazı | `/greenfield` | BOŞ | "Önce bir ticket seç" — boş durum; içerik yok | temiz |
| Jira'da görünüm | `/jira` | VERİ VAR | Komut tablosu 11 satır (`/approve`, `/reject`…) | temiz |
| Jira komut seti | `/commands` | VERİ VAR | 8 komut; yetki/adım/etki sütunları dolu | temiz |
| Runner havuzları | `/runners` | **HATA** | Üstte "⚠ Veri alınamadı". Altta yalnız statik "İzolasyon profili" ve "Kabul edilmiş risk" metni. Filo tablosu YOK | **500** `/api/studio/runners` |
| Canlı sandbox | `/sandbox` | **HATA** | "⚠ Veri alınamadı" + 2 açıklama paragrafı. Oturum tablosu YOK | **500** `/api/studio/sandboxes` |
| Cache & çalışma alanı | `/cache` | KASITLI RET | İki başlık ("Cache katmanları", "Aktif ticket çalışma alanları") **gövdesiz**. Hata mesajı da yok — sessiz boşluk | **503** `capability_not_wired` |
| .maestro.yaml | `/yaml` | VERİ VAR | 5 uygulama sekmesi; seçilen repo için YAML gösteriliyor (içerik İngilizce placeholder) | temiz |
| Variant'lar | `/variants` | VERİ VAR | 9 variant satırı (intake-default, analyst-desktop…) model/sürüm/eval skoru ile | temiz |
| Variant detayı | `/variant` | BOŞ | "Önce bir variant seç" — boş durum | temiz |
| Eval / golden ticket | `/eval` | KASITLI RET | "Golden ticket havuzu" ve "Son eval koşumu" başlıkları **gövdesiz**; hata mesajı yok | **503** `capability_not_wired` |
| Knowledge kütüphanesi | `/knowledge` | BOŞ | Arama kutusu var; "Aramak için bir kelime yaz." (uç en az 1 kelime istiyor) | temiz |
| Analiz şablonu | `/template` | **YAYINDA DEĞİL** | İki bölümde de "🚧 Bu bölüm henüz yayında değil". **Tasarımcı arayüzü hiç yok** — bölüm ekle/sırala denenemedi | **404** `/api/template` |
| Doküman şablonu | `/doctemplate` | VERİ VAR | "şablon yok" rozeti + 12 satırlık yer tutucu/bölüm eşleme tablosu | temiz |
| LLM Gateway | `/llm` | VERİ VAR | 10 satır; claude-sub-01 (5h %62 · weekly %41), claude-sub-02 (%88/%67) | temiz |
| PII maskeleme | `/pii` | VERİ VAR | Maskelenen çağrı 1/5 (%20), maskelenen alan 2, on-prem 1; kural tablosu 8 satır | temiz |
| Maliyet & kota | `/cost` | VERİ VAR | API harcaması **$0.74** / 3 çağrı, kotadan 2 çağrı, **228,100** token; 5 satır | temiz |
| Denetim izi | `/audit` | VERİ VAR | "Zincir tutarlı (yeniden hesaplandı)", **76 kayıt** yeniden hash'lendi; 50 satır listeleniyor | temiz |
| Kanıt paketi | `/evidence` | BOŞ | Ticket girişi bekliyor: "Paketi görmek için bir ticket anahtarı yaz." | temiz |
| Güvenlik bulguları | `/security` | KASITLI RET | "Bulgular" başlığı **gövdesiz**; sadece fail-closed açıklaması. Hata mesajı yok | **500** `/api/studio/scans` |
| Bildirim & eskalasyon | `/notify` | VERİ VAR | Merdiven: 24s Jira → 72s E-posta+Teams → 168s vekil → 336s rapor | temiz |
| Jira bağlantısı & eşleme | `/routing` | VERİ VAR | 5 proje (UGURDESK otomatik, UGURKREDI eşleşme yok, UGURMOB komut…) | temiz |
| Parametreler (DB) | `/params` | VERİ VAR | 19 parametre satırı, sürüm/kapsam/değiştiren + "Düzenle" | temiz |
| Maestro MCP | `/mcp` | VERİ VAR | 18 araç satırı, kapsam ve açıklama ile | temiz |
| Uygulama ekle | `/onboard` | VERİ VAR | 4 adımlı sihirbaz; Jira projeleri ve repo listesi dolu; kuru koşum çalışıyor (detay aşağıda) | **409** (aşağıya bak) |
| Kullanıcılar & roller | `/users` | VERİ VAR | Sorgu formu + kapalı rol kümesi (admin, tech-lead…) açıklamalarıyla | temiz |
| Ayarlar & bağlantılar | `/settings` | VERİ VAR | 12 satır: Jira DC ● bağlı, Azure DevOps ● bağlı, Vault ● bağlı (vault: referansları) | temiz |
| Sistem sağlığı | `/health` | VERİ VAR + YAYINDA DEĞİL | "● Tüm servisler sağlıklı", PostgreSQL ve Temporal ● sağlıklı. **Yedekleme bölümü** "🚧 henüz yayında değil" | temiz |
| Karar defteri | `/issues` | VERİ VAR | 36/36 kayıt; ama içerik ham enum: `GATE_REJECT`, `GATE_OPEN · maestro-worker` | temiz |

---

## Net sayılar

| Durum | Adet | Hangileri |
|---|---|---|
| **VERİ VAR** | **22** | login, help, live, tickets, workmode, jira, commands, yaml, variants, doctemplate, llm, pii, cost, audit, notify, routing, params, mcp, onboard, users, settings, issues |
| **BOŞ** | **7** | dash, fanout, clarify, greenfield, variant, knowledge, evidence |
| **HATA** | **3** | detail, runners, sandbox |
| **KASITLI RET** | **3** | cache, eval, security |
| **YAYINDA DEĞİL** | **1** | template |
| **VERİ VAR + kısmen YAYINDA DEĞİL** | **1** | health (servisler dolu, yedekleme bölümü yayında değil) |
| **Toplam** | **37** | login dahil |

"Yayında değil" mesajını gösteren ekran sayısı: **2** (template tamamen, health kısmen).
Gerçek veri render eden ekran sayısı: **23** (health dahil).

---

## Kök neden analizi (kanıtlı)

### 1. Temporal'da "hayalet" iş akışları — 6 ticket'ın detayını kırıyor · **EN KRİTİK**

Temporal'da **`verifyRun` tipinde 6 açık workflow** var, ama kod tabanında `verifyRun` diye bir workflow **hiç yok** (`grep -rn "verifyRun"` → 0 sonuç; tek workflow `ticketWorkflow`).

```
$ docker exec maestro-temporal-1 tctl --ad 172.26.0.4:7233 --ns default workflow list --open
verifyRun | maestro-UGURWEB-91  | ... | maestro-delivery
verifyRun | maestro-UGURPAY-478 | ...
verifyRun | maestro-UGURDESK-45 | ...
verifyRun | maestro-UGURPAY-712 | ...
verifyRun | maestro-UGURPAY-123 | ...
verifyRun | maestro-UGURPAY-501 | ...
```

BFF logu (`bff-final.log`):
```
QueryNotRegisteredError: Failed to initialize workflow of type 'verifyRun':
no such function is exported by the workflow bundle
  at TemporalRunGateway.queryRunState (apps/deploy/src/temporal-gateway.ts:143)
  at apps/bff/src/routes/studio-runs.ts:90
```

**Birebir doğrulama** — bu 6 ticket 500, diğer 16'sı 200:
```
UGURDESK-45 -> 500   UGURPAY-600 -> 200
UGURPAY-123 -> 500   UGURWEB-88  -> 200
UGURPAY-478 -> 500   UGURMOB-201 -> 200
UGURPAY-501 -> 500   UGURPAY-502 -> 200
UGURPAY-712 -> 500   UGURWEB-95  -> 200
UGURWEB-91  -> 500
```

**Kod hatası:** Liste ucu (`studio-runs.ts:54-62`) bu çağrıyı `try/catch` ile sarıyor ve nedenini uzun bir yorumla açıklıyor ("row survives with `state: null`"). **Detay ucu (satır 90) aynı çağrıyı korumasız yapıyor.** `runIdOf` (satır 187) de aynı şekilde korumasız — journal/summary/evidence/cost uçlarının hepsi bu yüzden 500 veriyor.

`queryRunState` yalnız `WorkflowNotFoundError`'ı `null`'a çeviriyor; `QueryNotRegisteredError` yukarı fırlıyor.

### 2. `state: null` → tüm sayaçlar sıfır

`/studio/runs` her satırda `"state": null` döndürüyor. Sebep: DB'de 22 `WorkflowRun` satırı var ama karşılık gelen canlı workflow ya yok ya da yukarıdaki bozuk tipte. Sonuç:

* Panel: Aktif 0 / Kapıda 0 / Tamamlanan 0 (Toplam 22)
* İş akışları: her satır `başlamadı`, adım `—`
* DB'de **`Gate` tablosu 0 satır** → "Kapıda bekleyen" gerçekten boş.

DB doğrulaması: `WorkflowRun`=22, `StepEvent`=40, `JournalEntry`=100, `AuditLog`=76, `LlmCall`=5, **`Gate`=0**.

### 3. Bağlanmamış read-model'ler 503 yerine 500 veriyor — tutarsızlık

`runners`, `sandboxes`, `scans` **kasıtlı olarak bağlanmamış** (`read-live.ts:26-31` bunu açıkça anlatıyor: "there is no runner-fleet table…"). Ancak düz `Error` fırlattıkları için kullanıcıya **500 internal_error** olarak çıkıyorlar:

```
read model runners.list: not wired — no runner fleet store (RunnerPort … M60)
read model scans.list: not wired — no scan result store … (M27)
```

Buna karşılık `cache` ve `eval` aynı durumda **doğru** davranıp `503 capability_not_wired` + `details.missing` döndürüyor. Aynı tasarım kararı iki farklı HTTP koduyla dışa vuruyor: biri "yetenek bağlı değil", diğeri "sunucu çöktü".

### 4. `/template` — arkasında tablo yok

`GET /template` → **404 `no_template`**, `GET /template/versions` → 404. Veritabanında analiz şablonu tablosu **yok** (yalnız `DocTemplateVersion` / `DocTemplateOutputRow` var, onlar Word şablonu için).
→ **Görev tanımındaki "bölüm ekle / sırala" testi yapılamadı: ekranda tasarımcı arayüzü hiç render edilmiyor.**

### 5. Onboarding kuru koşum — 409 kullanıcıya "Beklenmeyen bir hata" olarak çıkıyor

UGURPAY + ugurpay seçip "Kuru koşum yap" → istek:
```json
POST /api/onboarding/dry-run  {"jiraProject":"UGURPAY","adoRepo":"ugurpay"}
→ 409 {"error":"project_already_bound","details":{"projectKey":"UGURPAY","state":"active"}}
```
BFF **doğru ve anlaşılır** cevap veriyor. Ama `apps/studio/src/api/errors.ts` içinde `project_already_bound` anahtarı **yok**, bu yüzden ekranda kırmızı kutuda sadece **"Beklenmeyen bir hata oluştu."** yazıyor. Kullanıcı "bu proje zaten bağlı" bilgisini alamıyor.

Bağlanmamış bir proje seçilince (UGURKREDI) kuru koşum **çalışıyor**: 200 döndü, ekranda "kural eşleşti: 0 / AI önerisi: 0 / atama gerekir: 0" göründü (o projede ticket olmadığı için hepsi sıfır).

---

## Etkileşim testleri

| Test | Sonuç |
|---|---|
| **Yeni proje sihirbazı** (`/onboard`) kuru koşum | **Kısmen.** Bağlı projede 409 → "Beklenmeyen bir hata". Bağlanmamış projede çalışıyor ama sonuç tamamen sıfır. |
| **Şablon tasarımcısı** (`/template`) bölüm ekle/sırala | **Yapılamadı.** Ekranda tasarımcı yok, "henüz yayında değil". Sunucuda uç 404. |
| **İş akışı listesi** (`/tickets`) filtre | **Çalışıyor.** Proje filtresi: Tümü 22 → UGURWEB **5** → UGURDESK **3** → Tümü 22. Satırlardaki uygulama sütunu filtreyle tutarlı. |
| **İş akışı listesi** satıra tıkla → detay | **Çalışıyor ama yarısı kırık.** UGURPAY-600 → künye dolu açıldı. UGURPAY-123 → "Veri alınamadı". |
| Durum filtreleri (Çalışıyor/Kapıda/Tamamlandı/Hatalı) | Hepsi **(0)**; tıklayınca boş liste. Veri sebebiyle (state null), filtre mantığı sebebiyle değil. |

---

## Türkçe metin sorunları

1. **İngilizce metin Türkçe arayüzde** — `/routing` "NOT" sütunu doğrudan BFF'den İngilizce geliyor:
   `every ticket starts a run` · `draft: not yet bound` · `waits for the "maestro" label or /ai-start`
2. **`/yaml` yer tutucusu tamamen İngilizce:** "# .maestro.yaml has not been observed in Sube/_git/ugurmasaustu. # No run has read this repository's policy file yet…"
3. **`/issues` (Karar defteri) ham enum gösteriyor:** "SORU" sütununda `UGURPAY-123 · 11`, "KARAR" sütununda `GATE_OPEN · maestro-worker`. Bir banka denetçisi için `GATE_OPEN` bir karar cümlesi değil.
4. **Kod/terim karışıklığı:** ekran adları ve tablo hücreleri `full_auto`, `ai_assist`, `human_lead`, `human_only` gibi ham anahtarları gösteriyor; risk sütunu Türkçe ("düşük", "kritik") ama mod sütunu İngilizce snake_case. Aynı tabloda iki dil.
5. **Karışık dilli başlıklar:** "Clarification (2b)", "Work mode & devir", "Cache & çalışma alanı", "Variant detayı", "Knowledge kütüphanesi", "Eval / golden ticket" — sol menüde Türkçe-İngilizce karışımı.
6. `/dash`'te teknik detay son kullanıcıya sızıyor: "Hareket dökümü için sunucuda bir uç yok **(GET /activity)**". HTTP metodu bir banka mimarına değil, geliştiriciye ait bir bilgi.

---

## Kullanıcıya gösterilebilir mi?

**Kısaca: menüdeki "yayında değil" salgını büyük ölçüde bitmiş, ama ekran hâlâ "canlı bir sistem" hissi vermiyor.**

Önceki şikâyet ("neredeyse her ekranda yayında değil") artık **geçerli değil**: 36 ekranın yalnız **1'i tamamen** (`/template`), **1'i kısmen** (`/health` yedekleme bölümü) o mesajı gösteriyor. 23 ekran gerçek veriyle doluyor — denetim izi (76 kayıt, hash zinciri doğrulanıyor), maliyet ($0.74, 228.100 token), LLM kotaları, parametreler (19 satır), MCP araçları (18 satır), variant'lar (9 satır) ciddi ve inandırıcı görünüyor. Arayüz görsel olarak temiz ve profesyonel.

**Ama bir banka mimarı ilk 60 saniyede şunlara takılır:**

1. **Panel yalanmış gibi duruyor.** Açılış ekranı "Toplam 22" diyor, hemen yanında "Aktif 0, Kapıda 0, Tamamlanan 0". 22 iş akışı var ama hiçbiri hiçbir durumda değil. İlk izlenim: "sistem çalışmıyor."
2. **Listeden detaya tıklayınca %27 ihtimalle duvara çarpıyor.** 22 ticket'ın 6'sı "Veri alınamadı" veriyor. Bu tesadüfi değil, tekrarlanabilir — ve mimar büyük ihtimalle listenin **en üstündeki** UGURPAY-123'e tıklar, ki o bozuk olanlardan biri. **En kötü ilk deneyim.**
3. **Yürütme grubu neredeyse tamamen ölü.** Runner havuzları ve Canlı sandbox kırmızı hata kutusu; Cache ve Eval sessizce bomboş başlıklar. "Yürütme" menüsündeki 4 ekranın 4'ü de iş görmüyor. Bir SDLC otomasyon platformunda yürütme katmanının hiç veri göstermemesi en zor savunulacak nokta.
4. **Güvenlik bulguları boş.** Banka bağlamında "Güvenlik bulguları" başlığının altında hiçbir şey olmaması — hata mesajı bile olmadan — "tarama yapılmıyor mu?" sorusunu doğurur. Ekran fail-closed prensibini anlatıyor ama kendisi sessizce boş kalıyor.
5. **Şablon tasarımcısı sözü tutulmamış.** Menüde "Analiz şablonu" var, tıklayınca iki kutu da "henüz yayında değil".

**Değerli tarafı:** Sistem hiçbir yerde **uydurma veri göstermiyor.** Her boş ekran nedenini yazıyor ("sunucuda bir uç yok", "uydurma veri göstermemek için boş bırakıldı"). Bu, bir denetim ortamı için doğru ve savunulabilir bir tercih — mimar bunu takdir eder.

**Gösterilebilir mi?** Şu hâliyle **hazır değil.** Ama tek bir kök neden (Temporal'daki 6 hayalet `verifyRun` workflow'u) temizlenip `studio-runs.ts:90` ile `runIdOf` liste ucundaki gibi `try/catch`'e alınırsa, detay ekranı ve sayaçlar aynı anda düzelir. Bu, iki küçük düzeltmeyle demoyu "kırık"tan "çalışır"a taşıyan en yüksek getirili müdahale.

### Öncelik sırası
1. **Hayalet workflow'ları sonlandır** (`tctl workflow terminate`) — 6 ticket'ın detayı ve tüm sayaçlar düzelir.
2. **`studio-runs.ts:90` ve `runIdOf` (satır 187) `try/catch`'e alınsın** — motor hatası tüm ekranı düşürmesin (liste ucu bunu zaten doğru yapıyor).
3. **`runners`/`sandboxes`/`scans` 503 `capability_not_wired` döndürsün** — `cache`/`eval` ile tutarlı olsun; kullanıcı "çöktü" yerine "bağlı değil" görsün.
4. **`project_already_bound` Studio hata kataloğuna eklensin** — "Beklenmeyen bir hata" yerine gerçek sebep yazılsın.
5. **Cache/Eval/Security'nin boş gövdeleri** en azından `cache`/`eval`'in döndürdüğü "yetenek bağlı değil" mesajını göstersin.
6. **Türkçeleştirme:** routing notları, .maestro.yaml yer tutucusu, karar defteri enum'ları ve mod sütunu.

---

## Kanıt dosyaları

* `/home/ubuntu/coder/detail-500-full.png` — UGURPAY-123 detayı "Veri alınamadı"
* `/home/ubuntu/coder/runners-500.png` — Runner havuzları hata kutusu
* `/home/ubuntu/coder/sandbox-empty.png` — Canlı sandbox hata kutusu
* `/home/ubuntu/coder/dash-desktop.png` — Panel (0/0/0/22)
* BFF hata logu: `/home/ubuntu/.claude/jobs/bbaf4171/tmp/bff-final.log`
