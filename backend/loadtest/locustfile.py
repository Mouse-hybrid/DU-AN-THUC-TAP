"""Test chịu tải (SDD R4, BRD "Peak dining hour ≥ 200"): mỗi người dùng ảo giữ một bàn LT-xxx
và đi hết luồng mở bàn → gọi món (2–3 lần) → gửi bếp → bếp nấu, báo xong → phục vụ mang ra →
yêu cầu thanh toán → thu tiền → dọn bàn, xen kẽ xem sơ đồ bàn và hàng đợi bếp như màn hình thật.

Chuẩn bị dữ liệu bằng scripts/loadtest_data.py prepare --tables <số người dùng>. Chạy:

  LOADTEST_PASSWORD=... locust -f loadtest/locustfile.py --host http://160.191.47.17 \\
      --headless -u 200 -r 10 -t 10m --csv loadtest/result

Đạt khi (kiểm ở cuối, sai thì exit code 1):
  - "thêm món" p95 ≤ 1000 ms, "gửi bếp" p95 ≤ 2000 ms (BRD);
  - không có response 5xx nào;
  - sau đó `loadtest_data.py verify` báo không ghi trùng.
"""

from __future__ import annotations

import itertools
import os
import random
import threading
import uuid

from locust import HttpUser, between, events, task
from locust.exception import StopUser

PASSWORD = os.getenv("LOADTEST_PASSWORD", "")
TABLE_PREFIX = "LT-"
THRESHOLDS_P95_MS = {"thêm món": 1000, "gửi bếp": 2000}

_table_numbers = itertools.count(1)
_shared_lock = threading.Lock()
_shared: dict = {}
_server_errors = {"count": 0}


def _key() -> dict[str, str]:
    # Tiền tố "lt-" để `loadtest_data.py cleanup` xóa được các Idempotency-Key của bài test.
    return {"Idempotency-Key": f"lt-{uuid.uuid4()}"}


@events.request.add_listener
def _count_server_errors(response=None, exception=None, **kwargs):
    if response is not None and response.status_code >= 500:
        _server_errors["count"] += 1


@events.quitting.add_listener
def _check_thresholds(environment, **kwargs):
    failures = []
    for name, limit in THRESHOLDS_P95_MS.items():
        stats = environment.stats.entries.get((name, "POST"))
        if stats is None or stats.num_requests == 0:
            failures.append(f"không có request '{name}'")
            continue
        p95 = stats.get_response_time_percentile(0.95)
        print(f"{name}: {stats.num_requests} request, p95 {p95:.0f} ms (ngưỡng {limit} ms)")
        if p95 > limit:
            failures.append(f"'{name}' p95 {p95:.0f} ms > {limit} ms")
    print(f"Response 5xx: {_server_errors['count']}")
    if _server_errors["count"]:
        failures.append(f"{_server_errors['count']} response 5xx")
    if failures:
        print("KHÔNG ĐẠT: " + "; ".join(failures))
        environment.process_exit_code = 1
    else:
        print("ĐẠT ngưỡng thời gian và không có lỗi 5xx")


class TableCycle(HttpUser):
    """Một bàn = một người dùng ảo. Ba vai dùng chung token (đăng nhập một lần mỗi tiến trình),
    giống nhiều máy POS cùng ca."""

    wait_time = between(1, 3)

    def on_start(self) -> None:
        if not PASSWORD:
            raise StopUser("Cần env LOADTEST_PASSWORD")
        with _shared_lock:
            if not _shared:
                for role in ("waiter", "cashier", "kitchen"):
                    resp = self.client.post(
                        "/api/v1/auth/login",
                        json={"username": f"lt_{role}", "password": PASSWORD},
                        name="đăng nhập",
                    )
                    resp.raise_for_status()
                    _shared[role] = {"Authorization": f"Bearer {resp.json()['access_token']}"}
                tables = self.client.get(
                    "/api/v1/tables", headers=_shared["waiter"], name="sơ đồ bàn"
                ).json()
                _shared["tables"] = {t["code"]: t["id"] for t in tables}
                menu = self.client.get("/api/v1/menu", headers=_shared["waiter"], name="thực đơn")
                _shared["menu"] = [m["id"] for m in menu.json() if m.get("is_available", True)]
        number = next(_table_numbers)
        code = f"{TABLE_PREFIX}{number:03d}"
        if code not in _shared["tables"]:
            raise StopUser(f"Không có bàn {code}: chạy prepare --tables lớn hơn số người dùng")
        self.table_id = _shared["tables"][code]
        self.waiter, self.cashier, self.kitchen = (
            _shared["waiter"],
            _shared["cashier"],
            _shared["kitchen"],
        )

    def _post(self, path: str, headers: dict, name: str, json=None, expect=(200, 201)):
        with self.client.post(
            path, json=json, headers={**headers, **_key()}, name=name, catch_response=True
        ) as resp:
            if resp.status_code not in expect:
                resp.failure(f"{resp.status_code}: {resp.text[:200]}")
                return None
            resp.success()
            return resp.json()

    def _glance(self) -> None:
        """Màn hình thật tải lại sơ đồ bàn / hàng đợi bếp khi có event."""
        if random.random() < 0.5:
            self.client.get("/api/v1/tables", headers=self.waiter, name="sơ đồ bàn")
        else:
            self.client.get("/api/v1/kitchen/queue", headers=self.kitchen, name="hàng đợi bếp")

    @task
    def full_cycle(self) -> None:
        opened = self._post(
            f"/api/v1/tables/{self.table_id}/open-session",
            self.waiter,
            "mở bàn",
            json={"guest_count": random.randint(1, 6)},
            expect=(201,),
        )
        if opened is None:
            # Bàn còn dở từ vòng trước bị lỗi: dọn lại rồi để vòng sau thử tiếp.
            self._post(f"/api/v1/tables/{self.table_id}/mark-clean", self.waiter, "dọn bàn")
            return
        order = self._post(
            "/api/v1/orders",
            self.waiter,
            "tạo đơn",
            json={"table_session_id": opened["id"]},
            expect=(201,),
        )
        if order is None:
            return
        order_id = order["id"]

        for _ in range(random.randint(2, 3)):
            lines = [
                {"menu_item_id": item_id, "quantity": random.randint(1, 2)}
                for item_id in random.sample(_shared["menu"], k=min(2, len(_shared["menu"])))
            ]
            if self._post(
                f"/api/v1/orders/{order_id}/items",
                self.waiter,
                "thêm món",
                json={"items": lines},
                expect=(201,),
            ) is None:
                return
            self.wait()

        sent = self._post(f"/api/v1/orders/{order_id}/send-to-kitchen", self.waiter, "gửi bếp")
        if sent is None:
            return
        self._glance()

        base = f"/api/v1/orders/{order_id}/items"
        items = [i["id"] for i in sent["order"]["items"]]
        for item_id in items:
            self._post(f"{base}/{item_id}/start-cooking", self.kitchen, "bếp bắt đầu nấu")
        self.wait()
        for item_id in items:
            self._post(f"{base}/{item_id}/mark-ready", self.kitchen, "bếp báo xong")
            self._post(f"{base}/{item_id}/pickup", self.waiter, "phục vụ lấy món")
            self._post(f"{base}/{item_id}/served", self.waiter, "mang ra bàn")
        self._glance()
        self.client.get(f"/api/v1/tables/{self.table_id}", headers=self.waiter, name="chi tiết bàn")

        billed = self._post(
            f"/api/v1/orders/{order_id}/request-billing", self.waiter, "yêu cầu thanh toán"
        )
        if billed is None:
            return
        self._post(
            f"/api/v1/orders/{order_id}/payments",
            self.cashier,
            "thu tiền",
            json={"method": random.choice(["CASH", "CARD"])},
            expect=(201,),
        )
        self._post(f"/api/v1/tables/{self.table_id}/mark-clean", self.waiter, "dọn bàn")
