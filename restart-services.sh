#!/usr/bin/env bash

# Helper script to restart frontend and backend services for this project.
# Usage:
#   ./restart-services.sh backend   # start FastAPI backend (uvicorn)
#   ./restart-services.sh frontend  # start Vite dev server
#   ./restart-services.sh docker    # restart docker-compose stack (db + backend)
#   ./restart-services.sh both      # start backend then frontend

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

start_backend() {
  cd "$ROOT_DIR/backend"
  if [ -f "../.venv/bin/activate" ]; then
    # shellcheck disable=SC1091
    source "../.venv/bin/activate"
  fi
  echo "Starting FastAPI backend on http://0.0.0.0:8000 ..."
  uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
}

start_frontend() {
  cd "$ROOT_DIR"
  echo "Starting Vite frontend dev server ..."
  npm run dev
}

restart_docker() {
  cd "$ROOT_DIR"
  echo "Restarting docker-compose services ..."
  docker compose down || true
  docker compose up -d
}

case "${1:-}" in
  backend)
    start_backend
    ;;
  frontend)
    start_frontend
    ;;
  docker)
    restart_docker
    ;;
  both)
    # backend will block; typically run this in two terminals
    echo "Starting backend in this terminal; run 'frontend' in another if needed."
    start_backend
    ;;
  *)
    echo "Usage: $0 {backend|frontend|docker|both}" >&2
    exit 1
    ;;
esac
