#!/bin/sh
# Sauvegarde de base pour la restauration à un instant donné (M11) : une copie physique de la base,
# chiffrée par restic et envoyée hors de l'hôte. Les WAL archivés depuis (wal-push.sh) la complètent.
set -eu

printf '%s:5432:*:%s:%s\n' "$PGHOST" "$PGUSER" "$(cat /run/secrets/postgres_password)" > "$PGPASSFILE"
chmod 600 "$PGPASSFILE"

restic cat config >/dev/null 2>&1 || restic init

# Format tar sur la sortie standard, avec les WAL de la copie : la sauvegarde se suffit à elle-même.
pg_basebackup --format=tar --wal-method=fetch --checkpoint=fast --pgdata=- \
  | restic backup --stdin --stdin-filename base.tar --tag base
restic forget --tag base --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

echo "sauvegarde de base terminée"
