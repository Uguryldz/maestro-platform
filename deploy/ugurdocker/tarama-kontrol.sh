#!/usr/bin/env bash
#
# "Ticket'lar gelmiyor" — webhook'suz (JQL taraması) yolunun teşhisi.
#
# Tarama sessizce çalışmayabilir: bağlantı yeşil, panel açık, kurallar doğru
# görünürken hiçbir ticket gelmez. Sebep her zaman bu altı şarttan biridir.
# Bu script hepsini sırayla ölçer ve HANGİSİNİN eksik olduğunu söyler.
#
# Kullanım:  ./tarama-kontrol.sh          (kurulum klasöründe)
set -uo pipefail
cd "$(dirname "$0")"

PROJE="$(grep -oE '^COMPOSE_PROJECT_NAME=.*' .env 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ' || true)"
PROJE="${PROJE:-maestro}"
PSQL=(docker compose exec -T postgres psql -U maestro -d maestro -tAc)

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; SORUN=$((SORUN+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
SORUN=0

echo "════ MAESTRO TARAMA TEŞHİSİ (${PROJE}) ════"
echo

echo "1) BFF ayakta mı"
if docker compose ps --format '{{.Service}} {{.Status}}' 2>/dev/null | grep -q "^bff.*healthy"; then
  ok "bff sağlıklı"
else
  bad "bff sağlıklı DEĞİL — önce onu düzeltin: docker compose ps"
  echo; echo "Tarama BFF içinde koşar; BFF yoksa hiçbir şey aranmaz."; exit 1
fi

echo
echo "2) JIRA_DISCOVER_MS tanımlı mı  (tarama bu olmadan HİÇ başlamaz)"
MS="$(docker compose exec -T bff sh -c 'cat /proc/1/environ | tr "\0" "\n" | grep "^JIRA_DISCOVER_MS=" | cut -d= -f2' 2>/dev/null | tr -d '\r')"
if [ -n "${MS:-}" ] && [ "${MS}" -gt 0 ] 2>/dev/null; then
  ok "JIRA_DISCOVER_MS=${MS} ms"
else
  bad "JIRA_DISCOVER_MS boş/sıfır → tarama hiç başlamadı"
  echo "     .env'e ekleyin:  JIRA_DISCOVER_MS=\"300000\"   sonra: docker compose up -d"
fi

echo
echo "3) Açılışta tarama başladı mı"
ACIK="$(docker compose logs bff --no-log-prefix 2>/dev/null | grep 'ticket keşfi açık' | tail -1 || true)"
if [ -n "${ACIK}" ]; then
  ok "${ACIK}"
else
  bad "'jira ticket keşfi açık' satırı YOK → tarama kurulmadı (bkz. adım 2)"
fi

echo
echo "4) Dinleme kuralı var mı ve AÇIK mı"
KURAL="$("${PSQL[@]}" "SELECT count(*) FROM \"ListeningRule\" WHERE enabled;" 2>/dev/null | tr -d '\r ')"
TUM="$("${PSQL[@]}" "SELECT count(*) FROM \"ListeningRule\";" 2>/dev/null | tr -d '\r ')"
if [ "${KURAL:-0}" -gt 0 ] 2>/dev/null; then
  ok "${KURAL} açık kural (toplam ${TUM})"
  "${PSQL[@]}" "SELECT '      · '||\"projectKey\"||' | '||\"matchKind\"||'='||\"matchValue\"||' | '||\"assigneeAccountId\" FROM \"ListeningRule\" WHERE enabled ORDER BY priority;" 2>/dev/null
else
  bad "Açık dinleme kuralı YOK (toplam ${TUM:-0}) → aranacak bir şey yok"
  echo "     Panel → Kurulum sihirbazı ile projeyi bağlayın."
fi

echo
echo "5) Jira bağlantısı çalışıyor mu"
BAG="$("${PSQL[@]}" "SELECT kind||'|'||enabled||'|'||COALESCE(\"lastTestOk\"::text,'null')||'|'||COALESCE(\"baseUrl\",'-') FROM \"Connection\" WHERE kind LIKE '%jira%' LIMIT 1;" 2>/dev/null | tr -d '\r')"
if [ -z "${BAG}" ]; then
  bad "Jira bağlantısı YOK → panelden ekleyin"
else
  IFS='|' read -r K E T U <<< "${BAG}"
  [ "${E}" = "t" ] || [ "${E}" = "true" ] && ok "bağlantı açık (${K} → ${U})" || bad "bağlantı KAPALI (${K})"
  [ "${T}" = "t" ] || [ "${T}" = "true" ] && ok "son test başarılı" || warn "son test başarısız/hiç yapılmadı → panelden 'Test et'"
fi

echo
echo "6) Tarama turları koşuyor mu  (en güvenilir kanıt)"
TUR="$(docker compose logs bff --since 30m --no-log-prefix 2>/dev/null | grep -c 'keşif] tur bitti' || true)"
if [ "${TUR:-0}" -gt 0 ] 2>/dev/null; then
  ok "son 30 dakikada ${TUR} tur"
  docker compose logs bff --since 30m --no-log-prefix 2>/dev/null | grep 'keşif] tur bitti' | tail -2 | sed 's/^/      /'
else
  bad "Son 30 dakikada tek tur yok"
  echo "     NOT: 'tur bitti' satırı 1.0.8+ ile geldi. Daha eski sürümde tur"
  echo "     sessiz geçer — imajı 1.0.10'a yükseltin, sonra tekrar bakın."
fi

echo
echo "7) Tarama aralığı  (panelden ayarlanır)"
SN="$("${PSQL[@]}" "SELECT \"valueJson\"::text FROM \"ParamVersion\" WHERE key='jira.discover_seconds' ORDER BY version DESC LIMIT 1;" 2>/dev/null | tr -d '\r ')"
if [ -n "${SN}" ]; then
  [ "${SN}" = "0" ] && bad "aralık 0 = tarama KAPATILMIŞ → panelden büyütün" || ok "${SN} saniye"
else
  warn "jira.discover_seconds kaydı yok → boot değeri (${MS:-?} ms) kullanılıyor"
  echo "     Parametreler ekranı boşsa imaj 1.0.9'dan eski demektir."
fi

echo
echo "════════════════════════════════════════════"
if [ "${SORUN}" -eq 0 ]; then
  echo "Altı şart da sağlanıyor. Tarama çalışıyor."
  echo
  echo "Yine de ticket gelmiyorsa sebep taramada değil, EŞLEŞMEDE:"
  echo "  · Ticket bot hesabına ATANMIŞ olmalı (kuraldaki accountId ile aynı)"
  echo "  · Ticket'ın tipi/durumu kuraldaki değerle birebir eşleşmeli"
  echo "  · Zaten koşusu olan ticket bir daha alınmaz (bu kasıtlı)"
  echo
  echo "Şunu Jira'da aratın — sonuç boşsa sorun Jira tarafındadır:"
  "${PSQL[@]}" "SELECT '  project = \"'||\"projectKey\"||'\" AND assignee in ('||\"assigneeAccountId\"||')'||CASE WHEN \"matchKind\"='issuetype' THEN ' AND issuetype = \"'||\"matchValue\"||'\"' WHEN \"matchKind\"='status' THEN ' AND status = \"'||\"matchValue\"||'\"' ELSE '' END FROM \"ListeningRule\" WHERE enabled ORDER BY priority LIMIT 3;" 2>/dev/null
else
  echo "${SORUN} sorun bulundu — yukarıdaki ✗ satırlarını sırayla çözün."
fi
