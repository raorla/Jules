FROM postgres:18-alpine
RUN apk add --no-cache restic
COPY backup.sh restore.sh /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/backup.sh"]
