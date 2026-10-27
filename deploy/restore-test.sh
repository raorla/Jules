#!/bin/sh
# Test de restauration (ROADMAP M0, à refaire avant le pilote puis chaque mois) :
# restaure la dernière sauvegarde dans une base jetable, puis vérifie qu'elle est utilisable,
# secrets compris. Ne touche pas à la base de production.
set -eu
cd "$(dirname "$0")"

check_db="jules_restore_check_$(date +%Y%m%d%H%M%S)"
password="$(cat secrets/postgres_password)"
url="postgres://jules:${password}@postgres:5432/${check_db}"

docker compose --profile ops run --rm --entrypoint restore.sh backup "$check_db"
cleanup() { docker compose exec -T postgres dropdb -U jules "$check_db"; }
trap cleanup EXIT

# L'URL passe par l'environnement, pas par la ligne de commande (visible dans `ps`).
export DATABASE_URL="$url"
for check in migrate "audit verify" "secrets verify"; do
  # shellcheck disable=SC2086
  docker compose run --rm -e DATABASE_URL worker node dist/cli.js $check
done
echo "restauration vérifiée"
