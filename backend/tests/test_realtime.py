"""Test realtime (BE-S1-07): ConnectionManager + WebSocket /api/v1/ws."""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from starlette.websockets import WebSocketDisconnect

from app.core.realtime import ConnectionManager
from tests.conftest import login


class FakeWebSocket:
    def __init__(self, fail: bool = False) -> None:
        self.accepted = False
        self.sent: list[str] = []
        self._fail = fail

    async def accept(self) -> None:
        self.accepted = True

    async def send_text(self, text: str) -> None:
        if self._fail:
            raise RuntimeError("closed")
        self.sent.append(text)


def test_broadcast_only_reaches_same_outlet_and_channel():
    async def scenario():
        manager = ConnectionManager()
        outlet_a, outlet_b = uuid.uuid4(), uuid.uuid4()
        ws_a, ws_b, ws_other_channel = FakeWebSocket(), FakeWebSocket(), FakeWebSocket()
        await manager.connect(ws_a, outlet_a, "kitchen")
        await manager.connect(ws_b, outlet_b, "kitchen")
        await manager.connect(ws_other_channel, outlet_a, "tables")
        await manager.broadcast(outlet_a, "kitchen", {"type": "X"})
        return ws_a, ws_b, ws_other_channel

    ws_a, ws_b, ws_other_channel = asyncio.run(scenario())
    assert json.loads(ws_a.sent[0]) == {"type": "X"}
    assert ws_b.sent == []
    assert ws_other_channel.sent == []


def test_broadcast_drops_dead_connection():
    async def scenario():
        manager = ConnectionManager()
        outlet = uuid.uuid4()
        dead, alive = FakeWebSocket(fail=True), FakeWebSocket()
        await manager.connect(dead, outlet, "kitchen")
        await manager.connect(alive, outlet, "kitchen")
        await manager.broadcast(outlet, "kitchen", {"type": "X"})
        return manager, outlet, alive

    manager, outlet, alive = asyncio.run(scenario())
    assert len(alive.sent) == 1
    assert manager.has_listeners(outlet, "kitchen")


def test_publish_without_listeners_is_noop():
    manager = ConnectionManager()
    manager.publish(uuid.uuid4(), "kitchen", "EVENT", {"a": 1})  # không raise


def test_ws_rejects_missing_or_bad_token(client, seed):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/v1/ws?channel=kitchen"):
            pass
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/v1/ws?token=garbage&channel=kitchen"):
            pass


def test_ws_rejects_unknown_channel(client, seed):
    token = login(client, "kitchen_test")["Authorization"].split()[1]
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/v1/ws?token={token}&channel=nope"):
            pass


def test_ws_ping_pong(client, seed):
    token = login(client, "kitchen_test")["Authorization"].split()[1]
    with client.websocket_connect(f"/api/v1/ws?token={token}&channel=kitchen") as ws:
        ws.send_text("ping")
        assert ws.receive_json() == {"type": "pong"}
