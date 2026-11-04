"""Tùy chọn món: quản lý nhóm/tùy chọn, quy tắc chọn khi gọi món ở POS và QR, giá dòng món
gồm giá cộng thêm và không đổi khi sửa giá sau đó, phiếu bếp thấy tùy chọn."""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest

from tests.conftest import login

GROUP_SIZE = {
    "name": "Size",
    "min_select": 1,
    "max_select": 1,
    "options": [{"name": "Vừa"}, {"name": "Lớn", "price_delta": "10000"}],
}
GROUP_TOPPING = {
    "name": "Topping",
    "min_select": 0,
    "max_select": 2,
    "options": [
        {"name": "Trứng", "price_delta": "5000"},
        {"name": "Thịt", "price_delta": "15000"},
        {"name": "Hành", "price_delta": "0"},
    ],
}


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


def _add_group(client, seed, headers, body):
    resp = client.post(
        f"/api/v1/menu/{seed['menu_item_id']}/modifiers", json=body, headers={**headers, **_key()}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _option(group, name):
    return next(option["id"] for option in group["options"] if option["name"] == name)


@pytest.fixture()
def order(client, seed):
    waiter = login(client, "waiter_test")
    session_id = client.post(
        f"/api/v1/tables/{seed['table_id']}/open-session",
        json={"guest_count": 2},
        headers={**waiter, **_key()},
    ).json()["id"]
    order_id = client.post(
        "/api/v1/orders",
        json={"table_session_id": session_id},
        headers={**waiter, **_key()},
    ).json()["id"]
    return {"id": order_id, "waiter": waiter}


def _add_item(client, seed, order, option_ids=None, quantity=1):
    return client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={
            "items": [
                {
                    "menu_item_id": str(seed["menu_item_id"]),
                    "quantity": quantity,
                    "modifier_option_ids": option_ids or [],
                }
            ]
        },
        headers={**order["waiter"], **_key()},
    )


def test_price_includes_modifiers_and_totals_follow(client, seed, order):
    supervisor = login(client, "supervisor_test")
    size = _add_group(client, seed, supervisor, GROUP_SIZE)
    topping = _add_group(client, seed, supervisor, GROUP_TOPPING)

    resp = _add_item(
        client,
        seed,
        order,
        [_option(size, "Lớn"), _option(topping, "Trứng"), _option(topping, "Thịt")],
        quantity=2,
    )
    assert resp.status_code == 201, resp.text
    item = resp.json()["items"][0]
    # Món 50.000 + Lớn 10.000 + Trứng 5.000 + Thịt 15.000 = 80.000.
    assert Decimal(item["unit_price"]) == Decimal("80000")
    assert {m["option_name"] for m in item["modifiers"]} == {"Lớn", "Trứng", "Thịt"}

    detail = client.get(f"/api/v1/orders/{order['id']}", headers=order["waiter"]).json()
    assert Decimal(detail["subtotal"]) == Decimal("160000")
    assert Decimal(detail["items"][0]["line_total"]) == Decimal("160000")
    listed = client.get("/api/v1/orders", headers=order["waiter"]).json()
    assert Decimal(listed[0]["subtotal"]) == Decimal("160000")


def test_order_keeps_snapshot_after_option_changes(client, seed, order):
    supervisor = login(client, "supervisor_test")
    size = _add_group(client, seed, supervisor, GROUP_SIZE)
    big = _option(size, "Lớn")
    _add_item(client, seed, order, [big])

    client.patch(
        f"/api/v1/menu/modifier-options/{big}",
        json={"price_delta": "99000", "name": "Khổng lồ"},
        headers=supervisor,
    )
    detail = client.get(f"/api/v1/orders/{order['id']}", headers=order["waiter"]).json()
    assert Decimal(detail["items"][0]["unit_price"]) == Decimal("60000")
    assert detail["items"][0]["modifiers"][0]["option_name"] == "Lớn"


def test_selection_rules(client, seed, order):
    supervisor = login(client, "supervisor_test")
    size = _add_group(client, seed, supervisor, GROUP_SIZE)
    topping = _add_group(client, seed, supervisor, GROUP_TOPPING)
    medium, big = _option(size, "Vừa"), _option(size, "Lớn")

    assert _add_item(client, seed, order, []).status_code == 422  # thiếu nhóm bắt buộc
    assert _add_item(client, seed, order, [medium, big]).status_code == 422  # quá max
    assert _add_item(client, seed, order, [medium, medium]).status_code == 422  # trùng
    assert _add_item(client, seed, order, [str(uuid.uuid4())]).status_code == 422  # lạ
    too_many = [medium, *(option["id"] for option in topping["options"])]
    assert _add_item(client, seed, order, too_many).status_code == 422
    assert _add_item(client, seed, order, [medium]).status_code == 201

    client.patch(
        f"/api/v1/menu/modifier-options/{big}", json={"is_available": False}, headers=supervisor
    )
    assert _add_item(client, seed, order, [big]).status_code == 409

    # Ẩn nhóm: không còn bắt buộc, và tùy chọn của nhóm đó không chọn được nữa.
    client.patch(
        f"/api/v1/menu/modifiers/{size['id']}", json={"is_active": False}, headers=supervisor
    )
    assert _add_item(client, seed, order, []).status_code == 201
    assert _add_item(client, seed, order, [medium]).status_code == 422


def test_item_without_modifiers_still_works(client, seed, order):
    resp = _add_item(client, seed, order)
    assert resp.status_code == 201
    assert resp.json()["items"][0]["modifiers"] == []
    menu = client.get("/api/v1/menu", headers=order["waiter"]).json()
    assert menu[0]["has_modifiers"] is False


def test_manage_groups_and_options(client, seed):
    supervisor = login(client, "supervisor_test")
    url = f"/api/v1/menu/{seed['menu_item_id']}/modifiers"

    bad_range = {**GROUP_SIZE, "min_select": 3, "max_select": 2}
    assert client.post(url, json=bad_range, headers={**supervisor, **_key()}).status_code == 422
    too_strict = {**GROUP_SIZE, "min_select": 3, "max_select": 3}
    assert client.post(url, json=too_strict, headers={**supervisor, **_key()}).status_code == 422
    same_names = {**GROUP_SIZE, "options": [{"name": "A"}, {"name": "A"}]}
    assert client.post(url, json=same_names, headers={**supervisor, **_key()}).status_code == 422
    no_options = {**GROUP_SIZE, "options": []}
    assert client.post(url, json=no_options, headers={**supervisor, **_key()}).status_code == 422

    key = {"Idempotency-Key": "group-1"}
    first = client.post(url, json=GROUP_SIZE, headers={**supervisor, **key})
    again = client.post(url, json=GROUP_SIZE, headers={**supervisor, **key})
    assert first.status_code == again.status_code == 201
    assert first.json()["id"] == again.json()["id"]
    assert client.post(url, json=GROUP_SIZE, headers={**supervisor, **_key()}).status_code == 409

    group = first.json()
    options_url = f"/api/v1/menu/modifiers/{group['id']}/options"
    added = client.post(
        options_url,
        json={"name": "Nhỏ", "price_delta": "0"},
        headers={**supervisor, **_key()},
    )
    assert added.status_code == 201, added.text
    duplicate = client.post(options_url, json={"name": "Nhỏ"}, headers={**supervisor, **_key()})
    assert duplicate.status_code == 409
    negative = client.post(
        options_url, json={"name": "Âm", "price_delta": "-1"}, headers={**supervisor, **_key()}
    )
    assert negative.status_code == 422

    group_url = f"/api/v1/menu/modifiers/{group['id']}"
    assert client.patch(group_url, json={}, headers=supervisor).status_code == 422
    assert client.patch(group_url, json={"name": None}, headers=supervisor).status_code == 422
    assert client.patch(group_url, json={"min_select": 5}, headers=supervisor).status_code == 422
    assert client.patch(group_url, json={"name": "Cỡ"}, headers=supervisor).json()["name"] == "Cỡ"

    waiter = login(client, "waiter_test")
    menu = client.get("/api/v1/menu", headers=waiter).json()
    assert menu[0]["has_modifiers"] is True
    listed = client.get(url, headers=waiter).json()
    assert [o["name"] for o in listed[0]["options"]] == ["Lớn", "Nhỏ", "Vừa"]

    client.patch(group_url, json={"is_active": False}, headers=supervisor)
    assert client.get(f"{url}?active_only=true", headers=waiter).json() == []
    assert len(client.get(url, headers=waiter).json()) == 1


def test_qr_menu_and_submit_use_modifiers(client, seed, order):
    supervisor = login(client, "supervisor_test")
    size = _add_group(client, seed, supervisor, GROUP_SIZE)
    big = _option(size, "Lớn")
    token = client.post(
        f"/api/v1/tables/{seed['table_id']}/qr-session",
        headers={**order["waiter"], **_key()},
    ).json()["token"]

    item = client.get(f"/api/v1/public/qr/{token}/menu").json()["items"][0]
    assert item["modifier_groups"][0]["name"] == "Size"
    assert len(item["modifier_groups"][0]["options"]) == 2

    def submit(option_ids):
        return client.post(
            f"/api/v1/public/qr/{token}/orders",
            json={
                "items": [
                    {"menu_item_id": str(seed["menu_item_id"]), "modifier_option_ids": option_ids}
                ]
            },
            headers=_key(),
        )

    assert submit([]).status_code == 422
    resp = submit([big])
    assert resp.status_code == 201, resp.text
    line = resp.json()["items"][0]
    assert Decimal(line["unit_price"]) == Decimal("60000")
    assert line["modifiers"][0]["option_name"] == "Lớn"


def test_kitchen_ticket_and_versions_show_modifiers(client, seed, order):
    supervisor = login(client, "supervisor_test")
    size = _add_group(client, seed, supervisor, GROUP_SIZE)
    _add_item(client, seed, order, [_option(size, "Lớn")])
    sent = client.post(
        f"/api/v1/orders/{order['id']}/send-to-kitchen",
        headers={**order["waiter"], **_key()},
    )
    assert sent.status_code == 200, sent.text

    queue = client.get("/api/v1/kitchen/queue", headers=login(client, "kitchen_test")).json()
    assert queue[0]["modifiers"][0]["option_name"] == "Lớn"
    versions = client.get(f"/api/v1/orders/{order['id']}/versions", headers=supervisor).json()
    assert versions[-1]["snapshot"]["items"][0]["modifiers"] == [{"group": "Size", "option": "Lớn"}]
