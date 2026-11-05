from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from career_firm import db
from career_firm.api.app import create_app
from career_firm.config import Settings


@pytest.fixture
def fresh_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    """A first-run installation with nothing configured yet."""
    monkeypatch.setenv("CAREER_FIRM_HOME", str(tmp_path / "data"))
    for key in (
        "CAREER_FIRM_PROVIDER",
        "CAREER_FIRM_MODEL",
        "CAREER_FIRM_SETUP_COMPLETE",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)
    settings = Settings.load()
    assert settings.setup_complete is False
    return settings


@pytest.fixture
def fresh_client(fresh_settings: Settings) -> TestClient:
    return TestClient(create_app(fresh_settings))


def test_first_run_redirects_to_setup(fresh_client: TestClient):
    response = fresh_client.get("/", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/setup"

    # Every app page is gated until setup is finished.
    response = fresh_client.get("/profile", follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/setup"

    health = fresh_client.get("/health").json()
    assert health["ok"] is True
    assert health["setup_complete"] is False


def test_setup_page_renders_wizard(fresh_client: TestClient):
    response = fresh_client.get("/setup")
    assert response.status_code == 200
    body = response.text
    assert "Set up Career Firm" in body
    assert 'name="provider"' in body
    assert 'name="api_key"' in body
    assert 'name="context_file"' in body
    assert 'name="cv_file"' in body


def test_setup_saves_config_and_imports_source_material(
    fresh_client: TestClient, fresh_settings: Settings, sample_cv: str
):
    response = fresh_client.post(
        "/setup",
        data={
            "provider": "mock",
            "model": "mock",
            "default_language": "en",
            "context_text": "Executive engineering leader focused on AI platforms.",
            "vertical": "AI Platforms",
        },
        files={
            "cv_file": ("jane.md", sample_cv.encode(), "text/markdown"),
        },
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert response.headers["location"] == "/?welcome=1"

    assert fresh_settings.setup_complete is True
    assert fresh_settings.provider == "mock"

    with db.session(fresh_settings.db_path) as conn:
        stored = db.get_app_settings(conn)
        profile = db.get_or_create_profile(conn)
        cvs = db.list_cvs(conn, profile["id"], active_only=False)

    assert stored["provider"] == "mock"
    assert stored["setup_complete"] == "true"
    assert "Executive engineering leader" in profile["context_text"]
    assert [cv["vertical"] for cv in cvs] == ["AI Platforms"]

    # The app is now open and the wizard is no longer shown.
    dashboard = fresh_client.get("/?welcome=1")
    assert dashboard.status_code == 200
    assert "Setup complete" in dashboard.text


def test_setup_requires_key_for_hosted_provider(fresh_client: TestClient):
    response = fresh_client.post(
        "/setup",
        data={"provider": "openai", "model": "gpt-4.1"},
    )
    assert response.status_code == 200
    assert "OpenAI API key is required" in response.text


def test_settings_masks_saved_key(fresh_client: TestClient, fresh_settings: Settings):
    secret = "sk-test-1234567890"
    response = fresh_client.post(
        "/setup",
        data={
            "provider": "openai",
            "model": "gpt-4.1",
            "base_url": "https://api.openai.com/v1",
            "api_key": secret,
        },
        follow_redirects=False,
    )
    assert response.status_code == 303

    page = fresh_client.get("/settings")
    assert page.status_code == 200
    assert secret not in page.text
    assert "sk-…7890" in page.text

    with db.session(fresh_settings.db_path) as conn:
        stored = db.get_app_settings(conn)
    assert stored["api_key"] == secret
    assert stored["setup_complete"] == "true"

    # Leaving the key blank keeps the saved value.
    response = fresh_client.post(
        "/settings",
        data={
            "provider": "openai",
            "model": "gpt-4.1",
            "base_url": "https://api.openai.com/v1",
            "api_key": "",
        },
        follow_redirects=False,
    )
    assert response.status_code == 303
    with db.session(fresh_settings.db_path) as conn:
        assert db.get_app_settings(conn)["api_key"] == secret


def test_cli_applies_stored_settings(
    fresh_settings: Settings, monkeypatch: pytest.MonkeyPatch
):
    from career_firm.cli import _apply_stored_settings

    db.init_db(fresh_settings.db_path)
    with db.session(fresh_settings.db_path) as conn:
        db.save_app_settings(
            conn,
            {"provider": "ollama", "model": "llama3.1", "setup_complete": "true"},
        )

    loaded = _apply_stored_settings(Settings.load())
    assert loaded.provider == "ollama"
    assert loaded.model == "llama3.1"
    assert loaded.setup_complete is True
