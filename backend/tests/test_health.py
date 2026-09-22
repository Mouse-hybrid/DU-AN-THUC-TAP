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


def test_mock_summary_contains_all_screens():
    response = client.get("/api/v1/mock/summary")
    assert response.status_code == 200
    assert response.json()["data_mode"] == "mock"
    assert response.json()["screens"] == ["landing", "pos", "kitchen", "customer", "admin"]


def test_mock_pages_render():
    expected_titles = {
        "/": "POS System staging",
        "/pos": "Staff POS",
        "/kitchen": "Kitchen queue",
        "/customer": "Customer menu",
        "/admin": "Admin dashboard",
    }
    for path, title in expected_titles.items():
        response = client.get(path)
        assert response.status_code == 200
        assert title in response.text
        assert "Mock interface" in response.text


def test_static_styles_are_available():
    response = client.get("/static/styles.css")
    assert response.status_code == 200
    assert "--ink" in response.text
