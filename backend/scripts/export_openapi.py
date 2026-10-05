"""Xuất API contract ra docs/api/openapi.json (ở gốc repo) từ chính app FastAPI —
không cần chạy server hay kết nối DB. QA/FE dùng file này làm baseline API
contract (Dependency Tracking: "API Contract"); mở bằng Swagger Editor hoặc
import vào Postman.

Chạy từ thư mục backend/:  python scripts/export_openapi.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / "docs" / "api" / "openapi.json"

sys.path.insert(0, str(ROOT))

from app.main import app  # noqa: E402


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    spec = app.openapi()
    OUT.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Đã ghi {OUT} ({len(spec.get('paths', {}))} path)")


if __name__ == "__main__":
    main()
