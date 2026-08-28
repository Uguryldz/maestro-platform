# RAPOR — `@maestro/runners` (Dalga 2)

`RunnerPort`'un **docker-linux** sürücüsü (M21): efemer, sertleştirilmiş konteyner (M23/M24),
egress proxy'si (M26), dijest-pinli imaj (M27), 3 katmanlı cache'in ① ve ② katmanları (M31),
çalışma alanı yaşam döngüsü (M65) ve win/mac ajanları için **yalnız protokol iskeleti** (M22).
Kod/yorum/test adları İngilizce (M59); bu rapor Türkçe.

## 1. Ne yapıldı

| Dosya | İçerik |
|---|---|
| `src/deps.ts` | Enjekte edilen işbirlikçiler: `Clock`, `Timer` (iptal edilebilir gecikme), `IdSource`, **`DockerTransport`** (bayt boru hattı), `AuditSink` + `RUNNER_ACTOR`. Paketin tamamı bu arayüzlerin üstünde durduğu için varsayılan test paketi **hiç soket açmaz**. |
| `src/errors.ts` | Tipli hatalar: `RunnerConfigError`, `RunnerCapacityError`, `RunnerLeaseError`, `RunnerKeyError`, `DockerHttpError`, `DockerResponseError`, `AgentProtocolError`. **Kural:** hata metni ne sorulduğunu (konteyner adı, imaj, durum kodu) söyler, işin `env`'ini/komut yükünü ASLA taşımaz (kısa ömürlü token'lar orada — M80). |
| `src/config.ts` | Zod yapılandırması: `SandboxProfile`, `EgressConfig`, `WorkspaceConfig`, `PlatformSlot`, `DockerRunnerConfig`, `ImageRef` (dijest zorunlu), `isProductionStage`, **`profileIssues`** (sertleştirme kapısı, şemadan ayrı ve doğrudan test edilebilir). |
| `src/http.ts` | Elle yazılmış minimal HTTP/1.1: `encodeRequest` · `decodeResponse` (content-length **ve** chunked **ve** close-delimited) · `query`. `dockerode` YOK. |
| `src/docker-client.ts` | Engine API'sinin dar dilimi: create/start/wait/kill/remove · logs (+`demultiplex`) · volume create/remove · image inspect · `_ping`. Durum→hata eşlemesi, gövde kırpma, `tail()`. **exec / image push / swarm bilinçli olarak yok** (M24 dar API). |
| `src/unix-transport.ts` | `node:net` ile unix soket taşıması — ağa dokunan **tek** dosya. |
| `src/sandbox.ts` | **`buildContainerSpec`**: yapılandırma+iş → Docker create yükü. Saf fonksiyon; profil bir güvenlik kontrolü olduğu için konteyner başlatmadan doğrulanabilmesi şart. `sandboxEnv`, `sandboxBinds`, `egressNetworkMode`, `containerName`, `cacheIsWritable` ve **`buildPrepareSpec`** (workspace devir konteyneri) de saf. |
| `src/provision.ts` | Spec'in söyleyemediği iki önkoşul: **egress ağının gerçekten `Internal: true` olduğunun daemon'a sorulması** (M26) ve **workspace volume'ünün sandbox uid'ine devredilmesi** (M30/M31). Ayrıca audit'li workspace silme + M65 süpürme raporu. |
| `src/agent-registry.ts` | `AgentRegistry`: **kimlik doğrulamalı** kayıt (`sharedSecretAuthenticator`, sabit zamanlı karşılaştırma), açık **devralma** kuralı, **platform sahipli lease tablosu** (`assignLease`/`completeLease`), heartbeat/süre dolumu/kapasite görünümü. |
| `src/pool.ts` | `RunnerPool`: platform başına slot, `acquire` (kuyruk yok, fail-closed), `slotOf` (bilinmeyen/serbest bırakılmış/yabancı lease ayrımı), `beginSession`/`endSession` (meşgul runner'a ikinci iş verilmez), **idempotent `release`**, `attachCache`, `snapshot`. |
| `src/docker-runner.ts` | `DockerLinuxRunner implements RunnerPort`: `acquire`/`runSession`/`mountCache`/`release` + port dışı `removeWorkspace`, `sweepExpiredWorkspaces`, `ping`, `snapshot`. M23 zaman aşımı yarışı ve öldürme burada. |
| `src/agent-protocol.ts` | M22 şemaları (`AgentRegister`/`AgentHeartbeat`/`AgentBye` → `AgentMessage`; `RegisterAccepted`/`HeartbeatAck` → `PlatformReply`). **Sunucu/dinleyici yok** — taşıma Dalga 3. |
| `src/register.ts` | `registerRunnerDrivers(registry, deps)` (M44 DI), `createDockerLinuxRunner`, `resolvePinnedImage` (tag → dijest, dağıtım aracı için). |
| `src/index.ts` | Dış yüzey. **`DockerClient` yalnız TİP olarak** dışa verilir (aşağıda §4). |
| `fixtures/*.http` | **Gerçek Docker Engine 29.4'ten kaydedilmiş ham HTTP yanıtları** (create/start/wait/wait-zero/logs/remove/404/volume create+inspect+404/network inspect **internal** ve **bridge** ve 404/ping/image inspect + `containers-start-bad-seccomp.http`). Testler hiçbir yanıt şeklini uydurmuyor. |

## 2. Sertleştirilmiş profil (M23/M24/M26/M27)

Hiçbir şey söylemeyen bir yapılandırmanın ürettiği konteyner:
`ReadonlyRootfs: true` · `CapDrop: ["ALL"]`, `CapAdd: []` · `no-new-privileges:true` ·
`User: 10001:10001` · `Memory`/`MemorySwap` eşit (**swap kapalı** — swap'layabilen limit, limit değildir) ·
`NanoCpus` · `PidsLimit` · `nofile` ulimit · `/tmp` için `rw,noexec,nosuid,nodev,size=…` tmpfs ·
`Init: true` · `RestartPolicy: no`, `AutoRemove: false` (kaldırmayı biz yönetiyoruz) ·
**`NetworkMode: "none"`** · imaj `repo@sha256:…` veya `sha256:…` olmak zorunda.

**Gevşetme açıkça istenir, üretimde hiç mümkün değildir.** Bir anahtarı kapatmak
`sandbox.allowUnsafeProfile` listesinde adını yazmayı gerektirir (`readonly-rootfs`,
`no-new-privileges`, `cap-add`, `seccomp`, `direct-egress`); `NODE_ENV` üretimse kaçış anahtarı da
çalışmaz. **`NODE_ENV` tanımsız, boş veya tanınmayan bir değerse üretim sayılır** — yalnız
`development` ve `test` (kırpılmış, küçük harfe indirgenmiş) kapıyı gevşetir. Kalıp
`@maestro/secrets/src/stage.ts`'teki `resolveStage` ile aynı: ortam yalnız **sertleştirebilir**.
`NODE_ENV` çoğu konteyner dağıtımında hiç set edilmediği için eski "tanımsız = üretim değil"
davranışı, üretim host'unda tüm gevşetmeleri sessizce açıyordu.

**`uid 0` ve `gid 0` her koşulda reddedilir** — kaçış anahtarı yok. Karşılaştırma **sayısaldır**
(`"00:0"`, `"000000:0"` Docker için de root'tur; dize karşılaştırması bunları kaçırıyordu) ve şema
`uid:gid`'i baştaki sıfırsız ondalık olarak sınırlar. Kapı hem Zod'da hem `buildContainerSpec`
içinde koşar: kodda elle kurulan bir profil de kapıyı atlayamaz.

**Egress (M26) — kontrol ağdır, ortam değişkeni değil.** Yapılandırma yoksa `NetworkMode: none`.
Ağ tanımlıysa:
- Ad dilbilgisi `^[a-z0-9][a-z0-9_.-]*$` ile sınırlıdır; `host`, `none`, `bridge`, `default` ve
  `container:<id>` **her aşamada** reddedilir (bunlar operatörün kurduğu ağ değil, namespace
  seçicisidir; `host` işe runner host'unun loopback'indeki tüm servisleri verir).
- İlk konteynerden **önce** daemon'a sorulur: ağ var mı, adı birebir aynı mı (Docker id ön eki de
  çözer) ve **`Internal: true` mi**. Değilse iş hiç başlamaz (fail-closed, `provision.ts`).
- Proxy değişkenleri (`HTTP(S)_PROXY`/`NO_PROXY`, iki yazımla) yine enjekte edilir ve iş bunları
  **ezemez** (`ALL_PROXY`/`all_proxy` dahil rezerve; `LD_PRELOAD`/`LD_LIBRARY_PATH`/`LD_AUDIT`/
  `NODE_OPTIONS`/`BASH_ENV` yasak). Ama **enjeksiyon bir kontrol değildir**: iş bu değişkenleri
  okumak zorunda değil. Önceki rapordaki "iş kendi egress'ini yeniden yönlendiremez" ifadesi bu
  yüzden yanlıştı — iş yeniden yönlendirmeye ihtiyaç duymuyordu, proxy'yi **yok saymak** yetiyordu
  (canlı kanıt: sıradan bridge ağında `nc -w 3 -z 1.1.1.1 443` başarılıydı). Ham TCP'yi kapatan şey
  ağın `Internal` olması; `MAESTRO_DOCKER_IT=1` bataryası tam bu probu koşuyor.
- Ağ tanımlı ama proxy tanımsızsa yapılandırma reddedilir (`direct-egress`).

**Zaman aşımı (M23):** `runSession` konteynerin çıkışını enjekte edilen zamanlayıcıyla yarıştırır;
bütçe kazanırsa konteyner **SIGKILL** ile öldürülür, loglar yine çekilir ve **kısmi çıktı**
`exitCode = 124` (`timeout(1)` konvansiyonu) ile döner. Sessizce takılma yok. Zaman aşımı bütçesi
`maxTimeoutSeconds` tavanının üstündeyse **kırpılmaz, reddedilir** ve bu doğrulama slot "meşgul"
işaretlenmeden önce yapılır (reddedilen bir iş lease'i kilitli bırakmaz).

## 3. Çalışma alanı ve cache (M31 / M65)

- **Katman ① bağımlılık cache'i:** `dependencyCacheKey({platform, tool, repo, lockfileHash})` — saf,
  ticket'a değil **repo+lockfile**'a bağlı; lockfile değişince anahtar değişir (bayat set yeniden
  kullanılamaz). `mountCache(lease, keys)` volume'ü oluşturur ve lease'e iliştirir; sonraki
  `runSession` onu **varsayılan olarak `:ro`** bağlar (bir ticket diğerinin cache'ini zehirleyemez).
  İş başına en çok 8 cache; sınır **tekilleştirilmiş** anahtar kümesi üzerinden sayılır.
  **Yazma yolu (yeni):** `workspace.cacheWritableKeys` — ısıtma (warm-up) işinin doldurabileceği
  anahtarlar tek tek yazılır; liste boş olduğu sürece davranış eskisi gibi salt-okunurdur. Hiç
  yazılamayan bir cache kalıcı olarak boştur, herkesin yazabildiği bir cache ise ticket'lar arası
  tedarik zinciridir — bu yüzden global anahtar değil, adlandırılmış istisna listesi.
- **Katman ② ticket çalışma alanı:** `workspaceVolumeName(key)` saf ve **injektif** (slug + tam
  anahtarın sha256'sının 12 hanesi) — iki ticket aynı volume'e düşemez. Anahtarın **ilk segmenti**
  (ticket kimliği) büyük harfe normalize edilir: Jira anahtarı büyük/küçük harf duyarsızdır, aksi
  hâlde aynı ticket iki volume'e düşüp M30 resume bağlamını kaybederdi; kalan segmentler (branch)
  **duyarlı** kalır, çünkü git'te `feature/Foo` ile `feature/foo` iki ayrı daldır.
  Volume, bind'in otomatik oluşturmasına bırakılmaz; `workspace.volumeDriver` + `volumeOptions` ile
  **açıkça** oluşturulur ki M31'in şifreli diskine (LUKS/fscrypt) yerleşsin ve M65 süpürücüsünün
  aradığı etiketleri taşısın.
- **Sahiplik devri (yeni, K4):** boş bir `local` volume Docker'da **root:root 0755** doğar, konteyner
  ise `10001:10001` ile koşar — yani devir olmadan `/workspace` işe **salt okunurdur**: klon yok,
  build yok, M30 Agent SDK oturum dosyaları yok. Volume ilk kez oluşturulduğunda (veya etiketteki
  sahip uid'i değiştiğinde) tek atımlık bir **hazırlık konteyneri** koşar: sabit argv
  (`mkdir -p` + işaret dosyası + `chown -R`), işten gelen hiçbir girdi yok, **ağ yok**, salt okunur
  rootfs, `CapDrop: ALL` + yalnız `CHOWN`,`FOWNER`, `no-new-privileges`, 256 MB/32 pid. Bu, paketin
  root koşturduğu **tek** yerdir; alternatifler ve neden bu seçildi:
  1. `local` sürücüsünde volume'e uid vermenin API'si yok (`o=uid=` yalnız tmpfs'te).
  2. İmajda hazır `/workspace` dizini işe yarar (Docker boş volume'ü imajdan doldururken sahipliği
     de kopyalar) ama **kurumun her imajından bunu istemek** gerekir; bu yol
     `workspace.prepareOwnership: false` ile açık bırakıldı (yalnız hata verdirebilir, yetki
     yükseltemez).
  3. Hazırlık konteyneri hiçbir imaj varsayımı yapmaz (yalnız `/bin/sh` + `chown` ister) ve
     başarısız olursa iş **hiç başlamaz** (fail-closed), hata mesajı 2. yolu önerir.
  Yazılan `.maestro-workspace` işaret dosyası volume'ü "boş değil" hâline getirir; aksi hâlde iş
  konteyneri bağlandığında Docker imajdan yeniden doldurup sahipliği geri alabilirdi.
- **Yaşam döngüsü:** `expiredWorkspaces(records, now, maxAgeDays=60)` saf; okunamayan tarihte
  **silmez** (fail-closed). `removeWorkspace(key, reason)` volume'ü **önce sorar**, sonra siler ve
  yalnız gerçekten silindiyse `RETENTION_ARCHIVE` yazar — `DELETE /volumes/{ad}?force=true` var
  olmayan volume için de **204** döndüğü için (Engine 29.4'te doğrulandı) "sildik" kaydı yoksa da
  yazılıyordu. `sweepExpiredWorkspaces()` artık kayıt başına hata yakalar ve
  `{swept, missing, failed[]}` döner: bir volume kullanımdayken (409) arkasındaki tüm workspace'ler
  sessizce atlanıyordu. `SANDBOX_CREATE`/`SANDBOX_DESTROY` kayıtları `AuditSink` üzerinden yayılır
  (paket `@maestro/audit`'e bağımlı değil; zinciri kompozisyon kökü kurar); hazırlık konteyneri
  kendi kayıtlarını `meta.purpose = "workspace-prepare"` ile ayırt edilebilir biçimde bırakır.

## 4. Dış yüzey kararı

`DockerClient` **değer olarak dışa verilmez** (yalnız tip). Sebep `@maestro/secrets`'taki
`VaultClient` ile aynı: istemci **herhangi bir** spec'ten konteyner oluşturabilir, yani onu dışarı
vermek bu paketin var oluş sebebi olan sertleştirilmiş profili atlamanın yolunu vermek olurdu.
Kompozisyon kökünün ihtiyacı olan her şey `registerRunnerDrivers` / `createDockerLinuxRunner` /
`resolvePinnedImage` üzerinden erişilebilir.

## 5. Gerçek Docker'a karşı doğrulama (ve bulunan 2 gerçek hata)

Fikstürler gerçek daemon'dan (Engine 29.4.1, API 1.54) ham baytlar hâlinde kaydedildi; opsiyonel
duman testi (`MAESTRO_DOCKER_IT=1`) gerçek konteyner koşturur. Bu iki adım, yalnız birim testiyle
**yeşil görünüp üretimde çalışmayacak** iki hatayı yakaladı:

1. **`SecurityOpt: ["seccomp=default"]` konteyneri başlatmıyor.** Engine `seccomp=` değerini bir
   profil dokümanı olarak ayrıştırıyor: `"Decoding seccomp profile failed"` (HTTP 500,
   `fixtures/containers-start-bad-seccomp.http`). Varsayılan seccomp filtresini **açık tutmanın**
   yolu bu anahtarı hiç göndermemek; `seccomp=unconfined` yalnız açıkça izin verilen gevşetmede yazılır.
2. **İsteği `socket.end()` ile göndermek HTTP 499 üretiyor.** Yazma yönünü yarı kapatmak daemon'a
   isteğin terk edildiğini düşündürüyor. Taşıma artık `socket.write()` kullanıyor; yanıtı bitiren şey
   `Connection: close`.

**Bu turda duman testi bir KAÇIŞ BATARYASINA dönüştürüldü** (aşağıda §10). Eski test yalnız
`id -u`'ya baktığı için bu turun bulgularının hiçbirini görmemişti. Batarya, spec'i değil
**konteynerin gerçek davranışını** çiviliyor ve kendisi de iki gerçek hata daha yakaladı:

3. **`DELETE /volumes/{ad}?force=true` var olmayan volume için 204 döndürüyor** (404 değil). "Sildik"
   sonucunu bu yanıttan okumak, hiç var olmamış workspace için `RETENTION_ARCHIVE` yazmak demekti;
   silme artık `GET /volumes/{ad}` ile önden doğrulanıyor.
4. **Busybox kopyası `argv[0]` ile applet seçiyor**: `cp /bin/busybox /workspace/b` sonrası `b id -u`
   "applet not found" veriyor. (Test kalitesi bulgusu — assertion'ın sahte yeşil vermesini önledi.)

Batarya ayrıca şunları canlı doğruluyor: `/workspace`'e **yazma ve bir sonraki oturuma taşınma**,
`CapEff/CapBnd = 0`, `NoNewPrivs = 1`, salt okunur rootfs, `/tmp` noexec, docker soketinin yokluğu,
bellek limitinde OOM (137), pid limitinde fork reddi, `su`/setuid ile uid 0'a çıkılamaması,
`Internal` ağda ham TCP'nin başarısız olması, `Internal` olmayan/eksik ağın reddi, `host` ve
`container:` adlarının reddi, zaman aşımında gerçek SIGKILL ve **hiçbir konteyner/volume/ağ
artığının kalmaması**.

## 6. Test özeti

`pnpm -F @maestro/runners test` → **224 test yeşil, 23 atlandı** (12 dosya + 3 opsiyonel batarya dosyası).
`MAESTRO_DOCKER_IT=1 pnpm -F @maestro/runners test` → **247 test yeşil** (batarya dahil; Docker
bataryası dosyaları sırayla koşar, `vitest.config.ts`).
Kök kapısı: `pnpm run gate` (önbelleksiz) → **38/38 görev yeşil**.

| Dosya | Test | Neyi çiviliyor |
|---|---|---|
| `http.test.ts` | 16 | İstek çerçeveleme, chunked/content-length/close-delimited çözme, **kısa gövdeyi reddetme** (kesik `wait` temiz çıkış gibi okunamaz), bozuk girdiyi tahmin etmeme |
| `docker-client.test.ts` | 25 | Uç şekilleri (kayıtlı yanıtlara karşı), durum→hata eşlemesi, gövde kırpma, çoklama çözme (TTY yedeği dahil), `tail` bayt sayımı |
| `config.test.ts` | 23 | En katı varsayılanlar, dijest-pin matrisi (**tag+digest dahil**), gevşetme kapısı, üretimde kaçış yok, **uid/gid 0'ın her yazımı**, **ağ adı allow/deny listesi**, runtime allow-list, **`NODE_ENV` tanımsız = üretim** |
| `sandbox.test.ts` | 27 | Profil alanlarının tamamı, seccomp kararı, egress modu, env yasakları (**`ALL_PROXY` dahil**), bind'ler ve **çivilenmiş volume adı**, etiketler, **uzun runId'lerin ad çakışmaması** |
| `workspace.test.ts` | 19 | Anahtar dilbilgisi (traversal/flag/boşluk), injektiflik, **ticket segmentinde büyük/küçük harf katlama**, cache anahtarı türetimi, M65 seçimi |
| `pool.test.ts` | 14 | Kapasite, meşgul runner, yabancı/serbest bırakılmış lease ayrımı, **idempotent release**, slot geri dönüşümü |
| `docker-runner.test.ts` | 21 | Uçtan uca çağrı sırası, zaman aşımında öldürme + kısmi çıktı + audit anahtarı, tavan reddi, hata yollarında temizlik, başarısız temizliğin kaydı |
| `retention.test.ts` | 13 | Cache/workspace volume **adı üretenle tüketenin aynı olması**, mount sınırının tekilleştirilmiş sayımı, silme/arşiv dürüstlüğü (**404 ve zorlanmış 204**), M65 süpürme raporu (**hatada devam**) |
| `provision.test.ts` | 16 | **Ağın `Internal` doğrulaması** (yoksa/başka adsa/bridge'se ret, konteynerden önce, bir kez), **workspace sahiplik devri** (spec, sıra, atlama, uid değişimi, hata yolu, audit), cache yazma yolu |
| `agent-protocol.test.ts` | 7 | Şema sınırları, sürüm/tip ayrımı, **kimlik bilgisinin şemada zorunlu olması**, yanıtlarda sızmaması |
| `agent-registry.test.ts` | 22 | **Kimlik doğrulama** (yanlış/başkasının/bilinmeyen; sabit zamanlı; hata metninde token yok), **açık devralma** + düşen lease'lerin iadesi, **platform sahipli lease tablosu** (boş beyanla sonsuz iş yok), kapasite, süre dolumu, ajan saatine güvenmeme |
| `register.test.ts` | 11 | M44 kaydı, yapılandırma hatalarının toplu raporu, `DockerClient` sızmıyor, **kaynakta sunucu/dinleyici yok** (M22 yön kontrolü) |
| `docker-it.test.ts` | 7 (opt-in) | Gerçek daemon: çıkış kodu + iki akım, non-root uid **ve** gid, **`/workspace` yazılabilir ve sonraki oturuma taşınıyor**, `HOME`, zaman aşımında SIGKILL + artık yok, kısmi çıktı, retention |
| `docker-it-escape.test.ts` | 10 (opt-in) | uid 0'ın her yazımının reddi, `CapEff/CapBnd = 0` + `NoNewPrivs`, `su`/setuid ile root olamama, docker.sock yok, salt okunur rootfs, `/tmp` noexec, mount yok, **OOM 137**, **fork bombası pid limitinde**, dijest-pin reddi |
| `docker-it-network.test.ts` | 6 (opt-in) | Ağsız varsayılanda ham TCP+DNS başarısız, **`Internal` ağda ham TCP başarısız**, proxy env yine veriliyor, **gerçek bridge ağının reddi**, olmayan ağın reddi, `host`/`container:` reddi |

Belirlenimcilik: saat, zamanlayıcı, id üreteci ve taşıma enjekte edilir; hiçbir test gerçek zaman
beklemez, `sleep` kullanmaz, ağ/soket açmaz.

## 7. Varsayımlar

1. **Docker soketi yalnız Runner Servisi'nde** (M24). Paket soketi yalnız `unix-transport.ts` içinden
   açar; yetkilendirme dosya sistemi izniyle (docker grubu) sağlanır — kod tarafında ek auth yok.
2. `RunJob.workspaceKey` iş akışından gelir ve ticket ömrü boyunca aynıdır (M30 resume bunun üstünde durur).
3. `Entrypoint: []` gönderilir: `RunJob.command` tam argv'dir, imajın entrypoint sarmalayıcısı devrede değildir.
4. Konteyner `HOME=/workspace` ile koşar (root olmayan kullanıcının yazabildiği tek kalıcı yer) —
   ve bu artık **doğrulanmış** bir varsayım, sahiplik devri sayesinde (§3, batarya).
5. Log okunamazsa boş tail dönülür (çıkış kodu maskelenmez) ve bu durum audit'e `logsUnavailable`
   olarak yazılır; konteyner silinemezse `removeFailed` kaydı düşer — sessiz yetim yok.
6. Hazırlık konteyneri imajda `/bin/sh` ve `chown` bulunduğunu varsayar. Distroless bir imajda
   `workspace.prepareOwnership: false` + imajda hazır (uid'e ait) `/workspace` gerekir; aksi hâlde
   iş **başlamaz** (sessizce yazamayan bir workspace ile koşmaz).
7. Ajan kimlik doğrulaması bir **paylaşılan sır** modelidir (`sharedSecretAuthenticator`); sırların
   nereden geldiği kompozisyon kökünün işi (M80/`@maestro/secrets`). mTLS'e geçilecekse
   `AgentAuthenticator` arayüzü değişmeden kalır.
8. Üretim kodu **1633 etkin satır** (yorum/boş satır hariç; ham 2399). Artış bu turun iki kontrolü:
   ağ doğrulaması + workspace sahiplik devri (`provision.ts`) ve ajan kimlik doğrulaması/lease
   tablosu (`agent-registry.ts`). Dosya başına tavan (≤300) **her** kaynak ve test dosyasında sağlanıyor.

## 8. Talepler (orkestratöre)

1. **M104 katalog anahtarı — `runner.session_timeout`.** Zaman aşımıyla biten oturum audit meta'sında
   bu anahtarı taşıyor; `packages/config/locales/{tr,en}.json` içine eklenmeli (config paketi
   düzenlenmedi). Önerilen TR metni: *"İş, tanımlı süre sınırında tamamlanamadı ve durduruldu"*.
   Kod tarafında kullanıcı metni **gömülü değil**, yalnız anahtar taşınıyor.
2. **`packages/ports/src/runner.ts` (DONUK — değiştirilmedi) için iki öneri:**
   - `RunResult`'ta zaman aşımı bilgisi yok. Şu an `exitCode: 124` konvansiyonuyla ifade ediliyor;
     temizi `RunResult.timedOut: boolean` olurdu (124'ü gerçekten döndüren bir iş ile ayırt edilemiyor).
   - `mountCache(lease, keys): Promise<void>` hangi anahtarların gerçekten bağlandığını döndürmüyor;
     `Promise<string[]>` olsaydı kısmi/az bağlanma iş akışında görünür olurdu.
   İkisi de bu turda **gerekli değil**; karar orkestratörde.
3. **Dağıtım gereksinimleri (kod değil, ortam):**
   - Egress proxy'si ve yalnız ona çıkan bir Docker ağı (`egress.networkName` + `proxyUrl`) — M26.
     **Ağ `--internal` olmak zorunda** (`docker network create --internal maestro-egress`); proxy
     konteyneri hem bu ağa hem dış ağa bağlanır. Sürücü ağı `Internal: true` görmezse hiç
     başlamaz — bu, "iş proxy'yi yok sayıp ham TCP açar" senaryosunu kapatan tek kontrol.
   - **Ajan paylaşılan sırları** (M22): her `agentId` için bir sır, kompozisyon kökünde
     `sharedSecretAuthenticator`'a verilir. Sırsız kayıt yok; "auth kapalı" modu yok.
   - Çalışma alanı volume'lerinin **şifreli diskte** durması: `workspace.volumeDriver` /
     `volumeOptions` bunun için var, şifrelemenin kendisi host provizyonu (LUKS/fscrypt) — M31.
   - Kurumsal imaj deposundan **dijest-pinli** imaj referansları; `resolvePinnedImage` tag→dijest
     çevirisini dağıtım anında yapmak için var (çalışma anında tag çözülmez) — M27.
   - gVisor kullanılacaksa (`sandbox.runtime: "runsc"`) daemon'a runtime tanımı — M23 Aşama 3.
4. **Kök kapısı (güncellendi).** Dal güncel `main` üzerine kuruldu; `pnpm run gate` (önbelleksiz)
   **38/38 görev yeşil**. Önceki rapordaki `@maestro/execution:typecheck` kırmızısı `main`'de
   kapanmış durumda — o uyarı artık geçersiz.
5. **`RunnerPort` dışı imza değişiklikleri (port DONUK, dokunulmadı):**
   - `removeWorkspace(key, reason): Promise<boolean>` (eskiden `void`) — "silindi mi" bilgisi
     olmadan audit dürüst olamıyordu.
   - `sweepExpiredWorkspaces(records): Promise<{swept, missing, failed[]}>` (eskiden `string[]`).
   - `AgentRegistry.register(msg): {reply, displacedLeases}` (eskiden `RegisterAccepted`), ve
     `AgentRegistry` artık `authenticate` bağımlılığı **istiyor**.
   Üçü de kompozisyon kökü henüz bu paketi bağlamadığı için başka paketi kırmıyor.
6. **Dalga 3'e bırakılanlar:** ajan taşıması (outbound gRPC/WebSocket), iş teklifi/sonucu mesajları,
   `agent-macos`/`agent-windows` sürücüleri. Bu pakette yalnız şemalar + kayıt/heartbeat mantığı var
   ve **içeri port açan hiçbir kod yok** (`register.test.ts` bunu kaynak taramasıyla koruyor).

## 9. Bağımlılıklar

Yeni çalışma zamanı bağımlılığı **yok**: `@maestro/contracts`, `@maestro/ports`, `zod` (mevcut),
ve Node yerleşikleri `node:crypto` (isim hash'i, sabit zamanlı karşılaştırma) + `node:net` (unix
soket). `dockerode` eklenmedi — Engine API istemcisi bu paket içinde, enjekte edilebilir taşımayla
yazıldı.

## 10. Bağımsız doğrulama turu (KALDI) — bulgu bazında durum

Her düzeltme **önce kırılan bir testle** yazıldı; aşağıdaki "test" sütunu o testi gösteriyor.

| # | Bulgu | Durum | Düzeltme + testi |
|---|---|---|---|
| **K1** | `uid 0` yasağı baştaki sıfırla atlatılıyor (`"00:0"` → konteynerde root) | **Kapandı** | Sayısal `uid`/`gid` karşılaştırması + `uid:gid` dilbilgisi (baştaki sıfır yok) + gid 0 de yasak. `config.test.ts` "refuses every spelling of uid 0…", "refuses gid 0…"; canlı: `docker-it-escape` "refuses every spelling of uid 0 before a container exists" |
| **K2** | `egress.networkName` doğrulanmıyor; `host`/`container:<id>` üretimde kabul | **Kapandı** | Ad dilbilgisi + rezerve ad reddi (her aşamada) **ve** başlangıçta `GET /networks/{ad}` ile `Internal: true` doğrulaması, konteynerden önce, fail-closed. `config.test.ts` "refuses the daemon's magic network names…", `provision.test.ts` (5 test), `docker-it-network` (3 test) |
| **K3** | M26 "egress yalnız proxy" hiç zorlanmıyor (ham TCP çıkıyor) | **Kapandı** | K2'nin `Internal` doğrulaması. RAPOR §2'deki yanlış iddia düzeltildi. `docker-it-network` "cannot open a raw socket to the internet on the internal egress network" (K3'ün birebir probu) |
| **K4** | `/workspace` root:root 0755 — iş kendi çalışma alanına yazamıyor | **Kapandı** | Volume ilk oluşturulduğunda tek atımlık, sabit argv'li, ağsız, `CapDrop: ALL` + `CHOWN`,`FOWNER` hazırlık konteyneri (gerekçe ve alternatifler §3'te); `prepareOwnership` kaçış anahtarı. Duman testine yazma **ve** sonraki oturuma taşınma assert'ü eklendi: `docker-it` "gives the job a writable workspace that survives into the next session", `provision.test.ts` (8 test) |
| **Y1** | `NODE_ENV` tanımsızsa üretim kapısı kapalı | **Kapandı** | `isProductionStage` fail-closed (tanımsız/boş/tanınmayan = üretim), `resolveStage` kalıbı. `config.test.ts` "closes the escape hatch when NODE_ENV is not set at all (Y1)" |
| **O1** | `containerName` uzun runId'lerde çakışıyor (409) | **Kapandı** | Ada `sha256(runId+leaseId)`'nin 12 hanesi eklendi, slug ona göre kırpılıyor. `sandbox.test.ts` "keeps long run ids apart…" |
| **O2** | `sweepExpiredWorkspaces` ilk hatada duruyor | **Kapandı** | Kayıt başına try/catch + `{swept, missing, failed[]}`. `retention.test.ts` "keeps sweeping after a failure…" |
| **O3** | 404'te bile `RETENTION_ARCHIVE` yazılıyor | **Kapandı** | Silmeden önce `GET /volumes/{ad}`; yalnız gerçekten silinen arşivleniyor. Batarya, `force=true`'nun **204** döndürdüğünü ortaya çıkardı — `retention.test.ts` "does not read the daemon's forced 204 as a deletion" |
| **O4** | M22'de kimlik doğrulama yok; `register` önceki oturumu siliyor | **Kapandı** | `authToken` (şemada zorunlu) + sabit zamanlı `sharedSecretAuthenticator` + **açık `takeover`** ve düşen lease'lerin iadesi. `agent-registry.test.ts` (auth 4 test, devralma 3 test) |
| **O5** | Ajanın beyan ettiği `activeLeases`'e koşulsuz güven | **Kapandı** | Lease tablosu platformda (`assignLease`/`completeLease`, kapasite orada zorlanıyor); beyan yalnız karşılaştırılıyor (`revokedLeases`) ve `declaredLeases` olarak teşhis için saklanıyor. `agent-registry.test.ts` (6 test) |
| **O6** | Cache volume'ü boş yaratılıyor, `cacheReadOnly` varsayılan `true` → katman ① kalıcı boş | **Kapandı** | `workspace.cacheWritableKeys` ile adlandırılmış ısıtma yolu; yazılabilir cache de sahiplik devri alıyor. Varsayılan (boş liste) hâlâ salt okunur ve §3'te gerekçelendirildi. `provision.test.ts` (2 test) |
| **O7** | `sandbox.runtime` serbest metin | **Kapandı** | `z.enum(["runc","runsc"])`. `config.test.ts` "accepts only runc and runsc" |
| DÜŞÜK | `node:22@sha256:…` regex tutarsızlığı | **Kapandı** | Referans dilbilgisi host[:port]/yol[:tag]@digest olarak ayrıştırılıyor; `node:22:33@…` reddediliyor. `config.test.ts` "accepts a tag that is pinned by a digest, wherever the tag sits" |
| DÜŞÜK | `workspace.ts` anahtarı büyük/küçük harf duyarlı | **Kapandı** | Yalnız **ticket segmenti** normalize ediliyor; branch duyarlı kalıyor (gerekçe §3). `workspace.test.ts` "folds the ticket segment's case but not the branch's" |
| DÜŞÜK | `MAX_CACHE_MOUNTS` tekilleştirmeyi saymıyor | **Kapandı** | Sınır birleşim kümesi üzerinden. `retention.test.ts` "counts the limit over distinct keys, not over calls" |
| DÜŞÜK | `ALL_PROXY`/`all_proxy` rezerve değil | **Kapandı** | Rezerve listeye eklendi. `sandbox.test.ts` "refuses a job that tries to redirect its own egress" |
| DÜŞÜK | RAPOR §6/§8.4 güncel değil | **Kapandı** | §6 test tablosu yeniden yazıldı; §8.4 kök kapısı **38/38 yeşil** olarak güncellendi |

**Kaçış bataryası** (`MAESTRO_DOCKER_IT=1`, 3 dosya / 23 test, gerçek daemon): root olma denemeleri ·
`/workspace` yazma + kalıcılık · ağ erişilebilirliği (ham TCP **ve** DNS) · `Internal` olmayan /
olmayan / `host` / `container:` ağların reddi · cgroup limitleri (OOM 137, fork bombası) · rootfs
yazma · `/tmp` noexec · setuid/`su` · `mount` · docker.sock yokluğu · zaman aşımında gerçek SIGKILL ·
**artık bırakmama** (her dosya sonunda etiketli konteyner/volume/ağ sayımı sıfır olmalı).
Batarya dosyaları sırayla koşar (`vitest.config.ts`): aynı daemon üzerinde paralel dosyalar
birbirinin artık sayımını kirletirdi.
