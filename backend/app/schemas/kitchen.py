"""Pydantic schemas cho GET /kitchen/queue và GET /kitchen/stations."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel


class KitchenStationOut(BaseModel):
    id: uuid.UUID
    name: str
    is_active: bool

    model_config = {"from_attributes": True}


class KitchenQueueEntryOut(BaseModel):
    """1 dòng trên màn hình bếp (KDS): món + bàn + trạng thái hàng đợi."""

    id: uuid.UUID
    order_id: uuid.UUID
    order_item_id: uuid.UUID
    table_code: str
    menu_item_name: str
    quantity: int
    note: str | None
    station_id: uuid.UUID
    status: str  # trạng thái PHIẾU bếp: QUEUED | IN_PROGRESS | DONE | CANCELLED
    item_status: str  # trạng thái MÓN: SENT, PREPARING, READY, PICKED_UP, SERVED...
    queued_at: datetime
    started_at: datetime | None
    done_at: datetime | None = None  # lúc bếp bấm xong món (màn 34: "xong lúc")
    # SLA (BRD BR-KDS-SLA-001..003): tính bằng giờ server, chỉ chạy khi món đang
    # nấu (IN_PROGRESS); món chưa bắt đầu nấu -> elapsed_minutes=null, NORMAL.
    elapsed_minutes: float | None = None
    sla_status: str = "NORMAL"  # NORMAL | WARNING | DELAYED | CRITICAL
