"""FastAPI dependencies dùng chung: DB session, current staff (JWT), RBAC,
và Idempotency-Key cho các API tạo mới (order, payment...) theo BRD NFR.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.permissions import Permission
from app.core.rbac import role_has
from app.core.security import TokenError, decode_access_token, is_token_current
from app.db.base import get_session
from app.db.models import IdempotencyKey, Staff

_bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class CurrentStaff:
    id: uuid.UUID
    outlet_id: uuid.UUID
    role: str


def get_current_staff(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
    session: Session = Depends(get_session),
) -> CurrentStaff:
    """Giải mã JWT từ header `Authorization: Bearer <token>`, xác nhận staff
    còn tồn tại + is_active=True (revoke ngay khi tài khoản bị khóa, không
    phải đợi token hết hạn).
    """
    if credentials is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Thiếu Authorization header")

    try:
        payload = decode_access_token(credentials.credentials)
    except TokenError:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="Token không hợp lệ hoặc đã hết hạn"
        )

    staff_id = uuid.UUID(payload["sub"])
    staff = session.get(Staff, staff_id)
    if staff is None or not staff.is_active:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="Tài khoản không tồn tại hoặc đã bị khóa"
        )
    if not is_token_current(payload, staff.token_version):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail="Phiên đăng nhập đã hết hiệu lực"
        )

    return CurrentStaff(id=staff.id, outlet_id=staff.outlet_id, role=staff.role)


def require_permission(permission: Permission):
    """Dependency factory cho RBAC: `Depends(require_permission(Permission.MENU_WRITE))`.
    Role được phép = mặc định trong PERMISSION_MATRIX + các ô Supervisor đã sửa trên màn Vai trò
    (app/core/rbac.py), đọc lại ở mỗi request nên sửa quyền có hiệu lực ngay."""

    def _dependency(
        current: CurrentStaff = Depends(get_current_staff),
        session: Session = Depends(get_session),
    ) -> CurrentStaff:
        if not role_has(session, current.outlet_id, current.role, permission):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail=f"Role '{current.role}' không có quyền thực hiện thao tác này",
            )
        return current

    return _dependency


def require_idempotency_key(
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> str:
    """Bắt buộc header Idempotency-Key cho mọi API tạo mới, theo BRD NFR."""
    if not idempotency_key:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="Thiếu header 'Idempotency-Key' — bắt buộc cho API tạo mới",
        )
    return idempotency_key


def hash_request_body(body: dict) -> str:
    """Hash JSON body (key sort để ổn định) — dùng để phát hiện client gửi
    lại CÙNG Idempotency-Key nhưng KHÁC nội dung (lỗi client, không phải retry)."""
    canonical = json.dumps(body, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def get_idempotent_response(
    session: Session, *, key: str, endpoint: str, request_hash: str
) -> IdempotencyKey | None:
    """Tìm bản ghi Idempotency-Key đã tồn tại cho (key, endpoint).

    - Nếu tồn tại và request_hash khớp -> trả về bản ghi cũ (caller trả lại
      response_status/response_body y hệt lần đầu, KHÔNG chạy lại side-effect).
    - Nếu tồn tại nhưng request_hash KHÁC -> client dùng lại key cho request
      khác nội dung, đây là lỗi client -> raise 409 ngay tại đây.
    - Nếu chưa tồn tại -> trả None, caller tự tạo record mới sau khi xử lý xong.
    """
    # Hai request cùng key gửi đồng thời (client bấm 2 lần, retry khi timeout) phải
    # xếp hàng: không khóa thì cả hai cùng thấy "chưa có", cùng chạy, request sau
    # đụng unique constraint lúc commit -> 503 (QA TC-007). Khóa advisory theo key
    # giữ tới hết transaction, nên request sau chờ request đầu commit rồi đọc lại
    # đúng bản ghi -> trả lại kết quả lần đầu. SQLite (test) không cần/không có.
    if session.get_bind().dialect.name == "postgresql":
        session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": key}
        )
    existing = session.execute(
        select(IdempotencyKey).where(IdempotencyKey.key == key, IdempotencyKey.endpoint == endpoint)
    ).scalar_one_or_none()

    if existing is None:
        return None

    if existing.request_hash != request_hash:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail="Idempotency-Key đã được dùng cho 1 request khác nội dung",
        )

    return existing
