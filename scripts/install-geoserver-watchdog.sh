#!/usr/bin/env bash
#
# Installs (or updates) the GeoServer watchdog as a systemd *user* timer:
#   municipal-gis-geoserver-watchdog.timer → runs scripts/geoserver-watchdog.sh
#   every minute; GeoServer is restarted after ~3 minutes of not answering.
#
#   scripts/install-geoserver-watchdog.sh                                  install / update
#   journalctl --user -u municipal-gis-geoserver-watchdog.service          what it did
#   systemctl --user disable --now municipal-gis-geoserver-watchdog.timer  turn it off
set -euo pipefail
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/municipal-gis-geoserver-watchdog.service" <<UNIT
[Unit]
Description=Municipal GIS Platform — restart GeoServer if it hangs

[Service]
Type=oneshot
ExecStart=/bin/bash $PROJECT/scripts/geoserver-watchdog.sh
UNIT

cat > "$UNIT_DIR/municipal-gis-geoserver-watchdog.timer" <<UNIT
[Unit]
Description=Check GeoServer every minute

[Timer]
OnBootSec=3min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now municipal-gis-geoserver-watchdog.timer
systemctl --user list-timers municipal-gis-geoserver-watchdog.timer --no-pager
