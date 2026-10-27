# Serveur SSH de test (packages/ssh, apps/worker) : un vrai OpenSSH, l'utilisateur `jules` sans mot de
# passe, et un sudo -n limité. Les clés d'hôte sont générées au démarrage : chaque conteneur a la sienne.
FROM alpine:3.22
RUN apk add --no-cache openssh-server sudo coreutils \
 && adduser -D -s /bin/sh jules \
 && echo 'jules:*' | chpasswd -e \
 && echo 'jules ALL=(root) NOPASSWD: /usr/bin/id' > /etc/sudoers.d/jules \
 && printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' >> /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
