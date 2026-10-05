"""Realtime bàn/bếp qua WebSocket (BE-S1-07, theo ADR 0002 — modular monolith,
chạy trong cùng process FastAPI, chưa cần broker ngoài).

Mô hình: client mở `GET /api/v1/ws?token=<JWT>&channel=kitchen|tables`. Server
chỉ đẩy sự kiện xuống (kênh một chiều); client gửi chuỗi "ping" để giữ kết nối
và nhận lại {"type": "pong"}. Mọi kết nối được tách theo (outlet, channel) nên
một outlet không bao giờ nhận sự kiện của outlet khác.

Các endpoint REST hiện tại là hàm sync (chạy trong threadpool) nên không thể
`await` trực tiếp: `publish()` đẩy coroutine broadcast vào event loop đã lưu lúc
có client kết nối (`asyncio.run_coroutine_threadsafe`). Không có client nào
đang nghe thì `publish()` không làm gì — không ảnh hưởng luồng nghiệp vụ.

Giới hạn đã biết (MVP): trạng thái kết nối giữ trong RAM của 1 process — nếu sau
này chạy nhiều worker cần đổi sang Redis pub/sub hoặc tương đương.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)

CHANNELS = ("kitchen", "tables")


class ConnectionManager:
    def __init__(self) -> None:
        self._connections: dict[tuple[str, str], set[WebSocket]] = defaultdict(set)
        self._loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, websocket: WebSocket, outlet_id: uuid.UUID, channel: str) -> None:
        await websocket.accept()
        self._loop = asyncio.get_running_loop()
        self._connections[(str(outlet_id), channel)].add(websocket)

    def disconnect(self, websocket: WebSocket, outlet_id: uuid.UUID, channel: str) -> None:
        self._connections[(str(outlet_id), channel)].discard(websocket)

    def has_listeners(self, outlet_id: uuid.UUID, channel: str) -> bool:
        return bool(self._connections.get((str(outlet_id), channel)))

    async def broadcast(self, outlet_id: uuid.UUID, channel: str, message: dict[str, Any]) -> None:
        text = json.dumps(message, default=str)
        for websocket in list(self._connections.get((str(outlet_id), channel), ())):
            try:
                await websocket.send_text(text)
            except Exception:  # noqa: BLE001 - kết nối chết thì bỏ, không chặn client khác
                logger.info("Bỏ websocket đã đóng khỏi channel %s", channel)
                self.disconnect(websocket, outlet_id, channel)

    def publish(
        self,
        outlet_id: uuid.UUID,
        channel: str,
        event_type: str,
        data: dict[str, Any] | None = None,
    ) -> None:
        """Gọi được từ endpoint sync. Không bao giờ raise — realtime là phần phụ,
        lỗi ở đây không được làm hỏng giao dịch đã commit."""
        loop = self._loop
        if loop is None or loop.is_closed() or not self.has_listeners(outlet_id, channel):
            return
        message = {
            "type": event_type,
            "channel": channel,
            "data": data or {},
            "at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            asyncio.run_coroutine_threadsafe(self.broadcast(outlet_id, channel, message), loop)
        except RuntimeError:
            logger.warning("Không đẩy được sự kiện %s (event loop không còn chạy)", event_type)


manager = ConnectionManager()
