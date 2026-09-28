"""GET /menu (BE-S1-08) — danh sách món trong menu của outlet hiện tại.

Chưa có auth cho khách quét QR (Customer trong BRD) — endpoint này hiện chỉ
phục vụ staff đã login (mọi role, vì "xem menu" không phải action bị hạn chế
trong Permission Matrix). Cho khách quét QR xem menu công khai là 1 luồng
auth khác (qr_session_token trên table_session), ngoài phạm vi BE-S1-08 —
cần làm riêng khi có yêu cầu cụ thể.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.deps import CurrentStaff, get_current_staff
from app.db.base import get_session
from app.db.models import MenuItem
from app.schemas.menu import MenuItemOut

router = APIRouter(prefix="/menu", tags=["menu"])


@router.get("", response_model=list[MenuItemOut])
def list_menu(
    available_only: bool = Query(
        default=False, description="Chỉ trả món đang is_available=True"
    ),
    current: CurrentStaff = Depends(get_current_staff),
    session: Session = Depends(get_session),
) -> list[MenuItemOut]:
    stmt = select(MenuItem).where(MenuItem.outlet_id == current.outlet_id)
    if available_only:
        stmt = stmt.where(MenuItem.is_available.is_(True))
    stmt = stmt.order_by(MenuItem.name)
    items = session.execute(stmt).scalars().all()
    return [MenuItemOut.model_validate(item) for item in items]
