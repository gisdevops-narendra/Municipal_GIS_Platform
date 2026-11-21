#!/usr/bin/env bash
#
# GeoServer watchdog — run every minute by municipal-gis-geoserver-watchdog.timer
# (install with scripts/install-geoserver-watchdog.sh).
#
# Docker marks GeoServer "unhealthy" when it hangs but never restarts it.
# This checks GeoServer itself; after FAILS_NEEDED failed checks in a row
# (one a minute) it restarts the container — no data is lost — and records
# it in the admin Activity log. It never touches any other container.
#
#   journalctl --user -u municipal-gis-geoserver-watchdog.service   what it did
set -uo pipefail

CONTAINER="${CONTAINER:-municipal-gis-geoserver}"
URL="${URL:-http://localhost:8600/geoserver/web/}"
TIMEOUT="${TIMEOUT:-20}"            # seconds GeoServer gets to answer
FAILS_NEEDED="${FAILS_NEEDED:-3}"   # failed checks in a row before a restart
STARTUP_GRACE="${STARTUP_GRACE:-300}"  # seconds after a (re)start to leave it alone
COOLDOWN="${COOLDOWN:-900}"         # seconds between two restarts
DRY_RUN="${DRY_RUN:-0}"             # 1 = only say what would happen
PG=municipal-gis-postgres
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/municipal-gis"
STATE="$STATE_DIR/geoserver-watchdog"
mkdir -p "$STATE_DIR"

log() { printf '%s\n' "$*"; }

record_audit() { # action, details-json — best-effort
  docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qtA -v ON_ERROR_STOP=1' >/dev/null 2>&1 <<SQL || true
INSERT INTO audit_logs (id, action, actor_email, details)
VALUES (md5(random()::text || clock_timestamp()::text), '$1', 'watchdog', '$2'::jsonb);
SQL
}

fails=0; last_restart=0
[ -f "$STATE" ] && . "$STATE"
save() { printf 'fails=%s\nlast_restart=%s\n' "$fails" "$last_restart" > "$STATE"; }
now=$(date +%s)

running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo missing)
if [ "$running" = "missing" ]; then
  log "$CONTAINER does not exist — nothing to do."; exit 0
fi
if [ "$running" != "true" ]; then
  # Stopped on purpose (docker stop / compose down) — leave it stopped.
  log "$CONTAINER is stopped — leaving it alone."; fails=0; save; exit 0
fi

started=$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$CONTAINER")" +%s 2>/dev/null || echo "$now")
if [ $((now - started)) -lt "$STARTUP_GRACE" ]; then
  log "$CONTAINER started $((now - started))s ago — still starting up."; fails=0; save; exit 0
fi

code=$(curl -s -o /dev/null -m "$TIMEOUT" -w '%{http_code}' "$URL" || true)
if [ "$code" != "000" ] && [ "$code" -lt 500 ] 2>/dev/null; then
  [ "$fails" -gt 0 ] && log "GeoServer answered again (HTTP $code) after $fails failed check(s)."
  fails=0; save; exit 0
fi

fails=$((fails + 1))
log "GeoServer not answering (HTTP $code) — failed check $fails of $FAILS_NEEDED."
if [ "$fails" -lt "$FAILS_NEEDED" ]; then save; exit 0; fi

if [ $((now - last_restart)) -lt "$COOLDOWN" ]; then
  log "Restarted $((now - last_restart))s ago — waiting before trying again."
  save; exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  log "DRY RUN — would restart $CONTAINER now."; fails=0; save; exit 0
fi
log "Restarting $CONTAINER."
if docker restart -t 30 "$CONTAINER" >/dev/null; then
  last_restart=$now; fails=0; save
  record_audit system.geoserver_restarted "{\"reason\": \"Not answering for $FAILS_NEEDED minutes (HTTP $code) — restarted automatically\"}"
  log "Restarted."
else
  save
  record_audit system.geoserver_restart_failed "{\"error\": \"docker restart failed\"}"
  log "Restart FAILED."
  exit 1
fi
