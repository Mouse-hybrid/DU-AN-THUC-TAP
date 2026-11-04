"""Khóa cứng ma trận quyền ở tầng HTTP: mỗi endpoint nghiệp vụ chỉ mở cho đúng các
role đã chốt, và không endpoint nào quên kiểm tra đăng nhập. Đổi quyền mà quên sửa
bảng dưới thì test đỏ, buộc phải cố ý."""

from __future__ import annotations

import uuid

from fastapi.routing import APIRoute

from app.core.permissions import PERMISSION_MATRIX, Permission, permissions_for_role
from app.main import app
from tests.conftest import login

ID = uuid.uuid4()
ROLES = {
    "SUPERVISOR": "supervisor_test",
    "CASHIER": "cashier_test",
    "WAITER": "waiter_test",
    "KITCHEN": "kitchen_test",
}
ORDER_ITEM = f"/api/v1/orders/{ID}/items/{ID}"

# (method, path, các role được phép)
ENDPOINT_ROLES = [
    ("POST", "/api/v1/orders", {"CASHIER", "WAITER", "SUPERVISOR"}),
    ("POST", f"/api/v1/orders/{ID}/items", {"CASHIER", "WAITER", "SUPERVISOR"}),
    ("PATCH", ORDER_ITEM, {"CASHIER", "WAITER", "SUPERVISOR"}),
    ("DELETE", ORDER_ITEM, {"CASHIER", "WAITER", "SUPERVISOR"}),
    ("POST", f"/api/v1/orders/{ID}/send-to-kitchen", {"CASHIER", "WAITER", "SUPERVISOR"}),
    ("POST", f"/api/v1/orders/{ID}/request-billing", {"CASHIER", "WAITER", "SUPERVISOR"}),
    ("POST", f"/api/v1/orders/{ID}/pay", {"CASHIER", "SUPERVISOR"}),
    ("POST", f"/api/v1/orders/{ID}/close", {"CASHIER", "SUPERVISOR"}),
    ("POST", f"{ORDER_ITEM}/void", {"SUPERVISOR"}),
    ("POST", f"{ORDER_ITEM}/refire", {"SUPERVISOR"}),
    ("POST", f"{ORDER_ITEM}/start-cooking", {"KITCHEN", "SUPERVISOR"}),
    ("POST", f"{ORDER_ITEM}/mark-ready", {"KITCHEN", "SUPERVISOR"}),
    ("POST", f"{ORDER_ITEM}/pickup", {"WAITER", "SUPERVISOR"}),
    ("POST", f"{ORDER_ITEM}/served", {"WAITER", "SUPERVISOR"}),
    ("GET", "/api/v1/kitchen/queue", {"KITCHEN", "SUPERVISOR"}),
    ("POST", f"/api/v1/tables/{ID}/open-session", {"CASHIER", "WAITER", "SUPERVISOR"}),
    ("POST", f"/api/v1/tables/{ID}/mark-clean", {"WAITER", "SUPERVISOR"}),
    ("POST", f"/api/v1/tables/{ID}/qr-session", {"CASHIER", "WAITER", "SUPERVISOR"}),
    ("GET", f"/api/v1/tables/{ID}/qr-session", {"CASHIER", "WAITER", "SUPERVISOR"}),
    ("DELETE", f"/api/v1/tables/{ID}/qr-session", {"CASHIER", "WAITER", "SUPERVISOR"}),
    ("PATCH", f"/api/v1/tables/{ID}", {"SUPERVISOR"}),
    ("POST", "/api/v1/areas", {"SUPERVISOR"}),
    ("PATCH", f"/api/v1/areas/{ID}", {"SUPERVISOR"}),
    ("POST", f"/api/v1/menu/{ID}/modifiers", {"SUPERVISOR"}),
    ("PATCH", f"/api/v1/menu/modifiers/{ID}", {"SUPERVISOR"}),
    ("POST", f"/api/v1/menu/modifiers/{ID}/options", {"SUPERVISOR"}),
    ("PATCH", f"/api/v1/menu/modifier-options/{ID}", {"SUPERVISOR"}),
    ("POST", "/api/v1/menu", {"SUPERVISOR"}),
    ("PATCH", f"/api/v1/menu/{ID}", {"SUPERVISOR"}),
    ("POST", "/api/v1/menu/categories", {"SUPERVISOR"}),
    ("PATCH", f"/api/v1/menu/categories/{ID}", {"SUPERVISOR"}),
    ("GET", "/api/v1/audit-logs", {"SUPERVISOR"}),
    ("GET", f"/api/v1/orders/{ID}/versions", {"SUPERVISOR"}),
    ("GET", f"/api/v1/orders/{ID}/eligible-rewards", {"CASHIER", "SUPERVISOR"}),
    ("POST", f"/api/v1/orders/{ID}/rewards", {"CASHIER", "SUPERVISOR"}),
    ("DELETE", f"/api/v1/orders/{ID}/rewards/{ID}", {"CASHIER", "SUPERVISOR"}),
    ("GET", "/api/v1/rewards", {"CASHIER", "SUPERVISOR"}),
    ("POST", "/api/v1/rewards", {"SUPERVISOR"}),
    ("PATCH", f"/api/v1/rewards/{ID}", {"SUPERVISOR"}),
    ("GET", f"/api/v1/customers/{ID}/reward-usage", {"CASHIER", "SUPERVISOR"}),
    ("POST", f"/api/v1/orders/{ID}/customer", {"CASHIER", "SUPERVISOR"}),
    ("POST", "/api/v1/customers", {"CASHIER", "SUPERVISOR"}),
    ("GET", f"/api/v1/customers/{ID}", {"CASHIER", "SUPERVISOR"}),
    ("GET", f"/api/v1/customers/{ID}/points", {"CASHIER", "SUPERVISOR"}),
    ("PATCH", f"/api/v1/customers/{ID}", {"SUPERVISOR"}),
    ("POST", f"/api/v1/customers/{ID}/points/adjust", {"SUPERVISOR"}),
    ("GET", "/api/v1/loyalty-rules", {"SUPERVISOR"}),
    ("POST", "/api/v1/loyalty-rules", {"SUPERVISOR"}),
    ("GET", "/api/v1/customers", {"SUPERVISOR"}),
    ("GET", "/api/v1/staff", {"SUPERVISOR"}),
    ("POST", "/api/v1/staff", {"SUPERVISOR"}),
    ("GET", "/api/v1/staff/permissions", {"SUPERVISOR"}),
    ("GET", f"/api/v1/staff/{ID}", {"SUPERVISOR"}),
    ("PATCH", f"/api/v1/staff/{ID}", {"SUPERVISOR"}),
    ("POST", f"/api/v1/staff/{ID}/lock", {"SUPERVISOR"}),
    ("POST", f"/api/v1/staff/{ID}/unlock", {"SUPERVISOR"}),
    ("POST", f"/api/v1/staff/{ID}/reset-password", {"SUPERVISOR"}),
]

# Đọc dữ liệu chung: mọi role đã đăng nhập.
ANY_ROLE_ENDPOINTS = [
    "/api/v1/tables",
    f"/api/v1/tables/{ID}",
    "/api/v1/areas",
    "/api/v1/menu",
    f"/api/v1/menu/{ID}/modifiers",
    "/api/v1/menu/categories",
    "/api/v1/orders",
    f"/api/v1/orders/{ID}",
    "/api/v1/kitchen/stations",
    "/api/v1/auth/me",
]

PUBLIC_ROUTES = {
    ("POST", "/api/v1/auth/login"),
    ("GET", "/health"),
    ("GET", "/ready"),
    ("GET", "/version"),
    ("GET", "/"),
}


def _headers_by_role(client):
    # Đăng nhập 1 lần cho mỗi role: bcrypt chậm, gộp vào 1 test để CI không bị kéo dài.
    return {role: login(client, username) for role, username in ROLES.items()}


def test_endpoints_only_open_to_allowed_roles(client, seed):
    headers = _headers_by_role(client)
    wrong = []
    for method, path, allowed in ENDPOINT_ROLES:
        for role, auth in headers.items():
            resp = client.request(
                method, path, json={}, headers={**auth, "Idempotency-Key": str(uuid.uuid4())}
            )
            if (resp.status_code == 403) == (role in allowed):
                wrong.append(f"{role} {method} {path}: {resp.status_code}")
    assert wrong == []


def test_read_endpoints_open_to_every_role(client, seed):
    headers = _headers_by_role(client)
    wrong = [
        f"{role} GET {path}"
        for path in ANY_ROLE_ENDPOINTS
        for role, auth in headers.items()
        if client.get(path, headers=auth).status_code == 403
    ]
    assert wrong == []


def test_every_route_requires_login_except_public_ones(client, seed):
    checked = 0
    for route in app.routes:
        if not isinstance(route, APIRoute) or not route.include_in_schema and route.path != "/":
            continue
        path = route.path
        for param in route.param_convertors or ():
            path = path.replace("{" + param + "}", str(ID))
        for method in route.methods - {"HEAD", "OPTIONS"}:
            if (method, route.path) in PUBLIC_ROUTES:
                continue
            checked += 1
            # Có Idempotency-Key để kiểm tra đúng đăng nhập, không dừng ở lỗi 400 thiếu key.
            resp = client.request(method, path, json={}, headers={"Idempotency-Key": "k"})
            assert resp.status_code == 401, f"{method} {route.path}: {resp.status_code}"
    assert checked > 30


def test_matrix_covers_every_permission_with_known_roles():
    known = {"CASHIER", "WAITER", "KITCHEN", "SUPERVISOR"}
    assert set(PERMISSION_MATRIX) == set(Permission)
    for rule in PERMISSION_MATRIX.values():
        assert rule.roles and set(rule.roles) <= known
        assert rule.description


def test_permissions_for_role():
    assert "PROCESS_PAYMENT" not in permissions_for_role("WAITER")
    assert "STAFF_MANAGE" in permissions_for_role("SUPERVISOR")
    assert permissions_for_role("KHONG_CO") == []
