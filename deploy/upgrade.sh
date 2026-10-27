#!/bin/sh
# Montée de version d'un serveur Jules (M11), dans cet ordre :
#   1. sauvegarde complète : sans elle, rien ne change ;
#   2. le code de la version visée (tag git), puis ses images ;
#   3. arrêt du worker, de l'api et du gateway, puis les migrations, dans une transaction ;
#   4. redémarrage, puis vérification du journal d'audit et des secrets.
# Un échec arrête tout ; la sauvegarde de l'étape 1 permet le retour arrière (deploy/README.md §10).
# Les webhooks reçus pendant l'arrêt sont redemandés par la réconciliation.
#   deploy/upgrade.sh [<tag>]      (sans tag : le code déjà présent)
set -eu
cd "$(dirname "$0")"

step() { printf '\n==> %s\n' "$1"; }
fail() { echo "erreur : $1" >&2; exit 1; }
ref="${1:-}"
[ -z "$ref" ] || echo "$ref" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' || fail "tag attendu, par exemple v1.0.1"

step "Sauvegarde avant la montée de version"
docker compose --profile ops run --rm backup || fail "sauvegarde impossible : montée de version annulée, rien n'a changé"

if [ -n "$ref" ]; then
  step "Code de $ref"
  git -C .. fetch --tags --quiet
  git -C .. -c advice.detachedHead=false checkout --quiet "refs/tags/$ref"
fi

step "Images"
docker compose build
docker compose --profile images build

step "Migrations"
docker compose stop worker api gateway
docker compose run --rm migrate || fail "migration en échec : annulée par sa transaction ; relance l'ancienne version ou restaure la sauvegarde"

step "Redémarrage"
docker compose up -d --wait

step "Vérifications"
docker compose run --rm worker node dist/cli.js audit verify
docker compose run --rm worker node dist/cli.js secrets verify

echo "Montée de version terminée${ref:+ ($ref)}."
