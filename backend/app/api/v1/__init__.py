"""Gộp toàn bộ router v1 lại 1 chỗ — app/main.py chỉ cần include 1 router này."""

from fastapi import APIRouter

from app.api.v1.areas import router as areas_router
from app.api.v1.audit import router as audit_router
from app.api.v1.auth import router as auth_router
from app.api.v1.kitchen import router as kitchen_router
from app.api.v1.menu import router as menu_router
from app.api.v1.modifiers import router as modifiers_router
from app.api.v1.orders import router as orders_router
from app.api.v1.payments import router as payments_router
from app.api.v1.qr import public_router as qr_public_router
from app.api.v1.qr import router as qr_router
from app.api.v1.realtime import router as realtime_router
from app.api.v1.rewards import customers_router, rewards_router, rules_router
from app.api.v1.staff import router as staff_router
from app.api.v1.tables import router as tables_router

api_v1_router = APIRouter(prefix="/api/v1")
api_v1_router.include_router(auth_router)
api_v1_router.include_router(tables_router)
api_v1_router.include_router(areas_router)
api_v1_router.include_router(menu_router)
api_v1_router.include_router(modifiers_router)
api_v1_router.include_router(orders_router)
api_v1_router.include_router(payments_router)
api_v1_router.include_router(kitchen_router)
api_v1_router.include_router(realtime_router)
api_v1_router.include_router(audit_router)
api_v1_router.include_router(staff_router)
api_v1_router.include_router(customers_router)
api_v1_router.include_router(rules_router)
api_v1_router.include_router(rewards_router)
api_v1_router.include_router(qr_router)
api_v1_router.include_router(qr_public_router)
