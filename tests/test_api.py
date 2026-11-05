from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from resume_firm import db
from resume_firm.api.app import create_app


@pytest.fixture
def client(settings):
    return TestClient(create_app(settings))


def test_pages_render(client):
    for path in ("/", "/profile", "/jobs", "/jobs/new", "/runs", "/build"):
        response = client.get(path)
        assert response.status_code == 200, path
    health = client.get("/health").json()
    assert health["ok"] is True
    assert health["provider"] == "mock"


def test_import_and_tailor_via_api(client, sample_cv, sample_jd):
    response = client.post(
        "/profile/context",
        data={"text": "Executive engineering leader focused on AI platforms."},
        follow_redirects=False,
    )
    assert response.status_code == 303

    response = client.post(
        "/profile/cvs",
        data={"vertical": "AI Platforms"},
        files={"file": ("jane.md", sample_cv.encode(), "text/markdown")},
        follow_redirects=False,
    )
    assert response.status_code == 303, response.text

    response = client.post(
        "/jobs",
        data={
            "description": sample_jd,
            "title": "VP Engineering",
            "company": "Nimbus AI",
            "language": "en",
        },
        follow_redirects=False,
    )
    assert response.status_code == 303
    location = response.headers["location"]
    assert location == "/jobs/1"

    job_page = client.get(location)
    assert job_page.status_code == 200
    assert "Download PDF" in job_page.text
    assert "Headhunter analysis" in job_page.text

    status = client.get("/jobs/1/status").json()
    assert status["status"] == "done"
    assert len(status["generated"]) == 1

    pdf = client.get("/generated/1/download/pdf")
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert len(pdf.content) > 1000

    docx = client.get("/generated/1/download/docx")
    assert docx.status_code == 200
    assert len(docx.content) > 1000

    assert client.get("/generated/1/download/exe").status_code == 400
    assert client.get("/generated/999/download/pdf").status_code == 404


def test_upload_validation(client):
    response = client.post(
        "/profile/cvs",
        data={"vertical": "X"},
        files={"file": ("evil.exe", b"nope", "application/octet-stream")},
        follow_redirects=False,
    )
    assert response.status_code == 400
    assert "Unsupported file type" in response.text


def test_mock_build_via_api(client):
    response = client.post(
        "/build",
        data={"brief": "A local CLI that tracks reading list items", "title": "Reading list"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    location = response.headers["location"]
    detail = client.get(location)
    assert detail.status_code == 200
    assert "product_spec.md" in detail.text
    assert "qa_report.md" in detail.text
    assert client.get(location + "/status").json()["status"] == "done"
