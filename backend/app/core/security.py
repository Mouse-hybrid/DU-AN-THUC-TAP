"""Hash password + tạo/giải mã JWT cho staff login.

Dùng bcrypt trực tiếp (qua `passlib[bcrypt]`) thay vì tự viết hashing — không
tự chế crypto. Dùng PyJWT (thư viện `pyjwt`) cho JWT vì nhẹ, không kéo theo
cryptography backend nặng như python-jose.

Thêm 2 dependency mới vào requirements.txt: `passlib[bcrypt]`, `pyjwt`.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext

from app.core.config import JWT_ACCESS_TOKEN_EXPIRE_MINUTES, JWT_ALGORITHM, JWT_SECRET_KEY

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain_password: str) -> str:
    return _pwd_context.hash(plain_password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    return _pwd_context.verify(plain_password, password_hash)


def create_access_token(
    *, staff_id: uuid.UUID, outlet_id: uuid.UUID, role: str, token_version: int = 0
) -> str:
    """Tạo JWT cho 1 staff đã login thành công.

    `ver` là staff.token_version lúc cấp token: đổi mật khẩu, khóa tài khoản, đổi
    role sẽ tăng số này ở DB, mọi token cũ hết hiệu lực ngay (xem is_token_current).
    """
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=JWT_ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {
        "sub": str(staff_id),
        "outlet_id": str(outlet_id),
        "role": role,
        "ver": token_version,
        "iat": now,
        "exp": expires_at,
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def is_token_current(payload: dict, token_version: int) -> bool:
    """Token cấp trước khi có `ver` coi như version 0, nên vẫn dùng được tới khi hết hạn."""
    return payload.get("ver", 0) == token_version


class TokenError(Exception):
    """Token thiếu/hết hạn/sai chữ ký — dependency lớp trên map sang HTTP 401."""


def decode_access_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc
