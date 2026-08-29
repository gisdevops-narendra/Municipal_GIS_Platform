#!/usr/bin/env bash
#
# apply-auth-settings.sh — push the realm-level auth settings that the
# forgot-password flow needs onto an ALREADY-RUNNING Keycloak.
#
# Keycloak only imports keycloak/import/municipal-gis-realm.json when the
# realm does not yet exist, so once the realm is created these settings must
# be applied over the Admin API instead. This script is idempotent — run.sh
# runs it on every startup, and running it by hand is harmless.
#
# Settings applied:
#   - resetPasswordAllowed = true   -> "Forgot password?" link on the
#                                      Keycloak login page + reset flow
#   - smtpServer                    -> points at the `mailpit` container so
#                                      Keycloak can actually send the email
#
# Usage:  bash keycloak/apply-auth-settings.sh

set -euo pipefail

# Git Bash / MSYS on Windows rewrites Unix-looking arguments (e.g.
# `/opt/keycloak/bin/kcadm.sh`, `realms/municipal-gis`) into Windows paths
# before they reach `docker exec`, which breaks every call below. Disable
# that conversion for this script. No effect on Linux/macOS.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

KC_CONTAINER="${KC_CONTAINER:-municipal-gis-keycloak}"
ADMIN_USER="${KEYCLOAK_ADMIN_USERNAME:-admin}"
ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-admin}"
REALM="${KEYCLOAK_REALM:-municipal-gis}"

kcadm() {
  docker exec "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@"
}

# Authenticate against the master realm (kcadm caches the session in the
# container's filesystem for subsequent calls).
kcadm config credentials \
  --server http://localhost:8080 \
  --realm master \
  --user "$ADMIN_USER" \
  --password "$ADMIN_PASS"

# NOTE: pass smtpServer as one JSON object, not dotted `smtpServer.host=...`
# keys — kcadm silently ignores the dotted form when the map starts empty.
kcadm update "realms/$REALM" \
  -s resetPasswordAllowed=true \
  -s 'smtpServer={"host":"mailpit","port":"1025","from":"no-reply@municipal-gis.local","fromDisplayName":"Municipal GIS Platform","ssl":"false","starttls":"false","auth":"false"}'

echo "   applied: resetPasswordAllowed=true + SMTP -> mailpit:1025"
