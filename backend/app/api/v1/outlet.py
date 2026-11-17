"""Cài đặt vận hành của cửa hàng (quyền OUTLET_SETTINGS, mặc định Supervisor).

GET   /api/v1/outlet/settings — xem cài đặt.
PATCH /api/v1/outlet/settings — đổi cài đặt, ghi audit OUTLET_SETTINGS_UPDATED.

Hiện có `qr_send_mode`: món khách gọi qua QR vào bếp ngay (DIRECT, mặc định) hay chờ phục vụ
xác nhận (CONFIRM). Đổi chế độ chỉ áp cho lần gửi món sau; món đang chờ xác nhận vẫn chờ.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.core.deps import CurrentStaff, require_permission
from app.core.permissions import Permission
from app.db.base import get_session
from app.db.models import Outlet
from app.schemas.outlet import OutletSettingsOut, OutletSettingsUpdate

router = APIRouter(prefix="/outlet", tags=["outlet"])


@router.get("/settings", response_model=OutletSettingsOut)
def get_outlet_settings(
    current: CurrentStaff = Depends(require_permission(Permission.OUTLET_SETTINGS)),
    session: Session = Depends(get_session),
) -> OutletSettingsOut:
    outlet = session.get(Outlet, current.outlet_id)
    return OutletSettingsOut(qr_send_mode=outlet.qr_send_mode)


@router.patch("/settings", response_model=OutletSettingsOut)
def update_outlet_settings(
    payload: OutletSettingsUpdate,
    current: CurrentStaff = Depends(require_permission(Permission.OUTLET_SETTINGS)),
    session: Session = Depends(get_session),
) -> OutletSettingsOut:
    outlet = session.get(Outlet, current.outlet_id, with_for_update=True)
    before = outlet.qr_send_mode
    if payload.qr_send_mode != before:
        outlet.qr_send_mode = payload.qr_send_mode
        write_audit_log(
            session,
            outlet_id=current.outlet_id,
            staff_id=current.id,
            action="OUTLET_SETTINGS_UPDATED",
            entity_type="outlet",
            entity_id=outlet.id,
            payload={"qr_send_mode": {"before": before, "after": payload.qr_send_mode}},
        )
        session.commit()
    return OutletSettingsOut(qr_send_mode=outlet.qr_send_mode)
