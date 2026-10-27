#!/bin/sh
# Restaure la base à un instant donné (M11), dans un volume vide monté sur /var/lib/postgresql :
#   restore-pitr.sh '2026-10-27 14:30:00'      (heure UTC)
# Prend la dernière sauvegarde de base antérieure à cet instant, les WAL envoyés après, puis prépare
# la récupération : PostgreSQL, démarré sur ce volume, rejoue les WAL jusqu'à l'instant et s'arrête là.
set -eu
target="${1:?usage : restore-pitr.sh '<AAAA-MM-JJ HH:MM:SS>' (UTC)}"
echo "$target" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$' \
  || { echo "instant attendu au format AAAA-MM-JJ HH:MM:SS, en UTC" >&2; exit 2; }
data="${PGDATA:-/var/lib/postgresql/18/docker}"
wal=/var/lib/postgresql/wal-restore

if [ -e "$data/PG_VERSION" ]; then
  echo "$data contient déjà une base : restauration refusée" >&2
  exit 1
fi
# Secondes UTC d'un instant restic (2026-10-27T14:30:12.5+00:00) ou de la cible.
epoch() { date -u -d "$(echo "$1" | sed -E 's/T/ /; s/\.[0-9]+//; s/(Z|[+-][0-9]{2}:?[0-9]{2})$//')" +%s; }
want=$(epoch "$target")

# Instants des instantanés restic, comparés en secondes UTC.
snapshots() { restic snapshots --tag "$1" --json | jq -r '.[] | "\(.time) \(.id)"'; }
base=""
for line in $(snapshots base | tr ' ' '|'); do
  at=$(epoch "$(echo "$line" | cut -d'|' -f1)")
  [ "$at" -le "$want" ] && base=$(echo "$line" | cut -d'|' -f2)
done
[ -n "$base" ] || { echo "aucune sauvegarde de base antérieure à $target" >&2; exit 1; }
walsnap=""
for line in $(snapshots wal | tr ' ' '|'); do
  at=$(epoch "$(echo "$line" | cut -d'|' -f1)")
  walsnap=$(echo "$line" | cut -d'|' -f2)
  [ "$at" -ge "$want" ] && break
done
[ -n "$walsnap" ] || { echo "aucun envoi de WAL" >&2; exit 1; }

mkdir -p "$data" "$wal"
restic dump "$base" base.tar | tar -x -C "$data"
restic restore "$walsnap" --target /tmp/wal --include /var/lib/postgresql/wal-archive --quiet
cp /tmp/wal/var/lib/postgresql/wal-archive/* "$wal"/ 2>/dev/null || true

cat >> "$data/postgresql.auto.conf" <<CONF
restore_command = 'cp $wal/%f %p'
recovery_target_time = '$target+00'
recovery_target_action = 'promote'
CONF
touch "$data/recovery.signal"
chown -R postgres:postgres "$data" "$wal"
chmod 700 "$data"
echo "base $base et WAL $walsnap prêts : démarre PostgreSQL sur ce volume pour revenir à $target"
