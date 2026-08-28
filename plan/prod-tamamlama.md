# MAESTRO — Prod'a Uçtan Uca Tamamlama Planı

> Hedef (Uğur, 2026-08-10): "prod'a alacağım, uçtan uca Jira ile proje yazabilmek
> istiyorum; Mac/Windows runner fiziksel makine bekleyecek, gerisi TAM olacak."
> Kod tarafı da GERÇEK olacak: taklit ADO kalkacak, gerçek git repo'ya branch+PR+merge.

## 0. Bugün ne GERÇEK, ne TAKLİT (dürüst başlangıç)

| Parça | Durum |
|---|---|
| Jira (senin siten, OPS) | ✅ GERÇEK — jira-cloud sürücüsü, canlı koştu |
| Analiz / model / PII / audit / tarama | ✅ GERÇEK |
| PDF / Word üretimi | ✅ GERÇEK (9-sayfa PDF, Word, Türkçe) |
| Studio okuma ekranları (14) | ✅ gerçek DB'den okuyor |
| **Kod yazma → git push → PR → merge** | ❌ TAKLİT (pilot'ta ADO fake, push kapalı) |
| **Studio yazma ekranları (Ayarlar, Kullanıcılar, Routing, Notify, Onboard…)** | ❌ yarım — BFF'te bazı PUT uçları var, ekranlar bağlı değil |
| Mac/Windows runner | ⏸ fiziksel makine bekliyor (kapsam dışı, bilinçli) |

## 1. Dalgalar (her paket: builder + bağımsız doğrulayıcı; contracts/ports donuk)

### Dalga A — Studio yönetim ekranları GERÇEK (yazma tarafı)
BFF'te PUT/POST uçları çoğu VAR; iş bunları Studio ekranlarına bağlamak + eksik olanı yazmak.
- **A1 Kullanıcılar** — ekle/düzenle/rol-ata/pasifleştir. BFF'e `POST/PUT/DELETE /studio/users` (bcrypt provision, LocalIdentityProvider zaten var). Studio Users ekranı forma bağlanır.
- **A2 Ayarlar** — `PUT /settings` VAR; Studio Settings ekranı gerçek forma bağlanır (bağlantılar, kill-switch, dil, eşikler). Pilot'taki SettingsStore deseni referans.
- **A3 Parametreler** — `PUT /params` VAR (4-göz/M71); Params ekranı düzenleme modalına bağlanır.
- **A4 Routing/Jira bağlama** — `PUT /routing` + `POST /onboarding` VAR; Routing + Onboard ekranları gerçek bağlama + kuru koşum (M102) akışına bağlanır.
- **A5 Notify** — `PUT /notify` VAR; Notify ekranı kanal/eskalasyon ayarına bağlanır.

### Dalga B — Ajan yönetim ekranları GERÇEK
- **B1 Variants + Variant detayı** — variant CRUD (BFF `/studio/variants` okuma var; yazma + persona/model/knowledge düzenleme eklenir).
- **B2 Eval / golden ticket** — eval sonuçları + gerekçeli-geçiş (M78).
- **B3 Template / Doctemplate** — analiz şablonu + doküman şablonu sürümleme (`POST /template/versions`, `POST /doc-template` VAR; ekranlara bağla).
- **B4 Knowledge** — yükleme/sürümleme (okuma var; yazma eklenir).

### Dalga C — GERÇEK KOD TARAFI (en kritik, uçtan uca'nın kalbi)
- **C1 Gerçek git sürücüsü** — KARAR: ADO Services (dev.azure.com, ücretsiz) sürücüsü zaten çift-modda VAR → gerçek bir ADO Services org+repo bağla; VEYA yeni GitHub ScmPort sürücüsü yaz. (Uğur'un tercihi + repo/token gerekir.)
- **C2 Gerçek git push** — pilot/execution'da `issueSecret` gerçek kısa-ömürlü kimlik üretsin; runner sandbox'ta gerçek `git clone/commit/push`.
- **C3 Gerçek PR + CI** — sürücü gerçek PR açsın; CI sinyali gerçek webhook/poll ile gelsin (M106 köken doğrulamalı).
- **C4 Pilot → gerçek uçtan uca** — taklit ADO kaldırılır; OPS ticket'ı gerçekten gerçek repo'ya PR'a dönüşür.

### Dalga D — Studio'yu pilot akışının önüne geçir
- **D1** Şu an iki ayrı UI: Studio (izleme) + pilot (koşu). Hedef: Studio'dan da ticket seç/başlat/onay-izle. Pilot'un poll+akış motorunu Studio'nun arkasına al (ya da BFF'e).
- **D2** Sidebar yeniden: gerçek çalışan ekranlar mantıklı gruplu; artık hepsi çalıştığı için "gizleme" değil "düzenleme".

### Dalga E — Prod sertleştirme
- Kalan InMemory store'lar (session, kill-switch) → Postgres.
- AD/LDAP kimlik (M8) — adapter-ldap VAR, bağla.
- deploy/compose prod profili gerçek uçlarla; restore tatbikatı (M66).

## 2. Sıra ve bağımlılık
A (yazma ekranları) ve C (gerçek git) paralel gidebilir — A DB'ye, C git'e dokunur.
B, A'dan sonra. D, C bitince (gerçek akış olmadan Studio-başlat anlamsız). E en son.
**Önce A1+A2 (Kullanıcılar+Ayarlar)** — Uğur'un ilk gördüğü eksik bunlar.

## 3. Değişmeyen kurallar
- contracts/ports DONUK; her paket builder+doğrulayıcı; testler offline+yeşil; dalga sonu entegrasyon.
- Maestro prod'a DEPLOY etmez — merge'de biter (gerçek repo'da bile).
- SoD gevşetmesi yalnız tek-kullanıcı pilotta; gerçek kullanıcılar gelince PO≠TL döner.
- Mac/Windows runner kapsam dışı (fiziksel makine); linux-node yeter (Jira→web/api projeleri).
