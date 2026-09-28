"""Global exception handler (BE-S1-09).

Muc tieu: MOI loi chua duoc ham xu ly nao bat (bug, loi ket noi DB...) deu
phai tra ve 1 JSON response dang dong nhat cho client, KHONG lo traceback/chi
tiet noi bo ra ngoai, va duoc log day du lai phia server de debug.

Khong dung toi cac HTTPException dang co san (403/404/409/400... trong
orders.py, tables.py...) - nhung endpoint do da tu xu ly va tra dung
{"detail": "..."} theo chuan cua FastAPI, FE co the da tich hop theo format
nay roi nen KHONG doi. File nay chi xen vao phan con "lo hong": exception
khong luong truoc (-> 500) va loi tang SQLAlchemy chua ai bat (-> 503, dong
bo voi cach "/ready" trong main.py dang lam).
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

logger = logging.getLogger("app.errors")

_GENERIC_ERROR_MESSAGE = "Lỗi hệ thống, vui lòng thử lại sau"
_DB_ERROR_MESSAGE = "Không thể kết nối cơ sở dữ liệu, vui lòng thử lại sau"


async def _handle_database_error(request: Request, exc: SQLAlchemyError) -> JSONResponse:
    logger.exception(
        "Loi SQLAlchemy chua duoc xu ly tai %s %s", request.method, request.url.path
    )
    return JSONResponse(status_code=503, content={"detail": _DB_ERROR_MESSAGE})


async def _handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
    logger.exception(
        "Loi khong luong truoc tai %s %s", request.method, request.url.path
    )
    return JSONResponse(status_code=500, content={"detail": _GENERIC_ERROR_MESSAGE})


def register_exception_handlers(app: FastAPI) -> None:
    """Goi 1 lan trong app/main.py, ngay sau khi tao app va include router.

    Thu tu dang ky khong quan trong ve mat dung/sai (Starlette tu chon handler
    khop nhat theo MRO cua exception), nhung dang ky rieng SQLAlchemyError
    truoc de ro rang: day la truong hop cu the hon Exception chung.
    HTTPException (dang dung o cac router) van do FastAPI tu xu ly nhu cu,
    khong bi 2 handler nay can thiep vao.
    """
    app.add_exception_handler(SQLAlchemyError, _handle_database_error)
    app.add_exception_handler(Exception, _handle_unexpected_error)
