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
COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" build

echo "Starting db and waiting for its healthcheck before running migrations..."
"${COMPOSE[@]}" up -d --wait db

echo "Running alembic upgrade head against staging DB..."
"${COMPOSE[@]}" run --rm api alembic upgrade head

# Dữ liệu mẫu cho QA/FE (menu, bàn, 4 tài khoản test). Script idempotent nên
# chạy mỗi lần deploy được. Không chặn deploy nếu seed lỗi — chỉ cảnh báo.
echo "Seeding sample data (menu, tables, test accounts)..."
"${COMPOSE[@]}" run --rm api python scripts/seed_dev_data.py \
  || echo "WARNING: seed_dev_data.py failed — deploy continues, check output above."

"${COMPOSE[@]}" up -d

# infra/nginx/staging.conf được bind-mount 1 file: git checkout ghi file mới
# (inode mới) nên container đang chạy vẫn thấy bản cũ và `up -d` không tạo lại
# nginx khi compose không đổi. Restart để nginx mount lại + đọc cấu hình mới;
# kiểm tra cú pháp trước, sai thì dừng deploy thay vì để nginx chết.
echo "Validating and reloading nginx config..."
"${COMPOSE[@]}" run --rm --no-deps -T nginx nginx -t
"${COMPOSE[@]}" restart nginx
"${COMPOSE[@]}" ps

echo "Waiting for staging readiness endpoint..."
for attempt in {1..30}; do
  response=$(curl --fail --silent http://127.0.0.1/ready) || response=""
  if [[ -n ${response} ]] && grep -q '"database":"connected"' <<<"${response}"; then
    echo "Staging is healthy: http://127.0.0.1/"
    exit 0
  fi
  sleep 2
done

echo "Staging did not become healthy in time."
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" logs --tail=100
exit 1
