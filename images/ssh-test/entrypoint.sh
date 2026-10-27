set -eu
ssh-keygen -A >/dev/null
mkdir -p /home/jules/.ssh
printf '%s\n' "$AUTHORIZED_KEY" > /home/jules/.ssh/authorized_keys
chown -R jules:jules /home/jules/.ssh
chmod 700 /home/jules/.ssh
chmod 600 /home/jules/.ssh/authorized_keys
exec /usr/sbin/sshd -D -e
