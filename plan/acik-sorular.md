# MAESTRO — Açık Soru Envanteri

> **DURUM: KAPALI.** 2026-08-07 karar turunda 86 sorunun tamamı Uğur'la tek tek karara bağlandı → **masterplan.md §2b (M44–M98)**.
> Bu dosya tarihsel kayıt olarak durur; yeni sorular çıktıkça buraya eklenir, karara bağlanınca M-numarasıyla kapatılır.

## Kapanış özeti (soru → karar)

| Grup | Sorular | Karar |
|---|---|---|
| Bildirim kanalları | A1, A4, A5, J6 | M45 NotifyPort (teams+smtp+jira+slack, eklenti modül) · M88 eskalasyon tamamen parametrik |
| Jira sürüm/süreç | A2, A3, B1-B10 | M46 Jira DC · M48a proje bazlı tetikleme · M50 alt ticket tipi parametrik · M72 label'lar · M74 assignee aşamalı · M75 tek canlı özet yorumu · M96 ana kapanış PO · M98 zorunlu alan yok · M59 dil karma (analiz TR / kod EN) |
| Analiz yayını | A6 | M47 PublishPort (jira+confluence+repo-docs) |
| Change/entegrasyon | A7-A12 | M34 korundu (Jira) · M77 SonarQube/Fortify/Artifactory/Xray opsiyonel sürücüler · M80 SecretPort (vault + ileride cyberark) |
| Dallanma & merge | C1-C11 | M49 trunk-based+squash · M48 merge iki mod proje bazlı · M76 sahiplik+rotasyon reviewer · M84 repo yapısı esnek (path filtresi) · M85 platform timeout+retry · C8→Maestro `.maestro.yaml` PR'ı önerir (onboarding M93 içinde) |
| Kapılar & roller | D1-D8 | M51 risk-katmanlı kapı seti (2/4/6, ana yol Jira) · M81 PO+TL paralel + Studio vekil · M54 3-ret devir · M72 durum=label · M73 break-glass insan-only |
| AI sınırları | E1-E11 | M52 protected_paths · M53 bağımlılık onay listesi · M67 bug repro-first · M68 refactor davranış-koruma · M69 test değişiklik etiketi · M70 coverage ratchet · M54 takılma · M78 model/persona 4-göz+eval · M55 abonelik kota (dolar bütçesi yerine) |
| Güvenlik & uyum | F1-F10 | M63 veri sınıfı kurulumda · M95 sentetik fixture · M56 10 yıl · M57 WORM opsiyonel · M64 ağ esnek/proxy-chain · M66 restore Aşama 1 · M97 gizli sınıf kabul + on-prem agentic araştırma |
| Süreklilik | G1-G5 | M65 workspace 60 gün+arşiv · M89 iptalde anında imha · M82 journal maskeli · M83 şablon sürüm pin |
| Studio & UX | H1-H7 | M86 herkes girer rolü kadar · M62 KPI seti (esnek) · M60 iki dilli · M61 Jira mobil onay · M92 QA SoD parametrik-kapalı |
| İşletim | I1-I6 | M87 platform takımı+ops kanalı · M79 pilot ugurpay+ugurweb 1 sprint · M58 2 seviyeli kill-switch · M94 2 haftalık sürüm |
| Kapsam | J1-J5 | M93 self-service onboarding · M67/M68 bug+refactor · M91 release notu taslağı · M90 Maestro starter seti |

## Karar turundan çıkan mimari notlar
- **M71**: ayarlar `.maestro.yaml`'dan Studio/DB parametrelerine kaydı — mock ve şema buna göre.
- **M55**: abonelik bağlantıları (Claude/Gemini/Codex hesapları) → LlmPort'a subscription sürücü sınıfı; kota/pencere takibi, havuz, kota-farkında sıra. Token-API sürücüleri yedek/istisna.
- **M44**: eklenti-modül + clean-room repo düzeni; çekirdek sürücüleri import etmez, DI ile yükler.
- Kurumda **Fortify** var → ScanPort sürücüsü planda (M77).

## Yeni açık soru
*(yok — çıktıkça buraya)*
