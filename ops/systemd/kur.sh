#!/usr/bin/env bash
#
# Maestro systemd (user-level) birimlerini KURAR ama BAŞLATMAZ.
#
# Ne yapar:
#   1. maestro-stack.service + maestro-pilot.service → ~/.config/systemd/user/
#   2. systemctl --user daemon-reload
#   3. systemctl --user enable ...   (boot'ta başlasın diye işaretler — START ETMEZ)
#
# NEDEN START ETMİYOR: canlı sistemde script/elle başlatılmış Maestro süreçleri
# koşuyor olabilir (port 7000/7001/7020 çakışır). Kurulumdan sonra, UYGUN bir
# anda önce eskisini durdurup servisleri kendiniz başlatın:
#
#   ./maestro-baslat.sh stop
#   systemctl --user start maestro-stack maestro-pilot
#
set -euo pipefail
cd "$(dirname "$0")"

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

echo "→ Birim dosyaları kopyalanıyor → $UNIT_DIR"
cp maestro-stack.service maestro-pilot.service "$UNIT_DIR/"

echo "→ systemctl --user daemon-reload"
systemctl --user daemon-reload

echo "→ Boot'ta başlaması için enable (başlatmaz)"
systemctl --user enable maestro-stack.service maestro-pilot.service

# LINGER: user servisleri normalde ancak kullanıcı OTURUM AÇINCA başlar ve son
# oturum kapanınca ölür. Sunucuda "hiç kapanmayan worker" için linger şarttır:
# makine açılır açılmaz, kimse SSH yapmadan servisler kalkar ve oturumdan
# bağımsız yaşar. (Bir kez çalıştırmak yeter; root/şifre istemez.)
echo "→ Oturumdan bağımsız çalışma (linger) açılıyor"
loginctl enable-linger "$USER"

cat <<'EOF'

✓ Kurulum tamam — servisler ENABLE edildi, ama BAŞLATILMADI.

  Başlatmadan önce elle/script ile açılmış Maestro'yu durdurun:
    ./maestro-baslat.sh stop            (maestro kökünde)

  Sonra:
    systemctl --user start maestro-stack maestro-pilot

  Durum / log:
    systemctl --user status maestro-stack maestro-pilot
    journalctl --user -u maestro-pilot -f
EOF
