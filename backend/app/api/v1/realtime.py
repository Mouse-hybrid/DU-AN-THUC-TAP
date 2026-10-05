"""GET /api/v1/ws — WebSocket realtime bàn/bếp (BE-S1-07).

Trình duyệt không gắn được header Authorization vào WebSocket nên JWT đi qua
query param `token`. Kết nối bị từ chối (đóng 1008) nếu token sai/hết hạn,
tài khoản bị khóa hoặc `channel` không hợp lệ. Mọi role đã đăng nhập đều nghe
được kênh của outlet mình — sự kiện chỉ chứa id + trạng thái, không có dữ liệu
nhạy cảm; muốn xem chi tiết client gọi lại REST API (có kiểm tra role).
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.orm import Session

from app.core.deps import CurrentStaff
from app.core.realtime import CHANNELS, manager
from app.core.security import TokenError, decode_access_token
from app.db.base import get_session
from app.db.models import Staff

router = APIRouter(tags=["realtime"])


def _get_ws_staff(
    token: str | None = Query(default=None),
    session: Session = Depends(get_session),
) -> CurrentStaff | None:
    """Giống get_current_staff nhưng trả None thay vì raise HTTPException
    (không hợp lệ trên WebSocket) — handler sẽ tự đóng kết nối."""
    if not token:
        return None
    try:
        payload = decode_access_token(token)
        staff = session.get(Staff, uuid.UUID(payload["sub"]))
    except (TokenError, KeyError, ValueError):
        return None
    if staff is None or not staff.is_active:
        return None
    return CurrentStaff(id=staff.id, outlet_id=staff.outlet_id, role=staff.role)


@router.websocket("/ws")
async def realtime_socket(
    websocket: WebSocket,
    channel: str = Query(default="kitchen"),
    staff: CurrentStaff | None = Depends(_get_ws_staff),
) -> None:
    if staff is None or channel not in CHANNELS:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await manager.connect(websocket, staff.outlet_id, channel)
    try:
        while True:
            message = await websocket.receive_text()
            if message == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket, staff.outlet_id, channel)
