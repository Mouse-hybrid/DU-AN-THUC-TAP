"""Cài đặt vận hành của cửa hàng (quyền OUTLET_SETTINGS, mặc định Supervisor).

GET   /api/v1/outlet/settings — xem cài đặt.
PATCH /api/v1/outlet/settings — đổi cài đặt (gửi trường nào đổi trường đó), ghi audit
OUTLET_SETTINGS_UPDATED với giá trị trước/sau của các trường đã đổi.

- `qr_send_mode`: món khách gọi qua QR vào bếp ngay (DIRECT, mặc định) hay chờ phục vụ xác nhận
  (CONFIRM). Đổi chế độ chỉ áp cho lần gửi món sau; món đang chờ xác nhận vẫn chờ.
- `vat_rate`, `prices_include_vat`, `service_charge_rate` (specs/003-vat-hoa-don): mặc định tắt.
  Đơn chốt tỉ lệ lúc yêu cầu thanh toán, nên đổi ở đây chỉ áp cho đơn yêu cầu thanh toán sau.
"""

from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.audit import write_audit_log
from app.core.deps import CurrentStaff, require_permission
from app.core.permissions import Permission
from app.db.base import get_session
from app.db.models import Outlet
from app.schemas.outlet import OutletSettingsOut, OutletSettingsUpdate

router = APIRouter(prefix="/outlet", tags=["outlet"])

_FIELDS = ("qr_send_mode", "vat_rate", "prices_include_vat", "service_charge_rate")


def _out(outlet: Outlet) -> OutletSettingsOut:
    return OutletSettingsOut(
        qr_send_mode=outlet.qr_send_mode,
        vat_rate=Decimal(outlet.vat_rate or 0),
        prices_include_vat=bool(outlet.prices_include_vat),
        service_charge_rate=Decimal(outlet.service_charge_rate or 0),
    )


def _audit_value(value):
    return str(value) if isinstance(value, Decimal) else value


@router.get("/settings", response_model=OutletSettingsOut)
def get_outlet_settings(
    current: CurrentStaff = Depends(require_permission(Permission.OUTLET_SETTINGS)),
    session: Session = Depends(get_session),
) -> OutletSettingsOut:
    return _out(session.get(Outlet, current.outlet_id))


@router.patch("/settings", response_model=OutletSettingsOut)
def update_outlet_settings(
    payload: OutletSettingsUpdate,
    current: CurrentStaff = Depends(require_permission(Permission.OUTLET_SETTINGS)),
    session: Session = Depends(get_session),
) -> OutletSettingsOut:
    outlet = session.get(Outlet, current.outlet_id, with_for_update=True)
    changes = {}
    for name in _FIELDS:
        after = getattr(payload, name)
        if after is None:
            continue
        before = getattr(outlet, name)
        if isinstance(after, Decimal):
            before = Decimal(before or 0)
        if after != before:
            setattr(outlet, name, after)
            changes[name] = {"before": _audit_value(before), "after": _audit_value(after)}
    if changes:
        write_audit_log(
            session,
            outlet_id=current.outlet_id,
            staff_id=current.id,
            action="OUTLET_SETTINGS_UPDATED",
            entity_type="outlet",
            entity_id=outlet.id,
            payload=changes,
        )
        session.commit()
        session.refresh(outlet)
    return _out(outlet)
