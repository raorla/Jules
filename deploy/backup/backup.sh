#!/bin/sh
# Sauvegarde quotidienne de PostgreSQL, chiffrée par restic et envoyée hors de l'hôte
# (ARCHITECTURE.md §17) : une copie logique (pg_dump, portable d'une version à l'autre) et une copie
# physique (base-backup.sh, pour la restauration à un instant donné). La clé maître de Jules n'est
# jamais dans la sauvegarde.
set -eu

printf '%s:5432:*:%s:%s\n' "$PGHOST" "$PGUSER" "$(cat /run/secrets/postgres_password)" > "$PGPASSFILE"
chmod 600 "$PGPASSFILE"

restic cat config >/dev/null 2>&1 || restic init

pg_dump --format=custom --no-owner | restic backup --stdin --stdin-filename jules.dump --tag jules
restic forget --tag jules --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
# Relit un trentième des données à chaque passage : le dépôt entier est vérifié en un mois.
restic check --read-data-subset=1/30

# Copie physique pour la restauration à un instant donné (M11), avec les WAL envoyés par wal-push.sh.
base-backup.sh

echo "sauvegarde terminée"
