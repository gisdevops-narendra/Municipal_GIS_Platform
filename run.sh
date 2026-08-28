#!/usr/bin/env bash
#
# run.sh — start the whole Municipal GIS Platform locally.
#
#   ./run.sh              start everything (Docker stack + run migrations + ng serve)
#   ./run.sh --no-serve   start the Docker stack + migrations, but don't run `ng serve`
#   ./run.sh stop         stop the Docker stack (frontend is Ctrl+C)
#   ./run.sh down         stop AND remove the Docker stack (keeps named volumes / data)
#   ./run.sh logs         tail logs from every container
#
# The Docker stack = postgres(+PostGIS/pgvector), keycloak, geoserver,
# mapfish-print, ollama, gis-ai (Python RAG) and backend (NestJS).
# The Angular frontend runs on the host via `ng serve` (http://localhost:4200).

set -euo pipefail

cd "$(dirname "$0")"

# Prefer `docker compose` (v2), fall back to `docker-compose` (v1).
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "ERROR: Docker Compose not found. Install Docker Desktop and retry." >&2
  exit 1
fi

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m!!\033[0m  %s\n' "$*"; }

case "${1:-up}" in
  stop)
    log "Stopping the Docker stack"
    "${DC[@]}" stop
    exit 0
    ;;
  down)
    log "Stopping and removing the Docker stack (data volumes kept)"
    "${DC[@]}" down
    exit 0
    ;;
  logs)
    exec "${DC[@]}" logs -f --tail=100
    ;;
  up|--no-serve)
    : # fall through
    ;;
  *)
    echo "Unknown argument: $1" >&2
    sed -n '3,15p' "$0" >&2
    exit 1
    ;;
esac

# 1. Make sure Docker is actually running.
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not reachable. Start Docker Desktop and retry." >&2
  exit 1
fi

# 2. First-run: create .env from the template (all values have sane dev defaults).
if [ ! -f .env ]; then
  log "Creating .env from .env.example"
  cp .env.example .env
fi

# Read the LLM model name so we can pre-pull it (keep in sync with .env).
GIS_AI_LLM_MODEL="$(sed -n 's/^GIS_AI_LLM_MODEL=//p' .env | head -n1)"
GIS_AI_LLM_MODEL="${GIS_AI_LLM_MODEL:-qwen2.5:1.5b-instruct}"

# 3. Build + start every container.
log "Building and starting the Docker stack (this can take a while the first time)"
"${DC[@]}" up -d --build

# 4. Wait for Postgres to pass its healthcheck before touching the DB.
log "Waiting for PostgreSQL to be healthy"
for i in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' municipal-gis-postgres 2>/dev/null || echo starting)"
  if [ "$status" = "healthy" ]; then
    echo "   postgres is healthy"
    break
  fi
  if [ "$i" = "60" ]; then
    echo "ERROR: PostgreSQL did not become healthy in time. Check: ${DC[*]} logs postgres" >&2
    exit 1
  fi
  sleep 2
done

# 5. Apply Prisma migrations against the containerised backend/DB.
log "Applying database migrations (prisma migrate deploy)"
for i in $(seq 1 10); do
  if "${DC[@]}" exec -T backend npx prisma migrate deploy; then
    break
  fi
  if [ "$i" = "10" ]; then
    echo "ERROR: prisma migrate deploy failed. Check: ${DC[*]} logs backend" >&2
    exit 1
  fi
  echo "   backend not ready yet, retrying in 5s ($i/10)"
  sleep 5
done

# 6. Pre-pull the local LLM so the AI chatbot works without the first-request wait.
#    Non-fatal: the gis-ai service also auto-pulls on demand.
log "Pulling the local LLM model '$GIS_AI_LLM_MODEL' in the background"
if "${DC[@]}" exec -dT ollama ollama pull "$GIS_AI_LLM_MODEL"; then
  echo "   pull started — track it with: ${DC[*]} exec ollama ollama list"
else
  warn "Could not start the model pull; the AI service will pull it on first use."
fi

log "Docker stack is up:"
"${DC[@]}" ps
cat <<'EOF'

  Backend API   http://localhost:3000/api
  Keycloak      http://localhost:8180  (admin / admin)
  GeoServer     http://localhost:8600/geoserver  (admin / geoserver_dev_admin)
  AI service    http://localhost:8100/health
  Frontend      http://localhost:4200  (started below)
EOF

if [ "${1:-up}" = "--no-serve" ]; then
  log "--no-serve given; skipping 'ng serve'. Start it yourself with: npm start"
  exit 0
fi

# 7. Frontend deps + dev server (foreground — Ctrl+C stops it).
if [ ! -d node_modules ]; then
  log "Installing frontend dependencies (npm install)"
  npm install
fi

log "Starting the Angular dev server on http://localhost:4200 (Ctrl+C to stop)"
exec npm start
