#!/bin/sh
# Restaure la dernière sauvegarde dans la base indiquée, qui doit être neuve.
#   restore.sh <base>
set -eu
target="${1:?usage : restore.sh <base>}"

printf '%s:5432:*:%s:%s\n' "$PGHOST" "$PGUSER" "$(cat /run/secrets/postgres_password)" > "$PGPASSFILE"
chmod 600 "$PGPASSFILE"

createdb "$target"
restic dump --tag jules latest jules.dump | pg_restore --no-owner --dbname="$target"
echo "sauvegarde restaurée dans $target"
