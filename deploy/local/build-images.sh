#!/bin/sh
# Images du mode local (M10), construites depuis le repo tant qu'elles ne sont pas publiées.
# L'app desktop lance la pile avec les images de sa propre version : jules-api:<version>, etc.
# Usage : deploy/local/build-images.sh [version]   (par défaut, celle de apps/desktop/package.json)
set -eu
cd "$(dirname "$0")/../.."

version="${1:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' apps/desktop/package.json)}"
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "erreur : version x.y.z attendue (reçu : $version)" >&2; exit 1; }

# Les variables que l'app fournit au lancement ne servent pas à construire : valeurs neutres.
JULES_VERSION="$version" \
  JULES_HANDOFF_DIR=/build JULES_LOCAL_ROOT=/build JULES_LOCAL_RUNS_DIR=/build \
  JULES_LOCAL_LOGIN_HASH=build JULES_LOCAL_STEPUP_PUBLIC_KEY=build \
  JULES_SECRETS_HANDOFF_TOKEN=build JULES_SECRETS_HANDOFF_URL=unix:/build \
  docker compose -f deploy/local/compose.yaml --profile images build
echo "Images Jules $version construites : relance le mode local depuis l'app."
