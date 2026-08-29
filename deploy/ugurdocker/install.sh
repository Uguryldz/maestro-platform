#!/usr/bin/env bash
# =============================================================================
# Maestro — registry kurulumu (imajlar registry'den çekilir)
# BUNDLE_VERSION: 2026-08-27
# =============================================================================
# Kullanım (bu klasörde):
#   ./install.sh          # interaktif (registry login sorar)
#   ./install.sh --yes    # sorusuz (login yapılmış varsayar)
#
# Ön koşul: docker + compose v2 kurulu, .env doldurulmuş, registry'ye erişim.
#
# TASARIM: bu betik yalnızca "çalıştıran" değil, ÖNCE DOĞRULAYAN bir betiktir.
# Buradaki her kontrol, sahada bir kez sessizce başarısız olmuş bir kurulumun
# karşılığıdır. Sessiz arıza — açılan ama hiçbir şey yapmayan bir sistem —
# gürültülü arızadan pahalıdır, bu yüzden hepsi erken ve yüksek sesle düşer.
#
# Banka paketinden (../banka/install.sh) TEK farkı: orada imajların `docker
# load` ile yüklenmiş olması beklenir, burada registry'den ÇEKİLİR. Doğrulama
# adımlarının tamamı aynen korunur — imajın nereden geldiği, içindekinin doğru
# olduğunu göstermez.
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

BUNDLE_VERSION="2026-08-27"

ok()   { printf '\033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*"; }
err()  { printf '\033[31m✘\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m→\033[0m %s\n' "$*"; }
die()  { err "$*"; exit 1; }

AUTO_YES=0
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && AUTO_YES=1

onay() {  # onay <soru>  → --yes modunda otomatik evet
  [[ "$AUTO_YES" -eq 1 ]] && return 0
  read -r -p "$1 [e/H] " a
  [[ "$a" =~ ^[eEyY]$ ]]
}

echo "=================================================="
echo "  Maestro — registry kurulumu"
echo "  Paket sürümü: ${BUNDLE_VERSION}"
echo "=================================================="

# ── 1) Ön koşullar ───────────────────────────────────────────────────────────
info "Ön koşullar kontrol ediliyor…"
command -v docker >/dev/null 2>&1 || die "docker bulunamadı."
docker compose version >/dev/null 2>&1 || die "docker compose v2 bulunamadı."
docker info >/dev/null 2>&1 || die "docker daemon çalışmıyor ya da yetki yok (sudo?)."
ok "docker + compose hazır."

CPU=$(nproc 2>/dev/null || echo "?")
RAM=$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo "?")
info "Kaynak: ${CPU} CPU / ${RAM} GB RAM"
if [[ "$RAM" != "?" && "$RAM" -lt 8 ]]; then
  warn "RAM ${RAM} GB — asgari 8 GB önerilir."
  onay "Yine de devam edilsin mi?" || exit 0
fi

# ── 2) .env ──────────────────────────────────────────────────────────────────
[[ -f .env ]] || die ".env yok.  cp .env.example .env  yapıp doldurun."
chmod 600 .env 2>/dev/null || true
ok ".env mevcut."

# Betiğin kendi sürümü, .env okunmadan ÖNCE saklanır: `. ./.env` aynı adlı
# değişkeni ezer ve karşılaştırma anlamsızlaşırdı.
BUNDLE_VERSION_SCRIPT="${BUNDLE_VERSION}"

# shellcheck disable=SC1091
set -a; . ./.env; set +a

# Paket ile .env aynı sürümden mi? Farklıysa büyük ihtimalle eski bir kurulumun
# .env'i yeni bir paketin üstüne kopyalanmıştır — yeni zorunlu alanlar eksik olur.
DOTENV_VERSION=$(grep -E '^BUNDLE_VERSION=' .env | head -1 | cut -d= -f2- | tr -d '"' || true)
if [[ -n "${DOTENV_VERSION:-}" && "${DOTENV_VERSION}" != "${BUNDLE_VERSION_SCRIPT}" ]]; then
  warn ".env sürümü (${DOTENV_VERSION}) paket sürümünden (${BUNDLE_VERSION_SCRIPT}) farklı."
  warn "  Eski bir .env yeni pakete kopyalanmışsa yeni ZORUNLU alanlar eksik olabilir."
  warn "  .env.example ile karşılaştırın:  diff <(grep -oE '^[A-Z_]+=' .env.example) <(grep -oE '^[A-Z_]+=' .env)"
  onay "Yine de devam edilsin mi?" || exit 0
fi

# Yükseltme yedeksiz yapılırsa GERİ DÖNÜŞ YOKTUR.
#
# Şema göçleri yalnızca İLERİ yöndedir; geri alma göçü yoktur. Yükseltme kötü
# giderse imaj etiketini eskiye çevirmek yetmez — yeni göç şemayı çoktan
# değiştirmiştir ve eski kod onu okuyamaz. Tek gerçek geri dönüş yolu,
# yükseltmeden ÖNCE alınmış veritabanı yedeğidir (README §7b).
#
# Bu yüzden mevcut bir kurulumun üstüne çıkılıyorsa yedek SORULUR. Sormak,
# altı ay sonra yedeği olmayan bir operatörle konuşmaktan ucuzdur.
if docker volume ls --format '{{.Name}}' 2>/dev/null \
   | grep -qE "^${COMPOSE_PROJECT_NAME:-maestro}_postgres-data$"; then
  YEDEK_SAYISI=$(ls -1 maestro-yedek-*.sql.gz 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${YEDEK_SAYISI}" == "0" ]]; then
    warn "Mevcut bir veritabanı volume'ü var (yükseltme) ama YEDEK BULUNAMADI."
    warn "  Şema göçleri geri alınamaz: yükseltme kötü giderse tek dönüş yolu yedektir."
    warn "  Şimdi almak için:"
    warn "    docker compose exec -T postgres pg_dump -U maestro maestro \\"
    warn "      | gzip > maestro-yedek-\$(date +%F-%H%M).sql.gz"
    warn "    cp .env .env.yedek-\$(date +%F-%H%M)"
    onay "Yedeksiz devam edilsin mi?" \
      || die "Yedeği alıp tekrar çalıştırın (README §7 adım 1)."
  else
    ok "Yedek bulundu (${YEDEK_SAYISI} dosya): $(ls -1t maestro-yedek-*.sql.gz 2>/dev/null | head -1)"
  fi
fi

# Doldurulmamış alanlar.
#
# Yalnızca GERÇEK atamalara bakılır (`^AD=`), açıklama satırlarına değil.
# Dosyanın tamamında düz arama yapmak, belirtecin adını ANLATAN bir yorum
# satırının kendisini "doldurulmamış alan" saymak demektir — nitekim bu bir kez
# oldu ve kusursuz doldurulmuş bir .env, bir açıklama cümlesi yüzünden
# reddedildi. Bir dosyanın kendi belgelenmesi, o dosyayı geçersiz kılmamalıdır.
EKSIK_SATIR=$(grep -nE '^[A-Za-z_][A-Za-z0-9_]*=.*DEGISTIR' .env || true)
if [[ -n "$EKSIK_SATIR" ]]; then
  err ".env içinde DEGISTIR kalmış — doldurulmamış alan var:"
  printf '%s\n' "$EKSIK_SATIR" | sed 's/^/    /'
  die "Bu alanları doldurup tekrar çalıştırın."
fi
ok "Doldurulmamış alan yok."

# ── 3) ZORUNLU değişkenler dolu mu ───────────────────────────────────────────
# Boş bırakılınca sistemin AÇILIP HİÇBİR ŞEY YAPMADIĞI değişkenler. Her biri
# ayrı ayrı kontrol edilir ki hata mesajı hangisinin eksik olduğunu söylesin.
#
# ⚠ Bu liste KISADIR ve kısalığı bilinçlidir: Jira jetonu, GitHub jetonu ve
#   model anahtarı burada YOKTUR çünkü panelden girilir. Bu adlardan birini
#   listeye eklemek, panelin zaten topladığı bir sırrı ikinci bir yerde daha
#   zorunlu kılmak olurdu — ve iki yer birbirinden habersiz olduğu sürece
#   ayrışabilirler.
info "Zorunlu değişkenler…"
ZORUNLU=(
  MAESTRO_NODE_IMAGE MAESTRO_STUDIO_IMAGE POSTGRES_IMAGE REDIS_IMAGE TEMPORAL_IMAGE
  NODE_ENV
  CONNECTOR_MASTER_KEY
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB REDIS_PASSWORD
  MAESTRO_SECRET_KV_JIRA__WEBHOOK
  STUDIO_PORT
)
# JIRA_TOKEN_REF / LLM_API_KEY_REF bu listede ARTIK YOK ve .env'de de yok.
# İkisi de sır ADRESİDİR, sır değeri değil; varsayılanları compose'da ve
# apps/deploy/src/env.ts'te birebir aynı yazılıdır. Zorunlu saymak, .env'den
# çıkarılmış bir satırı boş bulup kusursuz bir kurulumu reddetmek olurdu.
# Yazılmışlarsa biçimleri §6'da yine denetlenir.
EKSIK_VAR=()
for v in "${ZORUNLU[@]}"; do
  [[ -n "${!v:-}" ]] || EKSIK_VAR+=("$v")
done
if [[ ${#EKSIK_VAR[@]} -gt 0 ]]; then
  err "Şu ZORUNLU değişkenler boş:"
  for v in "${EKSIK_VAR[@]}"; do err "    ${v}"; done
  die ".env dosyasını doldurup tekrar çalıştırın."
fi
ok "Zorunlu değişkenlerin hepsi dolu."

# ── 3b) Hangi Jira: Cloud mu, Data Center mı ─────────────────────────────────
# Sürücüyü SEÇEN ayrı bir değişken yoktur; hangi adres doluysa o sürücü çalışır
# (apps/deploy/src/profile.ts, `workDriverFor`). Bu yüzden burada kontrol edilen
# şey "biri dolu mu" değil, "YALNIZCA biri mi dolu".
#
# İkisi birden dolu olduğunda süreç zaten açılışta adıyla reddediyor; burada
# tekrar bakılmasının sebebi, o reddin konteyner log'unda kalması ve kurulumu
# yapan kişinin ekranında hiç görünmemesidir.
info "Jira adresi…"
if [[ -n "${JIRA_BASE_URL:-}" && -n "${JIRA_CLOUD_BASE_URL:-}" ]]; then
  err "JIRA_BASE_URL ve JIRA_CLOUD_BASE_URL birlikte dolu."
  err "  Bu ikisi İKİ AYRI sürücüyü besler; hangisinin kullanılacağı TAHMİN EDİLMEZ."
  die "Bu kurulumun konuştuğu Jira hangisiyse yalnızca onun adresini bırakın."
elif [[ -n "${JIRA_CLOUD_BASE_URL:-}" ]]; then
  ok "Jira: Cloud (${JIRA_CLOUD_BASE_URL})."
elif [[ -n "${JIRA_BASE_URL:-}" ]]; then
  ok "Jira: Data Center (${JIRA_BASE_URL})."
else
  # Ölümcül DEĞİL: panel açılır ve kurulum panelden tamamlanabilir. Ama sessiz
  # de geçilmez — bu hâlde hiçbir ticket işlenmez.
  warn "Ne JIRA_BASE_URL ne de JIRA_CLOUD_BASE_URL dolu."
  warn "  Yığın açılır ve panel çalışır, ama HİÇBİR ticket işlenmez."
  warn "  Kullandığınız Jira'nın adresini .env §5'e yazıp yeniden başlatın."
fi

# ── 4) Altyapı katmanı (NODE_ENV'den türetilir) ──────────────────────────────
# Sırların ve belgelerin NEREDE durduğu tek başına NODE_ENV'den türetilir
# (apps/deploy/src/env.ts).
info "Altyapı katmanı…"
if [[ "${NODE_ENV}" == "production" ]]; then
  for v in VAULT_ADDR VAULT_ROLE_ID VAULT_SECRET_ID STORAGE_ENDPOINT; do
    [[ -n "${!v:-}" ]] || die "NODE_ENV=production ise ${v} zorunludur (Vault + S3 katmanı)."
  done
  ok "Altyapı: production (Vault + S3 doğrulandı)."
else
  ok "Altyapı: development (sırlar .env'de, belgeler Postgres'te)."
fi

# ── 5) Motorun Jira kimliği ──────────────────────────────────────────────────
# Artık ZORUNLU değil: panel, bağlantı testinde /myself çağrısıyla jetonun
# gerçek sahibini öğrenir ve bağlantıya kendisi yazar. Elle doldurulduğunda
# yalnızca bir karşılaştırma dayanağı olur — o yüzden burada boşluk değil,
# YANLIŞ BİÇİM aranır: e-posta yazılmışsa kurulum durur, çünkü o değer hiçbir
# zaman eşleşmeyecek bir kimliktir.
info "Motor kimliği…"
if [[ -z "${MAESTRO_BOT_ACCOUNT_ID:-}" ]]; then
  ok "MAESTRO_BOT_ACCOUNT_ID boş — kimlik panelden, bağlantı testinde öğrenilecek."
elif [[ "${MAESTRO_BOT_ACCOUNT_ID}" =~ [@] ]]; then
  err "MAESTRO_BOT_ACCOUNT_ID bir e-posta gibi görünüyor: ${MAESTRO_BOT_ACCOUNT_ID}"
  err "  Beklenen: Jira Cloud accountId (profil adresindeki son parça),"
  err "  Data Center'da ise kullanıcı adı. E-posta MAESTRO_BOT_EMAIL'e yazılır."
  err "  Emin değilseniz BOŞ BIRAKIN; panel testi doğrusunu kendisi bulur."
  die "MAESTRO_BOT_ACCOUNT_ID düzeltilmeli."
else
  ok "MAESTRO_BOT_ACCOUNT_ID dolu."
  warn "Kurulumdan sonra DOĞRULAYIN: panelde Ayarlar > Bağlantılar > test, bu kimlikle"
  warn "  bağlantının kimliği AYNI olmalı. Farklıysa panel uyarır ve kurallar boş döner."
fi

# ── 6) Sır adları elle yazılmış mı ───────────────────────────────────────────
# Sürücü değişken adını referanstan TÜRETİR (kv/jira#webhook →
# MAESTRO_SECRET_KV_JIRA__WEBHOOK, '#' çift alt çizgi). Elle yazılmış adlar hiç
# aranmaz: sürücü "secret not found" derken operatör .env'de değeri dolu görür.
info "Sır değişken adları…"
for eski in MAESTRO_SECRET_JIRA_TOKEN MAESTRO_SECRET_JIRA_WEBHOOK MAESTRO_SECRET_ADO_TOKEN \
            MAESTRO_SECRET_LLM_API_KEY MAESTRO_SECRET_GITHUB_TOKEN \
            MAESTRO_SECRET_LDAP_BIND_PASSWORD; do
  if grep -qE "^${eski}=" .env 2>/dev/null; then
    err ".env içinde ESKİ sır değişkeni var: ${eski}"
    err "  Bu adı hiçbir sürücü aramaz. Doğru adlar referanstan türetilir:"
    err "    kv/jira#webhook →  MAESTRO_SECRET_KV_JIRA__WEBHOOK   ('#' ÇİFT alt çizgi)"
    err "    kv/llm#api-key  →  MAESTRO_SECRET_KV_LLM__API__2D_KEY  ('-' → __2D_)"
    die ".env.example'daki adları kullanın."
  fi
done
# Referans biçimi: <mount>/<yol>[#alan] — en az bir '/' içermeli.
for refvar in JIRA_TOKEN_REF LLM_API_KEY_REF JIRA_WEBHOOK_SECRET_REF GITHUB_TOKEN_REF; do
  val="${!refvar:-}"
  [[ -z "$val" ]] && continue
  if [[ "$val" != */* ]]; then
    err "${refvar}='${val}' geçersiz."
    err "  Beklenen biçim: <mount>/<yol>[#alan]  örn. kv/jira#token"
    err "  'env:JIRA_TOKEN' gibi bir değer ayrıştırılamaz ve açılışta SecretKeyError verir."
    die "${refvar} düzeltilmeli."
  fi
done
ok "Sır adları ve referans biçimleri doğru."

# CONNECTOR_MASTER_KEY tam 32 bayt (base64) olmalı; değilse BFF açılışta ölür.
KEY_BYTES=$(printf '%s' "${CONNECTOR_MASTER_KEY}" | base64 -d 2>/dev/null | wc -c || echo 0)
if [[ "${KEY_BYTES}" -ne 32 ]]; then
  err "CONNECTOR_MASTER_KEY base64 çözüldüğünde 32 bayt olmalı, ${KEY_BYTES} bayt çıktı."
  err "  Üretmek için:  openssl rand -base64 32"
  die "CONNECTOR_MASTER_KEY düzeltilmeli."
fi
ok "CONNECTOR_MASTER_KEY geçerli (32 bayt)."

# ── 7) Sık yapılan yapılandırma hataları ─────────────────────────────────────
info "Yapılandırma tutarlılığı…"

# Model .env'de tanımlı değilse bu bir HATA DEĞİL: adres, model adı ve anahtar
# artık "Ayarlar & bağlantılar" ekranından girilir ve kaydedildiği anda geçerli
# olur. Kurulum açılır; model tanımlanana kadar ilk model çağrısı adıyla
# reddedilir. Operatöre nereye bakacağını söylemek, sessizce geçmekten iyidir.
if [[ -z "${LLM_BASE_URL:-}" ]]; then
  info "LLM_BASE_URL boş — model PANELDEN tanımlanacak."
  info "  Kurulum bitince Studio > 'Ayarlar & bağlantılar' > 'Bağlantı ekle' >"
  info "  'Kurum içi model sunucusu (OpenAI uyumlu)': adres + model adı +"
  info "  (gerekiyorsa) anahtar, ardından 'Test et'."
fi

# ── autoheal'in soket erişimi ────────────────────────────────────────────────
# Konteyner uid 10001 ile koşar, soket root:docker sahiplidir. Doğru gid
# olmadan autoheal her çağrısında EACCES alır ve sessizce işe yaramaz —
# ilk sürümü tam olarak böyle çıktı, canlıda yakalandı.
#
# Elle doldurulmasını beklemek yerine burada bulunur: .env'deki değer hostun
# gerçeğiyle uyuşmuyorsa düzeltilir ve söylenir.
if [[ -S "${DOCKER_SOCKET_PATH:-/var/run/docker.sock}" ]]; then
  GERCEK_GID=$(stat -c '%g' "${DOCKER_SOCKET_PATH:-/var/run/docker.sock}" 2>/dev/null || echo "")
  if [[ -n "$GERCEK_GID" && "${DOCKER_GID:-}" != "$GERCEK_GID" ]]; then
    if grep -q '^DOCKER_GID=' .env 2>/dev/null; then
      sed -i "s|^DOCKER_GID=.*|DOCKER_GID=\"${GERCEK_GID}\"|" .env
    else
      printf '\nDOCKER_GID="%s"\n' "$GERCEK_GID" >> .env
    fi
    export DOCKER_GID="$GERCEK_GID"
    ok "Docker soket grubu bulundu ve .env'e yazıldı (DOCKER_GID=${GERCEK_GID})."
  fi
fi

# ── Analiz kurulumu: iki değişken sessizce açık kalırsa akış BİTMEZ ──────────
# Bu ikisi .env'de yorumlu gelir, ve ikisinin de boş kalması sahada aynı
# cümleye çıkıyor: "analiz bile yapamadım".
#
#  · MAESTRO_FLOW boş  → kural dışı kalan ticket TAM boru hattına girer. Analiz
#    yazılır, iki kapıdan geçer, sonra mühendislik adımında RUNNER_IMAGE_LINUX
#    yok diye ölür — yani iş bittikten SONRA, en pahalı yerde.
#  · JIRA_POLL_MS boş  → Jira yorumundaki /approve hiç okunmaz. Jira Cloud'da
#    webhook imzası doğrulanamadığı için bu tek yoldur; kapı sonsuza dek açık
#    bekler ve koşu "takıldı" görünür.
#
# Kurulum bunları dayatmaz — kod yazan bir saha için ikisi de doğru olabilir —
# ama sessizce geçmez: soran bir betik, bir hafta sonra log okuyan operatörden
# ucuzdur.
if [[ -z "${MAESTRO_FLOW:-}" ]]; then
  warn "MAESTRO_FLOW boş: hiçbir kurala uymayan ticket KOD YAZAN akışa düşer."
  warn "  Bu paket sanal makine filosu (RUNNER_IMAGE_LINUX) TAŞIMAZ; o akış"
  warn "  analiz yazıldıktan ve iki kapı onaylandıktan SONRA hata verir."
  warn "  Yalnız analiz için kurduysanız .env'de:  MAESTRO_FLOW=\"analiz\""
  onay "Böyle devam edilsin mi (kod yazan akış açık kalsın)?" \
    || die "MAESTRO_FLOW=\"analiz\" yazıp tekrar çalıştırın."
fi
if [[ -z "${JIRA_POLL_MS:-}" || "${JIRA_POLL_MS:-0}" == "0" ]]; then
  warn "JIRA_POLL_MS boş: ticket'a yazılan /approve OKUNMAZ, kapılar açık kalır."
  warn "  Jira Cloud kullanıyorsanız .env'de:  JIRA_POLL_MS=\"60000\""
  warn "  (Webhook'u çalışan bir Data Center kurulumunda kapalı kalması DOĞRUdur.)"
  onay "Böyle devam edilsin mi (yoklama kapalı kalsın)?" \
    || die "JIRA_POLL_MS ayarlayıp tekrar çalıştırın."
fi

if [[ -z "${GATE_GROUPS:-}" && -z "${GATE_GROUP_DEFAULT:-}" ]]; then
  warn "GATE_GROUPS ve GATE_GROUP_DEFAULT boş: onay grupları EŞLENMEMİŞ."
  warn "  Bu durumda Maestro rolün kendi adını grup adı sayar ve Jira'da"
  warn "  'product-owners', 'tech-leads', 'qa' gruplarını arar. Bu adlarda grup"
  warn "  yoksa HER /approve \"üye değil\" diye reddedilir; kapı sonsuza dek"
  warn "  bekler ve koşu takılmış görünür — hata vermez."
  warn "  Kendi grup adlarınızı .env'de eşleyin, örnek:"
  warn "    GATE_GROUPS=\"product-owners=jira-po-grubu,tech-leads=jira-lider-grubu\""
  warn "  Tek onay grubu varsa:  GATE_GROUP_DEFAULT=\"maestro-onay\""
  onay "Böyle devam edilsin mi (rol adları grup adı olarak kullanılsın)?" \
    || die "GATE_GROUPS ya da GATE_GROUP_DEFAULT ayarlayıp tekrar çalıştırın."
fi

if [[ -n "${JIRA_DISCOVER_MS:-}" && "${JIRA_DISCOVER_MS:-0}" != "0" \
      && -z "${JIRA_CLOUD_BASE_URL:-}" ]]; then
  warn "JIRA_DISCOVER_MS dolu ama Jira CLOUD bağlantısı yok."
  warn "  Ticket TARAMASI (JQL) yalnız Jira Cloud sürücüsünde vardır; Data Center"
  warn "  kurulumunda tarama çalışmaz ve ticket'lar yalnız WEBHOOK ile gelir."
  warn "  Data Center kullanıyorsanız webhook'u kurduğunuzdan emin olun."
  onay "Böyle devam edilsin mi (tarama kapalı, yalnız webhook)?" \
    || die "Jira Cloud bağlantısı tanımlayın ya da JIRA_DISCOVER_MS'i boşaltın."
fi

# LLM_BASE_URL sonunda /v1 → sürücü de ekler → /v1/v1 → her çağrı 404
# (Yalnız .env'e adres yazılmışsa. Model artık panelden tanımlanabilir; boş
# bırakılmışsa denetlenecek bir adres yoktur.)
if [[ -n "${LLM_BASE_URL:-}" && "${LLM_BASE_URL}" =~ /v1/?$ ]]; then
  err "LLM_BASE_URL sonunda '/v1' var: ${LLM_BASE_URL}"
  err "  Sürücü '/v1/chat/completions' ekler; bu hâliyle '/v1/v1/...' olur ve"
  err "  her model çağrısı 404 döner. Sondaki '/v1' kısmını silin."
  die "LLM_BASE_URL düzeltilmeli."
fi

# Kurum içi endpoint ama on-prem bayrağı kapalı → gizli işler bozularak biter
if [[ -n "${LLM_BASE_URL:-}" && "${LLM_ON_PREM:-}" != "true" ]]; then
  warn "LLM_ON_PREM='${LLM_ON_PREM:-}' — 'true' değil."
  warn "  Bu hâlde 'gizli' sınıflı işlerde on-prem model YOK sayılır; analiz"
  warn "  'elle tamamlayın' diye bozularak biter — hata değil, eksik çıktı."
  onay "Bilerek mi böyle?" || die "LLM_ON_PREM=true yapın."
fi

# BFF_PORT artık .env'den OKUNMAZ; compose onu 7001'de sabitler. Eski bir
# .env'de kalmış olabilir ve orada durduğu sürece operatör onu değiştirilebilir
# sanır. Değiştirdiğinde de yığın açılmaz: 7001 sayısı compose'daki
# healthcheck'te ve studio-nginx.conf'taki proxy_pass satırında SABİTTİR.
if [[ -n "${BFF_PORT:-}" && "${BFF_PORT}" != "7001" ]]; then
  err ".env içinde BFF_PORT='${BFF_PORT}' var; bu ayar artık KULLANILMIYOR."
  err "  BFF'in konteyner içindeki portu 7001'de sabittir (compose yazar) ve"
  err "  aynı sayı healthcheck ile studio-nginx.conf'ta da sabit durur. Bu satır"
  err "  değiştirildiği anda bff hiç 'healthy' olmaz ve studio hiç başlamaz."
  err "  Panelin dışarıya açıldığı portu değiştirmek için STUDIO_PORT kullanın."
  die ".env'den BFF_PORT satırını silin."
fi

# Kurumsal CA dosyası gerçekten var mı
if [[ -n "${NODE_EXTRA_CA_CERTS:-}" ]]; then
  CA_LOCAL="${CA_BUNDLE_DIR:-./certs}/$(basename "${NODE_EXTRA_CA_CERTS}")"
  if [[ ! -f "$CA_LOCAL" ]]; then
    err "NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS} ayarlı ama dosya yok: ${CA_LOCAL}"
    err "  Kurum kök CA'sını '${CA_BUNDLE_DIR:-./certs}' klasörüne koyun."
    die "CA dosyası eksik."
  fi
  ok "Kurumsal CA bulundu: ${CA_LOCAL}"
fi

# LDAP seçiliyse KODUN OKUDUĞU alanlar dolu mu.
# Dikkat: LDAP_USER_BASE_DN. `LDAP_BASE_DN` adını hiçbir şema okumaz — LDAP
# dolu görünüp hiç çalışmaz.
if [[ "${IDENTITY_DRIVER:-}" == "ldaps-bind" ]]; then
  for v in LDAP_URL LDAP_USER_BASE_DN LDAP_BIND_DN; do
    [[ -n "${!v:-}" ]] || die "IDENTITY_DRIVER=ldaps-bind ama ${v} boş."
  done
  [[ "${LDAP_URL}" == ldaps://* ]] \
    || die "LDAP_URL 'ldaps://' ile başlamalı — düz ldap:// parolayı açık metin gönderir."
  [[ -n "${MAESTRO_SECRET_KV_LDAP__SERVICE__2D_PASSWORD:-}" ]] \
    || die "IDENTITY_DRIVER=ldaps-bind ama MAESTRO_SECRET_KV_LDAP__SERVICE__2D_PASSWORD boş."
  ok "LDAP alanları dolu."
fi
ok "Yapılandırma tutarlı."

# ── 8) Registry oturumu ──────────────────────────────────────────────────────
# Bu paket imajları ÇEKER. Özel bir registry kullanıyorsanız `docker login`
# yapılmış olmalıdır; yoksa `pull` "unauthorized" ya da "not found" der ve iki
# hata birbirinden ayırt edilemez — kimliği olmayan bir istemciye çoğu registry
# deponun VARLIĞINI de söylemez.
#
# Registry adı imaj adresinden TÜRETİLİR, ayrı bir değişkende tutulmaz: iki yer
# ayrıştığında login bir registry'ye yapılıp imaj başka birinden çekilmeye
# çalışılırdı. Adreste eğik çizgi öncesi parça bir nokta ya da iki nokta üst
# üste içeriyorsa host'tur; içermiyorsa (örn. `maestro/node`) Docker Hub'dır.
info "Registry oturumu…"
REG_HOST="${MAESTRO_NODE_IMAGE%%/*}"
if [[ "${REG_HOST}" == "${MAESTRO_NODE_IMAGE}" || ( "${REG_HOST}" != *.* && "${REG_HOST}" != *:* ) ]]; then
  REG_HOST="docker.io"
fi
if grep -q "\"${REG_HOST}\"" ~/.docker/config.json 2>/dev/null; then
  ok "Oturum mevcut: ${REG_HOST}"
else
  warn "${REG_HOST} için kayıtlı oturum görünmüyor."
  warn "  Genel (public) bir depo ise gerek yok; özel depo ise 'pull' başarısız olur."
  if [[ "$AUTO_YES" -eq 0 ]]; then
    if onay "Şimdi 'docker login ${REG_HOST}' çalıştırılsın mı?"; then
      docker login "${REG_HOST}" || die "Registry oturumu açılamadı."
      ok "Oturum açıldı."
    fi
  else
    warn "  --yes modunda otomatik login yapılmaz. Gerekiyorsa: docker login ${REG_HOST}"
  fi
fi

# ── 9) İmajları çek ──────────────────────────────────────────────────────────
# `pull` başarısız olursa DURULUR. Devam etseydik `up -d` yerel bir imaja
# düşebilir — hangi sürümün çalıştığı ise artık bilinmezdi.
info "İmajlar çekiliyor (ilk sefer ~2.5 GB)…"
if ! docker compose pull; then
  err "İmaj çekilemedi."
  err "  Sık sebepler:"
  err "    · ${REG_HOST} için oturum açılmamış  →  docker login ${REG_HOST}"
  err "    · .env'deki imaj adresi/etiketi registry'de yok (adı ve etiketi doğrulayın)"
  err "    · sunucudan registry'ye ağ erişimi yok (vekil/güvenlik duvarı)"
  die "İmajları çekip tekrar çalıştırın."
fi
ok "İmajlar hazır."

# `latest` etiketi geri almayı imkânsızlaştırır ve bir dahaki `pull` sessizce
# başka bir imaj getirir.
for img in "${MAESTRO_NODE_IMAGE}" "${MAESTRO_STUDIO_IMAGE}"; do
  [[ "$img" == *:latest || "$img" != *:* ]] && \
    warn "  ${img} — 'latest' etiketi: hangi sürümün kurulu olduğu belirsizleşir, geri alma zorlaşır."
done

# ── 10) İmaj sağlığı (bayat/bozuk imaj erken yakalansın) ─────────────────────
# İmajın registry'den gelmiş olması içindekinin doğru olduğunu göstermez:
# registry, kendisine ne push edildiyse onu verir.
info "İmaj doğrulanıyor…"
if docker run --rm --entrypoint sh "${MAESTRO_NODE_IMAGE}" -c "openssl version" >/dev/null 2>&1; then
  ok "  OpenSSL kurulu (Prisma query engine için gerekli)."
else
  warn "  İmajda OpenSSL YOK. Prisma sürüm tahmini yapar; sorun çıkarsa imajı yeniden build edin."
fi

MIG_SAYI=$(docker run --rm --entrypoint sh "${MAESTRO_NODE_IMAGE}" \
  -c "ls /app/packages/db/prisma/migrations 2>/dev/null | grep -c '^[0-9]'" 2>/dev/null || echo 0)
# Bu paketin beklediği asgari migration KLASÖRÜ sayısı. Son migration 0021'dir
# (0021_connection_model_registry — panelden model tanımlamanın şeması) ama
# klasör sayısı 22'dir: iki klasör 0011 önekini paylaşır
# (0011_failed_run_is_terminal, 0011_listening_rules). Sayıyı en yüksek öneke
# bakarak tahmin etmek bu yüzden yanlış olur.
#
# Bu sayı elle yazılıdır ve bir kez sessizce bayatladı: 0021 eklendiğinde satır
# 21'de kaldı ve `-ge` karşılaştırması panel-öncesi bir imajı (1.0.0) yeşil
# geçirdi. apps/deploy/test/ugurdocker-bundle.test.ts artık bu sayıyı depodaki
# klasör sayısıyla karşılaştırır — yeni migration eklendiğinde test kırmızıya
# düşer ve satır güncellenmeden paket çıkamaz.
#
# İmaj bundan azını taşıyorsa eski bir koddan build edilmiştir: şema eksik
# kurulur ve eksik bir sütuna yazan kod hata vermeden çalışır — değer hiç
# veritabanına ulaşmaz.
MIG_BEKLENEN=22
if [[ "${MIG_SAYI}" -ge "${MIG_BEKLENEN}" ]]; then
  ok "  Migration dosyası: ${MIG_SAYI} adet (asgari ${MIG_BEKLENEN})."
else
  err "  İmajda ${MIG_SAYI} migration var, en az ${MIG_BEKLENEN} bekleniyordu."
  err "  İmaj ESKİ koddan build edilmiş. Eksik şemayla açılan sistem, yeni"
  err "  sütunlara yazarken hata vermez — veri sessizce kaybolur."
  die "Güncel koddan yeniden build edip registry'ye push edin."
fi

# Prisma istemcisi imajda üretilmiş mi. Üretilmemiş/bayat bir istemci yeni
# sütunu yok sayar: kod tip denetiminden geçer, yazar, değer Postgres'e HİÇ
# ULAŞMAZ. Bugüne kadar iki kez tam olarak bu yaşandı.
# pnpm, üretilen istemciyi `.pnpm` deposunun içine koyar; yol sürüm etiketini
# taşıdığı için sabit yazılamaz — bu yüzden yol tahmin edilmez, ARANIR.
if docker run --rm --entrypoint sh "${MAESTRO_NODE_IMAGE}" \
     -c "find /app -path '*/.prisma/client/index.js' -print -quit 2>/dev/null | grep -q ." >/dev/null 2>&1; then
  ok "  Prisma istemcisi imajda üretilmiş."
else
  err "  Prisma istemcisi imajda YOK."
  err "  Bu hâlde yeni sütunlara yazan kod hata vermeden çalışır ve değer"
  err "  veritabanına hiç ulaşmaz. İmaj kullanılamaz."
  die "İmajı yeniden build edin (Dockerfile.node 'prisma generate' adımını içerir)."
fi

# İmajın içinde doldurulmuş bir .env kalmış mı.
#
# Bu bir yapılandırma kontrolü değil, GÜVENLİK kontrolüdür ve buraya bir kez
# gerçekten yaşandığı için konuldu: sahaya çıkacak imajda `/app/deploy/.env`
# vardı — 18 KB, içinde tek bir DEGISTIR kalmamış, yani geliştiricinin gerçek
# veritabanı parolası ve jetonları. Sebep `.dockerignore`'daki `.env` kalıbının
# eğik çizgi içermemesiydi: böyle bir kalıp yalnızca bağlam kökünde eşleşir ve
# `deploy/.env` hiç dışlanmamıştı.
#
# Kalıp düzeltildi (`**/.env`), ama düzeltilen şey KAYNAKTIR; registry'deki
# etiket ondan önce build edilmiş olabilir ve dışarıdan bakınca ikisi ayırt
# edilemez. Bir registry'ye push edilen sızıntı, bir tar dosyasındakinden daha
# geniş dağılır: o etiketi çeken herkese gider.
if docker run --rm --entrypoint sh "${MAESTRO_NODE_IMAGE}" \
     -c "find /app -name '.env' -not -name '*.example' -print -quit 2>/dev/null | grep -q ." >/dev/null 2>&1; then
  err "  İmajın İÇİNDE bir .env dosyası var — gerçek kimlik bilgisi taşıyor olabilir."
  err "  Görmek için:"
  err "    docker run --rm --entrypoint sh ${MAESTRO_NODE_IMAGE} -c \"find /app -name '.env' -not -name '*.example'\""
  err "  Bu etiket KULLANILMAMALI ve registry'den SİLİNMELİDİR. '.dockerignore'"
  err "  içindeki kalıbın '**/.env' olduğu güncel koddan yeniden build edin."
  die "İmajda kimlik bilgisi sızıntısı var."
fi
ok "  İmajda doldurulmuş .env yok."

# ── 11) Compose doğrula ──────────────────────────────────────────────────────
info "Compose doğrulanıyor…"
docker compose config >/dev/null || die "compose config HATALI (.env eksik/yanlış?)."
ok "Compose geçerli."

# ── 11b) ORTAM ÖN DOĞRULAMASI — şemanın kendisiyle ───────────────────────────
# Yukarıdaki adımlar değişkenleri tek tek kontrol eder ve YİNE DE açılamayan bir
# yığını geçirdi. Sebep, listenin eksik olması değil — YÖNTEMİN eksik olması:
# betik "hangi değişkenler önemli" sorusunu ELLE yanıtlıyor, süreç ise bunu
# `packages/config`'teki şemadan öğreniyor. İki liste ayrı yerlerde durduğu
# sürece ayrışırlar, ve ayrıştıkları gün fark ediliş biçimi budur: sıra sıra
# yeşil tik, ardından `migrate` konteynerinin tek satırlık ölümü.
#
# Somut olay: compose `ADO_BASE_URL: ${ADO_BASE_URL:-}` satırıyla değişkeni
# İLETİR, .env'de ise değişken hiç yoktur. Compose'un "tanımsız" diye bir
# aktarımı yoktur; süreç değeri BOŞ DİZE olarak alır. Şema o gün boş dizeyi
# reddediyordu ve dört ayrı `Invalid URL` satırı, operatörün hiç duymadığı dört
# değişkeni suçluyordu. Şema düzeltildi (boş = yok), ama düzeltilen tek bir
# arızaydı; buradaki kontrol arıza SINIFINI kapatır.
#
# Yöntem: değişken adı SAYMAK yerine, konteynerin gerçekten göreceği ortamı
# şemanın KENDİSİNE doğrulatmak. `docker compose run` ile bff servisinin ortamı
# aynen kurulur — compose ne iletiyorsa o, boş dizeler dahil — ve içeride
# `loadDeployEnv` çağrılır. Bu, açılışta çalışan doğrulamanın ta kendisidir.
# Dolayısıyla burada geçen bir ortam açılışta da geçer, ve buradaki liste asla
# bayatlayamaz: liste yoktur, şema vardır.
#
# `--no-deps`: hiçbir servise, veritabanına ya da ağa dokunmaz; yalnızca ortamı
# okur.
info "Ortam, uygulamanın kendi şemasıyla ön doğrulamadan geçiriliyor…"
# `./dist/env.js` ve çıplak `node`, `./src/env.ts` + tsx DEĞİL: yayınlanmış
# imaj yalnızca derlenmiş `dist/`i taşır — `src/` de, tsx de imajda YOKTUR
# (deploy/docker/Dockerfile.node, allow-list budaması). Betik bir kez src/'ı
# import etti ve her kurulum burada ERR_MODULE_NOT_FOUND ile öldü.
ONDOGRULAMA='
import { loadDeployEnv } from "./dist/env.js";
try {
  loadDeployEnv();
  console.log("ORTAM_GECERLI");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
'
if ! ONDOGRULAMA_CIKTI=$(docker compose run --rm --no-deps \
      --entrypoint sh bff -c \
      "cd apps/deploy && node --input-type=module -e '${ONDOGRULAMA}'" 2>&1); then
  err "Ortam doğrulaması BAŞARISIZ — bu yığın açılamaz."
  printf '%s\n' "${ONDOGRULAMA_CIKTI}" | sed 's/^/    /' >&2
  err ""
  err "Bu, uygulamanın açılışta yaptığı doğrulamanın aynısıdır; şimdi başarısız"
  err "olması, 'migrate' konteynerinin birazdan aynı hatayla ölmesi demektir."
  err ""
  err "Çıktıda ERR_MODULE_NOT_FOUND varsa sorun .env DEĞİLDİR: bu betiğin"
  err "  import ettiği dosya imajda yoktur. İmaj etiketinin bu paketle aynı"
  err "  sürümden geldiğini doğrulayın (imaj apps/deploy/dist/env.js taşımalı)."
  err ""
  err "Onun dışında en sık sebep: compose'un ilettiği bir değişken .env'de HİÇ"
  err "  YOKTUR. Compose \${DEGISKEN:-} yazan her satırı BOŞ DİZE olarak iletir;"
  err "  şema bazı alanlarda boş dizeyi 'yok' saymaz. Yukarıda adı geçen her"
  err "  değişkeni .env'de ya doğru değerle doldurun ya da tamamen silin."
  die "Ortamı düzeltip tekrar çalıştırın."
fi
ok "Ortam şemaya uygun (uygulamanın açılış doğrulaması geçildi)."

# ── 12) Başlat ───────────────────────────────────────────────────────────────
info "Veri katmanı başlatılıyor…"
docker compose up -d postgres redis temporal

info "Şema kuruluyor (migrate)…"
if ! docker compose run --rm migrate; then
  err "Migration başarısız. Log:  docker compose logs migrate"
  die "Şema kurulamadı."
fi
ok "Şema kuruldu."

# İlk kurulumda migrate 'admin' hesabını RASTGELE bir geçici parolayla üretir ve
# parolayı YALNIZCA yukarıdaki çıktıda basar ("GEÇİCİ PAROLA" satırı). Parola
# hiçbir yere kaydedilmez; konteyner --rm ile silindiği için log da kalmaz.
# Güncelleme kurulumunda (hesap zaten varken) böyle bir satır çıkmaz.
warn "İLK KURULUMSA: yukarıdaki 'GEÇİCİ PAROLA' satırını ŞİMDİ not edin — bir daha gösterilmez."
warn "  Not almadıysanız/kaybettiyseniz yenisi:  ./reset-admin.sh admin"

info "Uygulama başlatılıyor…"
docker compose up -d

# ── 13) Sağlık ───────────────────────────────────────────────────────────────
echo
info "Servislerin hazır olması bekleniyor (~90 sn)…"
# Konteynerler ADIYLA değil, compose'a SORULARAK bulunur: bu paket sabit
# `container_name:` kullanmaz (aynı sunucuda ikinci kurulumu imkânsız kılardı),
# dolayısıyla gerçek ad yığın adına göre değişir (`maestro-bff-1`,
# `kabul-bff-1`). Sabit ad yazılsaydı `docker inspect` hata verir, `|| echo ""`
# onu yutar ve betik sapasağlam bir yığın için 150 saniye sonra "hazır olmadı"
# derdi.
HAZIR=0
for i in $(seq 1 30); do
  bff_id=$(docker compose ps -q bff 2>/dev/null || true)
  std_id=$(docker compose ps -q studio 2>/dev/null || true)
  bff=""; std=""
  [[ -n "$bff_id" ]] && bff=$(docker inspect "$bff_id" --format '{{.State.Health.Status}}' 2>/dev/null || echo "")
  [[ -n "$std_id" ]] && std=$(docker inspect "$std_id" --format '{{.State.Health.Status}}' 2>/dev/null || echo "")
  if [[ "$bff" == "healthy" && "$std" == "healthy" ]]; then HAZIR=1; break; fi
  sleep 5
done

echo
docker compose ps
echo
if [[ "$HAZIR" -eq 1 ]]; then
  ok "KURULUM TAMAM."
else
  warn "Servisler beklenen sürede 'healthy' olmadı — aşağıdaki logları inceleyin."
fi

PORT="${STUDIO_PORT:-7000}"
echo
echo "  Panel   : http://<SUNUCU_IP>:${PORT#*:}"
echo "  Giriş   : admin / <migrate çıktısındaki GEÇİCİ PAROLA> — ilk girişte değişim ZORUNLU"
echo "  Parola  : kaybolduysa  ./reset-admin.sh admin  yeni geçici parola üretir"
echo "  Loglar  : docker compose logs -f bff"
echo "  Durum   : docker compose ps"
echo "  Yedek   : docker compose exec -T postgres pg_dump -U ${POSTGRES_USER} ${POSTGRES_DB} | gzip > yedek.sql.gz"
echo
warn "KURULUM BİTMEDİ — sıradaki iş PANELDE (README.md §5):"
warn "  1) admin hesabına geçici parolayla girip kendi parolanızı belirleyin (panel zorunlu tutar)"
warn "  2) Ayarlar & bağlantılar → Jira bağlantısı ekleyin, jetonu girip 'Test et'"
warn "  3) Ayarlar & bağlantılar → GitHub bağlantısı ekleyin (kod yazan akışlar için)"
warn "  4) /setup sihirbazını çalıştırın"
warn "  5) Jira webhook'unu kaydedin (docs/jira-webhook-kurulum.md)"
echo
warn "ASLA 'docker compose down -v' çalıştırmayın — veritabanını siler."
