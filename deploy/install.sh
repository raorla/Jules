#!/bin/sh
# Installation d'un serveur Jules en une commande (M11) : vérifie l'hôte, crée les secrets locaux,
# remplit deploy/.env, construit les images, démarre la pile et installe les timers de sauvegarde.
# Relançable : ce qui existe est gardé (secrets, réglages déjà remplis), le reste est complété.
# Guide : docs/guide-admin.md ; détail des étapes : deploy/README.md.
set -eu
cd "$(dirname "$0")"

usage() {
  cat <<'USAGE'
usage : deploy/install.sh [options]
  --domain <nom>          domaine public de l'interface (Caddy ou tunnel)
  --admins <a,b>          logins GitHub des admins de l'instance
  --expose caddy|tunnel   exposition TLS (caddy par défaut)
  --github-app-id <n>     identifiant de la GitHub App (README §3) : démarre aussi le worker
  --systemd               installe et active les timers de sauvegarde (root, /opt/jules)
  --no-start              prépare tout sans démarrer
  --allow-runc            essai sans gVisor (jamais en production)
USAGE
}

domain="" admins="" expose="caddy" app_id="" systemd=0 start=1 allow_runc=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) domain="${2:-}"; shift 2 ;;
    --admins) admins="${2:-}"; shift 2 ;;
    --expose) expose="${2:-}"; shift 2 ;;
    --github-app-id) app_id="${2:-}"; shift 2 ;;
    --systemd) systemd=1; shift ;;
    --no-start) start=0; shift ;;
    --allow-runc) allow_runc=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$1"; }
fail() { echo "erreur : $1" >&2; exit 1; }

# Les valeurs vont dans .env par sed : seulement des caractères sans effet sur le motif.
echo "$domain" | grep -Eq '^([a-z0-9-]+\.)*[a-z0-9-]*$' || fail "--domain : nom de domaine invalide"
echo "$admins" | grep -Eq '^[A-Za-z0-9,-]*$' || fail "--admins : logins GitHub séparés par des virgules"
echo "$app_id" | grep -Eq '^[0-9]*$' || fail "--github-app-id : un nombre"
case "$expose" in caddy | tunnel) ;; *) fail "--expose : caddy ou tunnel" ;; esac

step "Vérification de l'hôte"
command -v docker >/dev/null || fail "Docker est requis : https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "le plugin docker compose est requis"
command -v openssl >/dev/null || fail "openssl est requis"
server="$(docker version --format '{{.Server.Version}}' 2>/dev/null)" || fail "le démon Docker ne répond pas"
[ "${server%%.*}" -ge 28 ] 2>/dev/null || fail "Docker 28 ou plus récent est requis (installé : $server)"
runtime=runsc
if ! docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}' | grep -qw runsc; then
  [ "$allow_runc" = 1 ] || fail "gVisor (runsc) n'est pas déclaré dans Docker : voir deploy/README.md §1 (ou --allow-runc pour un essai)"
  runtime=runc
  echo "attention : sans gVisor, les agents tournent dans des conteneurs ordinaires (essai seulement)"
fi
runs="${JULES_RUNS_DIR:-/var/lib/jules/runs}"
if [ ! -d "$runs" ]; then
  [ "$(id -u)" = 0 ] || fail "crée le dossier des exécutions : sudo install -d -o 1000 -g 1000 -m 700 $runs"
  install -d -o 1000 -g 1000 -m 700 "$runs"
fi
echo "Docker $server, runtime des sandboxes : $runtime"

step "Secrets locaux (deploy/secrets, mode 600)"
umask 077
mkdir -p secrets
new() { # nom, commande qui produit la valeur
  if [ -s "secrets/$1" ]; then
    echo "secrets/$1 existe déjà, conservé"
  else
    sh -c "$2" >"secrets/$1"
    echo "secrets/$1 créé"
  fi
}
new postgres_password "openssl rand -hex 32"
new github_webhook_secret "openssl rand -hex 32"
new restic_password "openssl rand -base64 48"
new jules_master_key "openssl rand -base64 32"
# Donné par GitHub (README §3) : le fichier est créé vide, à remplir avec le client secret de l'App.
[ -e secrets/github_oauth_client_secret ] || : >secrets/github_oauth_client_secret
printf 'postgres://jules:%s@postgres:5432/jules' "$(cat secrets/postgres_password)" >secrets/database_url

step "Réglages (deploy/.env, mode 600 : il peut contenir le jeton du tunnel)"
[ -f .env ] || cp .env.example .env
[ -f backup.env ] || cp backup.env.example backup.env
fill() { # nom, valeur : une ligne encore vide seulement, jamais un réglage existant
  if [ -n "$2" ] && grep -q "^$1=$" .env; then
    sed -i "s|^$1=$|$1=$2|" .env
    echo "$1 renseigné"
  fi
}
fill JULES_DOMAIN "$domain"
fill JULES_ADMIN_LOGINS "$admins"
fill GITHUB_APP_ID "$app_id"
fill DOCKER_GID "$(getent group docker 2>/dev/null | cut -d: -f3)"
sed -i "s|^JULES_SANDBOX_RUNTIME=.*|JULES_SANDBOX_RUNTIME=$runtime|" .env

step "Images"
docker compose build
docker compose --profile images build

if [ "$start" = 1 ]; then
  step "Démarrage"
  # Sans GitHub App, le worker ne peut pas démarrer : il attend l'identifiant et la clé (README §3, §4).
  if grep -Eq '^GITHUB_APP_ID=[0-9]+$' .env; then
    docker compose --profile "$expose" up -d --wait
  else
    docker compose --profile "$expose" up -d --wait postgres migrate gateway api "$([ "$expose" = caddy ] && echo caddy || echo cloudflared)"
  fi
fi

if [ "$systemd" = 1 ]; then
  step "Timers de sauvegarde (systemd)"
  [ "$(id -u)" = 0 ] || fail "--systemd demande root"
  [ "$(pwd)" = /opt/jules/deploy ] || fail "les unités supposent /opt/jules : installe le repo à cet endroit"
  cp systemd/jules-backup.service systemd/jules-backup.timer systemd/jules-wal.service systemd/jules-wal.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now jules-backup.timer jules-wal.timer
fi

cat <<MSG

Jules est installé.

Avant d'aller plus loin, range une copie HORS de cette machine (gestionnaire de mots de passe
ou papier) de :
  - deploy/secrets/jules_master_key  : sans elle, les secrets d'une sauvegarde sont perdus ;
  - deploy/secrets/restic_password   : sans lui, les sauvegardes sont illisibles.

Empreinte de la clé maître (à noter avec la copie ; \`jules master-key fingerprint\` la redonne) :
  $( (printf 'jules:kek:'; base64 -d <secrets/jules_master_key) | sha256sum | cut -c1-16)

Suite : la GitHub App (deploy/README.md §3 et §4), le dépôt des sauvegardes (deploy/backup.env),
puis \`deploy/install.sh --github-app-id <n>\` pour démarrer le worker.
MSG
