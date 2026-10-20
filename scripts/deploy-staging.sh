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
# Gắn commit đang deploy vào image để GET /version trả đúng bản đang chạy.
GIT_COMMIT=$(git -C "${REPO_DIR}" rev-parse HEAD)
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export GIT_COMMIT BUILT_AT
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

# Frontend (React + Vite trong frontend/): build bằng container Node rồi chép
# bản build vào thư mục cố định ngoài checkout, nginx mount thư mục này ở "/".
# Chưa có frontend/package.json thì bỏ qua — nginx tự rơi về backend như cũ.
FE_DIST_DIR="${HOME}/pos-staging-frontend"
mkdir -p "${FE_DIST_DIR}"
if [[ -f "${REPO_DIR}/frontend/package.json" ]]; then
  node_major=24
  if [[ -f "${REPO_DIR}/frontend/.nvmrc" ]]; then
    nvmrc=$(tr -d 'v[:space:]' < "${REPO_DIR}/frontend/.nvmrc")
    [[ ${nvmrc%%.*} =~ ^[0-9]+$ ]] && node_major=${nvmrc%%.*}
  fi
  # bookworm-slim (glibc) cho cùng native binding với job `frontend` trong CI
  # (ubuntu), tức đúng bản đã được kiểm ở mỗi PR.
  fe_image="node:${node_major}-bookworm-slim"
  echo "Building frontend with ${fe_image}..."
  # Cache npm để ngoài checkout và giữ qua các lần deploy: gói đã tải thì lần sau
  # không phải tải lại. Lý do: binding native của rolldown/vite là optional
  # dependency — tải lỗi thì npm lặng lẽ bỏ qua (npm/cli#4828), npm ci vẫn "xanh"
  # với thiếu 1 gói và build vỡ "Cannot find native binding" (deploy PR #33:
  # 190 thay vì 191 gói). Thêm vào đó thử lại tối đa 3 lần.
  npm_cache_dir="${HOME}/.cache/pos-staging-npm"
  mkdir -p "${npm_cache_dir}"
  # Chạy bằng uid/gid của runner để node_modules/dist không bị root sở hữu
  # (actions/checkout lần sau phải xóa được).
  docker run --rm --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e npm_config_cache=/npm-cache -e VITE_API_BASE_URL=/api/v1 \
    -v "${npm_cache_dir}:/npm-cache" \
    -v "${REPO_DIR}/frontend:/app" -w /app "${fe_image}" \
    sh -c 'for attempt in 1 2 3; do
             npm ci --no-audit --no-fund && npm run build && exit 0
             echo "Frontend build attempt ${attempt} failed, retrying..." >&2
             sleep 5
           done
           exit 1'
  # Thay nội dung nhưng giữ nguyên thư mục để bind mount của nginx vẫn trỏ đúng.
  find "${FE_DIST_DIR}" -mindepth 1 -delete
  cp -a "${REPO_DIR}/frontend/dist/." "${FE_DIST_DIR}/"
  echo "Frontend deployed to ${FE_DIST_DIR}"
else
  echo "No frontend/package.json yet — skipping frontend build."
fi

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
