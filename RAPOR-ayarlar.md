# RAPOR — Ayarlar bağlantı listesi gerçeğe uyduruldu

Dal: `gap-b10-b14-pii-changetype-audit-realmerge` (worktree `e001452` üzerine)

## Soru neydi
Banka mimarı sordu: **"ayarlardaki motor ayarları neden yok?"** Haklıydı. `/settings` ucu sekiz
bağlantı döndürüyordu — `jira ado vault storage egress_proxy identity siem publish` — ve platformun
üzerinde koştuğu **iş akışı motoru listede yoktu**. Operatör "motor nereye bağlı, ayakta mı"
sorusunu bu ekrandan soramıyordu.

İkinci kusur daha sinsiydi: Jira **yanlış değişkeni** okuyordu.

## Eklenen dört satır

| id | uç nokta | kaynak | probe |
|---|---|---|---|
| `temporal` | `TEMPORAL_ADDRESS` | `@maestro/config` EnvSchema | **`temporalProbe`** (gerçek yoklama) |
| `database` | `DATABASE_URL` — **maskeli** | aynı | **`postgresProbe`** (gerçek yoklama) |
| `llm` | `LLM_BASE_URL (LLM_MODEL)` | `DeployEnvSchema` | yok → `configured` |
| — | kimlik referansı `LLM_API_KEY_REF` | aynı | — |

`temporal` ve `database` satırları **gerçekten yoklanıyor**. Bir değişkenin dolu olması motorun
cevap verdiğinin kanıtı değildir; ölü bir motorun üzerinde yanan yeşil ışık bu ekranın söyleyebileceği
en pahalı şeydir. İkisi de `read.health`'in *aynı* probe setini okuyor — ikinci bir set kurmak,
sağlık ekranının kırmızı dediğine ayarlar ekranının yeşil demesine izin verirdi.

`llm`'in probe'u **yok**, o yüzden `connected` demiyoruz gerçek anlamda — mevcut `statusOf`
kuralı korundu: probe yoksa "yapılandırılmış" anlamında raporlanır, `checkedAt` **null** kalır.

## Jira değişken düzeltmesi — çalışan bir bağlantı bozuk gösteriliyordu

`settings-env.ts` yalnızca `env.JIRA_BASE_URL` okuyordu. Canlı ortamda değişkenin adı
**`JIRA_CLOUD_BASE_URL`**. Sonuç: Jira bağlı ve 16 koşu işlemişken ekran `endpoint: ""` ve
`status: "unconfigured"` gösteriyordu — **operatörü var olmayan bir sorunu kovalamaya iten** bir
yalan.

Düzeltme: `firstConfigured(env.JIRA_CLOUD_BASE_URL, env.JIRA_BASE_URL)`. Cloud ve DC **iki ayrı
sürücü**, iki ayrı kimlik şeması (Cloud `Basic email:token`, DC `Bearer` PAT); bir kurulum
hangisini kullanıyorsa onu set eder. Sıralama `apps/deploy/src/driver-config.ts`'teki
`jiraCloudConfig` ile **birebir aynı**, böylece ekran iş portunun gerçekten baktığı siteyi adlandırıyor.

Aynı çözümleme `publish` (Confluence) satırına da taşındı — aynı siteye, aynı token ile biniyor,
aynı sebeple yapılandırılmamış görünüyordu.

`JIRA_CLOUD_BASE_URL` `EnvSchema`'ya eklendi (donmuş değil). **`REQUIRED_IN_PROD`'a bilerek
eklenmedi**: `JIRA_BASE_URL` zaten "bir Jira yapılandırılmış" demek, ikisini birden şart koşmak var
olan her Data Center kurulumunun açılmasını reddederdi.

## Maskeleme yaklaşımı

`DATABASE_URL` `scheme://kullanıcı:parola@host:port/db` taşır. Uç noktayı göstermenin **bütün amacı
host** — bu platform hangi veritabanına bakıyor. Parola bu cevabın parçası değil ve olamaz: bu dize
bir tarayıcıda render ediliyor, ticket'lara ekran görüntüsü olarak giriyor ve arkasındaki log
toplayıcıya gidiyor.

`maskEndpointCredentials` (`apps/bff/src/stores/settings-wiring.ts`):

- **Yapısal ayrıştırma** (`new URL`), metin üzerinde regex **değil**. Bir parola yasal olarak `@`,
  `/` ve `:` içerebilir; mutlu yola göre yazılmış bir regex böyle bir parolanın kuyruğunu sessizce
  geçirir. Test bunu doğruluyor (`p%40ss%2Fword`).
- Kullanıcı **yaşar** (rolü adlandırır, operatörün ihtiyacı var), parola `***` olur:
  `postgresql://maestro:***@db.bank.local:5432/maestro`.
- `URL`'nin ayrıştıramadığı değer **bütünüyle saklanır** (`(set; unreadable form withheld)`), olduğu
  gibi gösterilmez. Şeklini tespit edemediğimiz değer, tahminle ekrana basılacak **son** değerdir.

`LLM_API_KEY_REF` bir SecretPort **anahtarı** (`kv/llm#apikey`) — işaretçi, anahtar değil; çözüldüğü
süreçten hiç çıkmıyor (M9). `MAESTRO_SECRET_*` değerlerinin hiçbiri bu yola girmiyor.

## Yapmadıklarım — bilerek

- **Gerçekten yapılandırılmamış olanı listeden çıkarmadım.** `ADO_BASE_URL`, `VAULT_ADDR`,
  `STORAGE_ENDPOINT`, `EGRESS_PROXY_URL` canlı ortamda yok; `unconfigured` görünmeleri **doğru**.
  Dosyadaki `siem` yorumunun kararı: tablodan eksik bir bağlantı "platformun parçası değil" diye
  okunur, denetim iletimi ise fazlasıyla öyledir (M33). Bir test bunu koruyor.
- **LLM değişkenlerini `EnvSchema`'ya kopyalamadım.** `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY_REF`
  `DeployEnvSchema`'da tanımlı ve `secret-names.test.ts` `MAESTRO_SECRET_*` adlarını **o dosyanın**
  `*_REF` varsayılanlarından türetiyor. İkinci bir şema, varsayılanların ayrıştığı gün ekranın hiçbir
  şeyin aramadığı bir uç noktayı raporlamasıyla biterdi. Onun yerine `LlmWiring` olarak bağlama
  noktasından (`apps/deploy/src/bin/bff.ts`) enjekte ediliyor.
- **Studio ekranına tablo eklemedim.** `Settings.tsx` salt-okunur "deployment facts" tablosunu daha
  önce bilerek kaldırmış (dosyadaki gerekçe: düzenlenebilir panelle aynı başlık altında
  tekrarlıyordu). Görev BFF ucunu gerçeğe uydurmaktı; UI'a geri koymak ayrı bir karar ve o kararı
  vermek bana düşmez. **Kullanıcıya sorulacak:** `/settings` artık doğru cevabı veriyor ama Studio
  onu göstermiyor. Katalog anahtarları (`settings.connection.{temporal,database,llm}`, tr+en)
  hazır — ekran istenirse eklenmesi küçük iş.

## Testler

`apps/bff/test/settings-env.test.ts` — **22 test**, hepsi yeşil. Ayrıca mevcut
`apps/bff/test/settings.test.ts` (22 test) bozulmadı.

Kanıtlananlar:
- `JIRA_CLOUD_BASE_URL` doluyken Jira `connected`, uç nokta doğru; yalnız `JIRA_BASE_URL` doluyken de;
  ikisi birdense Cloud kazanıyor; hiçbiri yoksa `unconfigured`.
- `DATABASE_URL` parolası ne uç nokta alanında ne de **serileştirilmiş tablonun tamamında** geçiyor
  (tek alanı yoklamak, sır başka alandan sızarken geçerdi).
- Motor satırı probe sonucunu yansıtıyor: `healthy → connected`, `down → degraded`,
  adres yokken `unconfigured` (asla `degraded` değil — "kurulmamış" ile "bozuk" farklı işler).
- Probe'suz satır (`identity`) hak etmediği bir `checkedAt` damgası taşımıyor.

## Mutasyon kanıtı

1. **Maskelemeyi kaldır** (`maskEndpointCredentials` içinde `return dsn`) → **3 test kırıldı**:
   `expected 'postgresql://maestro:s3cr3t-pw@db.ban…' not to contain 's3cr3t-pw'`, serileştirilmiş
   tablo testi, ve `@`/`/` içeren parola testi. Geri alındı.
2. **Jira düzeltmesini geri al** (`endpoint: env.JIRA_BASE_URL`) → **3 test kırıldı**: Cloud sitesi,
   iki-ad önceliği, publish satırı. Geri alındı.

## Kapı

`pnpm exec turbo run typecheck test --force --concurrency=1` → **exit 0, 64/64 görev**.

Öncesinde varsayılan eşzamanlılıkla bir kez `@maestro/pii#test > egress-gate` düştü
(`PiiLeakError … iban`). Tek başına koşuldu → **13/13 yeşil**. Dokunmadığım pakette, yük altında
flake; HANDOFF bunu zaten belgeliyor.

## ARAYÜZ İSTEKLERİ

**Yok.** `ConnectionView`/`SettingsReader` `apps/bff/src/deps.ts`'te, `packages/contracts` ve
`packages/ports` **donmuş** kaldı — hiçbirine dokunulmadı. `packages/config`'teki `EnvSchema`'ya
tek alan eklendi (`JIRA_CLOUD_BASE_URL`), o donmuş değil.

## Dosyalar

- `apps/bff/src/stores/settings-env.ts` (236 satır) — satırlar + Jira düzeltmesi
- `apps/bff/src/stores/settings-wiring.ts` (94 satır, **yeni**) — değer kuralları: `firstConfigured`,
  `maskEndpointCredentials`, `llmEndpoint`, `LlmWiring`
- `apps/bff/test/settings-env.test.ts` (243 satır, **yeni**) — 22 test
- `apps/bff/src/index.ts` — yeni modülün dışa aktarımı
- `apps/deploy/src/bin/bff.ts` — LLM üçlüsünün bağlanması
- `packages/config/src/env.ts` — `JIRA_CLOUD_BASE_URL`
- `packages/config/locales/{tr,en}.json` — üç yeni anahtar, **tr+en parite korundu**; `jira` etiketi
  "Jira DC" → "Jira (Cloud / DC)" (artık ikisini de okuyor, eski etiket yanıltıcıydı)
