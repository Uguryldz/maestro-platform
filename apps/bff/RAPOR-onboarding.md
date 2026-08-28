# RAPOR — Onboarding ve repo-politikası uçları

**Branch:** `worktree-agent-a8f77d91402e5cf17` (main'e merge edilmedi)
**Taban commit:** `528481d`

Studio'nun "Yeni proje sihirbazı" (`/onboard`) ve ".maestro.yaml" (`/yaml`) ekranlarının
arkası bağlandı. İkisi de önceden `{"error":"not_found"}` dönüyordu.

## Yazılan uçlar

| Metot | Yol | Kim erişebilir | Ne yapar |
|---|---|---|---|
| GET | `/onboarding/options` | admin, tech-lead | Bağlanabilir Jira projeleri, ADO repoları, platform profilleri |
| POST | `/onboarding/dry-run` | admin, tech-lead | Kuru koşum: projenin **gerçek** koşu geçmişini M99 katmanlarına ayırır |
| POST | `/onboarding` | admin, tech-lead | Bağlamayı **öneri** olarak dosyalar (4-göz). **202**, 201 değil |
| GET | `/repo-policy` | admin, tech-lead | Her uygulamanın `.maestro.yaml` görünümü |
| GET | `/repo-policy/:appId` | admin, tech-lead | Tek uygulama |
| GET | `/repo-policy/:appId/protected-paths` | admin, tech-lead | Deny-list, iki yarım hâlinde |
| POST | `/repo-policy/:appId/protected-paths` | admin, tech-lead | Repo eklemesi ekler |
| DELETE | `/repo-policy/:appId/protected-paths/:path` | admin, tech-lead | Repo eklemesi siler; **varsayılanı reddeder** |

### Sözleşme ekrandan alındı, ekrana uyduruldu
`Onboard.tsx`, `onboard/OnboardingSteps.tsx`, `onboard/DryRunPanel.tsx`, `Yaml.tsx`,
`yaml/ProtectedPaths.tsx` ve `screens/common/{onboarding-api,admin-api}.ts` okundu.
`apps/studio/` altına **hiçbir şey yazılmadı**.

**Görev tanımından sapma (ekran böyle istiyordu):** görevde
`GET/PUT /repo-policy/:appId/protected-paths` deniyordu. `ProtectedPaths.tsx` ise
**POST** (ekle) + **DELETE `/:path`** (sil) çağırıyor. Ekran sözleşmeyi belirlediği için
PUT değil POST+DELETE yazıldı. PUT zaten kötü bir şekil olurdu: istemci listeden bir
varsayılanı eksik göndererek "silme mi, bayat kopya mı" ayrımını sunucuya bırakırdı;
"şunu ekle"de bu belirsizlik yok.

## Kritik davranışlar — hepsi test + canlı doğrulandı

- **`POST /onboarding` uygulamaz.** `ParamStore.putPending` ile öneri yazar (guarded
  param ve kill-switch ile **aynı** 4-göz kuyruğu), `202 pending_four_eyes` döner.
- **Kuru koşum gerçek.** `WorkflowRun` satırlarını okur, her satırın kendi
  `MatchResult`'ını contract'ın validator'ından geçirir. Sabit metin yok.
  Bozuk `matchJson` → `unresolved` (fail-closed). Aynı ticket'ın iki koşusu tek sayılır.
  `sampled: 0` alanı "geçmiş yok" ile "hepsi çözüldü"yü ayırır.
- **Korumalı yol varsayılanları silinemez.** `DEFAULT_PROTECTED_PATHS`
  (`@maestro/execution`, runner'ın uyguladığı **aynı** liste) → 409
  `protected_path_is_default`. Sessiz no-op değil. Varsayılanın repo kopyasını
  eklemek de reddedilir (yoksa DELETE onu silip operatöre "varsayılanı sildim"
  dedirtirdi).
- **Derlenemeyen glob reddedilir** (`compileProtectedPath`). Hiçbir şeyle eşleşmeyen
  bir deny-list satırı, review'da koruma gibi okunup runtime'da koruma sağlamaz.
- **Kill switch** açıkken her iki yazma ucu da reddeder (`assertWritable`).
- **Bağlanmamış/başkasının projesi** reddedilir: `active`/`paused`/`dry_run` → 409.
  `draft` ve `unbound` bağlanabilir.
- **Sayfalama** üst sınırlı (`limit=5000` → 400).
- Kayıt bulunamazsa **404**, boş nesne değil. Read model bağlı değilse adıyla reddeder.

## Testler

**45 yeni test**, hepsi gerçek assert'li, ağ çağrısı yok:
- `apps/bff/test/onboarding.test.ts` — 17
- `apps/bff/test/repo-policy.test.ts` — 19
- `apps/deploy/test/read-onboarding.test.ts` — 9

`pnpm run gate` → **exit 0, 60/60 görev** (2m55s).

Not: yüklü makinede kapı flake yapıyor (HANDOFF'ta yazan tuzak; load average
bu koşular sırasında 8 çekirdekte **39**'a çıktı). Ara koşularda tamamı
**5 sn timeout** olan hatalar görüldü — çoğu benim dokunmadığım süitlerde
(`auth`, `params`, `webhooks-jira`, `studio-catalog`, hatta koduma hiç bağlı
olmayan `@maestro/storage`). İzole koşumların hepsi yeşil: `@maestro/bff`
**410/410**, `@maestro/workflows` **122/122**, `@maestro/storage` **210/210**,
`@maestro/deploy` typecheck temiz. Makine sakinleşince kapı 60/60 geçti.

`ReadModels`'a iki model eklemek **dört** yerde derleme hatası verdi ve hepsi
kasıtlı bir bekçi olduğu için düzeltildi, susturulmadı:
`apps/bff/test/helpers.ts`, `apps/deploy/test/{read-live,read-models,worker-boot}.test.ts`
ve `apps/demo-stack/src/deps.ts`. Demo yığını da gerçek (kendi envanterinden
türetilmiş) onboarding/policy verisiyle bağlandı — refuse eden stub değil.
`read-models.test.ts`'teki sabit "12" sayıları `EXPECTED_MODELS.length`'e
çevrildi; sayı büyüdüğünde tekrar kırılmasın diye.

## Canlı kanıt

Kendi Postgres'im (`maestro-onboarding-pg`, port 55441), migration 0001-0004,
demo seed (5 uygulama, 5 bağlama, 22 koşu), BFF kaynaktan `127.0.0.1:7051`.

```
GET  /onboarding/options                    200
  {"jiraProjects":["UGURDESK","UGURKREDI","UGURMOB","UGURPAY","UGURWEB"],
   "adoRepos":["ugurmasaustu","ugurmobil-android","ugurmobil-ios","ugurpay","ugurweb"],
   "platforms":["linux-android","linux-node","macos-xcode","windows-dotnet"]}

POST /onboarding/dry-run  (UGURMOB)         200
  {"byRule":["UGURMOB-188","UGURMOB-166"],"bySuggestion":["UGURMOB-201"],
   "unresolved":[],"sampled":3,"projectKey":"UGURMOB","appId":"ugurmobil-ios"}
  -> 2 rule + 1 ai_suggestion: DB'deki gerçek matchJson değerleriyle birebir

POST /onboarding/dry-run  (UGURPAY, active) 409  project_already_bound
POST /onboarding          (UGURKREDI)       202
  {"proposalId":"onboarding.binding:UGURKREDI:2026-08-10T09:06:07.574Z",
   "status":"pending_four_eyes","approverGroup":"maestro-admins"}

GET    /repo-policy                         200  (5 uygulama)
GET    /repo-policy/ugurpay/protected-paths 200  (26 varsayılan + repo eklemeleri)
POST   /repo-policy/ugurpay/protected-paths 200  (src/ledger/** eklendi)
DELETE .../protected-paths/**%2Fmigrations%2F**  409  protected_path_is_default
GET  /onboarding/options  (kimliksiz)       401  unauthenticated
GET  /onboarding/options  (developer)       403  role_required {anyOf:[admin,tech-lead]}
GET  /onboarding/options?limit=5000         400  invalid_page
```

Yazma sonraki okumada kalıcı (override birleştirme):
```
GET    /repo-policy/ugurpay                 []
POST   .../protected-paths src/ledger/**    ['src/ledger/**']
GET    /repo-policy/ugurpay                 ['src/ledger/**']   <- kalıcı
GET    /repo-policy (liste)                 [['src/ledger/**']] <- listede de var
DELETE .../protected-paths/src%2Fledger%2F** 200
GET    /repo-policy/ugurpay                 []
```

Denetim izi (hash zinciri, seq 77-78):
```
onboarding:UGURKREDI  PARAM_CHANGED  actor=ugur.yildiz@ugurbank.local
  meta={appId:ugurpay, proposal:onboarding_binding, triggerMode:opt_in, ...}
repo-policy:ugurpay   PARAM_CHANGED  actor=ugur.yildiz@ugurbank.local
  meta={change:PROTECTED_PATH_ADDED, path:"src/ledger/**"}
```

## Tarayıcı kanıtı

Studio `127.0.0.1:7050`, `MAESTRO_BFF_ORIGIN=http://127.0.0.1:7051`.

- **"Uygulama ekle" (`/onboard`)**: "yayında değil" **yok**. Jira projesi ve ADO reposu
  select'leri gerçek verilerle dolu. UGURMOB + ugurmobil-ios seçilip "Kuru koşum yap"
  tıklandı → ekranda **"kural eşleşti: 2 · AI önerisi + insan doğrulaması: 1 ·
  atama gerekir: 0"**. curl sonucuyla birebir aynı.
- **".maestro.yaml" (`/yaml`)**: "yayında değil" **yok**. 5 uygulama sekmesi.
  26 platform varsayılanı **"kaldırılamaz"** rozetiyle, silme düğmesi **olmadan**
  listeleniyor. `yamlPresent=false` olan `ugurmasaustu` için uydurma build komutu
  değil, "gözlenmedi" açıklaması render ediliyor.

## ARAYÜZ İSTEKLERİ (dondurulmuş paketler — değiştirmedim)

1. **`WorkPort`'ta ticket arama yok.** `packages/ports/src/work.ts` yalnız
   `getTicket(key)` sunuyor; "son N ticket"i Jira'dan çekmenin yolu yok. Kuru koşum bu
   yüzden **Jira'yı değil, `WorkflowRun` geçmişini** replay ediyor. Bu dürüst bir
   ölçüm (gerçekten nereye düştüklerini okur) ama **hiç koşusu olmayan yeni bir proje
   için kuru koşum `sampled: 0` döner** — yani pilotta ilk bağlanan proje için kuru
   koşum kanıt üretemez. `WorkPort.searchTickets(projectKey, limit)` gerekli.

2. **`ERROR_KEYS` tablosu `apps/studio/src/api/errors.ts`'de ve bana salt-okunur.**
   Yeni kodlarım (`unknown_project`, `project_already_bound`, `platform_mismatch`,
   `proposal_open`, `invalid_onboarding_body`, `invalid_path`, `invalid_path_pattern`,
   `protected_path_is_default`, `protected_path_exists`, `protected_path_unknown`)
   tabloda olmadığı için `error.unexpected`'a düşüyor — **çeviri bozulmuyor** (ham kod
   asla basılmıyor, tr/en pariteyi bozmadım) ama kullanıcı "Beklenmeyen bir hata"
   görüyor; oysa sunucu "bu proje zaten bağlı" diyor. Studio sahibinin
   `ERROR_KEYS` + `locales/{tr,en}.json`'a bu 10 anahtarı eklemesi gerekiyor.
   Önerilen tr metinleri raporun sonunda.

## Bulunan (benim olmayan) kusur

**Demo seed'in `userId` formatı denetim zincirini kırıyor.**
`packages/db/src/demo/registry.ts` kullanıcıları `u-ugur` gibi id'lerle yazıyor.
`PrismaUserDirectory` bunu `userId` olarak veriyor, `sessionActor` audit actor'ü
yapıyor, `assertActor` ise `user@corp` beklediği için **reddediyor** → denetim yazan
her uç 500 veriyor.

Bu **benim uçlarıma özgü değil**: canlı olarak **`POST /killswitch`** (wave-1 kodu,
`killswitch-service.ts:40`) de aynı `AuditActorError` ile 500 verdi. Kanıt
`/tmp/bff-onboarding.log`'da iki ayrı stack trace olarak duruyor.

Düzeltmedim (görev kapsamım değil, `packages/db` başka bir ajanın alanı). Doğru
düzeltme muhtemelen `PrismaUserDirectory`'nin `userId`'yi `email`den türetmesi ya da
seed'in id'leri `user@corp` yazması. Ben canlı doğrulama için yerel olarak
id'leri e-postaya eşitledim.

## Yapmadıklarım

- **Öneriyi onaylayan uç yazmadım.** `POST /onboarding` öneriyi kuyruğa koyar;
  ikinci kişinin onaylayıp bağlamayı gerçekten yazacağı uç yok. Ekran da istemiyor
  (sadece `{proposalId}` bekliyor). Bağlamayı uygulamak `JiraProjectBinding` yazmak
  demek ve bu ayrı bir iş — pilotta öneriler `/params` ekranındaki pending
  kuyruğunda görünür.
- **Korumalı yol yazımı repoya PR açmıyor.** Yazma parametre deposuna gidiyor
  (`repo.protected_paths`, uygulama kapsamlı); okuma ise hem en yeni koşunun
  `protectedPathsJson` sütununu hem de bu parametreyi okuyup **parametreyi
  üstün tutuyor** — yani bir ekleme/silme sonraki okumada görünüyor (test +
  canlı doğrulandı). Ama `.maestro.yaml`'ın **asıl kopyası repoda**; ekranın
  kendi notu da bunu söylüyor. Kalıcı doğru çözüm repoya PR açmak, o da
  publish/PR mekanizmasını gerektirdiği için bu görevin kapsamı dışında.
  Şu hâliyle: platform bir override tutuyor, repo dosyası değişmiyor.
- Yeni migration yazmadım (mevcut tablolar yetti).

## Önerilen çeviri anahtarları (Studio sahibine)

```
error.unknown_project        Böyle bir Jira projesi yok.
error.project_already_bound  Bu proje zaten bağlı; önce mevcut bağlamayı kaldır.
error.platform_mismatch      Seçilen platform profili reponunkiyle uyuşmuyor.
error.proposal_open          Bu proje için bekleyen bir öneri var.
error.invalid_onboarding_body Sihirbaz alanları eksik veya geçersiz.
error.invalid_path           Yol boş olamaz.
error.invalid_path_pattern   Desteklenmeyen glob deseni; yalnız * ? / ve [A-Za-z0-9._-].
error.protected_path_is_default Bu bir platform varsayılanı; kaldırılamaz.
error.protected_path_exists  Bu yol zaten listede.
error.protected_path_unknown Bu yol listede değil.
```
