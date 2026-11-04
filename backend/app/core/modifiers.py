"""Kiểm tra tùy chọn món khi gọi món, dùng chung cho POS (orders.py) và QR (qr.py)."""

from __future__ import annotations

import uuid
from decimal import Decimal

from fastapi import HTTPException, status

from app.db.models import MenuItem, OrderItemModifier


def resolve_modifiers(
    menu_item: MenuItem, option_ids: list[uuid.UUID]
) -> tuple[list[OrderItemModifier], Decimal]:
    """Trả về các dòng tùy chọn đã chọn và tổng giá cộng thêm. Sai quy tắc nhóm hoặc tùy
    chọn không thuộc món: 422. Tùy chọn hết hàng: 409, giống món hết hàng."""
    if len(set(option_ids)) != len(option_ids):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Tùy chọn món bị chọn trùng"
        )
    remaining = set(option_ids)
    rows: list[OrderItemModifier] = []
    total = Decimal("0")
    for group in menu_item.active_modifier_groups:
        chosen = [option for option in group.options if option.id in remaining]
        remaining -= {option.id for option in chosen}
        if not group.min_select <= len(chosen) <= group.max_select:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Món '{menu_item.name}': nhóm '{group.name}' phải chọn từ "
                    f"{group.min_select} đến {group.max_select} tùy chọn"
                ),
            )
        for option in chosen:
            if not option.is_available:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    detail=f"Tùy chọn '{option.name}' hiện không khả dụng",
                )
            rows.append(
                OrderItemModifier(
                    option_id=option.id,
                    group_name=group.name,
                    option_name=option.name,
                    price_delta=option.price_delta,
                )
            )
            total += Decimal(option.price_delta)
    if remaining:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Có tùy chọn không thuộc món '{menu_item.name}'",
        )
    return rows, total
