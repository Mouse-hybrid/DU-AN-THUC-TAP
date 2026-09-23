#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backend_dir="${project_root}/backend"
pid_file="${project_root}/app.pid"
log_file="${project_root}/app.log"
action="${1:-status}"

is_running() {
  [[ -f "${pid_file}" ]] && kill -0 "$(cat "${pid_file}")" 2>/dev/null
}

case "${action}" in
  start)
    if is_running; then
      echo "Preview is already running with PID $(cat "${pid_file}")."
      exit 0
    fi
    if [[ ! -x "${backend_dir}/.venv/bin/python" ]]; then
      echo "Missing backend/.venv. Create the isolated Python environment first."
      exit 1
    fi
    cd "${backend_dir}"
    nohup env APP_ENV=staging .venv/bin/python -m uvicorn app.main:app \
      --host 0.0.0.0 --port 8000 > "${log_file}" 2>&1 < /dev/null &
    echo "$!" > "${pid_file}"
    for _ in {1..10}; do
      if curl -fsS http://127.0.0.1:8000/health >/dev/null; then
        echo "Preview started on port 8000 with PID $(cat "${pid_file}")."
        exit 0
      fi
      sleep 1
    done
    echo "Preview failed to become healthy. Check ${log_file}."
    exit 1
    ;;
  stop)
    if ! is_running; then
      echo "Preview is not running."
      exit 0
    fi
    kill "$(cat "${pid_file}")"
    rm -f "${pid_file}"
    echo "Preview stopped."
    ;;
  status)
    if is_running; then
      echo "Preview is running with PID $(cat "${pid_file}")."
      curl -fsS http://127.0.0.1:8000/health
      printf '\n'
    else
      echo "Preview is not running."
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|status}"
    exit 2
    ;;
esac
