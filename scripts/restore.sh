#!/usr/bin/env bash
#
# restore.sh — restore the Municipal GIS Platform from a backup taken by
# scripts/backup.sh (backups/auto/<stamp>/). Usually started from
# Admin → Backups (via scripts/backup-runner.sh), but can be run by hand:
#
#   scripts/restore.sh <stamp> [--parts db,geoserver,storage,keycloak] [--dry-run]
#
#   db         PostgreSQL database (all accounts, layers, layer tables)
#   geoserver  GeoServer data directory (workspaces, layers, styles)
#   storage    uploaded files / rasters (backend-storage volume)
#   keycloak   logins and passwords (Keycloak H2 database)
#
# Safety: the backup's checksums are verified first, then a fresh backup of
# the CURRENT state is taken (never pruned), so a restore can be undone by
# restoring that safety backup. Only the containers a part needs are
# stopped, and every stopped container is started again even on failure.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

STAMP="${1:-}"
PARTS="db,geoserver,storage,keycloak"
DRY=0
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --parts) PARTS="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "Unknown option $1" >&2; exit 2 ;;
  esac
done

SRC="backups/auto/$STAMP"
LOG="logs/restore.log"
PG=municipal-gis-postgres
GS=municipal-gis-geoserver
BE=municipal-gis-backend
KC=municipal-gis-keycloak
mkdir -p logs
exec > >(tee -a "$LOG") 2>&1
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
run() { if [ "$DRY" = 1 ]; then log "DRY-RUN: $*"; else eval "$@"; fi; }
has() { case ",$PARTS," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }
record_audit() { # action, details-json — best-effort
  [ "$DRY" = 1 ] && return 0
  docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA' >/dev/null 2>&1 <<SQL || true
INSERT INTO audit_logs (id, action, actor_email, details)
VALUES (md5(random()::text || clock_timestamp()::text), '$1', 'restore', '$2'::jsonb);
SQL
}
volume_of() { # container, mount destination → volume name
  docker inspect "$1" --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Name}}{{end}}{{end}}"
}

[[ "$STAMP" =~ ^[0-9]{8}-[0-9]{6}$ ]] || { echo "Usage: $0 <YYYYMMDD-HHMMSS> [--parts ...] [--dry-run]" >&2; exit 2; }
[ -d "$SRC" ] || { log "No backup $SRC"; exit 1; }
for p in ${PARTS//,/ }; do
  case "$p" in db|geoserver|storage|keycloak) ;; *) log "Unknown part '$p'"; exit 2 ;; esac
done

STOPPED=()
start_again() {
  if [ ${#STOPPED[@]} -gt 0 ]; then
    log "Starting ${STOPPED[*]} again"
    run "docker start ${STOPPED[*]} >/dev/null"
  fi
}
stop() {
  for c in "$@"; do
    if docker ps --format '{{.Names}}' | grep -qx "$c"; then
      log "Stopping $c"
      run "docker stop -t 30 $c >/dev/null"
      STOPPED+=("$c")
    fi
  done
}
fail() {
  log "RESTORE FAILED (line $1)"
  start_again
  record_audit restore.failed "{\"stamp\": \"$STAMP\", \"parts\": \"$PARTS\", \"line\": $1}"
  exit 1
}
trap 'fail $LINENO' ERR

log "Restore of $STAMP starting (parts: $PARTS)$([ "$DRY" = 1 ] && echo ' — DRY RUN, nothing is changed')"

# 1. The backup must be intact.
log "Verifying checksums"
( cd "$SRC" && sha256sum -c --quiet SHA256SUMS )
has keycloak && [ ! -d "$SRC/keycloak-h2" ] && { log "The backup has no keycloak-h2 folder"; exit 1; }

# 2. Safety backup of the current state.
log "Taking a safety backup of the current state first"
run "bash scripts/backup.sh"

# 3. Stop what the chosen parts need stopped.
WANT=()
{ has db || has storage; } && WANT+=("$BE")
{ has db || has geoserver; } && WANT+=("$GS")
has keycloak && WANT+=("$KC")
stop "${WANT[@]}"

if has db; then
  log "Restoring the database"
  run "docker exec $PG sh -c 'psql -U \"\$POSTGRES_USER\" -d postgres -qc \"DROP DATABASE IF EXISTS \\\"\$POSTGRES_DB\\\" WITH (FORCE)\" -c \"CREATE DATABASE \\\"\$POSTGRES_DB\\\"\"'"
  run "docker exec -i $PG sh -c 'pg_restore -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" --no-owner --exit-on-error' < $SRC/db.dump"
fi

if has geoserver; then
  VOL="$(volume_of "$GS" /opt/geoserver/data_dir)"
  [ -n "$VOL" ] || { log "GeoServer data volume not found"; false; }
  log "Restoring the GeoServer data directory into volume $VOL"
  run "docker run --rm -v $VOL:/data -v $PWD/$SRC:/in:ro alpine:3.20 sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /in/geoserver-data.tar.gz -C /data'"
fi

if has storage; then
  VOL="$(volume_of "$BE" /app/storage)"
  [ -n "$VOL" ] || { log "Backend storage volume not found"; false; }
  log "Restoring uploaded files into volume $VOL"
  run "docker run --rm -v $VOL:/data -v $PWD/$SRC:/in:ro alpine:3.20 sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xf /in/storage.tar -C /data'"
fi

if has keycloak; then
  log "Restoring Keycloak logins"
  run "docker cp -q $SRC/keycloak-h2/. $KC:/opt/keycloak/data/h2/"
fi

trap - ERR
start_again
if has db; then
  # An older backup may predate newer migrations: bring the schema up to
  # date once the backend is running again.
  log "Applying database migrations"
  run "sleep 15; docker exec $BE npx prisma migrate deploy" || log "Migrations could not run — run ./run.sh --no-serve"
fi
log "Restore of $STAMP complete"
record_audit backup.restored "{\"stamp\": \"$STAMP\", \"parts\": \"$PARTS\"}"
