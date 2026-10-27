#!/bin/sh
# Prépare un serveur Jules : génère les secrets locaux dans deploy/secrets/ (jamais versionnés).
# À lancer une seule fois. Voir deploy/README.md pour la suite.
set -eu
cd "$(dirname "$0")"

umask 077
mkdir -p secrets

new() { # nom, commande qui produit la valeur
  if [ -s "secrets/$1" ]; then
    echo "secrets/$1 existe déjà, conservé"
  else
    sh -c "$2" > "secrets/$1"
    echo "secrets/$1 créé"
  fi
}

new postgres_password "openssl rand -hex 32"
new github_webhook_secret "openssl rand -hex 32"
new restic_password "openssl rand -base64 48"
new jules_master_key "openssl rand -base64 32"
printf 'postgres://jules:%s@postgres:5432/jules' "$(cat secrets/postgres_password)" > secrets/database_url

[ -f .env ] || cp .env.example .env
[ -f backup.env ] || cp backup.env.example backup.env

cat <<MSG

Secrets prêts. Avant d'aller plus loin, range une copie HORS de cette machine
(gestionnaire de mots de passe ou papier) de :
  - deploy/secrets/jules_master_key  : sans elle, les secrets d'une sauvegarde sont perdus ;
  - deploy/secrets/restic_password   : sans lui, les sauvegardes sont illisibles.

Empreinte de la clé maître (à noter avec la copie ; \`jules master-key fingerprint\` la redonne) :
  $( (printf 'jules:kek:'; base64 -d < secrets/jules_master_key) | sha256sum | cut -c1-16)

Suite : deploy/README.md, étapes 3 à 6.
MSG
