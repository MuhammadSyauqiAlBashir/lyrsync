#!/usr/bin/env bash
# Deploy lyrsync from this repo to the server. Safe to re-run.
#   backend  -> /opt/lyrsync (root-owned, run as user `lyrsync`)
#   web      -> /srv/lyrsync (static, served by Caddy)
#   pb files -> /var/lib/pocketbase/{pb_migrations,pb_hooks} (applied on PocketBase restart)
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(git rev-parse --short HEAD 2>/dev/null || echo dev)-$(date +%Y%m%d%H%M%S)"
echo "==> lyrsync $VERSION"

id lyrsync >/dev/null 2>&1 || sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin lyrsync

echo "==> backend"
sudo install -d -o root -g root -m 755 /opt/lyrsync
[ -x /opt/lyrsync/venv/bin/python ] || sudo python3 -m venv /opt/lyrsync/venv
sudo /opt/lyrsync/venv/bin/pip install --quiet --disable-pip-version-check -r backend/requirements.txt
sudo install -o root -g root -m 644 backend/app.py /opt/lyrsync/app.py
sudo install -o root -g root -m 644 deploy/lyrsync.service /etc/systemd/system/lyrsync.service

echo "==> web"
STAGE="$(mktemp -d)"
trap 'rm -rf -- "$STAGE"' EXIT
cp -r web/. "$STAGE/"
for f in index.html app.js sw.js; do sed -i "s/__VERSION__/$VERSION/g" "$STAGE/$f"; done
sudo install -d -o root -g root -m 755 /srv/lyrsync /srv/lyrsync/icons
sudo rsync -a --delete --chown=root:root --chmod=D755,F644 "$STAGE/" /srv/lyrsync/

echo "==> pocketbase migrations + hooks"
sudo install -o pocketbase -g pocketbase -m 640 pb_migrations/*.js /var/lib/pocketbase/pb_migrations/
sudo install -o pocketbase -g pocketbase -m 640 pb_hooks/*.js /var/lib/pocketbase/pb_hooks/

echo "==> restart"
sudo systemctl daemon-reload
sudo systemctl restart pocketbase
sudo systemctl enable --quiet lyrsync
sudo systemctl restart lyrsync
for i in $(seq 30); do curl -fsS http://127.0.0.1:8000/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8000/api/health && echo
echo "==> done: $VERSION"
