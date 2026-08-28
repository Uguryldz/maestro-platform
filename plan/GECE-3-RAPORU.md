# GECE 3 — Atamaya-dayalı SDLC akışı (Uğur uyurken)

> Uğur (2026-08-12 gecesi): sidebar'ları düzelt; Jira'daki akış tipini kendi ekranımızda
> flow ile tasarla, Jira workflow'unu import et; etiket yerine ATAMA dinle; uygunluk kapısı
> (uygun değilse İADE); tek kalıcı izole sandbox; hepsini yap; sabah test Jira'sı ver.

## SABAH BULACAĞIN — ÖZET

Maestro artık **gerçek bir takım arkadaşı gibi** çalışıyor: kendine atanan işi görür,
uygun değilse iade eder, uygunsa analiz eder, onaya yöneticiye devreder, onaylanınca kod yazar.

### 🔵 SENİN İÇİN HAZIR TEST: OPS-16
- **https://uyildiz.atlassian.net/browse/OPS-16** — "Giriş ekranına 'Beni hatırla' seçeneği ekle"
- Zaten **Maestro Bot'a atalı**, net bir ticket. Sen başlatınca (aşağıda nasıl) uçtan uca akar.
- **Başlatmak için:** pilot UI'ı aç → http://127.0.0.1:7020 → OPS-16'yı başlat.
  (veya terminalden: `curl -X POST http://127.0.0.1:7020/api/start -H "Content-Type: application/json" -d '{"ticketKey":"OPS-16"}'`)

## GECE KANITLANAN AKIŞ (canlı Jira'da gerçek)

Senin diyagramın (Talep → Agent baktı → Analiz → Onay → Yazılım) artık ÇALIŞIYOR:

| Adım | Kanıt |
|---|---|
| **Atama ile dinleme** | Maestro `assignee = Maestro Bot AND statusCategory != Done` ile keşfediyor (etiket değil) |
| **Uygunluk kapısı → İADE** | **OPS-14** "Rapor lazım" (belirsiz) → Maestro not yazdı + sana geri atadı + statü "Yapılacaklar"a aldı |
| **Analiz** | **OPS-15** (net) → analiz üretti, Word+PDF Jira'ya ekli, tek kalıcı sandbox'ta izole çalıştı |
| **Onay devri** | OPS-15 analizi **Analist Yönetici'ye** atandı + statü **İNCELEMEDE** |
| **Onay → Kod** | `/approve` sonrası 9 adım tamam → **gerçek GitHub PR #4** açıldı |

- **PR #4 (gerçek):** https://github.com/Uguryldz/maestro-pilot/pull/4 — "[AI] OPS-15 ekstre filtresi"
- Maestro tüm yorumları **kendi kimliğiyle** ("maestro") yazıyor, Uğur değil.

## OLUŞTURULAN JİRA HESAPLARI (atama zinciri)
| Rol | Hesap | Not |
|---|---|---|
| Talep açan | Uğur Yıldız | sen |
| **Maestro** | Maestro Bot (uyildiz2054@gmail.com) | işleri dinler+yapar+yazar, kendi token'ı var |
| Onaylayan | Analist Yönetici (0uguryldz94+yonetici) | analiz ona atanır |

## YENİ ÖZELLİKLER (kod)
1. **Studio > Flow ekranı**: Jira workflow'unu (statü+geçiş) import eder, saf SVG çizer, bir ticket'ın canlı statüsüne göre "hangi adımdayız"ı vurgular. Endpoint: GET /studio/jira-workflow.
2. **Kalıcı izole sandbox**: tek kök hep ayakta, ticket başına izole klasör+context, dispose ticket dizinini siler kökü korur.
3. **Studio Sandbox ekranı gerçek**: pilot SANDBOX_CREATE/DESTROY audit'e yazıyor, ekran gerçek oturumları gösteriyor.
4. **Sidebar düzeltmeleri**: Routing+Notify (param seed eksikti) düzeltildi; 24 sekmenin 21'i çalışıyor.

## KALİTE
- Tüm iş **builder + bağımsız verifier** turundan geçti.
- typecheck 32/32; bff 603, adapter-jira 193, studio 262, pilot 116, agent-roles 162 test — hepsi yeşil.
- **contracts/ports DONUK** (hiç değişmedi).
- Bulunan gerçek sorun düzeltildi: intake kapısı fazla katıydı (net ticket'ı bile iade ediyordu, "çıkmaz sokak") → eşik "analize başlamak için yeterli mi?"ye kalibre edildi.

## SENİN SABAH İŞİN / KARARIN
1. **OPS-16'yı çalıştır** (yukarıda), akışı canlı izle. İstersen /approve ver (tek başına, ek metin YOK — `/approve`).
2. **Güvenlik:** Maestro Bot API token'ı ve GitHub token'ı sohbette göründü → ikisini de İPTAL ET + yenile.
3. GitHub PR'ları (#1-4) incele + gerçek merge (insan işi, M48).
4. Küçük iz: onay sonrası Jira statüsü "İNCELEMEDE"de kaldı (Tamam'a geçmedi) + "PR birleşti" mesajı ama GitHub'da PR açık (merge simülasyonu). Kozmetik; istersen düzeltiriz.
5. Kalan 503 sekmeler (Eval/Güvenlik-scan/Runner-fleet): bu kurulumda üreticisi yok — kaldır/gerçek-yap kararı sana kaldı (geçen konuştuk).

## SIRADA KONUŞULACAK (senin vizyonun, henüz yapılmadı)
- Flow editörü **düzenlenebilir** (şu an import+görüntüle+canlı-durum var; sürükle-bırak düzenleme yok).
- "Projede bize atanan TÜM kayıtlar" — şu an tek assignee (Maestro Bot); çoklu proje/atama genişletmesi.
- Analiz adımlarının kendi içinde AI alt-adımlara bölünmesi.
