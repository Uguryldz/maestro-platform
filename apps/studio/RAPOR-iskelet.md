# Studio iskeleti — rapor (Dalga 4, görev #7)

Bu dosya **ekran ajanları için giriş belgesidir**. Ekran yazmadan önce bunu ve
`src/ui/README.md`'yi oku.

Kurulan şey: `apps/studio` (`@maestro/studio`) — Vite + React 19 + TypeScript
strict, 7000 portunda, BFF 7001'de. **Ekranların içeriği yazılmadı**; 37 ekranın
tamamı rota tablosuna kayıtlı ve `<Placeholder/>` döndüren stub dosyalara bağlı.

---

## 1. Kurulan yapı

```
apps/studio/
  index.html                    #root + main.tsx
  vite.config.ts                port 7000, /api -> localhost:7001 proxy
  vitest.config.ts              jsdom + testing-library (ayrı dosya, sebebi §7)
  tsconfig.json                 kök tsconfig.base.json'u genişletir, strict
  src/
    main.tsx                    createRoot
    app/
      App.tsx                   sağlayıcı yığını (i18n > query > auth > toast > router)
      routes.tsx                rota ağacı — TABLODAN üretilir, elle rota yok
      screens.ts                *** ROTA TABLOSU *** (37 satır)
      screen-components.ts      id -> bileşen kaydı
      Placeholder.tsx           yazılmamış ekranın gösterdiği şey
      NotFound.tsx              404
      ErrorBoundary.tsx         eksik katalog anahtarını görünür kılar
    api/
      client.ts                 tek fetch sarmalayıcı (ApiClient)
      errors.ts                 sunucu kodu -> katalog anahtarı eşlemesi
    auth/
      AuthProvider.tsx          oturum + token (bellekte) + ApiClient
      RequireSession.tsx        oturum yoksa /login  (GÜVENLİK NOTU: §5)
      LoginForm.tsx             giriş formu
      types.ts                  Session/LoginResponse + rol yardımcıları
    i18n/
      catalog.ts                @maestro/config katalog köprüsü
      I18nProvider.tsx          useT() / useI18n()
    shell/
      Shell.tsx                 sidebar + topbar + içerik
      Sidebar.tsx               mockdaki gruplama, rol filtresi
      TopBar.tsx                başlık, kill-switch, kullanıcı, dil, çıkış
      KillSwitchIndicator.tsx   GET /killswitch, 30sn'de bir
    ui/                         tasarım sistemi (§3) + README.md
    screens/                    37 stub dosya — ekran ajanlarının çalışma alanı
  test/                         56 test
```

`pnpm run gate` yeşil (50/50 görev). `pnpm --filter @maestro/studio build` çalışıyor
(389 kB JS / 120 kB gzip). Hiçbir dosya 300 satırı geçmiyor (en büyük kaynak: 146).

---

## 2. Rota tablosu — ekran ajanlarının EN ÖNEMLİ kuralı

**Yer: `src/app/screens.ts`.**

37 ekranın hepsi zaten burada kayıtlı, `src/screens/<Pascal>.tsx` stub dosyası ve
`src/app/screen-components.ts` kaydı da hazır.

**Ekran ajanı olarak: SADECE kendi `src/screens/<Ad>.tsx` dosyanı değiştir.**
`screens.ts`, `routes.tsx` ve `screen-components.ts` dosyalarına **dokunma**.
Rota, başlık anahtarı ve menü girişin zaten tanımlı. Bir yol/başlık/rol
değişikliği gerekiyorsa raporunda belirt.

Bunu koruyan testler: `test/routes.test.tsx` — 37 ekranın tamamının kayıtlı
olduğunu, id/yol tekrarı olmadığını, her satırın bir bileşeni ve her bileşenin bir
satırı olduğunu doğrular.

`detail` ekranı parametreli: yol `detail/:ticket`, menüde görünmez (tablodan
tıklanarak gelinir). `login` kabuğun **dışında** (`/login`).

---

## 3. `src/ui/` primitifleri ve API'leri

Tam kullanım kılavuzu **`src/ui/README.md`** (örnek kodlu). Özet:

| Bileşen | Ana proplar |
|---|---|
| `Button` | `variant: default\|primary\|success\|danger`, `size: md\|sm`, `busy` |
| `Input` | `label`, `hint`, `error` (hepsi çevrilmiş metin) |
| `Select` | `label`, `hint`, `error`, `options: {value,label,disabled}[]` |
| `Card` | `title`, `subtitle`, `actions`, `padded` |
| `Kpi` | `label`, `value`, `note` |
| `Badge` | `tone: blue\|green\|amber\|red\|purple\|teal\|orange\|gray`, `icon` |
| `Table<Row>` | `columns`, `rows`, `rowKey`, `onRowClick`, `loading`, `emptyLabel` |
| `Tabs` / `TabPanel` | `items`, `active`, `onChange`, `label` |
| `Modal` | `open`, `onClose`, `title`, `footer`, `closeLabel` |
| `Toast` | `useToast().show(tone, message)` |
| `EmptyState` | `title`, `description`, `action`, `icon` |
| `Skeleton` | `rows`, `lastWidth` |

Alan yardımcıları (aynı kavram her ekranda aynı renk olsun diye):
`runStatusTone(status)`, `riskTone(dusuk|orta|kritik)`, `workModeTone(...)`.

`Table` kendi `loading` (Skeleton) ve boş (EmptyState) durumlarını yönetir —
liste ekranlarında bu dallanmayı sen yazma.

**Stil kararı: düz CSS dosyaları + `tokens.css`** (Tailwind/CSS Modules değil).
Gerekçe `src/ui/README.md` başında: mock zaten bitmiş bir token sistemi
(`--blue`, `--panel`, karanlık tema dahil); onu olduğu gibi korumak en ucuz ve en
sadık yol. **Bileşende düz renk yazma**, `var(--...)` kullan yoksa karanlık tema
sessizce bozulur.

---

## 4. i18n — sıkı kural

- Kullanıcıya görünen **her metin** `packages/config/locales/{tr,en}.json`'dan gelir.
- Ekranda: `const t = useT(); t("anahtar")` veya `t("anahtar", {param: "x"})`.
- **Primitifler `t` çağırmaz** — onlara çevrilmiş metin verirsin.
- Yeni anahtarı **iki dosyaya birlikte** ekle; parite testi `@maestro/config`'te.
- **Eksik anahtar sessizce düşmez, fırlatır** (`MissingMessageError`).
  `ErrorBoundary` bunu kırmızı panele çevirir. `test/i18n.test.tsx` bunu doğrular.

Bu iskelet kataloğa **130 anahtar ekledi** (tr ve en, her ikisi de 248 anahtar):
`app.*`, `shell.*`, `locale.*`, `nav.group.*`, `nav.*` (37), `screen.*.title` (37),
`login.*`, `killswitch.level.*`, `action.*`, `empty.*`, `error.*` (31).

`error.*` anahtarlarının tamamı BFF'in ürettiği hata kodlarına birebir karşılık
gelir — ekran ajanı yeni hata metni uydurmasın, `messageKeyOf(error)` kullansın.

---

## 5. Kimlik ve GÜVENLİK NOTU

Akış: `POST /auth/login` -> token bellekte (`AuthProvider`'da `useRef`;
localStorage'da **değil**, XSS 8 saatlik bearer'ı alıp götürmesin diye) ->
her istekte `Authorization: Bearer <token>`.

- BFF **çerez kullanmıyor**, CSRF koruması yok ve gerekmiyor (tarayıcının
  kendiliğinden eklemediği bir başlık taşıyoruz).
- Oturum **8 saat mutlak**, kayan değil; yenileme ucu yok.
- 401 -> `ApiClient` oturumu düşürür, `RequireSession` `/login`'e yönlendirir.
- `/auth/session` düz, `/auth/login` `user` altında iç içe — `sessionFromLogin()`
  ikisini tek `Session` tipine indirger.
- `POST /auth/logout` **204** döner (gövde yok) ve **hesabın tüm oturumlarını**
  kapatır (kullanıcının diğer cihazları da düşer).

### Rol bazlı gizleme güvenlik DEĞİLDİR
`Sidebar` kullanıcının rolü olmayan menüyü gizler (`screens.ts`'teki `roles`).
Bu yalnızca **kullanılabilirlik** içindir — operatör 403 alacağı ekrana
gitmesin diye. Gerçek yetkilendirme **BFF'te**: her istekte `requireRole` /
`requireAnyRole` / proje grubu kontrolü. Bundle herkese açık, roller istemcinin
doğrulayamadığı bir yanıttan geliyor, URL elle yazılabilir.
**Hiçbir yetki kararını Studio'ya taşıma.** Bu, `RequireSession.tsx` ve
`Sidebar.tsx` içinde yorum olarak da yazılı, ve `test/auth.test.tsx` gizli bir
ekranın elle yazınca yine açıldığını **bilerek** doğrular.

Bugün BFF'in kontrol ettiği roller: `admin` (kill-switch, kullanıcılar),
`admin`+`tech-lead` (parametreler, projeler arası görünürlük). Rol listesi wire'da
düz `string[]` — kapalı bir enum yok.

`delegated: true` oturumlar (AI insan adına token tutuyor) kapı kararlarında ve
kill-switch'te BFF tarafından reddedilir (`403 human_channel_only`); TopBar bunu
rozetle gösterir. İlgili ekran ajanları o kontrolleri gizlesin.

---

## 6. API istemcisi

`src/api/client.ts` — tek kapı. `useApi()` ile al.

```tsx
const api = useApi();
useQuery({ queryKey: ["runs"], queryFn: ({signal}) => api.get("/runs", {query:{limit:50}, signal}) });
```

- Yollar BFF köküne göre (`/runs`), istemci başına `/api` ekler, Vite proxy'si
  7001'e taşır.
- `signal`'i **her zaman geçir** (iptal / AbortController).
- 204'te `undefined` döner (logout gövdesiz).
- Hata tipleri: `ApiError` (status, code, details), `UnauthenticatedError`,
  `NetworkError`. Abort **olduğu gibi** yeniden fırlatılır (TanStack Query
  iptali tanısın diye).
- **Ham sunucu metni kullanıcıya basılmaz.** BFF zaten düzyazı göndermiyor
  (`{error:"<code>"}`); istemci kodu `errorMessageKey()` ile katalog anahtarına
  çevirir, tanımadığı kod `error.unexpected`'a düşer. Ayrıştırılamayan gövde
  (proxy HTML hata sayfası) `internal_error` olur — HTML ekrana sızmaz.

---

## 7. Kütüphane ve sürüm kararları

React 19.2, React Router 8.3, TanStack Query 5.101, Vite **7.3**, vitest 3.2,
@testing-library/react 16.3, jsdom.

**Vite neden 8 değil 7:** depo genelinde vitest 3 standart; vitest 3 kendi Vite
7'sini paketliyor. Vite 8'i yanına kurunca iki kopyanın plugin tipleri karşılıklı
atanamaz oluyor ve typecheck patlıyor. Vite 8'e geçmek = tüm monorepo'yu tek
adımda vitest 4'e almak. Ayrıca `vitest.config.ts` `vite.config.ts`'ten **ayrı**:
Vite 8+ config tipi artık `test` bloğunu kabul etmiyor, ve testlerin dev
sunucusunun portunu/proxy'sini miras almaması gerekiyor.

Ağır UI kit kullanılmadı (istendiği gibi).

**`@maestro/config` içe aktarma tuzağı:** paketin barrel'ı (`src/index.ts`)
`env.ts`'i de dışa vuruyor; o `process.env` okuyor ve zod'u sürüklüyor. Tarayıcıya
Node kodu girmesin diye `@maestro/config/i18n` diye bir **takma ad** tanımlandı
(`vite.config.ts` + `vitest.config.ts` alias, `tsconfig.json` paths) ve doğrudan
`packages/config/src/i18n.ts`'e gidiyor. Katalog **kopyalanmadı**.

---

## 8. Testler (56 test, hepsi yeşil)

| Dosya | Kapsam |
|---|---|
| `test/routes.test.tsx` | 37 ekranın tamamı tabloda; id/yol tekrarı yok; her satır<->bileşen çift yönlü; login kabuk dışında |
| `test/auth.test.tsx` | oturumsuz -> /login (derin bağlantı dahil); başarılı giriş; hatalı parolada **çevrilmiş** mesaj (ham kod değil); rol filtresi menüyü gizler ama **rota yine açılır** (BFF gerçek kapı); rol yardımcıları |
| `test/api-client.test.ts` | bearer başlığı; 401'de oturum düşürme + `UnauthenticatedError`; 403'te düşürmeme; 204; query string; abort'un abort kalması; ham gövdenin sızmaması; kod->anahtar eşlemesinin tamlığı |
| `test/i18n.test.tsx` | tablodaki her başlık/menü anahtarı iki dilde var; her BFF hata kodunun karşılığı var; eksik anahtar **fırlatır**; render sırasında görünür hataya dönüşür |
| `test/ui.test.tsx` | 11 primitifin davranışı: busy button, label/error bağlama, Table boş/yükleniyor/klavye, Tabs aria, Modal kapanma, tone yardımcıları |

`test/setup.ts` `globalThis.fetch`'i **fırlatacak şekilde** eziyor — hiçbir test
ağa çıkamaz; her test kendi fetch stub'ını enjekte eder.

---

## 9. ARAYÜZ İSTEKLERİ (donmuş paketlere dokunmadım)

1. **Oturum/rol sözleşmesi `packages/contracts`'te yok.** `AuthenticatedUser`,
   `SessionRecord` ve rol dizgileri `apps/bff/src/deps.ts` içinde yerel tanımlı.
   Studio bunları `src/auth/types.ts`'te yeniden yazmak zorunda kaldı — iki
   tanımın elle senkron kalması gerekiyor. **İstek:** `Session` (+ varsa rol
   birleşimi) contracts'a taşınsın.
2. **BFF'te port ve CORS yok.** `apps/bff` yalnızca `buildServer()` dışa vuruyor;
   `listen()` yok, `PORT` env'i yok, CORS eklentisi yok. Studio 7000, BFF 7001
   varsayıldı ve dev'de **aynı köken proxy'si** kuruldu. Üretimde ters proxy
   yoksa CORS gerekecek. **İstek:** BFF kompozisyon kökü + port kararı; ayrı
   köken kullanılacaksa CORS.
3. **Studio'nun ihtiyaç duyduğu uçların çoğu yok.** Bugün BFF'te yalnızca
   `/healthz`, `/readyz`, `/auth/*`, `/runs*`, `/params*`, `/killswitch` var.
   37 ekranın büyük kısmı (variants, knowledge, audit, evidence, cost, llm,
   security, users, mcp, runners, sandbox, template, ...) için uç yok. Ekran
   ajanları bunu BFF ajanıyla koordine etmeli.
4. **`packages/config` locale JSON'ı alt yol olarak dışa vurulmuyor.**
   `exports` yalnızca `"."`. Takma adla çözüldü (§7); kalıcı çözüm
   `"./i18n": "./src/i18n.ts"` alt yolu eklemek olurdu — tarayıcı paketine
   `env.ts`/zod sızmasını da yapısal olarak engellerdi.
5. **`catalog-usage.test.ts` `apps/` altını taramıyor** ve ad alanı beyaz listesi
   sabit (`steps|notify|gate|command|match|params|run|evidence|llm|publish`).
   Yeni `nav.*`, `screen.*`, `error.*`, `ui` ad alanları o korumanın dışında.
   Studio kendi korumasını `test/i18n.test.tsx` ile kuruyor, ama istenirse o
   regex genişletilebilir.

---

## 10. Yapmadıklarım

- **37 ekranın içeriği** — kapsam dışıydı; hepsi `<Placeholder/>` stub'ı.
- Karanlık tema **anahtarı** — tokenlar hazır (`[data-theme="dark"]`), ama
  değiştirici düğme konmadı (mockta `toggleTheme` var).
- Dil seçimi `localStorage`'da; **kullanıcı tercihi olarak sunucuya yazılmıyor**
  (`params.description.output_language` ayrı bir kavram, o AI çıktı dili).
- Oturum **sayfa yenilemede kaybolur** (token bellekte). Bilinçli: BFF'te
  yenileme ucu yok ve localStorage'a 8 saatlik bearer koymak istemedim.
  Kalıcılık istenirse ürün kararı gerekir (§9.1 ile birlikte ele alınmalı).
- Oturum süresi **geri sayımı / uyarısı** yok (`expiresAt` elde var, ekran yok).
- E2E/Playwright yok; yalnızca birim + entegrasyon testleri.
- `apps/studio` **BFF'e karşı canlı çalıştırılmadı** (BFF'in `listen()`'ı yok).
