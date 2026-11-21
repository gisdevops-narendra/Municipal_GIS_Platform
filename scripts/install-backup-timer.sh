#!/usr/bin/env bash
#
# Installs (or updates) the nightly backup as a systemd *user* timer:
#   municipal-gis-backup.timer  → runs scripts/backup.sh every night at 02:30
#   (Persistent: a run missed while the machine was off happens at next boot.)
#
#   scripts/install-backup-timer.sh            install / update
#   systemctl --user list-timers municipal-gis-backup.timer   next run
#   journalctl --user -u municipal-gis-backup.service         last runs
#   systemctl --user disable --now municipal-gis-backup.timer stop nightly backups
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/municipal-gis-backup.service" <<UNIT
[Unit]
Description=Municipal GIS Platform nightly backup
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$PROJECT
Environment=KEEP=7
ExecStart=/bin/bash $PROJECT/scripts/backup.sh
Nice=19
IOSchedulingClass=idle
UNIT

cat > "$UNIT_DIR/municipal-gis-backup.timer" <<UNIT
[Unit]
Description=Nightly backup of the Municipal GIS Platform (02:30)

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now municipal-gis-backup.timer
systemctl --user list-timers municipal-gis-backup.timer --no-pager
