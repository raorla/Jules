FROM postgres:18-alpine
RUN apk add --no-cache restic jq
COPY backup.sh restore.sh base-backup.sh wal-push.sh restore-pitr.sh /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/backup.sh"]
