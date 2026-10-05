"""Test POST /menu và PATCH /menu/{id} (chỉ Supervisor)."""

from __future__ import annotations

import uuid

from tests.conftest import login


def test_create_menu_item_forbidden_for_waiter(client, seed):
    headers = login(client, "waiter_test")
    resp = client.post(
        "/api/v1/menu",
        json={"name": "Moi", "price": "10000"},
        headers={**headers, "Idempotency-Key": "menu-403"},
    )
    assert resp.status_code == 403


def test_create_menu_item_requires_idempotency_key(client, seed):
    headers = login(client, "supervisor_test")
    resp = client.post("/api/v1/menu", json={"name": "Moi", "price": "10000"}, headers=headers)
    assert resp.status_code == 400


def test_create_menu_item_success_and_replay(client, seed):
    headers = {**login(client, "supervisor_test"), "Idempotency-Key": "menu-ok"}
    payload = {"name": "Pho Bo", "price": "65000", "station_id": str(seed["station_id"])}
    first = client.post("/api/v1/menu", json=payload, headers=headers)
    assert first.status_code == 201
    assert first.json()["name"] == "Pho Bo"

    replay = client.post("/api/v1/menu", json=payload, headers=headers)
    assert replay.json()["id"] == first.json()["id"]
    assert len(client.get("/api/v1/menu", headers=headers).json()) == 2


def test_create_menu_item_rejects_nonpositive_price(client, seed):
    headers = {**login(client, "supervisor_test"), "Idempotency-Key": "menu-price"}
    resp = client.post("/api/v1/menu", json={"name": "X", "price": "0"}, headers=headers)
    assert resp.status_code == 422


def test_create_menu_item_unknown_station(client, seed):
    headers = {**login(client, "supervisor_test"), "Idempotency-Key": "menu-station"}
    resp = client.post(
        "/api/v1/menu",
        json={"name": "X", "price": "1000", "station_id": str(uuid.uuid4())},
        headers=headers,
    )
    assert resp.status_code == 404


def test_patch_menu_item(client, seed):
    headers = login(client, "supervisor_test")
    url = f"/api/v1/menu/{seed['menu_item_id']}"
    resp = client.patch(url, json={"price": "55000", "is_available": False}, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["price"] in ("55000", "55000.00")
    assert resp.json()["is_available"] is False


def test_patch_menu_item_empty_body_and_forbidden(client, seed):
    sup = login(client, "supervisor_test")
    url = f"/api/v1/menu/{seed['menu_item_id']}"
    assert client.patch(url, json={}, headers=sup).status_code == 422
    cashier = login(client, "cashier_test")
    assert client.patch(url, json={"name": "A"}, headers=cashier).status_code == 403


def test_patch_menu_item_not_found(client, seed):
    headers = login(client, "supervisor_test")
    resp = client.patch(f"/api/v1/menu/{uuid.uuid4()}", json={"name": "A"}, headers=headers)
    assert resp.status_code == 404
