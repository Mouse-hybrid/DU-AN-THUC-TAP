#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="${REPO_DIR}/.env.staging"
COMPOSE_FILE="${REPO_DIR}/infra/compose/compose.staging.yml"

if [[ ! -f ${ENV_FILE} ]]; then
  echo "Missing ${ENV_FILE}. Copy .env.staging.example and set a strong password."
  exit 1
fi

cd "${REPO_DIR}"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --quiet
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --build
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" ps

echo "Waiting for staging health endpoint..."
for attempt in {1..30}; do
  if curl --fail --silent http://127.0.0.1/health >/dev/null; then
    echo "Staging is healthy: http://127.0.0.1/"
    exit 0
  fi
  sleep 2
done

echo "Staging did not become healthy in time."
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" logs --tail=100
exit 1
