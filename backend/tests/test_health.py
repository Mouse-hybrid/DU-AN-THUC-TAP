from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_ok():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readiness_identifies_environment():
    response = client.get("/ready")
    assert response.status_code == 200
    assert response.json()["status"] == "ready"
    assert response.json()["environment"]
    assert response.json()["database"] == "not_configured"


def test_root_points_to_api_docs():
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["service"] == "NOVA POS API"
    assert response.json()["docs"] == "/docs"


def test_sprint0_mock_pages_are_removed():
    """Trang mock Sprint 0 đã gỡ (28/10): giao diện thật nằm ở frontend/."""
    for path in ("/pos", "/kitchen", "/customer", "/admin", "/static/styles.css"):
        assert client.get(path).status_code == 404
    assert client.get("/api/v1/mock/summary").status_code == 404
