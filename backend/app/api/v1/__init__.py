"""Gộp toàn bộ router v1 lại 1 chỗ — app/main.py chỉ cần include 1 router này."""

from fastapi import APIRouter

from app.api.v1.auth import router as auth_router
from app.api.v1.orders import router as orders_router
from app.api.v1.tables import router as tables_router

api_v1_router = APIRouter(prefix="/api/v1")
api_v1_router.include_router(auth_router)
api_v1_router.include_router(tables_router)
api_v1_router.include_router(orders_router)
