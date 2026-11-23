#!/usr/bin/env bash
# Installs the systemd user units that run backup / restore requests made in
# Admin → Backups (scripts/backup-runner.sh). Run once on the host.
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR" "$PROJECT/backups/requests"
chmod 777 "$PROJECT/backups/requests"   # the backend container writes requests here

cat > "$UNIT_DIR/municipal-gis-backup-runner.service" <<UNIT
[Unit]
Description=Municipal GIS Platform — run backup / restore requests from Admin

[Service]
Type=oneshot
WorkingDirectory=$PROJECT
ExecStart=/bin/bash $PROJECT/scripts/backup-runner.sh
Nice=10
UNIT

cat > "$UNIT_DIR/municipal-gis-backup-runner.path" <<UNIT
[Unit]
Description=Watch for backup / restore requests from Admin

[Path]
PathChanged=$PROJECT/backups/requests
Unit=municipal-gis-backup-runner.service

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now municipal-gis-backup-runner.path
systemctl --user status municipal-gis-backup-runner.path --no-pager | head -4
