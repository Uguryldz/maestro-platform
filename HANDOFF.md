# HANDOFF

## DURUM
**1.0.10 yayında.** `uguryldz/maestro-node:1.0.10` ve `uguryldz/maestro-studio:1.0.10`
Docker Hub'da. Çalışma ağacı temiz.

## Bu turun konusu: "parametreler canlıda boş geliyor"
Sebep bulundu ve kökten düzeltildi. `seedParams` YALNIZ opt-in olan `seed-cli.ts`
içinden çağrılıyordu; `migrate` — her kurulumun koştuğu yol — şablonu, ilk yöneticiyi
ve varyantları tohumluyor ama parametreleri tohumlamıyordu.

Aynı yapının iki yığınında ölçüldü: seed CLI'ını elle koşturmuş olanda 21 parametre,
doğrudan compose ile kurulanda SIFIR. Ekran ikisinde de aynı boş tabloyu çiziyordu.

Kill switch, veri sınıfı politikası, kapı eşikleri ve Jira tarama aralığı o tabloda.
Yani parametresiz kurulum "ayarları boş platform" değil, "ayarlarına erişilemeyen platform".

## Çıkan imajlar
- **1.0.9** — `migrate` artık parametreleri tohumluyor; boş tablo metni ne demek
  olduğunu ve ne yapılacağını söylüyor; not satırı neden ekleme/silme olmadığını açıklıyor
- **1.0.10** — tohum sayacı dürüst: yaptığını sayıyor, baktığını değil

## TEMİZ KURULUM KANITI (yayınlanan imajlarla, sıfırdan)
İlk kurulum:
    [maestro] 21 parameter default(s) seeded (21 definitions)
    [maestro] analysis template v1 published (8 sections)
    [maestro] İLK KURULUM: 'admin' yönetici hesabı oluşturuldu
İkinci koşu (hiçbir şey yazılmamalı):
    [maestro] 21 parameter definition(s) current, values left alone
    [maestro] analysis template already published, leaving it alone
    [maestro] agent variants already exist, leaving them alone
Yedi servis sağlıklı, panel 200, operatörün 45 sn'ye çektiği değer korundu.

## Parametre ekleme/silme NEDEN yok (soruldu, kasıtlı)
Her parametrenin arkasında onu OKUYAN kod var. Panelden yeni satır eklense onu okuyan
kod olmadığı için hiçbir şey yapmaz; silinse kod okumaya devam eder. Liste koda ait
(sürümle gelir), DEĞERLER operatöre ait (panelden değişir). Ekran artık bunu yazıyor.
Düzenle/İncele butonu her satırda var — kullanıcı görmedi çünkü tablo boştu.

## Bu makinedeki yığınlar (kullanıcının ASIL canlısı BAŞKA yerde)
- `maestro` → 7000, `/home/ubuntu/maestro-prod`, 1.0.8
- `maestrofinal` → 7500, ESKİ bir oturumun scratchpad'inde, 1.0.4
  Parametreleri elle tohumladım (20 satır); yığın hâlâ 1.0.4, yükseltme YAPILMADI.
Kullanıcının gerçek canlı ortamı bu makinede DEĞİL — oraya hiçbir şey uygulanmadı.
"Kendi kendine çoklama" ürünün hatası değil: port ve proje adı tek yerden sabit
(`STUDIO_PORT:-7000`, `COMPOSE_PROJECT_NAME:-maestro`); ikinci yığın ayrı dizine
ikinci kez kurulduğu için var.

## Ayrı repo
`https://github.com/Uguryldz/maestro-platform` — PRIVATE, dal `main`, 1628 dosya,
tek temiz commit (geçmiş taşınmadı). Yerel kopya `/home/ubuntu/maestro-repo`.
`.env` dosyaları gitignore'da olduğu için sırlar GİTMEDİ (uzakta doğrulandı).
DİKKAT: `/home/ubuntu/coder/maestro` hâlâ ESKİ `Uguryldz/coder` reposuna bağlı — iki ayrı yer.

## Testler
deploy 810/810 · db 232/232 · studio 405/405 · config 26/26 · tsc temiz.
Turbo'nun toplu koşusu bu makinede YÜK yüzünden ALAKASIZ paketleri kırmızı
gösterebiliyor — düşen paketi TEK BAŞINA koştur.

## Sıradaki iş
- **Kullanıcının asıl canlı ortamını 1.0.10'a yükselt** (nerede olduğu henüz bilinmiyor).
- **Bağlantı testi gerçek bir tamamlama çağrısı yapmalı.** Şu an `/models` çağırıyor:
  kredisi bitmiş anahtar testi GEÇİYOR, sonra koşu 2. adımda 403 ile takılıyor.
  Canlıda bir kez yaşandı. Kullanıcı kararı bekliyor.
- **Bot hesabını sil**: `User` tablosunda `712020.b836c135-…@corp`, `maestro-admins`
  üyesi (dört-göz muafiyeti). **Bankaya giderken SİL.**

## Tuzaklar
- `pkill -f "src/bin/worker.ts"` kendi kabuğunu vurur; `\.ts` diye kaçır.
- Jira Cloud auth **Basic** (`email:token`), DC **Bearer** — iki ayrı sürücü.
- JQL'de hesap kimliği **tırnaksız** ve `in (...)` içinde; `assignee = "712020:…"` boş döner.
- `ParamVersion` sütunları: `key, scopeRef, version, valueJson, guarded, changedBy,
  approvedBy, at` — `changedAt`/`status` YOK.
- `AnalysisTemplate` diye tablo YOK; şablon başka adla duruyor.
- BFF host'a port yayınlamaz; panele `http://127.0.0.1:<STUDIO_PORT>/api/...` üzerinden git.
- `pgrep -f "docker build"` ilk eşleşmede ALT süreci verir — yaş ölçümü yanıltır.
- `unbound` sessizliği KASITLI (M102) — bug sanıp "düzeltme".
- Canlı `/login`'e dokunma; launcher restart oturumu düşürür.
