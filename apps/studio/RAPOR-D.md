# RAPOR — Dalga D: pilot'un gerçek-Jira akışı Studio'dan sürülüyor

## Amaç

Operatör tek bir yüz kullansın (Studio, :7000): `maestro` etiketli bir OPS
ticket'ını keşfetsin, akışı başlatsın ve canlı izlesin — ayrı pilot sayfasına
(:7020) gitmeden. Bugün Studio yalnızca run'ları OKUYORDU; başlatma/izleme pilot
sayfasındaydı. Bu dalga o kontrolü Studio'ya taşıyor.

## Dürüst mimari — PROXY, motor taşıması DEĞİL

Bu, **ince bir kontrol yüzeyi**dir; pilot motorunun (poll/run/workspace/git/docs)
Temporal'a taşınması ya da yeniden yazılması DEĞİLDİR.

- Pilot süreci (apps/pilot) akış motoru olarak kalır. Jira'yı yoklar, workspace'i
  çalıştırır, git'i yazar, belgeleri üretir.
- Studio onun **yüzü** olur: her çağrı BFF proxy'sinden (`/studio/pilot/*`) geçer,
  proxy de pilot'un mevcut HTTP API'sine (`/api/state`, `/api/events` SSE,
  `/api/start`, `/api/settings`, `/api/doc/:kind`) iletir.
- Pilot'un kendi sayfası çalışmaya devam eder — Studio EK bir kapıdır, pilot
  sunucusunu kaldıran bir ikame değil.

Tam Temporal-tabanlı, Studio-yerel akış (pilot'un motoru platforma taşınmış hali)
sonraki, daha büyük bir iştir. Bu dalga operatörün UI'ını, o işi yapmış gibi
davranmadan birleştirir.

## BFF proxy rotaları — `apps/bff/src/routes/studio-pilot.ts`

| Rota | İletilen pilot ucu | Yetki |
|---|---|---|
| `GET /studio/pilot/state` | `GET {pilot}/api/state` | herhangi bir oturum |
| `POST /studio/pilot/start` `{ticketKey}` | `POST {pilot}/api/start` | admin / tech-lead |
| `GET /studio/pilot/events` (SSE geçişi) | `GET {pilot}/api/events` | herhangi bir oturum |
| `GET /studio/pilot/settings` | `GET {pilot}/api/settings` | herhangi bir oturum |
| `POST /studio/pilot/settings` | `POST {pilot}/api/settings` | admin / tech-lead |
| `GET /studio/pilot/doc/:kind` (pdf\|docx) | `GET {pilot}/api/doc/:kind` | herhangi bir oturum |

Pilot taban URL'i config'tir: `PILOT_BASE_URL` (env), varsayılan
`http://127.0.0.1:7020` (`DEFAULT_PILOT_BASE_URL`, server.ts). `packages/config`
env şemasına opsiyonel `PILOT_BASE_URL` eklendi — `REQUIRED_IN_PROD` DEĞİL, pilot
opsiyonel bir yüzdür ve onsuz da BFF açılmalı.

## Dört güvenlik özelliği (doğrulayıcının kontrol ettiği)

1. **Token asla iletilmez.** Proxy, pilot'a giden isteği sıfırdan kurar; gelen
   istekten hiçbir header kopyalamaz. Studio kullanıcısının 8 saatlik bearer'ı bir
   iç servis çağrısına takılmaz. `pilotFetch` deps üzerinden enjekte edilir
   (varsayılan gerçek `fetch`); testler stub verir. Test: state çağrısında
   `authorization` header'ı yok ve init'in hiçbir yerinde token dizesi geçmiyor.

2. **start/settings BFF'te rol-kapılı.** `PILOT_WRITE_ROLES = ["admin",
   "tech-lead"]` — bu platformun operatör rolleri (fleet/quota'yı kapatan
   `OPS_ROLES` ile aynı çift; kod tabanında "operator" adlı bir rol yok).
   `requireAnyRole(...)` preHandler'ı proxy'ye ulaşmadan reddeder. Pilot, sayfasını
   açabilen herkese güvenir; bu yüzden kapı BU tarafta olmalı. Test: viewer → 403
   ve pilot hiç çağrılmıyor.

3. **Pilot erişilemezse 503 `pilot_unreachable`.** Bağlantı hatası
   `unavailable("pilot_unreachable")`'a çevrilir; sahte bir `{discovered: []}`
   ÜRETİLMEZ. Bu, `routes/unwired.ts`'in engellediği "sessiz yanlış cevap"tır —
   boş liste ile ölü motor aynı görünür ama yalnızca biri doğrudur. SSE yolu da
   ölü pilotta boş akış yerine 503 döner.

4. **Açık SSRF değil.** Üst-akış taban URL'i config'tir (`deps.config.pilotBaseUrl`),
   istek parametresi değil. Çağıranın etkilediği tek path parçası `:kind`'dir ve
   URL'e girmeden önce `pdf|docx`'e kısıtlanır (`invalid_doc_kind`). Test:
   `..%2fapi%2fstate` → 400, pilot hiç çağrılmıyor; ayrı bir test config'ten gelen
   base URL'in kullanıldığını doğrular.

SSE geçişi `reply.hijack()` + `reply.raw` ile yapılır; üst-akışın web
`ReadableStream` gövdesi kare kare Studio'ya yazılır, istemci kapanınca reader
iptal edilir.

## Studio ekranı — `apps/studio/src/screens/Pilot.tsx`

Yeni "🎥 Canlı akış / Pilot" ekranı (`operation` grubu, `screens.ts` +
`screen-components.ts`'e eklendi; nav rolü YOK — viewer da izleyebilmeli).

- Keşfedilen `maestro` ticket'ları tablo halinde; her satırda operatöre "▶ Başlat"
  düğmesi (POST start). Viewer'a düğme gösterilmez, yerine "operatör yetkisi
  gerekir" notu — BFF zaten 403 döner, düğmeyi gizlemek yalnızca kullanılabilirlik.
- Çalışan akışın canlı görünümü: adımlar + durum rozetleri, açık insan kapısı
  (operatöre GERÇEK Jira yorumuna `/approve` yazması söylenir — pilot ile aynı),
  gerçek Jira ticket'ına link, `docsReady` olduğunda PDF/Word indirme (aynı
  kimlik-doğrulamalı proxy üzerinden `getBlob`).
- **Neden EventSource değil, poll?** Pilot SSE yayınlar ve BFF geçirir, ama
  tarayıcının `EventSource`'u Studio bearer'ını ekleyemez ve proxy her isteği
  doğrular. Bu yüzden ekran `/studio/pilot/state`'i kısa aralıkla (4 sn) yoklar —
  aynı canlı resim, oturum token'ını taşıyan bir kanalla. SSE geçişi, ileride
  kimlik taşıyan bir istemci için hazır durur.

Türkçe; tr+en katalog anahtarları (`pilot.*`, `nav.pilot`, `screen.pilot.title`,
`error.pilot_unreachable` / `error.invalid_doc_kind` / `error.pilot_bad_response`)
her iki dile eklendi. `routes.test.tsx` mock-sonrası eklemeyi (`pilot`) açıkça
tanır — kaza eseri/düşen ekran hâlâ testte patlar.

## Test sayıları (hepsi OFFLINE — enjekte fetch, ağ yok)

- BFF: `apps/bff/test/studio-pilot.test.ts` — **15 test**. state/start/settings/
  doc/events; token iletilmiyor; viewer→403; pilot-down→503; SSE el sıkışma
  şekli; base URL config'ten. Paket toplamı **568 yeşil**.
- Studio: `apps/studio/test/screens-pilot.test.tsx` — **6 test**. Keşfedilen
  ticket'lar render; başlat operatörde ticketKey ile POST'lar; viewer'da düğme
  yok; açık kapı + `/approve` + Jira linki; docs hazır → PDF/Word; pilot-down
  mesajı boş ekran yerine görünür. Paket toplamı **238 yeşil**.
- Config: **23 yeşil** (env şeması değişikliği dahil).

`pnpm -F @maestro/bff typecheck && test`, `pnpm -F @maestro/studio typecheck &&
test` yeşil; değiştirilen dosyalarda `eslint` temiz.

## Dokunulan dosyalar

- `packages/config/src/env.ts` — opsiyonel `PILOT_BASE_URL`.
- `apps/bff/src/deps.ts` — `BffConfig.pilotBaseUrl`, `PilotFetch` tipi,
  `BffDeps.pilotFetch` (ops.), `ResolvedDeps.pilotFetch`.
- `apps/bff/src/server.ts` — `DEFAULT_PILOT_BASE_URL`, `resolveDeps` env'den taban
  URL + `pilotFetch` çözümü, rota kaydı.
- `apps/bff/src/routes/studio-pilot.ts` — proxy (YENİ).
- `apps/bff/test/studio-pilot.test.ts` — testler (YENİ).
- `apps/studio/src/screens/Pilot.tsx` — ekran (YENİ).
- `apps/studio/src/app/screens.ts`, `screen-components.ts` — kayıt.
- `apps/studio/src/api/errors.ts` — üç yeni hata kodu eşlemesi.
- `apps/studio/test/screens-pilot.test.tsx` — testler (YENİ).
- `apps/studio/test/routes.test.tsx` — mock-sonrası `pilot` eklemesi tanındı.
- `packages/config/locales/{tr,en}.json` — `pilot.*` + hata + nav/screen anahtarları.

Pilot motoruna, git/adapter koduna veya pilot'un iç akışına DOKUNULMADI —
yalnızca ona ulaşan opsiyonel bir yol EKLENDİ.
