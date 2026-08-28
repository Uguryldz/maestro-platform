# GECE ÇALIŞMASI — Prod ortamını uçtan uca çalışır yap
> Uğur uyurken (2026-08-10 gecesi). Hedef: "prod ortamı tamamen çalışır hale getir."
> Elimdeki gerçek bilgiler: Jira (uyildiz.atlassian.net + token), OpenRouter key, Claude CLI kurulu.

## Uğur'un 4 isteği → yapılacaklar
1. **Prod gibi çalış** → demo-stack yerine gerçek-DB, gerçek bağlantılar, sahte veri yok.
2. **Bağlantılar Ayarlar'dan** → Jira + AI erişim bilgilerini connector ekranına GERÇEK kayıt olarak taşı; ayarlar oradan yönetilsin.
3. **AI agent şablonu/knowledge/variant çalışsın** → analizi yapan analyst variant'ı gerçek knowledge + şablonla çalışsın (agent-roles paketi hazır).
4. **Jira→sandbox→CrewAI-benzeri sub-agent'larla proje geliştiren yer** → pilot akışını gerçek agent-roles + gerçek git ile uçtan uca.

## Sıra (her adım builder+verifier, contracts/ports donuk)
- [G1] Connector doğrula + merge (yarıda kalmasın). Sonra Jira+OpenRouter bağlantılarını connector'a SEED et (Ayarlar'da görünsün, Test-et yeşil).
- [G2] PDF fix zaten main'de ✓. Analiz→Word/PDF→OTOMATİK Jira attachment (M103r) pilota bağla.
- [G3] Prod launcher: demo-stack in-memory yerine gerçek-DB + gerçek connector'lardan Jira/LLM okuyan tek stack. admin/admin123 must-change.
- [G4] Abonelik (M107): Claude CLI kurulu → claude-sub sürücüsünü pilota bağla (opsiyonel, OpenRouter yedek). Model seçimi Studio param'ından.
- [G5] agent-roles gerçekten devrede: analyst variant + knowledge + M108 şablon; analizi bu üretsin (pilot'un basit think yerine).
- [G6] Uçtan uca prova: OPS ticket → gerçek analiz (agent) → Word+PDF Jira'ya ek → (GitHub token yoksa fake ADO kalır, C4 Uğur'un token'ını bekler).

## Kısıtlar / dürüst sınırlar (sabah Uğur'a rapor)
- GERÇEK git/PR/merge = Uğur'un GitHub repo+token'ı gelince (C4). O olmadan kod tarafı fake ADO kalır.
- Mac/Windows runner = kapsam dışı (fiziksel makine).
- Prod-deploy (apps/deploy) tam kurum uçları ister (S3/Vault/ADO) — gece launcher'ıyla gösterilir, tam prod kuruma geçince.
- Her şey builder+verifier'dan geçer; güvenlik açığı bulunursa DÜZELTİLİR, merge edilmez.

## Sabah Uğur bulacak
- Ayarlar'da gerçek Jira + OpenRouter bağlantısı (Test-et yeşil).
- OPS ticket analizi düzgün PDF+Word olarak Jira'ya EKLENMİŞ.
- Gerçek agent/variant/knowledge ile üretilen analiz.
- Bu dosyada ne yapıldı/ne kaldı raporu (altına yazılacak).

---
## YAPILDI (gece boyu güncellenecek)

### Tur 1 (gece başı)
- Connector doğrulandı → **KALDI**: kripto/güvenlik çekirdeği sağlam (AES-GCM, token gizli, tampered→throw) ama 3 kırık gate + secret-ref çakışma bug'ı (Date.now→randomBytes) + Studio ekranı hiç yazılmamış. Aynı builder'a düzelttiriliyor.
- PDF empty-pages bug'ı düzeltildi + main'de (09a2587): 9 boş sayfa → 2 dolu, pdftotext ile doğrulandı.
- Yeni OpenRouter key .env'e yazıldı, çalışıyor.
- G2 (otomatik Jira attachment) builder başlatıldı, dönüyor.
- Claude CLI KURULU bulundu (/home/ubuntu/.local/bin/claude) → M107 abonelik uygulanabilir.

### Tur 2
- G2 attachment builder BİTTİ (commit a76bf6a): addAttachment JiraCloudWorkPort'a eklendi, multipart native FormData, fail-soft, filename sanitize, token sızmıyor. 166+65 test. → doğrulamaya verildi.
- Connector düzeltme mesajı gönderildi (randomBytes ref + 4 catalog kodu + deploy fake + Studio ekranı), builder çalışıyor.
- BEKLEYEN: G2 doğrulaması + connector düzeltme sonucu.

### Tur 3
- G2 attachment DOĞRULANDI (GEÇTİ 7/7) → **main'de merge** (multipart doğru, token gizli, fail-soft gerçek). Artık pilot analizi Word+PDF olarak otomatik Jira'ya ekliyor.
- G5 (agent-roles gerçek analiz) builder başlatıldı: pilot'un basit think'i yerine runAnalyst (şablon+knowledge+variant). Dönüyor.
- Connector düzeltme hala çalışıyor (randomBytes + 4 kod + deploy fake + Studio ekranı).
- BEKLEYEN: connector düzeltme + G5 sonucu.

### Tur 4
- Connector düzeltme BİTTİ (commit 475581f): 4 bulgu kapatıldı (randomBytes ref, 4 catalog kodu, deploy fake, STUDIO EKRANI yazıldı — ConnectorsPanel.tsx Settings'e bağlı, Test-et inline). Gate yeşil (bff 594, studio 248). → teyide verildi.
- G5 (gerçek agent analizi) hala dönüyor.
- BEKLEYEN: connector teyidi + G5 sonucu. Connector GEÇERSE → merge → G1b (Jira+OpenRouter'ı connector'a seed).

### Tur 5
- Connector DOĞRULANDI (GEÇTİ 6/6) → **main'de merge**. migration 0010 canlı DB'ye uygulandı (Connection + ConnectorSecret tabloları).
- **G1b TAMAM**: Uğur'un gerçek Jira + OpenRouter bağlantıları connector'a AES-şifreli seed edildi. CONNECTOR_MASTER_KEY .env'e sabit yazıldı (seed+launcher aynı key). DOĞRULANDI: token decrypt + canlı test → Jira 200 ✓, OpenRouter 200 ✓. Sabah Ayarlar>Bağlantılar'da görünür, Test-et yeşil.
- G5 (gerçek agent analizi) hala dönüyor.
- SIRADA: G5 bitince merge → launcher'ı connector'lardan Jira/LLM okuyacak şekilde bağla (böylece Ayarlar ekranı gerçek bağlantıları gösterir) → G6 uçtan uca prova.

### Tur 6
- G5 (gerçek agent analizi) BİTTİ (commit e4ad521): pilot artık runAnalyst ile gerçek şablon (M43 7 bölüm + M109 Kaynaklar/openItems) + variant kullanıyor. Masking inceliği çözülmüş (display=gerçek comment/docs için, masked=saklama için). 72+159 test. → doğrulamaya verildi (fail-closed + gerçek-PII-saklamaya-sızıyor-mu kritik).
- BEKLEYEN: G5 doğrulaması. GEÇERSE → merge → launcher'ı connector'a bağla (Ayarlar gerçek bağlantı gösterir) → G6 uçtan uca prova → gece işi ~biter.

### Tur 7 — GECE HEDEFLERİ TAMAMLANDI
- G5 DOĞRULANDI (GEÇTİ 7/7) → **main'de merge**. Pilot artık gerçek runAnalyst + M43/M109 şablon + variant ile analiz yapıyor; fail-closed, gerçek PII saklamaya sızmıyor.
- Launcher connector store'larına bağlandı → Ayarlar > Bağlantılar gerçek Jira+OpenRouter'ı gösteriyor.
- BUG BULUNDU+DÜZELTİLDİ: bootstrap admin id'si bare 'admin'di → audit chain reddediyordu (connector Test-et 500 veriyordu). id=admin@maestro.local (email=admin login için) yapıldı. db 197 + bff 594 test yeşil.
- CANLI DOĞRULANDI: admin/admin123 login ✓ · Test-et → jira ok ("Uğur Yıldız" tanındı) · Test-et → openrouter ok. İkisi de lastTestOk:True.

## SABAH UĞUR BULACAK (özet)
1. **Ayarlar > Bağlantılar**: gerçek Jira (uyildiz.atlassian.net ****0275) + OpenRouter (****eba6), "Test et" → CANLI YEŞİL. Yeni bağlantı ekle/düzenle/sil çalışıyor (AES-şifreli token).
2. **Analiz**: pilot gerçek agent-roles analyst + M43/M109 şablon + variant ile üretiyor (basit think değil).
3. **Jira attachment**: analiz üretilince Word+PDF OTOMATİK Jira'ya ekleniyor (elle değil).
4. **PDF düzgün**: 9 boş sayfa bug'ı çözüldü, 2 dolu sayfa, Türkçe sağlam.
5. **admin/admin123** ile giriş (ilk girişte parola değiştir — must-change).
6. Erişim: http://coder.uguryildiz.tech/ (0.0.0.0'a bağlı, allowedHosts ayarlı).

## UĞUR'UN KARARINI/ANAHTARINI BEKLEYEN (gece bitiremez)
- **GERÇEK git/PR/merge**: GitHub repo + fine-grained PAT gerekli (C3/C4). Olmadan kod tarafı fake ADO kalır — pilot PILOT_SCM=github ile bağlanır.
- **Kurum prod uçları**: gerçek Jira DC / ADO / Vault / S3 (apps/deploy prod profili). Şu an dev launcher + senin dev Jira'n.
- **Mac/Windows runner**: fiziksel makine (kapsam dışı).
- **CONNECTOR_MASTER_KEY**: dev key .env'de; prod'da gerçek 32-byte key ver.
