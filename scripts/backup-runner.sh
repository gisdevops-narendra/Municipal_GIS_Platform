#!/usr/bin/env bash
#
# backup-runner.sh — runs backup / restore requests made in Admin → Backups.
# The backend (which cannot run Docker itself) writes
#   backups/requests/<id>.json   {"action":"backup"} or
#                                {"action":"restore","stamp":"…","parts":"db,…","dryRun":false}
# and this script — started by the systemd path unit
# municipal-gis-backup-runner.path whenever that folder changes — runs each
# pending request once and reports back in <id>.status.json.
set -uo pipefail
cd "$(dirname "$0")/.."
REQ="backups/requests"
mkdir -p "$REQ" logs
exec 9>"$REQ/.lock"
flock -n 9 || exit 0   # another run is already working through the queue

status() { # id, state, message
  local tmp="$REQ/$1.status.json.tmp"
  printf '{"state":"%s","message":%s,"updatedAt":"%s"}\n' "$2" "$(printf '%s' "$3" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()[-4000:]))')" "$(date -Iseconds)" > "$tmp"
  mv "$tmp" "$REQ/$1.status.json"
}

for req in "$REQ"/*.json; do
  [ -e "$req" ] || continue
  case "$req" in *.status.json) continue ;; esac
  id="$(basename "$req" .json)"
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || continue
  [ -e "$REQ/$id.status.json" ] && continue   # already handled
  action="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("action",""))' "$req" 2>/dev/null)"
  status "$id" running "Started $(date '+%F %T')"
  out="$(mktemp)"
  if [ "$action" = backup ]; then
    bash scripts/backup.sh >"$out" 2>&1 && ok=1 || ok=0
  elif [ "$action" = restore ]; then
    read -r stamp parts dry < <(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("stamp",""),d.get("parts","db,geoserver,storage,keycloak"),"1" if d.get("dryRun") else "0")' "$req")
    args=("$stamp" --parts "$parts")
    [ "$dry" = 1 ] && args+=(--dry-run)
    bash scripts/restore.sh "${args[@]}" >"$out" 2>&1 && ok=1 || ok=0
  else
    echo "Unknown action '$action'" >"$out"; ok=0
  fi
  status "$id" "$([ $ok = 1 ] && echo done || echo failed)" "$(tail -n 40 "$out")"
  rm -f "$out"
done
# Keep the queue small: drop handled requests older than 30 days.
find "$REQ" -name '*.json' -mtime +30 -delete 2>/dev/null || true
