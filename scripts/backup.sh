#!/usr/bin/env bash
#
# backup.sh — full backup of the Municipal GIS Platform, run nightly by the
# systemd user timer `municipal-gis-backup.timer` (see scripts/install-backup-timer.sh).
#
#   scripts/backup.sh            take a backup now
#   KEEP=10 scripts/backup.sh    keep the 10 newest backups (default 7)
#
# Writes backups/auto/<YYYYMMDD-HHMMSS>/ containing:
#   db.dump               PostgreSQL database (pg_dump -Fc): all accounts, layers, tables
#   geoserver-data.tar.gz GeoServer data directory (workspaces, layers, styles) — tile cache excluded
#   storage.tar           uploaded files and rasters (backend-storage volume)
#   keycloak-h2/          Keycloak's database files (all logins + password hashes)
#   keycloak-realm.json   realm settings (export) · keycloak-users.json (user list)
#   SHA256SUMS            checksums · manifest.txt  what/when/sizes
#
# Runs at low CPU/IO priority. Restore steps: backups/RESTORE.md.

set -Eeuo pipefail
cd "$(dirname "$0")/.."

KEEP="${KEEP:-7}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ROOT="backups/auto"
DEST="$ROOT/$STAMP"
PART="$DEST.partial"
LOG="logs/backup.log"
PG=municipal-gis-postgres
GS=municipal-gis-geoserver
BE=municipal-gis-backend
KC=municipal-gis-keycloak
LOW="nice -n 19 ionice -c3"

mkdir -p "$ROOT" logs
exec > >(tee -a "$LOG") 2>&1
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

record_audit() { # action, details-json — best-effort, never fails the backup
  docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA -v ON_ERROR_STOP=1' >/dev/null 2>&1 <<SQL || true
INSERT INTO audit_logs (id, action, actor_email, details)
VALUES (md5(random()::text || clock_timestamp()::text), '$1', 'backup', '$2'::jsonb);
SQL
}

fail() {
  log "BACKUP FAILED (line $1)"
  rm -rf "$PART"
  record_audit backup.failed "{\"stamp\": \"$STAMP\", \"line\": $1}"
  exit 1
}
trap 'fail $LINENO' ERR

log "Backup $STAMP starting (keep $KEEP)"
mkdir -p "$PART"

log "1/4 database"
docker exec "$PG" sh -c 'nice -n 19 pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z 6' > "$PART/db.dump"

log "2/4 GeoServer data directory (without tile cache)"
docker exec "$GS" sh -c 'nice -n 19 tar czf - --exclude=./gwc -C /opt/geoserver/data_dir .' > "$PART/geoserver-data.tar.gz"

log "3/4 uploaded files"
# Rasters/archives are already compressed — plain tar keeps it fast.
docker exec "$BE" sh -c 'nice -n 19 tar cf - -C /app/storage .' > "$PART/storage.tar"

log "4/4 Keycloak (logins)"
# Keycloak uses its built-in H2 file database inside the container. Its
# database is locked while running (no live `kc.sh export`), so copy the
# files (H2's MVStore survives a hot copy) and also save the realm and user
# list through the admin CLI as a second copy.
docker cp -q "$KC:/opt/keycloak/data/h2" "$PART/keycloak-h2"
KCADM="/opt/keycloak/bin/kcadm.sh"
docker exec "$KC" sh -c "$KCADM config credentials --server http://localhost:8080 --realm master --user \"\${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}\" --password \"\$KC_BOOTSTRAP_ADMIN_PASSWORD\" >/dev/null 2>&1 \
  && $KCADM create realms/municipal-gis/partial-export -s exportClients=true -s exportGroupsAndRoles=true -o" > "$PART/keycloak-realm.json"
docker exec "$KC" sh -c "$KCADM get users -r municipal-gis --limit 1000000 --fields id,username,email,firstName,lastName,enabled,emailVerified,createdTimestamp" > "$PART/keycloak-users.json"

( cd "$PART" && $LOW sha256sum db.dump geoserver-data.tar.gz storage.tar keycloak-realm.json keycloak-users.json > SHA256SUMS )
{
  echo "Municipal GIS Platform backup $STAMP"
  echo "git commit: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "accounts: $(docker exec "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtAc "select count(*) from municipalities"')"
  du -sh "$PART"/* | sed "s|$PART/||"
} > "$PART/manifest.txt"

mv "$PART" "$DEST"
SIZE="$(du -sh "$DEST" | cut -f1)"
log "Backup $STAMP complete: $DEST ($SIZE)"
record_audit backup.completed "{\"stamp\": \"$STAMP\", \"size\": \"$SIZE\"}"

# Retention: keep the newest $KEEP complete backups; drop failed partials.
rm -rf "$ROOT"/*.partial
mapfile -t OLD < <(ls -1d "$ROOT"/2* 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))")
for dir in "${OLD[@]}"; do
  log "Removing old backup $dir"
  rm -rf "$dir"
done
