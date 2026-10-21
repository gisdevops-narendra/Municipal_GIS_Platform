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
#   - frontend client redirect URIs / web origins / post-logout URIs
#                                   -> every app origin in CORS_ORIGIN (.env),
#                                      e.g. localhost AND a LAN IP for a demo
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

# App origins the browser opens the app from (localhost, and a LAN IP for a
# demo) — the same list the backend allows in CORS_ORIGIN. Keycloak must
# redirect back to each of them after sign-in / sign-out.
ENV_FILE="$(dirname "$0")/../.env"
CORS_ORIGIN_VALUE="${CORS_ORIGIN:-}"
if [ -z "$CORS_ORIGIN_VALUE" ] && [ -f "$ENV_FILE" ]; then
  CORS_ORIGIN_VALUE="$(sed -n 's/^CORS_ORIGIN=//p' "$ENV_FILE" | head -n1 | tr -d '\r')"
fi
CORS_ORIGIN_VALUE="${CORS_ORIGIN_VALUE:-http://localhost:4200}"
FRONTEND_CLIENT="${KEYCLOAK_FRONTEND_CLIENT_ID:-municipal-gis-frontend}"

redirects=""; origins=""; logout=""
IFS=',' read -ra APP_ORIGINS <<< "$CORS_ORIGIN_VALUE"
for origin in "${APP_ORIGINS[@]}"; do
  origin="$(echo "$origin" | tr -d '[:space:]')"
  origin="${origin%/}"
  [ -z "$origin" ] && continue
  redirects="$redirects${redirects:+,}\"$origin/*\""
  origins="$origins${origins:+,}\"$origin\""
  logout="$logout${logout:+##}$origin/*"
done

CLIENT_UUID="$(kcadm get clients -r "$REALM" -q clientId="$FRONTEND_CLIENT" --fields id --format csv --noquotes | tr -d '\r' | head -n1)"
if [ -n "$CLIENT_UUID" ]; then
  kcadm update "clients/$CLIENT_UUID" -r "$REALM" \
    -s "redirectUris=[$redirects]" \
    -s "webOrigins=[$origins]" \
    -s "attributes.\"post.logout.redirect.uris\"=$logout"
  echo "   applied: $FRONTEND_CLIENT redirects -> $CORS_ORIGIN_VALUE"
else
  echo "   skipped: client $FRONTEND_CLIENT not found in realm $REALM" >&2
fi
