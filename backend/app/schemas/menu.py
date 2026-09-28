"""Pydantic schemas cho GET /menu (BE-S1-08)."""

from __future__ import annotations

import uuid
from decimal import Decimal

from pydantic import BaseModel


class MenuItemOut(BaseModel):
    id: uuid.UUID
    name: str
    price: Decimal
    is_available: bool
    station_id: uuid.UUID | None

    model_config = {"from_attributes": True}
