#!/usr/bin/env bash
# =============================================================================
# Maestro — yönetici parolası sıfırlama
# =============================================================================
# Kullanım (bu klasörde):
#   ./reset-admin.sh                # 'admin' hesabının parolasını sıfırlar
#   ./reset-admin.sh <kullanıcı>    # belirtilen hesabın parolasını sıfırlar
#
# Ne yapar: uygulama imajının İÇİNDE (migrate servisiyle aynı imaj, aynı
# bağımlılıklar) yeni bir RASTGELE parola üretir, bcrypt'leyip veritabanına
# yazar, parolayı ekrana BİR KEZ basar, hesabın açık oturumlarının tamamını
# kapatır ve ilk girişte parola değişimini ZORUNLU kılar.
#
# Parola hiçbir yere kaydedilmez ve bir daha gösterilmez. Not almadan
# kapattıysanız betiği yeniden çalıştırın — her çalıştırma YENİ parola üretir.
#
# Elle müdahale (psql'e hash yazmak) artık gerekmez ve önerilmez: bu betik aynı
# işi, BFF'in giriş yolunda kullandığı bcrypt gerçeklemesiyle ve doğrulayarak
# yapar (apps/deploy/src/bin/reset-admin-password.ts).
#
# deploy/banka/reset-admin.sh ile deploy/ugurdocker/reset-admin.sh BİLEREK
# birebir aynıdır; apps/deploy/test/reset-admin-bundle.test.ts bu ikizliği
# kilitler. Birini değiştiren diğerini de değiştirmelidir.
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*"; }
err()  { printf '\033[31m✘\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m→\033[0m %s\n' "$*"; }
die()  { err "$*"; exit 1; }

KULLANICI="${1:-admin}"
if [[ "$KULLANICI" == -* ]]; then
  echo "Kullanım: ./reset-admin.sh [kullanıcı-adı]   (varsayılan: admin)"
  exit 0
fi

# ── Ön koşullar ──────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker bulunamadı."
docker compose version >/dev/null 2>&1 || die "docker compose v2 bulunamadı."
docker info >/dev/null 2>&1 || die "docker daemon çalışmıyor ya da yetki yok (sudo?)."

# .env: compose dosyası zorunlu değişkenlerini (imaj adresleri, veritabanı
# parolası, COMPOSE_PROJECT_NAME) buradan okur. Yanlış klasörden çalıştırmayı
# da bu satır yakalar — betik her zaman kendi klasörünün .env'ini kullanır,
# dolayısıyla hangi yığına (maestro / kabul ortamı) dokunduğu .env'deki
# COMPOSE_PROJECT_NAME ile belirlenir; konteyner adı tahmin edilmez.
[[ -f .env ]] || die ".env yok. Bu betik kurulumun yapıldığı klasörde çalışır (install.sh ile aynı yer)."

# Veritabanı ayakta mı? `docker compose run migrate` bağımlılık olarak postgres'i
# kendisi de başlatır; ama kapalı bir yığında bunu SESSİZCE yapmak, operatörün
# "sistem zaten çalışıyor" varsayımını doğrulamadan veri katmanını ayağa
# kaldırmak olur. Kapalıysa adıyla söyleyip duralım.
pg_id=$(docker compose ps -q postgres 2>/dev/null || true)
if [[ -z "$pg_id" ]]; then
  err "postgres konteyneri çalışmıyor — yığın ayakta değil."
  err "  Önce yığını başlatın:  docker compose up -d"
  die "Parola sıfırlama, çalışan bir veritabanı gerektirir."
fi

info "Parola sıfırlanıyor: ${KULLANICI}"
info "(uygulama imajı içinde çalıştırılıyor; parola aşağıda BİR KEZ gösterilecek)"
echo

# Aynı imaj, farklı giriş noktası: MAESTRO_ENTRYPOINT ile migrate servisinin
# imajı reset komutunu çalıştırır. Böylece bcrypt ve Prisma istemcisi imajın
# içindeki derli node_modules'tan gelir — sunucuya node/pnpm kurulmaz.
RC=0
docker compose run --rm \
  -e MAESTRO_ENTRYPOINT=apps/deploy/dist/bin/reset-admin-password.js \
  migrate "$KULLANICI" || RC=$?

echo
if [[ "$RC" -eq 0 ]]; then
  warn "Yukarıdaki GEÇİCİ PAROLAYI ŞİMDİ not edin — bir daha gösterilmez."
  warn "İlk girişte panel yeni bir parola belirlemenizi zorunlu tutacak."
elif [[ "$RC" -eq 2 ]]; then
  die "Hesap bulunamadı — kullanıcı adını kontrol edip tekrar deneyin."
else
  err "Sıfırlama başarısız (çıkış kodu: ${RC})."
  err "  Veritabanı loglarına bakın:  docker compose logs postgres"
  die "Sorun sürerse migrate loglarıyla birlikte destek isteyin."
fi
