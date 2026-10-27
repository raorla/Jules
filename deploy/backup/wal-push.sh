#!/bin/sh
# Envoie l'archive des WAL hors de l'hôte (M11), toutes les 5 minutes (deploy/systemd/jules-wal.timer).
# Perte maximale en cas de sinistre : environ 10 minutes (archive_timeout + cette période).
set -eu
archive=/var/lib/postgresql/wal-archive

restic cat config >/dev/null 2>&1 || restic init
mkdir -p "$archive"
restic backup "$archive" --tag wal --quiet
# Chaque envoi contient les 8 derniers jours de WAL : avec une sauvegarde de base par jour, le plus
# récent suffit pour revenir à n'importe quel instant de la semaine.
find "$archive" -type f -mtime +8 -delete
restic forget --tag wal --keep-within 2d --keep-hourly 48 --keep-daily 35 --prune --quiet

echo "WAL envoyés"
