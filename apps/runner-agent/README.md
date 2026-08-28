# Maestro Runner Agent (M22)

Bir geliştirici makinesinde (Windows / macOS) çalışan servis. Maestro platformuna
**dışarı doğru** bağlanır, iş kiralar, işi sandbox içinde çalıştırır, çıktısını
maskeleyerek geri akıtır.

> **Makineye içeri port açılmaz.** Bağlantıyı her zaman ajan başlatır. Bu, bankanın
> ağ onayının dayandığı özelliktir (M22); bu uygulamada ne bir sunucu, ne bir
> dinleyici, ne de bir port vardır.

## Neden bu ajan var

`docker-linux` runner'ı platformun kendi tarafında çalışır. Xcode ve MSBuild
konteynıra sığmadığı için mac/win işleri gerçek makinelerde koşmak zorunda —
bu ajan o makinelerdeki eldir. macOS/Windows'ta konteynır izolasyonu **yoktur**;
telafi, iş başına dar yetkili ayrı bir kullanıcı + EDR + aynı egress kurallarıdır
ve bu, plan §7'de **kabul edilmiş risk** olarak kayıtlıdır.

## Mimari

| Dosya | Sorumluluk |
|---|---|
| `src/config.ts` | Yapılandırma (env + dosya). Eksik zorunlu ayarda **açılmaz**. |
| `src/token.ts` | Paylaşılan sırrı **referanstan** çözer (env / `SecretPort`). |
| `src/platform-client.ts` | Tek dışa bağlantı. Sır yalnız `register`'da gider. |
| `src/protocol.ts` | Donmuş şemada olmayan mesajlar (pull / lease / log). |
| `src/kill-switch.ts` | `pause_intake` / `stop_all` durumu ve çalışan işlere erişim. |
| `src/lease-manager.ts` | Kiralama: yenileme, süre dolması, geri bırakma. |
| `src/job-runner.ts` | Sandbox aç → çalıştır → topla → **her yolda** yık. |
| `src/agent.ts` | Kayıt, heartbeat, iş çekme döngüsü, zarif kapanma. |
| `src/main.ts` | Kompozisyon kökü: env okuma, sinyaller, zamanlayıcılar. |

### Kill switch iki yerde kontrol edilir

Tek noktada kontrol yetmez — aynı hata workflow paketinde bulunmuştu:

1. **İş çekiminde** (`agent.tick`) — `pull` cevabındaki seviye işler
   başlatılmadan **önce** uygulanır.
2. **Çalışan işin adım geçişlerinde** (`job-runner.ts`) — `acquire`, `run` ve
   `collect` sınırlarında. `lease_renew` cevabı da seviyeyi taşır, böylece dört
   saatlik bir build ortasında durdurulabilir.

`pause_intake` yeni iş almayı durdurur, çalışanı bitirir. `stop_all` çalışanı da
durdurur ve sandbox'ları yıkar.

### Kiralama neden kiralama

İş devredilmez, **kiralanır**: platform sahipliği korur, ajan süreli bir hak
tutar ve sürekli yeniler. Ajan çökerse kiralama süresi dolar ve iş yeniden
planlanır (iş kaybolmaz); yenilemesi reddedilen ajan işi bitiremeden durur
(iş iki kere çalışmaz).

### Sır maskeleme

Akıtılan her satır iki katmandan geçer (`src/masking.ts`):

1. **Bilinen sırlar** — ajan token'ı ve işin ortam değişkeni değerleri, birebir
   `[REDACTED]`. Rastgele bir token hiçbir dedektöre uymadığı için bu katman
   şarttır; hata metninden parola kurtarılabilmesi geçmişte bulunan bir açıktı.
2. **Kurumsal PII** — `@maestro/pii` sınırı (IBAN/TCKN/kart/e-posta…).

Sıra önemlidir: sır **önce** silinir, yoksa hesap numarasına benzeyen bir token
geri çevrilebilir bir `[ACCOUNT_1]` jetonuna dönüşürdü.

---

## Kurulum — macOS (launchd)

**Gereksinimler:** macOS 13+, Node 24+ (`node` PATH'te), yönetici hakkı.

1. **Platformda ajanı tanımla** ve paylaşılan sırrı al (`agentId` makine başına tek).

2. **Sırrı sistem keychain'ine yaz** — dosyaya veya plist'e **yazma**:
   ```bash
   sudo security add-generic-password \
     -a 'mac-mini-07' -s 'maestro-runner-agent' \
     -w -U /Library/Keychains/System.keychain
   ```
   Komut sırrı sorar; terminal geçmişine düşmez.

3. **Kur:**
   ```bash
   cd apps/runner-agent
   sudo ./scripts/install-macos.sh \
     --platform-url https://maestro.internal \
     --agent-id mac-mini-07 \
     --capacity 2 \
     --labels xcode-16,ios-18
   ```
   Betik `_maestro` adında **yönetici olmayan** bir servis hesabı açar,
   dosyaları `/usr/local/maestro/runner-agent` altına kopyalar ve
   `com.maestro.runner-agent` LaunchDaemon'unu yükler.

4. **Doğrula:**
   ```bash
   sudo launchctl print system/com.maestro.runner-agent
   tail -f /var/log/maestro/runner-agent.log
   ```
   Studio → **Runner havuzları** ekranında makine `sağlıklı` görünmeli.

**Kaldırma:** `sudo ./scripts/uninstall-macos.sh` (çalışma alanlarını da silmek
için `--purge`).

---

## Kurulum — Windows (nssm veya sc.exe)

**Gereksinimler:** Windows Server 2019+ / Windows 11, Node 24+ (`node` PATH'te),
yükseltilmiş PowerShell. `nssm` varsa kullanılır — durdurmayı gerçekten
**bekler**, kiralamaların bırakılması buna bağlıdır.

1. **Platformda ajanı tanımla** ve paylaşılan sırrı al.

2. **Kur** (sır kurulum sırasında sorulur; DPAPI ile servis hesabına şifrelenir,
   servis ortamına **yazılmaz**):
   ```powershell
   cd apps\runner-agent
   .\scripts\install-windows.ps1 `
     -PlatformUrl https://maestro.internal `
     -AgentId win-build-02 `
     -Capacity 2 `
     -Labels "vs2022,dotnet8"
   ```
   Betik `maestro-agent` adında **yönetici olmayan** yerel hesap açar,
   "Log on as a service" hakkını verir ve servisi otomatik başlatmaya alır.

3. **Doğrula:**
   ```powershell
   Get-Service MaestroRunnerAgent
   Get-Content 'C:\ProgramData\Maestro\agent\runner-agent.log' -Tail 50 -Wait
   ```

**Kaldırma:** `.\scripts\uninstall-windows.ps1` (çalışma alanları için `-Purge`).

---

## Yapılandırma

Öncelik: **ortam değişkeni dosyayı ezer.** Dosya yolu `MAESTRO_AGENT_CONFIG`.

| Ortam değişkeni | Dosya alanı | Zorunlu | Açıklama |
|---|---|:---:|---|
| `MAESTRO_AGENT_PLATFORM_URL` | `platformUrl` | ✔ | Platform adresi; production'da **https** şart. |
| `MAESTRO_AGENT_ID` | `agentId` | ✔ | Makine kimliği (`[a-z0-9-]`, 3-64). |
| `MAESTRO_AGENT_PLATFORM` | `platform` | ✔ | `macos-xcode` \| `windows-dotnet`. |
| `MAESTRO_AGENT_VERSION` | `agentVersion` | ✔ | Ajan sürümü. |
| `MAESTRO_AGENT_CAPACITY` | `capacity` | ✔ | Eşzamanlı sandbox sayısı (1-16). |
| `MAESTRO_AGENT_TOKEN_SOURCE` | `tokenRef.source` | ✔ | `env` \| `secret-port`. |
| `MAESTRO_AGENT_TOKEN_KEY` | `tokenRef.key` | ✔ | Değişken adı ya da `SecretPort` anahtarı. |
| `MAESTRO_AGENT_LABELS` | `labels` | | Virgülle ayrık (`xcode-16,ios-18`). |
| `MAESTRO_AGENT_LOG_LEVEL` | `logLevel` | | `debug`/`info`/`warn`/`error` (vars. `info`). |
| `MAESTRO_AGENT_PULL_INTERVAL_SECONDS` | `pullIntervalSeconds` | | Vars. `5`. |
| `MAESTRO_AGENT_LEASE_RENEW_MARGIN_SECONDS` | `leaseRenewMarginSeconds` | | Vars. `30`. |
| `MAESTRO_AGENT_SHUTDOWN_GRACE_SECONDS` | `shutdownGraceSeconds` | | Vars. `60`. |
| `MAESTRO_AGENT_REQUEST_TIMEOUT_MS` | `requestTimeoutMs` | | Vars. `15000`. |

> **Token yapılandırmaya yazılamaz.** `tokenRef` yalnız bir *referans* kabul eder;
> `source: "literal"` gibi bir seçenek bilinçli olarak **yoktur** — diskte düz
> metin sır demek olurdu.

Örnek `agent.json`:
```json
{
  "platformUrl": "https://maestro.internal",
  "agentId": "mac-mini-07",
  "platform": "macos-xcode",
  "agentVersion": "0.1.0",
  "capacity": 2,
  "labels": ["xcode-16", "ios-18"],
  "tokenRef": { "source": "env", "key": "MAESTRO_AGENT_TOKEN" }
}
```

> **`workDir` kaldırıldı.** Eskiden **zorunlu** bir alandı ama kodda hiçbir yerde
> okunmuyordu: operatöre "bankanın kaynağı buraya iner" sözü veriyor, o sözü
> tutmuyordu. Sandbox'ın deposu runner sürücüsünün işidir (linux'ta docker
> volume'leri, win/mac'te ajanın kendi kurulumu). Dosyada kalmış eski bir
> `workDir` alanı **yok sayılır**, hata vermez.

> **`logLevel` artık gerçekten uygulanıyor.** `error` seçen operatör `info`
> gürültüsü görmez; seviyesi tanınmayan bir satır **hiçbir zaman** elenmez.

## Zarif kapanma

`SIGINT`/`SIGTERM` alındığında: yeni iş alınmaz → çalışanlar bitirilir →
kalan kiralamalar `abandoned` olarak geri verilir → sandbox'lar yıkılır →
`bye` ile kayıt düşürülür. **İkinci sinyal** beklemeyi keser ve sandbox'ları
zorla kapatır.

## Test

```bash
pnpm --filter @maestro/runner-agent test
```

Ağ çağrısı yoktur; platform sahte bir `fetch` üzerinden **gerçek**
`PlatformClient` ile konuşur, saat enjekte edilir, hiçbir test uyumaz.
