#!/usr/bin/env bash
#
# Maestro'yu TEK KOMUTLA başlatır: BFF + Studio (gerçek Postgres) + Pilot motoru.
# Prod testi için: ./maestro-baslat.sh
#
# Ne yapar:
#   1. Eski süreçleri temizler (port çakışması olmasın — 7000 tuzağı)
#   2. .env'i yükler + eksik varsayılanları ekler
#   3. BFF (7001) + Studio (7000) başlatır  → real-users.ts
#   4. Pilot motoru (7020) başlatır          → pilot.ts
#   5. Hepsi ayağa kalkana kadar sağlık kontrolü yapar
#   6. Adresleri ve giriş bilgisini yazar
#
# Durdurmak için:  ./maestro-baslat.sh stop
set -uo pipefail
cd "$(dirname "$0")"

# ℹ systemd servisleri kuruluysa (ops/systemd/kur.sh) bu script yerine şu önerilir:
#   systemctl --user start maestro-stack maestro-pilot   (log: journalctl --user -u maestro-pilot -f)
echo "ℹ systemd servisleri kuruluysa bu script yerine önerilen: systemctl --user start maestro-stack maestro-pilot (bkz. ops/systemd/README.md)"

LOG_DIR="/tmp/maestro-logs"
mkdir -p "$LOG_DIR"

# ── env ──────────────────────────────────────────────────────────────────────
# .env'i yükle (varsa). set -a: sonrasında export edilenler alt süreçlere geçer.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
export DATABASE_URL="${DATABASE_URL:-postgresql://maestro:DEGISTIR-parola-uret-openssl-rand-hex-24@localhost:55432/maestro}"
export MAESTRO_STUDIO_HOST="${MAESTRO_STUDIO_HOST:-0.0.0.0}"
export MAESTRO_STUDIO_ALLOWED_HOSTS="${MAESTRO_STUDIO_ALLOWED_HOSTS:-coder.uguryildiz.tech,localhost}"

# ── durdur ───────────────────────────────────────────────────────────────────
stop_all() {
  echo "→ Maestro durduruluyor…"
  pkill -f "real-users.ts" 2>/dev/null || true
  pkill -f "src/bin/pilot.ts" 2>/dev/null || true
  pkill -f "apps/studio.*vite" 2>/dev/null || true
  # Port 7000'i tutan takılı vite'ı kesin öldür (bilinen tuzak)
  for port in 7000 7001 7020; do
    pid=$(ss -ltnp 2>/dev/null | grep ":$port " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
    [ -n "${pid:-}" ] && kill -9 "$pid" 2>/dev/null || true
  done
  sleep 2
  echo "  durduruldu."
}

if [ "${1:-}" = "stop" ]; then stop_all; exit 0; fi

# ── temiz başlangıç ──────────────────────────────────────────────────────────
stop_all

echo "→ BFF + Studio başlatılıyor (gerçek Postgres)…"
setsid pnpm -F @maestro/demo-stack exec tsx src/bin/real-users.ts \
  > "$LOG_DIR/bff-studio.log" 2>&1 &

echo "→ Pilot motoru başlatılıyor…"
setsid pnpm -F @maestro/deploy exec tsx src/bin/pilot.ts \
  > "$LOG_DIR/pilot.log" 2>&1 &

# ── sağlık kontrolü ──────────────────────────────────────────────────────────
wait_for() { # $1=ad $2=url
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$2" 2>/dev/null || echo 000)
    [ "$code" = "200" ] && { echo "  ✓ $1 hazır"; return 0; }
    sleep 2
  done
  echo "  ✗ $1 zaman aşımı (log: $LOG_DIR)"; return 1
}

echo "→ Servisler bekleniyor…"
wait_for "BFF (7001)"    "http://localhost:7001/healthz"
wait_for "Studio (7000)" "http://localhost:7000/"
wait_for "Pilot (7020)"  "http://localhost:7020/api/state" || echo "    (Pilot opsiyonel — Jira/OpenRouter env gerektirir)"

# ── özet ─────────────────────────────────────────────────────────────────────
cat <<EOF

════════════════════════════════════════════════════════════
  MAESTRO AYAKTA
════════════════════════════════════════════════════════════
  Studio (arayüz) : http://localhost:7000
  Dışarıdan       : http://coder.uguryildiz.tech
  Giriş           : admin (parola operatörde; unutulursa ./deploy/ugurdocker/reset-admin.sh deseni)

  Loglar          : $LOG_DIR/
  Durdurmak için  : ./maestro-baslat.sh stop
════════════════════════════════════════════════════════════
EOF
