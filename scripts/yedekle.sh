#!/usr/bin/env bash
# =============================================================================
# Maestro — veritabanı yedeği
# =============================================================================
# Kullanım:
#   ./scripts/yedekle.sh              # yedek al
#   ./scripts/yedekle.sh --liste      # mevcut yedekleri göster
#
# Neden var: 2026-08-16'da canlı veritabanı bir temizlik komutuyla silindi ve
# geri getirilemedi, çünkü bu makinede hiç yedek yoktu. Yedeği olmayan bir
# veritabanı, silinene kadar sorunsuz görünür.
#
# Yedek, konteynerin İÇİNDEN değil dışından alınır: volume silindiğinde
# konteynerin içindeki her şey de gider, o yüzden dosya host'ta durur.
# =============================================================================
set -euo pipefail

YEDEK_DIZIN="${MAESTRO_YEDEK_DIZIN:-/home/ubuntu/maestro-yedek}"
KONTEYNER="${MAESTRO_PG_KONTEYNER:-maestro-postgres-1}"
VERITABANI="${POSTGRES_DB:-maestro}"
KULLANICI="${POSTGRES_USER:-maestro}"
# Kaç günlük yedek saklanır. Eskiler silinir; disk dolduğunda yedek almayı
# durduran bir betik, yedeği olmayan bir sistemden farksızdır.
SAKLAMA_GUN="${MAESTRO_YEDEK_GUN:-14}"

mkdir -p "$YEDEK_DIZIN"

if [[ "${1:-}" == "--liste" ]]; then
  echo "Yedekler ($YEDEK_DIZIN):"
  ls -lh "$YEDEK_DIZIN"/*.sql.gz 2>/dev/null | awk '{print "  ", $9, "—", $5, $6, $7, $8}' || echo "  (yedek yok)"
  exit 0
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$KONTEYNER"; then
  echo "HATA: '$KONTEYNER' çalışmıyor — yedek alınamaz." >&2
  exit 1
fi

DAMGA="$(date +%Y%m%d-%H%M%S)"
HEDEF="$YEDEK_DIZIN/maestro-$DAMGA.sql.gz"

# `pg_dump` çıktısı doğrudan sıkıştırılır: ara dosya yazmak, diskte yer olmadığı
# anda yarım bir yedek bırakır ve yarım yedek, yedek değildir.
docker exec "$KONTEYNER" pg_dump -U "$KULLANICI" -d "$VERITABANI" --clean --if-exists \
  | gzip -9 > "$HEDEF.gecici"

# Dosya ancak TAM yazıldıktan sonra gerçek adını alır. Yedek alırken kesilen bir
# işlem, geri yüklerken bozuk olduğu anlaşılan bir dosya bırakmamalı.
mv "$HEDEF.gecici" "$HEDEF"

BOYUT="$(du -h "$HEDEF" | cut -f1)"
echo "✔ Yedek alındı: $HEDEF ($BOYUT)"

# Sağlamlık kontrolü: sıkıştırma bozuksa şimdi öğrenmek, geri yüklerken
# öğrenmekten iyidir.
if gzip -t "$HEDEF" 2>/dev/null; then
  echo "✔ Dosya sağlam (gzip doğrulandı)."
else
  echo "✘ UYARI: yedek dosyası bozuk görünüyor!" >&2
  exit 1
fi

SILINEN="$(find "$YEDEK_DIZIN" -name 'maestro-*.sql.gz' -mtime "+$SAKLAMA_GUN" -print -delete | wc -l)"
[[ "$SILINEN" -gt 0 ]] && echo "  ($SILINEN adet $SAKLAMA_GUN günden eski yedek silindi)"

echo
echo "Geri yükleme:"
echo "  gunzip -c $HEDEF | docker exec -i $KONTEYNER psql -U $KULLANICI -d $VERITABANI"
