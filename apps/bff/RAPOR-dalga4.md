# RAPOR — Dalga 4: BFF'in Studio REST yüzeyi

**Branch:** `worktree-agent-a8bce644a3a219891`
**Taban:** `cbcf9cd` (wave-3)
**Kapı:** `pnpm run gate` → **exit 0**, 48/48 görev başarılı.
**Test:** 212 → **336** (+124), BFF paketinde 21 dosya.

> Not: worktree yanlış temelden (`1c78e71`) dallanmıştı; brifingdeki talimat
> uyarınca `git reset --hard main` ile `cbcf9cd`'ye alındı. Provizyon hatası.

---

## 1. Yaklaşım — neden "kaynak bazlı" ve neden yeni port'lar

Mock'taki 37 ekran, BFF'in elindeki bağımlılıkların çok ötesinde veri istiyor.
İki dürüst olmayan yol vardı: (a) ekran başına uç açıp sabit/uydurma değer
döndürmek, (b) `packages/contracts`/`ports` dondurulmuş olduğu için oraya tip
eklemek. İkisi de yasak.

Seçilen yol: **BFF'in kendi okuma modeli katmanı** (`src/read-models.ts`).
Bunlar BFF'e ait arayüzlerdir — dondurulmuş paketlere dokunulmadı — ve her biri
mevcut kontrat tiplerini (`WorkflowRunState`, `JournalEntry`, `ApplicationRecord`,
`EvidencePackage`, `LlmCallLog`, `SubscriptionAccount`, `ScanFinding`, `RepoCard`,
`AuditEvent`) kullanır. Yeni kelime dağarcığı icat edilmedi; Studio'nun ihtiyaç
duyduğu **birleştirmeler** eklendi.

Her uç, seed edilmiş gerçek satırları döndürür. Testler fikstürü yazar,
uç onu döndürür — **sabit değer döndüren uç testte düşer**.

---

## 2. Eklenen uçlar

Öncesi 14 uç. Sonrası **31 uç** (+17).

### Çalışma (run) yüzeyi — `src/routes/studio-runs.ts`

| Metot | Yol | Kim erişebilir |
|---|---|---|
| GET | `/studio/runs` | Oturum; **proje kapsamlı** (admin/tech-lead hepsi) |
| GET | `/studio/runs/:ticket` | Oturum + o projenin üyesi |
| GET | `/studio/runs/:ticket/journal` | Oturum + proje üyesi |
| GET | `/studio/runs/:ticket/summary` | Oturum + proje üyesi |
| GET | `/studio/runs/:ticket/evidence` | Oturum + proje üyesi |
| GET | `/studio/runs/:ticket/cost` | Oturum + proje üyesi |

`/studio/runs` platform kaydını canlı workflow durumuyla **birlikte** döndürür;
iki ayrı çağrı, bir anın adımını başka bir anın durumuyla yan yana boyardı.

### Operatör yüzeyi — `src/routes/studio-ops.ts`

| Metot | Yol | Kim erişebilir |
|---|---|---|
| GET | `/studio/gates` | Oturum; proje kapsamlı (iş listesi) |
| GET | `/studio/runners` | `admin` \| `tech-lead` |
| GET | `/studio/sandboxes` | `admin` \| `tech-lead` |
| GET | `/studio/quota` | `admin` \| `tech-lead` |
| GET | `/studio/health` | `admin` \| `tech-lead` |
| GET | `/studio/audit` | `admin` \| `internal-audit` |
| GET | `/studio/audit/verification` | `admin` \| `internal-audit` |

`waitingDays` **saklanmaz, hesaplanır** — açılışta yazılan bir süre okunduğunda
zaten yanlıştır. Zincir doğrulaması GET'tir: onarmaz, sadece kanıtlar; boş
zincir `ok:false` döner (M33 — boşluk hiçbir şey kanıtlamaz).

### Katalog yüzeyi — `src/routes/studio-catalog.ts`

| Metot | Yol | Kim erişebilir |
|---|---|---|
| GET | `/studio/apps` | Oturum |
| GET | `/studio/apps/:appId` | Oturum |
| GET | `/studio/apps/:appId/repo-card` | Oturum |
| GET | `/studio/knowledge` | Oturum + **veri sınıfı süzgeci** |
| GET | `/studio/scans` | Oturum; proje kapsamlı |
| GET | `/studio/cost` | `admin` \| `tech-lead` |
| GET | `/studio/users/:username` | `admin` |

---

## 3. Kapı kararı yazılmadı (brifing madde 4)

Hiçbir yeni uç kapı kapatmaz. `/studio/gates` **salt okunur** bir pano; karar
mevcut `POST /runs/:ticket/signals/gateDecision` kalıbıyla sinyal olarak gider.
Test bunu doğrudan doğruluyor: `/studio/gates` üzerine POST/PUT/PATCH/DELETE
denemelerinin hepsi 404 alır (`studio-ops.test.ts`).

---

## 4. `MaestroPlatform` uygulaması — `src/platform/`

`maestro-mcp`'nin enjekte edeceği arayüzün tamamı uygulandı; `buildServer`
sonucuna `app.platform` olarak dekore edilir, yani MCP ve Studio **aynı okuma
modellerini aynı RBAC üzerinden** okur.

- `platform/actor-scope.ts` — `actingUser` → REST guard'ın ürettiği yetki öznesi.
  Roller/gruplar **her çağrıda dizinden** okunur; işten çıkarılmış bir hesabın
  MCP oturumu erişimini sürdüremez. `ai-via:` delegasyonu insanın rollerine
  çözülür, fazlası değil.
- `platform/read.ts` — 9 okuma metodu, limit tavanı 200'e sıkıştırılır.
- `platform/operate.ts` — 7 değişiklik metodu; her biri proje erişimi +
  kill switch + audit taşır.
- `platform/propose.ts` — 2 öneri metodu (param + kill switch); ikisi de
  **uygular değil, kuyruğa alır**.

**Yapısal garanti:** hiçbir yarıda kapı kapatan, verdict yazan veya PR merge
eden metot yok. Test bunu isim listesi üzerinden pinliyor.

Dikkate değer kararlar:
- `proposeParamChange`, **guarded olmayan** anahtarı reddeder (409). Aksi halde
  MCP kapı setini doğrudan değiştirebilirdi; arayüzde "uygulandı" anlamına gelen
  bir şekil olmaması bunun içindir.
- `proposeKillSwitch` kill switch açıkken de **kabul edilir** — aksi halde
  seviye yükseltmek için ikinci bir öneri hiç verilemezdi.
- `resumeRun`, `full_auto`'ya değil **çalışmanın kendi moduna** döner; devam
  ettirmek AI yetkisinin sessiz terfisi olmamalı.
- `retryStep` yalnızca **mevcut** adımı yeniler; geçilmiş adımı geri sarmak
  sonraki adımların üstüne inşa ettiği işi bozardı.

---

## 5. Brifingdeki uyarılara karşılık

| Uyarı | Nerede karşılandı |
|---|---|
| Sahte/sabit değer döndüren uç | Her alan fikstürden gelir; `studio-fixtures.ts` seed eder, testler alan alan doğrular (`costUsd`, `reporter`, `prId`, `ruleId`, `file`…). |
| Bağlanmamış proje | `startWorkflow`/`assignApp` mevcut `runIntake`'ten geçer → bağlanmamış proje 409 `intake_unbound`, hiçbir run başlamaz (test var). |
| `dataClass` etiketsiz = gizli | `src/knowledge-policy.ts`: `UNLABELLED_CLASS = "gizli"`; `undefined`/`null`/tanınmayan sınıf hepsi gizli sayılır. REST'te sayılarak saklanır (`withheld`), MCP kanalında **düşürülür** (maskelenmez — maskelenmiş parça belgenin varlığını sızdırır). 6 birim testi. |
| Kill switch açıkken yazma | `assertWritable` her operate metodunda; tek bir boğaz noktası değil, çünkü unutan metot olay anında çalışan metot olurdu. Testler 409 doğruluyor. |
| Ölü yol | Yazdığım `assertHumanChannel` çağrılmıyordu → **silindi**, yerine neden gerekmediğini anlatan yorum bırakıldı (bu arayüzde insan kanalı gerektiren tek eylem zaten yok). |

---

## 6. Sayfalama

Tüm liste uçlarında `limit` (varsayılan 50, **tavan 200**) + opak `cursor`.
Tavan aşan istek **400** alır — sessizce kırpılmaz.

Cursor, üretildiği süzgecin parmak iziyle bağlıdır: başka bir sorgunun
cursor'ı yeniden başlatır, o sorgunun ofsetiyle devam etmez.

**Yakalanan gerçek hata:** ilk yazımda `decodeCursor` son iki nokta üst üste
işaretinden bölüyordu. Parmak izleri iki nokta içeriyor
(`journal:<runId>:<actor>`), dolayısıyla ofset parmak izinin ortasından
ayrıştırılıyor, her cursor yabancı görünüyor ve "sonraki sayfa" sessizce
**hep birinci sayfayı** döndürüyordu. Sayfalı listenin en zor fark edilen
arızası. Testi yazarken düştü, düzeltildi, `read-side.test.ts` pinliyor.

---

## 7. Testler (212 → 336)

| Dosya | Test | Kapsam |
|---|---|---|
| `studio-runs.test.ts` | 22 | Run listesi/detay/defter/özet/kanıt/tüketim |
| `platform-operate.test.ts` | 23 | MaestroPlatform değişiklik yarısı |
| `platform.test.ts` | 24 | MaestroPlatform okuma yarısı + sunucu bağlantısı |
| `studio-ops.test.ts` | 21 | Kapılar, filo, kota, sağlık, denetim |
| `studio-catalog.test.ts` | 19 | Registry, knowledge, tarama, maliyet, kullanıcı |
| `read-side.test.ts` | 15 | Veri sınıfı politikası, proje kapsamı, cursor |

Her uç için üç soru: **yetkisiz erişim reddi**, **mutlu yol** (gerçek alanlar),
**hatalı girdi reddi**. Ağ/LLM çağrısı yok; hepsi fikstür ve sahte port.

---

## 8. ARAYÜZ İSTEKLERİ

**Yok.** `packages/contracts` ve `packages/ports` değiştirilmedi ve
değiştirilmesi gerekmedi. Studio'nun istediği her alan ya mevcut bir kontrat
tipiyle ya da BFF'e ait bir okuma modeliyle karşılandı.

Katalog anahtarı da eklenmedi: `notify.gate_reminder` (`{ticket}`, `{gate}`,
`{days}`) zaten tr+en olarak mevcuttu; `BFF_MESSAGE_KEYS.gateReminder` olarak
kaydedildi, böylece açılıştaki katalog kontrolü artık onu da kapsıyor.

**Bir gözlem (istek değil):** `MaestroPlatform.quotaStatus`, `usedTokens`/
`limitTokens` ister; abonelik kotası ise token değil **pencere yüzdesi** ile
ölçülür (M55). 0-100 ölçeğinde raporlandı, böylece iki sayı bölünebilir bir
oran. İleride arayüz `usedPct` alanına geçerse daha dürüst olur — ama bu
dondurulmuş bir arayüz olduğu için değiştirilmedi.

---

## 9. Yapılmayanlar ve nedenleri

1. **Yazma uçları (template, variant, knowledge dosyası, onboarding sihirbazı,
   PII kuralları, bildirim kanalı anahtarları).** Mock'ta bunlar düğmeli; ancak
   her biri kendi versiyonlama + 4-göz + pinleme semantiğini gerektiriyor
   (M83: çalışan akışlar başladıkları sürümle biter). Yarım bir yazma yüzeyi,
   veri bütünlüğü açısından hiç olmamasından kötüdür. Okuma yüzeyi ve
   `MaestroPlatform` bu paketin kapsamıydı.

2. **Canlı akış (SSE/WebSocket).** Mock'un `live` ve `sandbox` ekranları log
   akışı gösteriyor. Kalıcı bağlantı, kill switch ve oturum sonlandırma ile
   kendi etkileşimini taşır; REST yüzeyi oturmadan eklemek erken.

3. **`/studio/users` liste ucu.** Tek kullanıcı okuması var; liste, dizin
   senkronizasyonu (M8 LDAP) sahibi olduğunda ona ait olmalı — BFF'in kendi
   sayfalamasını AD'nin üstüne koymak yanlış katman.

4. **Analiz/diff/test sekmelerinin içerikleri.** `AnalysisDoc` kontratı var ama
   üretimi Dalga 2/3'ün analyst adımına ait; okuma modeli hazır olduğunda
   `/studio/runs/:ticket/analysis` tek dosyalık bir ek olur.

5. **Global arama (`gSearch`).** `/studio/runs?q=` olarak eklenebilirdi; mock'ta
   `k + " " + t` üzerinde çalışıyor. Kapsam dışı bıraktım çünkü gerçek bir
   arama, knowledge index'iyle aynı veri sınıfı süzgecinden geçmeli ve bu
   ayrı bir tasarım kararı.
