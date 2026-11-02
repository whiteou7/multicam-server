#!/usr/bin/env bash
# Nightly SQLite backup. Cron example (as a user that can run docker):
#   0 3 * * * /opt/multicam-server/deploy/backup-sqlite.sh >> /var/log/multicam-backup.log 2>&1
# Env: BACKUP_DIR (default /var/backups/multicam), KEEP (default 7).
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/multicam}"
KEEP="${KEEP:-7}"
cd "$(dirname "$0")/.."
mkdir -p "$BACKUP_DIR"

out="$BACKUP_DIR/multicam-$(date +%F-%H%M%S).sqlite3"
cid="$(docker compose ps -q backend)"
# better-sqlite3 .backup is consistent while the server is running.
docker compose exec -T backend node -e "
const db = require('better-sqlite3')(process.env.DATABASE_PATH);
db.backup('/tmp/backup.sqlite3').then(() => db.close()).catch(e => { console.error(e); process.exit(1); });"
docker cp "$cid:/tmp/backup.sqlite3" "$out"
docker compose exec -T backend rm -f /tmp/backup.sqlite3

ls -1t "$BACKUP_DIR"/multicam-*.sqlite3 | tail -n +$((KEEP + 1)) | xargs -r rm --
echo "backup ok: $out"
