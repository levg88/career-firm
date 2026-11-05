from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader

from resume_firm import db
from resume_firm.documents.extract import extract_text
from resume_firm.orchestrator.firm import FirmService


def test_firm_end_to_end_mock(settings, profile_id, sample_cv, sample_jd, tmp_path):
    with db.session(settings.db_path) as conn:
        db.update_profile_context(
            conn, profile_id, "Executive engineering leader focused on AI platforms.", "context.md"
        )
        job_id = db.create_job(
            conn,
            profile_id=profile_id,
            title="VP Engineering",
            company="Nimbus AI",
            description=sample_jd,
            language="en",
        )

    service = FirmService(settings)
    imported = service.import_cv(
        profile_id=profile_id,
        vertical="AI Platforms",
        filename="jane.md",
        file_path=str(tmp_path / "jane.md"),
        mime="text/markdown",
        raw_text=sample_cv,
    )
    assert imported["id"] == 1
    assert imported["parsed"]["name"] == "Jane Doe"

    result = service.tailor(job_id)
    assert result["score"] >= 50
    assert Path(result["pdf_path"]).is_file()
    assert Path(result["docx_path"]).is_file()
    assert result["warnings"] == []

    with db.session(settings.db_path) as conn:
        job = db.get_job(conn, job_id)
        analysis = db.latest_analysis(conn, job_id)
        generated = db.list_generated(conn, job_id)
        workflow = db.get_workflow(conn, result["workflow_id"])
    assert job["status"] == "done"
    assert job["error"] is None
    assert analysis["score"] == result["score"]
    assert len(analysis["data"]["strengths"]) >= 1
    assert len(generated) == 1
    assert generated[0]["warnings"] == []
    assert workflow["status"] == "done"

    pdf_text = "\n".join(
        page.extract_text() or "" for page in PdfReader(result["pdf_path"]).pages
    )
    assert "Jane Doe" in pdf_text
    assert "Acme Corp" in pdf_text
    assert "Nimbus AI" not in pdf_text  # company belongs to the job, not the CV


def test_blank_language_matches_the_posting(settings, profile_id, sample_cv, tmp_path):
    russian_jd = (
        "Директор по инженерии\n"
        "Компания: Аврора\n\n"
        "Требуется опыт руководства инженерными командами и работа с облачными платформами.\n"
        "Обязанности: развитие платформы и масштабирование команды.\n"
    )
    with db.session(settings.db_path) as conn:
        db.update_profile_context(conn, profile_id, "Engineering executive.", "context.md")
        job_id = db.create_job(
            conn,
            profile_id=profile_id,
            title="",
            company="",
            description=russian_jd,
            language="",
        )

    service = FirmService(settings)
    service.import_cv(
        profile_id=profile_id,
        vertical="AI Platforms",
        filename="jane.md",
        file_path=str(tmp_path / "jane.md"),
        mime="text/markdown",
        raw_text=sample_cv,
    )
    result = service.tailor(job_id)
    with db.session(settings.db_path) as conn:
        generated = db.list_generated(conn, job_id)
    assert generated[0]["language"] == "ru"
    assert Path(result["pdf_path"]).is_file()


def test_firm_requires_cv(settings, profile_id, sample_jd):
    with db.session(settings.db_path) as conn:
        job_id = db.create_job(
            conn,
            profile_id=profile_id,
            title="VP",
            company="Nimbus",
            description=sample_jd,
            language="en",
        )
    service = FirmService(settings)
    try:
        service.tailor(job_id)
    except ValueError as exc:
        assert "No CV versions" in str(exc)
    else:
        raise AssertionError("Expected ValueError")
    with db.session(settings.db_path) as conn:
        assert db.get_job(conn, job_id)["status"] == "failed"
